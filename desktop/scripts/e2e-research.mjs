#!/usr/bin/env node
/**
 * SuWen desktop vNext — research / agent-capability end-to-end verification.
 *
 * Drives the REAL daemon (dist/src/daemon.js) over its named-pipe RPC protocol,
 * exactly like scripts/e2e-rpc.mjs does, and exercises the research capability
 * surface end to end:
 *
 *   model gate -> configure deterministic LOCAL fixture model -> project ->
 *   hypothesis/select -> debate -> methods skill lifecycle -> analysis dataset
 *   profile/run/artifact/leakage -> discovery (approval + experiment result
 *   import + evidence + research graph) -> autonomy graph plan/execute/verify/
 *   update -> MCP registry with local stdio fixture -> local SKILL install/test
 *   -> Telegram + webhook channels against a local Bot-API-shaped fixture ->
 *   RSI (expected defect) -> task cancellation -> legacy import inspect/apply/
 *   rollback with secret exclusion.
 *
 * Live public-database checks (Europe PMC / UniProt) are gated behind --live or
 * SUWEN_E2E_LIVE=1. They are never part of the deterministic result set.
 *
 * The model is a deterministic local OpenAI-compatible SSE fixture server on
 * 127.0.0.1. No vendor API is contacted and no API key is real.
 *
 * Usage (from the desktop/ directory):
 *   npm run build
 *   node scripts/e2e-research.mjs            # deterministic only
 *   node scripts/e2e-research.mjs --live     # adds live database checks
 *   node scripts/e2e-research.mjs --keep     # keep temp home/datasets/logs
 *   node scripts/e2e-research.mjs --dist dist --out release/e2e-research
 */
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url))); // .../desktop
const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const opt = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback;
};

const LIVE = flag('--live') || process.env.SUWEN_E2E_LIVE === '1';
const KEEP = flag('--keep');
const DIST_DIR = path.isAbsolute(opt('--dist', 'dist')) ? opt('--dist', 'dist') : path.join(ROOT, opt('--dist', 'dist'));
const DAEMON_PATH = path.join(DIST_DIR, 'src', 'daemon.js');
const WORKER_PATH = path.join(ROOT, 'worker', 'research_worker.py');
const FIXTURES = path.join(ROOT, 'scripts', 'fixtures', 'research-e2e');
const MCP_FIXTURE = path.join(FIXTURES, 'mcp-server.mjs');
const SKILL_FIXTURE = path.join(FIXTURES, 'skill');
const INVALID_SKILL_FIXTURE = path.join(FIXTURES, 'invalid-skill');
const ANALYSIS_SOURCE_PATH = path.join(FIXTURES, 'analysis-score.py');
// Read-only demo cytometry file from the sibling omicslab checkout (never written by this suite).
const DEMO_FCS = path.resolve(ROOT, '..', 'omicslab', 'data', 'demo.fcs');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const REPORT_DIR = path.resolve(ROOT, opt('--out', path.join('release', 'e2e-research')), STAMP);
const DAEMON_LOG = path.join(REPORT_DIR, 'daemon.log');
const MODEL_LOG = path.join(REPORT_DIR, 'model-calls.jsonl');

const STARTED_AT = new Date();
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'suwen-e2e-research-'));
const HOME_DIR = path.join(TMP_ROOT, 'home');
const LEGACY_DIR = path.join(TMP_ROOT, 'legacy-home');
const DATASETS_DIR = path.join(TMP_ROOT, 'datasets');

const cases = [];
const defects = [];
const liveResults = [];
const state = {
  child: null,
  connection: null,
  daemonExitCode: null,
  daemonLogTail: '',
  fixtureServer: null,
  fixturePort: 0,
  fixtureBaseUrl: '',
  modelCalls: 0,
  httpHits: [],
  python: null,
  version: null,
};

// ---------------------------------------------------------------------------
// small assertion / helpers
// ---------------------------------------------------------------------------
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class CaseFailure extends Error {}
class SkipCase extends Error {
  constructor(message, evidence) {
    super(message);
    this.skip = true;
    this.evidence = evidence;
  }
}

function CHECK(condition, message) {
  if (!condition) throw new CaseFailure(message);
}
function eq(actual, expected, label) {
  if (actual !== expected) throw new CaseFailure(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function skip(message, evidence) {
  throw new SkipCase(message, evidence);
}
function short(value, max = 400) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
function unwrap(response, key) {
  return response && response[key] !== undefined ? response[key] : response;
}
function describeTask(task) {
  if (!task) return 'task not found in snapshot';
  const steps = (task.steps || [])
    .map(step => `${step.id}:${step.status}${step.error ? ` err=${short(step.error, 240)}` : ''}`)
    .join(' | ');
  const events = (task.events || []).slice(-8).map(event => short(event, 200)).join(' ');
  return `status=${task.status} steps=[${steps}]${events ? ` lastEvents=${events}` : ''}`;
}
function isoNow() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// daemon transport (mirrors scripts/e2e-rpc.mjs: one-line JSON, no ids)
// ---------------------------------------------------------------------------
function appendDaemonLog(chunk) {
  const text = chunk.toString('utf8');
  try {
    fs.appendFileSync(DAEMON_LOG, text);
  } catch {
    /* ignore log write failures */
  }
  state.daemonLogTail = (state.daemonLogTail + text).slice(-12000);
}

async function startDaemon() {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(DAEMON_LOG, '');
  state.child = spawn(process.execPath, [DAEMON_PATH, '--home', HOME_DIR, '--worker', WORKER_PATH], {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SUWEN_LEGACY_HOME: LEGACY_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  state.child.stdout.on('data', appendDaemonLog);
  state.child.stderr.on('data', appendDaemonLog);
  state.child.on('exit', code => {
    state.daemonExitCode = code;
  });

  const connectionPath = path.join(HOME_DIR, 'connection.json');
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (state.daemonExitCode !== null) {
      throw new Error(`daemon exited with code ${state.daemonExitCode} before connecting. stderr tail: ${state.daemonLogTail.slice(-1500)}`);
    }
    try {
      const raw = fs.readFileSync(connectionPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.pipe === 'string' && typeof parsed.token === 'string') {
        state.connection = parsed;
        return;
      }
    } catch {
      /* not ready yet */
    }
    await sleep(100);
  }
  throw new Error(`daemon did not publish connection.json within 25s. stderr tail: ${state.daemonLogTail.slice(-1500)}`);
}

function rpc(method, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!state.connection) return reject(new Error('RPC called before daemon connection'));
    const socket = connect(state.connection.pipe);
    let buffer = '';
    let settled = false;
    let timer = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    timer = setTimeout(() => finish(new Error(`RPC ${method} timed out after ${timeoutMs}ms`)), timeoutMs);
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ token: state.connection.token, method, params })}\n`);
    });
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 8_000_000) return finish(new Error(`RPC ${method} response exceeded the 8MB cap`));
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return finish(new Error(`RPC ${method} returned invalid JSON: ${line.slice(0, 200)}`));
      }
      if (message && message.error !== undefined) return finish(new Error(String(message.error)));
      finish(null, message ? message.result : undefined);
    });
    socket.on('error', error => finish(new Error(`RPC ${method} socket error: ${error.message}`)));
  });
}

async function expectRpcError(fn, pattern, label) {
  try {
    await fn();
  } catch (error) {
    if (pattern.test(String(error.message))) return String(error.message);
    throw new CaseFailure(`${label}: expected an error matching ${pattern}, got a different error: ${short(error.message, 500)}`);
  }
  throw new CaseFailure(`${label}: expected an error matching ${pattern}, but the RPC call succeeded`);
}

// ---------------------------------------------------------------------------
// task helpers
// ---------------------------------------------------------------------------
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled']);

async function snapshot() {
  return rpc('snapshot');
}

async function findTask(taskId) {
  const snap = await snapshot();
  return (snap.tasks || []).find(task => task.id === taskId) || null;
}

async function waitTask(taskId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await findTask(taskId);
    if (last && TERMINAL_TASK_STATUSES.has(last.status)) return last;
    await sleep(120);
  }
  throw new CaseFailure(`timed out after ${timeoutMs}ms waiting for task ${taskId}: ${describeTask(last)}`);
}

async function waitForApprovalStep(taskId, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await findTask(taskId);
    if (last) {
      if (TERMINAL_TASK_STATUSES.has(last.status)) {
        throw new CaseFailure(`task ${taskId} reached terminal status ${last.status} while waiting for human approval: ${describeTask(last)}`);
      }
      const step = (last.steps || []).find(item => item.status === 'waiting_approval');
      if (step) return { task: last, step };
    }
    await sleep(150);
  }
  throw new CaseFailure(`timed out after ${timeoutMs}ms waiting for an approval step on ${taskId}: ${describeTask(last)}`);
}

async function confirmStep(taskId, stepId, output = { confirmed: true }) {
  return rpc('approval', { taskId, stepId, decision: { action: 'confirm_completed', output } });
}

// ---------------------------------------------------------------------------
// deterministic local fixture model (OpenAI-compatible SSE)
// ---------------------------------------------------------------------------
const MODELS = [];
const BOT_TOKEN = 'e2e-telegram-token';
const BOT_USERNAME = 'suwen_e2e_fixture_bot';

function readBody(request) {
  return new Promise((resolve, reject) => {
    let data = '';
    request.on('data', chunk => {
      data += chunk.toString('utf8');
      if (data.length > 2_000_000) {
        reject(new Error('request body too large'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(data));
    request.on('error', reject);
  });
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Model steps persist { text, context, ... } (desktop/src/activities/model.ts); JSON-mode steps
// keep their structured answer inside output.text, possibly wrapped in a fenced block.
function parseFirstJsonObject(text) {
  if (typeof text !== 'string') return null;
  const direct = parseJsonSafe(text.trim());
  if (direct !== null && typeof direct === 'object') return direct;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const parsed = parseJsonSafe(text.slice(start, end + 1));
    if (parsed !== null && typeof parsed === 'object') return parsed;
  }
  return null;
}

function extractDataPayload(users) {
  for (const content of users) {
    const marker = 'DATA JSON:';
    const index = content.lastIndexOf(marker);
    if (index < 0) continue;
    let rest = content.slice(index + marker.length).trim();
    const direct = parseJsonSafe(rest);
    if (direct !== null) return direct;
    const start = rest.indexOf('{');
    const end = rest.lastIndexOf('}');
    if (start >= 0 && end > start) {
      rest = rest.slice(start, end + 1);
      const parsed = parseJsonSafe(rest);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function detectDebateOp(text) {
  const lower = text.toLowerCase();
  if (lower.includes('chair') || lower.includes('synthesi')) return 'synthesize';
  if (lower.includes('critiquing') || lower.includes('critique the')) return 'critique';
  if (lower.includes('revising') || lower.includes('revise the')) return 'revise';
  return 'propose';
}

function modelReplyFor(messages, context) {
  const system = messages.filter(message => message.role === 'system').map(message => String(message.content || '')).join('\n');
  const users = messages.filter(message => message.role === 'user').map(message => String(message.content || ''));
  const descriptor = `${system}\n${users[0] || ''}`;
  const has = needle => descriptor.toLowerCase().includes(needle.toLowerCase());
  const data = extractDataPayload(users);

  // The daemon's built-in RSI evaluator sends {kind, input:{task, complexity}} as plain JSON
  // (no DATA JSON wrapper) and compares the parsed answer against the persisted eval-case
  // expectation {success:true, evidence:<complexity%2===0>}. Key order must match for deep equality.
  if (has('rsi evaluator')) {
    const body = parseJsonSafe(users[0] || '') ?? {};
    const complexity = Number(body?.input?.complexity ?? 0);
    const evidence = Number.isFinite(complexity) ? complexity % 2 === 0 : true;
    return { kind: 'rsi-eval', value: { answer: { success: true, evidence } } };
  }

  if (has('"skillmarkdown"')) {
    return {
      kind: 'methods-scaffold',
      value: {
        skillMarkdown: '# Fixture Method\n\nDeterministic method scaffold produced by the local E2E fixture model.\n\n## Steps\n\n1. Load the fixture table.\n2. Compute the fixture metric.\n',
        entrySource: 'def main(argv=None):\n    labels = list(argv or [])\n    return {"ok": True, "rows": 2, "labels": labels}\n',
        testSource: 'import json\nimport entry\nresult = entry.main([])\nprint(json.dumps({"ok": bool(result.get("ok")), "result": result}, sort_keys=True))\n',
        license: 'MIT',
        permissions: [],
      },
    };
  }
  if (has('"critiques"')) {
    const targets = Array.isArray(data?.hypotheses) ? data.hypotheses : [];
    return {
      kind: 'hypothesis-critique',
      value: {
        critiques: targets.map((target, index) => ({
          id: String(target.id),
          critique: `Deterministic fixture critique ${index + 1}: the claim relies on a synthetic fixture endpoint and needs independent replication before it can be treated as evidence.`,
          severity: 'medium',
        })),
      },
    };
  }
  if (has('"ranking"')) {
    const targets = Array.isArray(data?.hypotheses) ? data.hypotheses : [];
    return {
      kind: 'hypothesis-rank',
      value: {
        ranking: targets.map((target, index) => ({
          id: String(target.id),
          score: index === 0 ? 0.82 : 0.61,
          reason: `Deterministic fixture ranking ${index + 1}: testability and synthetic evidence are scored by the local fixture rubric.`,
        })),
      },
    };
  }
  // The discovery-feedback prompt embeds the prior analyze payload (which itself contains the
  // string "verdict"), so match the feedback marker before the discovery-analyze branch below.
  if (has('design the next round of hypotheses')) {
    return {
      kind: 'discovery-feedback',
      value: {
        hypotheses: [
          {
            statement: 'A fixture follow-up should test the rescue effect at a lower fixture inhibitor dose.',
            rationale: 'Deterministic fixture feedback one: the reported result was supported but the dose axis was not explored.',
            novelty: 0.4,
            testability: 0.75,
          },
        ],
      },
    };
  }
  if (has('"verdict"')) {
    return {
      kind: 'discovery-analyze',
      value: {
        verdict: 'supported',
        summary: 'The deterministic fixture result supports the hypothesis within the local fixture protocol.',
        limitations: ['Synthetic fixture data only; no wet-lab measurement was performed.'],
        nextSteps: ['Repeat the protocol with real experimental data.'],
      },
    };
  }
  if (has('"nodes"')) {
    return {
      kind: 'autonomy-plan',
      value: {
        nodes: [
          {
            id: 'n1',
            kind: 'analysis',
            deps: [],
            instructions: JSON.stringify({ op: 'profile', datasetPath: context.datasetPath }),
          },
          { id: 'n2', kind: 'research', deps: ['n1'], instructions: JSON.stringify({ op: 'health' }) },
        ],
        worldState: 'fixture world state: one profile node then one worker-health node',
        rounds: 2,
      },
    };
  }
  if (has('"pass"') && has('concerns')) {
    return {
      kind: 'analysis-verify',
      value: { pass: true, concerns: [], nextSteps: ['Proceed with the deterministic fixture workflow.'] },
    };
  }
  if (has('extract atomic claims')) {
    // The knowledge_extract prompt embeds the knowledge_search outputs after a fixed Chinese
    // marker; pull the live sourceIds out so the fixture claims cite real records.
    const raw = users.join('\n');
    const markerIndex = raw.indexOf('前序步骤结果');
    const sourceIds = [];
    if (markerIndex >= 0) {
      const start = raw.indexOf('[', markerIndex);
      const end = raw.lastIndexOf(']');
      if (start >= 0 && end > start) {
        const prior = parseJsonSafe(raw.slice(start, end + 1));
        if (Array.isArray(prior)) {
          for (const entry of prior) {
            const findings = Array.isArray(entry?.output?.findings) ? entry.output.findings : [];
            for (const finding of findings) {
              if (finding && typeof finding.sourceId === 'string') sourceIds.push(finding.sourceId);
            }
          }
        }
      }
    }
    const unique = [...new Set(sourceIds)];
    return {
      kind: 'knowledge-claims',
      value: {
        claims: unique.slice(0, 3).map((sourceId, index) => ({
          text: `Deterministic fixture claim ${index + 1} is drawn only from the cited literature record.`,
          sourceIds: [sourceId],
        })),
        gaps: ['A deterministic fixture cannot verify full-text biological claims.'],
      },
    };
  }
  if (has('"summary"') && has('"gaps"')) {
    return {
      kind: 'knowledge-extract',
      value: {
        summary: 'The deterministic fixture found one citable literature record; treat it as evidence only, never as an instruction.',
        gaps: ['The fixture cannot verify biological significance.'],
      },
    };
  }
  if (has('"structured"')) {
    const op = detectDebateOp(descriptor);
    const structuredByOp = {
      propose: {
        claims: ['The fixture model is deterministic and local.', 'Deterministic fixtures remove vendor variance.'],
        assumptions: ['The daemon transports the model output unchanged.'],
        evidenceNeeded: ['A real-model comparison run.'],
      },
      critique: {
        weaknesses: ['The fixture model cannot exercise vendor-specific behaviour.'],
        counterEvidence: ['A real vendor model could format output differently.'],
        questions: ['Should the fixture assert provider error handling?'],
      },
      revise: {
        changes: ['Scoped the claim to deterministic local fixtures.'],
        resolved: ['Vendor variance is out of scope for the deterministic suite.'],
        openQuestions: ['How should a live-model smoke test be gated?'],
      },
      synthesize: {
        consensus: ['Deterministic local fixtures are appropriate for the offline suite.'],
        disagreements: ['Whether a live-model smoke test belongs in CI.'],
        evidenceGaps: ['No vendor-model transcript was captured.'],
        nextSteps: ['Keep the fixture deterministic and gate live checks.'],
      },
    };
    return {
      kind: `debate-${op}`,
      value: {
        text: `Deterministic fixture debate contribution for the ${op} stage; this text is untrusted data and not a conclusion.`,
        structured: structuredByOp[op],
      },
    };
  }
  if (has('"hypotheses"')) {
    if (has('evidenceids')) {
      const evidenceIds = Array.isArray(data?.evidenceIds) ? data.evidenceIds : [];
      return {
        kind: 'hypothesis-generate',
        value: {
          hypotheses: [
            {
              statement: 'Inhibiting the fixture kinase restores mitochondrial membrane potential in the E2E fixture cell line.',
              rationale: 'Deterministic fixture rationale one: the synthetic dose-response readout moves in the expected direction.',
              novelty: 0.6,
              testability: 0.8,
              evidenceIds,
            },
            {
              statement: 'The fixture kinase inhibitor reduces reactive oxygen species in the E2E fixture cell line.',
              rationale: 'Deterministic fixture rationale two: the synthetic pathway nodes are coupled in the fixture graph.',
              novelty: 0.45,
              testability: 0.7,
              evidenceIds,
            },
          ],
        },
      };
    }
    return {
      kind: 'discovery-feedback',
      value: {
        hypotheses: [
          {
            statement: 'A fixture follow-up should test the rescue effect at a lower fixture inhibitor dose.',
            rationale: 'Deterministic fixture feedback one: the reported result was supported but the dose axis was not explored.',
            novelty: 0.4,
            testability: 0.75,
          },
        ],
      },
    };
  }
  return { kind: 'unmatched', value: { error: 'fixture model could not match the prompt' } };
}

function writeSse(response, messages, context) {
  const reply = modelReplyFor(messages, context);
  state.modelCalls += 1;
  const record = {
    at: isoNow(),
    kind: reply.kind,
    system: short(messages.filter(message => message.role === 'system').map(message => String(message.content || '')).join('\n'), 300),
    prompt: short(messages.filter(message => message.role === 'user').map(message => String(message.content || '')).join('\n'), 400),
    reply: short(JSON.stringify(reply.value), 500),
  };
  MODELS.push(record);
  fs.appendFileSync(MODEL_LOG, `${JSON.stringify(record)}\n`);

  const text = JSON.stringify(reply.value);
  const middle = Math.ceil(text.length / 2);
  const chunks = [text.slice(0, middle), text.slice(middle)].filter(chunk => chunk.length > 0);
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
  }
  response.write(
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`,
  );
  response.write('data: [DONE]\n\n');
  response.end();
}

