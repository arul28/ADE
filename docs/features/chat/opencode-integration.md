# OpenCode integration

How ADE drives OpenCode: which data home a server writes, how a turn is
dispatched, how steering behaves, and the invariants that keep a wedged child
session from looking healthy. Read this before changing
`apps/desktop/src/main/services/opencode/**` or the OpenCode branch of
`agentChatService.ts`.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/opencode/openCodeServerManager.ts` | Owns the `opencode serve` processes: lease kinds (`shared` / `dedicated`), the generated `OPENCODE_CONFIG_CONTENT` (ADE's `ade-plan`/`ade-edit`/`ade-full-auto`/`ade-helper` agents and provider keys), the ADE-owned XDG data/state/cache home, auth seeding, orphan recovery, and the launch spec per data home. |
| `apps/desktop/src/main/services/opencode/openCodeRuntime.ts` | The SDK client boundary: session start (including legacy-home continuity), the `/event` stream, prompt-part construction, and the one-shot `runOpenCodeTextPrompt` helper. |
| `apps/desktop/src/main/services/opencode/openCodeIdleProbe.ts` | Wraps the event stream: when it is quiet, asks `GET /session/status` and synthesizes an idle for sessions the server no longer reports busy. Bounded probe failures end the turn instead of waiting forever. |
| `apps/desktop/src/main/services/opencode/openCodeAuthService.ts` | Login/logout through the OpenCode server, plus ADE's encrypted key store. |
| `apps/desktop/src/main/services/chat/agentChatService.ts` | The turn loop: dispatch, the `AgentChatEvent` mapping, pending approvals/questions (parent and child), subagent lifecycle, and status. |
| `apps/ade-cli/src/commands/openCodeCleanup.ts`, `apps/ade-cli/src/services/opencode/openCodeStoreMaintenance.ts` | `ade storage opencode`: dry-run/apply pruning of whole old sessions from an OpenCode store, with opt-in VACUUM. |

## Data homes

ADE-managed servers write **ADE's owned data home**, not the user's personal
OpenCode store: `XDG_DATA_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME` are
forced to `<ADE runtime root>/xdg-v1/{data,state,cache}`. The user's *config*
still loads (project config and `~/.config/opencode` are untouched), and ADE's
generated config merges last through `OPENCODE_CONFIG_CONTENT`.

- Why: OpenCode's `event` table is append-only and snapshots whole messages,
  `summary.diffs[].patch` included. On one real machine it was 11.5 GB of a
  12.5 GB store, with 621 rows over 1 MB and a largest row of 88 MB. ADE chats
  were the writers. Restarting from a deleted store only regrows the same way.
- Auth: the first launch copies the user's `<user data>/opencode/auth.json` into
  the owned home (never overwriting an existing copy, so OAuth refresh in the
  owned copy survives). Config-provided API keys from ADE's encrypted store flow
  through `OPENCODE_CONFIG_CONTENT` as before.
- Continuity: a chat whose persisted `providerSessionId` predates owned storage
  exists only in the user's store. On resume, the owned home's 404 for that id
  falls back to a **user-home server for that session** rather than creating a
  fresh empty session. A session missing from both homes is recreated and logged
  `opencode.session_recreated_missing`. New sessions never use the user home.
- Pruning: `ade storage opencode` targets ADE's store by default (`--store user`
  for the personal one), is a dry run unless `--apply`, deletes whole sessions
  including their `event_sequence` row (which cascades the event log) exactly
  like OpenCode's own `Session.remove`, and only shrinks the file with
  `--vacuum` while no server is writing.

## Turns and steering

Turns are dispatched with OpenCode's legacy `session.promptAsync`
(`/session/{id}/prompt_async`) and consumed from `/event`; the ADE
`AgentChatEvent` contract is the boundary, and no OpenCode wire shape reaches the
renderer.

**OpenCode is queue-only for active-turn messages**
(`ACTIVE_TURN_DISPATCH_MODES.opencode = ["queue"]`, mirrored by iOS). The legacy
runner has no drain for mid-turn input: a v2 `delivery: "steer"` admission lands
in the server's `session_input` table and is never promoted by the loop that is
actually running (the promotion code lives in the v2 runner, which the legacy
path never calls). Marking such a row "Steered" was a lie — the model never read
the message. The truthful behavior is staging: the message is delivered as the
next turn at the turn boundary, labeled as sent after the turn.

Re-enabling inline steering requires moving turns to the v2 runner
(`POST /api/session/{id}/prompt` with `delivery: "steer"`, model/agent switched
first). That migration is **not** a transport swap:

- Legacy and v2 read models are disjoint (`message`/`part` vs
  `session_message`/`session_input`), so an existing chat has no v2 history and
  a v2 runner would answer from an empty context.
- The v2 catalog does not read `OPENCODE_CONFIG_CONTENT`; providers and agents
  must be present as a config file in a config home the v2 config service loads.
- There is no per-prompt `system` on the v2 body; the legacy path passes ADE's
  assembled system prompt directly.
- The v2 stream has no `session.idle`; completion must come from
  `/api/session/{id}/wait` plus `/api/session/active`.

Until all four are handled, the table must not advertise inline steering.

## Child sessions, permissions, and status

- A subagent is an OpenCode child session (`parentID` = the chat's session).
  Child `permission.asked` / `question.asked` events are **admitted into the
  parent chat's pending inputs** and attributed to the child. Dropping them was
  what left a parent turn "running" for an hour while a child sat on an
  unanswered prompt.
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
`AgentChatClaudeSessionMessage.timestamp`. Codex items inherit their turn's
`startedAt`; Claude's SDK object is read defensively. When no provider time
exists the row is marked `provenance.timestampSynthetic` and the client hides the
clock — the old `2026-01-01T00:00:00Z` placeholder rendered as "7:00 PM Dec 31"
in negative UTC offsets. Ordering still uses the placeholder; only display is
suppressed.
