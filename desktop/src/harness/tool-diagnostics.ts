import { safeError } from '../security.js';
import { ValidationError, type Json } from './types.js';

/**
 * Tool failures are a protocol boundary. Keep the diagnosis structured so the
 * model can correct its own input without parsing a stack trace, while keeping
 * retries strictly limited to side-effect-free tools.
 */
export const TOOL_RECOVERY_POLICY = Object.freeze({
  maxReadOnlyAttempts: 2,
  baseRetryDelayMs: 120,
  maxSuggestions: 5,
});

export type ToolFailureCategory =
  | 'unknown_tool'
  | 'validation'
  | 'argument_json'
  | 'timeout'
  | 'cancelled'
  | 'network'
  | 'rate_limit'
  | 'empty_result'
  | 'permission'
  | 'not_found'
  | 'stale_state'
  | 'tool';

export interface ToolFailureDiagnostic {
  category: ToolFailureCategory;
  message: string;
  retryable: boolean;
  safeToRetry: boolean;
  field?: string;
  expected?: string;
  received?: string;
  suggestions: string[];
  hint: string;
}

export interface ToolDiagnosticContext {
  toolName: string;
  availableTools: string[];
  readOnly: boolean;
}

export interface ParsedToolArguments {
  args: Record<string, Json>;
  repaired: boolean;
  repairs: string[];
}

export interface NormalizedToolArguments {
  args: Record<string, Json>;
  repaired: boolean;
  repairs: string[];
}

export class ToolArgumentError extends ValidationError {
  readonly field?: string;
  readonly keyword?: string;
  readonly expected?: string;
  readonly received?: string;
  readonly suggestions: string[];

  constructor(message: string, details: {
    field?: string;
    keyword?: string;
    expected?: string;
    received?: string;
    suggestions?: string[];
  } = {}) {
    super(message);
    this.name = 'ToolArgumentError';
    this.field = details.field;
    this.keyword = details.keyword;
    this.expected = details.expected;
    this.received = details.received;
    this.suggestions = details.suggestions ?? [];
  }
}

export class UnknownToolError extends ValidationError {
  readonly requested: string;
  readonly suggestions: string[];

  constructor(requested: string, suggestions: string[]) {
    super(`Unknown tool: ${requested}${suggestions.length ? `. Did you mean ${suggestions.join(', ')}?` : ''}`);
    this.name = 'UnknownToolError';
    this.requested = requested;
    this.suggestions = suggestions;
  }
}

function normalizedName(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, '');
}

function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const saved = previous[j]!;
      previous[j] = Math.min(
        previous[j]! + 1,
        previous[j - 1]! + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = saved;
    }
  }
  return previous[right.length]!;
}

function similarity(left: string, right: string): number {
  const length = Math.max(left.length, right.length);
  return length === 0 ? 1 : 1 - editDistance(left, right) / length;
}

/** Resolve a misspelled tool name to a small, explainable candidate set. */
export function suggestToolNames(requested: string, availableTools: string[]): string[] {
  const wanted = normalizedName(requested);
  if (!wanted) return [];
  const ranked = availableTools
    .filter((name, index, all) => all.indexOf(name) === index && name !== requested)
    .map(name => {
      const normalized = normalizedName(name);
      const score = normalized === wanted
        ? 1
        : normalized.includes(wanted) || wanted.includes(normalized)
          ? 0.9
          : similarity(wanted, normalized);
      return { name, score };
    })
    .filter(entry => entry.score >= 0.58)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, TOOL_RECOVERY_POLICY.maxSuggestions);
  return ranked.map(entry => entry.name);
}

export function suggestFieldName(requested: string, allowed: string[]): string[] {
  return suggestToolNames(requested, allowed);
}

function receivedType(value: Json | undefined): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function propertyType(property: Json): string {
  if (!property || typeof property !== 'object' || Array.isArray(property)) return 'value';
  const type = property.type;
  if (typeof type === 'string') return type;
  if (Array.isArray(property.enum)) return `one of ${property.enum.map(item => JSON.stringify(item)).join(', ')}`;
  return 'value';
}

