# PR merge queue

ADE's merge queue models sequential PR landings with explicit state
transitions and optional AI-driven conflict auto-resolution. The
queue is how users land several stacked PRs in one click while still
getting visibility into each step.

Source: `apps/desktop/src/main/services/prs/queueLandingService.ts`.

## Model

A **queue group** is a `pr_groups` row with `group_type = 'queue'`,
an optional target branch, and flags for `auto_rebase` and
`ci_gating`. Each member is a row in `pr_group_members` with a role
(`source`, `integration`, or `target`) and a position.

A **queue landing state** (`queue_landing_state` table) is the live
run for a group. A group may have at most one non-`completed`
landing state at a time.

```ts
type QueueLandingState = {
  queueId: string;
  groupId: string;
  groupName: string | null;
  targetBranch: string | null;
  state: "landing" | "paused" | "completed" | "cancelled";
  entries: QueueLandingEntry[];
  currentPosition: number;
  activePrId: string | null;
  activeResolverRunId: string | null;
  lastError: string | null;
  waitReason: QueueWaitReason | null;
  config: QueueAutomationConfig;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
};
```

## Queue automation config

```ts
type QueueAutomationConfig = {
  method: MergeMethod;                // squash | merge | rebase
  archiveLane: boolean;                // archive lane after landing
  autoResolve: boolean;                // run conflict resolver on merge conflict
  ciGating: boolean;                   // block land until CI passes
  resolverProvider: "claude" | "codex" | null;
  resolverModel: string | null;
  reasoningEffort: string | null;
  permissionMode: ConflictResolverPermissionMode;
  confidenceThreshold: number | null;
  originSurface: ConflictResolverOriginSurface;
  originMissionId: string | null;
  originRunId: string | null;
  originLabel: string | null;
};
```

`DEFAULT_QUEUE_CONFIG` sets `method = 'squash'`, `autoResolve =
false`, `ciGating = true`, `permissionMode = 'guarded_edit'`.

## Entry lifecycle

`QueueLandingEntry` states:

| State | Meaning |
|-------|---------|
| `pending` | In queue, not yet attempted |
| `landing` | Active land attempt in flight |
| `rebasing` | Rebase attempt before land (when behind) |
| `resolving` | Conflict resolver running (auto-resolve path) |
| `landed` | Successfully merged |
| `failed` | Terminal failure |
| `skipped` | User skipped this entry |
| `paused` | Awaiting user attention |

## State transition table

The queue landing service enforces an explicit transition table.
Invalid transitions are logged and rejected rather than silently
applied.

```ts
const ALLOWED_TRANSITIONS: Record<QueueEntryState, readonly QueueEntryState[]> = {
  pending:   ["landing", "rebasing", "skipped", "paused"],
  landing:   ["landing", "landed", "failed", "paused"],
  rebasing:  ["resolving", "pending", "failed", "paused"],
  resolving: ["pending", "failed", "paused"],
  landed:    [],
  failed:    ["skipped"],
  skipped:   [],
  paused:    ["pending", "landing", "skipped"],
};
```

Helpers:

- `isValidTransition(from, to)` — pure check.
- `guardTransition(entry, to, context)` — log and reject path; returns
  `true` when allowed. Other methods early-return on rejection so
  state mutations never happen for rejected transitions.
- `markEntryLanded(state, entry, index, sha)` — centralizes the
  landed-entry bookkeeping (state, position advance, active-PR
  reset).

## Landing loop

`launchLandingLoop(queueId)` runs one loop per queue id, chained via
an `activeLandingLoops: Map<string, Promise<void>>` so a loop never
runs twice concurrently for the same queue.

Per iteration:

1. Re-read the row. If missing → return. If state is `cancelled`
   / `completed` / `paused` → return.
2. Pick the next `pending` entry at `currentPosition`.
3. Call `prService.land({ prId, method, archiveLane })`.
4. If the land succeeds:
   - `markEntryLanded(...)`.
   - Continue the loop.
5. If the land fails with a merge conflict message and
   `config.autoResolve && conflictService`:
   - Transition to `resolving`.
   - Call `conflictService.runExternalResolver(...)`.
   - If the resolver completed and produced changed files: commit
     the files, push, transition back to `landing`, retry the land.
