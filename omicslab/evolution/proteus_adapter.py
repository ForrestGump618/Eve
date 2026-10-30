"""Native Eve phases behind Proteus's staged-activation contract."""
from __future__ import annotations

from dataclasses import dataclass, fields
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from ..utils import atomic_write_text
from .runtime import checked_path, require_package, source_command, tree_files

POLICY_PATH = Path(__file__).resolve().parents[1] / 'data' / 'evolution-policy.json'
DEFAULTS = json.loads(POLICY_PATH.read_text(encoding='utf-8'))
UPSTREAM_COMMIT = '69f766e73460f67d96a3ce965a5c3f9adaab2f85'
PROTEUS_VERSION = '0.4.0'
SURFACES = {'loop': 'src/omicslab', 'notes': 'notes', 'skills': 'skills', 'tools': 'tools', 'instructions': 'instructions'}


@dataclass(frozen=True)
class EvolutionPolicy:
    phase_timeout_s: int = DEFAULTS['phase_timeout_s']
    validation_timeout_s: int = DEFAULTS['validation_timeout_s']
    max_turns: int = DEFAULTS['max_turns']
    episodes: int = DEFAULTS['episodes']
    seeds: int = DEFAULTS['seeds']
    max_file_bytes: int = DEFAULTS['max_file_bytes']
    max_tree_bytes: int = DEFAULTS['max_tree_bytes']
    max_context_bytes: int = DEFAULTS['max_context_bytes']
    max_source_files: int = DEFAULTS['max_source_files']
    validation_tests: tuple[str, ...] = tuple(DEFAULTS['validation_tests'])
    poll_interval_ms: int = DEFAULTS['poll_interval_ms']
    list_limit: int = DEFAULTS['list_limit']

    def __post_init__(self):
        for item in fields(self):
            value = getattr(self, item.name)
            if item.name == 'validation_tests':
                if not isinstance(value, (list, tuple)) or any(
                    not isinstance(v, str) or Path(v).name != v or not v.endswith('.py') for v in value
                ):
                    raise ValueError('validation_tests must contain test basenames')
            elif type(value) is not int or value <= 0:
                raise ValueError(f'{item.name} must be a positive integer')

    def as_dict(self):
        return {item.name: getattr(self, item.name) for item in fields(self)}


def dependency_status():
    from importlib.metadata import PackageNotFoundError, version
    try:
        installed = version('proteus-evolve')
    except PackageNotFoundError:
        installed = None
    error = ''
    if installed == PROTEUS_VERSION:
        try:
            from proteus.core.adapter import EpisodeResult, Surface
            from proteus.core.budget import budget_plan, phase_prompt
            from proteus.sweep import SweepConfig, run_sweep
        except (ImportError, AttributeError) as exc:
            error = f'Proteus API unavailable ({type(exc).__name__})'
    return {'available': installed == PROTEUS_VERSION and not error, 'installed_version': installed,
            'required_version': PROTEUS_VERSION, 'source_commit': UPSTREAM_COMMIT,
            'error': error,
            'install': f'python -m pip install "proteus-evolve @ https://github.com/proteus-evolve/Proteus/archive/{UPSTREAM_COMMIT}.zip" "pytest>=8" "pytest-asyncio>=0.23"'}


def phase_environment(active_root: Path):
    env = dict(os.environ)
    # A phase imports the frozen source, never the writable candidate or host checkout.
    env['PYTHONPATH'] = str(active_root / 'src')
    env['PYTHONIOENCODING'] = 'utf-8'
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    env['PYTEST_DISABLE_PLUGIN_AUTOLOAD'] = '1'
    env.pop('PYTEST_ADDOPTS', None)
    env.pop('PYTEST_PLUGINS', None)
    env.pop('OMICSLAB_SKILL_ROOTS', None)
    return env


