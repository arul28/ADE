# History

History is ADE's operations timeline: a record of every meaningful
action that changed the project state (git ops, pack refreshes,
checkpoints). The goal is traceability and debuggability, not just
`git log`. Chat transcripts, session PTYs, and mission runs are
recorded in parallel tables owned by their respective features;
history is the operations-level view that ties them together.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/history/operationService.ts` | CRUD for `operations` rows; the canonical entry point for `record`, `start`, `finish`, `list`. |
| `apps/desktop/src/main/services/state/kvDb.ts` | Schema for `operations`, `checkpoints`, `pack_events`, `pack_versions`, `pack_heads`, `terminal_sessions`, `orchestrator_chat_threads`, `orchestrator_chat_messages`. |
| `apps/desktop/src/main/services/git/gitOperationsService.ts` | Brackets every git operation with `operationService.start` / `finish`, capturing pre/post HEAD SHAs. |
| `apps/desktop/src/main/services/prs/prService.ts` | Records PR creation as an operation. |
| `apps/desktop/src/main/services/conflicts/conflictService.ts` | Records rebase operations. |
| `apps/desktop/src/main/services/sessions/sessionService.ts` | Terminal session lifecycle (separate `terminal_sessions` table). |
| `apps/desktop/src/main/services/ipc/registerIpc.ts` | `ade.history.listOperations` and `ade.history.exportOperations` handlers. |
| `apps/desktop/src/renderer/components/history/` | History page UI (2-pane layout, filters, operation detail). |
| `apps/desktop/src/shared/chatTranscript.ts` | JSON-lines parser for persisted chat transcripts; used when replaying history-adjacent chat streams. |
| `apps/desktop/src/shared/types/history.ts` | `OperationRecord`, `HistoryFilters`, `ExportHistoryArgs`. |

## What history captures

History records **operations** -- discrete, typed actions that changed
state. It does not record chat turns or agent reasoning (those live in
the chat transcript and orchestrator tables).

### Operation kinds

Tracked kinds:

| Kind | Source | Metadata |
|---|---|---|
| `git.commit` / `git_commit` | `gitOperationsService.commit` | `{ message, filesChanged, sha, reason, branchRef, baseRef }` |
| `git.checkout` | `gitOperationsService.checkout` | `{ fromBranch, toBranch, reason }` |
| `git.merge` | `gitOperationsService.merge` | `{ fromBranch, conflicts }` |
| `git.rebase` | `gitOperationsService.rebase`, `conflictService.rebaseLane` | `{ ontoBranch, commitCount }` |
| `git.push` / `git_push` | `gitOperationsService.push` | `{ remote, branch, commitCount }` |
| `git.pull` | `gitOperationsService.pull` | `{ remote, branch, newCommits }` |
| `git.fetch` / `git_fetch` | `gitOperationsService.fetch` | `{ remote }` |
| `git.sync` / `git_sync` | `gitOperationsService.sync` | `{ mode, baseRef }` |
| `pack_update_lane` | `packService.refreshLane` | `{ reason, trigger }` |
| `pack_update_project` | `packService.refreshProject` | `{ reason, trigger }` |

### Status

`running | succeeded | failed | canceled`. `running` is set at `start`
and transitions on `finish`. Canceled operations are bracketed with
`finish({ status: "canceled" })` by the caller.

### SHA transitions

Every git operation records `preHeadSha` and `postHeadSha`. This is
the foundation for a future undo capability and for showing "what
actually changed" in the timeline.

## Other history-adjacent tables

Several features own their own history-style tables. These are not
queried via `ade.history.*` but contribute to the broader picture.

### Terminal sessions

`terminal_sessions` (schema in `kvDb.ts` line 689):

- `id`, `lane_id`, `pty_id`, `tracked`, `pinned`, `manually_named`
- `goal`, `tool_type`, `title`
- `started_at`, `ended_at`, `exit_code`, `status`
- `transcript_path` -- filesystem path to the persisted transcript
- `head_sha_start`, `head_sha_end` -- git HEAD bracketing the session
- `last_output_preview`, `last_output_at`, `summary`
- `resume_command`, `resume_metadata_json` -- resume info for CLI
  tools (Claude Code, Codex, Cursor) so sessions can be picked up
  after exit.

Sessions are owned by `sessionService.ts`; their full transcript is on
disk at `transcript_path`.

### Checkpoints (Phase 8)

`checkpoints` (schema in `kvDb.ts`):

- Immutable SHA snapshots at session boundaries.
- Carry diff stats and linked pack event IDs.
- Surfaced internally via `packService` compatibility paths but not
  through a public `ade.packs.*` IPC.

### Pack events (Phase 8)

`pack_events`:

- Append-only log of pack state changes (checkpoint created, narrative
  updated, conflict detected, etc.).
- Event-specific payload stored as JSON.

### Pack versions (Phase 8)

`pack_versions`, `pack_heads`:

- Track pack content hashes and which version is "live" per pack key.
- Used by deterministic-context exports.

### Orchestrator chat threads and messages

`orchestrator_chat_threads`, `orchestrator_chat_messages`:

- Mission-scoped chat threads with structured message records.
- Used by the mission feed UI.

### AI usage log

`ai_usage_log`:

- Per-turn token and cost tracking across providers.
- Consumed by the budget/usage dashboards, not the history UI.

## IPC surface

Defined in `apps/desktop/src/shared/ipc.ts`, handled in
`apps/desktop/src/main/services/ipc/registerIpc.ts`.

| Channel | Args | Purpose |
|---|---|---|
| `ade.history.listOperations` | `ListOperationsArgs` (`{ laneId?, kind?, status?, limit?, offset? }`) | Query operations with optional filters and pagination. Default limit 300, max 1000. |
| `ade.history.exportOperations` | `{ format: "csv" \| "json"; laneId?, kind?, status?, limit? }` | Export filtered history as CSV or JSON via a save dialog. Cancellation returns `{ cancelled: true }`. |

Planned but not yet implemented: `getFeatureHistory`,
`undoOperation`, dedicated checkpoint/event browsing.

## Operation recording pattern

Every operation that should appear in history follows:

```ts
const op = operationService.start({
  laneId,
  kind: "git.commit",
  preHeadSha,
  metadata: { reason, branchRef }
});

