"""Proteus integration contracts; no model credentials or model calls."""
import json
import shutil
import subprocess
import sys
import importlib
from pathlib import Path
from types import SimpleNamespace

import pytest

pytest.importorskip('proteus', reason='optional RSI dependency')
from omicslab.evolution.proteus_adapter import EveHarness, EvolutionPolicy
from omicslab.evolution.runtime import source_command


def fixture_source(tmp_path):
    source = tmp_path / 'source'
    package = source / 'omicslab'
    shutil.copytree(Path(__file__).resolve().parents[1] / 'omicslab', package,
                    ignore=shutil.ignore_patterns('__pycache__', 'web'))
    (package / 'agent.py').write_text('def answer():\n    return 1\n', encoding='utf-8')
    return source


def test_seed_is_a_copy_and_validation_rejects_broken_source(tmp_path):
    source = fixture_source(tmp_path)
    harness = EveHarness(source=source, policy=EvolutionPolicy(validation_tests=()))
    candidate = tmp_path / 'run' / 'harness'
    harness.seed(candidate)
    changed = candidate / 'src' / 'omicslab' / 'agent.py'
    changed.write_text('def broken(\n', encoding='utf-8')
    assert harness.validate_candidate(candidate)
    assert (source / 'omicslab' / 'agent.py').read_text() == 'def answer():\n    return 1\n'


def test_requires_frozen_active_snapshot_and_native_trace(tmp_path):
    source = fixture_source(tmp_path)
    calls = []
    def runner(payload, active):
        calls.append((payload, active))
        return {'ok': True, 'turns': 1, 'events': [
            {'tool': 'write_file', 'path': 'skills/test/SKILL.md', 'ok': True},
        ]}
    harness = EveHarness(source=source, phase_runner=runner, policy=EvolutionPolicy(validation_tests=()))
    run = tmp_path / 'run'
    harness.seed(run / 'harness')
    spec = SimpleNamespace(root=run, active_root=None, episode=1, model='fixture',
                           seed=0, phases=('observe', 'act'),
                           phase_prompts={'observe': 'Inspect', 'act': 'Improve'}, max_turns=8,
                           phase_turns={}, hard_max_turns=0, checkpoint_turns=0,
                           announce_budget=False, min_turns_per_phase=0)
    assert not harness.run_episode(spec).ok
    assert not calls
    spec.active_root = tmp_path / 'frozen'
    harness.seed(spec.active_root)
    result = harness.run_episode(spec)
    assert result.ok and result.turns == 2
    assert all(active == spec.active_root for _, active in calls)
    trace = harness.read_trace(run, 1)
    assert len(trace) == 2 and trace[1].surface == 'skills'
    assert trace[1].params['ok'] is True


def test_disposition_is_reversible_and_validation_rejects_links(tmp_path):
    from proteus.core.disposition import Disposition, NEUTRAL
    harness = EveHarness(source=fixture_source(tmp_path), policy=EvolutionPolicy(validation_tests=()))
    root = tmp_path / 'candidate'
    harness.seed(root)
    harness.install_disposition(root, NEUTRAL)
    original = harness.disposition_fingerprint(root)
    harness.install_disposition(root, Disposition(label='test', prompt_suffix='Prefer notes.'))
    assert harness.disposition_fingerprint(root) != original
    harness.install_disposition(root, NEUTRAL)
    assert harness.disposition_fingerprint(root) == original
    try:
        (root / 'notes' / 'escape').symlink_to(tmp_path, target_is_directory=True)
    except OSError:
        pytest.skip('Windows symlink privilege unavailable')
    assert 'link' in harness.validate_candidate(root).lower()


def test_policy_validation_and_optional_dependency_status():
    with pytest.raises(ValueError):
        EvolutionPolicy(phase_timeout_s=0)
    with pytest.raises(ValueError):
        EvolutionPolicy(max_turns=True)
    assert EvolutionPolicy().max_turns > 0


def test_real_proteus_keeps_last_valid_snapshot_on_failed_candidate(tmp_path):
    from proteus.core.disposition import NEUTRAL
    from proteus.core.goal import GoalConfig
    from proteus.sweep import SweepConfig, run_sweep
    source = fixture_source(tmp_path)
    active_values = []
    def runner(payload, active):
        active_values.append((active / 'src/omicslab/agent.py').read_text())
        if payload['phase'] == 'act':
            target = Path(payload['candidate']) / 'src/omicslab/agent.py'
            target.write_text('def invalid(\n', encoding='utf-8')
        return {'ok': True, 'turns': 1, 'events': []}
    policy = EvolutionPolicy(validation_tests=(), episodes=2)
    records = run_sweep(SweepConfig(name='fixture', adapter_factory=lambda: EveHarness(
        source=source, policy=policy, phase_runner=runner), arms=[NEUTRAL], seeds=1,
        goal=GoalConfig(text='Preserve valid source'), root=tmp_path / 'sweep', episodes=policy.episodes))
    assert records[0]['episodes_complete'] == 2
    assert all(text == 'def answer():\n    return 1\n' for text in active_values)
    rows = [json.loads(line) for p in (tmp_path / 'sweep/progress').glob('*.jsonl')
            for line in p.read_text(encoding='utf-8').splitlines()]
    assert rows and all(row['accepted'] is False for row in rows)


