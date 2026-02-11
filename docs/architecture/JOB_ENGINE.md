# Job Engine Architecture

> Last updated: 2026-02-11

---

## Table of Contents

1. [Overview](#overview)
2. [Design Decisions](#design-decisions)
3. [Technical Details](#technical-details)
   - [Core Mechanism](#core-mechanism)
   - [Queue State Machine](#queue-state-machine)
   - [Job Types](#job-types)
   - [Lane Refresh Pipeline](#lane-refresh-pipeline)
   - [Coalescing Behavior](#coalescing-behavior)
   - [Failure Handling](#failure-handling)
4. [Integration Points](#integration-points)
5. [Implementation Status](#implementation-status)

---

## Overview

The Job Engine is ADE's background task scheduling system. It processes asynchronous work triggered by system events -- primarily terminal session endings and git HEAD changes -- ensuring that context packs remain current without blocking the user's interactive workflow.

The engine is deliberately simple in its current implementation: an in-process queue with per-lane deduplication. This simplicity is intentional. ADE's workload characteristics (infrequent triggers, short-duration jobs, single-machine execution) do not warrant the complexity of a full job framework. The design leaves room for future evolution toward more sophisticated scheduling as the Hosted Agent integration and conflict prediction features are added.

---

## Design Decisions

### Event-Driven Over Polling

Jobs are triggered by explicit events (session end, HEAD change) rather than periodic polling. This ensures:

- Zero unnecessary work when nothing has changed
- Immediate response when changes occur
- No wasted CPU cycles scanning for state changes
- Clear causal chain from trigger to result

### Per-Lane Coalescing

If a lane refresh job is already pending for a given lane, subsequent requests for the same lane replace the pending request rather than enqueuing a duplicate. This handles the common case where rapid successive events (multiple file saves triggering HEAD changes) would otherwise queue redundant pack refreshes.

### Fire-and-Forget From Callers

Event sources (PTY service, git service) enqueue jobs without waiting for completion. This prevents background pack generation from blocking terminal session teardown or git operation response times. The caller receives its response immediately; the pack will be refreshed asynchronously.

### Sequential Processing Per Lane

Jobs for a given lane execute sequentially (one at a time). This avoids race conditions in pack file generation where two concurrent refreshes for the same lane could produce inconsistent output. Different lanes can have concurrent jobs in the future, but the current implementation processes all jobs sequentially across the entire engine.

### Failures Are Logged, Not Propagated

Job failures are captured in the log but do not propagate back to the original event source. A failed pack refresh does not retroactively fail the terminal session that triggered it. This isolation ensures that background processing issues never degrade the user's interactive experience.

---

## Technical Details

### Core Mechanism

The job engine is implemented in `jobEngine.ts` and created via the `createJobEngine()` factory function:

```typescript
export function createJobEngine({
  logger,
  packService
}: {
  logger: Logger;
  packService: ReturnType<typeof createPackService>;
}) {
  const laneQueue = new Map<string, LaneQueueState>();
  // ...
  return { enqueueLaneRefresh, onSessionEnded, onHeadChanged };
}
```

The engine maintains a `Map<string, LaneQueueState>` keyed by lane ID. Each entry tracks whether a job is currently running for that lane and whether a subsequent request is pending.

### Queue State Machine

Each lane's queue follows a simple state machine:

```
                           ┌───────────┐
                           │   Idle    │
                           │ running=F │
                           │ pending=F │
                           └─────┬─────┘
                                 │ enqueue()
                                 v
                           ┌───────────┐
                    ┌─────>│ Processing│<─────┐
                    │      │ running=T │      │
                    │      │ pending=F │      │
                    │      └─────┬─────┘      │
                    │            │             │
                    │   job completes          │ enqueue() while processing
                    │   (no pending)           │ sets pending=T, next=req
                    │            │             │
                    │            v             │
                    │      ┌───────────┐      │
                    │      │   Idle    │      │
                    │      │ running=F │      │
                    │      │ pending=F │      │
                    │      └───────────┘      │
                    │                         │
                    │   job completes   ┌─────┴─────┐
                    │   (has pending)   │ Coalesced  │
                    └──────────────────│ running=T  │
                                       │ pending=T  │
                                       │ next=req   │
                                       └────────────┘
```

The `LaneQueueState` type:

```typescript
type LaneQueueState = {
  running: boolean;       // Is a job currently executing?
  pending: boolean;       // Is there a queued request?
  next: RefreshRequest | null;  // The queued request payload
};
```

The `RefreshRequest` type:

```typescript
type RefreshRequest = {
  laneId: string;
  reason: string;         // What triggered this refresh
  sessionId?: string;     // If triggered by session end
};
```

### Job Types

#### Implemented

| Job Type | Trigger | Action |
|----------|---------|--------|
| `RefreshLanePack` | Session end, HEAD change | Compute session delta, regenerate lane pack markdown, update project pack |

#### Planned

| Job Type | Trigger | Action |
|----------|---------|--------|
| `CreateCheckpoint` | Session end | Create immutable snapshot with SHA, diff stat, pack event IDs |
| `MaterializeProjectPack` | Lane pack update, config change | Rebuild project-level context pack |
| `MaterializeFeaturePack` | Lane pack update (feature-scoped) | Rebuild feature/issue-scoped pack |
| `MaterializeConflictPack` | Conflict prediction complete | Rebuild conflict resolution context |
| `PredictConflicts` | HEAD change, staged changes (debounced) | Run dry-merge simulation across lane pairs |
| `SyncToHostedMirror` | Pack update, checkpoint creation | Upload changed blobs and manifest to cloud |
| `RunAutomation` | User-defined trigger | Execute automation action script |

### Lane Refresh Pipeline

When a lane refresh is triggered, the engine executes two pack operations in sequence:

```
Event received (session end or HEAD change)
  |
  v
enqueueLaneRefresh({ laneId, reason, sessionId? })
  |
  v
runLaneRefresh(laneId)
  |
  ├── packService.refreshLanePack({ laneId, reason, sessionId })
  │     ├── computeSessionDelta() if sessionId provided
  │     ├── Build lane pack markdown body
  │     ├── Write to .ade/packs/lanes/<laneId>/lane_pack.md
  │     └── Upsert packs_index row
  │
  └── packService.refreshProjectPack({ reason, laneId })
        ├── Read project config
        ├── List all active lanes with status
        ├── Build project pack markdown body
        ├── Write to .ade/packs/project_pack.md
        └── Upsert packs_index row
```

The lane pack is always refreshed first because the project pack references lane summaries. Both operations are tracked as separate entries in the operations table.

The planned full pipeline (future implementation):

```
Session End
  --> CreateCheckpoint
  --> RefreshLanePack
  --> MaterializeProjectPack (if project pack stale)
  --> PredictConflicts
  --> SyncToHostedMirror (if hosted agent enabled)
```

### Coalescing Behavior

The coalescing mechanism ensures that only the most recent request is processed when multiple events arrive while a job is running:

```typescript
const enqueueLaneRefresh = (request: RefreshRequest) => {
  const state = ensureState(request.laneId);
  state.pending = true;
  state.next = request;        // Overwrites any previous pending request
  void runLaneRefresh(request.laneId);
};
```

**Example scenario**:

1. Session A ends for lane X --> enqueue refresh (reason: "session_end", sessionId: A)
2. Job starts processing
3. User runs git commit in lane X --> enqueue refresh (reason: "commit")
4. Previous pending request is replaced with new one
5. Job completes processing request from step 1
6. Job picks up request from step 3 (step 3 effectively replaced any earlier pending)
7. Job processes commit-triggered refresh
8. Queue is empty, lane returns to idle

This means that in rapid-fire scenarios, intermediate events may be skipped. This is acceptable because:
- Pack generation always reads the current state (not the state at trigger time)
- The final refresh captures the cumulative result of all intermediate changes
- Session deltas are computed independently and stored in the database

**Planned coalescing rules** (future):

| Scope | Coalesce Key | Behavior |
|-------|-------------|----------|
| Per-lane | `lane_id` | Latest request wins (current behavior) |
| Per-feature | `feature_id` | Latest request per feature wins |
| Per-project | `project_id` | Global singleton (one at a time) |
| Conflict prediction | `project_id` | Global singleton (covers all lanes) |

### Failure Handling

Current failure handling is minimal but safe:

```typescript
try {
  await packService.refreshLanePack({ ... });
  await packService.refreshProjectPack({ ... });
  logger.info("jobs.refresh_lane.done", payload);
} catch (error) {
  logger.error("jobs.refresh_lane.failed", {
    ...payload,
    error: error instanceof Error ? error.message : String(error)
  });
}
```

**Current behavior**:
- Failed jobs are logged with error details
- The queue state is properly reset (running = false)
- No automatic retry
- Subsequent triggers will attempt the refresh again naturally

**Planned failure handling** (future):
- Configurable retry with exponential backoff (max 3 retries)
- Retry delay: 1s, 4s, 16s (exponential with base 4)
- Dead letter logging for jobs that fail all retries
- Health monitoring: alert if job failure rate exceeds threshold
- Circuit breaker: temporarily disable a job type if it fails repeatedly

**Planned realtime conflict pass** (future):
- Triggered by staged or dirty changes (debounced by 2 seconds)
- Lightweight comparison against known peer lane states
- Updates lane conflict indicators without running full dry-merge
- Does not require sequential processing (can run concurrently with pack refresh)

---

## Integration Points

### Event Sources (Upstream)

| Source | Event | Handler |
|--------|-------|---------|
| PTY Service | Session ended | `jobEngine.onSessionEnded({ laneId, sessionId })` |
| Git Operations Service | HEAD SHA changed | `jobEngine.onHeadChanged({ laneId, reason })` |

Both event sources call the job engine from within their own service callbacks. The PTY service fires `onSessionEnded` after recording the session end in the database. The git service fires `onHeadChanged` after the operation tracking wrapper detects that the HEAD SHA changed.

### Job Executors (Downstream)

| Executor | Job Type | Operation |
|----------|----------|-----------|
| Pack Service | `RefreshLanePack` | `packService.refreshLanePack()` |
| Pack Service | `RefreshProjectPack` | `packService.refreshProjectPack()` |

### Wiring in main.ts

The job engine is wired into the event flow during service initialization:

```typescript
const jobEngine = createJobEngine({ logger, packService });

const ptyService = createPtyService({
  // ...
  onSessionEnded: ({ laneId, sessionId }) => {
    jobEngine.onSessionEnded({ laneId, sessionId });
  },
  // ...
});

const gitService = createGitOperationsService({
  // ...
  onHeadChanged: ({ laneId, reason }) => {
    jobEngine.onHeadChanged({ laneId, reason });
  }
});
```

### Future Integration Points

| Service | Direction | Purpose |
|---------|-----------|---------|
| Hosted Agent Service | Downstream | `SyncToHostedMirror` job pushes pack snapshots to cloud |
| Conflict Prediction Service | Downstream | `PredictConflicts` job runs dry-merge simulations |
| Automation Service | Downstream | `RunAutomation` job executes user-defined scripts |
| Checkpoint Service | Downstream | `CreateCheckpoint` job creates immutable snapshots |
| IPC (Renderer) | Upstream | Manual refresh triggers from the UI |

---

## Implementation Status

### Completed

- Job engine factory (`createJobEngine`) with dependency injection
- Per-lane queue with `Map<string, LaneQueueState>` structure
- Coalescing logic (latest request replaces pending request)
- Sequential execution per lane (no concurrent jobs for same lane)
- `onSessionEnded` handler for PTY session end events
- `onHeadChanged` handler for git operation HEAD changes
- Lane pack + project pack refresh pipeline
- Structured error logging for failed jobs
- Integration wiring in `main.ts`

### Not Yet Implemented

- **Retry logic**: Exponential backoff with configurable max retries
- **Dead letter logging**: Persistent record of permanently failed jobs
- **Job priority**: Some jobs (conflict prediction) should be lower priority than pack refresh
- **Concurrent lane processing**: Currently all jobs are serialized per lane; different lanes could process concurrently
- **Job cancellation**: Ability to cancel a running job (e.g., when switching projects)
- **Job metrics**: Tracking execution time, success rate, queue depth
- **Checkpoint jobs**: `CreateCheckpoint` at session boundaries
- **Feature/conflict pack materialization**: `MaterializeFeaturePack`, `MaterializeConflictPack`
- **Conflict prediction jobs**: `PredictConflicts` with dry-merge simulation
- **Hosted sync jobs**: `SyncToHostedMirror` for cloud agent integration
- **Automation jobs**: `RunAutomation` for user-defined triggers
- **Debounced triggers**: Rate-limiting for high-frequency events (staged changes)
- **Health monitoring**: Alerting on elevated failure rates
