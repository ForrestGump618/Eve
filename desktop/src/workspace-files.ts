import { realpath, stat, readdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, basename, join, normalize } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ValidationError, type Json } from './harness/types.js';

const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * Path repair thresholds live in one policy object so the resolver can be
 * tightened per deployment without scattering magic numbers through the tool.
 */
export const WORKSPACE_PATH_POLICY = Object.freeze({
  maxEntries: 2_500,
  maxDepth: 10,
  maxSuggestions: 6,
  readMinSimilarity: 0.72,
  writeMinSimilarity: 0.96,
  uniqueConfidenceMargin: 0.08,
});

export interface WorkspacePathResolution {
  requested: string;
  normalized: string;
  path: string | null;
  corrected: boolean;
  confidence: number;
  suggestions: string[];
  reason: 'resolved' | 'missing' | 'ambiguous' | 'outside';
}

interface Candidate {
  path: string;
  confidence: number;
  exact: boolean;
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

function slurpQuoted(value: string): string {
  let text = value.trim();
  const pairs: Array<[string, string]> = [
    ['"', '"'], ["'", "'"], ['`', '`'], ['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'],
  ];
  for (const [open, close] of pairs) {
    if (text.startsWith(open) && text.endsWith(close) && text.length > 1) {
      text = text.slice(open.length, -close.length).trim();
      break;
    }
  }
  return text;
}

/** Normalize common copy/paste mistakes without guessing the file itself. */
export function normalizeWorkspacePath(value: string): string {
  let text = value.normalize('NFKC').trim();
  if (text === '.' || text === './' || text === '.\\' || text === '..' || text === '../' || text === '..\\') return text;
  // Strip terminal punctuation before quotes so “path”。 and "path", both
  // become the same request. The quote pass then removes the paired wrapper.
  text = text.replace(/[.,;:!?，。；：！？、]+$/u, '').trim();
  text = slurpQuoted(text);
  if (/^file:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      text = decodeURIComponent(url.pathname);
      if (/^\/[A-Za-z]:\//.test(text)) text = text.slice(1);
    } catch { /* keep the original and let the resolver report it */ }
  }
  text = text
    .replace(/\uFF3C/g, '\\')
    .replace(/\uFF0F/g, '/')
    .replace(/\uFE68/g, '\\')
    .replace(/\uFE5F/g, '/')
    .replace(/\uFF1A/g, ':')
    .replace(/\uFF5E/g, '~')
    .replace(/[.,;:!?，。；：！？、]+$/u, '')
    .trim();
  return text;
}

function comparisonPath(value: string): string {
  return normalize(value.replaceAll('\\', '/')).toLocaleLowerCase('en-US');
}

function relativeRequest(root: string, requested: string): string | null {
  if (requested === '.' || requested === './' || requested === '.\\') return '';
  if (!isAbsolute(requested)) return comparisonPath(requested);
  const rel = relative(root, requested);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? comparisonPath(rel) : null;
}

function scoreCandidate(requested: string, root: string, candidate: string): { confidence: number; exact: boolean } {
  const requestedRelative = relativeRequest(root, requested);
  const candidateRelative = comparisonPath(relative(root, candidate));
  if (requestedRelative === null) {
    const requestedBase = comparisonPath(basename(requested));
    const candidateBase = comparisonPath(basename(candidate));
    const baseScore = requestedBase === candidateBase ? 0.91 : similarity(requestedBase, candidateBase) * 0.9;
    return { confidence: baseScore, exact: requestedBase === candidateBase };
  }
  if (requestedRelative === candidateRelative) return { confidence: 1, exact: true };
  const requestedBase = comparisonPath(basename(requestedRelative));
  const candidateBase = comparisonPath(basename(candidateRelative));
  if (requestedBase === candidateBase) {
    return { confidence: candidateRelative.endsWith(`/${requestedBase}`) ? 0.95 : 0.9, exact: false };
  }
  const whole = similarity(requestedRelative, candidateRelative);
  const base = similarity(requestedBase, candidateBase);
  return { confidence: Math.max(whole * 0.88, base * 0.78), exact: false };
}

export class WorkspaceFiles {
  constructor(readonly roots: string[], readonly files: string[]) {}