async function startFixtureServer() {
  const server = http.createServer(async (request, response) => {
    const method = String(request.method || 'GET').toUpperCase();
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    let body = null;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      const raw = await readBody(request);
      body = parseJsonSafe(raw);
    }
    state.httpHits.push({ at: isoNow(), method, path: url.pathname, body });

    if (method === 'POST' && url.pathname === '/v1/chat/completions') {
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      return writeSse(response, messages, { datasetPath: path.join(DATASETS_DIR, 'data.csv') });
    }
    if (method === 'GET' && url.pathname === `/bot${BOT_TOKEN}/getMe`) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { id: 1, username: BOT_USERNAME, first_name: 'SuWen E2E Fixture' } }));
      return;
    }
    if (method === 'POST' && url.pathname === `/bot${BOT_TOKEN}/sendMessage`) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { message_id: 42, date: Math.floor(Date.now() / 1000), text: body?.text ?? '' } }));
      return;
    }
    if (method === 'GET' && url.pathname === '/webhook') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (method === 'POST' && url.pathname === '/webhook') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, id: 'wh-msg-1' }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'fixture route not found' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  state.fixtureServer = server;
  state.fixturePort = server.address().port;
  state.fixtureBaseUrl = `http://127.0.0.1:${state.fixturePort}`;
}

// ---------------------------------------------------------------------------
// fixture files
// ---------------------------------------------------------------------------
const SENTINEL_SECRET = 'sk-legacy-e2e-sentinel-0123456789';

