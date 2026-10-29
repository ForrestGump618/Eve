import test from 'node:test';
import assert from 'node:assert/strict';
import { createRsiModelRunner } from '../src/rsi-evaluation.js';
import type { ModelMessage } from '../src/shared/contract.js';

test('RSI measures the candidate configuration and does not disclose expected answers', async () => {
  const requests: ModelMessage[][] = [];
  const runner = createRsiModelRunner(async messages => {
    requests.push(messages);
    return { text: '{"answer":"observed"}', tokens: 12 };
  });
  const args = { candidateId: 'candidate', change: { evidenceFirst: true },
    baselineConfig: { evidenceFirst: true },
    evalCase: { id: 'case', kind: 'prompt' as const, input: { question: 'What was observed?' },
      expect: { answer: 'observed', privateCanary: 'expected-secret' }, weight: 1 } };
  const result = await runner(args);
  assert.equal(result.success, true);
  assert.equal(result.reproducible, true);
  assert.equal(result.cost, undefined);
  assert.equal(result.evidenceScore, undefined);
  assert.equal(requests.length, 2);
  assert.ok(requests[0]![0]!.content.includes('evidenceFirst'));
  assert.ok(!JSON.stringify(requests).includes('expected-secret'));
});

test('RSI does not call one stochastic result reproducible', async () => {
  let call = 0;
  const runner = createRsiModelRunner(async () => ({ text: JSON.stringify({ answer: ++call }), tokens: 1 }));
  const result = await runner({ candidateId: 'baseline', change: {}, baselineConfig: {},
    evalCase: { id: 'case', kind: 'prompt', input: {}, expect: 1, weight: 1 } });
  assert.equal(result.reproducible, false);
  assert.equal(result.success, false);
});