/** A focused description of the first Ajv failure, suitable for the model and trace. */
export function describeSchemaFailure(error: unknown, schema: unknown, skeletonPath: string): ToolArgumentError {
  if (error instanceof ToolArgumentError) return error;
  const record = schema && typeof schema === 'object' && !Array.isArray(schema)
    ? schema as Record<string, Json>
    : {};
  const properties = record.properties && typeof record.properties === 'object' && !Array.isArray(record.properties)
    ? record.properties as Record<string, Json>
    : {};
  const allowed = Object.keys(properties);
  return new ToolArgumentError(`${skeletonPath}: schema validation failed`, {
    ...(allowed.length ? { suggestions: allowed.slice(0, TOOL_RECOVERY_POLICY.maxSuggestions) } : {}),
  });
}

const ARGUMENT_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  path: ['file_path', 'filepath', 'file', 'filename', 'directory', 'dir'],
  query: ['query_text', 'queryText', 'search_query', 'searchQuery', 'q', 'term'],
  id: ['skill_id', 'skillId', 'run_id', 'runId', 'task_id', 'taskId'],
  expectedSha256: ['expected_sha256', 'sha256', 'hash'],
  startLine: ['start_line', 'start-line'],
  startChar: ['start_char', 'start-char'],
  serverId: ['server_id', 'server-id'],
  member_id: ['memberId', 'member-id'],
  depends_on: ['dependsOn', 'dependencies'],
  input: ['arguments', 'params', 'parameters'],
  limit: ['max_results', 'maxResults', 'max_count', 'maxCount', 'count'],
  content: ['text', 'body', 'data'],
  url: ['href', 'link'],
  command: ['cmd'],
  cwd: ['working_directory', 'workingDirectory', 'workdir'],
  timeoutSeconds: ['timeout_seconds', 'timeout', 'timeoutSec'],
});

function schemaProperties(schema: Record<string, Json>): Record<string, Json> {
  return schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, Json>
    : {};
}

/**
 * Repair only deterministic argument-shape mistakes: common aliases, scalar
 * strings for scalar schemas, and one item supplied where an array is declared.
 * It never invents a missing required value or changes a write destination.
 */
export function normalizeToolArguments(
  args: Record<string, Json>,
  schema: Record<string, Json>,
): NormalizedToolArguments {
  const properties = schemaProperties(schema);
  const next: Record<string, Json> = { ...args };
  const repairs: string[] = [];

  for (const [canonical, aliases] of Object.entries(ARGUMENT_ALIASES)) {
    if (!Object.hasOwn(properties, canonical)) continue;
    for (const alias of aliases) {
      if (!Object.hasOwn(next, alias) || Object.hasOwn(properties, alias)) continue;
      if (Object.hasOwn(next, canonical)) {
        if (JSON.stringify(next[canonical]) === JSON.stringify(next[alias])) {
          delete next[alias];
          repairs.push(`removed duplicate alias ${alias} for ${canonical}`);
          continue;
        }
        throw new ToolArgumentError(
          `Both ${canonical} and alias ${alias} were supplied with different values; keep only ${canonical}.`,
          { field: alias, suggestions: [canonical] },
        );
      }
      next[canonical] = next[alias]!;
      delete next[alias];
      repairs.push(`mapped ${alias} to ${canonical}`);
      break;
    }
  }

  for (const [key, property] of Object.entries(properties)) {
    if (!Object.hasOwn(next, key) || next[key] === undefined) continue;
    const value = next[key]!;
    if (!property || typeof property !== 'object' || Array.isArray(property)) continue;
    const spec = property as Record<string, Json>;
    const expected = typeof spec.type === 'string' ? spec.type : undefined;
    if (expected === 'boolean' && typeof value === 'string') {
      const lower = value.trim().toLocaleLowerCase('en-US');
      if (['true', 'yes', '1'].includes(lower)) { next[key] = true; repairs.push(`coerced ${key} to boolean`); }
      else if (['false', 'no', '0'].includes(lower)) { next[key] = false; repairs.push(`coerced ${key} to boolean`); }
    } else if ((expected === 'number' || expected === 'integer') && typeof value === 'string' && value.trim() !== '') {
      const number = Number(value);
      if (Number.isFinite(number) && (expected !== 'integer' || Number.isSafeInteger(number))) {
        next[key] = number;
        repairs.push(`coerced ${key} to ${expected}`);
      }
    } else if (expected === 'array' && typeof value === 'string') {
      next[key] = [value];
      repairs.push(`wrapped ${key} as a one-item array`);
    }
    if (typeof next[key] === 'string' && Array.isArray(spec.enum)) {
      const exact = spec.enum.find(item => item === next[key]);
      if (exact === undefined) {
        const matches = spec.enum.filter(item => typeof item === 'string'
          && item.toLocaleLowerCase('en-US') === String(next[key]).trim().toLocaleLowerCase('en-US'));
        if (matches.length === 1) {
          next[key] = matches[0]!;
          repairs.push(`normalized ${key} to enum value ${String(matches[0])}`);
        }
      }
    }
  }

  return { args: next, repaired: repairs.length > 0, repairs };
}

