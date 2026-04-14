# Recording and Export

Operations are recorded through a thin service that brackets every
state-changing action with `start` / `finish` calls. This doc walks
through the recording paths, how transcripts are serialised for
history-adjacent features, and how the export flow converts rows to
CSV/JSON.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/history/operationService.ts` | The service: `start`, `finish`, `recordCompleted`, `list`. |
| `apps/desktop/src/main/services/git/gitOperationsService.ts` | Primary consumer: every git operation runs through `runTrackedOperation`, which handles start/finish + cache invalidation. |
| `apps/desktop/src/main/services/prs/prService.ts` | Records PR creation and related operations. |
| `apps/desktop/src/main/services/conflicts/conflictService.ts` | Records rebase lifecycle. |
| `apps/desktop/src/main/services/sessions/sessionService.ts` | Terminal session lifecycle (writes `terminal_sessions` rows and persists transcripts to disk). |
| `apps/desktop/src/shared/chatTranscript.ts` | JSON-lines parser for chat transcripts; used to reconstruct chat state, generate summaries, and derive activity signals. |
| `apps/desktop/src/main/services/ipc/registerIpc.ts` | `ade.history.listOperations` and `ade.history.exportOperations` handlers. |

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

- `git.commit` -- before/after HEAD, files changed, commit message.
- `git.checkout` -- from/to branch.
- `git.merge` -- base branch, conflict flag.
- `git.rebase` -- base, number of commits replayed.
- `git.push` -- remote, branch, commit count.
- `git.pull` -- remote, branch, new commits.
- `git.fetch` -- remote.
- `git.sync` -- mode (`merge` | `rebase`), base ref.

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

1. Call `operationService.list({ laneId, kind, limit: 1000 })`. Note
   that `status` is filtered client-side after the fetch.
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
  calls or a future streaming IPC.
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
- **Export filter ordering.** Status filter is applied after the
  1000-row pull. Heavy status filters combined with a specific kind
  can yield 0 rows even when many matching rows exist beyond the
  limit.

## Related docs

- [History README](README.md) -- overview and IPC surface.
- [Chat Transcript and Turns](../chat/transcript-and-turns.md) -- the
  full event union and render pipeline for chat streams.
- [Agents README](../agents/README.md) -- CTO and worker session
  logs (tracked separately in `cto_session_logs`).
</content>
</invoke>