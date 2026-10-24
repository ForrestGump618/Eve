import test from 'node:test';

import assert from 'node:assert/strict';

import { ValidationError } from '../src/harness/types.js';
import type { TaskDefinition } from '../src/harness/types.js';
import {
  DEFAULT_SCRIPT_TIMEOUT_MS,
  MAX_SCRIPT_TIMEOUT_MS,
  RESEARCH_GRAPH_NODE_CAP,
  buildAnalysisTask,
  buildAutonomyTask,
  buildDiscoveryTask,
  buildKnowledgeTask,
  buildMethodsTask,
  canonicalJson,
  createResearchGraphData,
  edgesFromNodes,
  httpUrlOrNull,
  assertAcyclicDependencies,
  loadResearchGraph,
  payloadSha256,
  toJson,
  validateDatasetPath,
} from '../src/domain/research.js';
import {
  assertHypothesisTransition,
  buildDebateTask,
  buildHypothesisTask,
  hypothesisDedupeKey,
  rankHypothesisRows,
} from '../src/domain/hypothesis.js';
import { FakeClock, FakeRecordStore } from './fixtures/research/fake-services.js';

function stepById(task: TaskDefinition, id: string) {
  const step = task.steps.find((candidate) => candidate.id === id);
  assert.ok(step, `expected step '${id}' in task '${task.name}'`);
  return step;
}

function assertChained(task: TaskDefinition, expected: string[]): void {
  assert.deepEqual(task.steps.map((step) => step.id), expected);
  expected.forEach((id, index) => {
    assert.deepEqual(stepById(task, id).dependsOn ?? [], index === 0 ? [] : [expected[index - 1]]);
  });
}

test('knowledge builder produces a search -> extract DAG with stable ids', () => {
  const task = buildKnowledgeTask({ question: 'Does marker X predict outcome Y?', databases: ['pubmed'], limit: 3, projectId: 'proj-1' });
  assert.match(task.id ?? '', /^knowledge-/);
  assert.equal(task.name, 'knowledge.search-extract');
  assertChained(task, ['knowledge_search', 'knowledge_extract']);
  assert.equal(stepById(task, 'knowledge_search').kind, 'knowledge');
  assert.equal(stepById(task, 'knowledge_extract').kind, 'model');
  assert.equal(stepById(task, 'knowledge_search').sideEffect, false);
  assert.equal(stepById(task, 'knowledge_search').timeoutMs, 180_000);
  assert.equal(task.limits?.maxCalls, 8);
  assert.equal(task.limits?.concurrency, 2);
  const searchInput = stepById(task, 'knowledge_search').input;
  assert.ok(searchInput !== undefined && typeof searchInput === 'object' && !Array.isArray(searchInput));
  assert.equal((searchInput as Record<string, unknown>).question, 'Does marker X predict outcome Y?');
  assert.equal(buildKnowledgeTask({ question: 'Does marker X predict outcome Y?', databases: ['pubmed'], limit: 3, projectId: 'proj-1' }).id, task.id);
  assert.notEqual(buildKnowledgeTask({ question: 'A different question?', projectId: 'proj-1' }).id, task.id);
});

test('knowledge builder rejects invalid questions, databases, limits and project ids', () => {
  assert.throws(() => buildKnowledgeTask({ question: '' }), ValidationError);
  assert.throws(() => buildKnowledgeTask({ question: 'ab' }), ValidationError);
  assert.throws(() => buildKnowledgeTask({ question: 'q'.repeat(2001) }), ValidationError);
  assert.throws(() => buildKnowledgeTask({ question: 'valid question', databases: ['ebi' as 'pubmed'] }), ValidationError);
  assert.throws(() => buildKnowledgeTask({ question: 'valid question', databases: [] }), ValidationError);
  assert.throws(() => buildKnowledgeTask({ question: 'valid question', limit: 0 }), ValidationError);
  assert.throws(() => buildKnowledgeTask({ question: 'valid question', limit: 11 }), ValidationError);
  assert.throws(() => buildKnowledgeTask({ question: 'valid question', projectId: 'p'.repeat(201) }), ValidationError);
});

