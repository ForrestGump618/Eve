"""Portable skill runner source, executed only on the selected SSH backend."""
from __future__ import annotations
import json

RUNNER = r'''
def _suwen_skill_run(payload):
    import json, os, pathlib, signal, subprocess, sys, tempfile, time
    if payload.get('language') not in ('python', 'node'):
        raise ValueError('Unsupported skill language')
    timeout = min(120, max(1, float(payload.get('timeoutMs', 30000))/1000))
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix='.suwen-skill-', dir=os.getcwd()) as directory:
        root = pathlib.Path(directory).resolve()
        total = 0
        files = payload.get('files') or []
        if len(files) > 100: raise ValueError('Too many skill resources')
        for file in files:
            name = str(file.get('name', ''))
            if '\\' in name: raise ValueError('Invalid resource path')
            path = (root / name).resolve()
            if not path.is_relative_to(root) or path == root: raise ValueError('Resource outside skill directory')
            text = str(file.get('text', ''))
            total += len(text.encode('utf-8'))
            if total > 2000000: raise ValueError('Skill resources exceed limit')
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding='utf-8')
        source = str(payload.get('source', ''))
        if not source or len(source) > 200000: raise ValueError('Invalid skill source')
        script = root / ('__suwen_entry.py' if payload['language'] == 'python' else '__suwen_entry.js')
        script.write_text(source, encoding='utf-8')
        command = [sys.executable if payload['language'] == 'python' else 'node', str(script)]
        args = payload.get('args') or []
        if not isinstance(args, list) or len(args) > 20 or any(not isinstance(x, str) for x in args): raise ValueError('Invalid skill arguments')
        timed_out = False
        with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
            proc = subprocess.Popen(command + args, cwd=root, stdout=out, stderr=err, start_new_session=(os.name != 'nt'))
            try:
                try: proc.wait(timeout=timeout)
                except subprocess.TimeoutExpired: timed_out = True
            finally:
                if proc.poll() is None:
                    if os.name != 'nt': os.killpg(proc.pid, signal.SIGKILL)
                    else: proc.kill()
                    proc.wait(timeout=5)
            out.seek(0); err.seek(0)
            stdout, stderr = out.read(400001), err.read(400001)
        return dict(exitCode=proc.returncode, timedOut=timed_out, stdout=stdout[:400000].decode('utf-8', 'replace'), stderr=stderr[:400000].decode('utf-8', 'replace'), truncated=len(stdout)>400000 or len(stderr)>400000, durationMs=int((time.monotonic()-started)*1000), executionEnvironment='ssh')
'''


def runner_source(payload: dict) -> str:
    return RUNNER + "\nprint(__import__('json').dumps(_suwen_skill_run(__import__('json').loads(" + repr(json.dumps(payload)) + "))))\n"
