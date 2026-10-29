import type { EvalRunner } from './domain/rsi.js';
import type { Json } from './harness/types.js';
import type { ModelMessage } from './shared/contract.js';

export const RSI_EVALUATION_POLICY = Object.freeze({ repetitions: 2 });
type Call = (messages: ModelMessage[], signal: AbortSignal) => Promise<{ text: string; tokens: number }>;

function normalized(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value.trim()); } catch { return value.trim(); }
}

function matches(answer: unknown, expected: Json): boolean {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    return JSON.stringify(answer) === JSON.stringify(expected);
  }
  const text = typeof answer === 'string' ? answer : JSON.stringify(answer);
  if (typeof expected.equals === 'string') return text === expected.equals.trim();
  if (typeof expected.contains === 'string') return text.includes(expected.contains);
  if (Array.isArray(expected.oneOf)) return expected.oneOf.some(value =>
    JSON.stringify(answer) === JSON.stringify(normalized(value)));
  if (expected.answer !== undefined) return JSON.stringify(answer) === JSON.stringify(normalized(expected.answer));
  return JSON.stringify(answer) === JSON.stringify(expected);
}

/** Model-answer regression only; scientific evidence and tool correctness need native trace evaluators. */
export function createRsiModelRunner(call: Call): EvalRunner {
  return async args => {
    const started = performance.now();
    const signal = args.signal ?? new AbortController().signal;
    const messages: ModelMessage[] = [
      { role: 'system', content: 'Apply this candidate strategy to the evaluation input. '
        + 'Reply with one JSON object containing answer. Strategy: '
        + JSON.stringify({ kind: args.evalCase.kind, config: args.baselineConfig }) },
      { role: 'user', content: JSON.stringify(args.evalCase.input) },
    ];
    const answers: unknown[] = [];
    try {
      for (let index = 0; index < RSI_EVALUATION_POLICY.repetitions; index++) {
        const reply = await call(messages, signal);
        const value = normalized(reply.text);
        answers.push(value && typeof value === 'object' && !Array.isArray(value) && 'answer' in value
          ? (value as Record<string, unknown>).answer : value);
      }
      return { caseId: args.evalCase.id, success: answers.every(answer => matches(answer, args.evalCase.expect)),
        reproducible: answers.every(answer => JSON.stringify(answer) === JSON.stringify(answers[0])),
        latencyMs: performance.now() - started };
    } catch (error) {
      if (signal.aborted) throw error;
      return { caseId: args.evalCase.id, success: false, reproducible: false,
        latencyMs: performance.now() - started };
    }
  };
}
