import { spawn, execFile, type ChildProcessByStdio } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Managed runtime for the full research workbench (the legacy web application).
 *
 * The desktop shell hosts the complete web UI, but its Python dependencies are
 * deliberately not bundled into the installer: they are downloaded on explicit
 * user request into a desktop-owned directory. This module owns that lifecycle
 * (detect interpreter, verify an isolated dependency set, install/repair, probe)
 * so the renderer never has to guess whether the workbench can start.
 */

/** Exact top-level dependency set validated with the packaged bridge. */
export const WORKBENCH_REQUIREMENTS = [
  'fastapi==0.162.0',
  'uvicorn==0.54.0',
  'jupyter_client==8.10.0',
  'ipykernel==7.4.0',
  'httpx==0.28.1',
  'nbformat==5.11.1',
  'python-multipart==0.0.32',
  'PyYAML==6.0.3',
  'rich==15.0.0',
  'prompt_toolkit==3.0.53',
  'websockets==17.3',
  'paramiko==5.1.0',
  'qrcode==8.2',
] as const;

export const WORKBENCH_MARKER = '.suwen-workbench.json';
export const WORKBENCH_SCHEMA = 1;
/** Approximate first-install download; shown to the user before the network transfer. */
export const WORKBENCH_DOWNLOAD_MB = 130;
const INSTALL_TIMEOUT_MS = 20 * 60_000;
const PROBE_TIMEOUT_MS = 20_000;
const PROBE_MODULES = ['fastapi', 'uvicorn', 'ipykernel', 'jupyter_client', 'paramiko', 'httpx'];
const SAFE_ENV_KEYS = [
  'SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'PIP_INDEX_URL', 'PIP_TRUSTED_HOST', 'PIP_EXTRA_INDEX_URL',
  'REQUESTS_CA_BUNDLE', 'SSL_CERT_FILE',
];

export interface WorkbenchStatus {
  ok: boolean;
  python: string;
  pythonVersion: string | null;
  pip: boolean;
  depsDir: string;
  installed: boolean;
  installing: boolean;
  bytes: number;
  downloadMb: number;
  requirementsHash: string;
  markerPython: string | null;
  installedAt: number | null;
  missing: string[];
  error: string | null;
}

export interface WorkbenchProgressEvent {
  phase: 'checking' | 'installing' | 'verifying' | 'installed' | 'error';
  message: string;
  detail?: string;
  installed?: WorkbenchStatus;
}

export interface WorkbenchOptions {
  depsDir: string;
  home: string;
  python: () => string;
  /** Injected for tests; defaults to spawning the configured Python. */
  run?: (args: string[], options: { timeoutMs: number; env: NodeJS.ProcessEnv }) => Promise<{ code: number | null; stdout: string; stderr: string }>;
}

function safeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) if (process.env[key]) env[key] = process.env[key];
  return env;
}

/** Stable hash of the pinned top-level requirement set (marker invalidation). */
export function requirementsHash(requirements: readonly string[] = WORKBENCH_REQUIREMENTS): string {
  return createHash('sha256').update(requirements.join('\n')).digest('hex');
}

/** `3.11.9` -> `3.11` (a dependency set is valid only for the interpreter minor version). */
export function pythonMinor(version: string | null): string | null {
  const match = String(version ?? '').match(/^(\d+)\.(\d+)\./);
  return match ? `${match[1]}.${match[2]}` : null;
}

export class WorkbenchManager {
  readonly depsDir: string;
  readonly home: string;
  private readonly python: () => string;
  private readonly runner: NonNullable<WorkbenchOptions['run']>;
  private child: PipedChild | null = null;
  private installing: Promise<WorkbenchStatus> | null = null;
  private lastError: string | null = null;

  constructor(options: WorkbenchOptions) {
    this.depsDir = options.depsDir;
    this.home = options.home;
    this.python = options.python;
    this.runner = options.run ?? ((args, opts) => this.spawnPython(args, opts));
  }

