# OpenCode integration

How ADE drives OpenCode 2.0: which server a chat uses, which data home it
writes, how a turn maps to an OpenCode execution, how steering and the queue
work, and how subagents, permissions, and questions reach ADE. Read this before
changing `apps/desktop/src/main/services/opencode/**`, the OpenCode branch of
`agentChatService.ts`, or `openCodeEventMapper.ts`.

ADE pins OpenCode **2.0.18** exactly (`@opencode/cli`, `@opencode/client`).
There is no 1.x code path.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/opencode/openCodeServer.ts` | The `opencode serve` processes: one per profile, password auth, the owned data home, the hot-reloaded config file, the shared event stream with reconnect, idle shutdown, orphan recovery (including the Windows process listing and the on-disk registry), and launch diagnostics. |
| `apps/desktop/src/main/services/opencode/openCodeConfig.ts` | ADE's generated config in the native 2.0 shape: providers (ADE API keys, local providers, custom providers, preset providers), the `ade-plan` / `ade-edit` / `ade-full-auto` / `ade-helper` agents with ordered `permissions`, MCP servers, skills; and the profile a config belongs on. |
| `apps/desktop/src/main/services/opencode/openCodeSession.ts` | Create or resume a chat session, attach ADE's instruction entry and shell environment, prompt files, the personal-store guard, and the one-shot helper prompt. |
| `apps/desktop/src/main/services/chat/openCodeEventMapper.ts` | Pure mapping of one execution's content events (text, reasoning, tools, steps, usage, compaction, retries, tool images) to ADE chat events, and of stored messages to subagent transcript rows. |
| `apps/desktop/src/main/services/chat/agentChatService.ts` (OpenCode 2.0 runtime block, `startOpenCodeSessionRuntime`) | The chat runtime: the persistent session listener, turn start and finish, inbox rows (steer/queue), permission asks, question forms, child sessions, reconnect reconciliation, server exit. |
| `apps/desktop/src/main/services/chat/openCodeTurnUsage.ts` | Turn usage and cost from step tokens, and the account that paid. |
| `apps/desktop/src/main/services/opencode/openCodeAuthService.ts`, `openCodeInventory.ts` | Provider login through 2.0 integrations/credentials; the model list with a long-lived disk cache. |

## Servers and profiles

- A **profile** is a set of chats that can share one config. Every ordinary
  lane chat, the model inventory, auth, and one-shot tasks use the shared
  profile for their project's OpenCode settings (`sharedOpenCodeProfileFor`:
  `ai.apiKeys`, `localProviders`, `customProviders`, `customModelSlugs`).
  Projects with the same settings share one server; a brain serving projects
  with different settings runs one per set, so they never overwrite each
  other's config. Personal chats use `shared:personal` (they get no ADE skills). A
  chat whose config must differ — its own MCP servers (CTO tools), a harness
  preset provider, a strict MCP surface — gets a profile keyed by that content.
- One `opencode serve --hostname=127.0.0.1 --port=<p>` runs per profile. The
  shared server stays up for 10 minutes after its last lease; a per-chat
  profile for 1 minute. There is no pool of per-chat servers and no model-list
  server churn. The idle timer dies with its process, so both the Electron main
  process and the brain (`ade serve` disposal) stop every server on exit.
- Every server is password-protected: `OPENCODE_SERVER_PASSWORD` is random per
  start, and the client sends Basic auth (user `opencode`). ADE never uses the
  CLI's shared background service (`serve --service`,
  `~/.local/state/opencode/service.json`).
- Config reaches the server as a file named by `OPENCODE_CONFIG`
  (`<runtime root>/config-ade/<profile hash>.<pid>.<id>.json`, one per server
  start), written atomically and private to the user. It holds provider keys,
  so it lives only as long as its server: close, exit, a failed launch, and
  orphan recovery (through the registry record) delete it. OpenCode
  watches and hot-reloads it, so a new API key or local model applies to a
  running server. It layers over the user's global config
  (`XDG_CONFIG_HOME/opencode`), so the user's own providers, agents, skills,
  and MCP servers still load. An isolated profile points `XDG_CONFIG_HOME` at an
  empty ADE directory and sets `OPENCODE_DISABLE_PROJECT_CONFIG=1`.
- One `/api/event` subscription per server receives every session's events
  (all directories) and fans them out. 2.0 streams do not replay or reconnect,
  so the server loop resubscribes with backoff and tells listeners about the
  gap; a chat then reconciles against `session.active` and `session.get`.

## Data home

Servers write ADE's owned data home (`XDG_DATA_HOME/STATE/CACHE` under
`<ADE_HOME>/opencode-runtime/xdg-v1`). OpenCode 2.0 uses the same default
database path as 1.x and **migrates any v1 store it opens in place**, so ADE
never starts OpenCode on the user's personal store. ADE's own earlier sessions
in the owned store are migrated at the first 2.0 start and keep their ids.

A chat whose persisted session exists only in the user's personal store (from
before ADE owned a data home) stays readable from ADE's transcript but cannot
take new turns (`OpenCodeSessionInPersonalStoreError`).

2.0 stores no event log (the 1.x `event` table held 98% of a 16 GB store), so
ADE runs no retention or pruning.

Credentials: API keys ADE manages are passed in the generated config. OAuth
providers are connected through the 2.0 integration flow into the owned store.
2.0.18 does not import OAuth tokens from a 1.x `auth.json`; users sign in once.
Every OAuth method 2.0.18 offers (OpenAI browser and headless, GitHub Copilot,
xAI SuperGrok, OpenCode Console account, GitLab, Poe, DigitalOcean, Snowflake)
starts in `auto` mode: a browser page or a device code ADE shows, with no code
pasted back. `startOAuth` reads the provider from `integration.list`, which
waits for the location's catalog; `integration.get` just after a server start
reports real providers as missing. OpenCode Go has no OAuth method of its own:
its models come with the opencode.ai account sign-in on the `opencode` provider
(what `opencode auth login opencode` does; verified 2026-09-27, 33 Go models and
a completed Go turn). The Go dialog signs in through that provider; a Go key
stays an optional second method.

ADE names OpenCode's own services for users: the `opencode` provider (2.0 calls
it "OpenCode Console") is **OpenCode Zen**, and `opencode-go` is **OpenCode Go**.
Settings pins both above the provider catalog. Zen serves free models with no
sign-in, so the inventory's `connected` is true for it before any login;
`signedIn` (the integration has a connection) is what "Connected" means for a
provider that offers a sign-in.

## Turns

- A chat runtime listens to its session for its whole life. **One OpenCode
  execution is one ADE turn.** `session.execution.started` opens it (ADE opens
  its own turns before sending, so the prompt cannot race the event);
  `session.execution.succeeded | failed | interrupted` settles it.
- An execution ADE did not start — a background subagent finished and woke the
  parent — becomes a turn with no user message, exactly like Claude and Codex.
- Before a prompt, the runtime switches the session's agent (permissions) and
  model (with the effort/Fast variant) only when they changed, and updates the
  instruction entry when ADE's context changed.
- A prompt OpenCode admitted but never ran is checked after 20 s against the
  server rather than left on "Working".
- If the server process exits, the open turn fails with a clear message and
  the runtime is torn down with its session pointer kept; the next send starts a
  new server and reopens the session.

## Steering and the queue

`ACTIVE_TURN_DISPATCH_MODES.opencode = ["inline", "queue"]` (iOS mirrors it).

- A message sent while a turn runs is admitted to OpenCode's session inbox:
  "inline" with `delivery: "steer"` (delivered at the next step boundary),
  "queue" with `delivery: "queue"` (delivered after the current reply). Both are
  delivered **inside the running execution**.
- OpenCode's inbox is the single source of truth. ADE's rows mirror it: a row
  reads "Steering…" or queued until `session.inbox.delivered` (then "Steered")
  or `session.inbox.cancelled`. An outcome that arrives before the prompt
  request returns its inbox id is held and applied when the id arrives.
- Cancel is `inbox.cancel`; "send now" is `inbox.update(delivery: "steer")`.
- Stop (`stop_and_clear`) cancels the inbox rows, then interrupts. `stop_only`
  keeps them, and OpenCode continues with them after the interrupt.
- A steer reaches the model only at a step boundary. While a foreground
  subagent runs, the parent is inside one step, so a steer waits for the child.

## System prompt and environment

- The agent's `system` text is the first block of the real system prompt. ADE's
  per-chat context (worktree, lineage, activity guidance) is the session
  instruction entry `ade`, which OpenCode puts in the system prompt as
  `<context key="ade">`; a later change reaches the model as a context message
  at the next step, which keeps the prompt cache stable.
- 2.0 has no OpenCode base prompt; `AGENTS.md` and skills are included. It reads
  only `AGENTS.md` (no `CLAUDE.md` fallback) and runs no LSP.
- `session.environment` sets the shell environment of the session's commands
  to ADE's agent environment, so `ade` resolves and knows the chat, lane, and
  workspace.

## Permissions and questions

- Rules are ordered and the last match wins, after OpenCode's base policy
  (`* allow`, asks for external directories and `.env` reads). `ade-full-auto`
  is `* allow`; `ade-plan` denies edits, web search, and skills and
  asks for shell; `ade-edit` asks for edits and shell; `ade-helper` denies all
  side effects.
- Agent rules stop at the agent: a child runs under its own agent (`general`
  allows edits). So ADE also puts the mode's rules on the session itself
  (`session.create` / `session.update` `permissions`, `openCodeSessionRulesFor`),
  and a child session inherits those. `config-toml` clears them.
- `permission.asked` (parent or child) becomes an ADE approval card, attributed
  to the subagent for a child ask, with the child marked blocked. The pending
  entry is keyed by the card's item id (the tool call id), which is what an
  answer carries back. The reply goes to `permission.reply` with the asking
  session's id and the request id. "Allow always" saves a
  project-scoped allow rule in OpenCode, as OpenCode does.
- The `question` tool arrives as `form.created`. Its fields map to ADE's
  structured question card (string with options → single choice, multiselect →
  multiple choice, `custom` → free text, boolean → yes/no); the answer goes to
  `session.form.reply` keyed by field `key`. A form answered elsewhere cancels
  only its own card.

## Subagents

- The `subagent` tool starts a child session; its `session.created` carries
  `parentID` (nested children are tracked too). The child card links to the
  tool call that started it and carries the call's description.
- Children report usage from their steps and settle on their own execution
  events. A background child keeps running after the parent's turn ends; its
  completion starts a new parent turn.
- Drill-in reads the child's stored messages (`message.list`) and maps each
  part to a formed chat event.

## Background shells

- `shell` with `background: true` returns at once with
  `metadata: { status: "running", shellID }`; the command keeps running inside
  the OpenCode server. The runtime tracks it in `backgroundShells` from that
  `session.tool.success` (`openCodeBackgroundShellStarted`) and projects it onto
  the same `scheduled_work_update {kind: "background_task"}` rows Claude's
  background commands use: a live job line with a timer and Stop in the thread,
  the Background popover, and **Background work** on the Work row.
- The end comes from the server-wide `shell.exited` (or `shell.deleted`) event,
  which carries only the shell id (`openCodeBackgroundShellEnded`). OpenCode
  then wakes the session itself, and that execution becomes a turn with no user
  message. `session.synthetic` with `metadata.source: "shell"` is also accepted,
  though 2.0.18 does not publish it on the event bus. An `exited` shell with no
  exit code died from a signal and reads as stopped.
- A live shell or child counts as background workload, so the idle sweep and
  the runtime budget leave the chat connected (and its hold on the shared
  server in place) until it ends. The three-hour stale-work backstop applies.
- The tracker lives in `openCodeBackgroundShells.ts`, one per runtime.
- Stop on a job row (`agentChat.stopTask`) and the interrupt modes that stop
  background work kill the shell's process tree (`killOpenCodeShellProcessTree`;
  `taskkill /T` on Windows) and settle the row only once the process is gone
  (up to 3 s); a shell that survives stays visible as running and Stop reports
  why. OpenCode then tells the agent the command was killed. Deleting the shell
  record instead made the agent read a stopped command as one that never
  started. `stopTask` with a running child's session id interrupts that child.
- A teardown that stops listening (close, delete, model switch, provider
  switch, shutdown) cannot wait, so it settles every live shell and child as
  stopped at once, kills in the background, and posts a notice naming the
  cause, because no one would hear their wake-up. A kill it cannot confirm logs
  `agent_chat.opencode_stop_shell_unconfirmed`; the shared server's own
  shutdown then ends that process.
  `agent_chat.opencode_runtime_teardown` logs each teardown with its reason and
  counts; `opencode.server_released` pairs with `opencode.server_acquired`.
- After a stream gap, `shell.list` settles shells that ended unseen. OpenCode
  drops a shell once its result is read, so a missing shell has ended.

## Tool failures

- A failed tool call is a failed tool row only (red, with the error sentence on
  the row). It does not end the turn — the model reads the error and continues —
  so it raises no chat-level `error` card.

## Fork and handoff

- Local fork: `session.fork`.
- Cross-machine fork: `session.export` (sanitized) on the source; on the
  destination `session.import`, then `session.fork` and `session.move` to the
  destination lane, then the runtime opens on the fork.

## Known boundaries

- A model change still starts a fresh OpenCode session with ADE's
  reconstruction context, as before.
- `session.wait`, instruction entries, export/import, and `generate` are marked
  experimental in 2.0.18; ADE depends on events more than on `wait`.
- OpenCode issue [#49765](https://github.com/anomalyco/opencode/issues/49765):
  a subagent ignores its agent's configured model in 2.0.8+.
- An attached terminal TUI gets `OPENCODE_SERVER_PASSWORD` in its PTY env. When
  the TUI runs through the user's shell, that shell keeps the variable after
  the TUI exits. The owner accepted this (2026-09-28): only programs the user
  starts in that tab can read it, and the server listens on 127.0.0.1 only.
- The host advertises `openCodeInboxSteer` in `hello_ok.features`; iOS offers
  OpenCode's "send during turn" only when it is present. The desktop renderer
  does not check it for a remote brain; an older remote brain rejects the
  inline send and queue still works (owner decision, 2026-09-28).
