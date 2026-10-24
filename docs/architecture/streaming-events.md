# SuWen Streaming Event Protocol v1 (frozen 2026-10-25, round 3)

This document is the single source of truth for the incremental event stream that drives the
chat UI during model / tool / research runs. Daemon, Electron main, preload and renderer must
agree on this contract. Additive changes bump `schemaVersion`; removing or renaming fields is
forbidden.

## Transport

1. Daemon exposes a **main-process-only** RPC method `events.stream`:

   ```
   request : { since?: number, limit?: number }        // since = last seen global sequence, default 0
   response: {
     schemaVersion: 1,
     cursor: number,                 // highest sequence covered by this response (may equal since)
     reset?: true,                   // true only when the daemon restarted or cursor is invalid
     tasks: TaskSummary[],           // lightweight task state for every task touched since `since`
     events: Envelope[],             // ordered by sequence ascending
     streams: StreamSnapshot[]       // live buffers for running model steps (latest text, append-only)
   }
   ```

   `limit` defaults to 500, max 2000. `since` greater than the current max sequence yields an
   empty response with `reset:true` and `cursor=0`.

2. Electron main polls `events.stream` while a window exists (target 100 ms, backoff to 500 ms
   when idle) and forwards each non-empty response to the renderer on channel `suwen:events`.
   The cursor is held in main-process memory. If the daemon dies, main reconnects automatically
   with bounded exponential backoff (300 ms → 12 s), re-pushes the encrypted model config and
   credential refs, and notifies the renderer via `window.suwen.onConnection(handler)` with
   `{ state: 'reconnecting' | 'restored' | 'lost', at }`. On a restart with a fresh database the
   cursor is reset and a response with `reset:true` is forwarded.
3. Renderer obtains events through `window.suwen.onEvent(handler) -> unsubscribe`. The callback
   receives the response object above. Gap replay uses the main bridge
   `window.suwen.call('events.replay', { since: last, limit: 2000 })`, which returns the same
   response shape; `events.stream` itself stays main-process-only. The renderer keeps `snapshot`
   polling only as a slow (>= 2 s) reconciliation fallback; it must never be the primary
   streaming source.

## Types

```
TaskSummary  = { taskId, status, version, updatedAt }
StreamSnapshot = { taskId, stepId?, text, updatedAt }
Envelope = {
  schemaVersion: 1,
  eventId: string,        // stable; currently `e:<global sequence>` (globally unique)
  sequence: number,       // global monotonically increasing event sequence
  taskId: string,
  stepId?: string,
  type: EventType,        // protocol type, see mapping below
  sourceType: string,     // raw persisted store event type (diagnostics)
  at: number,             // epoch ms
  payload: object         // event data as persisted (redacted at write time)
}
```

## Event types and mapping

`type` is a protocol-level name; `sourceType` keeps the persisted name.

| protocol type | source store type | meaning |
|---|---|---|
| `run.queued` | `task.created` | task accepted; not running yet |
| `step.started` | `step.claimed` | a step was claimed by the worker (model call begins for model steps) |
| `step.completed` | `step.completed` | step finished successfully |
| `step.failed` | `step.failed` | step attempt failed (payload includes error/retryable) |
| `step.retry_scheduled` | `step.retry_scheduled` | retry with backoff scheduled |
| `step.reconciliation_required` | `step.reconciliation_required` | side-effect outcome unknown; needs human decision |
| `approval.requested` | `step.waiting_approval` | run paused for human approval |
| `approval.resolved` | `approval.resolved` | human decision recorded |
| `run.paused` | `task.paused` | paused by user |
| `run.resumed` | `task.resumed` | resumed |
| `run.completed` | `task.completed` | terminal success |
| `run.failed` | `task.failed` | terminal failure |
| `run.cancelled` | `task.cancelled` | terminal cancellation |
| `context.compaction.started` | `context.compaction.started` | compaction in progress (if emitted) |
| `context.compaction.completed` | `context.compaction.completed` | compaction finished (if emitted) |
| `connection.reset` | (synthetic) | response reset flag is surfaced as an event by the renderer |

Unknown source types pass through with `type = sourceType` so new daemon events remain
observable without a renderer release.

## Stream buffers (text deltas)

Model activities append text to an in-memory per-task buffer. A `StreamSnapshot` carries the
**full current text** for that task's active model step; it is append-only within a step and
replaced when a new step starts. Renderer rules:

1. Compare with the last known text for the same `taskId/stepId`.
   - If new text starts with old text: emit `message.delta` with the suffix (never drop chars).
   - If not (new step, retry, restart): replace and emit `message.reset`.
2. Never call `requestAnimationFrame` per token; merge deltas and paint at most once per frame
   (typical 16–50 ms budget). Characters must never be dropped by throttling.
3. Text is UTF-16 safe only if the renderer appends whole suffixes. The daemon never splits a
   JS string incorrectly; suffix appends are safe.

## Ordering, duplicates, cancellation

1. Renderer deduplicates by `eventId` (bounded LRU, 10k ids).
2. Per task, `sequence` must be strictly increasing. Older/duplicate envelopes are ignored; a
   gap (`sequence > last+1`) triggers a single `events.replay {since:last}` request via the main
   bridge (`window.suwen.call('events.replay', {since:last})`) and a UI notice; it must not render
   out of order.
3. Late events for a terminal run (`run.completed/failed/cancelled` seen for that task) are
   ignored by message and status reducers; the terminal state is immutable until a new run id.
4. Two concurrent runs are isolated by `taskId`; streams and envelopes are keyed by task. Text
   must never move between conversations.
5. After reconnect (`reset:true` or `connection.reset`), drop per-run caches and rebuild from
   snapshot + replay; drafts in the composer are preserved client-side.

## Run state machine (renderer)

`idle -> connecting -> preparing -> streaming -> tool_running -> waiting_approval -> compacting
-> reconnecting -> paused -> cancelling -> completed | failed | cancelled`

Transitions are driven by the task status + protocol events. Exactly one banner state is shown
at a time; contradictory combinations are a defect (see defect register).

## Test requirements

- Deterministic reducer tests with 100 / 1,000 / 10,000 deltas: 0 lost, 0 duplicated, 0
  reordered characters; Unicode and surrogate-pair chunks included.
- Replay tests: duplicate envelopes ignored; out-of-order ignored; gap triggers one replay;
  `reset:true` rebuilds; cancel-then-late-delta performs 0 writes.
- UI E2E: composer bounding box deviation < 1 px during a 500-delta stream; draft preserved;
  scroll intent respected; two parallel runs isolated; daemon kill + reconnect restores text.
