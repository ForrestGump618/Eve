/**
 * Real-process node:test coverage for the research worker and its persistent
 * TypeScript client.
 *
 * No mocks and no network: every test drives the actual Python worker through
 * the compiled client (or through the raw JSON-lines protocol for the protocol
 * compatibility test). Tests skip only when no Python interpreter is present,
 * and say so with the probe evidence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Json } from '../src/harness/types.js';
import {
  createResearchWorker,
  ResearchWorkerError,
  type ResearchWorkerClient,
  type ResearchWorkerOptions,
  resolveResearchWorkerScript,
} from '../src/research-worker.js';

const PYTHON = process.env.SUWEN_TEST_PYTHON || 'python';
const pythonProbe = spawnSync(PYTHON, ['-E', '-c', 'import sys; print(sys.version)'], {
  encoding: 'utf8',
  windowsHide: true,
  timeout: 10_000,
});
const PYTHON_OK = !pythonProbe.error && pythonProbe.status === 0;
const PYTHON_SKIP = `Python interpreter is unavailable (${PYTHON}): ${pythonProbe.error?.message ?? (pythonProbe.stderr || `exit ${pythonProbe.status}`).trim()}`;

const FIXTURES = fileURLToPath(new URL('../../test/fixtures/worker/', import.meta.url));
const DEMO_FCS = fileURLToPath(new URL('../../../omicslab/data/demo.fcs', import.meta.url));
const DEMO_COUNTS_CSV = fileURLToPath(new URL('../../../omicslab/data/demo_counts.csv', import.meta.url));
const NEVER = new AbortController().signal;

interface JsonObject { [key: string]: Json }

function object(value: Json | undefined): JsonObject {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), 'expected a JSON object');
  return value as JsonObject;
}

function array(value: Json | undefined): Json[] {
  assert.ok(Array.isArray(value), 'expected a JSON array');
  return value as Json[];
}

function text(value: Json | undefined): string {
  assert.equal(typeof value, 'string', 'expected a JSON string');
  return value as string;
}

function numberValue(value: Json | undefined): number {
  assert.equal(typeof value, 'number', 'expected a JSON number');
  return value as number;
}

function booleanValue(value: Json | undefined): boolean {
  assert.equal(typeof value, 'boolean', 'expected a JSON boolean');
  return value as boolean;
}

function assertClose(actual: number, expected: number, tolerance = 1e-9): void {
  const scale = Math.max(1, Math.abs(expected));
  assert.ok(Math.abs(actual - expected) <= tolerance * scale, `expected ${actual} to be within ${tolerance} relative of ${expected}`);
}

function sha256(buffer: Buffer | string): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function makeDir(t: { after: (fn: () => void) => void }, prefix: string): string {
  // Resolve 8.3 short names (e.g. QINGYU~1) so paths returned by Python compare cleanly.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeClient(t: { after: (fn: () => Promise<void> | void) => void }, options: ResearchWorkerOptions = {}): ResearchWorkerClient {
  const client = createResearchWorker({ python: PYTHON, ...options });
  t.after(async () => {
    await client.close();
  });
  return client;
}

async function call(client: ResearchWorkerClient, op: string, input: Json = {}, signal: AbortSignal = NEVER): Promise<Json> {
  return client.call(op, input, signal);
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<ResearchWorkerError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ResearchWorkerError, `expected ResearchWorkerError, received ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected the promise to reject with ${code}`);
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
  }
  assert.fail(`timed out after ${timeoutMs} ms waiting for ${label}`);
}

function decodeFixture(t: Parameters<typeof makeDir>[0], fixtureName: string, outputName: string): { path: string; bytes: Buffer } {
  const dir = makeDir(t, 'suwen-fixture-');
  const encoded = readFileSync(join(FIXTURES, fixtureName), 'utf8').trim();
  const bytes = Buffer.from(encoded, 'base64');
  const path = join(dir, outputName);
  writeFileSync(path, bytes);
  return { path, bytes };
}

test('resolves the bundled worker script and reports a healthy Python worker', { timeout: 60_000 }, async t => {
  if (!PYTHON_OK) {
    t.skip(PYTHON_SKIP);
    return;
  }
  const script = resolveResearchWorkerScript();
  assert.ok(existsSync(script));
  assert.ok(script.endsWith('research_worker.py'));
  const client = makeClient(t);
  assert.equal(client.diagnostics().script, script);
  const health = await client.health();
  assert.equal(health.status, 'ok');
  assert.match(health.python ?? '', /^\d+\.\d+\.\d+/);
  assert.equal(health.version, '2.0.0');
  assert.deepEqual(health.capabilities, ['health', 'describe', 'flowSummary', 'datasetProfile', 'discoveryScan', 'runScript']);
  assert.equal(typeof health.deps?.numpy, 'string');
  assert.equal(typeof health.deps?.scipy, 'string');
  const status = client.status();
  assert.equal(status.state, 'ready');
  assert.ok(typeof status.pid === 'number' && status.pid > 0);
  assert.equal(status.restarts, 0);
});

test('describe advertises the protocol and every supported operation', { timeout: 60_000 }, async t => {
  if (!PYTHON_OK) {
    t.skip(PYTHON_SKIP);
    return;
  }
  const client = makeClient(t);
  const describe = object(await client.describe());
  assert.equal(text(describe.protocol), 'suwen-research-worker/2');
  assert.equal(text(describe.version), '2.0.0');
  const ops = object(describe.ops);
  assert.deepEqual(Object.keys(ops).sort(), ['datasetProfile', 'describe', 'discoveryScan', 'flowSummary', 'health', 'runScript']);
  for (const name of Object.keys(ops)) {
    const op = object(ops[name]);
    assert.ok(text(op.description).length > 10);
    assert.ok('input' in op);
    assert.ok('output' in op);
  }
  assert.equal(numberValue(object(describe.limits).maxArtifacts), 256);
});

test('flowSummary parses the real demo.fcs with exact events, channels and per-channel statistics', { timeout: 120_000 }, async t => {
  if (!PYTHON_OK) {
    t.skip(PYTHON_SKIP);
    return;
  }
  const client = makeClient(t);
  const result = object(await call(client, 'flowSummary', { path: DEMO_FCS }));
  const file = object(result.file);
  assert.equal(numberValue(file.bytes), 120_811);
  assert.equal(text(file.sha256), '40ba7ac2b9a3f0095116931e21d6e4fb231d7afe5a585d25368571058abaf0d8');
  assert.equal(text(result.fcsVersion), '3.1');
  assert.equal(numberValue(result.par), 5);
  assert.equal(numberValue(result.eventCount), 6000);
  assert.equal(numberValue(result.eventCountDeclared), 6000);
  assert.equal(text(result.datatype), 'F');
  assert.equal(text(result.endian), 'little');
  assert.equal(text(result.byteord), '1,2,3,4');
  assert.deepEqual(array(result.channelNames), ['FSC-A', 'SSC-A', 'FL1-A', 'FL2-A', 'FL3-A']);
  assert.deepEqual(array(result.markers), ['FSC-A', 'SSC-A', 'CD3', 'CD19', 'CD14']);
  const expected = [
    { channel: 'FSC-A', mean: 50357.3182109375, median: 52082.4140625, min: 24081.837890625, max: 87964.8359375, stddev: 15428.992941258295 },
    { channel: 'SSC-A', mean: 30390.82620933024, median: 23328.9873046875, min: 1224.3909912109375, max: 87807.9453125, stddev: 23908.602116698952 },
    { channel: 'FL1-A', mean: 734.9151572555118, median: 156.6205062866211, min: 0, max: 3948.5390625, stddev: 1062.531324811597 },
    { channel: 'FL2-A', mean: 363.63072526567413, median: 186.2959976196289, min: 0, max: 3268.72998046875, stddev: 569.3247347873969 },
    { channel: 'FL3-A', mean: 788.0968406620225, median: 482.5080108642578, min: 0, max: 3489.155029296875, stddev: 772.6589365905347 },
  ];
  const stats = array(result.stats);
  assert.equal(stats.length, 5);
  for (let index = 0; index < expected.length; index += 1) {
    const stat = object(stats[index]);
    assert.equal(text(stat.channel), expected[index].channel);
    assert.equal(numberValue(stat.count), 6000);
    for (const key of ['mean', 'median', 'min', 'max', 'stddev'] as const) {
      assertClose(numberValue(stat[key]), expected[index][key]);
    }
  }
  const defaults = array(result.populations).map(population => object(population));
  assert.deepEqual(defaults.map(population => text(population.name)), ['above:FSC-A', 'above:SSC-A', 'above:FL1-A', 'above:FL2-A', 'above:FL3-A']);
  assert.deepEqual(defaults.map(population => numberValue(population.count)), [3199, 1979, 1612, 653, 1279]);
  assert.deepEqual(defaults.map(population => text(population.method)), ['otsu', 'otsu', 'otsu', 'otsu', 'otsu']);
  for (const population of defaults) assertClose(numberValue(population.fraction), numberValue(population.count) / 6000);
  const spillover = object(result.spillover);
  assert.deepEqual(array(spillover.channels), ['FL1-A', 'FL2-A', 'FL3-A']);
  const matrix = array(spillover.matrix).map(row => array(row).map(value => numberValue(value)));
  assert.equal(matrix.length, 3);
  assert.deepEqual(matrix[0].map(value => Number(value.toFixed(6))), [1, 0.12, 0.05]);
});

test('flowSummary honors caller-supplied threshold and rule populations', { timeout: 120_000 }, async t => {
  if (!PYTHON_OK) {
    t.skip(PYTHON_SKIP);
    return;
  }
  const client = makeClient(t);
  const result = object(await call(client, 'flowSummary', {
    path: DEMO_FCS,
    populations: [
      { name: 'cd3', channel: 'FL1-A', op: '>=', value: 1000 },
      { name: 'cd19', channel: 'FL2-A', op: '>=', value: 800 },
      { name: 'cd14', channel: 'FL3-A', op: '>=', value: 1000 },
      { name: 'double-positive', rules: [{ channel: 'FL1-A', op: '>=', value: 1000 }, { channel: 'FL2-A', op: '>=', value: 800 }] },
    ],
  }));
  const populations = array(result.populations).map(entry => object(entry));
  assert.equal(populations.length, 4);
  assert.deepEqual(populations.slice(0, 3).map(entry => numberValue(entry.count)), [1625, 667, 1411]);
  assertClose(numberValue(populations[0].fraction), 1625 / 6000);
  assert.equal(text(populations[0].method), 'threshold');
  assert.equal(numberValue(populations[3].count), 0);
  assert.equal(array(populations[3].rules).length, 2);
  assert.equal(numberValue(object(array(populations[3].rules)[0]).value), 1000);
});

test('flowSummary parses FCS 2.0 little-endian float32, FCS 3.0 big-endian float64 and FCS 3.1 integer fixtures', { timeout: 120_000 }, async t => {
  if (!PYTHON_OK) {
    t.skip(PYTHON_SKIP);
    return;
  }
  const client = makeClient(t);
  const fcs20 = decodeFixture(t, 'tiny_fcs20_le_f32.b64', 'tiny20.fcs');
  const fcs30 = decodeFixture(t, 'tiny_fcs30_be_f64.b64', 'tiny30.fcs');
  const fcs31 = decodeFixture(t, 'tiny_fcs31_i16_le.b64', 'tiny31.fcs');
  assert.equal(fcs20.bytes.length, 592);
  assert.equal(fcs30.bytes.length, 550);
  assert.equal(fcs31.bytes.length, 510);

  const result20 = object(await call(client, 'flowSummary', { path: fcs20.path }));
  assert.equal(text(result20.fcsVersion), '2.0');
  assert.equal(numberValue(result20.par), 3);
  assert.equal(numberValue(result20.eventCount), 4);
  assert.equal(text(result20.datatype), 'F');
  assert.equal(text(result20.endian), 'little');
  assert.equal(text(object(result20.file).sha256), sha256(fcs20.bytes));
  assert.deepEqual(array(result20.channelNames), ['A', 'B', 'C']);
  assert.deepEqual(array(result20.markers), ['a', 'b', 'c']);
  assert.deepEqual(array(result20.stats).map(entry => numberValue(object(entry).mean)), [2.5, 25, 250]);
  assert.deepEqual(array(result20.stats).map(entry => numberValue(object(entry).stddev)).map(value => Number(value.toFixed(6))), [1.290994, 12.909944, 129.099445]);
  assert.deepEqual(array(result20.populations).map(entry => numberValue(object(entry).count)), [2, 2, 2]);

  const result30 = object(await call(client, 'flowSummary', { path: fcs30.path }));
  assert.equal(text(result30.fcsVersion), '3.0');
  assert.equal(numberValue(result30.eventCount), 3);
  assert.equal(text(result30.datatype), 'F');
  assert.equal(text(result30.endian), 'big');
  assert.deepEqual(array(result30.channelNames), ['CH1', 'CH2']);
  assert.deepEqual(array(result30.markers), ['M1', 'M2']);
  assert.deepEqual(array(result30.stats).map(entry => numberValue(object(entry).mean)), [2.5, 0.5]);
  assert.deepEqual(array(result30.stats).map(entry => numberValue(object(entry).median)), [2.5, 0.5]);

  const result31 = object(await call(client, 'flowSummary', { path: fcs31.path }));
  assert.equal(text(result31.fcsVersion), '3.1');
  assert.equal(numberValue(result31.eventCount), 4);
  assert.equal(text(result31.datatype), 'I');
  assert.equal(text(result31.endian), 'little');
  assert.deepEqual(array(result31.channelNames), ['I1', 'I2']);
  assert.deepEqual(array(result31.markers), ['S1', 'S2']);
  assert.deepEqual(array(result31.stats).map(entry => numberValue(object(entry).mean)), [2.5, 25]);
  assert.deepEqual(array(result31.stats).map(entry => numberValue(object(entry).count)), [4, 4]);
});

test('invalid FCS input returns a structured error without killing the worker', { timeout: 120_000 }, async t => {
  if (!PYTHON_OK) {
    t.skip(PYTHON_SKIP);
    return;
  }
  const dir = makeDir(t, 'suwen-invalid-fcs-');
  const notFcs = join(dir, 'not.fcs');
  writeFileSync(notFcs, 'this is not an FCS file');
  const client = makeClient(t);
  await rejectsWithCode(call(client, 'flowSummary', { path: notFcs }), 'NOT_FCS');
  await rejectsWithCode(call(client, 'flowSummary', { path: join(dir, 'missing.fcs') }), 'NOT_FOUND');
  const health = await client.health();
  assert.equal(health.status, 'ok');
  const demo = object(await call(client, 'flowSummary', { path: DEMO_FCS }));
  assert.equal(numberValue(demo.eventCount), 6000);
});

test('datasetProfile profiles the real demo_counts.csv with dtypes, statistics and missingness', { timeout: 120_000 }, async t => {
  if (!PYTHON_OK) {
    t.skip(PYTHON_SKIP);
    return;
  }
  const client = makeClient(t);
  const result = object(await call(client, 'datasetProfile', { path: DEMO_COUNTS_CSV }));
  assert.equal(numberValue(result.rowCount), 10);
  assert.equal(numberValue(result.columnCount), 9);
  assert.equal(numberValue(result.scannedRows), 10);
  assert.equal(text(result.format), 'csv');
  assert.equal(text(result.delimiter), ',');
  assert.equal(booleanValue(result.truncated), false);
  assert.equal(numberValue(object(result.missing).total), 0);
  const columns = array(result.columns).map(column => object(column));
  assert.deepEqual(columns.map(column => text(column.name)), ['gene', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']);
  const gene = columns[0];
  assert.equal(text(gene.dtype), 'string');
  assert.equal(numberValue(gene.distinct), 10);
  assert.ok(array(gene.examples).includes('CD3D'));
  const expected = [
    { mean: 2322.5, min: 85, max: 8900 },
    { mean: 2357, min: 95, max: 9200 },
    { mean: 2326.3, min: 78, max: 8750 },
    { mean: 2357.2, min: 102, max: 9050 },
    { mean: 2504, min: 180, max: 9100 },
    { mean: 2486.5, min: 210, max: 8850 },
    { mean: 2487, min: 165, max: 9000 },
  ];
  for (let index = 0; index < expected.length; index += 1) {
    const column = columns[index + 1];
    assert.equal(text(column.dtype), 'integer');
    assert.equal(numberValue(column.nonNull), 10);
    assertClose(numberValue(column.mean), expected[index].mean);
    assert.equal(numberValue(column.min), expected[index].min);
    assert.equal(numberValue(column.max), expected[index].max);
  }
  const last = columns[8];
  assert.equal(text(last.dtype), 'integer');
  assert.equal(numberValue(last.min), 195);
  assert.equal(numberValue(last.max), 8950);
});

test('datasetProfile handles JSON, CSV, sniffed delimiters, missing tokens and row caps', { timeout: 120_000 }, async t => {
  if (!PYTHON_OK) {
    t.skip(PYTHON_SKIP);
    return;
  }
  const client = makeClient(t);
  const json = object(await call(client, 'datasetProfile', { path: join(FIXTURES, 'profile', 'sample.json') }));
  assert.equal(numberValue(json.rowCount), 3);
  assert.equal(numberValue(json.columnCount), 4);
  const jsonColumns = array(json.columns).map(column => object(column));
  assert.deepEqual(jsonColumns.map(column => text(column.name)), ['gene', 'S1', 'ratio', 'group']);
  assert.equal(text(jsonColumns[0].dtype), 'string');
  assert.equal(text(jsonColumns[1].dtype), 'integer');
  assert.equal(numberValue(jsonColumns[1].nonNull), 2);
  assert.equal(numberValue(jsonColumns[1].min), 3);
  assert.equal(numberValue(jsonColumns[1].max), 5);
  assert.equal(text(jsonColumns[2].dtype), 'number');
  assertClose(numberValue(jsonColumns[2].mean), 1.5);
  assert.equal(numberValue(jsonColumns[2].missing), 0);
  assert.equal(numberValue(jsonColumns[3].missing), 1);
  assert.equal(numberValue(object(json.missing).total), 2);
  assert.equal(numberValue(object(json.missing).cells), 12);

  const csv = object(await call(client, 'datasetProfile', { path: join(FIXTURES, 'profile', 'sample.csv') }));
  const csvColumns = array(csv.columns).map(column => object(column));
  assert.deepEqual(csvColumns.map(column => text(column.name)), ['name', 'score', 'active', 'note']);
  assert.equal(text(csvColumns[0].dtype), 'string');
  assert.equal(text(csvColumns[1].dtype), 'integer');
  assert.equal(text(csvColumns[2].dtype), 'boolean');
  assert.equal(numberValue(csvColumns[1].missing), 1);
  assert.equal(numberValue(csvColumns[3].missing), 1);
  assert.equal(numberValue(object(csv.missing).total), 2);

  const semi = join(makeDir(t, 'suwen-profile-'), 'semi.csv');
  writeFileSync(semi, 'x;y;z\n1;2;3\n4;5;6\n');
  const sniffed = object(await call(client, 'datasetProfile', { path: semi }));
  assert.equal(text(sniffed.delimiter), ';');
  assert.equal(numberValue(sniffed.rowCount), 2);
  assert.equal(numberValue(sniffed.columnCount), 3);

  const capped = object(await call(client, 'datasetProfile', { path: join(FIXTURES, 'profile', 'sample.csv'), maxRows: 2 }));
  assert.equal(numberValue(capped.rowCount), 3);
  assert.equal(numberValue(capped.scannedRows), 2);
  assert.equal(booleanValue(capped.truncated), true);
  assert.ok(array(capped.warnings).length >= 1);
});

test('discoveryScan walks the fixture tree deterministically with hashes, row counts and duplicate detection', { timeout: 120_000 }, async t => {
  if (!PYTHON_OK) {
    t.skip(PYTHON_SKIP);
    return;
  }
  const client = makeClient(t);
  const result = object(await call(client, 'discoveryScan', { root: join(FIXTURES, 'scan') }));
  assert.equal(numberValue(result.fileCount), 5);
  assert.equal(numberValue(result.directoryCount), 2);
  assert.equal(numberValue(result.totalBytes), 211);
  assert.equal(numberValue(result.rowsTotal), 10);
  assert.equal(numberValue(result.rowsKnownFiles), 4);
  assert.equal(text(result.hash), 'sha256');
  assert.equal(booleanValue(result.truncated), false);
  const files = array(result.files).map(file => object(file));
  assert.deepEqual(files.map(file => text(file.path)), [
    'dataA.csv',
    'dataA_copy.csv',
    'nested/dataB.tsv',
    'nested/deeper/dataC.json',
    'notes.txt',
  ]);
  for (const file of files) assert.match(text(file.sha256), /^[0-9a-f]{64}$/);
  assert.equal(numberValue(files[0].rows), 3);
  assert.equal(numberValue(files[2].rows), 2);
  assert.equal(numberValue(files[3].rows), 2);
  const duplicates = array(result.duplicates).map(entry => object(entry));
  assert.equal(duplicates.length, 1);
  assert.equal(text(duplicates[0].sha256), '4c0610aa92b75ca794ceec30068934fc6bc3d2fbff87969a15977f8fcf96f13f');
  assert.deepEqual(array(duplicates[0].paths), ['dataA.csv', 'dataA_copy.csv']);
  const skipped = object(result.skipped);
  assert.deepEqual(array(skipped.symlinks), []);
  assert.deepEqual(array(skipped.depthExceeded), []);
  const byExtension = object(result.byExtension);
  assert.equal(numberValue(byExtension.csv), 2);
  assert.equal(numberValue(byExtension.json), 1);
  assert.equal(numberValue(byExtension.tsv), 1);
  assert.equal(numberValue(byExtension.txt), 1);
});

test('discoveryScan respects maxDepth, maxFiles, hidden-file and extension filters', { timeout: 120_000 }, async t => {
  if (!PYTHON_OK) {
    t.skip(PYTHON_SKIP);
    return;
  }
  const client = makeClient(t);
  const shallow = object(await call(client, 'discoveryScan', { root: join(FIXTURES, 'scan'), maxDepth: 0 }));
  assert.equal(numberValue(shallow.fileCount), 3);
  assert.equal(numberValue(shallow.directoryCount), 1);
  assert.deepEqual(array(object(shallow.skipped).depthExceeded), ['nested']);

  const capped = object(await call(client, 'discoveryScan', { root: join(FIXTURES, 'scan'), maxFiles: 2 }));
  assert.equal(numberValue(capped.fileCount), 2);
  assert.equal(booleanValue(capped.truncated), true);

  const hidden = object(await call(client, 'discoveryScan', { root: join(FIXTURES, 'scan'), includeHidden: true }));
  assert.equal(numberValue(hidden.fileCount), 6);
  assert.ok(array(hidden.files).some(file => text(object(file).path) === '.hidden.csv'));

  const filtered = object(await call(client, 'discoveryScan', { root: join(FIXTURES, 'scan'), extensions: ['.csv'], hash: false }));
  assert.equal(numberValue(filtered.fileCount), 2);
  assert.equal(filtered.hash, null);
  assert.equal(numberValue(filtered.totalBytes), 48);
});

test('discoveryScan refuses to follow symlinks', { timeout: 120_000 }, async t => {
  if (!PYTHON_OK) {
    t.skip(PYTHON_SKIP);
    return;
  }
  const root = makeDir(t, 'suwen-symlink-');
  writeFileSync(join(root, 'data.csv'), 'a,b\n1,2\n');
  try {
    symlinkSync(join(root, 'data.csv'), join(root, 'link.csv'), 'file');
  } catch (error) {
    t.skip(`this host cannot create symlinks: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const client = makeClient(t);
  const result = object(await call(client, 'discoveryScan', { root }));
  assert.deepEqual(array(object(result.skipped).symlinks), ['link.csv']);
  const files = array(result.files).map(file => object(file));
  assert.deepEqual(files.map(file => text(file.path)), ['data.csv']);
});

test('runScript runs real Python with files, args, seed, environment and hashed artifacts', { timeout: 120_000 }, async t => {
  if (!PYTHON_OK) {
    t.skip(PYTHON_SKIP);
    return;
  }
  const sandboxRoot = makeDir(t, 'suwen-sandbox-');
  const client = makeClient(t);
  const source = [
    'import os, pathlib, sys',
    "print('argv', sys.argv[1:])",
    "print('seed', os.environ.get('SUWEN_SEED'))",
    "print('runid', bool(os.environ.get('SUWEN_RUN_ID')))",
    "data = pathlib.Path('input.dat').read_text()",
    "pathlib.Path('output.txt').write_text('got:' + data)",
    "pathlib.Path('sub').mkdir()",
    "pathlib.Path('sub/extra.json').write_text('{\"ok\": true}')",
    "print('done')",
  ].join('\n');
  const result = object(await call(client, 'runScript', {
    language: 'python',
    sandboxRoot,
    source,
    args: ['--flag', 'value'],
    files: [{ name: 'input.dat', text: 'hello-worker' }],
    seed: 12345,
    timeoutMs: 30_000,
  }));
  assert.equal(text(result.language), 'python');
  assert.equal(text(result.script), 'main.py');
  assert.equal(numberValue(result.seed), 12345);
  assert.equal(numberValue(result.timeoutMs), 30_000);
  assert.equal(numberValue(result.exitCode), 0);
  assert.equal(booleanValue(result.timedOut), false);
  const stdout = text(result.stdout);
  assert.ok(stdout.includes('seed 12345'));
  assert.ok(stdout.includes("argv ['--flag', 'value']"));
  assert.ok(stdout.includes('runid True'));
  assert.ok(stdout.includes('done'));
  assert.equal(text(result.stderr), '');
  assert.match(text(object(result.versions).python), /^3\./);
  const sandbox = text(result.sandbox);
  assert.ok(existsSync(sandbox));
  const rel = relative(sandboxRoot, sandbox);
  assert.ok(rel.length > 0 && !rel.startsWith('..'), `sandbox ${sandbox} must live under ${sandboxRoot}`);
  assert.equal(readFileSync(join(sandbox, 'output.txt'), 'utf8'), 'got:hello-worker');
  const files = array(result.files).map(file => object(file));
  const byPath = new Map(files.map(file => [text(file.path), file]));
  const input = byPath.get('input.dat');
  assert.ok(input);
  assert.equal(numberValue(input.bytes), 12);
  assert.equal(text(input.sha256), sha256('hello-worker'));
  assert.equal(booleanValue(input.input), true);
  const output = byPath.get('output.txt');
  assert.ok(output);
  assert.equal(numberValue(output.bytes), 16);
  assert.equal(text(output.sha256), sha256('got:hello-worker'));
  assert.equal(booleanValue(output.input), false);
  assert.ok(byPath.has('sub/extra.json'));
  const inputFiles = array(result.inputFiles).map(file => object(file));
  assert.equal(inputFiles.length, 1);
  assert.equal(text(inputFiles[0].name), 'input.dat');
});

test('runScript runs real Node with the explicit runtime path', { timeout: 120_000 }, async t => {
  if (!PYTHON_OK) {
    t.skip(PYTHON_SKIP);
    return;
  }
  const sandboxRoot = makeDir(t, 'suwen-sandbox-');
  const client = makeClient(t);
  const source = [
    "const fs = require('node:fs');",
    "fs.writeFileSync('node-out.txt', process.version);",
    "console.log('node', process.version);",
    "console.error('node-stderr');",
  ].join('\n');
  const result = object(await call(client, 'runScript', {
    language: 'node',
    sandboxRoot,
    source,
    nodePath: process.execPath,
    timeoutMs: 30_000,
  }));
  assert.equal(numberValue(result.exitCode), 0);
  assert.equal(booleanValue(result.timedOut), false);
  assert.ok(text(result.stdout).includes(`node ${process.version}`));
  assert.ok(text(result.stderr).includes('node-stderr'));
  assert.equal(text(object(result.versions).node), process.version);
  const files = array(result.files).map(file => object(file));
  const artifact = files.find(file => text(file.path) === 'node-out.txt');
  assert.ok(artifact, 'expected node-out.txt artifact');
  assert.equal(text(artifact.sha256), sha256(process.version));
});

test('runScript enforces its timeout and still keeps the worker healthy', { timeout: 120_000 }, async t => {
  if (!PYTHON_OK) {
    t.skip(PYTHON_SKIP);
    return;
  }
  const sandboxRoot = makeDir(t, 'suwen-sandbox-');
  const client = makeClient(t);
  const result = object(await call(client, 'runScript', {
    language: 'python',
    sandboxRoot,
    source: "import time\nprint('start', flush=True)\ntime.sleep(10)\nprint('never', flush=True)\n",
    timeoutMs: 300,
  }));
  assert.equal(booleanValue(result.timedOut), true);
  assert.equal(result.exitCode, null);
  assert.ok(text(result.stdout).includes('start'));
  assert.ok(!text(result.stdout).includes('never'));
  assert.ok(numberValue(result.durationMs) >= 250);
  const warnings = array(result.warnings).map(warning => text(warning));
  assert.ok(warnings.some(warning => warning.toLowerCase().includes('timeout')));
  assert.equal((await client.health()).status, 'ok');
});

test('runScript rejects relative sandbox roots, path-escaping file names and file roots', { timeout: 120_000 }, async t => {
  if (!PYTHON_OK) {
    t.skip(PYTHON_SKIP);
    return;
  }
  const dir = makeDir(t, 'suwen-sandbox-');
  const client = makeClient(t);
  await rejectsWithCode(call(client, 'runScript', { language: 'python', sandboxRoot: 'relative/root', source: 'print(1)' }), 'INVALID_INPUT');
  await rejectsWithCode(call(client, 'runScript', {
    language: 'python',
    sandboxRoot: dir,
    source: 'print(1)',
    files: [{ name: '../escape.txt', text: 'bad' }],
  }), 'INVALID_INPUT');
  const notADirectory = join(dir, 'not-a-dir.txt');
  writeFileSync(notADirectory, 'a regular file cannot be a sandbox root');
  await rejectsWithCode(call(client, 'runScript', {
    language: 'python',
    sandboxRoot: notADirectory,
    source: 'print(1)',
  }), 'INVALID_INPUT');
  assert.equal((await client.health()).status, 'ok');
});

test('runScript confines artifact reporting to the sandbox even when the script writes outside it', { timeout: 120_000 }, async t => {
  if (!PYTHON_OK) {
    t.skip(PYTHON_SKIP);
    return;
  }
  const sandboxRoot = makeDir(t, 'suwen-sandbox-');
  const client = makeClient(t);
  const result = object(await call(client, 'runScript', {
    language: 'python',
    sandboxRoot,
    source: [
      'import pathlib',
      "pathlib.Path('inside.txt').write_text('in')",
      "pathlib.Path('../outside.txt').write_text('out')",
      "print('confine')",
    ].join('\n'),
  }));
  assert.equal(numberValue(result.exitCode), 0);
  const files = array(result.files).map(file => object(file));
  assert.deepEqual(files.map(file => text(file.path)), ['inside.txt']);
  assert.ok(existsSync(join(sandboxRoot, 'outside.txt')), 'the script really escaped the working directory');
  const sandbox = text(result.sandbox);
  assert.equal(readFileSync(join(sandbox, 'inside.txt'), 'utf8'), 'in');
});

test('cancellation aborts an in-flight request, kills the worker and recovers with a restart', { timeout: 120_000 }, async t => {
  if (!PYTHON_OK) {
    t.skip(PYTHON_SKIP);
    return;
  }
  const sandboxRoot = makeDir(t, 'suwen-sandbox-');
  const client = makeClient(t);
  const controller = new AbortController();
  const pending = call(client, 'runScript', {
    language: 'python',
    sandboxRoot,
    source: 'import time\ntime.sleep(10)\n',
    timeoutMs: 30_000,
  }, controller.signal);
  setTimeout(() => controller.abort(), 400);
  await rejectsWithCode(pending, 'WORKER_CANCELLED');
  const health = await client.health();
  assert.equal(health.status, 'ok');
  assert.ok(client.status().restarts >= 1);
  const demo = object(await call(client, 'flowSummary', { path: DEMO_FCS }));
  assert.equal(numberValue(demo.eventCount), 6000);
});

test('a client-side request timeout kills and restarts the worker', { timeout: 120_000 }, async t => {
  if (!PYTHON_OK) {
    t.skip(PYTHON_SKIP);
    return;
  }
  const sandboxRoot = makeDir(t, 'suwen-sandbox-');
  const client = createResearchWorker({ python: PYTHON, requestTimeoutMs: 700 });
  t.after(async () => {
    await client.close();
  });
  await rejectsWithCode(call(client, 'runScript', {
    language: 'python',
    sandboxRoot,
    source: 'import time\ntime.sleep(10)\n',
  }), 'WORKER_TIMEOUT');
  assert.ok(client.status().restarts >= 1);
  assert.equal((await client.health()).status, 'ok');
});

test('an unexpected worker crash is detected, reported and restarted on the next request', { timeout: 120_000 }, async t => {
  if (!PYTHON_OK) {
    t.skip(PYTHON_SKIP);
    return;
  }
  const client = makeClient(t);
  assert.equal((await client.health()).status, 'ok');
  const firstPid = client.status().pid;
  if (firstPid === null) assert.fail('worker pid is null after a healthy request');
  process.kill(firstPid, 'SIGKILL');
  await waitFor(() => client.status().state !== 'ready', 10_000, 'the worker to report a crash');
  assert.equal(client.status().state, 'crashed');
  assert.ok(client.status().restarts >= 1);
  assert.ok((client.status().lastError ?? '').length > 0);
  const health = await client.health();
  assert.equal(health.status, 'ok');
  const secondPid = client.status().pid;
  assert.ok(secondPid !== null && secondPid !== firstPid);
  const demo = object(await call(client, 'flowSummary', { path: DEMO_FCS }));
  assert.equal(numberValue(demo.eventCount), 6000);
});

test('health degrades to unavailable and calls fail cleanly when Python cannot start', { timeout: 60_000 }, async t => {
  const client = createResearchWorker({ python: 'definitely-not-a-real-python-executable' });
  t.after(async () => {
    await client.close();
  });
  const health = await client.health();
  assert.equal(health.status, 'unavailable');
  assert.match(health.error ?? '', /ENOENT|not found|cannot find/i);
  await rejectsWithCode(client.call('health', {}, NEVER), 'WORKER_UNAVAILABLE');
  await client.close();
  assert.equal(client.status().state, 'closed');
});

test('raw JSON-lines protocol answers bad JSON, unknown ops and id/operation aliases without dying', { timeout: 60_000 }, async t => {
  if (!PYTHON_OK) {
    t.skip(PYTHON_SKIP);
    return;
  }
  const requests = [
    '{this is not json',
    JSON.stringify({ id: 901, op: 'health', input: {} }),
    JSON.stringify({ id: 902, op: 'no-such-op', input: {} }),
    JSON.stringify({ id: 903, operation: 'health', input: {} }),
  ];
  const result = spawnSync(PYTHON, ['-u', resolveResearchWorkerScript()], {
    input: `${requests.join('\n')}\n`,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const lines = result.stdout.split(/\r?\n/).filter(line => line.trim().length > 0);
  assert.equal(lines.length, 4);
  const responses = lines.map(line => object(JSON.parse(line) as Json));
  assert.equal(responses[0].id, null);
  assert.equal(booleanValue(responses[0].ok), false);
  assert.equal(text(object(responses[0].error).code), 'BAD_JSON');
  assert.equal(numberValue(responses[1].id), 901);
  assert.equal(booleanValue(responses[1].ok), true);
  assert.equal(text(object(responses[2].error).code), 'UNKNOWN_OP');
  assert.equal(numberValue(responses[2].id), 902);
  assert.equal(numberValue(responses[3].id), 903);
  assert.equal(booleanValue(responses[3].ok), true);
});

test('close is idempotent, rejects later calls and pre-aborted calls never spawn Python', { timeout: 60_000 }, async t => {
  const client = createResearchWorker({ python: PYTHON });
  assert.equal((await client.health()).status, 'ok');
  await client.close();
  assert.equal(client.status().state, 'closed');
  await rejectsWithCode(client.call('health', {}, NEVER), 'WORKER_CLOSED');
  const closedHealth = await client.health();
  assert.equal(closedHealth.status, 'unavailable');
  await client.close();

  const aborted = new AbortController();
  aborted.abort();
  const neverStarted = createResearchWorker({ python: 'definitely-not-a-real-python-executable' });
  await rejectsWithCode(neverStarted.call('health', {}, aborted.signal), 'WORKER_CANCELLED');
  assert.equal(neverStarted.status().pid, null);
  assert.equal(neverStarted.status().restarts, 0);
  await neverStarted.close();
});
