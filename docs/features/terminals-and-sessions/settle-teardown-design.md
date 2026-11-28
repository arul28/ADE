# Settle: the settling window and the settle writer

Settle is a classification, not a stop. Settling a chat files it out of the
way; its background shells, subagents, cloud runs, scheduled wakes and crons
keep running. A working chat cannot be settled, and any turn start (a scheduled
wake too) unsettles it. Archive is the path that stops work. This doc covers
the machinery that keeps a settle from overwriting a newer decision. The
section numbers are kept because other docs link to them.

## Source file map

| File | Responsibility |
|------|----------------|
| `apps/desktop/src/main/services/sessions/settleLifecycleWriter.ts` | The only writer of the settle tuple and its revision. |
| `apps/desktop/src/main/services/sessions/settlingStateRegistry.ts` | The in-memory settling window; abort reasons and outcome types. |
| `apps/desktop/src/main/services/sessions/settleTurnCheck.ts` | What a settle checks inside its window: is a turn running. Stops nothing. |
| `apps/desktop/src/main/services/sessions/settleWiring.ts` | `createSettleWiring` / `createLateBoundSettle`: one factory for desktop main and the brain. |
| `apps/desktop/src/main/services/sessions/settleTerminalSession.ts` | The single settle transaction for IPC and the action registry. |
| `apps/desktop/src/main/services/sessions/sessionService.ts` | `settleSessions`, `settleSessionsReportingAborts`, `settleSession`, `unsettleSession(s)`, `clearSettleOnTurnStart`, `getSettleLifecycleRevision`. |
| `apps/desktop/src/main/services/state/kvDb.ts` | `session_lifecycle_revisions` (local only); the remote settle-tuple hook in `applyChanges`. |
| `apps/ade-cli/src/services/sync/syncHostService.ts` | Drops settle columns from phone changesets. |
| `apps/ios/ADE/Services/Database.swift` | `PendingSessionSettleStates`: the phone's local optimistic overlay. |

## Rules

- **Every caller is refused while a turn runs** (`turn_running`). A turn read
  that does not answer in 10 s refuses with `status_unknown`. The UI hides
  Settle on mid-flight rows (`sessionIsMidFlight`).
- **Any turn start unsettles** (`sessionService.clearSettleOnTurnStart`, from
  `agentChatService.setSessionActive`). It clears the settle tuple only, never
  a `daex chat ask` hand.
- **Settled chats resume after a restart** like any other chat; the resumed
  turn unsettles them.
- **Terminals are never touched.**
- A subagent mid-turn refuses and is left as it is.
- Warm idle compaction skips settled chats (its turn would unsettle them).
- The retired `session_settle_residue` table is dropped at startup.

## 3a. Single settle writer

`settleLifecycleWriter.ts` is the only code that writes the **settle tuple**
(`settled_at`, `settle_override`, `settle_source`). Its colocated test scans
`apps/desktop/src` and `apps/ade-cli/src` for any other assignment, so a new
write path fails a test. The writer owns the whole tuple because a `'settled'`
override makes a row read as settled without touching `settled_at`.

Every transition bumps a per-session revision in `session_lifecycle_revisions`
(local only, in `LOCAL_ONLY_CRR_EXCLUDED_TABLES`) with one `insert … on conflict
do update set revision = revision + 1` right next to the column write. The
runtime is single-threaded and the bump cannot throw (it falls back to an
in-memory counter), so no reader sees the column change without the bump. The
read (`getSettleLifecycleRevision`) takes `max(table, in-process)`; 0 is a real
value. The bump costs about 6.6 µs on the output path (WAL,
`synchronous = NORMAL`), so it stays persisted.

Limits: a sibling process on the same database can read between column write
and bump (microseconds; `AdeDb` has no transaction helper), and a peer's write
arrives through `crsql_changes`, which §6d handles.

## 3b. The settling window