6. Otherwise: transition to `failed` or `paused` with an explicit
   `waitReason`.

Conflict detection helper:

```ts
const isMergeConflictMessage = (message) =>
  message.includes("merge conflict") || message.includes("resolve conflicts");
```

(Case-insensitive.)

## Cancel path

Cancelling a queue force-fails entries in non-skippable states
(`landing`, `resolving`) with a warning rather than leaving them in
an inconsistent state. After cancel:

- `state = "cancelled"`, `completedAt = now`.
- Active resolver runs are not killed by the queue service itself;
  they are owned by `conflictService` and will complete on their own.
  The queue simply stops acting on their results.

## CI gating

When `config.ciGating` is true, `land()` waits for the PR's checks
status to transition to `passing` before attempting the merge. A
check status of `pending` pauses the queue with
`waitReason: "waiting_for_checks"`. The UI surfaces this reason in
the Queue tab with a timer-style indicator.

## Auto-resolve path

When `config.autoResolve` is true and `conflictService` is available:

1. `runExternalResolver` runs a Codex or Claude CLI session in the
   resolved target lane's worktree (or an integration lane).
2. Resolver outputs changed files and a summary.
3. ADE `git add` + `git commit` with a canned message:
   `"Resolve queue conflicts for PR #<num> via ADE"`.
4. Push the lane branch (with `--force-with-lease` fallback if
   the plain push is rejected).
5. Retry the land.

Provider fallback: `state.config.resolverProvider ??
(state.config.resolverModel?.includes("anthropic/") ? "claude" : "codex")`.

Cancellation races are handled at three checkpoints:

- Before resolver launch (`isQueueCancelledOrDone`).
- After resolver completion, before commit.
- After commit, before push/retry.

## Queue workflow model (renderer)

`renderer/components/prs/tabs/queueWorkflowModel.ts` is the pure
model for the Queue tab:

- Active / history bucketing of queue groups.
- Current member selection based on landing state or open-PR
  position.
- Manual-land warning generation from PR status (checks failing,
  not mergeable, dirty lane, etc).
- Queue guidance tone: `idle | ready | warning | blocked | success`,
  paired with recommended actions.

This keeps the tab rendering testable and separates it from the
component tree.

## IPC

| Channel | Description |
|---------|-------------|
| `ade.prs.listQueueStates` | List all queue landing states for the project |
| `ade.prs.createQueue` | Create a queue group with initial members |
| `ade.prs.landQueueNext` | Advance the queue to the next entry |
| `ade.prs.cancelQueue` | Cancel a queue (force-fails active entries) |
| `ade.prs.resumeQueue` | Resume a paused queue |
| `ade.prs.reorderQueuePrs` | Move an entry within a queue |

## Gotchas

- **Don't bypass `guardTransition`.** Every state mutation path in
  `queueLandingService` routes through it. A direct `entry.state =
  …` without the guard leaves traces in logs with no way to
  reproduce invalid states later.
- **One active loop per queue id.** `activeLandingLoops` chains
  promises. Starting a second loop concurrently would double-fire
  transitions.
- **Conflict detection is substring-based.** `"merge conflict"` /
  `"resolve conflicts"` in error messages triggers the auto-resolve
  path. Changing GitHub's error wording upstream could silently
  disable auto-resolve.
- **Commit-then-push failures force-with-lease.** If a plain push is
  rejected, the service retries with `--force-with-lease`. This is
  safe because the queue is the sole writer for the duration of the
  land attempt, but it does mean abandoning the queue halfway can
  leave a branch that has been force-pushed without a clean reset
  path.
- **Archive on landing is opt-in.** `config.archiveLane` defaults to
  `false` to preserve the lane for post-merge cleanup and
  inspection. The UI surfaces this explicitly.
- **Resolver context key.** `buildPrAiResolutionContextKey` builds a
  stable key for the resolver context so subsequent rounds can
  reuse prior context. Queue auto-resolve inherits the label
  pattern via `state.config.originLabel ?? "queue:<groupId>"`.
