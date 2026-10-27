import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveUserData } from '../src/user-data.js';

test('user data uses an explicit isolated test home', () => {
  const appData = mkdtempSync(join(tmpdir(), 'eve-user-data-test-'));
  const testHome = join(appData, 'isolated');
  assert.deepEqual(resolveUserData({ appData, testHome }), { path: testHome });
});

test('legacy user data is adopted atomically without losing conversations', () => {
  const appData = mkdtempSync(join(tmpdir(), 'eve-user-data-legacy-'));
  const legacy = join(appData, 'SuWen');
  mkdirSync(join(legacy, 'runtime', 'legacy', 'conversations'), { recursive: true });
  writeFileSync(join(legacy, 'runtime', 'legacy', 'conversations', 'conversation.json'), '{"title":"preserved"}');

  const result = resolveUserData({ appData });

  assert.equal(result.path, join(appData, 'Eve'));
  assert.equal(result.migratedFrom, legacy);
  assert.equal(existsSync(legacy), false);
  assert.equal(readFileSync(join(result.path, 'runtime', 'legacy', 'conversations', 'conversation.json'), 'utf8'), '{"title":"preserved"}');
});

test('an existing Eve profile wins and the legacy directory remains untouched', () => {
  const appData = mkdtempSync(join(tmpdir(), 'eve-user-data-existing-'));
  const legacy = join(appData, 'SuWen');
  const current = join(appData, 'Eve');
  mkdirSync(legacy);
  mkdirSync(current);

  assert.deepEqual(resolveUserData({ appData }), { path: current });
  assert.equal(existsSync(legacy), true);
});
