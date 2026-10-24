export type RunStatus = 'queued' | 'running' | 'waiting_external' | 'waiting_approval' | 'paused' | 'retry_scheduled' | 'failed' | 'completed' | 'cancelled';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface TaskLimits { maxCalls?: number; maxWallMs?: number; maxCost?: number; maxTokens?: number; concurrency?: number }
export interface StepDefinition {
  id: string; kind: string; input?: Json; dependsOn?: string[]; sideEffect?: boolean;
  maxAttempts?: number; timeoutMs?: number;
}
export interface TaskDefinition { id?: string; name?: string; parentId?: string; steps: StepDefinition[]; limits?: TaskLimits }
export interface TaskRun {
  id: string; name: string; parentId: string | null; status: RunStatus; version: number;
  createdAt: number; updatedAt: number; limits: TaskLimits; calls: number; cost: number; tokens: number;
}
export interface StepRun extends StepDefinition {
  taskId: string; status: RunStatus; version: number; operationId: string; attempts: number;
  maxAttempts: number; timeoutMs: number; dependsOn: string[]; sideEffect: boolean;
  owner: string | null; fence: number; leaseUntil: number | null; dueAt: number | null;
  output?: Json; error: string | null;
}
export interface Lease { task: TaskRun; step: StepRun; owner: string; fence: number }
export interface RunEvent { sequence: number; taskId: string; stepId: string | null; type: string; version: 1; at: number; data: Json }
export interface Checkpoint { id: number; taskId: string; at: number; reason: string; snapshot: Json }
export interface ArtifactReference { id: string; path: string; sha256: string; bytes: number; mediaType?: string }
export interface Artifact extends ArtifactReference { taskId: string; stepId: string; createdAt: number }
export interface CompletionMetadata { cost?: number; tokens?: number; artifacts?: ArtifactReference[]; contextSnapshot?: string; configHashes?: Record<string, string> }
export interface ApprovalDecision { action: 'confirm_completed' | 'retry' | 'reject'; output?: Json }
export interface ActivityContext {
  task: TaskRun; step: StepRun; operationId: string; signal: AbortSignal; heartbeat: () => boolean;
}
export interface ActivityResult extends CompletionMetadata { output: Json }
export type ActivityHandler = (context: ActivityContext) => Promise<ActivityResult | Json>;
export interface FailureOptions { retryable?: boolean; definitive?: boolean; retryAfterMs?: number }
export class ConflictError extends Error { constructor(message = 'State changed or lease expired') { super(message); this.name = 'ConflictError'; } }
export class ValidationError extends Error { constructor(message: string) { super(message); this.name = 'ValidationError'; } }