try {
  const result = await doTheThing();
  const postHeadSha = await getHeadSha();
  operationService.finish({
    operationId: op.operationId,
    status: "succeeded",
    postHeadSha,
    metadataPatch: { message: result.message, filesChanged: result.files.length }
  });
} catch (error) {
  operationService.finish({
    operationId: op.operationId,
    status: "failed",
    postHeadSha: await getHeadSha(),
    metadataPatch: { error: error.message }
  });
  throw error;
}
```

For instantaneous operations (no async work between start and finish),
`operationService.recordCompleted()` wraps both calls.

See `gitOperationsService.ts` for the canonical implementation
(`runTrackedOperation`). That helper also emits lane-changed and
HEAD-changed events so dependent services can invalidate caches.

## History page UI

Under `apps/desktop/src/renderer/components/history/`:

- Two-pane `PaneTilingLayout` (timeline ~45%, detail ~55%).
- Timeline: chronological list with status-colored left border,
  human-readable description via `describeOperation()`, kind chip,
  lane name, status chip, relative timestamp with absolute hover.
- Filter bar: lane dropdown, kind dropdown, status chip toggles,
  manual refresh button. `laneId` URL parameter supported for deep
  links.
- Auto-refresh: silent polling every 4 s when any operation has
  `running` status; guarded by window visibility/focus so background
  tabs stay quiet.
- Event detail panel: all fields as labeled rows, metadata JSON
  (expandable), actions (jump to lane, future: undo, copy details).

## What is NOT in history

Deliberately excluded to keep the timeline focused on state-changing
operations:

- Chat turns and agent reasoning (chat transcript instead).
- Individual tool calls during a session.
- UI navigation events.
- Memory writes/reads (Settings -> Memory).
- PR comment polling / check re-runs (captured in PR module).
- Context-pack generation telemetry.
- AI token usage (`ai_usage_log`).

## Fragile and tricky wiring

- **Start/finish pairing.** Operations without a `finish` stay
  `running` forever. Every code path that calls `start` must have a
  matching `finish` (success or failure). `gitOperationsService`
  wraps both in `runTrackedOperation`; new call sites should adopt
  that pattern rather than calling start/finish manually.
- **Pre/post HEAD capture timing.** `preHeadSha` is captured
  immediately before the operation; `postHeadSha` immediately after
  (even on failure). If the operation crashes the process between
  the two reads, the row is left with `running` status and null
  `postHeadSha` -- it must be reconciled on next startup or left as
  a tombstone.
- **Metadata merge on finish.** `operationService.finish` merges the
  `metadataPatch` into the existing metadata via spread. Nested
  objects are overwritten wholesale, not deep-merged.
- **Status filter in export.** `historyExportOperations` filters
  statuses client-side after pulling rows. Large projects with heavy
  filters can hit the 1000-row limit before the filter applies.
- **`laneName` join.** `list()` left-joins `lanes.name`. Deleted or
  archived lanes still show up with `laneName: null` instead of the
  original name -- good for stable history, surprising for the UI.
- **CSV export escaping.** The export path embeds metadata JSON; CSV
  escaping must survive nested quotes. Validate with round-trip
  tests when adjusting export formats.
- **Pack/checkpoint data exists but is hidden.** Phase 8 tables are
  populated but the History UI does not surface them. Any new IPC
  that exposes them must also respect the visibility/focus polling
  guards already in place for operations.

## Detail doc

- [Recording and Export](recording-and-export.md) -- how git/PR/pack
  services emit operations, and how the export flow writes CSV/JSON.

## Related docs

- [Chat README](../chat/README.md) -- chat transcript persistence is
  separate from the operations timeline but parallel in intent.
- [Agents README](../agents/README.md) -- worker and CTO session logs
  are tracked in `cto_session_logs` and agent-specific tables, not
  `operations`.
</content>
</invoke>