  /**
   * Resolve a requested path without accessing it. Read operations may recover a
   * unique case/separator/typo mismatch; writes only recover deterministic
   * case or root-relative mismatches and never guess a different file.
   */
  async resolve(wanted: string, options: { write?: boolean; signal?: AbortSignal } = {}): Promise<WorkspacePathResolution> {
    const requested = String(wanted ?? '');
    const normalized = normalizeWorkspacePath(requested);
    if (!normalized || normalized.includes('\0')) {
      return { requested, normalized, path: null, corrected: false, confidence: 0, suggestions: [], reason: 'missing' };
    }
    options.signal?.throwIfAborted();
    const rootAliases = new Map<string, string>();
    const roots = (await Promise.all(this.roots.map(async root => {
      const canonical = await realpath(root).catch(() => '');
      if (canonical) rootAliases.set(canonical, resolve(root));
      return canonical;
    }))).filter(Boolean);
    const absoluteOutside = isAbsolute(normalized)
      && !roots.some(root => inside(root, resolve(normalized)));
    const admittedFiles = options.write
      ? []
      : (await Promise.all(this.files.map(file => realpath(file).catch(() => '')))).filter(Boolean);
    if (!roots.length && !admittedFiles.length) {
      return { requested, normalized, path: null, corrected: false, confidence: 0, suggestions: [], reason: absoluteOutside ? 'outside' : 'missing' };
    }
    const candidates: Candidate[] = [];
    const visiblePath = (path: string): string => {
      const root = roots.find(item => inside(item, path));
      const original = root ? rootAliases.get(root) : undefined;
      return root && original ? join(original, relative(root, path)) : path;
    };
    const add = async (candidate: string): Promise<void> => {
      try {
        const canonical = await realpath(candidate);
        const root = roots.find(item => inside(item, canonical));
        if (!root && (options.write || !admittedFiles.includes(canonical))) return;
        const scored = scoreCandidate(normalized, root ?? roots[0]!, canonical);
        candidates.push({ path: canonical, ...scored });
      } catch {
        if (!options.write) return;
        const parent = await realpath(dirname(candidate)).catch(() => null);
        if (!parent || !roots.some(root => inside(root, parent))) return;
        const target = join(parent, basename(candidate));
        const scored = scoreCandidate(normalized, roots.find(root => inside(root, target)) ?? roots[0]!, target);
        candidates.push({ path: target, ...scored });
      }
    };

    const direct = isAbsolute(normalized) ? [normalized] : roots.map(root => resolve(root, normalized));
    for (const candidate of direct) await add(candidate);
    if (!options.write) {
      for (const file of this.files) {
        const canonical = await realpath(file).catch(() => '');
        if (canonical && (
          comparisonPath(canonical) === comparisonPath(normalized)
          || comparisonPath(basename(canonical)) === comparisonPath(normalized)
          || comparisonPath(basename(canonical)) === comparisonPath(basename(normalized))
        )) candidates.push({ path: canonical, confidence: 1, exact: true });
      }
    }

    const exact = candidates.find(candidate => candidate.exact && candidate.confidence >= 0.99);
    if (exact) {
      return {
        requested,
        normalized,
        path: visiblePath(exact.path),
        corrected: comparisonPath(exact.path) !== comparisonPath(normalized) && comparisonPath(basename(exact.path)) !== comparisonPath(basename(normalized)),
        confidence: exact.confidence,
        suggestions: [],
        reason: 'resolved',
      };
    }

    if (candidates.length === 0 && !options.write) {
      // Bounded traversal is only used for reads. It never follows symlinks and
      // never expands the selected roots.
      const queue: Array<{ path: string; depth: number }> = roots.map(root => ({ path: root, depth: 0 }));
      let visited = 0;
      while (queue.length && visited < WORKSPACE_PATH_POLICY.maxEntries) {
        options.signal?.throwIfAborted();
        const current = queue.shift()!;
        if (current.depth > WORKSPACE_PATH_POLICY.maxDepth) continue;
        let entries;
        try { entries = await readdir(current.path, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          if (visited >= WORKSPACE_PATH_POLICY.maxEntries) break;
          if (entry.isSymbolicLink()) continue;
          visited += 1;
          const path = join(current.path, entry.name);
          const scored = scoreCandidate(normalized, roots.find(root => inside(root, path)) ?? roots[0]!, path);
          if (scored.confidence >= WORKSPACE_PATH_POLICY.readMinSimilarity) candidates.push({ path, ...scored });
          if (entry.isDirectory()) queue.push({ path, depth: current.depth + 1 });
        }
      }
    }

    const threshold = options.write ? WORKSPACE_PATH_POLICY.writeMinSimilarity : WORKSPACE_PATH_POLICY.readMinSimilarity;
    const ranked = [...new Map(candidates
      .filter(candidate => candidate.confidence >= threshold)
      .sort((left, right) => right.confidence - left.confidence || left.path.localeCompare(right.path))
      .map(candidate => [candidate.path, candidate])).values()];
    const suggestions = ranked.slice(0, WORKSPACE_PATH_POLICY.maxSuggestions).map(candidate => visiblePath(candidate.path));
    const top = ranked[0];
    if (!top) {
      return { requested, normalized, path: null, corrected: false, confidence: 0, suggestions: [], reason: absoluteOutside ? 'outside' : 'missing' };
    }
    const second = ranked[1];
    const unique = !second || top.confidence >= 0.99 || top.confidence - second.confidence >= WORKSPACE_PATH_POLICY.uniqueConfidenceMargin;
    if (!unique) {
      return { requested, normalized, path: null, corrected: false, confidence: top.confidence, suggestions, reason: 'ambiguous' };
    }
    return {
      requested,
      normalized,
      path: visiblePath(top.path),
      corrected: comparisonPath(top.path) !== comparisonPath(normalized),
      confidence: top.confidence,
      suggestions: ranked.slice(1, WORKSPACE_PATH_POLICY.maxSuggestions + 1).map(candidate => visiblePath(candidate.path)),
      reason: 'resolved',
    };
  }

  async path(wanted: string, write = false, signal?: AbortSignal): Promise<string> {
    const resolution = await this.resolve(wanted, { write, ...(signal ? { signal } : {}) });
    if (resolution.path) return resolution.path;
    const suggestions = resolution.suggestions.length
      ? ` Candidates: ${resolution.suggestions.slice(0, WORKSPACE_PATH_POLICY.maxSuggestions).join(' | ')}`
      : '';
    const guidance = write
      ? ' Writes require one exact workspace-relative path; no fuzzy write destination is chosen.'
      : ' Use resolve_path or list_directory to inspect candidates, then retry the closest valid path.';
    throw new ValidationError(`Path ${resolution.reason}: ${JSON.stringify(wanted)}.${suggestions}${guidance}`);
  }

  async list(wanted = '.', offset = 0, signal?: AbortSignal): Promise<Json> {
    const path = await this.path(wanted, false, signal);
    const info = await stat(path);
    if (!info.isDirectory()) throw new ValidationError('Not a directory');
    const entries = (await readdir(path, { withFileTypes: true }))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    return {
      path,
      requested: wanted,
      total: entries.length,
      offset,
      nextOffset: offset + 200 < entries.length ? offset + 200 : null,
      entries: entries.slice(offset, offset + 200).map(entry => ({
        name: entry.name,
        type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file',
      })),
    };
  }

  async read(wanted: string, start = 1, limit = 400, signal?: AbortSignal): Promise<Json> {
    const path = await this.path(wanted, false, signal);
    const info = await stat(path);
    if (!info.isFile() || info.size > 20_000_000) throw new ValidationError('Read supports text files up to 20 MB');
    const bytes = await readFile(path);
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (content.includes('\0')) throw Error();
    } catch {
      throw new ValidationError('Binary file: use a document-specific skill instead of reading as UTF-8');
    }
    const lines = content.split(/\r?\n/), selected: string[] = [];
    let chars = 0;
    for (const line of lines.slice(start - 1, start - 1 + limit)) {
      if (selected.length && chars + line.length > 28000) break;
      selected.push(line);
      chars += line.length + 1;
    }
    const text = selected.join('\n'), clipped = text.length > 28000;
    return {
      path,
      requested: wanted,
      bytes: bytes.length,
      sha256: digest(bytes),
      startLine: start,
      endLine: start + selected.length - 1,
      totalLines: lines.length,
      content: text.slice(0, 28000),
      truncated: clipped || start - 1 + selected.length < lines.length,
      nextStartLine: !clipped && start - 1 + selected.length < lines.length ? start + selected.length : null,
    };
  }

