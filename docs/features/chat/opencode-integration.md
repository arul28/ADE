# OpenCode integration

How ADE drives OpenCode: which data home a server writes, which runner owns a
turn, how steering behaves, and the invariants that keep a wedged child session
from looking healthy. Read this before changing
`apps/desktop/src/main/services/opencode/**` or the OpenCode branch of
`agentChatService.ts`.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/opencode/openCodeServerManager.ts` | Owns the `opencode serve` processes: lease kinds (`shared` / `dedicated`), the generated `OPENCODE_CONFIG_CONTENT` plus the v2 config file (`OPENCODE_CONFIG` under `config-v2/<fingerprint>.json`), the ADE-owned XDG data/state/cache home, auth seeding (including `OPENCODE_AUTH_CONTENT` for the v2 Auth service), automatic store retention, orphan recovery, and the launch spec per data home. |
| `apps/desktop/src/main/services/opencode/openCodeRuntime.ts` | The SDK client boundary: session start (v2 create/resume, legacy-home continuity), the legacy `/event` stream, prompt-part construction, and the one-shot `runOpenCodeTextPrompt` helper (v2). |
| `apps/desktop/src/main/services/opencode/openCodeV2Events.ts` | The v2 runner's wire boundary: `session.next.*` (and `permission.v2.*` / `question.v2.*`) are normalized into the legacy event shapes the turn loop consumes; child sessions are discovered through `v2.session.get`; `mergeOpenCodeV2IdleReceipt` injects the `session.wait` idle; `mapOpenCodeV2MessagesToLegacyRows` serves reopened transcripts. |
| `apps/desktop/src/main/services/opencode/openCodeIdleProbe.ts` | Wraps an event stream: when it is quiet, asks the server for status and synthesizes an idle for sessions it no longer reports busy. Bounded probe failures end the turn instead of waiting forever. |
| `apps/desktop/src/main/services/opencode/openCodeAuthService.ts` | Login/logout through the OpenCode server, plus ADE's encrypted key store. |
| `apps/desktop/src/main/services/chat/agentChatService.ts` | The turn loop: dispatch, the `AgentChatEvent` mapping, pending approvals/questions (parent and child), subagent lifecycle, steering, and status. |
| `apps/desktop/src/shared/opencodeStoreMaintenance.ts`, `apps/ade-cli/src/commands/openCodeCleanup.ts` | The prune engine shared by `ade storage opencode` and the automatic retention policy. |

## Data homes

ADE-managed servers write **ADE's owned data home**, not the user's personal
OpenCode store: `XDG_DATA_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME` are
forced to `<ADE runtime root>/xdg-v1/{data,state,cache}`. The user's *config*
still loads (project config and `~/.config/opencode` are untouched); ADE's
generated config then merges on top.

- Why: OpenCode's `event` table is append-only and snapshots whole messages,
  `summary.diffs[].patch` included. On one real machine it was 11.5 GB of a
  12.5 GB store, with 621 rows over 1 MB and a largest row of 88 MB. ADE chats
  were the writers. Restarting from a deleted store only regrows the same way.
- **Config transport.** The legacy client read the generated config from
  `OPENCODE_CONFIG_CONTENT`; the v2 config service never does. For every
  non-user data home ADE also writes the same generated config to
  `<root>/config-v2/<sha256>.json` and points `OPENCODE_CONFIG` at it, so the
  user's own `opencode.json` keeps loading underneath and ADE's providers and
  `ade-plan`/`ade-edit`/`ade-full-auto` agents merge on top. ADE never writes
  into the user's config home, and `OPENCODE_CONFIG_CONTENT` is still set for
  any legacy reader.
- **Auth.** The first launch copies the user's `<user data>/opencode/auth.json`
  into the owned home (never overwriting an existing copy, so OAuth refresh in
  the owned copy survives). Config-provided API keys from ADE's encrypted store
  flow through the generated config as before. The v2 Auth service additionally
  reads `OPENCODE_AUTH_CONTENT` and not the legacy file path, so owned and
  isolated servers get the owned `auth.json` content through that variable;
  a user-provided value always wins, and user-home servers are untouched.
- **Continuity.** A chat whose persisted `providerSessionId` predates owned
  storage exists only in the user's store. On resume, the owned home's 404 for
  that id falls back to a **user-home server for that session** rather than
  creating a fresh empty session. A session missing from both homes is recreated
  on the v2 runner and logged `opencode.session_recreated_missing`. New sessions
  never use the user home.
- **Pruning.** `ade storage opencode` targets ADE's store by default
  (`--store user` for the personal one), is a dry run unless `--apply`, deletes
  whole sessions including their `event_sequence` row (which cascades the event
  log) exactly like OpenCode's own `Session.remove`, and only shrinks the file
  with `--vacuum` while no server is writing. In addition, every owned-server
  acquisition runs the bounded **automatic retention policy** (throttled to once
  per `OPENCODE_STORE_RETENTION_INTERVAL_MS`, only when the database is at or
  above `OPENCODE_STORE_RETENTION_MIN_FILE_BYTES`, only sessions untouched for
  `OPENCODE_STORE_RETENTION_MAX_AGE_MS`, VACUUM only when no writer holds it).
  It never throws and never touches the user's store.

## Runners

A session is owned by exactly one runner, persisted in its handle:

- **`v2`** — the runner every new chat is created on. Session create and resume
  use `POST /api/session`, the model/agent live on the session
  (`session.switchModel` / `session.switchAgent` before the first prompt), turns
  dispatch with `POST /api/session/{id}/prompt` (`delivery: "queue"`), and the
  turn consumes `/api/event`.
- **`legacy`** — a chat whose persisted `providerSessionId` exists only on the
  legacy read model (`message`/`part`), which the v2 runner cannot read. Those
  chats keep running on `session.promptAsync` + `/event` exactly as before; they
  cannot take a mid-turn message and the host rejects an inline dispatch on them
  with an explicit error instead of staging the old lie. New chats are never
  legacy.

The event boundary is `OpenCodeRuntimeEvent`: `openCodeV2Events.ts` maps
`session.next.step.started/ended`, text/reasoning deltas, tool
input/called/progress/success/failed, retried, compaction, `permission.v2.asked`,
and `question.v2.asked` onto the legacy shapes, so the turn loop, the pending
input pipeline, and the transcript mappers are shared across both runners. No
v2 wire shape reaches the renderer.

### Completion

The v2 stream has no `session.idle`. A turn ends through three signals, in
order of authority:

1. `POST /api/session/{id}/wait` resolving 204 (`mergeOpenCodeV2IdleReceipt`
   yields the parent and child idles). On 1.18.32 this route answers
   `503 "Session wait is not available yet"`, so it is an accelerator, not the
   contract.
2. The idle probe's `session.active` check: a session absent from the map is
   idle. While the parent drain runs, every known child is reported busy so a
   slow child is never synthesized finished early.
3. Probe failures are bounded exactly as on the legacy runner (a server that
   stops answering ends the turn with an explicit `session.error`).

Interrupt/stop uses `session.interrupt` on a v2 session and `session.abort` on a
legacy one.

## Steering

`ACTIVE_TURN_DISPATCH_MODES.opencode = ["inline", "queue"]` (iOS mirrors it).
The composer's default for a live OpenCode turn is inline.

1. ADE admits the message with `delivery: "steer"` and reads the admitted
   message id from the response.
2. The transcript row reads "Steering…" (`accepted`) while it awaits evidence.
3. `session.next.prompted` for that message id is the only signal that moves the
   row to "Steered" (`inline`). The v2 loop promotes a steer at the next step
   boundary and does not end the drain unpromoted; a steer admitted after the
   final step still starts another step (verified against 1.18.32).
4. If the turn ends without promotion — an abort, a stream failure — the row
   reads `queued` (clean end) or `failed` (aborted/failed), never "Steered".
5. If the prompt request itself fails, nothing is lost: the message goes back on
   ADE's queue, its row reads `queued`, and the turn boundary delivers it as the
   next turn.

`dispatchSteer` ("send now" on a staged row) promotes a row through the same
`delivery: "steer"` admission and the same `accepted → inline/queued` ladder. A
legacy session rejects the dispatch rather than restaging.

## System prompt

The v2 prompt body has no `system` field. The generated config's agents carry
their permission blocks but no session-specific system text: including it would
make every chat's config unique and give each chat its own server. Instead, the
same assembled system prompt the legacy runner passed as `system` is delivered
as the session's **first prompt context**, wrapped in
`<ade-system-context> … </ade-system-context>`, once per runtime incarnation.
Later turns do not re-send it. Residual differences from the legacy runner:
the model sees the text as the first user message rather than a system role, and
a chat reopened in a new runtime incarnation sends it again. The one-shot
`runOpenCodeTextPrompt` uses the same marker for its `system` argument.

## Child sessions, permissions, and status

- A subagent is an OpenCode child session (`parentID` = the chat's session). On
  the v2 runner there is no `session.created` on `/api/event`: the adapter sees
  an unknown session id, calls `v2.session.get` once, and — when `parentID` is
  this chat — emits a synthesized legacy `session.created` before the child's
  first event. Any other unknown session shares the server and is dropped.
- Child `permission.v2.asked` / `question.v2.asked` events are **admitted into
  the parent chat's pending inputs** and attributed to the child. Dropping them
  was what left a parent turn "running" for an hour while a child sat on an
  unanswered prompt.
- Replies route on the handle's runner, because the two services are different
  endpoints: a v2 ask is answered at
  `POST /api/session/{id}/permission/{requestID}/reply` (the legacy
  `/permission/{id}/reply` answers `PermissionNotFoundError` for it), and a v2
  question at `/api/session/{id}/question/{requestID}/reply|reject`. The child's
  own session id is used, never the parent's.
- `full-auto` auto-approves `external_directory` asks whose literal patterns sit
  inside `<project>/.ade` (which includes lane worktrees and ADE artifacts)
  before any card exists — for child asks too.
- A child parked on an ask reports `blockedReason` on its `subagent_progress`
  snapshot and the session-level `awaitingInput` state, so `ade chat status`
  returns `blocked` (exit 2). The child stays in the active tree (its status
  remains `running`); the reason field is what distinguishes parked from
  progressing, because the pane's snapshot reducer has no third lifecycle state.
- OpenCode's `task` tool has no directory argument; the child inherits the
  parent's directory, and the only path it reads is one the model typed. The
  system prompt therefore states the worktree path verbatim and forbids
  retyping, so a mistyped path cannot turn into an out-of-worktree ask.

## Idle and liveness

OpenCode's idle can be lost between SSE reconnections. While the stream is
quiet, the probe asks the server for status: sessions missing from the map (or
reported `idle`) get a synthetic idle. A `busy`/`retry` answer is a real
decision and is waited on indefinitely — a long tool call must never be killed.
A probe that fails outright or answers with only unusable statuses is bounded:
after `probeFailureLimit` consecutive failures the turn ends with an explicit
`session.error` instead of hanging. Ids that leave the wait set are forgotten so
a resumed child can be synthesized again.

## Subagent transcript times

OpenCode messages carry `info.time.created`; the transcript mapping lifts it to
`AgentChatClaudeSessionMessage.timestamp`. A v2 child's messages are mapped to
the same `{info, parts}` rows by `mapOpenCodeV2MessagesToLegacyRows`, so
drill-in renders through one mapper. Codex items inherit their turn's
`startedAt`; Claude's SDK object is read defensively. When no provider time
exists the row is marked `provenance.timestampSynthetic` and the client hides the
clock — the old `2026-01-01T00:00:00Z` placeholder rendered as "7:00 PM Dec 31"
in negative UTC offsets. Ordering still uses the placeholder; only display is
suppressed.

## Known boundary

Cross-machine fork of an OpenCode chat shells out to `opencode export`, which
reads the legacy read model; a v2 session's history is not part of that export
until OpenCode ships v2 export support. The ADE-side fork UI therefore falls
back to a brief for a v2 session whose export comes back empty.
