import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  WORKBENCH_MARKER,
  WORKBENCH_SCHEMA,
  WorkbenchManager,
  promoteManagedDirectory,
  pythonMinor,
  requirementsHash,
  type WorkbenchStatus,
} from '../src/workbench.js';

interface FakeRun { code: number | null; stdout: string; stderr: string }

/** Fake interpreter: version/pip/probe calls are answered from explicit switches. */
function fakeRunner(options: { version?: string | null; pip?: boolean; probe?: boolean }) {
  const calls: string[][] = [];
  const run = async (args: string[]): Promise<FakeRun> => {
    calls.push(args);
    const joined = args.join(' ');
    if (joined.includes('sys.version.split')) {
      if (!options.version) return { code: 1, stdout: '', stderr: 'No Python found' };
      return { code: 0, stdout: `${options.version}\n`, stderr: '' };
    }
    if (joined.includes('pip') && joined.includes('--version')) {
      return options.pip ? { code: 0, stdout: 'pip 26.1.1\n', stderr: '' } : { code: 1, stdout: '', stderr: 'no pip' };
    }
    if (joined.includes('suwen-ready')) {
      return options.probe ? { code: 0, stdout: 'suwen-ready\n', stderr: '' } : { code: 1, stdout: '', stderr: 'ModuleNotFoundError: pypdf' };
    }
    if (joined.includes('import fastapi')) {
      return options.probe ? { code: 0, stdout: 'ok\n', stderr: '' } : { code: 1, stdout: '', stderr: 'ModuleNotFoundError: fastapi' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

function fixture(options: { python?: string | null; pip?: boolean; probe?: boolean; marker?: Record<string, unknown> | null; bytes?: number }) {
  const root = mkdtempSync(join(tmpdir(), 'suwen-wb-'));
  const depsDir = join(root, 'python-env');
  if (options.marker) {
    mkdirSync(depsDir, { recursive: true });
    writeFileSync(join(depsDir, WORKBENCH_MARKER), JSON.stringify({ schema: WORKBENCH_SCHEMA, ...options.marker }), 'utf8');
  }
  if (options.bytes) {
    mkdirSync(depsDir, { recursive: true });
    writeFileSync(join(depsDir, 'payload.bin'), Buffer.alloc(options.bytes, 7));
  }
  const fake = fakeRunner({ version: options.python ?? null, pip: options.pip ?? false, probe: options.probe ?? false });
  const manager = new WorkbenchManager({ depsDir, home: root, python: () => 'python', run: fake.run });
  return { root, depsDir, manager, calls: fake.calls };
}

test('no usable Python reports unavailable with the interpreter error', async () => {
  const { root, manager } = fixture({});
  try {
    const status: WorkbenchStatus = await manager.status();
    assert.equal(status.installed, false);
    assert.equal(status.pythonVersion, null);
    assert.ok(status.error && /No Python found/.test(status.error));
    assert.equal(status.downloadMb > 0, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a valid marker with a passing import probe is reported as installed', async () => {
  const { root, depsDir, manager } = fixture({
    python: '3.11.9', pip: true, probe: true, bytes: 300,
    marker: { requirementsHash: requirementsHash(), python: '3.11.9', installedAt: 1700000000000 },
  });
  try {
    const status = await manager.status();
    assert.equal(status.installed, true);
    assert.equal(status.pythonVersion, '3.11.9');
    assert.equal(status.pip, true);
    assert.deepEqual(status.missing, []);
    assert.ok(status.bytes >= 300);
    assert.equal(status.markerPython, '3.11.9');
    assert.equal(status.installedAt, 1700000000000);
    assert.equal(status.depsDir, depsDir);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a marker from a different requirement set is invalidated', async () => {
  const { root, manager } = fixture({
    python: '3.11.9', pip: true, probe: true,
    marker: { requirementsHash: 'deadbeef', python: '3.11.9', installedAt: 1 },
  });
  try {
    const status = await manager.status();
    assert.equal(status.installed, false);
    assert.ok(status.missing.length > 0);
    assert.equal(status.requirementsHash, requirementsHash());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a marker from another Python minor version is invalidated', async () => {
  const { root, manager } = fixture({
    python: '3.11.9', pip: true, probe: true,
    marker: { requirementsHash: requirementsHash(), python: '3.12.4', installedAt: 1 },
  });
  try {
    const status = await manager.status();
    assert.equal(status.installed, false);
    assert.ok(status.missing.length > 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a marker whose import probe fails is not reported as installed', async () => {
  const { root, manager } = fixture({
    python: '3.11.9', pip: true, probe: false,
    marker: { requirementsHash: requirementsHash(), python: '3.11.9', installedAt: 1 },
  });
  try {
    const status = await manager.status();
    assert.equal(status.installed, false);
    assert.ok(status.error && /fastapi/.test(status.error));
    assert.ok(status.missing.includes('fastapi'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reusing a system interpreter requires the PDF and upload dependencies', async () => {
  const { root, manager, calls } = fixture({ python: '3.11.9', pip: true, probe: true });
  try {
    assert.deepEqual(await manager.runtime(), { ready: true });
    const probe = calls.find(args => args.join(' ').includes('suwen-ready'));
    assert.ok(probe, 'expected a runtime import probe');
    const source = probe.join(' ');
    assert.match(source, /\bpypdf\b/);
    assert.match(source, /\bmultipart\b/);
    assert.match(source, /\bwebsockets\b/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pythonMinor only accepts a full interpreter version', () => {
  assert.equal(pythonMinor('3.11.9'), '3.11');
  assert.equal(pythonMinor('3.12.0 (tags/v3.12.0)'), '3.12');
  assert.equal(pythonMinor('unknown'), null);
  assert.equal(pythonMinor(null), null);
});

test('cancel without an in-flight install is a no-op', () => {
  const { root, manager } = fixture({});
  try { assert.equal(manager.cancel(), false); } finally { rmSync(root, { recursive: true, force: true }); }
});

test('verified dependency staging replaces the active environment', () => {
  const root = mkdtempSync(join(tmpdir(), 'suwen-wb-promote-'));
  const active = join(root, 'python-env');
  const staging = join(root, '.eve-python-env-test');
  try {
    mkdirSync(active);
    mkdirSync(staging);
    writeFileSync(join(active, 'version.txt'), 'old');
    writeFileSync(join(staging, 'version.txt'), 'new');
    promoteManagedDirectory(staging, active);
    assert.equal(readFileSync(join(active, 'version.txt'), 'utf8'), 'new');
    assert.equal(existsSync(staging), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed dependency promotion restores the previous environment', () => {
  const root = mkdtempSync(join(tmpdir(), 'suwen-wb-restore-'));
  const active = join(root, 'python-env');
  try {
    mkdirSync(active);
    writeFileSync(join(active, 'version.txt'), 'old');
    assert.throws(() => promoteManagedDirectory(join(root, 'missing-staging'), active));
    assert.equal(readFileSync(join(active, 'version.txt'), 'utf8'), 'old');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