test('methods builder wires scaffold then test without external side effects', () => {
  const task = buildMethodsTask({ name: 'assay-kit', paperText: 'Some paper text.', projectId: 'proj-1' });
  assert.deepEqual(task.steps.map((step) => step.id), ['methods_scaffold', 'methods_test']);
  assert.deepEqual(stepById(task, 'methods_test').dependsOn, ['methods_scaffold']);
  assert.equal(stepById(task, 'methods_scaffold').kind, 'methods');
  assert.equal(stepById(task, 'methods_scaffold').sideEffect, false);
  assert.equal(stepById(task, 'methods_scaffold').timeoutMs, 240_000);
  assert.equal(stepById(task, 'methods_test').maxAttempts, 1);
  assert.equal(stepById(task, 'methods_test').timeoutMs, 300_000);
  const scaffoldInput = stepById(task, 'methods_scaffold').input as Record<string, unknown>;
  assert.equal(scaffoldInput.op, 'scaffold');
  assert.equal(scaffoldInput.name, 'assay-kit');
  assert.equal(scaffoldInput.paperText, 'Some paper text.');
});

test('methods builder rejects hostile or malformed skill names', () => {
  assert.throws(() => buildMethodsTask({ name: '../evil' }), ValidationError);
  assert.throws(() => buildMethodsTask({ name: 'evil/name' }), ValidationError);
  assert.throws(() => buildMethodsTask({ name: '1bad' }), ValidationError);
  assert.throws(() => buildMethodsTask({ name: 'a'.repeat(65) }), ValidationError);
  assert.throws(() => buildMethodsTask({ name: 'ok-name', repoPath: '/tmp/\u0000repo' }), ValidationError);
});

test('analysis builder validates dataset/train-test inputs and chains profile -> run -> verify', () => {
  const task = buildAnalysisTask({ datasetPath: '/data/train.csv', source: 'print("{}")', projectId: 'proj-1' });
  assert.deepEqual(task.steps.map((step) => step.id), ['analysis_profile', 'analysis_run', 'analysis_verify']);
  assert.deepEqual(stepById(task, 'analysis_profile').dependsOn ?? [], []);
  assert.deepEqual(stepById(task, 'analysis_run').dependsOn, ['analysis_profile']);
  assert.deepEqual(stepById(task, 'analysis_verify').dependsOn, ['analysis_profile', 'analysis_run']);
  assert.equal(stepById(task, 'analysis_run').kind, 'analysis');
  assert.equal(stepById(task, 'analysis_run').maxAttempts, 1);
  assert.equal(stepById(task, 'analysis_verify').kind, 'model');
  const runInput = stepById(task, 'analysis_run').input as Record<string, unknown>;
  assert.equal(runInput.source, 'print("{}")');
  assert.equal(runInput.metric, 'score');
  assert.throws(() => buildAnalysisTask({ datasetPath: '', source: 'x' }), ValidationError);
  assert.throws(() => buildAnalysisTask({ datasetPath: '/data/x.csv', source: '' }), ValidationError);
  assert.throws(() => buildAnalysisTask({ datasetPath: '/data/x.csv', source: 'x', metric: '1bad' }), ValidationError);
  assert.throws(() => buildAnalysisTask({ datasetPath: '/data/x.csv', source: 'x', trainPath: '/data/train.csv' }), ValidationError);
  assert.throws(() => buildAnalysisTask({ datasetPath: '/data/x.csv', source: 'x', trainPath: '/data/same.csv', testPath: '/data/same.csv' }), ValidationError);
});

test('discovery builder orders design -> approval -> import -> analyze -> feedback', () => {
  const task = buildDiscoveryTask({ hypothesisId: 'hyp-1', design: { summary: 'Randomised assay' } });
  assert.deepEqual(task.steps.map((step) => step.id), [
    'discovery_design',
    'discovery_approval',
    'discovery_import',
    'discovery_analyze',
    'discovery_feedback',
  ]);
  assert.deepEqual(stepById(task, 'discovery_approval').dependsOn, ['discovery_design']);
  assert.deepEqual(stepById(task, 'discovery_import').dependsOn, ['discovery_approval']);
  assert.deepEqual(stepById(task, 'discovery_analyze').dependsOn, ['discovery_import']);
  assert.deepEqual(stepById(task, 'discovery_feedback').dependsOn, ['discovery_analyze']);
  assert.equal(stepById(task, 'discovery_approval').kind, 'approval');
  assert.equal(stepById(task, 'discovery_import').kind, 'approval');
  const designInput = stepById(task, 'discovery_design').input as Record<string, unknown>;
  assert.equal((designInput.design as Record<string, unknown>).simulated, true);
  const realTask = buildDiscoveryTask({ hypothesisId: 'hyp-1', design: { summary: 'Real assay' }, simulated: false });
  const realInput = stepById(realTask, 'discovery_design').input as Record<string, unknown>;
  assert.equal((realInput.design as Record<string, unknown>).simulated, false);
  assert.throws(() => buildDiscoveryTask({ hypothesisId: '', design: {} }), ValidationError);
  assert.throws(() => buildDiscoveryTask({ hypothesisId: 'hyp-1', design: 'not-an-object' as unknown as Record<string, unknown> }), ValidationError);
});

