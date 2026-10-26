import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { ApprovalDecision, Artifact, Checkpoint, CompletionMetadata, ConflictError, FailureOptions, Json, Lease, RunEvent, RunStatus, StepRun, TaskDefinition, TaskRun, ValidationError } from './types.js';
import type { PutRecordOptions, RecordRow } from '../shared/contract.js';
import { normalizeConversation } from '../conversations.js';

const SCHEMA_VERSION = 3;
const terminal = new Set<RunStatus>(['completed', 'failed', 'cancelled']);
type Row = Record<string, any>;
export interface StoreOptions { now?: () => number; maxTasks?: number; retryBaseMs?: number; random?: () => number }
function redact(value: any): Json {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k,
    typeof v==='number'&&/^(?:tokens|maxTokens|reservedTokens|inputTokens|outputTokens|totalTokens|prompt_tokens|completion_tokens|total_tokens|beforeTokens|afterTokens)$/i.test(k)
      ? v : /token|secret|password|authorization|api.?key/i.test(k) ? '[REDACTED]' : redact(v)]));
  if (typeof value === 'string') return value.replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]').replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
  return value === undefined ? null : value;
}
function validNumber(n: unknown, name: string, min = 1): void { if (typeof n !== 'number' || !Number.isFinite(n) || n < min) throw new ValidationError(`${name} must be >= ${min}`); }
function assertJson(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || depth > 128 || ancestors.has(value)) throw new ValidationError('Value must be finite, acyclic JSON with nesting <=128');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new ValidationError('Value must be plain JSON');
  ancestors.add(value); for (const child of Object.values(value)) assertJson(child, ancestors, depth + 1); ancestors.delete(value);
}