function writeFile(relativePath, content) {
  const target = path.join(TMP_ROOT, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function prepareFixtures() {
  fs.mkdirSync(DATASETS_DIR, { recursive: true });
  const header = 'sampleId,featureA,featureB,label\n';
  fs.writeFileSync(path.join(DATASETS_DIR, 'data.csv'), header + '1,0.1,1.0,yes\n2,0.2,0.9,yes\n3,0.8,0.2,no\n4,0.9,0.1,no\n5,0.3,0.8,yes\n6,0.7,0.3,no\n');
  fs.writeFileSync(path.join(DATASETS_DIR, 'train.csv'), header + '1,0.1,1.0,yes\n2,0.2,0.9,yes\n3,0.8,0.2,no\n4,0.9,0.1,no\n');
  fs.writeFileSync(path.join(DATASETS_DIR, 'test.csv'), header + '5,0.3,0.8,yes\n6,0.7,0.3,no\n');
  fs.writeFileSync(path.join(DATASETS_DIR, 'leak-a.csv'), header + '7,0.5,0.5,yes\n8,0.4,0.6,no\n');
  fs.writeFileSync(path.join(DATASETS_DIR, 'leak-b.csv'), header + '7,0.5,0.5,yes\n8,0.4,0.6,no\n');

  fs.mkdirSync(path.join(LEGACY_DIR, 'conversations'), { recursive: true });
  fs.mkdirSync(path.join(LEGACY_DIR, 'memory'), { recursive: true });
  const session = {
    id: 'conv-legacy-e2e-1',
    title: 'Legacy E2E conversation',
    agent: 'legacy-agent',
    created_at: 1700000000,
    updated_at: 1700000200,
    messages: [
      { role: 'user', content: 'legacy question from the E2E fixture', ts: 1700000001 },
      { role: 'assistant', content: 'legacy answer from the E2E fixture', ts: 1700000002 },
    ],
  };
  fs.writeFileSync(path.join(LEGACY_DIR, 'conversations', 'session-1.json'), JSON.stringify(session, null, 2));
  fs.writeFileSync(
    path.join(LEGACY_DIR, 'settings.json'),
    JSON.stringify({ theme: 'dark', language: 'zh-CN', api_key: SENTINEL_SECRET, nested: { retries: 2 } }, null, 2),
  );
  fs.writeFileSync(path.join(LEGACY_DIR, 'memory', 'notes.md'), '# Legacy E2E memory\n\nDeterministic fixture memory note.\n');
  fs.writeFileSync(path.join(LEGACY_DIR, 'auth.json'), JSON.stringify({ token: SENTINEL_SECRET }));
}

// ---------------------------------------------------------------------------
// case runner
// ---------------------------------------------------------------------------
async function runCase(id, title, fn, options = {}) {
  const startedAt = Date.now();
  const record = { id, title, status: 'fail', detail: '', evidence: null, ms: 0, gated: Boolean(options.gated), at: isoNow() };
  const log = message => {
    record.detail = message || '';
    process.stdout.write(`  ${id}: ${message || ''}\n`);
  };
  try {
    const result = await fn(log);
    record.status = 'pass';
    record.detail = short(result?.detail ?? 'passed', 600);
    record.evidence = result?.evidence ?? null;
  } catch (error) {
    if (error && error.skip) {
      record.status = 'skip';
      record.detail = short(error.message, 800);
      record.evidence = error.evidence ?? null;
    } else {
      record.status = 'fail';
      record.detail = short(error && error.message ? error.message : String(error), 1200);
      record.evidence = error && error.evidence ? error.evidence : null;
      record.daemonTail = state.daemonLogTail.slice(-2000);
    }
  }
  record.ms = Date.now() - startedAt;
  cases.push(record);
  const label = record.status.toUpperCase().padEnd(5);
  process.stdout.write(`[${label}] ${id} — ${title} (${(record.ms / 1000).toFixed(1)}s)\n`);
  if (record.status === 'fail') {
    process.stdout.write(`        ${record.detail.split('\n').slice(0, 6).join('\n        ')}\n`);
  }
  return record;
}

// ---------------------------------------------------------------------------
// the actual verification cases
// ---------------------------------------------------------------------------
async function main() {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  prepareFixtures();
  await startFixtureServer();
  process.stdout.write(`SuWen research E2E — daemon ${short(DAEMON_PATH, 120)}\n`);
  process.stdout.write(`fixture model + Bot API fixture: ${state.fixtureBaseUrl}\n`);
  process.stdout.write(`report dir: ${REPORT_DIR}\n\n`);
  await startDaemon();

  let projectId = null;
  let hypothesisId = null;
  let methodName = null;
  let analysisTaskId = null;
  let mcpServerId = null;
  let telegramChannelId = null;
  let webhookChannelId = null;
  let importJobId = null;
  let legacyConversationId = null;
  let installedSkillId = null;

  // -- 1. boot ---------------------------------------------------------------
  await runCase('boot', 'daemon health, doctor, research worker handshake', async log => {
    const health = await rpc('health');
    CHECK(health.ready === true, 'health.ready must be true');
    eq(health.mode, 'user-background', 'health.mode');
    eq(health.version, pkg.version, 'health.version');
    CHECK(health.runtimeVersions && typeof health.runtimeVersions.node === 'string', 'health.runtimeVersions.node missing');
    CHECK(typeof health.python === 'string' && health.python.length > 0, 'health.python missing');
    state.version = health.version;
    state.python = health.python;

    const doctor = await rpc('doctor.run');
    CHECK(Array.isArray(doctor.checks) && doctor.checks.length >= 6, `doctor returned ${doctor.checks?.length} checks`);
    const byId = Object.fromEntries(doctor.checks.map(check => [check.id, check]));
    for (const required of ['daemon', 'store', 'python', 'researchWorker', 'artifacts', 'home', 'model']) {
      CHECK(byId[required], `doctor missing check '${required}'`);
    }
    eq(byId.daemon.status, 'pass', 'doctor daemon check');
    eq(byId.store.status, 'pass', 'doctor store check');
    CHECK(['warn', 'pass'].includes(byId.model.status), `doctor model check before configure: ${byId.model?.status}`);

    const workerHealth = unwrap(await rpc('worker.health'), 'health');
    CHECK(workerHealth && typeof workerHealth === 'object', 'worker.health did not return an object');
    eq(workerHealth.status, 'ok', `research worker status (${short(workerHealth, 300)})`);
    const describe = await rpc('worker.describe');
    const capabilities = describe.capabilities || describe.ops || [];
    CHECK(
      Array.isArray(capabilities) && capabilities.map(String).includes('runScript'),
      `worker.describe must expose runScript: ${short(describe, 300)}`,
    );
    log(`daemon v${health.version} pid=${health.pid} python=${health.python}; worker=${workerHealth.status}; doctor=${doctor.checks.length} checks`);
    return {
      detail: `daemon v${health.version} pid=${health.pid}, worker ${workerHealth.status}, python ${health.python}`,
      evidence: {
        health: { ready: health.ready, mode: health.mode, version: health.version, python: health.python, runtimeVersions: health.runtimeVersions },
        doctor: doctor.checks,
        worker: workerHealth,
        describe,
      },
    };
  });

  // -- 2. model gate before configure ---------------------------------------
  await runCase('gate-model', 'research capabilities fail closed before a model is configured', async () => {
    const knowledgeError = await expectRpcError(
      () => rpc('research.knowledge', { question: 'What is the role of deterministic fixture models in end-to-end verification?', databases: ['pubmed'] }),
      /model|模型|配置/i,
      'research.knowledge without a model',
    );
    const hypothesisError = await expectRpcError(
      () => rpc('research.hypothesis', { question: 'Does a deterministic fixture model improve end-to-end test stability?' }),
      /model|模型|配置/i,
      'research.hypothesis without a model',
    );
    return { detail: `localized model-required error: ${knowledgeError}`, evidence: { knowledgeError, hypothesisError } };
  });

  // -- 3. configure the deterministic local fixture model --------------------
  await runCase('configure-model', 'configure deterministic local OpenAI-compatible fixture model', async () => {
    const configured = await rpc('configure', {
      provider: 'openai',
      baseUrl: `${state.fixtureBaseUrl}/v1`,
      model: 'suwen-e2e-fixture',
      apiKey: 'fixture-key-not-a-real-credential',
      contextWindow: 32768,
      maxOutput: 4096,
    });
    eq(configured.ok, true, 'configure.ok');
    eq(configured.provider, 'openai', 'configure.provider');
    eq(configured.model, 'suwen-e2e-fixture', 'configure.model');
    const health = await rpc('health');
    eq(health.configured, true, 'health.configured after configure');
    const defaults = await rpc('defaults.get');
    CHECK(defaults.model && defaults.model.provider === 'openai', `defaults.get model config: ${short(defaults.model, 200)}`);
    const doctor = await rpc('doctor.run');
    const modelCheck = doctor.checks.find(check => check.id === 'model');
    eq(modelCheck.status, 'pass', 'doctor model check after configure');
    return {
      detail: `deterministic local fixture model openai/suwen-e2e-fixture at ${state.fixtureBaseUrl}/v1 (doctor model=pass)`,
      evidence: { configured, model: defaults.model, doctorModel: modelCheck },
    };
  });

  // -- 4. project + empty research graph baseline ---------------------------
  await runCase('project', 'create project and read an empty research graph baseline', async () => {
    const created = await rpc('project.create', { name: `E2E research ${STAMP}` });
    projectId = created.project?.id ?? created.id;
    CHECK(typeof projectId === 'string' && projectId.length > 0, `project.create returned no id: ${short(created, 300)}`);
    const projects = await rpc('project.list');
    CHECK(Array.isArray(projects) && projects.some(project => project.id === projectId), 'project.list does not contain the new project');
    const graph = await rpc('research.graph', { projectId });
    CHECK(graph.graph === null, `a fresh project must have no research graph: ${short(graph, 300)}`);
    return { detail: `project ${projectId}; research.graph={graph:null}`, evidence: { projectId, graph } };
  });

  // -- 5. knowledge (live-gated) -------------------------------------------
  if (!LIVE) {
    cases.push({
      id: 'knowledge-live',
      title: 'knowledge research flow with a real PubMed query (Europe PMC)',
      status: 'skip',
      detail: 'live-gated: needs a real public-database query. Re-run with --live (or SUWEN_E2E_LIVE=1) to exercise research.knowledge end to end.',
      evidence: { gate: '--live / SUWEN_E2E_LIVE=1', method: 'research.knowledge', params: { databases: ['pubmed'], limit: 3 } },
      ms: 0,
      gated: true,
      at: isoNow(),
    });
    process.stdout.write('[SKIP ] knowledge-live — live-gated; deterministic run does not touch public databases\n');
  }

  // -- 6. hypothesis generation + critique + ranking + human selection -----
  await runCase('hypothesis', 'hypothesis generate/critique/rank records and human selection', async log => {
    const question = 'Does inhibiting the fixture kinase restore mitochondrial membrane potential in the E2E fixture cell line?';
    const submitted = await rpc('research.hypothesis', { projectId, question });
    CHECK(typeof submitted.taskId === 'string', 'research.hypothesis returned no taskId');
    const task = await waitTask(submitted.taskId, 150000);
    CHECK(task.status === 'completed', `hypothesis task did not complete: ${describeTask(task)}`);

    const rows = (await rpc('hypothesis.list', { projectId })).filter(row => row.taskId === submitted.taskId);
    CHECK(rows.length >= 1, 'hypothesis.list returned no records for this task');
    for (const row of rows) {
      CHECK(typeof row.statement === 'string' && row.statement.length >= 10, `bad statement: ${short(row, 200)}`);
      CHECK(typeof row.rationale === 'string' && row.rationale.length >= 10, `bad rationale: ${short(row, 200)}`);
      CHECK(typeof row.dedupeKey === 'string' && row.dedupeKey.length === 64, `bad dedupeKey: ${short(row.dedupeKey, 100)}`);
      CHECK(typeof row.score === 'number' && row.score >= 0 && row.score <= 1, `bad score: ${short(row.score, 100)}`);
      CHECK(typeof row.critique === 'string' && row.critique.length >= 10, `bad critique: ${short(row.critique, 100)}`);
      CHECK(row.status === 'ranked', `expected ranked status after rank step, got ${row.status}`);
    }
    const ranked = rows.filter(row => row.status === 'ranked').sort((a, b) => b.score - a.score);
    CHECK(ranked.length >= 1, 'no ranked hypothesis to select');
    hypothesisId = ranked[0].id;
    const selected = await rpc('hypothesis.select', { id: hypothesisId });
    eq(selected.selected, true, 'hypothesis.select.selected');
    const after = await rpc('hypothesis.list', { projectId });
    const selectedRows = after.filter(row => row.selected === true);
    eq(selectedRows.length, 1, 'exactly one hypothesis may be selected per project');
    eq(selectedRows[0].id, hypothesisId, 'selected hypothesis id');
    // D3 pre-fix evidence: hypothesis.select only persisted selected:true and left status 'ranked',
    // which made the discovery design step fail with "transition 'ranked' -> 'testing' is not allowed".
    const selectedRecord = await rpc('hypothesis.get', { id: hypothesisId });
    eq(selectedRecord.status, 'selected', 'hypothesis.select must persist status "selected" so a discovery experiment can start');
    log(`${rows.length} hypotheses; selected ${hypothesisId} score=${ranked[0].score}; status=${selectedRecord.status}`);
    return {
      detail: `${rows.length} ranked hypotheses, selected ${hypothesisId}`,
      evidence: {
        taskId: submitted.taskId,
        hypotheses: rows.map(row => ({ id: row.id, statement: row.statement, score: row.score, status: row.status, novelty: row.novelty, testability: row.testability })),
        selected,
      },
    };
  });

  // -- 7. debate ------------------------------------------------------------
  await runCase('debate', 'two-round debate with per-role evidence and referee synthesis (no unconditional verdict)', async log => {
    const submitted = await rpc('research.debate', {
      projectId,
      question: 'Should the E2E suite use a deterministic local fixture model or a real vendor model?',
      rounds: 2,
    });
    const task = await waitTask(submitted.taskId, 180000);
    CHECK(task.status === 'completed', `debate task did not complete: ${describeTask(task)}`);
    const evidenceRows = await rpc('evidence.list', { taskId: submitted.taskId });
    const notes = evidenceRows.filter(row => row.kind === 'note' && row.source === 'debate');
    CHECK(notes.length >= 7, `expected 7 debate records (2 rounds × propose/critique/revise + synthesize), got ${notes.length}`);
    const opOf = row => row.payload?.op;
    const roundOf = row => row.payload?.round;
    for (const op of ['propose', 'critique', 'revise']) {
      for (const round of [1, 2]) {
        const match = notes.filter(row => opOf(row) === op && roundOf(row) === round);
        eq(match.length, 1, `debate record ${op} round ${round}`);
      }
    }
    const synthesize = notes.filter(row => opOf(row) === 'synthesize');
    eq(synthesize.length, 1, 'referee synthesis record count');
    const structured = synthesize[0].payload?.structured;
    CHECK(structured && typeof structured === 'object', 'synthesize record has no structured payload');
    for (const key of ['consensus', 'disagreements', 'evidenceGaps', 'nextSteps']) {
      CHECK(Array.isArray(structured[key]) && structured[key].length >= 1, `synthesize structured.${key} missing`);
    }
    for (const record of notes) {
      CHECK(!('verdict' in (record.payload || {})), 'debate records must not persist an unconditional verdict');
      CHECK(typeof record.title === 'string' && record.title.startsWith('Debate round '), `bad debate title: ${short(record.title, 100)}`);
      CHECK(typeof record.citation === 'string' && record.citation.startsWith('debate:'), `bad debate citation: ${short(record.citation, 100)}`);
      CHECK(typeof record.payloadSha256 === 'string' && /^[0-9a-f]{64}$/.test(record.payloadSha256), 'bad payloadSha256 on debate record');
    }
    log(`${notes.length} debate note records; synthesis has consensus/disagreements/evidenceGaps/nextSteps`);
    return {
      detail: `${notes.length} debate records; synthesis consensus=${structured.consensus.length}, disagreements=${structured.disagreements.length}`,
      evidence: {
        taskId: submitted.taskId,
        records: notes.map(row => ({ op: opOf(row), round: roundOf(row), role: row.payload?.role, citation: row.citation, title: row.title })),
        synthesis: structured,
      },
    };
  });

  // -- 8. methods skill lifecycle -------------------------------------------
  await runCase('methods', 'methods scaffold with license/test metadata, skill test + disable/enable/remove', async log => {
    methodName = `e2eMethod${Date.now().toString(36)}`;
    const submitted = await rpc('research.methods', { projectId, name: methodName });
    const task = await waitTask(submitted.taskId, 180000);
    CHECK(task.status === 'completed', `methods task did not complete: ${describeTask(task)}`);
    const skills = (await rpc('skill.list')).skills;
    const skill = skills.find(item => item.name === methodName);
    CHECK(skill, `no skill record named ${methodName}`);
    eq(skill.license, 'MIT', 'methods skill license');
    CHECK(typeof skill.source === 'string' && /method|synth/i.test(skill.source), `methods skill source: ${short(skill.source, 100)}`);
    eq(skill.entry, 'entry.py', 'methods skill entry');
    CHECK(typeof skill.sha256 === 'string' && /^[0-9a-f]{64}$/.test(skill.sha256), 'methods skill sha256');
    eq(skill.enabled, false, 'methods skill starts disabled');
    eq(skill.test.status, 'passed', `methods scaffold self-test status (detail: ${short(skill.test.detail, 300)})`);

    const tested = await rpc('skill.test', { id: skill.id });
    eq(tested.status, 'passed', `skill.test status (detail: ${short(tested.detail, 400)})`);
    CHECK(/exit=0/.test(tested.detail || ''), `skill.test detail should contain exit=0: ${short(tested.detail, 200)}`);
    const disabled = unwrap(await rpc('skill.disable', { id: skill.id }), 'skill');
    eq(disabled.enabled, false, 'skill.disable');
    const enabled = unwrap(await rpc('skill.enable', { id: skill.id }), 'skill');
    eq(enabled.enabled, true, 'skill.enable');
    const removed = await rpc('skill.remove', { id: skill.id });
    eq(removed.ok, true, 'skill.remove');
    CHECK(!(await rpc('skill.list')).skills.some(item => item.id === skill.id), 'removed skill still listed');
    log(`${methodName} -> ${skill.id}: test passed, enable/disable/remove ok`);
    return {
      detail: `${methodName} (${skill.id}) license=${skill.license} test=${tested.status}; enable/disable/remove verified`,
      evidence: {
        taskId: submitted.taskId,
        skill: { id: skill.id, name: skill.name, source: skill.source, license: skill.license, entry: skill.entry, sha256: skill.sha256, test: skill.test },
        tested: { status: tested.status, detail: tested.detail },
      },
    };
  });

  // -- 8b. research worker passthrough (datasetProfile / flowSummary) ------
  await runCase('research-worker', 'research worker passthrough: datasetProfile on CSV + flowSummary on the demo FCS', async log => {
    if (!fs.existsSync(DEMO_FCS)) {
      skip(`demo cytometry fixture is missing: ${DEMO_FCS}`, { demoFcs: DEMO_FCS });
    }
    const created = await rpc('create', {
      name: 'e2e-research-worker-passthrough',
      steps: [
        { id: 'profile', kind: 'research', input: { op: 'datasetProfile', input: { path: path.join(DATASETS_DIR, 'data.csv') } } },
        { id: 'fcs', kind: 'research', input: { op: 'flowSummary', input: { path: DEMO_FCS } }, dependsOn: ['profile'] },
      ],
    });
    const taskId = created.id ?? created.taskId;
    const task = await waitTask(taskId, 120000);
    CHECK(task.status === 'completed', `research worker passthrough task: ${describeTask(task)}`);
    const profileStep = (task.steps || []).find(step => step.id === 'profile');
    const profile = profileStep?.output?.result ?? profileStep?.output;
    CHECK(profile && typeof profile === 'object' && JSON.stringify(profile).length > 20, `datasetProfile output: ${short(profile, 400)}`);
    const fcsStep = (task.steps || []).find(step => step.id === 'fcs');
    const fcs = fcsStep?.output?.result ?? fcsStep?.output;
    CHECK(fcs && typeof fcs === 'object' && JSON.stringify(fcs).length > 20, `flowSummary output: ${short(fcs, 400)}`);
    log(`datasetProfile keys=${Object.keys(profile).slice(0, 8).join(',')}; flowSummary keys=${Object.keys(fcs).slice(0, 8).join(',')}`);
    return {
      detail: `worker op=datasetProfile(path) and op=flowSummary(${path.basename(DEMO_FCS)}) completed`,
      evidence: { taskId, profile, flowSummary: fcs, demoFcs: DEMO_FCS },
    };
  });

  // -- 8c. sandboxed runScript through the research activity ----------------
  await runCase('runScript-sandbox', 'sandboxed runScript through the research activity (worker sandboxRoot wiring)', async log => {
    const created = await rpc('create', {
      name: 'e2e-research-runscript',
      steps: [
        {
          id: 'script',
          kind: 'research',
          input: {
            op: 'runScript',
            input: {
              language: 'python',
              source: 'import json\n\nwith open("input.txt", "r", encoding="utf-8") as handle:\n    text = handle.read().strip()\nprint(json.dumps({"ok": True, "input": text}))\n',
              files: [{ name: 'input.txt', text: 'fixture-file-body' }],
              timeoutMs: 60000,
            },
          },
        },
      ],
    });
    const taskId = created.id ?? created.taskId;
    const task = await waitTask(taskId, 120000);
    CHECK(task.status === 'completed', `sandboxed runScript task: ${describeTask(task)}`);
    const step = (task.steps || []).find(item => item.id === 'script');
    const raw = step?.output?.result ?? step?.output;
    const result = raw?.result ?? raw;
    CHECK(result && typeof result === 'object', `runScript output: ${short(raw, 400)}`);
    eq(result.exitCode, 0, `runScript exit code (stdout=${short(result.stdout, 200)} stderr=${short(result.stderr, 200)})`);
    CHECK(/fixture-file-body/.test(String(result.stdout || '')), `runScript stdout should quote the input file: ${short(result.stdout, 200)}`);
    CHECK(typeof result.sandbox === 'string' && result.sandbox.length > 0, 'runScript did not report the worker sandbox path');
    log(`runScript exit=0 stdout=${short(result.stdout, 80)}`);
    return {
      detail: `sandboxed python runScript exit=0, input file visible in ${path.basename(result.sandbox)}`,
      evidence: { taskId, exitCode: result.exitCode, stdout: result.stdout, sandbox: result.sandbox },
    };
  });

  // -- 9. analysis: profile + sandboxed metric run + artifact + leakage -----
  await runCase('analysis', 'analysis profile/run/artifact plus train-test leakage rejection', async log => {
    const analysisSource = fs.readFileSync(ANALYSIS_SOURCE_PATH, 'utf8');
    const datasetPath = path.join(DATASETS_DIR, 'data.csv');
    const trainPath = path.join(DATASETS_DIR, 'train.csv');
    const testPath = path.join(DATASETS_DIR, 'test.csv');

    const samePathError = await expectRpcError(
      () => rpc('research.analysis', { projectId, datasetPath, source: 'print(1)', trainPath, testPath: trainPath, metric: 'score' }),
      /same file|leakage/i,
      'analysis with identical train/test path',
    );
    const halfSpecError = await expectRpcError(
      () => rpc('research.analysis', { projectId, datasetPath, source: 'print(1)', trainPath, metric: 'score' }),
      /both trainPath and testPath/i,
      'analysis with only trainPath',
    );

    // The worker profile op needs a real dataset path; an inline source-only analysis profile must
    // be rejected with an explicit ValidationError (source is only used by the run step).
    const sourceOnlyProfile = await rpc('create', {
      name: 'e2e-analysis-profile-source-only',
      steps: [{ id: 'profile', kind: 'analysis', input: { op: 'profile', source: 'a,b\n1,2\n3,4\n' } }],
    });
    const sourceOnlyTaskId = sourceOnlyProfile.id ?? sourceOnlyProfile.taskId;
    const sourceOnlyTask = await waitTask(sourceOnlyTaskId, 60000);
    eq(sourceOnlyTask.status, 'failed', `source-only analysis profile must end failed: ${describeTask(sourceOnlyTask)}`);
    const sourceOnlyStep = (sourceOnlyTask.steps || []).find(step => step.id === 'profile');
    CHECK(
      /requires datasetPath/i.test(String(sourceOnlyStep?.error || '')),
      `source-only profile rejection should mention datasetPath: ${short(sourceOnlyStep?.error, 400)}`,
    );

    const leakSubmit = await rpc('research.analysis', {
      projectId,
      datasetPath: path.join(DATASETS_DIR, 'leak-a.csv'),
      source: analysisSource,
      metric: 'score',
      trainPath: path.join(DATASETS_DIR, 'leak-a.csv'),
      testPath: path.join(DATASETS_DIR, 'leak-b.csv'),
    });
    const leakTask = await waitTask(leakSubmit.taskId, 120000);
    eq(leakTask.status, 'failed', `identical train/test content must fail the run: ${describeTask(leakTask)}`);
    const leakStep = (leakTask.steps || []).find(step => step.id === 'analysis_run');
    CHECK(leakStep && /identical content|leakage/i.test(String(leakStep.error || '')), `leakage rejection error: ${short(leakStep?.error, 400)}`);

    const submitted = await rpc('research.analysis', {
      projectId,
      datasetPath,
      source: analysisSource,
      metric: 'score',
      seed: 7,
      trainPath,
      testPath,
    });
    analysisTaskId = submitted.taskId;
    const task = await waitTask(submitted.taskId, 180000);
    CHECK(task.status === 'completed', `analysis task did not complete: ${describeTask(task)}`);

    const profileStep = (task.steps || []).find(step => step.id === 'analysis_profile');
    CHECK(profileStep && profileStep.output && typeof profileStep.output.profile === 'object', 'analysis_profile output missing a profile object');
    const runStep = (task.steps || []).find(step => step.id === 'analysis_run');
    CHECK(runStep && runStep.output, 'analysis_run output missing');
    const runOutput = runStep.output;
    eq(runOutput.metric, 'score', 'analysis run metric');
    eq(runOutput.score, 0.5, 'analysis run score (worker metric JSON)');
    eq(runOutput.leakageCheck?.status, 'checked', 'analysis leakage check status');
    eq(runOutput.leakageCheck?.overlap, false, 'analysis leakage overlap flag');
    CHECK(typeof runOutput.artifact?.sha256 === 'string' && /^[0-9a-f]{64}$/.test(runOutput.artifact.sha256), 'analysis artifact sha256');
    const artifact = await rpc('artifact.read', { taskId: submitted.taskId, artifactId: runOutput.artifact.id });
    CHECK(artifact.bytes > 0, 'artifact.read returned zero bytes');
    eq(artifact.encoding, 'utf8', 'analysis artifact encoding');
    const readBack = parseJsonSafe(artifact.text);
    CHECK(readBack && readBack.op === 'run' && readBack.score === 0.5, `artifact.read text is not the analysis run payload: ${short(artifact.text, 200)}`);
    const verifyStep = (task.steps || []).find(step => step.id === 'analysis_verify');
    const verifyJson = parseFirstJsonObject(verifyStep?.output?.text);
    eq(verifyJson?.pass, true, `analysis_verify model pass flag (output: ${short(verifyStep?.output?.text, 300)})`);
    log(`score=${runOutput.score} artifact=${runOutput.artifact.id} sha256=${runOutput.artifact.sha256.slice(0, 12)}…; leakage rejected`);
    return {
      detail: `profile+run score=${runOutput.score}, artifact ${runOutput.artifact.sha256.slice(0, 12)}…, leakage rejected (${samePathError.slice(0, 60)}…)`,
      evidence: {
        taskId: submitted.taskId,
        handlerRejections: { samePathError, halfSpecError },
        leakTask: { taskId: leakSubmit.taskId, status: leakTask.status, error: leakStep?.error },
        run: { metric: runOutput.metric, score: runOutput.score, leakageCheck: runOutput.leakageCheck, artifact: runOutput.artifact },
        artifactTextPrefix: short(artifact.text, 400),
        profileKeys: profileStep.output.profile ? Object.keys(profileStep.output.profile).slice(0, 12) : [],
      },
    };
  });

  // -- 10. discovery: approval gate, experiment result import, feedback -----
  await runCase('discovery', 'discovery approval gate, experiment result import, evidence and research graph', async log => {
    const submitted = await rpc('research.discovery', {
      projectId,
      hypothesisId,
      design: { simulated: false, protocol: 'fixture-protocol-v1', endpoint: 'local-fixture' },
    });
    let waiting = await waitForApprovalStep(submitted.taskId, 90000);
    eq(waiting.step.id, 'discovery_approval', `first approval step (${describeTask(waiting.task)})`);

    const experiments = (await rpc('experiment.list', { projectId })).filter(row => row.hypothesisId === hypothesisId);
    CHECK(experiments.length >= 1, 'discovery design did not create an experiment record');
    const experiment = experiments[experiments.length - 1];
    eq(experiment.status, 'proposed', 'experiment starts proposed');
    eq(experiment.simulated, false, 'experiment simulated flag');
    const beforeApprovalError = await expectRpcError(
      () => rpc('experiment.result', { id: experiment.id, result: { value: 1.25, units: 'fixture-units' } }),
      /approved|approve/i,
      'experiment.result before approval',
    );
    const approved = await rpc('experiment.approve', { id: experiment.id, decision: 'approve', note: 'E2E deterministic approval' });
    eq(approved.status, 'approved', 'experiment.approve status');
    const result = await rpc('experiment.result', { id: experiment.id, result: { value: 1.25, units: 'fixture-units' }, simulated: false });
    eq(result.status, 'completed', 'experiment.result status');
    // The mutation response only carries {id,version,status,simulated}; the persisted resultKind is read back.
    const fetched = await rpc('experiment.get', { id: experiment.id });
    eq(fetched.resultKind, 'real', 'experiment.result persisted resultKind');
    eq(fetched.result?.value, 1.25, 'experiment.result persisted result value');

    await confirmStep(submitted.taskId, waiting.step.id, { approved: true, experimentId: experiment.id });
    waiting = await waitForApprovalStep(submitted.taskId, 90000);
    eq(waiting.step.id, 'discovery_import', `second approval step (${describeTask(waiting.task)})`);
    await confirmStep(submitted.taskId, waiting.step.id, { imported: true, experimentId: experiment.id });

    const task = await waitTask(submitted.taskId, 180000);
    CHECK(task.status === 'completed', `discovery task did not complete: ${describeTask(task)}`);

    const completedExperiment = (await rpc('experiment.list', { projectId })).find(row => row.id === experiment.id);
    eq(completedExperiment.status, 'completed', 'experiment completed after result import');

    const analysisRows = await rpc('evidence.list', { taskId: submitted.taskId, kind: 'experiment' });
    eq(analysisRows.length, 1, 'discovery analyze evidence record count');
    const verdictRow = analysisRows[0];
    eq(verdictRow.payload?.verdict, 'supported', 'discovery verdict');
    eq(verdictRow.payload?.result?.value, 1.25, 'discovery analyze embeds the imported result');
    eq(verdictRow.contradicting, false, 'supported verdict is not contradicting');
    CHECK(String(verdictRow.citation || '').startsWith('experiment:'), `evidence citation: ${short(verdictRow.citation, 100)}`);
    CHECK(/^[0-9a-f]{64}$/.test(String(verdictRow.payloadSha256 || '')), 'discovery evidence payloadSha256');

    const hypothesis = await rpc('hypothesis.get', { id: hypothesisId });
    eq(hypothesis.status, 'supported', 'hypothesis status after supported verdict');

    const feedbackHypotheses = (await rpc('hypothesis.list', { projectId })).filter(
      row => row.taskId === submitted.taskId && row.origin === 'discovery-feedback',
    );
    CHECK(feedbackHypotheses.length >= 1, 'discovery feedback did not create follow-up hypotheses');

    const graphResponse = await rpc('research.graph', { taskId: submitted.taskId });
    CHECK(graphResponse.graph && typeof graphResponse.graph === 'object', 'research.graph did not return the feedback graph');
    const graph = graphResponse.graph;
    CHECK(Array.isArray(graph.milestones) && graph.milestones.some(milestone => milestone.kind === 'discovery-feedback'), 'research graph missing discovery-feedback milestone');
    log(`experiment ${experiment.id} approved+completed, verdict supported, ${feedbackHypotheses.length} follow-up hypotheses, graph ${graphResponse.recordId}`);
    return {
      detail: `experiment ${experiment.id}: ${beforeApprovalError.slice(0, 60)}… → approved → result imported → verdict supported; graph has discovery-feedback milestone`,
      evidence: {
        taskId: submitted.taskId,
        experiment: { id: experiment.id, status: completedExperiment.status, simulated: experiment.simulated },
        beforeApprovalError,
        evidence: { id: verdictRow.id, verdict: verdictRow.payload.verdict, citation: verdictRow.citation, payloadSha256: verdictRow.payloadSha256 },
        hypotheses: feedbackHypotheses.map(row => ({ id: row.id, statement: row.statement })),
        graph: { recordId: graphResponse.recordId, milestones: graph.milestones?.slice(-4) },
      },
    };
  });

  // -- 11. autonomy ---------------------------------------------------------
  await runCase('autonomy', 'bounded research graph: plan (≤8 nodes), high-risk approval, execute/verify/update', async log => {
    const objective = 'Profile the deterministic E2E dataset and confirm the research worker health, then checkpoint the research graph.';
    const submitted = await rpc('research.autonomy', { projectId, objective, rounds: 2 });
    const waiting = await waitForApprovalStep(submitted.taskId, 90000);
    eq(waiting.step.id, 'autonomy_approval', `autonomy approval step (${describeTask(waiting.task)})`);

    let graphResponse = await rpc('research.graph', { taskId: submitted.taskId });
    CHECK(graphResponse.graph, 'research.graph returned no plan before approval');
    const planned = graphResponse.graph;
    CHECK(Array.isArray(planned.nodes) && planned.nodes.length >= 1, 'planned graph has no nodes');
    CHECK(planned.nodes.length <= 8, `planned graph exceeds the 8 node cap: ${planned.nodes.length}`);
    eq(planned.budget?.maxNodes, 8, 'graph budget maxNodes');
    for (const node of planned.nodes) {
      CHECK(['research', 'analysis', 'knowledge', 'hypothesis'].includes(node.kind), `unexpected planned node kind ${node.kind}`);
    }
    CHECK(planned.nodes.some(node => node.kind === 'analysis'), 'fixture plan should contain one analysis node');

    await confirmStep(submitted.taskId, waiting.step.id, { approved: true });
    const task = await waitTask(submitted.taskId, 240000);
    CHECK(task.status === 'completed', `autonomy task did not complete: ${describeTask(task)}`);

    graphResponse = await rpc('research.graph', { taskId: submitted.taskId });
    const finalGraph = graphResponse.graph;
    CHECK(finalGraph, 'research.graph lost the graph');
    eq(finalGraph.status, 'complete', 'final graph status');
    eq(finalGraph.worldState?.phase, 'complete', 'final graph worldState.phase');
    CHECK(Number(finalGraph.worldState?.verifiedNodes) >= 1, `worldState.verifiedNodes: ${short(finalGraph.worldState, 300)}`);
    for (const node of finalGraph.nodes) {
      CHECK(['completed', 'verified'].includes(node.status), `node ${node.id} final status ${node.status}`);
    }
    CHECK(Array.isArray(finalGraph.milestones) && finalGraph.milestones.length >= 1, 'graph has no checkpoint milestones');
    CHECK(finalGraph.milestones.some(milestone => milestone.kind === 'checkpoint'), 'graph has no checkpoint milestone');
    const updateSteps = (task.steps || []).filter(step => String(step.id).startsWith('autonomy_update_'));
    eq(updateSteps.length, 2, 'autonomy_update step count for rounds=2');
    log(`plan ${planned.nodes.length} nodes (cap 8), execution completed, worldState.phase=complete, milestones=${finalGraph.milestones.length}`);
    return {
      detail: `plan ${planned.nodes.length}/8 nodes, execute+verify+update completed, graph status=complete, milestones=${finalGraph.milestones.length}`,
      evidence: {
        taskId: submitted.taskId,
        planned: { nodes: planned.nodes.map(node => ({ id: node.id, kind: node.kind, deps: node.deps })), budget: planned.budget },
        final: {
          status: finalGraph.status,
          worldState: finalGraph.worldState,
          nodes: finalGraph.nodes.map(node => ({ id: node.id, kind: node.kind, status: node.status })),
          milestones: finalGraph.milestones?.slice(-2),
        },
      },
    };
  });

  // -- 12. MCP registry with local stdio fixture ---------------------------
  await runCase('mcp', 'MCP registry add/health/tools/remove with a local stdio fixture server', async log => {
    const added = await rpc('mcp.add', {
      name: 'e2e-fixture-mcp',
      transport: 'stdio',
      command: process.execPath,
      args: [MCP_FIXTURE],
      readOnly: true,
      enabled: true,
    });
    const server = unwrap(added, 'server');
    CHECK(server && typeof server.id === 'string', `mcp.add returned no server: ${short(added, 300)}`);
    mcpServerId = server.id;
    eq(server.transport, 'stdio', 'mcp server transport');
    eq(server.readOnly, true, 'mcp server readOnly');

    const healthResponse = await rpc('mcp.health', { id: mcpServerId });
    const healthy = unwrap(healthResponse, 'server');
    eq(healthy.health?.status, 'ok', `mcp.health status (${short(healthy.health, 400)})`);
    CHECK(typeof healthy.health?.latencyMs === 'number', 'mcp.health latencyMs missing');
    CHECK(Array.isArray(healthy.tools) && healthy.tools.some(tool => tool.name === 'e2e_ping'), `mcp.health did not persist the e2e_ping tool: ${short(healthy.tools, 300)}`);

    const toolsResponse = await rpc('mcp.tools', { id: mcpServerId, refresh: true });
    const tools = unwrap(toolsResponse, 'tools');
    const tool = Array.isArray(tools) ? tools.find(item => item.name === 'e2e_ping') : null;
    CHECK(tool, 'mcp.tools did not return e2e_ping');
    eq(tool.inputSchema?.type, 'object', 'mcp tool inputSchema type');

    const removed = await rpc('mcp.remove', { id: mcpServerId });
    eq(removed.ok, true, 'mcp.remove');
    CHECK(!(await rpc('mcp.list')).servers.some(item => item.id === mcpServerId), 'removed MCP server still listed');
    log(`MCP fixture handshake ok, tools=${healthy.tools.length}, removed`);
    return {
      detail: `stdio fixture handshake ok (${MCP_FIXTURE}), e2e_ping tool listed, server removed`,
      evidence: {
        server: { id: mcpServerId, transport: server.transport, readOnly: server.readOnly, health: healthy.health },
        tools: (Array.isArray(tools) ? tools : []).map(item => ({ name: item.name, description: item.description, schemaType: item.inputSchema?.type })),
      },
    };
  });

  // -- 13. local SKILL install + declared test + invalid skill rejection ----
  await runCase('skill-install', 'install a local SKILL fixture, run its declared test, reject an invalid skill dir', async log => {
    const inspectedResponse = await rpc('skill.inspect', { path: SKILL_FIXTURE });
    const inspection = unwrap(inspectedResponse, 'inspection');
    eq(inspection.allowed, true, `skill.inspect allowed (${short(inspection, 400)})`);
    eq(inspection.manifest?.name, 'e2e-fixture-skill', 'skill.inspect manifest name');
    eq(inspection.license, 'MIT', 'skill.inspect license');

    const installed = await rpc('skill.install', { path: SKILL_FIXTURE, confirm: true });
    const skill = unwrap(installed, 'skill');
    CHECK(skill && typeof skill.id === 'string', `skill.install returned no skill: ${short(installed, 300)}`);
    eq(skill.license, 'MIT', 'installed skill license');
    eq(skill.test?.status, 'not_run', 'installed skill test status before running');
    eq(skill.enabled, true, 'installed skill enabled default');

    installedSkillId = skill.id;

    const invalidError = await expectRpcError(
      () => rpc('skill.install', { path: INVALID_SKILL_FIXTURE, confirm: true }),
      /manifest|rejected/i,
      'install invalid SKILL dir',
    );
    CHECK(!(await rpc('skill.list')).skills.some(item => item.name === 'invalid'), 'invalid skill dir produced a skill record');
    log(`installed ${skill.id}; invalid dir rejected (${invalidError.slice(0, 70)}…)`);
    return {
      detail: `installed ${skill.id} (MIT); invalid dir rejected by static scan`,
      evidence: {
        inspection: { allowed: inspection.allowed, name: inspection.manifest?.name, license: inspection.license, findings: inspection.findings?.slice(0, 5) },
        skill: { id: skill.id, name: skill.name, version: skill.version, license: skill.license, sha256: skill.sha256, test: skill.test },
        invalidError,
      },
    };
  });

  // -- 13b. declared SKILL test (worker sandbox path) -----------------------
  await runCase('skill-test', 'declared SKILL test executes inside the research worker sandbox', async log => {
    CHECK(installedSkillId, 'skill-install case did not produce an installed skill');
    const tested = await rpc('skill.test', { id: installedSkillId });
    eq(tested.status, 'passed', `skill.test status (detail: ${short(tested.detail, 400)})`);
    CHECK(/exit=0/.test(tested.detail || ''), `skill.test detail should contain exit=0: ${short(tested.detail, 200)}`);
    const after = (await rpc('skill.list')).skills.find(item => item.id === installedSkillId);
    eq(after?.test?.status, 'passed', 'persisted skill test status');
    log(`${installedSkillId}: declared python test passed (${short(tested.detail, 90)})`);
    return {
      detail: `skill.test passed for ${installedSkillId}`,
      evidence: { tested, persisted: after?.test },
    };
  });

  // -- 14. channels: telegram + webhook against local fixtures --------------
  await runCase('channels', 'Telegram + webhook channels: secret refs, health probe, send, inbox, read-only guard', async log => {
    const secrets = await rpc('secrets.set', { refs: { 'e2e-telegram-bot': BOT_TOKEN } });
    eq(secrets.ok, true, 'secrets.set ok');
    eq(secrets.count, 1, 'secrets.set count');

    const savedTelegram = unwrap(
      await rpc('channel.save', {
        type: 'telegram',
        name: 'E2E Telegram fixture',
        config: { botRef: 'e2e-telegram-bot', chatId: '1', baseUrl: state.fixtureBaseUrl },
        enabled: true,
        readOnly: false,
      }),
      'channel',
    );
    CHECK(savedTelegram && typeof savedTelegram.id === 'string', 'channel.save telegram returned no channel');
    telegramChannelId = savedTelegram.id;
    eq(savedTelegram.readOnly, false, 'telegram channel readOnly');
    eq(savedTelegram.health?.status, 'unknown', 'telegram channel initial health status');

    const telegramHealth = unwrap(await rpc('channel.test', { id: telegramChannelId }), 'health');
    eq(telegramHealth.status, 'ok', `telegram health (${short(telegramHealth, 400)})`);
    CHECK(String(telegramHealth.detail || '').includes(`@${BOT_USERNAME}`), `telegram health detail should include the fixture bot username: ${short(telegramHealth.detail, 200)}`);

    const sent = await rpc('channel.send', { id: telegramChannelId, text: 'E2E deterministic telegram fixture message' });
    eq(sent.ok, true, 'telegram channel.send ok');
    eq(sent.messageId, '42', 'telegram fixture message id');
    const getMeHit = state.httpHits.find(hit => hit.method === 'GET' && hit.path === `/bot${BOT_TOKEN}/getMe`);
    CHECK(getMeHit, 'local Telegram Bot API fixture did not receive GET /getMe');
    const sendHit = state.httpHits.find(hit => hit.method === 'POST' && hit.path === `/bot${BOT_TOKEN}/sendMessage`);
    CHECK(sendHit, 'local Telegram Bot API fixture did not receive POST /sendMessage');
    eq(String(sendHit.body?.chat_id), '1', 'telegram sendMessage chat_id');
    eq(sendHit.body?.text, 'E2E deterministic telegram fixture message', 'telegram sendMessage text');

    const inbox = unwrap(await rpc('channel.inbox', { channelId: telegramChannelId, limit: 50 }), 'messages');
    const outbound = (Array.isArray(inbox) ? inbox : []).filter(message => message.direction === 'outbound' && message.text === 'E2E deterministic telegram fixture message');
    eq(outbound.length, 1, 'telegram outbound channelMessage in inbox');

    const readOnlyChannel = unwrap(
      await rpc('channel.save', {
        type: 'webhook',
        name: 'E2E read-only webhook',
        config: { url: `${state.fixtureBaseUrl}/webhook` },
      }),
      'channel',
    );
    const readOnlyError = await expectRpcError(
      () => rpc('channel.send', { id: readOnlyChannel.id, text: 'must be rejected' }),
      /read-only/i,
      'channel.send on a read-only channel',
    );
    await rpc('channel.remove', { id: readOnlyChannel.id });

    const savedWebhook = unwrap(
      await rpc('channel.save', {
        type: 'webhook',
        name: 'E2E webhook fixture',
        config: { url: `${state.fixtureBaseUrl}/webhook` },
        enabled: true,
        readOnly: false,
      }),
      'channel',
    );
    webhookChannelId = savedWebhook.id;
    const webhookHealth = unwrap(await rpc('channel.test', { id: webhookChannelId }), 'health');
    eq(webhookHealth.status, 'ok', `webhook health (${short(webhookHealth, 400)})`);
    CHECK(/webhook reachable/.test(String(webhookHealth.detail || '')), `webhook health detail: ${short(webhookHealth.detail, 200)}`);
    const webhookSent = await rpc('channel.send', { id: webhookChannelId, text: 'E2E deterministic webhook payload' });
    eq(webhookSent.ok, true, 'webhook channel.send ok');
    eq(webhookSent.messageId, 'wh-msg-1', 'webhook fixture message id');
    const webhookHit = state.httpHits.find(hit => hit.method === 'POST' && hit.path === '/webhook');
    CHECK(webhookHit, 'local webhook fixture did not receive POST /webhook');
    eq(webhookHit.body?.text, 'E2E deterministic webhook payload', 'webhook POST body text');
    log(`telegram ok (GET getMe + POST sendMessage, message_id=42), webhook ok (message_id=wh-msg-1), read-only guard ok`);
    return {
      detail: 'telegram health/send/inbox verified against local Bot API fixture; webhook health/send verified; read-only send rejected',
      evidence: {
        secrets: { ok: secrets.ok, count: secrets.count },
        telegram: { channelId: telegramChannelId, health: telegramHealth, messageId: sent.messageId, botApi: { getMe: Boolean(getMeHit), sendMessage: Boolean(sendHit) } },
        inbox: (Array.isArray(inbox) ? inbox : []).map(message => ({ direction: message.direction, text: message.text, status: message.status })),
        readOnlyError,
        webhook: { channelId: webhookChannelId, health: webhookHealth, messageId: webhookSent.messageId },
      },
    };
  });

  // -- 15. RSI benchmark/review/promote/rollback ----------------------------
  await runCase('rsi', 'RSI benchmark baseline+candidates, review, promote and rollback', async log => {
    const activeStrategy = response => {
      const value = response?.active;
      if (Array.isArray(value)) return value.find(item => item?.kind === 'routing')?.strategy ?? null;
      return value ?? null;
    };
    let run;
    try {
      run = unwrap(await rpc('rsi.run', { kind: 'routing' }, 90000), 'run');
    } catch (error) {
      const runError = String(error.message);
      const sideEffects = {
        active: await rpc('rsi.active', { kind: 'routing' }).catch(inner => ({ error: String(inner.message) })),
        runs: await rpc('rsi.list', { kind: 'routing', limit: 20 }).catch(inner => ({ error: String(inner.message) })),
      };
      defects.push({
        id: 'rsi-runner-not-injected',
        severity: 'high',
        title: 'rsi.run / rsi.evaluate always fail over RPC because the daemon never injects an evaluation runner',
        repro: { method: 'rsi.run', params: { kind: 'routing' } },
        observedError: runError,
        expected: 'a deterministic built-in evaluation runner produces baseline+candidate metrics, persists a "strategy" and an "rsiRun" record, and moves the run to review or rolled_back',
        sideEffectsAfterFailure: sideEffects,
        codeRefs: ['desktop/src/daemon.ts:105 (createToolServices without rsiOptions/runner)', 'desktop/src/activities/tools.ts:43-51 (runner only from options)', 'desktop/src/domain/rsi.ts evaluate() throws ValidationError("rsi evaluation requires an injected runner")'],
      });
      throw new CaseFailure(`DEFECT: ${runError} — baseline strategy/draft run side effects: ${short(sideEffects, 500)}`);
    }
    CHECK(run && typeof run.id === 'string', `rsi.run returned no run: ${short(run, 300)}`);
    CHECK(['review', 'rolled_back'].includes(run.status), `rsi.run terminal status (${short(run, 400)})`);
    CHECK(run.baseline && typeof run.baseline === 'object', 'rsi run baseline missing');
    const baselineCases = run.baseline?.metrics?.cases;
    CHECK(typeof baselineCases === 'number' && baselineCases >= 1, `baseline metrics (${short(run.baseline, 400)})`);
    CHECK(Array.isArray(run.candidates) && run.candidates.length >= 1, `rsi candidates (${short(run.candidates, 400)})`);
    for (const candidate of run.candidates) {
      CHECK(candidate.metrics && typeof candidate.metrics === 'object', `candidate metrics missing: ${short(candidate, 300)}`);
      eq(candidate.metrics.cases, baselineCases, 'candidate and baseline must score the same eval set');
    }
    const runs = unwrap(await rpc('rsi.list', { kind: 'routing', limit: 50 }), 'runs');
    CHECK((Array.isArray(runs) ? runs : []).some(item => item.id === run.id), 'rsi.list does not contain the run');
    let evidence = { run, baseline: run.baseline };
    if (run.status === 'review') {
      CHECK(run.chosenCandidateId, 'review run has no chosen candidate');
      const beforeActive = activeStrategy(await rpc('rsi.active', { kind: 'routing' }));
      CHECK(beforeActive && typeof beforeActive.id === 'string', 'review run has no active baseline strategy');
      const reviewed = unwrap(await rpc('rsi.review', { runId: run.id, decision: 'approve', note: 'E2E deterministic review' }), 'run');
      eq(reviewed.status, 'canary', `rsi.review should move review -> canary (${short(reviewed, 300)})`);
      const promoted = unwrap(await rpc('rsi.promote', { runId: run.id, confirm: true, note: 'E2E deterministic promotion' }), 'run');
      eq(promoted.status, 'promoted', `rsi.promote status (${short(promoted, 300)})`);
      // RsiRunView/StrategyView do not expose strategyAfterId/parentStrategyId; the promotion is
      // verified through rsi.active (new id + version, and rollback restoring the baseline id).
      const afterActive = activeStrategy(await rpc('rsi.active', { kind: 'routing' }));
      CHECK(afterActive && typeof afterActive.id === 'string', 'rsi.active returned no strategy after promote');
      CHECK(afterActive.id !== beforeActive.id, 'rsi.promote did not supersede the active baseline strategy');
      eq(afterActive.version, (beforeActive.version ?? 0) + 1, 'promoted strategy version');
      const rolledBack = unwrap(await rpc('rsi.rollback', { runId: run.id, note: 'E2E deterministic rollback' }), 'run');
      eq(rolledBack.status, 'rolled_back', `rsi.rollback status (${short(rolledBack, 300)})`);
      const restored = activeStrategy(await rpc('rsi.active', { kind: 'routing' }));
      eq(restored?.id, beforeActive.id, 'rsi.rollback should restore the baseline strategy');
      evidence = {
        run,
        reviewed: { id: reviewed.id, status: reviewed.status },
        promoted: { id: promoted.id, status: promoted.status, strategyBefore: beforeActive.id, strategyAfter: afterActive.id },
        rolledBack: { id: rolledBack.id, status: rolledBack.status, restoredStrategy: restored?.id ?? null },
      };
      log(`run ${run.id}: review→canary→promoted→rolled_back; baseline cases=${baselineCases}, candidates=${run.candidates.length}, strategy ${beforeActive.id} → ${afterActive.id} → ${restored?.id}`);
    } else {
      // Every candidate regressed: baseline must stay active and the run is retained.
      const active = activeStrategy(await rpc('rsi.active', { kind: 'routing' }));
      CHECK(active && typeof active.id === 'string', 'rolled_back run left no active strategy');
      log(`run ${run.id}: rolled_back (every candidate regressed); baseline retained`);
    }
    return { detail: `RSI run ${run.id} ${run.status} (cases=${baselineCases}, candidates=${run.candidates.length})`, evidence };
  });

  // -- 16. cancellation of a running durable task --------------------------
  await runCase('cancel', 'cancel a running durable task and verify no artifacts are committed', async log => {
    const created = await rpc('create', { name: 'e2e-cancel-running', steps: [{ id: 'slow', kind: 'delay', input: { ms: 120000 } }] });
    const taskId = created.id ?? created.taskId;
    CHECK(typeof taskId === 'string', `create did not return a task id: ${short(created, 300)}`);
    const deadline = Date.now() + 30000;
    let observed = null;
    while (Date.now() < deadline) {
      observed = await findTask(taskId);
      if (observed && observed.status !== 'queued') break;
      await sleep(120);
    }
    CHECK(observed && observed.status !== 'queued', `task never left the queued state: ${describeTask(observed)}`);
    const cancelledTask = await rpc('control', { id: taskId, action: 'cancel' });
    const task = await waitTask(taskId, 30000);
    eq(task.status, 'cancelled', `cancelled task status (${describeTask(task)})`);
    eq((task.artifacts || []).length, 0, 'cancelled task must not commit artifacts');
    CHECK((task.steps || []).every(step => step.status !== 'running'), 'cancelled task still has a running step');
    const evidence = await rpc('evidence.list', { taskId });
    eq(evidence.length, 0, 'cancelled task must not write evidence records');
    log(`task ${taskId} cancelled (${cancelledTask?.status}); artifacts=0 evidence=0`);
    return {
      detail: `delay task cancelled (status=cancelled), no artifacts and no evidence`,
      evidence: { taskId, beforeCancel: { status: observed.status }, afterCancel: { status: task.status, artifacts: task.artifacts?.length ?? 0, steps: (task.steps || []).map(step => step.status) }, evidenceCount: evidence.length },
    };
  });

  // -- 17. legacy import inspect/apply/rollback with secret exclusion ------
  await runCase('import', 'legacy home inspect/apply/rollback with secret-key exclusion and backup', async log => {
    const inspected = await rpc('import.inspect');
    eq(inspected.exists, true, 'import.inspect exists');
    const conversationsItem = (inspected.items || []).find(item => item.kind === 'conversations');
    CHECK(conversationsItem && conversationsItem.count === 1, `conversations item: ${short(conversationsItem, 300)}`);
    const settingsItem = (inspected.items || []).find(item => item.kind === 'settings');
    CHECK(settingsItem, 'import.inspect did not report settings.json');
    CHECK((inspected.warnings || []).some(warning => /api_key/i.test(warning)), `expected a secret-key warning, got: ${short(inspected.warnings, 400)}`);
    CHECK((inspected.items || []).some(item => item.kind === 'excluded' && item.count >= 1), 'auth.json should be reported as an excluded file');

    const applied = unwrap(await rpc('import.apply', { kinds: ['conversations', 'settings'] }), 'job');
    CHECK(applied && typeof applied.id === 'string', `import.apply returned no job: ${short(applied, 300)}`);
    importJobId = applied.id;
    eq(applied.status, 'completed', `import.apply status (${short(applied, 400)})`);
    eq(applied.counts?.imported, 2, `import counts.imported: ${short(applied.counts, 200)}`);
    CHECK(typeof applied.backupPath === 'string' && fs.existsSync(applied.backupPath), 'import backup directory missing');
    CHECK(fs.existsSync(path.join(applied.backupPath, 'manifest.json')), 'import backup manifest missing');
    CHECK(fs.existsSync(path.join(applied.backupPath, 'conversations', 'session-1.json')), 'import backup conversation missing');
    CHECK(!fs.existsSync(path.join(applied.backupPath, 'auth.json')), 'never-imported auth.json must not be copied to the backup');

    legacyConversationId = (applied.createdRecordIds || []).find(id => String(id).startsWith('legacy-conv-'));
    CHECK(legacyConversationId, `import did not create an expected legacy conversation id: ${short(applied.createdRecordIds, 300)}`);
    const conversation = await rpc('conversation.get', { id: legacyConversationId });
    eq(conversation.title, 'Legacy E2E conversation', 'imported conversation title');
    eq(conversation.messages?.[0]?.text, 'legacy question from the E2E fixture', 'imported conversation first message');
    CHECK(String(conversation.legacy?.sourcePath || '').endsWith('session-1.json'), `imported conversation legacy.sourcePath: ${short(conversation.legacy, 200)}`);

    // The daemon store (outside the by-design raw backup) must never contain the secret value.
    const leak = findSentinelLeak(HOME_DIR, SENTINEL_SECRET, path.join(HOME_DIR, 'migration'));
    CHECK(!leak, `legacy secret value leaked into ${leak}`);

    const jobs = unwrap(await rpc('import.jobs'), 'jobs');
    CHECK((Array.isArray(jobs) ? jobs : []).some(job => job.id === importJobId), 'import.jobs does not list the applied job');

    const rolled = await rpc('import.rollback', { jobId: importJobId });
    CHECK(Number(rolled.removed) >= 2, `import.rollback removed=${short(rolled.removed, 100)}`);
    await expectRpcError(() => rpc('conversation.get', { id: legacyConversationId }), /unknown|not found/i, 'conversation.get after rollback');
    const rolledJobs = unwrap(await rpc('import.jobs'), 'jobs');
    const rolledJob = (Array.isArray(rolledJobs) ? rolledJobs : []).find(job => job.id === importJobId);
    eq(rolledJob?.status, 'rolled_back', 'import job status after rollback');
    CHECK(fs.existsSync(applied.backupPath), 'rollback must keep the raw migration backup');
    log(`imported conversations+settings (2 records), secret excluded from store, rollback removed ${rolled.removed} records, backup kept`);
    return {
      detail: `imported 2 records (conversation + settings) with api_key excluded; rollback removed ${rolled.removed}; raw backup kept`,
      evidence: {
        inspect: { legacyHome: inspected.legacyHome, items: inspected.items, warnings: inspected.warnings },
        job: { id: applied.id, status: applied.status, counts: applied.counts, backupPath: applied.backupPath, createdRecordIds: applied.createdRecordIds },
        conversation: { id: legacyConversationId, title: conversation.title, legacy: conversation.legacy, messages: conversation.messages?.length },
        rollback: rolled,
        finalJobStatus: rolledJob?.status,
      },
    };
  });

  // -- 18. live public-database checks (gated) -----------------------------
  if (LIVE) {
    await runCase('live-knowledge', 'research.knowledge against a real PubMed/Europe PMC query', async log => {
      const submitted = await rpc('research.knowledge', {
        projectId,
        question: 'CRISPR base editing off-target effects in human cells',
        databases: ['pubmed'],
        limit: 3,
      });
      const task = await waitTask(submitted.taskId, 300000);
      CHECK(task.status === 'completed', `live knowledge task did not complete: ${describeTask(task)}`);
      const findings = await rpc('evidence.list', { taskId: submitted.taskId, kind: 'literature' });
      CHECK(findings.length >= 1, 'live knowledge task wrote no literature evidence');
      for (const finding of findings) {
        eq(finding.source, 'pubmed', `live finding source (${short(finding, 200)})`);
        CHECK(/^[0-9a-f]{64}$/.test(String(finding.payloadSha256 || '')), 'live finding payloadSha256');
        CHECK(typeof finding.citation === 'string' && finding.citation.length > 0, 'live finding citation');
        // The live database adapter may stamp retrievedAt as an epoch-ms number or an ISO string.
        CHECK(
          (typeof finding.retrievedAt === 'string' && finding.retrievedAt.length >= 10) ||
            (typeof finding.retrievedAt === 'number' && finding.retrievedAt > 0),
          `live finding retrievedAt (got ${short(finding.retrievedAt, 80)})`,
        );
        CHECK(finding.payload && typeof finding.payload === 'object', 'live finding payload');
      }
      const extractStep = (task.steps || []).find(step => step.id === 'knowledge_extract');
      CHECK(String(extractStep?.output?.text || '').length > 20, 'live knowledge digest text missing');
      const artifacts = task.artifacts || [];
      CHECK(artifacts.length >= 1 && /^[0-9a-f]{64}$/.test(String(artifacts[0].sha256 || '')), 'live knowledge model artifact missing');
      liveResults.push({
        id: 'live-knowledge',
        case: 'research.knowledge databases=[pubmed] limit=3',
        taskId: submitted.taskId,
        findings: findings.length,
        sample: findings.slice(0, 3).map(finding => ({ sourceId: finding.payload?.sourceId, title: short(finding.title, 160), url: finding.url, citation: short(finding.citation, 120), retrievedAt: finding.retrievedAt })),
        summary: short(extractStep?.output?.text, 400),
        artifacts: artifacts.length,
      });
      log(`live knowledge: ${findings.length} literature findings, ${artifacts.length} artifacts`);
      return { detail: `live PubMed: ${findings.length} findings`, evidence: liveResults[liveResults.length - 1] };
    }, { gated: true });

    await runCase('live-uniprot', 'direct UniProt task (bundled database MCP server, live network)', async log => {
      const real = await rpc('create', { name: 'e2e-live-uniprot', steps: [{ id: 'search', kind: 'uniprot', input: { query: 'TP53' } }] });
      const realId = real.id ?? real.taskId;
      const done = await waitTask(realId, 180000);
      eq(done.status, 'completed', `live uniprot task: ${describeTask(done)}`);
      const searchStep = (done.steps || []).find(step => step.id === 'search');
      const output = searchStep?.output;
      CHECK(output, 'live uniprot step has no output');
      CHECK(JSON.stringify(output).length > 100, 'live uniprot output is unexpectedly small');
      const artifacts = done.artifacts || [];
      CHECK(artifacts.length >= 1 && /^[0-9a-f]{64}$/.test(String(artifacts[0].sha256 || '')), 'live uniprot artifact sha256');
      liveResults.push({
        id: 'live-uniprot',
        case: 'create kind=uniprot query=TP53',
        taskId: realId,
        outputPreview: short(JSON.stringify(output), 500),
        artifacts: artifacts.length,
      });
      log(`live uniprot: output ${JSON.stringify(output).length} chars, ${artifacts.length} artifacts`);
      return { detail: `live UniProt output ${JSON.stringify(output).length} chars`, evidence: liveResults[liveResults.length - 1] };
    }, { gated: true });
  } else {
    cases.push({
      id: 'live-knowledge',
      title: 'research.knowledge against a real PubMed/Europe PMC query',
      status: 'skip',
      detail: 'live-gated: re-run with --live (or SUWEN_E2E_LIVE=1) to query a real public database.',
      evidence: { gate: '--live / SUWEN_E2E_LIVE=1' },
      ms: 0,
      gated: true,
      at: isoNow(),
    });
    cases.push({
      id: 'live-uniprot',
      title: 'direct UniProt task (bundled database MCP server, live network)',
      status: 'skip',
      detail: 'live-gated: re-run with --live (or SUWEN_E2E_LIVE=1) to query a real public database.',
      evidence: { gate: '--live / SUWEN_E2E_LIVE=1' },
      ms: 0,
      gated: true,
      at: isoNow(),
    });
    process.stdout.write('[SKIP ] live-knowledge — live-gated\n[SKIP ] live-uniprot — live-gated\n');
  }

  // -- report ---------------------------------------------------------------
  const finishedAt = new Date();
  const passed = cases.filter(item => item.status === 'pass').length;
  const failed = cases.filter(item => item.status === 'fail').length;
  const skipped = cases.filter(item => item.status === 'skip').length;
  const deterministicFailures = cases.filter(item => item.status === 'fail' && !item.gated).length;
  const liveFailures = cases.filter(item => item.status === 'fail' && item.gated).length;

  // Defect register: the five defects found by the pre-fix deterministic run are kept as static
  // records with their original reproduction evidence. A defect is only marked fixed when every
  // mapped case passes on this build.
  const defectRegister = [
    {
      id: 'D1',
      title: 'research activity executeScript and skill tests never injected a worker sandboxRoot',
      severity: 'high',
      caseIds: ['methods', 'analysis', 'skill-test', 'runScript-sandbox', 'autonomy'],
      preFixError: "'sandboxRoot' must be a non-empty absolute path string",
      preFixRepro: { method: 'research.methods', params: { name: 'e2eMethod…' }, failedStep: 'methods_test', alsoSeenIn: ['skill.test', 'analysis_run'] },
      expectedAfterFix: 'research.runScript / skill.test / methods_test calls carry sandboxRoot=<daemon home>/sandbox and complete',
    },
    {
      id: 'D2',
      title: 'analysis datasetProfile worker input used the wrong field for the worker path',
      severity: 'high',
      caseIds: ['analysis'],
      preFixError: "'path' must be a non-empty absolute path string (analysis_profile worker input mapping)",
      preFixRepro: { method: 'research.analysis', params: { datasetPath: '<dataset.csv>' }, failedStep: 'analysis_profile' },
      expectedAfterFix: 'analysis_profile sends worker input {path: datasetPath}; source-only profiles are rejected with an explicit datasetPath ValidationError',
    },
    {
      id: 'D3',
      title: 'hypothesis.select did not persist status "selected", blocking the discovery design step',
      severity: 'high',
      caseIds: ['hypothesis', 'discovery'],
      preFixError: "hypothesis status transition 'ranked' -> 'testing' is not allowed",
      preFixRepro: { method: 'hypothesis.select', params: { id: '$hypothesisId' }, then: 'research.discovery {design:{simulated:false}}', failedStep: 'discovery_design' },
      expectedAfterFix: 'select returns status "selected" and the discovery design step creates a proposed experiment',
    },
    {
      id: 'D4',
      title: 'daemon never injected an RSI evaluation runner, so rsi.run always failed over RPC',
      severity: 'high',
      caseIds: ['rsi'],
      preFixError: 'rsi evaluation requires an injected runner',
      preFixRepro: { method: 'rsi.run', params: { kind: 'routing' } },
      preFixSideEffects: { activeBaselineStrategy: true, draftRunPersisted: true, seededEvalCases: true },
      expectedAfterFix: 'rsi.run benchmarks baseline+candidates on one eval set; review/promote/rollback reachable',
    },
    {
      id: 'D5',
      title: 'conversation view dropped the imported legacy provenance block',
      severity: 'medium',
      caseIds: ['import'],
      preFixError: 'imported conversation.legacy was null after import.apply',
      preFixRepro: { method: 'conversation.get', params: { id: 'legacy-conv-…' } },
      expectedAfterFix: 'conversation.get/list expose legacy.sourcePath/sourceSha256/backupPath/jobId',
    },
    {
      id: 'D6',
      title: 'methods-scaffolded skill manifests declared only tests[] so RPC skill.test rejected them',
      severity: 'high',
      caseIds: ['methods'],
      preFixError: 'Skill skill-e2eMethod…-<sha8> declares no test command',
      preFixRepro: {
        method: 'research.methods',
        params: { name: 'e2eMethod…' },
        then: 'skill.test {id: <scaffolded skillId>}',
      },
      expectedAfterFix: 'runMethodsScaffold persists manifest.test {language:"python",script:"test_sample.py",timeoutMs}; skill.test executes it and reports passed',
    },
    {
      id: 'D7',
      title: 'methods-scaffolded skill records lacked installedPath, so the registry scanned a nonexistent directory',
      severity: 'high',
      caseIds: ['methods'],
      preFixError: "ENOENT: no such file or directory, scandir '<home>/skills/skill-e2eMethod…-<sha8>'",
      preFixRepro: {
        method: 'skill.test',
        params: { id: 'skill-e2eMethod…-<sha8>' },
        note: 'the activity writes <home>/skills/<name>-<sha8> but SkillRegistry resolved <home>/skills/<recordId>',
      },
      expectedAfterFix: 'the record persists installedPath=<home>/skills/<name>-<sha8> with containment enforcement; skill.test/enable/disable/remove work on scaffolded skills',
    },
  ].map(entry => {
    const mapped = entry.caseIds.map(id => cases.find(item => item.id === id)).filter(Boolean);
    return {
      ...entry,
      fixed: mapped.length > 0 && mapped.every(item => item.status === 'pass'),
      caseStatus: mapped.map(item => ({ id: item.id, status: item.status })),
      verifiedAt: isoNow(),
    };
  });

  const report = {
    tool: 'suwen-desktop-vnext/scripts/e2e-research.mjs',
    startedAt: STARTED_AT.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - STARTED_AT.getTime(),
    command: `node scripts/e2e-research.mjs${LIVE ? ' --live' : ''}${KEEP ? ' --keep' : ''}`,
    cwd: ROOT,
    host: { platform: process.platform, arch: process.arch, node: process.version, cpus: os.cpus().length },
    daemon: {
      path: DAEMON_PATH,
      version: state.version,
      pipe: state.connection?.pipe ?? null,
      log: DAEMON_LOG,
      modelCalls: state.modelCalls,
      model: { provider: 'openai', baseUrl: `${state.fixtureBaseUrl}/v1`, name: 'suwen-e2e-fixture', note: 'deterministic local OpenAI-compatible SSE fixture model; no vendor API and no real credentials' },
    },
    environment: {
      home: HOME_DIR,
      legacyHome: LEGACY_DIR,
      datasets: DATASETS_DIR,
      tempRoot: TMP_ROOT,
      python: state.python,
      live: LIVE,
      keep: KEEP,
    },
    summary: { total: cases.length, passed, failed, skipped, deterministicFailures, liveFailures },
    cases,
    defects,
    defectRegister,
    live: { enabled: LIVE, results: liveResults },
    fixtures: { mcpServer: MCP_FIXTURE, skill: SKILL_FIXTURE, invalidSkill: INVALID_SKILL_FIXTURE, analysisScript: ANALYSIS_SOURCE_PATH },
    limitations: [
      'The model is a deterministic LOCAL OpenAI-compatible SSE fixture served from 127.0.0.1; no real vendor model was exercised and no real API key exists.',
      'Database-backed knowledge and direct UniProt checks are live-gated and were skipped in this deterministic run unless --live is recorded above.',
      'No clean VM / fresh-user environment: run on the developer workstation with node_modules and a system python 3.11 present.',
      'The legacy workbench UI is out of scope (this machine lacks fastapi for the legacy server); only the headless daemon RPC surface was exercised.',
      'Channel fixtures are local HTTP servers shaped like the Telegram Bot API and a generic webhook; no real Telegram/Slack/Discord/email delivery was attempted.',
      'Defects D1-D7 were found by the pre-fix deterministic runs on 2026-10-24; this report re-verifies each one on the fixed build (see defectRegister for both pre-fix error strings and post-fix case status).',
      'The live knowledge digest text (knowledge_extract) is produced by the local fixture model; it cites the real live sourceIds but is not a scientific summary.',
      'The RSI evaluator injected by the daemon makes one bounded fixture-model call per eval case; it is a real evaluation path, not a vendor benchmark.',
    ],
  };

  fs.writeFileSync(path.join(REPORT_DIR, 'report.json'), JSON.stringify(report, null, 2));

  // -- console table --------------------------------------------------------
  process.stdout.write('\nPer-case results\n');
  process.stdout.write('================\n');
  for (const item of cases) {
    process.stdout.write(`${item.status.toUpperCase().padEnd(5)} ${String(item.id).padEnd(20)} ${item.title}\n`);
    if (item.status !== 'pass' && item.detail) process.stdout.write(`      ${item.detail.split('\n').slice(0, 4).join('\n      ')}\n`);
  }
  process.stdout.write('\nSummary\n=======\n');
  process.stdout.write(`  total=${cases.length} pass=${passed} fail=${failed} skip=${skipped}\n`);
  process.stdout.write(`  deterministic failures=${deterministicFailures} live failures=${liveFailures} defects=${defects.length}\n`);
  process.stdout.write(`  model calls (fixture)=${state.modelCalls}; http fixture hits=${state.httpHits.length}\n`);
  process.stdout.write(`  report: ${path.join(REPORT_DIR, 'report.json')}\n`);
  process.stdout.write(`  daemon log: ${DAEMON_LOG}\n`);
  if (defects.length) {
    process.stdout.write('\nDefects\n=======\n');
    for (const defect of defects) {
      process.stdout.write(`  [${defect.severity}] ${defect.id}: ${defect.title}\n`);
      process.stdout.write(`      repro: ${JSON.stringify(defect.repro)}\n`);
      process.stdout.write(`      observed: ${short(defect.observedError, 400)}\n`);
    }
  }
  // -- defect register ------------------------------------------------------
  process.stdout.write('\nDefect register (pre-fix evidence -> post-fix verification)\n');
  process.stdout.write('=========================================================\n');
  for (const entry of defectRegister) {
    process.stdout.write(`  ${entry.id} ${entry.fixed ? 'FIXED' : 'OPEN '} ${entry.title}\n`);
    process.stdout.write(`      pre-fix: ${short(entry.preFixError, 160)}\n`);
    process.stdout.write(`      now: ${entry.caseStatus.map(item => `${item.id}=${item.status}`).join(' ')}\n`);
  }
  return deterministicFailures === 0 && liveFailures === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// secret-leak scan (store files only; the raw migration backup is by design)
// ---------------------------------------------------------------------------
function findSentinelLeak(directory, sentinel, skipDirectory) {
  const needle = Buffer.from(sentinel, 'utf8');
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (skipDirectory && (full === skipDirectory || full.startsWith(skipDirectory + path.sep))) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.size > 64 * 1024 * 1024) continue;
      let bytes;
      try {
        bytes = fs.readFileSync(full);
      } catch {
        continue;
      }
      if (bytes.includes(needle)) return full;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// shutdown / cleanup
// ---------------------------------------------------------------------------
async function shutdownDaemon() {
  if (!state.child) return;
  try {
    await rpc('shutdown', {}, 8000);
  } catch {
    /* ignore: the daemon may already be gone */
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && state.daemonExitCode === null) await sleep(100);
  if (state.daemonExitCode === null) {
    try {
      state.child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

async function shutdownFixtureServer() {
  if (!state.fixtureServer) return;
  await new Promise(resolve => state.fixtureServer.close(() => resolve()));
  state.fixtureServer = null;
}

function cleanupTemporaryDirectories() {
  if (KEEP) {
    process.stdout.write(`\n--keep: temp directories retained\n  home: ${HOME_DIR}\n  legacy: ${LEGACY_DIR}\n  temp: ${TMP_ROOT}\n`);
    return;
  }
  for (const directory of [HOME_DIR, LEGACY_DIR, DATASETS_DIR, TMP_ROOT]) {
    try {
      if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  process.stderr.write(`\nfatal harness error: ${error && error.stack ? error.stack : String(error)}\n\n`);
  if (state.daemonLogTail) process.stderr.write(`daemon log tail:\n${state.daemonLogTail.slice(-4000)}\n`);
  exitCode = 1;
  try {
    const failureReport = {
      tool: 'suwen-desktop-vnext/scripts/e2e-research.mjs',
      fatal: true,
      error: String(error && error.message ? error.message : error),
      at: isoNow(),
      cases,
      defects,
    };
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(path.join(REPORT_DIR, 'report.json'), JSON.stringify(failureReport, null, 2));
  } catch {
    /* ignore */
  }
} finally {
  try {
    await shutdownDaemon();
  } catch {
    /* ignore */
  }
  try {
    await shutdownFixtureServer();
  } catch {
    /* ignore */
  }
  cleanupTemporaryDirectories();
}

process.exitCode = exitCode;