test('autonomy builder bounds the loop and exposes one plan approval', () => {
  const task = buildAutonomyTask({ objective: 'Find a testable biomarker' });
  assert.deepEqual(task.steps.map((step) => step.id), [
    'autonomy_plan',
    'autonomy_approval',
    'autonomy_execute_r1',
    'autonomy_verify_r1',
    'autonomy_update_r1',
    'autonomy_execute_r2',
    'autonomy_verify_r2',
    'autonomy_update_r2',
  ]);
  assert.deepEqual(stepById(task, 'autonomy_approval').dependsOn, ['autonomy_plan']);
  assert.deepEqual(stepById(task, 'autonomy_execute_r1').dependsOn, ['autonomy_approval']);
  assert.deepEqual(stepById(task, 'autonomy_execute_r2').dependsOn, ['autonomy_update_r1']);
  assert.equal((stepById(task, 'autonomy_execute_r1').input as Record<string, unknown>).approved, true);
  assert.equal(task.limits?.concurrency, 1);
  assert.equal(task.limits?.maxCalls, 2 * 4 + 4);
  const four = buildAutonomyTask({ objective: 'Find a testable biomarker', rounds: 4 });
  assert.equal(four.steps.length, 2 + 4 * 3);
  assert.equal(four.limits?.maxCalls, 4 * 4 + 4);
  assert.throws(() => buildAutonomyTask({ objective: 'ab' }), ValidationError);
  assert.throws(() => buildAutonomyTask({ objective: 'valid objective', rounds: 0 }), ValidationError);
  assert.throws(() => buildAutonomyTask({ objective: 'valid objective', rounds: 5 }), ValidationError);
});

test('hypothesis builder chains generate -> critique -> rank with evidence validation', () => {
  const task = buildHypothesisTask({ question: 'Does marker X predict outcome Y?', evidenceIds: ['ev-1'], projectId: 'proj-1' });
  assert.match(task.id ?? '', /^hypothesis-/);
  assertChained(task, ['hypothesis_generate', 'hypothesis_critique', 'hypothesis_rank']);
  assert.equal(stepById(task, 'hypothesis_generate').kind, 'hypothesis');
  assert.deepEqual((stepById(task, 'hypothesis_generate').input as Record<string, unknown>).evidenceIds, ['ev-1']);
  assert.equal(task.limits?.maxCalls, 12);
  assert.throws(() => buildHypothesisTask({ question: 'ab' }), ValidationError);
  assert.throws(() => buildHypothesisTask({ question: 'valid question', evidenceIds: ['ev-1', 5 as unknown as string] }), ValidationError);
  assert.throws(() => buildHypothesisTask({ question: 'valid question', evidenceIds: Array.from({ length: 101 }, (_, index) => `ev-${index}`) }), ValidationError);
});

test('debate builder expands bounded rounds and a synthesize step', () => {
  const task = buildDebateTask({ question: 'Should assay A replace assay B?', rounds: 1 });
  assert.deepEqual(task.steps.map((step) => step.id), ['debate_r1_propose', 'debate_r1_critique', 'debate_r1_revise', 'debate_synthesize']);
  assert.deepEqual(stepById(task, 'debate_r1_critique').dependsOn, ['debate_r1_propose']);
  assert.deepEqual(stepById(task, 'debate_r1_revise').dependsOn, ['debate_r1_critique']);
  assert.deepEqual(stepById(task, 'debate_synthesize').dependsOn, ['debate_r1_revise']);
  assert.equal((stepById(task, 'debate_r1_propose').input as Record<string, unknown>).op, 'propose');
  assert.equal((stepById(task, 'debate_r1_critique').input as Record<string, unknown>).role, 'critic');
  assert.equal((stepById(task, 'debate_synthesize').input as Record<string, unknown>).op, 'synthesize');
  assert.equal(task.limits?.concurrency, 1);
  assert.throws(() => buildDebateTask({ question: 'A valid debate question?', rounds: 0 }), ValidationError);
  assert.throws(() => buildDebateTask({ question: 'A valid debate question?', rounds: 4 }), ValidationError);
});

test('hypothesis dedupe keys are normalized and stable', () => {
  const first = hypothesisDedupeKey(' Does X  predict Y? ', 'Statin reduces risk.');
  const second = hypothesisDedupeKey('does x predict y?', 'statin   reduces risk.');
  const different = hypothesisDedupeKey('does x predict y?', 'statin increases risk.');
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, second);
  assert.notEqual(first, different);
});

