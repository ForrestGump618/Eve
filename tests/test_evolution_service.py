import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from omicslab.evolution.service import EvolutionService
from omicslab.evolution.proteus_adapter import EvolutionPolicy


def test_plan_is_confirmed_by_content_and_scoped(tmp_path):
    service = EvolutionService(tmp_path)
    plan = service.plan('ws_main', 'Preserve evidence while reducing retries')
    assert plan['status'] == 'planned'
    assert service.list('ws_other') == []
    with pytest.raises(ValueError, match='another workspace'):
        service.get(plan['id'], 'ws_other')
    with pytest.raises(ValueError):
        service.get('../outside', 'ws_main')
    assert plan['plan']['phases'] == ['observe', 'propose', 'act', 'reflect']


async def test_unconfirmed_plan_does_not_spawn(tmp_path):
    service = EvolutionService(tmp_path)
    plan = service.plan('ws_main', 'Preserve public contracts')
    with pytest.raises(ValueError, match='Confirm'):
        await service.start(plan['id'], 'ws_main', 'stale', SimpleNamespace())
    assert not service.processes


def test_restart_marks_running_experiment_interrupted_without_replay(tmp_path):
    service = EvolutionService(tmp_path)
    plan = service.plan('ws_main', 'Inspect tools')
    plan['status'] = 'running'
    service._save(plan)
    restarted = EvolutionService(tmp_path)
    assert restarted.get(plan['id'], 'ws_main')['status'] == 'interrupted'
    assert not restarted.processes


async def test_zero_exit_cannot_hide_rejected_candidate(tmp_path):
    service = EvolutionService(tmp_path)
    plan = service.plan('ws_main', 'Inspect tools')
    plan['status'] = 'running'
    service._save(plan)
    progress = service._directory(plan['id']) / 'sweep' / 'progress'
    progress.mkdir(parents=True)
    rows = [{'ok': True, 'accepted': False} for _ in range(service.policy.episodes * service.policy.seeds)]
    (progress / 'neutral-s0.jsonl').write_text('\n'.join(map(json.dumps, rows)), encoding='utf-8')
    class Process:
        async def wait(self): return 0
    await service._monitor(plan['id'], 'ws_main', Process())
    assert service.get(plan['id'], 'ws_main')['status'] == 'failed'


def test_installed_app_resolves_configured_source_and_reports_missing_bundle(tmp_path, monkeypatch):
    source = Path(__file__).resolve().parents[1]
    monkeypatch.setenv('EVE_RSI_SOURCE_ROOT', str(tmp_path / 'missing-bundle'))
    service = EvolutionService(tmp_path / 'home')
    missing = service.readiness()
    assert missing['ready'] is False
    assert missing['source_ready'] is False
    assert any('source_root' in issue['action'] for issue in missing['issues'])
    (service.root / 'config.json').write_text(json.dumps({'source_root': str(source)}))
    resolved = service.readiness()
    assert resolved['source_ready'] is True
    assert resolved['source_root'] == str(source)
    assert resolved['capabilities']['deployment'] is False
    assert 'guidance' in resolved['capabilities']['tools']


def test_invalid_source_configuration_does_not_fall_back_to_live_app(tmp_path):
    home = tmp_path / 'home'
    folder = home / 'evolution'
    folder.mkdir(parents=True)
    (folder / 'config.json').write_text(json.dumps({'source_root': 'relative'}))
    service = EvolutionService(home)
    status = service.readiness()
    assert not status['source_ready']
    assert status['source_root'] is None


async def test_completion_uses_all_rows_not_the_ui_display_limit(tmp_path):
    service = EvolutionService(tmp_path, policy=EvolutionPolicy(episodes=2, list_limit=1))
    plan = service.plan('ws_main', 'Inspect tools')
    plan['status'] = 'running'
    service._save(plan)
    progress = service._directory(plan['id']) / 'sweep' / 'progress'
    progress.mkdir(parents=True)
    rows = [{'ok': True, 'accepted': True} for _ in range(2)]
    (progress / 'neutral-s0.jsonl').write_text('\n'.join(map(json.dumps, rows)))
    class Process:
        async def wait(self): return 0
    await service._monitor(plan['id'], 'ws_main', Process())
    assert len(service.progress(plan['id'], 'ws_main')) == 1
    assert service.get(plan['id'], 'ws_main')['status'] == 'completed'