  async search(query: string, wanted = '.', signal?: AbortSignal): Promise<Json> {
    const root = await this.path(wanted, false, signal);
    const matches: Json[] = [], queue = [root];
    let visited = 0, limited = false;
    while (queue.length && visited < 600 && matches.length < 80) {
      signal?.throwIfAborted();
      const path = await this.path(queue.shift()!, false, signal);
      visited++;
      const info = await stat(path);
      if (info.isDirectory()) {
        for (const entry of await readdir(path, { withFileTypes: true })) {
          if (entry.isSymbolicLink() || ['.git', 'node_modules', '.venv', '__pycache__'].includes(entry.name)) continue;
          if (queue.length + visited >= 600) { limited = true; break; }
          const full = join(path, entry.name);
          if (entry.isDirectory() || entry.isFile()) queue.push(full);
        }
      } else {
        if (info.size > 1_000_000) continue;
        const bytes = await readFile(path);
        if (bytes.includes(0)) continue;
        const lines = bytes.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length && matches.length < 80; i++) {
          if (lines[i]!.toLocaleLowerCase().includes(query.toLocaleLowerCase())) {
            matches.push({ path, line: i + 1, text: lines[i]!.slice(0, 400) });
          }
        }
      }
    }
    limited = limited || queue.length > 0 || matches.length >= 80;
    return { query, visited, limited, matches };
  }