test('hypothesis status transitions are enforced', () => {
  assert.doesNotThrow(() => assertHypothesisTransition('draft', 'critiqued'));
  assert.doesNotThrow(() => assertHypothesisTransition('testing', 'supported'));
  assert.throws(() => assertHypothesisTransition('draft', 'ranked'), ValidationError);
  assert.throws(() => assertHypothesisTransition('draft', 'supported'), ValidationError);
  assert.throws(() => assertHypothesisTransition('supported', 'testing'), ValidationError);
});

test('rankHypothesisRows sorts by score descending then id', () => {
  const sorted = rankHypothesisRows([
    { id: 'b', score: 0.5 },
    { id: 'a', score: 0.9 },
    { id: 'c', score: 0.5 },
  ]);
  assert.deepEqual(sorted.map((row) => row.id), ['a', 'b', 'c']);
});

test('canonical JSON and payload hashes are deterministic', () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null] }), '{"a":[true,null],"b":1}');
  assert.equal(canonicalJson({ a: 2, b: 1 }), canonicalJson({ b: 1, a: 2 }));
  assert.equal(payloadSha256({ b: 1, a: 2 }), payloadSha256({ a: 2, b: 1 }));
  assert.match(payloadSha256({ x: 1 }), /^[a-f0-9]{64}$/);
  assert.throws(() => canonicalJson(undefined));
  assert.throws(() => payloadSha256(Number.NaN));
});

test('graph helpers enforce acyclic, bounded graphs and load by id/scope', () => {
  assert.deepEqual(edgesFromNodes([{ id: 'a', deps: [] }, { id: 'b', deps: ['a'] }]), [{ from: 'a', to: 'b' }]);
  assert.doesNotThrow(() => assertAcyclicDependencies([{ id: 'a', deps: [] }, { id: 'b', deps: ['a'] }]));
  assert.throws(() => assertAcyclicDependencies([{ id: 'a', deps: ['b'] }, { id: 'b', deps: ['a'] }]), ValidationError);
  assert.throws(() => assertAcyclicDependencies([{ id: 'a', deps: ['missing'] }]), ValidationError);
  const graph = createResearchGraphData({ projectId: 'proj-x', taskId: 'task-x', objective: 'Find a marker', now: 1_700_000_000_000 });
  assert.equal(graph.projectId, 'proj-x');
  assert.equal(graph.taskId, 'task-x');
  assert.equal(graph.nodes.length, 0);
  assert.equal(graph.budget.maxNodes, RESEARCH_GRAPH_NODE_CAP);
  assert.equal(graph.status, 'planned');
  assert.deepEqual(graph.milestones, []);
  const tooMany = Array.from({ length: RESEARCH_GRAPH_NODE_CAP + 1 }, (_, index) => ({
    id: `n${index + 1}`,
    kind: 'knowledge',
    status: 'planned',
    deps: index === 0 ? [] : [`n${index}`],
    output: null,
    evidenceIds: [],
  }));
  assert.throws(() => createResearchGraphData({ objective: 'too many', now: 1, nodes: tooMany }), ValidationError);
  const clock = new FakeClock();
  const store = new FakeRecordStore(() => clock.now());
  store.putRecord('researchGraph', toJson(graph), { id: 'graph-test' });
  assert.equal(loadResearchGraph(store, { graphId: 'graph-test' })?.data.objective, 'Find a marker');
  assert.equal(loadResearchGraph(store, { projectId: 'proj-x', taskId: 'task-x' })?.row.id, 'graph-test');
  assert.equal(loadResearchGraph(store, { taskId: 'task-y' }), undefined);
  assert.equal(loadResearchGraph(store, { graphId: 'missing-graph' }), undefined);
  store.putRecord('researchGraph', { objective: 'corrupt graph data' } as never, { id: 'graph-bad' });
  assert.throws(() => loadResearchGraph(store, { graphId: 'graph-bad' }), ValidationError);
});

test('shared validation helpers keep contract bounds', () => {
  assert.equal(DEFAULT_SCRIPT_TIMEOUT_MS, 120_000);
  assert.equal(MAX_SCRIPT_TIMEOUT_MS, 600_000);
  assert.equal(httpUrlOrNull('https://example.org/a?b=1'), 'https://example.org/a?b=1');
  assert.equal(httpUrlOrNull('javascript:alert(1)'), null);
  assert.equal(httpUrlOrNull('/relative/path'), null);
  assert.equal(validateDatasetPath('/data/set.csv', 'path'), '/data/set.csv');
  assert.throws(() => validateDatasetPath('../escape.csv', 'path'), ValidationError);
  assert.throws(() => validateDatasetPath('/data/\u0000set.csv', 'path'), ValidationError);
});
