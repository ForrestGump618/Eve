"""Controlled loopback model protocol, real Eve subprocesses and Proteus snapshots."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

import pytest

pytest.importorskip('proteus', reason='optional RSI dependency')


def test_native_eve_phases_run_from_frozen_source_and_record_tools(tmp_path, monkeypatch):
    from proteus.core.disposition import NEUTRAL
    from proteus.core.goal import GoalConfig
    from proteus.sweep import SweepConfig, run_sweep
    from omicslab.evolution.proteus_adapter import EveHarness, EvolutionPolicy

    requests = []
    skill = '---\nname: evolution-proof\ndescription: Frozen evolution probe\nwhen_to_use: Protocol testing\n---\n'
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args): pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            requests.append(body)
            tools = [m for m in body['messages'] if m['role'] == 'tool']
            steps = [
                ('read_file', {'path': 'src/omicslab/__init__.py'}),
                ('skill_view', {'name': 'evolution-proof'}),
                ('write_file', {'path': 'skills/evolution-proof/SKILL.md', 'content': skill + 'NEW_SKILL_MARKER\n'}),
                ('write_file', {'path': 'notes/protocol.md', 'content': 'NEW_NOTE_MARKER\n'}),
                ('write_file', {'path': 'tools/protocol.md', 'content': 'NEW_TOOL_MARKER\n'}),
                ('write_file', {'path': '../outside.md', 'content': 'forbidden'}),
                ('write_file', {'path': '.git/config', 'content': 'forbidden'}),
            ]
            if len(tools) < len(steps):
                name, arguments = steps[len(tools)]
                delta = {'tool_calls': [{'index': 0, 'id': f'fixture-{len(tools)}', 'type': 'function',
                                        'function': {'name': name, 'arguments': json.dumps(arguments)}}]}
                finish = 'tool_calls'
            else:
                delta, finish = {'content': 'Candidate note saved; boundary checks remain.'}, 'stop'
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            for packet in [
                {'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]},
                {'choices': [{'index': 0, 'delta': {}, 'finish_reason': finish}],
                 'usage': {'prompt_tokens': 100, 'completion_tokens': 10, 'total_tokens': 110}},
            ]:
                self.wfile.write(('data: ' + json.dumps(packet) + '\n\n').encode())
            self.wfile.write(b'data: [DONE]\n\n')

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv('EVE_RSI_BASE_URL', f'http://127.0.0.1:{server.server_port}/v1')
    monkeypatch.setenv('CUSTOM_OPENAI_API_KEY', 'loopback-fixture')
    policy = EvolutionPolicy(episodes=2, max_turns=40)
    source = Path(__file__).resolve().parents[1]
    original = (source / 'omicslab/__init__.py').read_bytes()
    phase_results = []
    class Harness(EveHarness):
        def seed(self, root, rng_seed=0):
            super().seed(root, rng_seed)
            root = Path(root)
            (root / 'skills/evolution-proof').mkdir()
            (root / 'skills/evolution-proof/SKILL.md').write_text(skill + 'OLD_SKILL_MARKER\n')
            (root / 'notes/protocol.md').write_text('OLD_NOTE_MARKER\n')
            (root / 'tools/protocol.md').write_text('OLD_TOOL_MARKER\n')
    def factory():
        harness = Harness(source=source, policy=policy)
        def phase(payload, active):
            result = harness._subprocess_phase(payload, active)
            phase_results.append(result)
            return result
        harness._phase_runner = phase
        return harness
    try:
        records = run_sweep(SweepConfig(name='native-fixture', adapter_factory=factory, arms=[NEUTRAL], seeds=1,
            goal=GoalConfig(text='Record a small reproducible note'), root=tmp_path / 'sweep',
            model='controlled-protocol-fixture', episodes=policy.episodes, max_turns=policy.max_turns))
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    assert records[0]['episodes_complete'] == policy.episodes, (records, phase_results)
    rows = [json.loads(line) for p in (tmp_path / 'sweep/progress').glob('*.jsonl')
            for line in p.read_text(encoding='utf-8').splitlines()]
    assert len(rows) == policy.episodes and all(row['ok'] and row['accepted'] for row in rows), rows
    assert len(requests) == sum(row['turns'] for row in rows)
    events = [event for row in rows for event in row['action_metadata']]
    assert sum(event['tool'] is None for event in events) == len(requests)
    assert {event['tool'] for event in events} == {None, 'read_file', 'write_file', 'skill_view'}
    assert all(any(event.get('path') == '.git/config' and event['ok'] is False
                   for event in result['events']) for result in phase_results)
    assert all(any(event.get('path') == '../outside.md' and event['ok'] is False
                   for event in result['events']) for result in phase_results)
    first, second = requests[:rows[0]['turns']], requests[rows[0]['turns']:]
    assert all('OLD_NOTE_MARKER' in r['messages'][0]['content'] and 'NEW_NOTE_MARKER' not in r['messages'][0]['content'] for r in first)
    assert all('NEW_NOTE_MARKER' in r['messages'][0]['content'] and 'NEW_TOOL_MARKER' in r['messages'][0]['content'] for r in second)
    def viewed(batches):
        return [m['content'] for r in batches for m in r['messages'] if m['role'] == 'tool' and m.get('name') == 'skill_view']
    assert viewed(first) and all('OLD_SKILL_MARKER' in text for text in viewed(first))
    assert viewed(second) and all('NEW_SKILL_MARKER' in text for text in viewed(second))
    assert not list((tmp_path / 'sweep').rglob('outside.md'))
    assert (source / 'omicslab/__init__.py').read_bytes() == original
    assert all('write_file' in str(r['tools']) and 'run_shell' not in str(r['tools']) for r in requests)