function withoutCodeFence(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json|javascript|js|text)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1]!.trim() : trimmed;
}

/** Extract a balanced object while ignoring braces inside JSON strings. */
function extractObject(value: string): string | null {
  const start = value.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return null;
}

function removeTrailingCommas(value: string): string {
  let result = '';
  let quote = '';
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; result += char; continue; }
    if (char === ',') {
      let next = index + 1;
      while (next < value.length && /\s/.test(value[next]!)) next += 1;
      if (value[next] === '}' || value[next] === ']') continue;
    }
    result += char;
  }
  return result;
}

/**
 * Parse model-produced arguments. Syntax repair is intentionally available
 * only for read-only tools; writes and external side effects must be retried
 * by the model after an explicit, corrected argument object.
 */
export function parseToolArguments(raw: string, context: Pick<ToolDiagnosticContext, 'toolName' | 'readOnly'>): ParsedToolArguments {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { args: {}, repaired: false, repairs: [] };
  const attempts: Array<{ value: string; note: string }> = [{ value: text, note: 'parsed JSON arguments' }];
  if (context.readOnly) {
    const fenced = withoutCodeFence(text);
    if (fenced !== text) attempts.push({ value: fenced, note: 'removed Markdown code fence' });
    const extracted = extractObject(fenced);
    if (extracted && extracted !== fenced) attempts.push({ value: extracted, note: 'extracted JSON object from surrounding prose' });
    for (const attempt of [...attempts]) {
      const repaired = removeTrailingCommas(attempt.value);
      if (repaired !== attempt.value) attempts.push({ value: repaired, note: 'removed trailing comma' });
    }
  }
  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt.value) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ToolArgumentError(
          `${context.toolName}: arguments must be one JSON object, received ${receivedType(parsed as Json)}.`,
          { field: '$', expected: 'object', received: receivedType(parsed as Json), suggestions: ['Send an object such as {"query":"..."}'] },
        );
      }
      const args = Object.fromEntries(Object.entries(parsed as Record<string, Json>));
      return { args, repaired: attempt !== attempts[0], repairs: attempt === attempts[0] ? [] : [attempt.note] };
    } catch (error) {
      lastError = error;
      if (error instanceof ToolArgumentError) throw error;
    }
  }
  const detail = safeError(lastError);
  throw new ToolArgumentError(
    `${context.toolName}: invalid JSON arguments${detail ? ` (${detail.slice(0, 240)})` : ''}.`,
    {
      field: '$',
      expected: 'JSON object',
      suggestions: [
        'Send valid JSON with double-quoted keys and no trailing comma.',
        context.readOnly ? 'Read-only arguments may be repaired automatically; this syntax could not be repaired safely.' : 'Writes are never repaired silently; send a corrected object.',
      ],
    },
  );
}

function normalizeForMatch(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/[\s_-]+/g, '');
}

