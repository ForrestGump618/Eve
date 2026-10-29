"""Plan/confirm/run boundary for optional, run-local Proteus experiments."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid

from ..utils import atomic_write_text
from .proteus_adapter import EvolutionPolicy, dependency_status
from .runtime import checked_path, require_package, resolve_source, source_command, tree_files


class EvolutionService:
    def __init__(self, home, source=None, policy=None):
        self.root = checked_path(Path(home) / 'evolution')
        self.home, self.explicit_source = home, source
        self.source_error = ''
        try:
            self.source = resolve_source(home, source)
        except (OSError, ValueError) as exc:
            self.source = None
            self.source_error = str(exc)
        self.policy = policy or EvolutionPolicy()
        self.processes = {}
        self.monitors = set()
        self._start_lock = asyncio.Lock()
        self.root.mkdir(parents=True, exist_ok=True)
        # A previous process is never relaunched blindly after restart.
        for path in self.root.glob('*/record.json'):
            value = json.loads(checked_path(path).read_text(encoding='utf-8'))
            if value['status'] == 'running':
                value.update(status='interrupted', updated_at=time.time())
                self._save(value)

    def _directory(self, id):
        if not isinstance(id, str) or not id.startswith('evolve_') or len(id) != len('evolve_') + len(uuid.uuid4().hex):
            raise ValueError('Invalid evolution run ID')
        if any(c not in '0123456789abcdef' for c in id[len('evolve_'):]):
            raise ValueError('Invalid evolution run ID')
        return checked_path(self.root / id)

    def _save(self, record):
        atomic_write_text(self._directory(record['id']) / 'record.json', json.dumps(record, ensure_ascii=False, indent=2))

    def get(self, id, scope):
        path = checked_path(self._directory(id) / 'record.json')
        if not path.is_file():
            raise ValueError('Evolution run not found')
        record = json.loads(path.read_text(encoding='utf-8'))
        if record['scope'] != scope:
            raise ValueError('Evolution run belongs to another workspace')
        return record

    def list(self, scope):
        records = [json.loads(checked_path(path).read_text(encoding='utf-8')) for path in self.root.glob('*/record.json')]
        return sorted((r for r in records if r['scope'] == scope),
                      key=lambda r: r['created_at'], reverse=True)[:self.policy.list_limit]

    def progress(self, id, scope, *, limited=True):
        self.get(id, scope)
        directory = checked_path(self._directory(id) / 'sweep' / 'progress')
        rows = []
        for path in sorted(directory.glob('*.jsonl')):
            for line in checked_path(path).read_text(encoding='utf-8').splitlines():
                try:
                    row = json.loads(line)
                except ValueError:
                    continue  # An in-flight final line may not be complete yet.
                rows.append(row)
        return rows[-self.policy.list_limit:] if limited else rows

    def readiness(self, target=None):
        dependency = dependency_status()
        issues = []
        source_ready = False
        if not dependency['available']:
            issues.append({'code': 'dependency', 'message': dependency['error'] or 'Pinned Proteus is unavailable',
                           'action': dependency['install']})
        try:
            self.source = resolve_source(self.home, self.explicit_source)
            self.source_error = ''
            require_package(self.source)
            files = list(tree_files(self.source / 'omicslab'))
            if len(files) > self.policy.max_source_files or sum(p.stat().st_size for p in files) > self.policy.max_tree_bytes:
                raise ValueError('Source copy exceeds evolution policy')
            if not self.policy.validation_tests:
                raise ValueError('Release experiments require trusted baseline tests')
            for name in self.policy.validation_tests:
                if not checked_path(self.source / 'tests' / name).is_file():
                    raise ValueError(f'Required baseline test is unavailable: {name}')
            source_ready = True
        except (OSError, ValueError, TypeError) as exc:
            issues.append({'code': 'source', 'message': str(exc),
                           'action': 'Set an absolute source_root in <home>/evolution/config.json or EVE_RSI_SOURCE_ROOT to the full RSI source bundle (omicslab/ and tests/).'})
        from importlib.util import find_spec
        for module in ('pytest', 'pytest_asyncio'):
            if find_spec(module) is None:
                issues.append({'code': 'validation_dependency', 'message': f'{module} is unavailable',
                               'action': 'Install pytest>=8 and pytest-asyncio>=0.23 into the bundled Python runtime.'})
        if target is not None and (not target.api_key or not target.model or target.family != 'openai'):
            issues.append({'code': 'model', 'message': 'An OpenAI-compatible model connection is required',
                           'action': 'Configure a model and credential in model settings.'})
        return {'ready': not issues, 'source_ready': source_ready, 'validation_ready': source_ready and
                not any(i['code'] == 'validation_dependency' for i in issues),
                'source_root': str(self.source) if self.source else None, 'issues': issues,
                'dependency': dependency,
                'capabilities': {'skills': 'native skill_list/skill_view from frozen snapshot',
                                 'tools': 'guidance files only; no executable tool loader',
                                 'notes': 'bounded frozen context', 'deployment': False}}

    def plan(self, scope, goal):
        if not isinstance(goal, str) or not goal.strip() or len(goal.encode('utf-8')) > self.policy.max_file_bytes:
            raise ValueError('A bounded evolution goal is required')
        plan = {'goal': goal.strip(), 'scope': scope, 'policy': self.policy.as_dict(),
                'surfaces': ['instructions', 'notes', 'skills', 'tools', 'Python source'],
                'phases': ['observe', 'propose', 'act', 'reflect'],
                'activation': 'validated snapshot in next episode; no deployment to the installed app',
                'validation': list(self.policy.validation_tests)}
        plan['source_root'] = str(self.source) if self.source else None
        digest = hashlib.sha256(json.dumps(plan, sort_keys=True).encode()).hexdigest()
        record = {'id': 'evolve_' + uuid.uuid4().hex, 'scope': scope, 'status': 'planned',
                  'plan': plan, 'plan_hash': digest, 'created_at': time.time(), 'updated_at': time.time()}
        self._save(record)
        return record

    async def start(self, id, scope, plan_hash, target):
        async with self._start_lock:
            return await self._start(id, scope, plan_hash, target)

    async def _start(self, id, scope, plan_hash, target):
        record = self.get(id, scope)
        if record['status'] != 'planned' or plan_hash != record['plan_hash']:
            raise ValueError('Confirm the current plan before dispatching evolution')
        readiness = self.readiness(target)
        if not readiness['ready']:
            raise ValueError('; '.join(issue['message'] + '. ' + issue['action'] for issue in readiness['issues']))
        if record['plan'].get('source_root') != str(self.source):
            raise ValueError('Source configuration changed; create and confirm a new plan')
        if self.processes:
            raise ValueError('An evolution experiment is already running')
        if not target.api_key or not target.model:
            raise ValueError('Configure a model connection before evolution')
        if target.family != 'openai':
            raise ValueError('This adapter currently requires an OpenAI-compatible model connection')
        directory = self._directory(id)
        policy_file = checked_path(directory / 'policy.json')
        atomic_write_text(policy_file, json.dumps(record['plan']['policy']))
        env = dict(os.environ)
        env.update(CUSTOM_OPENAI_API_KEY=target.api_key, EVE_RSI_BASE_URL=target.api_base,
                   PYTHONPATH=str(self.source), PYTHONIOENCODING='utf-8', PYTHONDONTWRITEBYTECODE='1')
        # Credentials travel only in the process environment, never argv or the plan ledger.
        kwargs = {'start_new_session': True} if os.name != 'nt' else {}
        checked_path(directory / 'sweep')
        try:
            with checked_path(directory / 'run.log').open('wb') as log:
                process = await asyncio.create_subprocess_exec(
                *source_command(self.source, 'omicslab.evolution', '--out', str(directory / 'sweep'),
                '--goal', record['plan']['goal'], '--model', target.model, '--source', str(self.source),
                '--policy', str(policy_file)), cwd=directory, env=env, stdout=log, stderr=log, **kwargs)
        except (OSError, subprocess.SubprocessError) as exc:
            raise ValueError(f'Evolution could not start ({type(exc).__name__}); check the bundled Python runtime and run-directory permissions') from exc
        self.processes[id] = process
        record.update(status='running', updated_at=time.time())
        self._save(record)
        task = asyncio.create_task(self._monitor(id, scope, process))
        self.monitors.add(task)
        task.add_done_callback(self.monitors.discard)
        return record

    async def _monitor(self, id, scope, process):
        code = await process.wait()
        self.processes.pop(id, None)
        record = self.get(id, scope)
        if record['status'] == 'running':
            # Sweep completion alone does not prove that episodes or candidates passed.
            rows = self.progress(id, scope, limited=False)
            expected = record['plan']['policy']['episodes'] * record['plan']['policy']['seeds']
            failed = len(rows) != expected or any(row.get('ok') is not True or row.get('accepted') is not True for row in rows)
            record.update(status='failed' if code or failed else 'completed', exit_code=code, updated_at=time.time(),
                          error='Native experiment or regression gate failed; inspect the local run.log and progress records.' if code or failed else '')
            self._save(record)

    async def stop(self, id, scope):
        record = self.get(id, scope)
        process = self.processes.get(id)
        if not process or process.returncode is not None:
            raise ValueError('Evolution is not running in this server process')
        record.update(status='cancelled', updated_at=time.time())
        self._save(record)
        if os.name == 'nt':
            killer = await asyncio.create_subprocess_exec('taskkill', '/PID', str(process.pid), '/T', '/F',
                                                          stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            await killer.wait()
        else:
            os.killpg(process.pid, signal.SIGTERM)
        await process.wait()
        return self.get(id, scope)

    async def close(self):
        for id in list(self.processes):
            record = json.loads((self._directory(id) / 'record.json').read_text(encoding='utf-8'))
            await self.stop(id, record['scope'])
        if self.monitors:
            await asyncio.gather(*self.monitors, return_exceptions=True)