@pytest.mark.parametrize('relative', ['__init__.py', 'agent/loop.py', 'agent.py'])
def test_candidate_cannot_remove_baseline_source_even_with_installed_package(tmp_path, relative):
    harness = EveHarness(source=fixture_source(tmp_path), policy=EvolutionPolicy(validation_tests=()))
    root = tmp_path / 'run' / 'harness'
    harness.seed(root)
    (root / 'src' / 'omicslab' / relative).unlink()
    assert harness.validate_candidate(root)


@pytest.mark.parametrize('relative', ['__init__.py', 'evolution/__main__.py'])
def test_subprocess_import_never_falls_back_to_installed_omicslab(tmp_path, relative):
    source = fixture_source(tmp_path)
    command = source_command(source, 'omicslab.evolution', '--status')
    (source / 'omicslab' / relative).unlink()
    result = subprocess.run(command, cwd=tmp_path, capture_output=True, timeout=30)
    assert result.returncode != 0
    assert b'Required native module is missing' in result.stderr


def test_real_resource_regression_reads_candidate_and_cannot_skip_missing_skills(tmp_path):
    source = fixture_source(tmp_path)
    tests = source / 'tests'
    tests.mkdir()
    shutil.copyfile(Path(__file__).with_name('test_skills.py'), tests / 'test_skills.py')
    harness = EveHarness(source=source, policy=EvolutionPolicy(validation_tests=('test_skills.py',)))
    root = tmp_path / 'run' / 'harness'
    harness.seed(root)
    assert harness.validate_candidate(root) == ''
    skill = next((root / 'src/omicslab/skills').glob('*/SKILL.md'))
    skill.write_text('Broken frontmatter\n', encoding='utf-8')
    assert 'regression gate failed' in harness.validate_candidate(root)


def test_skipped_trusted_baseline_is_a_failed_gate(tmp_path):
    source = fixture_source(tmp_path)
    (source / 'tests').mkdir()
    (source / 'tests/test_skip.py').write_text('import pytest\npytest.skip("missing", allow_module_level=True)\n')
    harness = EveHarness(source=source, policy=EvolutionPolicy(validation_tests=('test_skip.py',)))
    root = tmp_path / 'run' / 'harness'
    harness.seed(root)
    assert 'regression gate failed' in harness.validate_candidate(root)


def test_windows_junctions_are_rejected_for_source_candidate_and_output(tmp_path):
    import os
    if os.name != 'nt':
        pytest.skip('Windows junction contract')
    source = fixture_source(tmp_path)
    harness = EveHarness(source=source, policy=EvolutionPolicy(validation_tests=()))
    root = tmp_path / 'run' / 'harness'
    harness.seed(root)
    junction = root / 'notes/escape'
    result = subprocess.run(['cmd', '/c', 'mklink', '/J', str(junction), str(source)], capture_output=True)
    assert result.returncode == 0, result.stderr
    try:
        assert harness.validate_candidate(root)
        with pytest.raises(ValueError, match='junction'):
            harness.seed(junction / 'seed')
        with pytest.raises(ValueError, match='junction'):
            EveHarness(source=junction)
    finally:
        junction.rmdir()


def test_subprocess_preserves_managed_target_dependency_root_without_pythonpath(tmp_path, monkeypatch):
    source = fixture_source(tmp_path)
    deps = tmp_path / 'managed-target'
    package = deps / 'httpx'
    package.mkdir(parents=True)
    (package / '__init__.py').write_text('MANAGED_TARGET_MARKER = "managed-only"\n')
    (deps / 'eve_managed_dependency_probe.py').write_text(
        'import httpx\nassert httpx.MANAGED_TARGET_MARKER == "managed-only"\nprint("managed-import-ok")\n')
    monkeypatch.syspath_prepend(str(deps))
    monkeypatch.delitem(sys.modules, 'httpx', raising=False)
    importlib.invalidate_caches()
    command = source_command(source, 'eve_managed_dependency_probe')
    env = {'SYSTEMROOT': __import__('os').environ.get('SYSTEMROOT', ''), 'PYTHONPATH': str(tmp_path / 'untrusted')}
    result = subprocess.run(command, cwd=tmp_path, env=env, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stderr.decode(errors='replace')
    assert b'managed-import-ok' in result.stdout
    # The restored dependency root must not weaken native-source enforcement.
    command = source_command(source, 'omicslab.evolution', '--status')
    (source / 'omicslab/__init__.py').unlink()
    result = subprocess.run(command, cwd=tmp_path, env=env, capture_output=True, timeout=30)
    assert result.returncode != 0
    assert b'Required native module is missing' in result.stderr
