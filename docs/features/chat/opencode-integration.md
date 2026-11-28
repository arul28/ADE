# OpenCode integration

How DAEX drives OpenCode 2.0 in chat: servers, data home, turns, steering,
permissions, subagents and background shells. Read before changing
`apps/desktop/src/main/services/opencode/**`, the OpenCode block of
`agentChatService.ts`, or `openCodeEventMapper.ts`.

DAEX pins `@opencode/cli` and `@opencode/client` at **2.0.29** exactly
(`apps/desktop/package.json`, `apps/ade-cli/package.json`). There is no 1.x
path.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/opencode/openCodeServer.ts` | `opencode serve` per profile: password auth, owned data home, config file, shared event stream and reconnect, idle shutdown, launch diagnostics. |
| `apps/desktop/src/main/services/opencode/openCodeServerOrphans.ts` | Orphan recovery (process listing incl. Windows, on-disk registry, stale config files). |
| `apps/desktop/src/main/services/opencode/openCodeConfig.ts` | Generated 2.0 config: providers, the `ade-plan` / `ade-edit` / `ade-full-auto` / `ade-helper` agents, MCP servers, skills, lane guard rules; profile selection (`sharedOpenCodeProfileFor`, `PERSONAL_OPENCODE_PROFILE`). |
| `apps/desktop/src/main/services/opencode/openCodeSession.ts` | Create/resume a session, instruction entry and shell env, personal-store guard, one-shot helper prompt. |
| `apps/desktop/src/main/services/chat/openCodeEventMapper.ts` | Pure mapping of execution events and stored messages to DAEX chat events. |
| `apps/desktop/src/main/services/chat/agentChatService.ts` (`startOpenCodeSessionRuntime`) | Chat runtime: session listener, turns, inbox rows, permission asks, forms, child sessions, reconnect reconciliation, server exit. |
| `apps/desktop/src/main/services/chat/openCodeBackgroundShells.ts` | Background shell tracker, one per runtime. |
| `apps/desktop/src/main/services/chat/openCodeTurnUsage.ts` | Turn usage and cost from step tokens. |
| `apps/desktop/src/main/services/opencode/openCodeAuthService.ts`, `openCodeInventory.ts` | Provider login via 2.0 integrations; model list with a disk cache. |
| `apps/desktop/src/main/services/opencode/openCodeAccounts.ts`, `openCodeCloudLoginSync.ts`, `openCodeCloudReadiness.ts` | Several logins per provider, cloud logins and their account sync, machine readiness for them. |
| `apps/desktop/src/renderer/components/settings/providers/opencode/OpenCodeAccounts.tsx` | Accounts list in a provider's Settings dialog. |

## Gotchas

- A model change starts a fresh OpenCode session with DAEX's reconstruction
  context.
- `session.wait`, instruction entries, export/import and `generate` are
  experimental upstream; DAEX relies on events, not `wait`.
- Upstream issue [#49765](https://github.com/anomalyco/opencode/issues/49765):
  a subagent ignores its agent's configured model.
- An attached terminal TUI gets `OPENCODE_SERVER_PASSWORD` in its PTY env, and a
  wrapping shell keeps it after the TUI exits. Accepted: the server listens on
  127.0.0.1 only.
- The host advertises `openCodeInboxSteer` in `hello_ok.features`; iOS offers
  "send during turn" only when present. The desktop renderer does not check it;
  an older remote brain rejects inline and queue still works.

## Servers and profiles

- A **profile** is a set of chats that can share one config. Ordinary lane
  chats, inventory, auth and one-shot tasks use the shared profile for the
  project's OpenCode settings (`sharedOpenCodeProfileFor`). Projects with equal
  settings share a server. Personal chats use `shared:personal` (no DAEX
  skills). A chat that needs its own config (own MCP servers, harness preset
  provider, strict MCP) gets a profile keyed by that content.
- One `opencode serve --hostname=127.0.0.1` per profile. Idle shutdown: shared
  10 min, per-chat 1 min (`SHARED_SERVER_IDLE_MS`, `PROFILE_SERVER_IDLE_MS`).
  Electron main and `daex serve` stop every server on exit.
- `OPENCODE_SERVER_PASSWORD` is random per start; the client sends Basic auth
  (user `opencode`). DAEX never uses `serve --service`.
- Config is a file named by `OPENCODE_CONFIG`
  (`<runtime root>/config-ade/<profile>.<pid>.<uuid>.json`), atomic, user-only.
  It holds provider keys, so it is deleted with its server (close, exit, failed
  launch, orphan recovery). OpenCode hot-reloads it. It layers over the user's
  global config; an isolated profile points `XDG_CONFIG_HOME` at an empty dir and
  sets `OPENCODE_DISABLE_PROJECT_CONFIG=1`.
- One `/api/event` subscription per server fans out to every session. 2.0
  streams do not replay, so the loop resubscribes with backoff and tells
  listeners about the gap; a chat reconciles with `session.active` /
  `session.get`. A 45 s silence watchdog reconnects a stalled stream.

## Data home and credentials

- Servers use DAEX's owned data home under `<ADE_HOME>/opencode-runtime/xdg-v1`.
  OpenCode 2.0 migrates any v1 store it opens in place, so DAEX never starts it
  on the user's personal store. A chat whose session exists only in the
  personal store is readable but cannot take turns
  (`OpenCodeSessionInPersonalStoreError`).
- 2.0 keeps no event log, so DAEX runs no pruning.
- DAEX API keys go in the generated config. OAuth goes through the 2.0
  integration flow in `auto` mode (browser page or device code). `startOAuth`
  reads providers from `integration.list`, which waits for the catalog
  (`integration.get` just after start reports providers missing).
- UI names: the `opencode` provider is **OpenCode Zen** (free models, no sign-in,
  so inventory `connected` is true before login; `signedIn` means "Connected");
  `opencode-go` is **OpenCode Go**, whose models come with the `opencode`
  account sign-in. Both are pinned above the catalog in Settings.

## Accounts and cloud logins

- OpenCode keeps every login in its `credential` table and uses one per provider
  machine-wide. A new login becomes active; `credential.activate` switches for
  every running chat's next request. While any OpenCode login exists for a
  provider, DAEX's own API key for it is not used.
- Settings → provider → **Accounts** (`ai.opencodeAccounts`,
  `opencodeAccountActivate`, `…Rename`, `…Remove`; all pinned to the page's
  machine). No secret leaves SQLite.
- **Cloud logins** are OpenCode `external` methods (`google-adc`,
  `aws-profile`, Azure when its CLI is installed). They name a machine login,
  never a token. `ai.opencodeCloudConnect` saves them to the account setting
  `opencodeCloudLogins` (scope `all`); each machine reconciles its store when
  accounts are listed (`cloud-logins-applied.json` records which came from the
  account). Rows show whether this machine has the ADC file or AWS profile.

## Lane guard

DAEX owns worktrees, so `OPENCODE_LANE_GUARD_RULES` go last on every DAEX agent
and every session (including `config-toml`): deny `opencode_worktree_create`,
`opencode_worktree_list`, `opencode_session_move` (removes them from the Code
Mode catalog) and `edit` on `.` (stops `worktree_remove` removing the chat's own
lane).

## Custom providers

Optional request compression (`settings.encoding`: gzip/zstd) and cache marker
style (`compatibility.cacheFormat`: anthropic/alibaba). Both off by default; an
endpoint that cannot read them rejects every request.

## Turns

- The runtime listens to its session for its whole life. **One OpenCode
  execution is one DAEX turn**: `session.execution.started` opens it (DAEX opens
  its own turn before sending), `succeeded | failed | interrupted` settles it.
- An execution DAEX did not start (a background child woke the parent) becomes a
  turn with no user message.
- Before a prompt, the runtime switches agent and model (with effort/Fast
  variant) only when changed, and updates the instruction entry when context
  changed.
- A prompt admitted but not started within 20 s
  (`OPENCODE_EXECUTION_START_TIMEOUT_MS`) is checked against the server.
- Server exit fails the open turn and tears the runtime down, keeping the
  session pointer; the next send starts a server and reopens it.
- A failed tool call is a failed tool row only; the turn continues, no chat
  `error` card.

## Steering and the queue

`ACTIVE_TURN_DISPATCH_MODES.opencode = ["inline", "queue"]`.

- A send during a turn goes to OpenCode's session inbox: inline =
  `delivery: "steer"` (next step boundary), queue = `delivery: "queue"` (after
  the current reply). Both land inside the running execution.
- The inbox is the source of truth; DAEX rows mirror it until
  `session.inbox.delivered` or `session.inbox.cancelled`. An outcome that
  arrives before the inbox id is held until the id arrives.
- Cancel = `inbox.cancel`; "send now" = `inbox.update(delivery: "steer")`.
  `stop_and_clear` cancels inbox rows then interrupts; `stop_only` keeps them.
- While a foreground subagent runs, the parent is inside one step, so a steer
  waits for the child.

## System prompt and environment

- The agent's `system` text leads the system prompt. DAEX's per-chat context is
  the session instruction entry `ade` (`<context key="ade">`); later changes
  arrive as context messages, keeping the prompt cache stable.
- OpenCode 2.0 reads `AGENTS.md` (not `CLAUDE.md`) and skills; no base prompt,
  no LSP.
- `session.environment` sets DAEX's agent env so `daex`/`ade` resolve to the
  chat, lane and workspace.

## Permissions and questions

- Rules are ordered, last match wins, after OpenCode's base policy.
  `ade-full-auto` = `* allow`; `ade-plan` denies edits and asks for shell, and the
  chat service answers a shell ask `once` when every parsed command only reads
  (`shellCommandIsReadOnlyOnPlatform`); `ade-edit` asks for edits and shell; `ade-helper` denies
  all side effects.
- Agent rules do not reach children (a child runs under its own agent), so the
  mode's rules are also set on the session (`openCodeSessionRulesFor`) and
  children inherit them. `config-toml` clears them.
- `permission.asked` (parent or child) becomes an approval card keyed by the
  tool call id; a child ask is attributed to the subagent and marks it blocked.
  The reply goes to `permission.reply` with the asking session and request id.
  "Allow always" saves a project-scoped OpenCode rule.
- The `question` tool arrives as `form.created` and maps to the structured
  question card (options → single choice, multiselect → multiple, `custom` →
  free text, boolean → yes/no); the answer goes to `session.form.reply` by
  field `key`.

## Subagents

- `session.created` with `parentID` starts a child (nested too); the card links
  to the starting tool call.
- A parent turn's cost includes children's spend since the last turn
  (`takeUnbilledOpenCodeChildCost`). A background child outlives the parent's
  turn; its completion starts a new parent turn.
- Drill-in reads `message.list` and maps each part.

## Background shells

- `shell` with `background: true` returns `metadata: { status: "running",
  shellID }`. The runtime tracks it (`openCodeBackgroundShellStarted`) and
  projects it onto the same `scheduled_work_update {kind: "background_task"}`
  rows as Claude's background commands.
- The end is the server-wide `shell.exited` / `shell.deleted`
  (`openCodeBackgroundShellEnded`); OpenCode then wakes the session. No exit
  code means a signal: reads as stopped. After a stream gap, `shell.list`
  settles shells that ended unseen.
- Live shells and children count as background workload, so the idle sweep and
  runtime budget keep the chat connected.
- Stop (`agentChat.stopTask`) kills the process tree
  (`killOpenCodeShellProcessTree`, `taskkill /T` on Windows) and settles the row
  only once the process is gone (up to 3 s). `stopTask` with a child's session
  id interrupts that child.
- A teardown (close, delete, model/provider switch, shutdown) settles live
  shells and children as stopped at once, kills in the background, and posts a
  notice. Logs: `agent_chat.opencode_runtime_teardown`,
  `agent_chat.opencode_stop_shell_unconfirmed`.

## Fork and handoff

- Local fork: `session.fork`.
- Cross-machine: `session.export` on the source; `session.import`, then
  `session.fork` and `session.move` to the destination lane.
