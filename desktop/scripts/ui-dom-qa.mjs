#!/usr/bin/env node
'use strict';
/*
 * SuWen vNext — UI DOM QA (static, no Electron, no network).
 *
 * Checks:
 *  1. index.html is parseable enough for the fixed structure (five pages, legacy ids) and the
 *     frozen CSP is byte-identical (`connect-src 'none'`).
 *  2. Every action in ui/actions.json has a unique id and a method that belongs to
 *     desktop/src/shared/contract.ts RPC_METHODS. The five legacy main-process bridge methods
 *     (settings, login, reconnect, pythonPicker, support) are allowed with a warning because
 *     they are outside RPC_METHODS and must be reported to the Lead.
 *  3. Every RPC method the UI actually calls is declared in the contract and covered by an
 *     actions.json entry (auto entries cover polling/loading calls without a user control).
 *  4. zh/en parity: every copy dictionary entry has exactly two non-empty strings; every
 *     data-i18n* key in index.html and every t('key') reference in app.js exists in the dict.
 *  5. No innerHTML assignment except static empty/constant strings (textContent-only rule).
 *  6. No old brand (OmicLab) anywhere in the UI.
 *
 * Exit code 1 when any failure is found; warnings alone keep the exit code 0.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, '..');
const uiDir = path.join(desktopDir, 'ui');
const contractPath = path.join(desktopDir, 'src', 'shared', 'contract.ts');

const failures = [];
const warnings = [];
const checks = [];
function ok(name, detail) { checks.push({ name, detail: detail || '' }); }
function fail(name, detail) { checks.push({ name, detail: detail || '', failed: true }); failures.push(`${name}${detail ? `: ${detail}` : ''}`); }
function warn(name, detail) { warnings.push(`${name}${detail ? `: ${detail}` : ''}`); }

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (error) { fail('read-file', `${file} (${error.code || error.message})`); return ''; }
}

/* ---------- contract ---------- */
const contractSource = read(contractPath);
let rpcMethods = [];
const rpcBlock = contractSource.match(/RPC_METHODS[^=]*=\s*\[([\s\S]*?)\]/);
if (rpcBlock) {
  rpcMethods = [...rpcBlock[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
}
if (!rpcMethods.length) fail('contract', `RPC_METHODS not found in ${path.relative(desktopDir, contractPath)}`);
else ok('contract', `${rpcMethods.length} RPC methods`);
const rpcSet = new Set(rpcMethods);
const BRIDGE_METHODS = ['settings', 'login', 'reconnect', 'pythonPicker', 'support'];

/* ---------- actions.json ---------- */
const actionsPath = path.join(uiDir, 'actions.json');
let actions = [];
try {
  actions = JSON.parse(read(actionsPath));
  if (!Array.isArray(actions)) { fail('actions', 'actions.json must be a JSON array'); actions = []; }
} catch (error) {
  fail('actions', `actions.json is not valid JSON (${error.message})`);
}
const actionIds = new Set();
const declaredMethods = new Set();
const pagesSeen = new Set();
const bridgeUsed = new Set();
for (const action of actions) {
  const label = action && action.id ? action.id : '(missing id)';
  if (!action || typeof action !== 'object') { fail('action-shape', label); continue; }
  if (!action.id || typeof action.id !== 'string') fail('action-id', JSON.stringify(action));
  else if (actionIds.has(action.id)) fail('action-duplicate', action.id);
  else actionIds.add(action.id);
  if (typeof action.selector !== 'string' || !action.selector.trim()) fail('action-selector', action.id);
  if (action.page !== 'global' && !['chat', 'projects', 'tasks', 'tools', 'settings'].includes(action.page)) fail('action-page', `${action.id} -> ${action.page}`);
  pagesSeen.add(action.page);
  if (action.params === undefined || action.params === null || typeof action.params !== 'object') fail('action-params', action.id);
  if (typeof action.notes !== 'string' || !action.notes.trim()) fail('action-notes', action.id);
  if (action.method === null || action.method === undefined) continue;
  if (typeof action.method !== 'string') { fail('action-method-type', action.id); continue; }
  declaredMethods.add(action.method);
  if (rpcSet.has(action.method)) continue;
  if (BRIDGE_METHODS.includes(action.method)) { bridgeUsed.add(action.method); warn('bridge-method', `${action.id} -> ${action.method} (main-process bridge outside RPC_METHODS)`); continue; }
  fail('action-method-unknown', `${action.id} -> ${action.method}`);
}
if (actions.length) ok('actions', `${actions.length} actions, ${actionIds.size} unique ids, pages: ${[...pagesSeen].sort().join(',')}`);
else fail('actions', 'actions.json is empty');

/* ---------- index.html ---------- */
const html = read(path.join(uiDir, 'index.html'));
const EXPECTED_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
if (html.includes(EXPECTED_CSP)) ok('csp', 'frozen CSP intact');
else fail('csp', 'CSP meta content changed or missing');
if (!/connect-src 'none'/.test(html)) fail('csp-connect', "connect-src 'none' missing");

const REQUIRED_IDS = [
  'timeline', 'prompt', 'send', 'sessions', 'health', 'page-title', 'language', 'toggle-evidence',
  'error', 'new-chat', 'mode', 'research-example', 'demo', 'composer', 'welcome',
  'project-form', 'project-name', 'project-notes', 'project-list',
  'task-demo', 'task-list', 'task-filter-status', 'task-filter-kind', 'task-filter-text',
  'tool-results', 'settings-form', 'saved', 'diagnostics', 'launch-login', 'reconnect',
  'pick-python', 'support', 'shutdown', 'evidence', 'close-evidence', 'evidence-content',
  'provider', 'baseUrl', 'model', 'apiKey', 'contextWindow', 'maxOutput', 'confirm-dialog',
];
const missingIds = REQUIRED_IDS.filter(id => !new RegExp(`id="${id}"`).test(html));
if (missingIds.length) fail('legacy-ids', `missing: ${missingIds.join(', ')}`);
else ok('legacy-ids', `${REQUIRED_IDS.length} ids present`);

const pageIds = ['chat', 'projects', 'tasks', 'tools', 'settings'].filter(id => new RegExp(`id="${id}"`).test(html));
if (pageIds.length === 5) ok('pages', 'chat/projects/tasks/tools/settings');
else fail('pages', `found ${pageIds.join(',') || 'none'}`);

/* ---------- app.js: called methods, i18n, innerHTML, brand ---------- */
const appSource = read(path.join(uiDir, 'app.js'));
const CALL_ALLOWED_EXTRA = new Set(); // no extra RPC methods are allowed
const calledMethods = new Map();
for (const match of appSource.matchAll(/\bcall\(\s*'([^']+)'/g)) {
  calledMethods.set(match[1], (calledMethods.get(match[1]) || 0) + 1);
}
for (const [method, count] of calledMethods) {
  if (rpcSet.has(method)) continue;
  if (BRIDGE_METHODS.includes(method)) { bridgeUsed.add(method); warn('bridge-call', `${method} (${count}x) is a main-process bridge outside RPC_METHODS`); continue; }
  if (CALL_ALLOWED_EXTRA.has(method)) continue;
  fail('app-method-unknown', `${method} (${count}x) is not in RPC_METHODS`);
}
const uncovered = [...calledMethods.keys()].filter(method => !declaredMethods.has(method));
if (uncovered.length) warn('action-coverage', `methods called but not declared as an action: ${uncovered.join(', ')}`);
else ok('action-coverage', `all ${calledMethods.size} called RPC/bridge methods appear in actions.json`);

/* i18n dictionary parity */
const dictEntries = new Map();
for (const match of appSource.matchAll(/(?:^|[,{]\s*)(?:'([^']+)'|([A-Za-z][\w]*))\s*:\s*\[\s*'([^']*)'\s*,\s*'([^']*)'\s*\]/gm)) {
  const key = match[1] || match[2];
  if (!key || dictEntries.has(key)) continue;
  dictEntries.set(key, [match[3], match[4]]);
}
const emptyTranslations = [...dictEntries.entries()].filter(([, pair]) => !pair[0].trim() || !pair[1].trim()).map(([key]) => key);
if (!dictEntries.size) fail('i18n-dict', 'no copy dictionary entries found');
else if (emptyTranslations.length) fail('i18n-empty', emptyTranslations.join(', '));
else ok('i18n-dict', `${dictEntries.size} bilingual keys`);

const htmlKeys = new Set([...html.matchAll(/data-i18n(?:-title|-placeholder|-aria)?="([^"]+)"/g)].map(match => match[1]));
const missingHtmlKeys = [...htmlKeys].filter(key => !dictEntries.has(key)).sort();
if (missingHtmlKeys.length) fail('i18n-html', `missing keys: ${missingHtmlKeys.join(', ')}`);
else ok('i18n-html', `${htmlKeys.size} data-i18n keys resolved`);

const tKeys = new Set();
for (const match of appSource.matchAll(/\bt\(\s*'([^']+)'/g)) tKeys.add(match[1]);
for (const match of appSource.matchAll(/\bt\(\s*"([^"]+)"/g)) tKeys.add(match[1]);
const missingTKeys = [...tKeys].filter(key => !key.startsWith('!') && !dictEntries.has(key)).sort();
if (missingTKeys.length) fail('i18n-t', `missing keys: ${missingTKeys.join(', ')}`);
else ok('i18n-t', `${tKeys.size} t() references resolved`);

/* innerHTML rule: static empty strings only */
let innerHtmlViolations = 0;
for (const match of appSource.matchAll(/([^\n]*?)\.innerHTML\s*=\s*([^\n;]*)/g)) {
  const value = match[2].trim()
    .replace(/\s*\/\/.*$/, '')
    .trim();
  const staticOnly = /^(['"])(?:(?!\1)[^$\\])*\1\s*;?$/.test(value) || /^['"]{2}\s*;?$/.test(value);
  if (!staticOnly) innerHtmlViolations += 1;
}
if (innerHtmlViolations) fail('innerHTML', `${innerHtmlViolations} non-static innerHTML assignment(s); use textContent/createElement`);
else ok('innerHTML', 'no dynamic innerHTML assignments');

/* dynamic code / unsafe DOM APIs are forbidden under the frozen CSP and textContent rule */
const UNSAFE_APIS = [
  [/\beval\s*\(/g, 'eval('],
  [/\bnew\s+Function\s*\(/g, 'new Function('],
  [/insertAdjacentHTML/g, 'insertAdjacentHTML'],
  [/outerHTML/g, 'outerHTML'],
  [/document\.write\s*\(/g, 'document.write('],
  [/javascript:/g, 'javascript: URL'],
];
const unsafeHits = [];
for (const [pattern, label] of UNSAFE_APIS) {
  const count = [...appSource.matchAll(pattern)].length;
  if (count) unsafeHits.push(`${label} (${count})`);
}
if (unsafeHits.length) fail('dynamic-code', `forbidden APIs: ${unsafeHits.join(', ')}`);
else ok('dynamic-code', 'no eval/new Function/innerHTML-injection APIs');

/* old brand */
const brandFiles = ['index.html', 'app.js', 'style.css', 'actions.json'];
const brandHits = brandFiles.filter(file => { try { return /omiclab|omicslab/i.test(fs.readFileSync(path.join(uiDir, file), 'utf8')); } catch { return false; } });
if (brandHits.length) fail('old-brand', `old brand found in: ${brandHits.join(', ')}`);
else ok('old-brand', 'OmicLab/omicslab absent from UI');

/* step kind labels cover the contract TASK_STEP_KINDS (informational) */
const stepKindsMatch = contractSource.match(/TASK_STEP_KINDS[^=]*=\s*\[([\s\S]*?)\]/);
if (stepKindsMatch) {
  const stepKinds = [...stepKindsMatch[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  const missingLabels = stepKinds.filter(kind => !dictEntries.has(kind));
  if (missingLabels.length) warn('step-kind-labels', `missing i18n labels: ${missingLabels.join(', ')}`);
  else ok('step-kind-labels', `${stepKinds.length} contract step kinds labeled`);
}

/* required method families must be reachable from the UI (task-2 acceptance) */
const REQUIRED_FAMILIES = [
  ['chat', ['create']],
  ['task controls', ['control', 'approval', 'contextCompact', 'contextRestore', 'contextHistory', 'artifact.read']],
  ['projects', ['project.create', 'project.update', 'project.delete', 'conversation.list', 'research.graph', 'evidence.list', 'hypothesis.list', 'hypothesis.select', 'experiment.list', 'experiment.approve']],
  ['import', ['import.inspect', 'import.apply', 'import.jobs', 'import.rollback']],
  ['tools', ['mcp.list', 'mcp.add', 'mcp.health', 'mcp.tools', 'mcp.enable', 'mcp.disable', 'mcp.remove', 'skill.list', 'skill.inspect', 'skill.install', 'skill.enable', 'skill.disable', 'skill.test', 'skill.remove', 'channel.list', 'channel.save', 'channel.test', 'channel.send', 'channel.inbox', 'channel.remove', 'rsi.list', 'rsi.run', 'rsi.review', 'rsi.promote', 'rsi.rollback', 'rsi.active']],
  ['settings', ['configure', 'defaults.get', 'defaults.set', 'doctor.run', 'worker.health', 'shutdown']],
];
const allDeclared = new Set([...declaredMethods, ...calledMethods.keys()]);
for (const [family, methods] of REQUIRED_FAMILIES) {
  const missing = methods.filter(method => !allDeclared.has(method));
  if (missing.length) {
    const contractMissing = missing.filter(method => !rpcSet.has(method) && !BRIDGE_METHODS.includes(method));
    fail('coverage-family', `${family}: ${missing.join(', ')}${contractMissing.length ? ' (also absent from RPC_METHODS)' : ''}`);
  } else ok('coverage-family', family);
}

/* ---------- report ---------- */
const failedChecks = checks.filter(check => check.failed);
console.log('SuWen UI DOM QA');
for (const check of checks) console.log(`  ${check.failed ? 'FAIL' : 'ok  '} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
if (warnings.length) {
  console.log('Warnings:');
  for (const warning of warnings) console.log(`  warn ${warning}`);
}
console.log(`Summary: ${checks.length - failedChecks.length} passed, ${failedChecks.length} failed, ${warnings.length} warning(s); ${actions.length} actions, ${rpcMethods.length} contract RPC methods.`);
if (bridgeUsed.size) console.log(`Bridge methods used outside RPC_METHODS: ${[...bridgeUsed].sort().join(', ')}`);
if (failures.length) {
  console.error('Violations:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
process.exit(0);