`settlingStateRegistry.ts` holds a short-lived marker per session while a
settle runs its check. It is:

- **exclusive:** a second settle joins the first (`joined_in_flight`);
- **abortable:** a human-decision clearer trips it;
- **in memory:** a restart has no settling sessions, which is the required
  answer (a settle is not resumable), and nothing replicates a flag that would
  lie after a crash. Each window has a token, so a stale owner cannot close a
  newer window.

Clearers carry a `cause`. During the window:

| Clearer | Effect |
|---------|--------|
| Turn start (`turn_start`) | Aborts the settle. |
| Turn failed (`turn_failed`) | Aborts; failure outranks settled. |
| `daex chat ask` (`attention_requested`) | Aborts; Needs you outranks settled. |
| Output preview, activity touch (`mechanical`) | Swallowed: does not clear `settled_at`, bump the revision, or abort. Preview columns still update. |

Outside the window all clearers clear normally.

## 3c. Outcomes

An abandoned settle is reported, never silent. `SettleSessionsOutcome` is
`{ settled, aborted: [{ sessionId, reason }] }` with reasons `turn_start`,
`turn_failed`, `attention_requested`, `remote_lifecycle_changed`,
`lifecycle_changed`, `turn_running`, `status_unknown`, `joined_in_flight`.
The desktop shows a quiet toast; the action registry and CTO tool return
per-session outcomes.

The sync command `session.settleSessions` still answers with the bare
changed-id list (iOS reads `.changedIdList`), so an aborted id is just absent;
the phone's pending overlay expires on its own (20 s). Changing the shape needs
a mobile-compatible addition.

PR-merge auto-settle (`prMergeAutoSettlementService`) leaves the PR unhandled
for an aborted session so a later pass retries, and defers before asking while
the chat has an active turn: `hasActiveChatTurn` reads `status` through the
injected `getChatLiveness` (built by `chatLivenessReader`, shared by desktop
`main.ts` and the brain's `bootstrap.ts`). A thrown read counts as active. Never
gate on the persisted row: it holds `running` between chat turns and for the
life of a CLI terminal. See
[Active-turn deferral](../pull-requests/README.md#active-turn-deferral).

## 3c-i. `settled_at` is host-authoritative

`terminal_sessions` is a CRR. A phone writing `settled_at` into its own replica
would win by merge over a host that refused the settle. So:

- iOS never writes the settle columns; its helper is
  `updateSessionSnoozeOverlay`. `PendingSessionSettleStates` is a local,
  non-persisted overlay that resolves when the host's changeset arrives, the
  command fails, or a staleness backstop fires. Snooze keeps its optimistic
  write and rollback.
- `syncHostService` drops inbound `settled_at`, `settle_override` and
  `settle_source` changes from phone peers (`isMobilePeer`, resolved from the
  pairing record) per column and silently, and still acks the batch. Paired
  desktops keep replicating: they run the same writer.

## 6d. Peer tuple writes

`db.sync.applyChanges` applies an inbound settle-tuple change **normally**,
then tells the session layer which sessions and columns moved. The session
layer re-asserts the tuple through the writer as a self-assignment: the
revision bumps, but cr-sqlite records no new column version, so nothing echoes.
CRR owns the values; the writer owns the revision.

Do not hold such changes back from `crsql_changes`: merges are last-writer-wins
per column version, and a host that never raises its counter loses every later
decision to every peer.

- The peer write also aborts any open window (`remote_lifecycle_changed`),
  because the revision is re-read only after the check.
- Only changes cr-sqlite accepted are reported (a re-delivered batch is
  ignored).
- Both processes register the hook through `createSettleWiring`; in a normal
  install the brain applies changesets and serves the phone.
- Per session, best effort; only a single TEXT primary key is decoded.
- `onRemoteSettleWrite` counts how often this runs (once per changeset). It is
  not an anomaly signal: a second desktop's settles land here by design.