/** Local single-machine durable state store. Every mutation uses a write transaction. */
export class Store {
  readonly db: DatabaseSync;
  private readonly clock: () => number;
  private readonly options: StoreOptions;
  constructor(readonly path: string, options: StoreOptions = {}) {
    this.options = options; this.clock = options.now ?? Date.now;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const existed = path !== ':memory:' && existsSync(path);
    this.db = new DatabaseSync(path);
    try {
      const version = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
      if (version > SCHEMA_VERSION) throw new ValidationError(`Database schema ${version} is newer than supported ${SCHEMA_VERSION}`);
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      const integrity = this.db.prepare('PRAGMA quick_check').get() as Row;
      if (integrity.quick_check !== 'ok') throw new Error(`Database integrity check failed: ${integrity.quick_check}`);
      if (version < SCHEMA_VERSION) {
        if (existed && path !== ':memory:') {
          const backup = `${path}.pre-v${SCHEMA_VERSION}-${Date.now()}-${randomUUID()}.bak`;
          this.db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
        }
        this.tx(() => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY,name TEXT NOT NULL,parent_id TEXT REFERENCES tasks(id),status TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,limits_json TEXT NOT NULL,calls INTEGER NOT NULL DEFAULT 0,cost REAL NOT NULL DEFAULT 0,tokens INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS steps (task_id TEXT NOT NULL REFERENCES tasks(id),id TEXT NOT NULL,kind TEXT NOT NULL,input_json TEXT NOT NULL,dependencies_json TEXT NOT NULL,side_effect INTEGER NOT NULL,max_attempts INTEGER NOT NULL,timeout_ms INTEGER NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,operation_id TEXT NOT NULL UNIQUE,attempts INTEGER NOT NULL DEFAULT 0,owner TEXT,fence INTEGER NOT NULL DEFAULT 0,lease_until INTEGER,due_at INTEGER,output_json TEXT,error TEXT,prior_status TEXT,PRIMARY KEY(task_id,id));
            CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL REFERENCES tasks(id),step_id TEXT,type TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,at INTEGER NOT NULL,data_json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS checkpoints (id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL REFERENCES tasks(id),at INTEGER NOT NULL,reason TEXT NOT NULL,snapshot_json TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS outbox (operation_id TEXT PRIMARY KEY REFERENCES steps(operation_id),status TEXT NOT NULL,updated_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),step_id TEXT NOT NULL,path TEXT NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,media_type TEXT,created_at INTEGER NOT NULL,FOREIGN KEY(task_id,step_id) REFERENCES steps(task_id,id));
            CREATE INDEX IF NOT EXISTS steps_schedule ON steps(status,due_at,lease_until);
            CREATE INDEX IF NOT EXISTS event_task ON events(task_id,sequence);
            CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY,kind TEXT NOT NULL,data_json TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,provenance_json TEXT,project_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS records_kind ON records(kind,updated_at DESC);
            CREATE INDEX IF NOT EXISTS records_project ON records(project_id,kind,updated_at DESC);
            PRAGMA user_version=3;
          `);
        });
      }
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  now(): number { return this.clock(); }

  /** Generic versioned records (projects, conversations, evidence, skills, channels, RSI, ...). */
  private record(row: Row): RecordRow {
    return { id: row.id, kind: row.kind, version: row.version, data: JSON.parse(row.data_json), provenance: row.provenance_json === null ? null : JSON.parse(row.provenance_json), projectId: row.project_id ?? null, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  private recordProjectId(data: Json, requested: string | null | undefined): string | null {
    if (requested !== undefined) {
      if (requested !== null && (typeof requested !== 'string' || requested.length < 1 || requested.length > 200)) throw new ValidationError('projectId must be null or a string <= 200 chars');
      return requested;
    }
    if (data && typeof data === 'object' && !Array.isArray(data) && typeof (data as Record<string, Json>).projectId === 'string') return (data as Record<string, Json>).projectId as string;
    return null;
  }
  putRecord(kind: string, data: Json, options: PutRecordOptions = {}): RecordRow {
    if (typeof kind !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(kind)) throw new ValidationError('kind must be a short identifier');
    assertJson(data);
    const storedData: Json = redact(data);
    if (options.provenance !== undefined) assertJson(options.provenance);
    const provenance: Json = options.provenance === undefined ? null : redact(options.provenance);
    const projectId = this.recordProjectId(storedData, options.projectId);
    const projected = projectId === null ? null : projectId;
    const at = this.now();
    const dataJson = JSON.stringify(storedData);
    const provenanceJson = provenance === null ? null : JSON.stringify(provenance);
    return this.tx(() => {
      if (options.id !== undefined && (typeof options.id !== 'string' || options.id.length < 1 || options.id.length > 200)) throw new ValidationError('id must be a string <= 200 chars');
      const existing = options.id === undefined ? undefined : this.db.prepare('SELECT * FROM records WHERE id=?').get(options.id) as Row | undefined;
      if (existing) {
        if (typeof options.expectedVersion === 'number' && options.expectedVersion !== existing.version) throw new ConflictError('Record version mismatch');
        this.db.prepare('UPDATE records SET data_json=?,version=version+1,provenance_json=?,project_id=?,updated_at=? WHERE id=?').run(dataJson, provenanceJson, projected, at, options.id!);
        return this.record(this.db.prepare('SELECT * FROM records WHERE id=?').get(options.id!) as Row);
      }
      if (typeof options.expectedVersion === 'number' && options.expectedVersion !== 0) throw new ConflictError('Record version mismatch');
      const id = options.id ?? randomUUID();
      this.db.prepare('INSERT INTO records(id,kind,data_json,version,provenance_json,project_id,created_at,updated_at) VALUES(?,?,?,1,?,?,?,?)').run(id, kind, dataJson, provenanceJson, projected, at, at);
      return this.record(this.db.prepare('SELECT * FROM records WHERE id=?').get(id) as Row);
    });
  }
  getRecord(id: string): RecordRow | undefined {
    if (typeof id !== 'string' || id.length < 1) throw new ValidationError('id must be a non-empty string');
    const row = this.db.prepare('SELECT * FROM records WHERE id=?').get(id) as Row | undefined;
    return row && this.record(row);
  }
  listRecords(kind: string, options: { projectId?: string | null; limit?: number; offset?: number; order?: 'asc' | 'desc' } = {}): RecordRow[] {
    if (typeof kind !== 'string' || kind.length < 1) throw new ValidationError('kind must be a non-empty string');
    const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 100)), 500);
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const direction = options.order === 'asc' ? 'ASC' : 'DESC';
    const params: Array<string | number> = [kind];
    let sql = 'SELECT * FROM records WHERE kind=?';
    if (options.projectId !== undefined) {
      if (options.projectId === null) sql += ' AND project_id IS NULL';
      else { sql += ' AND project_id=?'; params.push(options.projectId); }
    }
    sql += ` ORDER BY updated_at ${direction}, rowid ${direction} LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    return (this.db.prepare(sql).all(...params) as Row[]).map(r => this.record(r));
  }
  countRecords(kind: string, options: { projectId?: string | null } = {}): number {
    if (typeof kind !== 'string' || kind.length < 1) throw new ValidationError('kind must be a non-empty string');
    const params: Array<string> = [kind];
    let sql = 'SELECT COUNT(*) AS n FROM records WHERE kind=?';
    if (options.projectId !== undefined) {
      if (options.projectId === null) sql += ' AND project_id IS NULL';
      else { sql += ' AND project_id=?'; params.push(options.projectId); }
    }
    return Number((this.db.prepare(sql).get(...params) as Row).n);
  }
  deleteRecord(id: string, expectedVersion?: number): void {
    if (typeof id !== 'string' || id.length < 1) throw new ValidationError('id must be a non-empty string');
    this.tx(() => {
      const existing = this.db.prepare('SELECT version FROM records WHERE id=?').get(id) as Row | undefined;
      if (!existing) throw new ValidationError('Record not found');
      if (typeof expectedVersion === 'number' && expectedVersion !== existing.version) throw new ConflictError('Record version mismatch');
      this.db.prepare('DELETE FROM records WHERE id=?').run(id);
    });
  }
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private event(taskId: string, stepId: string | null, type: string, data: unknown = {}): void {
    this.db.prepare('INSERT INTO events(task_id,step_id,type,at,data_json) VALUES(?,?,?,?,?)').run(taskId, stepId, type, this.now(), JSON.stringify(redact(data)));
  }
  private task(row: Row): TaskRun { return { id: row.id, name: row.name, parentId: row.parent_id, status: row.status, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, limits: JSON.parse(row.limits_json), calls: row.calls, cost: row.cost, tokens: row.tokens }; }
  private step(row: Row): StepRun { return { taskId: row.task_id, id: row.id, kind: row.kind, input: JSON.parse(row.input_json), dependsOn: JSON.parse(row.dependencies_json), sideEffect: !!row.side_effect, maxAttempts: row.max_attempts, timeoutMs: row.timeout_ms, status: row.status, version: row.version, operationId: row.operation_id, attempts: row.attempts, owner: row.owner, fence: row.fence, leaseUntil: row.lease_until, dueAt: row.due_at, output: row.output_json === null ? undefined : JSON.parse(row.output_json), error: row.error }; }
  getTask(id: string): TaskRun | undefined { const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Row | undefined; return row && this.task(row); }
  listTasks(): TaskRun[] { return (this.db.prepare('SELECT * FROM tasks ORDER BY created_at,rowid').all() as Row[]).map(r => this.task(r)); }
  /** Cheap idle probe: avoid opening write transactions when every task is settled. */
  hasPendingWork(): boolean {
    const row = this.db.prepare(`SELECT 1 AS pending
      FROM steps s JOIN tasks t ON t.id=s.task_id
      WHERE t.status NOT IN ('completed','failed','cancelled','paused','waiting_approval')
        AND s.status IN ('queued','running','retry_scheduled','waiting_external')
      LIMIT 1`).get() as Row | undefined;
    return row !== undefined;
  }
  private runnableTasks(): TaskRun[] {return (this.db.prepare("SELECT * FROM tasks WHERE status NOT IN ('completed','failed','cancelled','paused') ORDER BY created_at,rowid").all() as Row[]).map(r=>this.task(r));}
  getSteps(taskId: string): StepRun[] { return (this.db.prepare('SELECT * FROM steps WHERE task_id=? ORDER BY rowid').all(taskId) as Row[]).map(r => this.step(r)); }
  getStep(taskId: string, stepId: string): StepRun | undefined { const row = this.db.prepare('SELECT * FROM steps WHERE task_id=? AND id=?').get(taskId, stepId) as Row | undefined; return row && this.step(row); }
  events(taskId: string, after = 0): RunEvent[] { return (this.db.prepare('SELECT * FROM events WHERE task_id=? AND sequence>? ORDER BY sequence').all(taskId, after) as Row[]).map(r => ({ sequence: r.sequence, taskId: r.task_id, stepId: r.step_id, type: r.type, version: 1, at: r.at, data: JSON.parse(r.data_json) })); }
  /** Global ordered event window used by the streaming protocol (docs/architecture/streaming-events.md). */
  eventsSince(after = 0, limit = 500): RunEvent[] {
    const capped = Math.max(1, Math.min(2000, Math.floor(limit)));
    return (this.db.prepare('SELECT * FROM events WHERE sequence>? ORDER BY sequence LIMIT ?').all(after, capped) as Row[]).map(r => ({ sequence: r.sequence, taskId: r.task_id, stepId: r.step_id, type: r.type, version: 1, at: r.at, data: JSON.parse(r.data_json) }));
  }
  maxEventSequence(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS seq FROM events').get() as { seq: number };
    return row.seq;
  }
  checkpoints(taskId: string): Checkpoint[] { return (this.db.prepare('SELECT * FROM checkpoints WHERE task_id=? ORDER BY id').all(taskId) as Row[]).map(r => ({ id: r.id, taskId: r.task_id, at: r.at, reason: r.reason, snapshot: JSON.parse(r.snapshot_json) })); }
  artifacts(taskId: string): Artifact[] { return (this.db.prepare('SELECT * FROM artifacts WHERE task_id=? ORDER BY created_at,rowid').all(taskId) as Row[]).map(r => ({ id: r.id, taskId: r.task_id, stepId: r.step_id, path: r.path, sha256: r.sha256, bytes: r.bytes, mediaType: r.media_type ?? undefined, createdAt: r.created_at })); }
  private checkpoint(taskId: string, reason: string, metadata?: CompletionMetadata): void {
    this.db.prepare('INSERT INTO checkpoints(task_id,at,reason,snapshot_json) VALUES(?,?,?,?)').run(taskId, this.now(), reason, JSON.stringify({ task: this.getTask(taskId), steps: this.getSteps(taskId), artifacts: this.artifacts(taskId), contextSnapshot: metadata?.contextSnapshot, configHashes: metadata?.configHashes }));
  }
  createTask(def: TaskDefinition): TaskRun {
    if (!Array.isArray(def.steps) || !def.steps.length || def.steps.length > 10000) throw new ValidationError('A task requires 1 to 10000 steps');
    const ids = new Set<string>();
    for (const s of def.steps) {
      if (!s.id || !s.kind || ids.has(s.id)) throw new ValidationError('Step IDs must be unique and kinds nonempty');
      assertJson(s.input ?? null);
      ids.add(s.id); validNumber(s.maxAttempts ?? 3, 'maxAttempts'); validNumber(s.timeoutMs ?? 60000, 'timeoutMs');
      if (!Number.isInteger(s.maxAttempts ?? 3)) throw new ValidationError('maxAttempts must be an integer');
    }
    // Kahn validation avoids recursion/stack exhaustion on long research DAGs.
    const degrees = new Map<string, number>(); const dependents = new Map<string, string[]>();
    for (const s of def.steps) {
      const deps = s.dependsOn ?? []; if (!Array.isArray(deps) || new Set(deps).size !== deps.length) throw new ValidationError('Dependencies must be a unique array');
      degrees.set(s.id, deps.length);
      for (const dependency of deps) {
        if (!ids.has(dependency)) throw new ValidationError(`Unknown dependency ${dependency}`);
        const edges = dependents.get(dependency) ?? []; edges.push(s.id); dependents.set(dependency, edges);
      }
    }
    const ready = [...degrees].filter(([, degree]) => degree === 0).map(([id]) => id);
    for (let i = 0; i < ready.length; i++) for (const next of dependents.get(ready[i]) ?? []) { const remaining = degrees.get(next)! - 1; degrees.set(next, remaining); if (!remaining) ready.push(next); }
    if (ready.length !== ids.size) throw new ValidationError('DAG contains a cycle');
    for (const [k, v] of Object.entries(def.limits ?? {})) {
      validNumber(v, k, k === 'maxCost' || k === 'maxTokens' ? 0 : 1);
      if (['maxCalls', 'maxTokens', 'concurrency'].includes(k) && !Number.isInteger(v)) throw new ValidationError(`${k} must be an integer`);
    }
    const id = def.id ?? randomUUID();
    return this.tx(() => {
      const count = Number((this.db.prepare("SELECT count(*) AS n FROM tasks WHERE status NOT IN ('completed','failed','cancelled')").get() as Row).n);
      if (count >= (this.options.maxTasks ?? 1000)) throw new ValidationError('Active task limit reached');
      if (def.parentId) { const parent = this.getTask(def.parentId); if (!parent || terminal.has(parent.status) || parent.status === 'paused') throw new ValidationError('Parent task must be active'); }
      this.db.prepare('INSERT INTO tasks(id,name,parent_id,status,created_at,updated_at,limits_json) VALUES(?,?,?,?,?,?,?)').run(id, def.name ?? id, def.parentId ?? null, 'queued', this.now(), this.now(), JSON.stringify(def.limits ?? {}));
      const insert = this.db.prepare('INSERT INTO steps(task_id,id,kind,input_json,dependencies_json,side_effect,max_attempts,timeout_ms,status,operation_id) VALUES(?,?,?,?,?,?,?,?,?,?)');
      for (const s of def.steps) insert.run(id, s.id, s.kind, JSON.stringify(s.input ?? null), JSON.stringify(s.dependsOn ?? []), Number(s.sideEffect ?? false), s.maxAttempts ?? 3, s.timeoutMs ?? 60000, 'queued', createHash('sha256').update(JSON.stringify([id, s.id])).digest('hex'));
      this.event(id, null, 'task.created', { stepCount: def.steps.length }); this.checkpoint(id, 'created'); return this.getTask(id)!;
    });
  }
  private touch(taskId: string, status?: RunStatus): void {
    if (status) this.db.prepare('UPDATE tasks SET status=?,version=version+1,updated_at=? WHERE id=?').run(status, this.now(), taskId);
    else this.db.prepare('UPDATE tasks SET version=version+1,updated_at=? WHERE id=?').run(this.now(), taskId);
  }
  private refresh(taskId: string): void {
    const task = this.getTask(taskId)!; if (terminal.has(task.status) || task.status === 'paused') return;
    let steps = this.getSteps(taskId);
    if (steps.some(s => s.status === 'failed')) {
      // A failed branch stops sibling work. In-flight unsafe outcomes remain actionable.
      for (const s of steps) {
        if (s.status === 'running' && s.sideEffect) this.toApproval(s, 'Sibling branch failed; external result unknown');
        else if (!terminal.has(s.status) && s.status !== 'waiting_approval') this.db.prepare("UPDATE steps SET status='cancelled',owner=NULL,lease_until=NULL,fence=fence+1,version=version+1 WHERE task_id=? AND id=?").run(taskId, s.id);
      }
      steps = this.getSteps(taskId);
    }
    const status: RunStatus = steps.every(s => s.status === 'completed') ? 'completed' : steps.some(s => s.status === 'failed') ? (steps.some(s => s.status === 'waiting_approval') ? 'waiting_approval' : 'failed') : steps.some(s => s.status === 'running') ? 'running' : steps.some(s => s.status === 'waiting_approval') ? 'waiting_approval' : steps.some(s => s.status === 'queued') ? 'queued' : steps.some(s => s.status === 'retry_scheduled') ? 'retry_scheduled' : 'waiting_external';
    this.touch(taskId, status);
    if (terminal.has(status)) { this.event(taskId, null, `task.${status}`); this.checkpoint(taskId, status); }
  }
  private budgetError(task: TaskRun): string | undefined {
    if (task.limits.maxWallMs !== undefined && this.now() - task.createdAt >= task.limits.maxWallMs) return 'Task wall-time budget exhausted';
    if (task.limits.maxCalls !== undefined && task.calls >= task.limits.maxCalls) return 'Task call budget exhausted';
    if (task.limits.maxCost !== undefined && task.cost >= task.limits.maxCost) return 'Task cost budget exhausted';
    if (task.limits.maxTokens !== undefined && task.tokens >= task.limits.maxTokens) return 'Task token budget exhausted';
    return undefined;
  }
  /** Atomically chooses a ready DAG node and assigns a strictly increasing fence. */
  claim(owner: string, leaseMs = 30000, canRun?: (step: StepRun, task: TaskRun) => boolean): Lease | undefined {
    if (!owner) throw new ValidationError('Lease owner is required'); validNumber(leaseMs, 'leaseMs');
    return this.tx(() => {
      for (const task of this.runnableTasks()) {
        if (terminal.has(task.status) || task.status === 'paused') continue;
        const steps = this.getSteps(task.id); const running = steps.filter(s => s.status === 'running').length;
        if (running >= (task.limits.concurrency ?? 4)) continue;
        for (const s of steps) {
          if (!(['queued', 'retry_scheduled', 'waiting_external'] as RunStatus[]).includes(s.status) || (s.dueAt !== null && s.dueAt > this.now())) continue;
          if (!s.dependsOn.every(d => steps.find(x => x.id === d)?.status === 'completed')) continue;
          if (canRun && !canRun(s, task)) continue;
          // A fired durable timer commits without rerunning its activity or consuming another call.
          if (s.kind === 'delay' && s.status === 'waiting_external') {
            this.db.prepare("UPDATE steps SET status='completed',version=version+1,output_json=?,due_at=NULL WHERE task_id=? AND id=?").run(JSON.stringify({ elapsed: true }), task.id, s.id);
            s.status = 'completed'; this.event(task.id, s.id, 'timer.fired'); this.refresh(task.id); this.checkpoint(task.id, 'timer.fired'); continue;
          }
          const error = this.budgetError(this.getTask(task.id)!);
          if (error) {
            // A reserved final call may still be running. Let it finish before failing
            // unstarted nodes; reaching the admission ceiling does not revoke that call.
            if (running > 0 && error !== 'Task wall-time budget exhausted') break;
            this.failTaskBudget(task.id, error); break;
          }
          if (s.attempts >= s.maxAttempts) { this.db.prepare("UPDATE steps SET status='failed',error=?,version=version+1 WHERE task_id=? AND id=?").run('Retry budget exhausted', task.id, s.id); this.refresh(task.id); break; }
          const until = this.now() + Math.min(leaseMs, s.timeoutMs);
          const result = this.db.prepare("UPDATE steps SET status='running',version=version+1,attempts=attempts+1,owner=?,fence=fence+1,lease_until=?,due_at=NULL,error=NULL WHERE task_id=? AND id=? AND version=?").run(owner, until, task.id, s.id, s.version);
          if (Number(result.changes) !== 1) continue;
          this.db.prepare("UPDATE tasks SET status='running',version=version+1,calls=calls+1,updated_at=? WHERE id=?").run(this.now(), task.id);
          if (s.sideEffect) this.db.prepare("INSERT INTO outbox(operation_id,status,updated_at) VALUES(?,'dispatched',?) ON CONFLICT(operation_id) DO UPDATE SET status='dispatched',updated_at=excluded.updated_at").run(s.operationId, this.now());
          const current = this.getStep(task.id, s.id)!; this.event(task.id, s.id, 'step.claimed', { owner, fence: current.fence, operationId: s.operationId, attempt: current.attempts });
          return { task: this.getTask(task.id)!, step: current, owner, fence: current.fence };
        }
      }
      return undefined;
    });
  }
  private failTaskBudget(taskId: string, error: string): void {
    for (const s of this.getSteps(taskId)) if (s.sideEffect && s.status === 'running') this.toApproval(s, `Budget exhausted; external result unknown: ${error}`);
    this.db.prepare("UPDATE steps SET status='failed',error=?,owner=NULL,lease_until=NULL,fence=fence+1,version=version+1 WHERE task_id=? AND status NOT IN ('completed','failed','cancelled','waiting_approval')").run(error, taskId);
    this.touch(taskId, this.getSteps(taskId).some(s => s.status === 'waiting_approval') ? 'waiting_approval' : 'failed'); this.event(taskId, null, 'task.budget_exhausted', { error }); this.checkpoint(taskId, 'budget_exhausted');
  }
  private requireLease(lease: Lease): StepRun {
    const step = this.getStep(lease.task.id, lease.step.id); const task = this.getTask(lease.task.id);
    if (!step || !task || terminal.has(task.status) || task.status === 'paused' || step.status !== 'running' || step.owner !== lease.owner || step.fence !== lease.fence || step.leaseUntil === null || step.leaseUntil <= this.now()) throw new ConflictError();
    return step;
  }
  isLeaseValid(lease: Lease): boolean { try { this.requireLease(lease); return true; } catch { return false; } }
  /** Fenced per-turn accounting and trace events inside a durable model activity.
   * The first model call uses the activity's existing call reservation. */
  activityProgress(taskId:string, step:StepRun, type:string, data:Json, usage:{call?:boolean;tokens?:number;artifact?:Artifact}={}):void {
    this.tx(()=>{
      const task=this.getTask(taskId);if(!task)throw new ConflictError();
      this.requireLease({task,step,owner:step.owner!,fence:step.fence});
      if(usage.call&&task.limits.maxCalls!==undefined&&task.calls>=task.limits.maxCalls)throw new ValidationError('Task call budget exhausted');
      const tokens=usage.tokens??0;validNumber(tokens,'tokens',0);
      this.db.prepare('UPDATE tasks SET calls=calls+?,tokens=tokens+? WHERE id=?').run(usage.call?1:0,tokens,taskId);
      if(usage.artifact){const a=usage.artifact;this.db.prepare('INSERT INTO artifacts(id,task_id,step_id,path,sha256,bytes,media_type,created_at) VALUES(?,?,?,?,?,?,?,?)').run(a.id,taskId,step.id,a.path,a.sha256,a.bytes,a.mediaType??null,this.now());}
      this.event(taskId,step.id,type,data);
    });
  }
  heartbeat(lease: Lease, leaseMs = 30000): boolean {
    return this.tx(() => { const s = this.requireLease(lease); this.db.prepare('UPDATE steps SET lease_until=?,version=version+1 WHERE task_id=? AND id=?').run(this.now() + Math.min(leaseMs, s.timeoutMs), s.taskId, s.id); this.event(s.taskId, s.id, 'step.heartbeat', { fence: s.fence }); return true; });
  }
  complete(lease: Lease, output: Json, usage: CompletionMetadata = {}): void {
    assertJson(output);
    validNumber(usage.cost ?? 0, 'cost', 0); validNumber(usage.tokens ?? 0, 'tokens', 0);
    this.tx(() => {
      const s = this.requireLease(lease);
      for (const artifact of usage.artifacts ?? []) {
        if (!artifact.id || !artifact.path || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) throw new ValidationError('Artifact requires ID, path and SHA256');
        validNumber(artifact.bytes, 'artifact.bytes', 0);
        this.db.prepare('INSERT INTO artifacts(id,task_id,step_id,path,sha256,bytes,media_type,created_at) VALUES(?,?,?,?,?,?,?,?)').run(artifact.id, s.taskId, s.id, artifact.path, artifact.sha256, artifact.bytes, artifact.mediaType ?? null, this.now());
      }
      this.db.prepare("UPDATE steps SET status='completed',output_json=?,owner=NULL,lease_until=NULL,version=version+1 WHERE task_id=? AND id=?").run(JSON.stringify(output), s.taskId, s.id);
      // Mirror only after a fenced completion, in the same transaction. A late
      // model reply after pause/cancel can never append a successful transcript.
      const conversationId=s.kind==='model'&&s.input&&typeof s.input==='object'&&!Array.isArray(s.input)?s.input.conversationId:undefined;
      if(typeof conversationId==='string'&&output&&typeof output==='object'&&!Array.isArray(output)&&typeof output.text==='string'&&output.text.trim()){
        const record=this.getRecord(conversationId);
        if(record?.kind==='conversation'){
          const view=normalizeConversation(record.data),id=`a-${s.operationId}`.slice(0,100);
          if(view.messages.length<4000&&!view.messages.some(m=>m.id===id)){
            view.messages.push({id,role:'assistant',text:output.text.slice(0,100000),at:this.now(),taskId:s.taskId});view.updatedAt=this.now();
            this.db.prepare('UPDATE records SET data_json=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify(redact(view)),this.now(),record.id);
          }
        }
      }
      this.db.prepare('UPDATE tasks SET cost=cost+?,tokens=tokens+? WHERE id=?').run(usage.cost ?? 0, usage.tokens ?? 0, s.taskId);
      if (s.sideEffect) this.db.prepare("UPDATE outbox SET status='confirmed',updated_at=? WHERE operation_id=?").run(this.now(), s.operationId);
      this.event(s.taskId, s.id, 'step.completed', { operationId: s.operationId, usage }); this.refresh(s.taskId); this.checkpoint(s.taskId, 'step.completed', usage);
    });
  }
  /** Persist a timer; the engine releases all activity resources until it is due. */
  defer(lease: Lease, delayMs: number): void {
    validNumber(delayMs, 'delayMs', 0);
    this.tx(() => { const s = this.requireLease(lease); this.db.prepare("UPDATE steps SET status='waiting_external',due_at=?,owner=NULL,lease_until=NULL,version=version+1 WHERE task_id=? AND id=?").run(this.now() + delayMs, s.taskId, s.id); this.event(s.taskId, s.id, 'timer.scheduled', { dueAt: this.now() + delayMs }); this.refresh(s.taskId); this.checkpoint(s.taskId, 'timer.scheduled'); });
  }
  waitForApproval(lease: Lease, reason = 'Approval required'): void { this.tx(() => { const s = this.requireLease(lease); this.toApproval(s, reason); this.refresh(s.taskId); this.checkpoint(s.taskId, 'waiting_approval'); }); }
  private toApproval(s: StepRun, reason: string): void {
    reason = String(redact(reason));
    this.db.prepare("UPDATE steps SET status='waiting_approval',error=?,owner=NULL,lease_until=NULL,fence=fence+1,version=version+1 WHERE task_id=? AND id=?").run(reason, s.taskId, s.id);
    if (s.sideEffect) this.db.prepare("UPDATE outbox SET status='unknown',updated_at=? WHERE operation_id=?").run(this.now(), s.operationId);
    this.event(s.taskId, s.id, 'step.reconciliation_required', { reason, operationId: s.operationId });
  }
  fail(lease: Lease, error: unknown, options: FailureOptions = {}): void {
    if (options.retryAfterMs !== undefined) validNumber(options.retryAfterMs, 'retryAfterMs', 0);
    this.tx(() => { const s = this.requireLease(lease); this.failure(s, error instanceof Error ? error.message : String(error), options); this.refresh(s.taskId); this.checkpoint(s.taskId, 'step.failed'); });
  }
  private failure(s: StepRun, error: string, options: FailureOptions): void {
    error = String(redact(error));
    if (s.sideEffect && !options.definitive) { this.toApproval(s, `External result unknown: ${error}`); return; }
    const retry = options.retryable !== false && s.attempts < s.maxAttempts;
    const delay = options.retryAfterMs ?? Math.min(60000, (this.options.retryBaseMs ?? 1000) * 2 ** Math.min(s.attempts - 1, 10)) * (0.75 + (this.options.random ?? Math.random)() * 0.5);
    this.db.prepare('UPDATE steps SET status=?,error=?,due_at=?,owner=NULL,lease_until=NULL,fence=fence+1,version=version+1 WHERE task_id=? AND id=?').run(retry ? 'retry_scheduled' : 'failed', error, retry ? this.now() + Math.ceil(delay) : null, s.taskId, s.id);
    this.event(s.taskId, s.id, retry ? 'step.retry_scheduled' : 'step.failed', { error, attempt: s.attempts, dueAt: retry ? this.now() + Math.ceil(delay) : null });
  }
  reclaimExpired(): number {
    return this.tx(() => {
      const rows = this.db.prepare("SELECT s.* FROM steps s JOIN tasks t ON t.id=s.task_id WHERE s.status='running' AND s.lease_until<=? AND t.status NOT IN ('paused','cancelled','completed','failed')").all(this.now()) as Row[];
      for (const row of rows) { const s = this.step(row); this.failure(s, 'Lease expired; worker lost', {}); this.refresh(s.taskId); this.checkpoint(s.taskId, 'lease.reclaimed'); }
      // Wall time is enforced even while a task waits on a timer or approval.
      for (const t of this.runnableTasks()) if (t.limits.maxWallMs !== undefined && this.now() - t.createdAt >= t.limits.maxWallMs && !this.db.prepare("SELECT 1 FROM events WHERE task_id=? AND type='task.budget_exhausted' LIMIT 1").get(t.id)) this.failTaskBudget(t.id, 'Task wall-time budget exhausted');
      return rows.length;
    });
  }
  resolveApproval(taskId: string, stepId: string, decision: ApprovalDecision, expectedVersion?: number): void {
    if (!decision || typeof decision !== 'object' || Array.isArray(decision) || !['confirm_completed', 'retry', 'reject'].includes(decision.action)) throw new ValidationError('Approval action must be confirm_completed, retry, or reject');
    if (decision.action === 'confirm_completed' && decision.output !== undefined) assertJson(decision.output);
    this.tx(() => {
      const task = this.getTask(taskId); const s = this.getStep(taskId, stepId);
      if (!task || !s || terminal.has(task.status) || s.status !== 'waiting_approval' || (expectedVersion !== undefined && expectedVersion !== s.version)) throw new ConflictError();
      if (decision.action === 'retry' && s.attempts >= s.maxAttempts) throw new ValidationError('Retry budget exhausted');
      if (decision.action === 'retry' && this.budgetError(task)) throw new ValidationError(this.budgetError(task)!);
      const status = decision.action === 'confirm_completed' ? 'completed' : decision.action === 'retry' ? 'queued' : 'failed';
      this.db.prepare('UPDATE steps SET status=?,output_json=?,error=NULL,due_at=NULL,fence=fence+1,version=version+1 WHERE task_id=? AND id=?').run(status, decision.action === 'confirm_completed' ? JSON.stringify(decision.output ?? null) : null, taskId, stepId);
      if (s.sideEffect) this.db.prepare('UPDATE outbox SET status=?,updated_at=? WHERE operation_id=?').run(decision.action === 'confirm_completed' ? 'confirmed' : decision.action === 'retry' ? 'approved_retry' : 'rejected', this.now(), s.operationId);
      this.event(taskId, stepId, 'approval.resolved', { action: decision.action }); this.refresh(taskId); this.checkpoint(taskId, 'approval.resolved');
    });
  }
  pauseTask(taskId: string, expectedVersion?: number): void { this.control(taskId, 'paused', expectedVersion); }
  cancelTask(taskId: string, expectedVersion?: number): void { this.control(taskId, 'cancelled', expectedVersion); }
  private control(taskId: string, status: 'paused' | 'cancelled', expectedVersion?: number): void {
    this.tx(() => { this.controlInside(taskId, status, expectedVersion); });
  }
  private controlInside(taskId: string, status: 'paused' | 'cancelled', expectedVersion?: number): void {
    const task = this.getTask(taskId); if (!task || terminal.has(task.status) || (expectedVersion !== undefined && expectedVersion !== task.version)) throw new ConflictError();
    for (const s of this.getSteps(taskId)) {
      if (terminal.has(s.status)) continue;
      if (s.status === 'running' && s.sideEffect) this.toApproval(s, `${status}: external result must be reconciled`);
      if (status === 'cancelled') this.db.prepare("UPDATE steps SET status='cancelled',owner=NULL,lease_until=NULL,fence=fence+1,version=version+1 WHERE task_id=? AND id=?").run(taskId, s.id);
      else if (s.status !== 'waiting_approval' && !(s.status === 'running' && s.sideEffect)) this.db.prepare("UPDATE steps SET prior_status=?,status='paused',owner=NULL,lease_until=NULL,fence=fence+1,version=version+1 WHERE task_id=? AND id=?").run(s.status === 'running' ? 'queued' : s.status, taskId, s.id);
    }
    this.touch(taskId, status); this.event(taskId, null, `task.${status}`); this.checkpoint(taskId, status);
    for (const child of this.listTasks().filter(t => t.parentId === taskId && !terminal.has(t.status))) this.controlInside(child.id, status);
  }
  resumeTask(taskId: string, expectedVersion?: number): void {
    this.tx(() => { this.resumeInside(taskId, expectedVersion); });
  }
  private resumeInside(taskId: string, expectedVersion?: number): void {
    const task = this.getTask(taskId); if (!task || task.status !== 'paused' || (expectedVersion !== undefined && expectedVersion !== task.version)) throw new ConflictError();
    this.db.prepare("UPDATE steps SET status=COALESCE(prior_status,'queued'),prior_status=NULL,version=version+1 WHERE task_id=? AND status='paused'").run(taskId);
    this.touch(taskId, 'queued'); this.refresh(taskId); this.event(taskId, null, 'task.resumed'); this.checkpoint(taskId, 'resumed');
    for (const child of this.listTasks().filter(t => t.parentId === taskId && t.status === 'paused')) this.resumeInside(child.id);
  }
}
