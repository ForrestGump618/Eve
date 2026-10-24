import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export interface LegacyHandle { port: number; token: string; pid: number; stop: () => Promise<void> }

/** Starts only the trusted bridge script; no model-generated code, shell or inherited API credentials. */
export async function launchLegacy(python: string, script: string, source: string, home: string, signal?: AbortSignal): Promise<LegacyHandle> {
  if (signal?.aborted) throw new Error('Legacy bridge launch cancelled');
  if (!python || /[\u0000-\u001f]/.test(python) || ![script, source, home].every(isAbsolute) || !existsSync(script) || !existsSync(join(source, 'omicslab', 'config.py'))) throw new Error('Legacy bridge requires a Python interpreter and trusted absolute paths');
  const token = randomBytes(32).toString('hex');
  const env: NodeJS.ProcessEnv = {};
  // OS and installed-Python dependency discovery only; API/SSH/model and
  // PYTHONPATH/PYTHONSTARTUP/legacy configuration variables are never inherited.
  for (const key of ['SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA']) if (process.env[key]) env[key] = process.env[key];
  env.HOME = resolve(home);
  env.SUWEN_BRIDGE_TOKEN = token;
  const child = spawn(python, ['-E', '-X', 'utf8', '-u', script, '--source', source, '--home', home], { cwd: resolve(home, '..'), env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  const pid = child.pid;
  let closed = false;
  let ready = false;
  let pending = '';
  let total = 0;
  let stopPromise: Promise<void> | undefined;
  let resolveReady: (value: LegacyHandle) => void;
  let rejectReady: (error: Error) => void;
  const started = new Promise<LegacyHandle>((resolveStart, rejectStart) => { resolveReady = resolveStart; rejectReady = rejectStart; });
  let resolveClosed: () => void;
  const exited = new Promise<void>(resolveExit => { resolveClosed = resolveExit; });
  child.stderr.resume(); // Logs never cross this API and cannot expose private paths in UI errors.
  child.stdin.on('error', () => {});
  const forceOwnedTree = async (): Promise<void> => {
    if (closed || !pid || child.pid !== pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
      const executable = join(process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'taskkill.exe');
      await new Promise<void>(resolveKill => execFile(executable, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => resolveKill()));
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* Owned process group already exited. */ }
    }
  };
  const stop = (): Promise<void> => stopPromise ??= (async () => {
    if (closed) return;
    child.stdin.end('shutdown\n');
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([exited, new Promise<void>(resolveWait => { timer = setTimeout(resolveWait, 8000); })]);
    if (timer) clearTimeout(timer);
    if (!closed) await forceOwnedTree();
    let fallback: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([exited, new Promise<void>((_, rejectWait) => { fallback = setTimeout(() => rejectWait(new Error('Legacy bridge process cleanup failed')), 6000); })]);
    if (fallback) clearTimeout(fallback);
  })();
  const fail = (message: string): void => {
    if (!ready) rejectReady(new Error(message));
    void stop().catch(() => {});
  };
  const cancel = (): void => fail('Legacy bridge cancelled');
  signal?.addEventListener('abort', cancel, { once: true });
  const startupTimeout = setTimeout(() => fail('Legacy bridge startup timed out; check the optional Python environment'), 90_000);
  child.on('error', () => { fail('Legacy bridge unavailable; select a Python interpreter with the legacy dependencies'); });
  child.on('close', () => {
    closed = true;
    clearTimeout(startupTimeout);
    signal?.removeEventListener('abort', cancel);
    resolveClosed();
    if (!ready) rejectReady(new Error('Legacy bridge exited before readiness; check the optional Python environment'));
  });
  child.stdout.on('data', (chunk: Buffer) => {
    if (ready) return;
    total += chunk.length;
    if (total > 16_384) { fail('Legacy bridge returned an invalid readiness response'); return; }
    pending += chunk.toString('utf8');
    const boundary = pending.indexOf('\n');
    if (boundary < 0) return;
    try {
      const response = JSON.parse(pending.slice(0, boundary));
      if (!pid || response.pid !== pid || !Number.isInteger(response.port) || response.port < 1 || response.port > 65535 || Object.keys(response).some(key => key !== 'pid' && key !== 'port')) throw new Error('Invalid readiness');
      ready = true;
      clearTimeout(startupTimeout);
      resolveReady({ port: response.port, token, pid, stop });
    } catch { fail('Legacy bridge returned an invalid readiness response'); }
  });
  return started;
}
