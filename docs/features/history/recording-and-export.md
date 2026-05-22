# Recording and Export

Operations are recorded through a thin service that brackets every
state-changing action with `start` / `finish` calls. This doc walks
through the recording paths, how transcripts are serialised for
history-adjacent features, and how the export flow converts rows to
CSV/JSON.

The operationService and gitOperationsService both run inside the
**active ADE runtime** (local daemon for local-bound windows,
SSH-attached remote runtime for remote-bound windows). The same source
files are also loaded by the desktop main process for the legacy
in-process IPC fallback path. Export-to-disk is split: the runtime
returns the row payload, then the desktop main process writes the
file through the native save dialog (the file always lands on the
user's local machine).

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/history/operationService.ts` | The service: `start`, `finish`, `recordCompleted`, `list`, `get`, `listHeadChanges`. |
| `apps/desktop/src/main/services/git/gitOperationsService.ts` | Primary consumer: every git operation runs through `runLaneOperation` / `runTrackedOperation`, which handles start/finish + cache invalidation. Also owns the head-change undo/redo helpers that read `operationService.listHeadChanges`. |
| `apps/desktop/src/main/services/prs/prService.ts` | Records PR creation and related operations. |
| `apps/desktop/src/main/services/conflicts/conflictService.ts` | Records rebase lifecycle. |
| `apps/desktop/src/main/services/sessions/sessionService.ts` | Terminal session lifecycle (writes `terminal_sessions` rows and persists transcripts to disk). |
| `apps/desktop/src/shared/chatTranscript.ts` | JSON-lines parser for chat transcripts; used to reconstruct chat state, generate summaries, and derive activity signals. |
| `apps/desktop/src/main/services/ipc/registerIpc.ts` | `ade.history.listOperations` and `ade.history.exportOperations` handlers, plus the new git IPC the History toolbar relies on (`gitCreateTag`, `gitResetToCommit`, `gitUndoLastHeadChange`, `gitRedoLastHeadChange`, multi-mode `gitPull`). |
| `apps/desktop/src/renderer/components/history/historyActivitySources.ts` | Renderer-side adapters that synthesize Activity-feed rows from `agentChat.list`, `missions.list`, `cto.getState`, and `cto.listAgentRuns`. These rows are not written to the operations table. |

## Recording pattern

`operationService.start(args)` inserts a row with `status = 'running'`
and returns `{ operationId, startedAt }`. `operationService.finish(args)`
updates the row's `ended_at`, `status`, `post_head_sha`, and merges
`metadataPatch` into the existing `metadata_json`.

### Tracked git operation wrapper

`runTrackedOperation` in `gitOperationsService.ts` is the canonical
pattern for async operations:

```ts
async function runTrackedOperation<T>({
  laneId, kind, reason, metadata, fn,
}): Promise<{ result: T; action: GitActionResult }> {
  invalidateLaneReadCache(laneId);
  const lane = laneService.getLaneBaseAndBranch(laneId);
  const preHeadSha = await getHeadSha(lane.worktreePath);

  const operation = operationService.start({
    laneId, kind, preHeadSha,
    metadata: { reason, branchRef: lane.branchRef, baseRef: lane.baseRef, ...metadata }
  });

  try {
    const result = await fn(lane);
    const postHeadSha = await getHeadSha(lane.worktreePath);
    operationService.finish({
      operationId: operation.operationId,
      status: "succeeded",
      postHeadSha,
    });
    onWorktreeChanged?.({ laneId, reason, operationId: operation.operationId, preHeadSha, postHeadSha });
    if (preHeadSha !== postHeadSha) {
      onHeadChanged?.({ laneId, reason, operationId: operation.operationId, preHeadSha, postHeadSha });
    }
    return { result, action: { operationId: operation.operationId, preHeadSha, postHeadSha } };
  } catch (error) {
    const postHeadSha = await getHeadSha(lane.worktreePath);
    operationService.finish({
      operationId: operation.operationId,
      status: "failed",
      postHeadSha,
      metadataPatch: { error: error.message }
    });
    throw error;
  } finally {
    invalidateLaneReadCache(laneId);
  }
}
```

Notable points:

- `preHeadSha` is captured _before_ the operation; `postHeadSha` is
  captured in both success and failure branches.
- Callback failures (`onWorktreeChanged`, `onHeadChanged`) are
  swallowed so they never fail the git operation.
- Cache invalidation fires on both sides.

### Synchronous operations

For operations with no async work between start and finish (e.g., a
pack regeneration that delegates internally and just records the
result), `operationService.recordCompleted(args)` wraps the sequence:

```ts
const { operationId } = operationService.recordCompleted({
  laneId,
  kind: "pack_update_lane",
  preHeadSha,
  postHeadSha,
  status: "succeeded",
  metadata: { reason: "session_end", trigger: "auto" }
});
```

### Adding a new operation kind

1. Pick a stable `kind` string (prefer `domain.verb` form).
2. Call `operationService.start` immediately before the work starts.
3. Capture pre-state (HEAD SHA or other invariants) and pass to
   `start`.
4. On success and failure, call `finish` with `status` and
   `postHeadSha` + any failure context in `metadataPatch`.
5. Add a case to `describeOperation()` in the renderer so the
   timeline renders a human-readable summary.
6. Add the kind to the filter dropdown if it is user-visible.

## What each feature records

### Git operations (`gitOperationsService.ts`)

- `git_commit` -- before/after HEAD, files changed, commit message.
- `git_checkout_branch` -- `{ fromBranch, toBranch, mode }`.
- `git.merge` -- base branch, conflict flag.
- `git.rebase` / `git_rebase_continue` / `git_rebase_abort` -- base, commit count.
- `git_merge_continue` / `git_merge_abort` -- in-progress merge resolution.
- `git_push` -- `{ remote, branch, commitCount }`.
- `git_push_force_with_lease` -- annotated separately so the timeline distinguishes lease-rewrites.
- `git_pull` -- `{ mode: "ff-only" | "rebase" | "merge" }`. The pull command map lives in `gitOperationsService.pull`; each mode maps to a distinct git invocation but they share the same operation kind so the timeline groups by intent.
- `git_fetch` -- `{ remote }`.
- `git_sync_merge` / `git_sync_rebase` -- `{ baseRef }`.
- `git_cherry_pick`, `git_revert` -- `{ commitSha }`.
- `git_tag_create` -- `{ commitSha, tagName, annotated }`. Annotated when a message is supplied.
- `git_reset_soft` / `git_reset_mixed` / `git_reset_hard` -- `{ commitSha, mode }`. Bracketed like any other head-changing op so they show up in undo/redo lookups.
- `git_stash_push` / `git_stash_apply` / `git_stash_pop` / `git_stash_drop` / `git_stash_clear`.
- `git_undo_head_change` -- bracketed user recovery: looks up the previous successful `git_*` op with non-equal pre/post SHAs via `operationService.listHeadChanges`, refuses if HEAD has moved since, then `git reset --hard preHeadSha`. Metadata: `{ undoneOperationId, undoneOperationKind, redoHeadSha, targetHeadSha }`.
- `git_redo_head_change` -- inverse: reads `redoHeadSha` from the latest `git_undo_head_change` row's metadata. Metadata: `{ redoneUndoOperationId, targetHeadSha }`.

### Lane operations

Lane creation, rename, archive, and deletion go through
`laneService.ts` which records a corresponding operation for the
action. Lane-scoped git ops inherit `laneId`.

### PR operations (`prService.ts`)

- `pr.create` -- lane id, PR number, title, body.
- `pr.issueResolution.*` -- check reruns, review thread replies and
  resolution, when performed via the PR issue resolution chat flow.

### Conflicts (`conflictService.ts`)

- `git.rebase` -- entering and completing a rebase.
- Dismissed/deferred rebase suggestions do not record operations (they
  are UI state only).

### Pack refreshes

- `pack_update_lane` -- lane pack regeneration.
- `pack_update_project` -- project pack regeneration.
- Triggered by `session_end`, `head_change`, `manual`, or `scheduled`.

## Head-change undo / redo

The undo/redo feature is a per-lane stack-of-one that reads the same
operations table it writes to.

`operationService.listHeadChanges({ laneId, limit })` returns the
recent `succeeded` operations whose kind starts with `git_` /  `git.`,
both `pre_head_sha` and `post_head_sha` are non-null, and the two SHAs
differ. The list is ordered newest-first.

`gitOperationsService.undoLastHeadChange` looks at the head of that
list:

1. Reject if the head row is itself a `git_undo_head_change` -- the
   lane is already in an undone state; the caller should call redo.
2. Read the live HEAD with `git rev-parse HEAD`. If it does not match
   the row's `postHeadSha`, refuse: HEAD has drifted since that
   operation (the user committed, pulled, or otherwise moved on) and
   `git reset --hard` would clobber unrelated work.
3. Run `git reset --hard preHeadSha` and record a new
   `git_undo_head_change` operation whose metadata captures the row
   it undid plus `redoHeadSha = preHeadSha`'s sibling (`postHeadSha`
   of the undone row). This is what `redoLastHeadChange` reads back.

`gitOperationsService.redoLastHeadChange` mirrors the same shape but
walks the inverse direction: head row must be a `git_undo_head_change`
and current HEAD must still match its `postHeadSha`, then
`git reset --hard redoHeadSha`.

Both paths fail loudly with `Cannot undo because the lane head has
changed since that operation.` (or `since the undo.`) when the SHA
guard trips. The UI surfaces those errors verbatim through
`historyLaneActions.runHistoryLaneAction`.

## Synthesized Activity rows

The Activity surface in the History UI merges persisted
`OperationRecord` rows with synthesized rows pulled from chat,
mission, CTO, and worker feeds. Synthesis happens in
`apps/desktop/src/renderer/components/history/historyActivitySources.ts`
and never writes to the operations table.

The renderer fetches the four feeds in parallel with
`fetchSupplementalTimelineRecords(limit)` and folds the results into
`OperationRecord`-shaped objects with namespaced IDs (`chat:`,
`mission:`, `worker-run:`, `cto-session:`, `cto-activity:`). Each
record carries:

- `kind` -- `chat.session`, `mission.{completed|failed|intervention|update}`,
  `worker.run`, `cto.session`, or `worker.activity`. The taxonomy in
  `eventTaxonomy.ts` ensures each kind has a category, icon, and
  importance level.
- `status` -- mapped from the source's status enum (e.g. mission
  `intervention_required` → `running`, worker `cancelled` → `canceled`).
- `metadataJson` -- a `JSON.stringify`'d object with at minimum
  `source`, `eventLabel`, and an `actor` field so the detail panel can
  render uniformly regardless of source.

`sortTimelineRecords` deduplicates by `id` and sorts by `startedAt`
descending before the result is clamped to the renderer's limit. The
export path does not consult these adapters.

## Chat transcript serialisation

Chat transcripts are JSON-lines (`.jsonl`) files, one envelope per
line. The canonical writer is `agentChatService.ts`; the canonical
parser is `parseAgentChatTranscript` in
`apps/desktop/src/shared/chatTranscript.ts`.

### Envelope format

```
{"sessionId": "uuid", "timestamp": "2026-04-13T12:00:00Z", "event": {...}, "sequence": 42}
```

- `sessionId` -- must be non-empty for the line to be accepted.
- `timestamp` -- ISO 8601; missing/malformed timestamps fall back to
  `Date.now()` at parse time.
- `event` -- the `AgentChatEvent` discriminated union.
- `sequence` -- optional monotonic index for ordering across parallel
  streams.
- `provenance` -- optional metadata for mission-scoped chats (thread
  id, role, source session id, attempt id, step key, lane id, run id).

Malformed lines are silently skipped; the parser is tolerant by design
so a single corrupt line does not poison an entire transcript.

### Storage

Chat transcripts live on disk under the `.ade` state layout. The
service persists buffered text before flush so reads never see a
half-written text event. Version-2 persistence (`sessionRecovery.ts`)
includes recent entries, a continuity summary, and provider-native
runtime state so sessions resume after app restarts.

### Recovery

On session resume:

1. Parse the persisted transcript via `parseAgentChatTranscript`.
2. Filter to the tail relevant for continuity (bounded).
3. Inject a continuity summary into the new runtime's context.
4. Rehydrate provider-native state (Claude session id, Codex
   app-server socket path, OpenCode runtime ids).

### Terminal session transcripts

`terminal_sessions.transcript_path` points to the PTY session's
transcript on disk. The writer is `ptyService.ts`; contents are raw
terminal output with ANSI escape sequences (for tools that parse them
back). `stripAnsi` in `shared/ansiStrip.ts` is available for readers
that want plain text.

## Export flow

`ade.history.exportOperations` handler:

1. Call `operationService.list({ laneId, kind, status?, limit: 1000 })`.
   When `args.status` is a single concrete value the handler forwards
   it as a server-side filter; when it is `"all"` (the export sentinel)
   or absent, the handler omits the filter and falls back to a
   client-side filter only if the caller is also doing multi-status
   selection through `ExportHistoryArgs.status`.
2. Compute a default filename:
   `ade-history-<projectSlug>-<YYYY-MM-DD>.<format>`.
3. Open a system save dialog (native `dialog.showSaveDialog`).
4. If the user cancels, return `{ cancelled: true }`.
5. Format the rows:
   - **JSON** -- pretty-printed object with `exportedAt`, project,
     filters, row count, and rows array.
   - **CSV** -- headers line + one row per operation, with
     `escapeCsvCell` quoting each field. Columns:
     `id, laneId, laneName, kind, status, startedAt, endedAt,
     preHeadSha, postHeadSha, metadataJson`.
6. Write with `fs.writeFileSync` (UTF-8).
7. Return `{ cancelled: false, savedPath, bytesWritten, exportedAt,
   rowCount, format }`.

### CSV quoting

`escapeCsvCell(value)` wraps fields containing `,`, `"`, or newlines
in double quotes and escapes internal quotes by doubling. The
`metadataJson` column regularly contains nested quotes and newlines,
so CSV consumers must respect RFC 4180-style quoting.

## Fragile and tricky wiring

- **Orphan `running` rows.** If the app crashes between `start` and
  `finish`, the row stays in `running` status forever. There is no
  automatic reconciliation on startup; operations older than a
  reasonable threshold should be tombstoned manually during a
  migration, or the UI should filter very-old `running` rows.
- **Metadata merge shallow.** `operationService.finish` spreads
  `metadataPatch` over the existing metadata. Nested objects
  (`{ commit: { ... } }`) are replaced wholesale, not deep-merged.
- **Max list limit.** `list()` clamps `limit` to `[1, 1000]`. Export
  uses `limit: 1000` by default; larger ranges require multiple
  calls or a future streaming IPC. `listHeadChanges()` uses the same
  clamp with a default of 100, scoped to a single lane.
- **`laneName` resolution via left join.** If a lane is archived or
  deleted, its name disappears from future rows. Historical rows
  still show `laneName: null`. Do not rely on `laneName` to identify
  the lane -- use `laneId`.
- **`post_head_sha` on failed operations.** The code captures
  `postHeadSha` in the catch branch as well, which can surprise
  consumers expecting `postHeadSha` only on success. Treat a
  `failed` row's `postHeadSha` as "where we ended up", not "where we
  intended to be".
- **Transcript parser tolerance.** `parseAgentChatTranscript` silently
  skips malformed lines. This is good for resilience but means that
  partial file corruption does not throw -- monitor sequence gaps
  instead.
- **Session replay vs history.** Terminal session transcripts are raw
  ANSI; chat transcripts are JSON-lines. Do not cross the streams
  (parsing a terminal transcript as JSON will silently produce zero
  events).
- **Export filter ordering.** A single concrete `status` is now
  applied server-side (it lands in the SQL `where` clause), so the
  1000-row clamp happens after that filter. The `"all"` sentinel and
  multi-status renderer paths still rely on the rows the handler
  pulled, so a heavily filtered export combined with a specific kind
  can still yield 0 rows even when many matching rows exist beyond
  the limit.

## Related docs

- [History README](README.md) -- overview and IPC surface.
- [Chat Transcript and Turns](../chat/transcript-and-turns.md) -- the
  full event union and render pipeline for chat streams.
- [Agents README](../agents/README.md) -- CTO and worker session
  logs (tracked separately in `cto_session_logs`).
</content>
</invoke>