export function diagnoseToolFailure(error: unknown, context: ToolDiagnosticContext): ToolFailureDiagnostic {
  if (error && typeof error === 'object' && 'diagnostic' in error) {
    const diagnostic = (error as { diagnostic?: ToolFailureDiagnostic }).diagnostic;
    if (diagnostic) return diagnostic;
  }
  const message = safeError(error);
  const lower = message.toLocaleLowerCase('en-US');
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
  let category: ToolFailureCategory = 'tool';
  let retryable = false;
  let suggestions: string[] = [];
  let field: string | undefined;
  let expected: string | undefined;
  let received: string | undefined;

  if (error instanceof UnknownToolError || /unknown tool|unsupported tool|tool .*not found/.test(lower)) {
    category = 'unknown_tool';
    suggestions = error instanceof UnknownToolError
      ? error.suggestions
      : suggestToolNames(context.toolName, context.availableTools);
  } else if (error instanceof ToolArgumentError || error instanceof ValidationError || /validation failed|schema|must be|required|additional propert/.test(lower)) {
    category = 'validation';
    if (error instanceof ToolArgumentError) {
      field = error.field;
      expected = error.expected;
      received = error.received;
      suggestions = error.suggestions.slice();
    }
  } else if (/not valid json|unexpected token|json at position|json.*syntax|invalid json/.test(lower)) {
    category = 'argument_json';
    suggestions = ['Send a JSON object with double-quoted keys and no trailing comma.', 'Do not wrap the object in prose or a Markdown fence.'];
  } else if (error instanceof Error && error.name === 'AbortError' || /tool cancelled|cancelled|aborted/.test(lower)) {
    category = 'cancelled';
  } else if (/timed? out|timeout/.test(lower) || code === 'ETIMEDOUT') {
    category = 'timeout';
    retryable = true;
    suggestions = [context.readOnly ? 'Retry once with the same arguments, or narrow the query.' : 'Do not repeat a write after a timeout; verify its result first.'];
  } else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EPIPE' || /fetch failed|network|socket hang up|econn|dns/.test(lower)) {
    category = 'network';
    retryable = true;
    suggestions = [context.readOnly ? 'Retry once after the transient network failure.' : 'Check whether the external action took effect before retrying.'];
  } else if (/429|rate limit|too many requests/.test(lower)) {
    category = 'rate_limit';
    retryable = true;
    suggestions = ['Wait for the provider retry window or switch to another read-only provider.'];
  } else if (/empty|no parsable results|no body|no response/.test(lower)) {
    category = 'empty_result';
    retryable = true;
    suggestions = ['Broaden or rewrite the query; do not treat an empty result as evidence.'];
  } else if (/permission|denied|forbidden|unauthorized|approval/.test(lower)) {
    category = 'permission';
    suggestions = ['Request the missing permission explicitly; never bypass the approval boundary.'];
  } else if (/not found|missing|does not exist|enoent/.test(lower)) {
    category = 'not_found';
    suggestions = ['Check the path/identifier with list_directory, discover_tools, or the relevant status tool before retrying.'];
  } else if (/conflict|drift|changed|stale|version/.test(lower)) {
    category = 'stale_state';
    suggestions = ['Re-read the current state and reconcile it before retrying; do not overwrite an unseen change.'];
  }

  const safeToRetry = context.readOnly && retryable;
  const hint = category === 'validation'
    ? `Correct the ${field ?? 'reported'} field according to the schema, then retry.`
    : safeToRetry
      ? 'This is a read-only operation; one bounded automatic retry is allowed.'
      : category === 'unknown_tool' && suggestions.length
        ? `Use one of the suggested tools: ${suggestions.join(', ')}.`
        : 'Do not blindly replay an operation with an unknown or side-effecting outcome.';

  return {
    category,
    message: message.slice(0, 600),
    retryable,
    safeToRetry,
    ...(field === undefined ? {} : { field }),
    ...(expected === undefined ? {} : { expected }),
    ...(received === undefined ? {} : { received }),
    suggestions,
    hint,
  };
}

export function diagnosticAsJson(diagnostic: ToolFailureDiagnostic): Json {
  return diagnostic as unknown as Json;
}