class EveHarness:
    name = 'eve'
    continuity_mode = 'none'
    supports_custom_phases = True
    staged_activation = True
    disposition_in_files = False

    def __init__(self, source=None, policy=None, phase_runner=None):
        self.source = checked_path(source or Path(__file__).resolve().parents[2])
        self.policy = policy or EvolutionPolicy()
        self.phase_timeout_s = self.policy.phase_timeout_s
        self._phase_runner = phase_runner or self._subprocess_phase

    def surfaces(self):
        from proteus.core.adapter import Surface
        return [Surface(name, path, unit='directory' if name == 'skills' else 'file',
                        write_tools=frozenset({'write_file'}), is_code=name in {'loop', 'tools'})
                for name, path in SURFACES.items()]

    def required_edit_tools(self):
        return frozenset({'write_file'})

    def seed(self, harness_root, rng_seed=0):
        root = checked_path(harness_root)
        require_package(self.source)
        source = self.source / 'omicslab'
        if not source.is_dir():
            raise ValueError('Eve source package is unavailable')
        if root.is_relative_to(self.source) or self.source.is_relative_to(root):
            raise ValueError('Evolution output must be outside the source package')
        if root.exists() and any(root.iterdir()):
            raise ValueError('Evolution seed requires an empty output directory')
        root.mkdir(parents=True, exist_ok=True)
        files = [p for p in tree_files(source) if '__pycache__' not in p.parts
                 and (p.suffix == '.py' or p.relative_to(source).parts[0] in {'data', 'agents', 'skills'})]
        if len(files) > self.policy.max_source_files or sum(p.stat().st_size for p in files) > self.policy.max_tree_bytes:
            raise ValueError('Source copy exceeds evolution policy')
        for p in files:
            target = root / 'src' / 'omicslab' / p.relative_to(source)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(p, target)
        for path in SURFACES.values():
            (root / path).mkdir(parents=True, exist_ok=True)
        atomic_write_text(root / 'instructions' / 'SYSTEM.md',
                          'Improve the Eve harness using reproducible evidence. Preserve public contracts.\n')
        # Baseline tests and policy are outside the measured writable subject.
        trusted = checked_path(root.parent / '.eve-validation')
        trusted.mkdir(exist_ok=True)
        manifest = {'required_files': sorted(p.relative_to(source).as_posix() for p in files), 'tests': {}}
        for name in self.policy.validation_tests:
            src = checked_path(self.source / 'tests' / name)
            if not src.is_file():
                raise ValueError(f'Required baseline test is unavailable: {name}')
            target = checked_path(trusted / name)
            shutil.copyfile(src, target)
            manifest['tests'][name] = hashlib.sha256(target.read_bytes()).hexdigest()
        atomic_write_text(trusted / 'manifest.json', json.dumps(manifest, sort_keys=True))
        atomic_write_text(trusted / 'pytest.ini', '[pytest]\nasyncio_mode = auto\n')

    def install_disposition(self, harness_root, disposition):
        value = {'label': disposition.label, 'config': dict(disposition.config),
                 'prompt_suffix': disposition.prompt_suffix, 'per_phase': dict(disposition.per_phase)}
        atomic_write_text(Path(harness_root) / '.disposition.json', json.dumps(value, sort_keys=True))

    def disposition_fingerprint(self, harness_root):
        path = Path(harness_root) / '.disposition.json'
        return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else ''

    def _subprocess_phase(self, payload, active_root):
        result = subprocess.run(source_command(active_root / 'src', 'omicslab.evolution.phase_worker'),
                                input=json.dumps(payload), text=True, encoding='utf-8', capture_output=True,
                                cwd=active_root, env=phase_environment(active_root),
                                timeout=self.policy.phase_timeout_s)
        if result.returncode:
            # Logs can include credentials supplied by a provider; keep them out of the ledger.
            raise RuntimeError(f'Eve phase exited with code {result.returncode}')
        return json.loads(result.stdout)

    def run_episode(self, spec):
        from proteus.core.adapter import EpisodeResult
        from proteus.core.budget import budget_plan, phase_prompt
        if spec.active_root is None:
            return EpisodeResult(episode=spec.episode, ok=False, turns=0, error='Frozen active snapshot required')
        active = checked_path(spec.active_root)
        candidate = checked_path(Path(spec.root) / 'harness')
        if active.is_relative_to(candidate) or candidate.is_relative_to(active):
            return EpisodeResult(episode=spec.episode, ok=False, turns=0, error='Active and candidate must differ')
        trace = Path(spec.root) / 'traces' / f'ep{spec.episode:03d}.jsonl'
        trace.parent.mkdir(parents=True, exist_ok=True)
        turns, error = 0, ''
        plan = budget_plan(spec)
        with trace.open('w', encoding='utf-8') as sink:
            for phase in spec.phases:
                remaining = plan.stop_at(phase, turns) - turns if plan.enabled else self.policy.max_turns - turns
                if remaining <= 0:
                    error = 'Native Eve episode exhausted its budget before all phases completed'
                    break
                payload = {'candidate': str(candidate), 'episode': spec.episode, 'phase': phase,
                           'prompt': phase_prompt(spec, phase, turns), 'model': spec.model,
                           'max_turns': remaining, 'policy': self.policy.as_dict()}
                try:
                    result = self._phase_runner(payload, active)
                    used = result.get('turns')
                    if type(used) is not int or used < 0 or used > remaining:
                        raise ValueError('Invalid phase budget accounting')
                    offset = turns
                    turns += used
                    for event in result.get('events', []):
                        path = event.get('path', '')
                        surface = next((name for name, sub in SURFACES.items()
                                        if path == sub or path.startswith(sub + '/')), None)
                        event_turn = event.get('turn', used)
                        if type(event_turn) is not int or not 0 <= event_turn <= used:
                            raise ValueError('Invalid native trace turn')
                        sink.write(json.dumps({'turn': offset + event_turn, 'phase': phase, 'tool': event.get('tool'),
                                               'surface': surface, 'params': {'path': path, 'ok': event.get('ok')},
                                               'text': ''}) + '\n')
                    sink.flush()
                    if not result.get('ok'):
                        error = 'Native Eve phase failed or exhausted its budget'
                        break
                except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
                    error = type(exc).__name__
                    break
        return EpisodeResult(episode=spec.episode, ok=not error, turns=turns, error=error)

    def read_trace(self, root, episode):
        from proteus.core.adapter import ActionEvent
        path = Path(root) / 'traces' / f'ep{episode:03d}.jsonl'
        return [ActionEvent(**json.loads(line)) for line in path.read_text(encoding='utf-8').splitlines()] if path.exists() else []

    def validate_candidate(self, harness_root):
        total, count = 0, 0
        try:
            root = checked_path(harness_root)
            require_package(root / 'src')
            trusted = checked_path(root.parent / '.eve-validation')
            manifest = json.loads(checked_path(trusted / 'manifest.json').read_text(encoding='utf-8'))
            for name in manifest['required_files']:
                if not checked_path(root / 'src' / 'omicslab' / name).is_file():
                    return f'Required baseline source file removed: {name}'
            for path in tree_files(root):
                if '.git' in path.relative_to(root).parts:
                    continue
                if path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction()):
                    return 'Candidate links are not supported'
                if not path.is_file():
                    continue
                count += 1
                size = path.stat().st_size
                total += size
                if size > self.policy.max_file_bytes or total > self.policy.max_tree_bytes or count > self.policy.max_source_files:
                    return 'Candidate exceeds evolution policy'
                if path.suffix == '.py':
                    compile(path.read_text(encoding='utf-8-sig'), str(path.relative_to(root)), 'exec')
            if self.policy.validation_tests:
                tests = [checked_path(trusted / name) for name in self.policy.validation_tests]
                if not all(path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == manifest['tests'][path.name]
                           for path in tests):
                    return 'Trusted baseline tests unavailable'
                # The baseline's __file__-relative resource lookups must see the
                # candidate package, not the installed app or validation store.
                with tempfile.TemporaryDirectory(prefix='eve-regression-') as temporary:
                    project = Path(temporary)
                    shutil.copytree(root / 'src' / 'omicslab', project / 'omicslab')
                    (project / 'tests').mkdir()
                    for test in tests:
                        shutil.copyfile(test, project / 'tests' / test.name)
                    shutil.copyfile(trusted / 'pytest.ini', project / 'pytest.ini')
                    env = phase_environment(project)
                    for key in list(env):
                        if key.endswith(('API_KEY', '_TOKEN', '_SECRET', '_PASSWORD')):
                            env.pop(key)
                    result = subprocess.run(source_command(project, 'pytest', '-c', project / 'pytest.ini',
                                             '--import-mode=importlib', '-q', project / 'tests'),
                                            cwd=project, env=env, capture_output=True,
                                            timeout=self.policy.validation_timeout_s)
                if result.returncode:
                    return f'Trusted regression gate failed ({result.returncode})'
        except ValueError as exc:
            detail = str(exc).strip()
            return f'Candidate validation failed: {detail}' if detail else 'Candidate validation failed: invalid value'
        except (OSError, KeyError, SyntaxError, subprocess.SubprocessError) as exc:
            return f'Candidate validation failed: {type(exc).__name__}'
        return ''