  private spawnPython(args: string[], options: { timeoutMs: number; env: NodeJS.ProcessEnv }): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolveResult, reject) => {
      let child: PipedChild;
      try {
        child = spawn(this.python(), args, { env: { ...safeEnv(), ...options.env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.killTree(child);
        reject(new Error('Python probe timed out'));
      }, options.timeoutMs);
      timer.unref?.();
      child.stdout.on('data', chunk => { if (stdout.length < 200_000) stdout += chunk.toString('utf8'); });
      child.stderr.on('data', chunk => { if (stderr.length < 200_000) stderr += chunk.toString('utf8'); });
      child.on('error', error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Cannot run Python (${error.message})`));
      });
      child.on('close', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveResult({ code, stdout, stderr });
      });
    });
  }

  private killTree(child: PipedChild): void {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    if (process.platform === 'win32') {
      const executable = join(process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'taskkill.exe');
      execFile(executable, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }, () => {});
    } else {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }

  private async detect(): Promise<{ version: string | null; pip: boolean; error: string | null }> {
    try {
      const version = await this.runner(['-E', '-s', '-c', 'import sys;print(sys.version.split()[0])'], { timeoutMs: PROBE_TIMEOUT_MS, env: {} });
      if (version.code !== 0) return { version: null, pip: false, error: (version.stderr || version.stdout || 'Python unavailable').trim().slice(0, 400) };
      const pip = await this.runner(['-E', '-s', '-m', 'pip', '--version'], { timeoutMs: PROBE_TIMEOUT_MS, env: {} });
      return { version: version.stdout.trim() || null, pip: pip.code === 0, error: pip.code === 0 ? null : 'pip is not available for the selected Python interpreter' };
    } catch (error) {
      return { version: null, pip: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private readMarker(): { requirementsHash?: unknown; python?: unknown; installedAt?: unknown } | null {
    const path = join(this.depsDir, WORKBENCH_MARKER);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      if (parsed.schema !== WORKBENCH_SCHEMA) return null;
      return parsed;
    } catch { return null; }
  }

  private dirBytes(): number {
    if (!existsSync(this.depsDir)) return 0;
    let total = 0;
    const walk = (dir: string): void => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        try {
          if (entry.isDirectory()) walk(full);
          else if (entry.isFile()) total += statSync(full).size;
        } catch { /* raced with installer */ }
      }
    };
    walk(this.depsDir);
    return total;
  }

  private async probeDeps(): Promise<{ ok: boolean; detail: string }> {
    const script = 'import sys;sys.path.insert(0,sys.argv[1]);import ' + PROBE_MODULES.join(',') + ';print("ok")';
    try {
      const result = await this.runner(['-E', '-s', '-c', script, this.depsDir], { timeoutMs: PROBE_TIMEOUT_MS, env: {} });
      if (result.code === 0 && result.stdout.includes('ok')) return { ok: true, detail: '' };
      return { ok: false, detail: (result.stderr || result.stdout || 'dependency import failed').trim().slice(0, 400) };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async status(): Promise<WorkbenchStatus> {
    const detected = await this.detect();
    const marker = this.readMarker();
    const expectedHash = requirementsHash();
    const markerMatches = !!marker
      && marker.requirementsHash === expectedHash
      && pythonMinor(typeof marker.python === 'string' ? marker.python : null) === pythonMinor(detected.version);
    let installed = false;
    let missing: string[] = [];
    let probeError: string | null = null;
    if (markerMatches) {
      const probe = await this.probeDeps();
      installed = probe.ok;
      if (!probe.ok) { missing = PROBE_MODULES.slice(); probeError = probe.detail || null; }
    } else if (detected.pip) missing = PROBE_MODULES.slice();
    const bytes = this.dirBytes();
    return {
      ok: detected.version !== null && detected.pip,
      python: this.python(),
      pythonVersion: detected.version,
      pip: detected.pip,
      depsDir: this.depsDir,
      installed,
      installing: this.installing !== null,
      bytes,
      downloadMb: WORKBENCH_DOWNLOAD_MB,
      requirementsHash: expectedHash,
      markerPython: typeof marker?.python === 'string' ? marker.python : null,
      installedAt: typeof marker?.installedAt === 'number' ? marker.installedAt : null,
      missing,
      error: this.lastError ?? detected.error ?? probeError,
    };
  }
  /** Reuse a working interpreter without requiring a redundant managed install. */
  async runtime():Promise<{ready:boolean;depsDir?:string}> {
    const managed=await this.status();if(managed.installed)return {ready:true,depsDir:this.depsDir};
    try {
      const probe=await this.runner(['-E','-c','import uvicorn, fastapi, jupyter_client, ipykernel, nbformat, httpx, rich, yaml, prompt_toolkit, qrcode;print("suwen-ready")'],{timeoutMs:PROBE_TIMEOUT_MS,env:{}});
      return {ready:probe.code===0&&probe.stdout.includes('suwen-ready')};
    } catch { return {ready:false}; }
  }

  /**
   * Install the pinned dependency set into the desktop-owned directory.
   * Idempotent: a matching marker with passing import probe returns instantly.
   */
  async install(onProgress: (event: WorkbenchProgressEvent) => void): Promise<WorkbenchStatus> {
    if (this.installing) return this.installing;
    const run = async (): Promise<WorkbenchStatus> => {
      this.lastError = null;
      onProgress({ phase: 'checking', message: '检查 Python 与依赖状态…' });
      const detected = await this.detect();
      if (!detected.version) {
        const status = await this.status();
        this.lastError = detected.error ?? 'Python unavailable';
        onProgress({ phase: 'error', message: '未找到可用的 Python 解释器', detail: this.lastError });
        return status;
      }
      if (!detected.pip) {
        const status = await this.status();
        this.lastError = 'pip is not available';
        onProgress({ phase: 'error', message: '该 Python 缺少 pip，无法安装科研工作台依赖', detail: detected.error ?? undefined });
        return status;
      }
      const current = await this.status();
      if (current.installed) {
        onProgress({ phase: 'installed', message: '科研工作台依赖已就绪', installed: current });
        return current;
      }
      mkdirSync(this.depsDir, { recursive: true });
      const requirementsPath = join(this.depsDir, 'requirements.suwen.txt');
      writeFileSync(requirementsPath, WORKBENCH_REQUIREMENTS.join('\n') + '\n', { encoding: 'utf8' });
      onProgress({ phase: 'installing', message: `正在下载并安装科研工作台依赖（约 ${WORKBENCH_DOWNLOAD_MB} MB，需要联网）…`, detail: this.depsDir });
      const args = ['-E', '-s', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--no-warn-script-location', '--upgrade', '--progress-bar', 'off', '--target', this.depsDir, '-r', requirementsPath];
      const result = await new Promise<{ code: number | null; tail: string }>((resolveResult, reject) => {
        let child: PipedChild;
        try {
          child = spawn(this.python(), args, { env: safeEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) { reject(error); return; }
        this.child = child;
        const tail: string[] = [];
        let stderr = '';
        const push = (line: string): void => {
          if (!line) return;
          tail.push(line);
          if (tail.length > 8) tail.shift();
          onProgress({ phase: 'installing', message: '正在安装依赖…', detail: tail.join('\n') });
        };
        let buffer = '';
        const onData = (chunk: Buffer): void => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';
          for (const line of lines) push(line.trim());
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
        const timer = setTimeout(() => { this.killTree(child); }, INSTALL_TIMEOUT_MS);
        timer.unref?.();
        child.on('error', error => { clearTimeout(timer); this.child = null; reject(error); });
        child.on('close', code => {
          clearTimeout(timer);
          this.child = null;
          if (buffer.trim()) push(buffer.trim());
          resolveResult({ code, tail: (stderr || tail.join('\n')).slice(-4000) });
        });
      });
      if (result.code !== 0) {
        this.lastError = result.tail || 'dependency installation failed';
        const status = await this.status();
        onProgress({ phase: 'error', message: '依赖安装失败；可重试或检查网络/代理设置', detail: this.lastError.slice(-2000) });
        return status;
      }
      onProgress({ phase: 'verifying', message: '正在校验已安装依赖…' });
      const probe = await this.probeDeps();
      if (!probe.ok) {
        this.lastError = probe.detail;
        const status = await this.status();
        onProgress({ phase: 'error', message: '依赖校验失败', detail: probe.detail });
        return status;
      }
      const marker = { schema: WORKBENCH_SCHEMA, requirementsHash: requirementsHash(), python: detected.version, installedAt: Date.now(), requirements: WORKBENCH_REQUIREMENTS.slice() };
      const markerPath = join(this.depsDir, WORKBENCH_MARKER);
      const tmp = markerPath + '.tmp';
      writeFileSync(tmp, JSON.stringify(marker, null, 2), { encoding: 'utf8' });
      renameSync(tmp, markerPath);
      try { unlinkSync(requirementsPath); } catch { /* keep directory tidy; harmless */ }
      const status = await this.status();
      onProgress({ phase: 'installed', message: '科研工作台依赖已就绪', installed: status });
      return status;
    };
    this.installing = run().finally(() => { this.installing = null; });
    return this.installing;
  }

  /** Cancel an in-flight installation (safe to call from the UI). */
  cancel(): boolean {
    if (!this.child) return false;
    const child = this.child;
    this.child = null;
    this.killTree(child);
    this.lastError = '安装已取消';
    return true;
  }
}
