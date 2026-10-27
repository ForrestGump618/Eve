import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextBudgetError, ContextManager, CompactionService, encodingForContextModel, type ContextMessage, type CompactionInput, type ContextSummary } from '../src/context.js';

const call: ContextMessage = { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'analyze', arguments: '{}' } }] };

test('large repeated context bodies are deduplicated while raw hashes and old inline records remain valid',()=>{
 const directory=mkdtempSync(join(tmpdir(),'eve-context-dedup-'));
 try{
  const options={directory,model:'deepseek-v4.1-flash-economy',contextWindow:64000,outputTokens:512,accounting:'estimate' as const};
  const manager=new ContextManager(options),text='Evidence /remote/研究.csv\n'.repeat(600);
  const messages:ContextMessage[]=[{role:'user',content:'Keep original goal.'},{role:'assistant',content:text}];
  for(let i=0;i<10;i++)manager.prepare({recordOnly:true,messages,tools:[{name:'example',description:'x'.repeat(5000)}]});
  const objects=join(directory,'objects'),files=readdirSync(objects);
  assert.equal(files.length,2);
  const bytes=statSync(join(directory,'raw-events.jsonl')).size+files.reduce((n,f)=>n+statSync(join(objects,f)).size,0);
  const inlineBytes=Buffer.byteLength(JSON.stringify({messages,tools:[{name:'example',description:'x'.repeat(5000)}]}))*10;
  assert.ok(bytes<inlineBytes/3);
  assert.deepEqual(new ContextManager(options).replay()?.messages,messages);
  const file=files.find(f=>readFileSync(join(objects,f),'utf8').includes('研究.csv'))!;
  writeFileSync(join(objects,file),readFileSync(join(objects,file),'utf8').replace('研究.csv','tampered.csv'));
  assert.throws(()=>new ContextManager(options),/integrity/);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('known tokenizer mapping and fail-closed unknown model', () => {
  assert.equal(encodingForContextModel('gpt-4o-2024-08-06'), 'o200k_base');
  assert.equal(encodingForContextModel('gpt-4-0613'), 'cl100k_base');
  assert.throws(() => encodingForContextModel('deepseek-chat'), /Unknown tokenizer/);
});

test('non-OpenAI protocols require explicit conservative estimated accounting', () => {
  const directory = mkdtempSync(join(tmpdir(), 'suwen-context-estimate-'));
  try {
    const manager = new ContextManager({ directory, model: 'claude-test', contextWindow: 8192, outputTokens: 256, accounting: 'estimate' });
    const result = manager.prepare({ messages: [{ role: 'user', content: '汉字 Unicode 😀' }] });
    assert.equal(result.stats.estimated, true);
    assert.equal(result.stats.accounting, 'conservative-utf8-bytes-plus-reserves');
    assert.equal(result.stats.encoding, 'utf8-bytes-upper-bound');
    assert.equal(result.stats.exactProviderFraming, false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('100k+ visible tokens survive ten compactions with explicit constraints, evidence, and immutable raw history', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'suwen-context-'));
  try {
    const manager = new ContextManager({ directory, model: 'gpt-4o', contextWindow: 8192, outputTokens: 512 });
    const longOutput = ' datapoint'.repeat(100_100) + '\nEvidence PMID:12345 p=0.004; negative result B; uncertainty remains.';
    const constraints = ['Do not overwrite sample.raw', 'No external network', 'Preserve negative results'];
    const state = { constraints, facts: [{ value: 'p=0.004', source: 'PMID:12345', sha256: 'a'.repeat(64) }],
      artifacts: [{ path: 'results/figure.png', sha256: 'b'.repeat(64) }], dag: [{ id: 'validate', status: 'queued' }],
      approvals: [{ operation: 'publish', approved: false }], environment: { python: '3.12' }, failures: ['fit-1 failed'], questions: ['Confirm cohort?'] };
    const messages: ContextMessage[] = [{ role: 'system', content: 'Follow workspace permissions.' },
      { role: 'user', content: 'Analyze cohort. Do not overwrite sample.raw. Preserve negative results.' }, call,
      { role: 'tool', tool_call_id: 'c1', content: longOutput }, { role: 'assistant', content: 'Analysis stage complete.' }];
    let priorRaw = '';
    const measured: Array<{ before: number; after: number }> = [];
    for (let round = 0; round < 10; round++) {
      messages.push({ role: 'user', content: `Continue validation round ${round}; no external network.` });
      const result = manager.prepare({ messages, state, force: true });
      assert.equal(result.action, 'compacted');
      assert.ok(result.stats.beforeTokens > 100_000);
      assert.ok(result.stats.afterTokens < 8192 * .82);
      assert.ok(result.stats.afterTokens / result.stats.beforeTokens < .1);
      assert.equal(result.summary?.stats.afterTokens, result.stats.afterTokens);
      measured.push({ before: result.stats.beforeTokens, after: result.stats.afterTokens });
      assert.equal(result.summary?.stats.explicitFactRetention, 1);
      assert.deepEqual(result.summary?.state, state);
      assert.equal(result.summary?.userGoals.length, round + 2);
      assert.ok(result.summary?.observedFacts.some(fact => fact.text.includes('PMID:12345')));
      assert.equal(result.messages[0]?.content, messages[0]?.content);
      const artifact = result.summary!.artifacts[0]!;
      assert.equal(manager.readArtifact(artifact.sha256), longOutput);
      assert.equal(manager.readSource(artifact.source).content, longOutput);
      const raw = readFileSync(join(directory, 'raw-events.jsonl'), 'utf8');
      assert.ok(raw.startsWith(priorRaw));
      priorRaw = raw;
    }
    assert.equal(manager.history().length, 10);
    const restarted = new ContextManager({ directory, model: 'gpt-4o', contextWindow: 8192, outputTokens: 512 });
    assert.deepEqual(restarted.replay()?.messages, messages);
    assert.equal(restarted.restore(1).version, 1);
    assert.equal(restarted.replay()?.messages.length, 6);
    assert.equal(restarted.history().length, 10);
    assert.equal(readFileSync(join(directory, 'raw-events.jsonl'), 'utf8'), priorRaw);
    t.diagnostic(`Ten rounds, visible tokens plus output/framing reserves: ${JSON.stringify(measured)}; explicit fact retention 100%; semantic coverage not claimed.`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('restart replays the latest request after a compacted turn and rejects tampered source logs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'suwen-context-replay-'));
  try {
    const options = { directory, model: 'gpt-4o', contextWindow: 8192, outputTokens: 256 };
    const manager = new ContextManager(options);
    manager.prepare({ messages: [{ role: 'user', content: 'Original goal.' }], force: true });
    const latest: ContextMessage[] = [{ role: 'user', content: 'Continue with new constraints.' }];
    manager.prepare({ messages: latest });
    assert.deepEqual(new ContextManager(options).replay()?.messages, latest);
    const rawPath = join(directory, 'raw-events.jsonl');
    writeFileSync(rawPath, readFileSync(rawPath, 'utf8').replace('Original goal.', 'Tampered goal.'));
    assert.throws(() => new ContextManager(options), /integrity/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('latest complete tool group is preserved and large output is retrievable', () => {
  const directory = mkdtempSync(join(tmpdir(), 'suwen-context-pairs-'));
  try {
    const manager = new ContextManager({ directory, model: 'gpt-4o', contextWindow: 8192, outputTokens: 512, toolOutputTokens: 50 });
    const messages: ContextMessage[] = [{ role: 'system', content: 'Preserve this exact system instruction.' }, { role: 'user', content: 'Summarize the input.' },
      call, { role: 'tool', tool_call_id: 'c1', content: ' output'.repeat(3000) }];
    const result = manager.prepare({ messages });
    assert.equal(result.action, 'compacted');
    assert.deepEqual(result.messages.at(-2)?.tool_calls, call.tool_calls);
    assert.equal(result.messages.at(-1)?.tool_call_id, 'c1');
    assert.equal(JSON.parse(result.messages.at(-1)!.content).kind, 'archived-tool-output');
    assert.throws(() => manager.prepare({ messages: [{ role: 'tool', tool_call_id: 'orphan', content: 'unsafe' }] }), /Orphan/);
    assert.throws(() => manager.prepare({ messages: [call] }), /incomplete/);
    assert.throws(() => manager.readArtifact('../secret'), /Invalid artifact hash/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('coverage failures preserve original context and never commit a candidate summary', () => {
  class BrokenCompactor extends CompactionService {
    override create(input: CompactionInput): ContextSummary {
      const result = super.create(input); result.state.constraints = []; return result;
    }
  }
  const directory = mkdtempSync(join(tmpdir(), 'suwen-context-bad-'));
  try {
    const manager = new ContextManager({ directory, model: 'gpt-4o', contextWindow: 4096, outputTokens: 256, compaction: new BrokenCompactor() });
    const messages: ContextMessage[] = [{ role: 'system', content: 'Never overwrite.' }, { role: 'user', content: 'Retain all constraints.' }];
    assert.throws(() => manager.prepare({ messages, state: { constraints: ['No file deletion'] }, force: true }), error => {
      assert.ok(error instanceof ContextBudgetError); assert.deepEqual(error.originalMessages, messages); return true;
    });
    assert.equal(manager.history().length, 0);
    assert.deepEqual(manager.replay()?.messages, messages);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('system, schemas, and verbatim user budget overflow reject rather than truncate', () => {
  const directory = mkdtempSync(join(tmpdir(), 'suwen-context-overflow-'));
  try {
    const manager = new ContextManager({ directory, model: 'gpt-4o', contextWindow: 4096, outputTokens: 256 });
    const messages: ContextMessage[] = [{ role: 'system', content: ' must-preserve'.repeat(5000) }, { role: 'user', content: 'Do not drop the original objective.' }];
    assert.throws(() => manager.prepare({ messages, tools: [{ description: ' schema'.repeat(2000) }] }), error => {
      assert.ok(error instanceof ContextBudgetError); assert.deepEqual(error.originalMessages, messages); return true;
    });
    assert.equal(manager.history().length, 0);
    assert.equal(manager.countTokens([{ role: 'user', content: 'hello' }], [{ description: 'visible schema' }]) > manager.countTokens([{ role: 'user', content: 'hello' }]), true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
