# Job Engine Architecture

> Roadmap reference: `docs/final-plan.md` is the canonical future plan and sequencing source.

> Last updated: 2026-02-19

---

## Table of Contents

1. [Overview](#overview)
2. [Design Decisions](#design-decisions)
3. [Technical Details](#technical-details)
   - [Core Mechanism](#core-mechanism)
   - [Queue State Machine](#queue-state-machine)
   - [Job Types](#job-types)
   - [Lane Refresh Pipeline](#lane-refresh-pipeline)
   - [Auto-Narrative Generation](#auto-narrative-generation)
   - [Conflict Prediction Queue](#conflict-prediction-queue)
   - [Coalescing Behavior](#coalescing-behavior)
   - [Failure Handling](#failure-handling)
4. [Integration Points](#integration-points)
5. [Implementation Status](#implementation-status)

---

## Overview

The Job Engine is ADE's background task scheduling system. It processes asynchronous work triggered by system events -- terminal session endings, git HEAD changes, and lane dirty state changes -- ensuring that context packs remain current and conflict predictions stay fresh without blocking the user's interactive workflow.

The engine is an in-process queue with per-lane deduplication for pack refreshes and a debounced conflict prediction queue. After each deterministic pack refresh, the engine optionally triggers AI narrative generation (via Hosted or BYOK providers) in a non-blocking async flow. Conflict prediction runs on a debounced schedule (900ms-1500ms depending on trigger type) plus a periodic 120-second interval.

Phase 1.5 introduces a separate orchestrator runtime service for mission step scheduling/execution state machines. The job engine remains focused on background context maintenance (packs, narratives, conflict prediction) and does not coordinate orchestrator step transitions.

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

### AI Is Advisory In This Pipeline

The deterministic portion of the queue (lane/project pack refresh, checkpoint derivation, conflict prediction scheduling) is code-driven. AI calls are bounded post-processing steps (narrative augmentation) and never become the scheduler or state-machine authority.

---

## Technical Details

### Core Mechanism

The job engine is implemented in `jobEngine.ts` and created via the `createJobEngine()` factory function:

```typescript
export function createJobEngine({
  logger,
  packService,
  conflictService,
  hostedAgentService,
  projectConfigService,
  byokLlmService
}: {
  logger: Logger;
  packService: ReturnType<typeof createPackService>;
  conflictService?: ReturnType<typeof createConflictService>;
  hostedAgentService?: ReturnType<typeof createHostedAgentService>;
  projectConfigService?: ReturnType<typeof createProjectConfigService>;
  byokLlmService?: ReturnType<typeof createByokLlmService>;
}) {
  const laneQueue = new Map<string, LaneQueueState>();
  const dirtyLaneQueue = new Set<string>();
  // ...
  return {
    enqueueLaneRefresh,
    onSessionEnded,
    onHeadChanged,
    onLaneDirtyChanged,
    runConflictPredictionNow,
    dispose
  };
}
```

The engine maintains:
- A `Map<string, LaneQueueState>` keyed by lane ID for pack refresh coalescing.
- A `Set<string>` (`dirtyLaneQueue`) for debounced conflict prediction.
- A periodic conflict prediction timer (every 120 seconds).
- Optional references to `conflictService`, `hostedAgentService`, `projectConfigService`, and `byokLlmService` for auto-narrative generation and conflict prediction.

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
| `AutoNarrative` | After `RefreshLanePack` (when AI provider is configured) | Generate AI narrative via Hosted or BYOK, apply via marker-based replacement |
| `PredictConflicts` | HEAD change, lane dirty change (debounced 900-1500ms), periodic (120s) | Run dry-merge simulation across lane pairs via conflictService |
| `RunAutomation` | User-defined trigger (HEAD change, manual, etc.) | Execute automation action scripts via automationService (Phase 8) |

#### Not Yet Implemented

| Job Type | Trigger | Action |
|----------|---------|--------|
| `SyncToHostedMirror` | Pack update, checkpoint creation | Upload changed blobs and manifest to cloud |

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

### Auto-Narrative Generation

After the deterministic lane+project pack refresh completes, the job engine checks `projectConfigService` for the active provider mode. If the mode is not `guest`, the engine fires an async (non-blocking) narrative generation flow:

1. Build a `LaneExportStandard` and `ProjectExportLite` from the pack service.
2. Clip and redact both exports (lane: 220K chars max, project: 120K chars max).
3. Assemble a `projectContext` payload including the project export, pack key refs, omission metadata, and assumption flags.
4. For `hosted` mode: call `hostedAgentService.requestLaneNarrative()` with callbacks for job submission and status updates.
5. For `byok` mode: call `byokLlmService.generateLaneNarrative()` with the combined lane+project export body.
6. Apply the returned narrative via `packService.applyHostedNarrative()` with metadata (jobId, timing, provider, model).
7. Record `narrative_requested` and `narrative_failed` pack events for telemetry.

The narrative flow runs in a detached `void (async () => { ... })()` so it does not block the lane refresh completion.

### Conflict Prediction Queue

The job engine manages a separate debounced conflict prediction queue:

- `dirtyLaneQueue: Set<string>` — lanes that need per-lane prediction.
- `fullConflictPredictionQueued: boolean` — when true, runs a full project-wide prediction instead of per-lane.
- **Debounce**: Conflict prediction requests are debounced with configurable delay (default 1200ms for session events, 1500ms for HEAD changes, 900ms for dirty changes).
- **Periodic**: A `setInterval` timer runs full conflict prediction every 120 seconds.
- **Initial**: On engine creation, a full prediction is queued with 2000ms debounce.

When the debounce timer fires:
- If `fullConflictPredictionQueued` is true, calls `conflictService.runPrediction({})` (all lanes).
- Otherwise, iterates `dirtyLaneQueue` and calls `conflictService.runPrediction({ laneId })` for each.

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
| Head Watcher (main.ts) | HEAD SHA changed | `jobEngine.onHeadChanged({ laneId, reason })` |
| File Service / Git Service | Lane dirty state changed | `jobEngine.onLaneDirtyChanged({ laneId, reason })` |
| IPC (Renderer) | Manual conflict prediction | `jobEngine.runConflictPredictionNow({ laneId? })` |

The PTY service fires `onSessionEnded` after recording the session end in the database. The head watcher in `main.ts` polls for HEAD changes and routes them to `jobEngine.onHeadChanged`, `automationService`, and `restackSuggestionService`. Lane dirty changes trigger conflict prediction with a shorter debounce (900ms).

### Job Executors (Downstream)

| Executor | Job Type | Operation |
|----------|----------|-----------|
| Pack Service | `RefreshLanePack` | `packService.refreshLanePack()` |
| Pack Service | `RefreshProjectPack` | `packService.refreshProjectPack()` |
| Pack Service | `AutoNarrative` (apply) | `packService.applyHostedNarrative()`, `packService.recordEvent()` |
| Hosted Agent Service | `AutoNarrative` (hosted) | `hostedAgentService.requestLaneNarrative()` |
| BYOK LLM Service | `AutoNarrative` (byok) | `byokLlmService.generateLaneNarrative()` |
| Conflict Service | `PredictConflicts` | `conflictService.runPrediction()` |

### Wiring in main.ts

The job engine is wired into the event flow during service initialization:

```typescript
const jobEngine = createJobEngine({
  logger,
  packService,
  conflictService,
  hostedAgentService,
  projectConfigService,
  byokLlmService
});

const ptyService = createPtyService({
  // ...
  onSessionEnded: ({ laneId, sessionId }) => {
    jobEngine.onSessionEnded({ laneId, sessionId });
  },
  // ...
});

// Head watcher in main.ts routes HEAD changes to multiple consumers:
const handleHeadChanged = ({ laneId, reason }) => {
  jobEngine.onHeadChanged({ laneId, reason });
  automationService.onHeadChanged({ laneId, reason });
  restackSuggestionService?.evaluate({ laneId });
};
```

### Future Integration Points

| Service | Direction | Purpose |
|---------|-----------|---------|
| Hosted Agent Service | Downstream | `SyncToHostedMirror` job pushes pack snapshots to cloud |
| Automation Service | Downstream | `RunAutomation` job executes user-defined scripts |
| Checkpoint Service | Downstream | `CreateCheckpoint` job creates immutable snapshots |

---

## Implementation Status

### Completed

- Job engine factory (`createJobEngine`) with 6-dependency injection (logger, packService, conflictService?, hostedAgentService?, projectConfigService?, byokLlmService?)
- Per-lane queue with `Map<string, LaneQueueState>` structure
- Coalescing logic (latest request replaces pending request)
- Sequential execution per lane (no concurrent jobs for same lane)
- `onSessionEnded` handler for PTY session end events
- `onHeadChanged` handler for HEAD changes (triggers both lane refresh and conflict prediction)
- `onLaneDirtyChanged` handler for lane dirty state changes (triggers conflict prediction with 900ms debounce)
- `runConflictPredictionNow` for on-demand conflict prediction from UI
- Lane pack + project pack refresh pipeline
- Auto-narrative generation (hosted + BYOK) with non-blocking async execution after lane refresh
- Narrative telemetry: `narrative_requested` and `narrative_failed` pack events with context delivery metadata
- Conflict prediction queue with debounced execution (900ms-1500ms depending on trigger)
- Periodic conflict prediction timer (every 120 seconds)
- Initial conflict prediction on engine creation (2000ms debounce)
- `dispose()` method for cleaning up timers on shutdown
- Structured error logging for failed jobs
- Integration wiring in `main.ts` with head watcher routing
- Automation jobs: `automationService` triggers job execution on HEAD changes and other events (Phase 8)
- Auto-narrative pipeline: deterministic pack refresh followed by async AI narrative generation (hosted + BYOK)

### Not Yet Implemented

- **Retry logic**: Exponential backoff with configurable max retries
- **Dead letter logging**: Persistent record of permanently failed jobs
- **Job priority**: Some jobs (conflict prediction) should be lower priority than pack refresh
- **Concurrent lane processing**: Currently all jobs are serialized per lane; different lanes could process concurrently
- **Job cancellation**: Ability to cancel a running job (e.g., when switching projects)
- **Job metrics**: Tracking execution time, success rate, queue depth
- **Checkpoint jobs**: Checkpoints exist at session boundaries, but not yet as a standalone job type (partially done)
- **Feature/conflict pack materialization**: `MaterializeFeaturePack`, `MaterializeConflictPack`
- **Hosted sync jobs**: `SyncToHostedMirror` for cloud agent integration (as standalone job type)
- **Health monitoring**: Alerting on elevated failure rates