  async write(wanted: string, content: string, expectedSha256?: string): Promise<Json> {
    const path = await this.path(wanted, true);
    let previous: Buffer | null = null;
    try { previous = await readFile(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (previous && digest(previous) !== expectedSha256) {
      throw new ValidationError('Read the existing file first and supply its matching expectedSha256 before replacing it');
    }
    if (!previous && expectedSha256) throw new ValidationError('Expected existing file does not exist');
    const tmp = join(dirname(path), `.suwen-${randomUUID()}.tmp`);
    try {
      await writeFile(tmp, content, { encoding: 'utf8', flag: 'wx' });
      await rename(tmp, path);
    } finally {
      await unlink(tmp).catch(() => {});
    }
    const confirmed = await readFile(path);
    if (!confirmed.equals(Buffer.from(content, 'utf8'))) {
      throw new ValidationError('File read-back verification failed after write; inspect the current file before retrying');
    }
    return { path, requested: wanted, bytes: Buffer.byteLength(content), sha256: digest(content), created: !previous, verified: true };
  }
}

/** Resolve common copied-path mistakes while still requiring an existing file. */
export async function userFileGrants(prompt: string): Promise<string[]> {
  const candidates = [
    ...prompt.matchAll(/(?:[A-Za-z]:[\\/]|\\\\)[^\n"'<>|]*?\.[a-zA-Z0-9]{1,10}(?=[\s"'”’」，。；）)]|$)/g),
  ].map(match => normalizeWorkspacePath(match[0]));
  const grants = await Promise.all(candidates.map(async path => {
    const canonical = await realpath(path).catch(() => '');
    // Keep the user-facing lexical path for grants. WorkspaceFiles performs a
    // second canonical containment check; returning a Windows 8.3 realpath
    // here would make the same file appear under two identities.
    return canonical && (await stat(canonical).then(info => info.isFile()).catch(() => false)) ? resolve(path) : null;
  }));
  return [...new Set(grants.filter((path): path is string => Boolean(path)))];
}
