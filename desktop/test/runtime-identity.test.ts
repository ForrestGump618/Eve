import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { blocksRuntimeUpgrade, compatibleRuntime, diagnosticConsole, runtimeIdentity } from '../src/runtime-identity.js';

test('same-version daemons are reused only for the same identified build and installation', () => {
  const root = mkdtempSync(join(tmpdir(), 'eve-build-identity-'));
  writeFileSync(join(root, 'build-info.json'), JSON.stringify({ buildId: 'a'.repeat(64) }));
  const expected = runtimeIdentity('1.0.0', root);
  assert.equal(compatibleRuntime(expected, expected), true);
  assert.equal(compatibleRuntime({ ...expected, buildId: 'b'.repeat(64) }, expected), false);
  assert.equal(compatibleRuntime({ ...expected, runtimeRoot: root + '-old' }, expected), false);
  assert.equal(compatibleRuntime({ version: '1.0.0' }, expected), false);
});

test('missing or malformed build manifests cannot authorize stale daemon reuse', () => {
  const root = mkdtempSync(join(tmpdir(), 'eve-build-missing-'));
  const missing = runtimeIdentity('1.0.0', root);
  assert.equal(compatibleRuntime(missing, missing), false);
  writeFileSync(join(root, 'build-info.json'), '{"buildId":"not-a-digest"}');
  assert.equal(runtimeIdentity('1.0.0', root).buildId, null);
});

test('legacy console arguments cannot replace the normal product home', () => {
  assert.equal(diagnosticConsole(['--native']), false);
  assert.equal(diagnosticConsole(['--native'], '/isolated-test-profile'), true);
  assert.equal(diagnosticConsole([], '/isolated-test-profile'), false);
});

test('upgrade preserves dormant tasks but cannot interrupt runnable or in-flight work', () => {
  assert.equal(blocksRuntimeUpgrade({ tasks: [{ status: 'paused', steps: [{ status: 'waiting_approval' }] }] }), false);
  assert.equal(blocksRuntimeUpgrade({ tasks: [{ status: 'waiting_approval' }] }), false);
  assert.equal(blocksRuntimeUpgrade({ tasks: [{ status: 'pending' }] }), true);
  assert.equal(blocksRuntimeUpgrade({ tasks: [{ status: 'running' }] }), true);
  assert.equal(blocksRuntimeUpgrade({ tasks: [{ status: 'paused', steps: [{ status: 'running' }] }] }), true);
});
