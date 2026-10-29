import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceFiles, normalizeWorkspacePath } from '../src/workspace-files.js';

function fixture(t: { after: (callback: () => void) => void }): { root: string; files: WorkspaceFiles } {
  const directory = mkdtempSync(join(tmpdir(), 'eve-workspace-'));
  const root = join(directory, 'project');
  mkdirSync(join(root, 'data', 'RNA-seq'), { recursive: true });
  mkdirSync(join(root, 'analysis'), { recursive: true });
  writeFileSync(join(root, 'data', 'RNA-seq', 'counts.csv'), 'gene,count\nTP53,42\n');
  writeFileSync(join(root, 'analysis', 'summary.txt'), 'verified result');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { root, files: new WorkspaceFiles([root], []) };
}

test('path normalization repairs copied full-width separators, quotes and trailing punctuation', () => {
  assert.equal(normalizeWorkspacePath(' “data／RNA－seq／counts.csv”。 '), 'data/RNA-seq/counts.csv');
  assert.equal(normalizeWorkspacePath('`analysis\\summary.txt`'), 'analysis\\summary.txt');
});

test('read paths recover a unique case, separator and spelling mismatch', async t => {
  const { root, files } = fixture(t);
  const caseFixed = await files.resolve('DATA/rna-seq/COUNTS.csv');
  assert.equal(caseFixed.path, join(root, 'data', 'RNA-seq', 'counts.csv'));
  assert.equal(caseFixed.reason, 'resolved');

  const typo = await files.resolve('dat/rna_seqi/count.csv');
  assert.equal(typo.path, join(root, 'data', 'RNA-seq', 'counts.csv'));
  assert.ok(typo.confidence > 0.7);

  const quoted = await files.resolve('“data／RNA－seq／counts.csv”。');
  assert.equal(quoted.path, join(root, 'data', 'RNA-seq', 'counts.csv'));
});

test('ambiguous basename returns candidates instead of guessing', async t => {
  const { root, files } = fixture(t);
  writeFileSync(join(root, 'analysis', 'counts.csv'), 'gene,count\nGAPDH,7\n');
  const resolution = await files.resolve('counts.csv');
  assert.equal(resolution.path, null);
  assert.equal(resolution.reason, 'ambiguous');
  assert.equal(resolution.suggestions.length, 2);
  await assert.rejects(files.read('counts.csv'), /Path ambiguous/);
});

test('write resolution never fuzzes to a different existing file', async t => {
  const { root, files } = fixture(t);
  const exactCase = await files.resolve('DATA/rna-seq/COUNTS.csv', { write: true });
  assert.equal(exactCase.path, join(root, 'data', 'RNA-seq', 'counts.csv'));
  const typo = await files.resolve('data/rna-seq/counts.csv', { write: true });
  assert.equal(typo.path, join(root, 'data', 'RNA-seq', 'counts.csv'));
  const different = await files.resolve('data/rna-seq/countz.csv', { write: true });
  // An exact new relative path is a valid create target; it must not be
  // rewritten to the similarly named existing file.
  assert.equal(different.path, join(root, 'data', 'RNA-seq', 'countz.csv'));
  assert.notEqual(different.path, join(root, 'data', 'RNA-seq', 'counts.csv'));
  assert.equal(different.reason, 'resolved');
});

test('traversal and symlink escape cannot expand the workspace grant', async t => {
  const { root, files } = fixture(t);
  const outside = join(root, '..', 'outside.txt');
  writeFileSync(outside, 'secret');
  try { symlinkSync(outside, join(root, 'analysis', 'escape.txt'), 'file'); } catch { /* Windows may deny symlink creation */ }
  await assert.rejects(files.read('../outside.txt'), /Path (?:missing|outside)/);
  await assert.rejects(files.read('analysis/escape.txt'), /outside|missing|ambiguous/i);
  const resolved = await files.resolve('../outside.txt');
  assert.equal(resolved.path, null);
});
