# Personal chats

Personal chats are machine-owned AI conversations with no project, lane,
branch or pull request. They use the same provider and model catalog as Work
chat, on desktop (the **Chats** tab, `/chats`), the hosted web client, the
iPhone and the CLI (`daex chat … --personal`; `ade` still works).

They stay on the machine that owns them. The account holds no copy and DAEX
Cloud does not run them. The web app and the iPhone list the chats of each
connected computer; a person with no computer online sees none.

## Source file map

| Path | Role |
|---|---|
| `apps/ade-cli/src/services/personalChats/personalChatScope.ts` | The machine-owned chat runtime: lazy start plus background prewarm when state exists, hidden state and scratch roots, repair of legacy session rows, the action allowlist, attachment confinement, terminal ownership, event stream and push subscription, caller MCP forwarding, and the `chat` / `embedded` runtime profile. |
| `apps/ade-cli/src/services/personalChats/embeddedHostSettings.ts`, `rpcArgs.ts` | Embedded-host settings and RPC argument parsing for the scope. |
| `apps/ade-cli/src/services/runtime/parentDeathWatchdog.ts` | Embedded profile: shuts the guest runtime down when `ADE_EMBEDDED_PARENT_PID` disappears. |
| `apps/ade-cli/src/services/projects/machineLayout.ts` | The channel-local `$ADE_HOME/personal-chats/{state,workspaces}` roots. |
| `apps/ade-cli/src/multiProjectRpcServer.ts` | Machine RPC methods `personalChats.call`, `personalChats.streamEvents`, `personalChats.subscribeEvents` / `unsubscribeEvents`, and capability advertisement. |
| `apps/ade-cli/src/cli.ts` | `daex chat … --personal`; requires the machine brain, never falls back to a project runtime. |
| `apps/ade-cli/src/services/sync/` (`syncService.ts`, `syncHostService.ts`, `syncRemoteCommandService.ts`) | Runtime-scoped `personalChats.*` sync commands, feature advertisement, policy descriptors, transcript subscriptions. |
| `apps/ade-cli/src/services/imageAttachment.ts` | Image validation, MIME sniffing and bounded temporary attachments (shared with project chat). |
| `apps/desktop/src/shared/types/personalChats.ts` | Cross-process actions, results, capabilities, queue policy, scope and events. |
| `apps/desktop/src/shared/callerMcpServers.ts` | Caller-MCP validation and the per-provider honesty table. |
| `apps/desktop/src/main/services/chat/personalSession.ts` | `isAssistantPersonalSession` / `isEmbeddedPersonalSession`, `PERSONAL_LANE_ONLY_AGENT_SKILLS`, both system prompts. |
| `apps/desktop/src/main/services/chat/agentChatService.ts` | The durable `personal` surface, reconstruction and repair, neutral guidance and environment, `adoptLegacyPersonalSessionAsAssistant`. |
| `apps/desktop/src/main/services/ipc/runtimeBridge.ts` | Routes personal-chat calls to the named local or remote machine. |
| `apps/desktop/src/main/services/builtInBrowser/builtInBrowserService.ts` | The global browser profile and the separate personal tab collection. |
| `apps/desktop/src/renderer/components/personalChats/PersonalChatsPage.tsx` | The Chats page: rail, model catalog, link routing, Browser/Terminal panels, and the real `AgentChatPane` scoped to the chat's machine. |
| `…/personalChats/personalChatMachines.ts` | Lists chats across connected machines, routes each machine's calls and stream, the new-chat machine picker. |
| `…/personalChats/personalAgentChatApi.ts` | Re-points the pane's `agentChat` API at `personalChats.*`; unsupported actions refuse instead of reaching a project runtime. |
| `…/personalChats/ProjectlessSidebar.tsx`, `sessionHelpers.ts` | The conversation rail (pinned, then by recency; search; machine badges; rename, pin, archive, delete) and its helpers. |
| `apps/desktop/src/renderer/components/chat/agentChatApi.tsx` | `ChatPaneScope` / `useAgentChatApi`; no scope means project chat. |
| `apps/desktop/src/renderer/components/chat/chatSurfaceTheme.ts` | Provider accent (`effectiveChatAccent`, `chatAccentContrast`). |
| `apps/desktop/src/renderer/components/app/` | `/chats` route and the machine-level Chats tab (`personalChatsTabOpen` in `state/appStore.ts`, rendered by `ShellNavTab.tsx`). |
| `apps/desktop/src/renderer/state/lastOpenChat.ts` | The last open chat per machine. |
| `apps/desktop/src/renderer/webclient/adapter/personalChats.ts`, `webclient/shell/` | Hosted web adapter and projectless routing. |
| `apps/ios/ADE/Views/PersonalChats/`, `apps/ios/ADE/Services/SyncService.swift` | iPhone list, new-chat and chat screens; runtime-scoped commands and subscriptions. |
| `packages/sdk/` | The embeddable sidecar that speaks this RPC ([DAEX SDK](../sdk/README.md)). |

## Gotchas / fragile areas

- **Never infer personal scope from a missing project id.** Require the
  personal RPC/action or `chatScope: "personal"`. Older project paths treat an
  unscoped subscription as the active project.
- **Never fall back to the active project.** An older runtime without the
  capability is an unsupported host, not a reason to create a project chat.
- **The hidden project and lane are internal.** They exist because the chat
  stack needs a lane id. Never register them in `projects.json`, show them in
  recents, lane lists or the iPhone roster, or offer lane, git, PR, worktree or
  **Open in** editor actions for them. Project delete cannot touch them.
- **Keep state and scratch roots separate.** The provider cwd must not expose
  the database or transcripts.
- **Preserve `surface: "personal"`** on reconstruction. Only the personal
  runtime may repair missing legacy markers; project runtimes never relabel.
- **Browser calls need `tabCollection: "personal"`**, or they land in the
  source window's project tab collection (auth storage is global either way).
- **Personal content is sensitive.** Never log prompts or message bodies in
  RPC or sync diagnostics.
- **No push or deeplinks** from the hidden runtime until they have a personal
  route; project links would open a Work surface.
- **Capabilities are optional.** Treat `pushEvents`, `mcpServers`,
  `updateMcpServers`, `mcpToolFilters`, `deferredMcpUpdates` as absent on older
  runtimes (they would ignore the fields or refuse mid-turn with
  `turn_in_flight`).
- **Strict MCP is a Claude-only guarantee.** Branch on `mcpCapability.level`,
  never on the object's presence ([SDK](../sdk/README.md#strict-mcp-honesty)).
- **`pendingInputs` is resident state only.** After a runtime restart it is
  empty; the provider processes that raised the requests are gone. An
  unanswered approval blocks the turn with no timeout.

## Storage and runtime scope

The machine runtime lazily creates a hidden state root under the channel's
`ADE_HOME` and a hidden primary lane. It is channel-scoped, so stable, beta and
dev homes do not share conversations. It runs no sync listener of its own.

Provider processes run in the separate workspace root. Their environment keeps
the session identity but drops `ADE_PROJECT_ROOT`, `ADE_WORKSPACE_ROOT`,
`ADE_REPO_ROOT`, `ADE_LANE_ID`, `INIT_CWD` and `OLDPWD`; `PWD` is the scratch
workspace.

## Protocol and capabilities

Machine RPC methods outside project dispatch:

- `personalChats.call({ action, args })`: one allowlisted action.
- `personalChats.streamEvents({ cursor, limit })`: drains the bounded chat/PTY
  event buffer (the one-shot CLI polls this).
- `personalChats.subscribeEvents` / `unsubscribeEvents`: push `runtime/event`
  (`scope: "personal"`, `projectId: null`). Not in the action registry, so not
  listed by `daex chat actions --personal`.
- `providers.status({ refresh? })`: what each CLI-backed provider is on this
  machine (binary, version, credentials, install and login commands), cached
  60 s; `refresh: true` is for "I just installed it", never a poll
  ([Provider status](../sdk/README.md#provider-status)).

`runtime/info.capabilities.personalChats` advertises version 1, the action set
and the optional flags above. Clients must gate the surface on it.

### Create arguments

- **Caller MCP** (`mcpServers`, tristate `strictMcpConfig`; see
  [Caller-injected MCP](../chat/README.md#caller-injected-mcp)). Accepted for
  Claude (`enforced`) and Codex, Cursor, Droid, OpenCode and Muse
  (`best-effort`); Pi and the rest refuse. No typed CLI flags; use
  `--arg-json`. Per-server `allowedTools` / `disallowedTools`: Codex enforces
  both (`enabled_tools` / `disabled_tools`); Claude enforces only
  `disallowedTools` (Agent SDK drops `mcp__<server>__<tool>`); every other
  provider refuses both (OpenCode because one shared server config serves all
  personal chats). Refusals are `invalid_argument` at create, `updateSession`
  and a model switch.
- **`updateSession({ mcpServers })`** replaces the servers. Between turns it
  restarts the provider on the same thread. Mid-turn it validates now and
  queues until the turn ends (on Claude, also until background agents and
  shells finish). Until then the summary has `mcpServersPending: true`. The
  queue is in memory only.
- **`instructions`** (`{ mode: "append" | "replace", text }` or a string =
  append), **`requestedCwd`** (absolute dir replacing the scratch workspace),
  **`settingSources`** (`none | project | user | all`). The session carries
  `instructionsCapability` and `settingSourcesCapability`
  ([per-provider tables](../sdk/README.md#instructions-cwd-settingsources)).
- `requestedCwd` is validated before any row is written (`invalid_argument:`):
  refused if relative, `~…`, a filesystem or drive root, a bare UNC share, the
  home dir, or inside DAEX's state dir. It is created at 0755 and
  canonicalized (symlinks resolved, real casing on Windows) before the check
  and before storing, so a symlink or case variant cannot slip into DAEX's
  state.
- **`permissionPolicy`**: see
  [Caller-supplied permission policy](../chat/README.md#caller-supplied-permission-policy);
  read `permissionCapability.level`.

### Approvals

`approve({ sessionId, itemId, decision, responseText? })` with `accept`,
`accept_for_session`, `decline` or `cancel`. `pendingInputs({ sessionId })`
lists open requests so a reloaded host can redraw cards; it includes
`question`, `structured_question`, `plan_approval` and `model_selection`, which
`approve` cannot answer (the SDK refuses them with `invalid_option`).

### Other actions

List/create/read/send and turn controls, metadata (`setPinned`), the composer's
`slashCommands`, scheduled-work create/cancel/pause (rechecked to belong to
`surface: "personal"`), model inventory, paged history, attachments, image
readback, row reports (`setSessionActivity`, `setSessionStatusNote`,
`requestSessionAttention`) and a chat-owned shell PTY.

- Attachments: any type up to the 10 MB base64 cap; declared images are
  sniffed. Bytes go under a fresh UUID name in the hidden store. There is no
  path-copy route, because paired clients can reach `personalChats.call`.
- Image readback refuses anything outside the attachment store, artifact store
  and scratch workspace. Terminal calls check the PTY belongs to this scope.
- Transcripts use the project chat pager (1,000 events / 256 KiB first page,
  256 KiB older pages, 60,000 events / 32 MiB view cap).

Over sync the actions are `personalChats.*` with `scope: "runtime"` (no
`projectId`). Only `send` is offline-queueable; create and scheduled-work
mutations need a live host. Create is owner-only; paired viewers may pause,
resume or cancel schedules.

## Client routing

Desktop calls the machine RPC directly; web and iPhone use runtime-scoped sync
commands. The chat stream carries `chatScope: "personal"`.

The rail lists the chats of every connected machine at once
(`personalChatMachines.ts`). Each machine is read separately with a timeout. A
row's id is machine + session id, and every row action names its machine in
`PersonalChatMachineTarget` (`THIS_MACHINE_ID` = this computer, from
`shared/machineIdentity.ts`). The picker beside the composer only chooses where
a **new** chat runs; nothing on the page moves the window's project tab. The
Browser tab's docked chat runs on the window's machine, so "Open in the
Browser tab" is offered only for that machine's chats.

The Chats tab is machine-level: `personalChatsTabOpen` (session-only) holds its
existence, the route its active state. The page reopens the last open chat per
machine and starts a new one only after **New**. A new draft remembers the last
model and thinking level per machine.

```bash
daex chat list --personal --text
daex chat create --personal --provider codex --model openai/gpt-6.2-sol --prompt "Help me plan a trip"
daex chat create --personal --provider claude --model anthropic/claude-opus-5-5 \
  --arg-json mcpServers='{"docs":{"type":"http","url":"https://mcp.example/mcp"}}'
daex chat send <session-id> --personal --text "Make it a three-day itinerary"
```

Project and personal flags are mutually exclusive; Linear flags are rejected.

## Profiles: `assistant` and `embedded`

Every chat has a persisted `personalProfile`:

- **`assistant`**: chats from DAEX's own Chats pages (desktop, web, iPhone) and
  from `daex chat create --personal` (CLI default).
- **`embedded`**: the SDK-host surface.

**Absent means `embedded`, everywhere**, so nothing gains skills or user MCP by
omission. `daex runtime run --profile embedded` forces `embedded`.

**Legacy rows are upgraded by use.** DAEX's own surfaces send
`personalProfile: "assistant"` as a claim (`PersonalChatAssistantClaim`) on
`getSummary`, `send` and `steer` (iPhone on `send`; CLI on `send|steer`). A
claimed chat with no profile becomes `assistant`, and an idle provider process
under the old profile is stopped. An explicit `embedded`, an embedded runtime,
or a call without the claim (every SDK call) never upgrades.

| | `assistant` | `embedded` |
|---|---|---|
| Session profile | `workflow` (tool gate, cards, hooks) | `light` |
| Prompt | Assistant prompt: shell, files, DAEX browser, computer use, App Control, the `daex` CLI, the scratch workspace or host folder | Neutral general-assistant prompt |
| DAEX skills | Bundled catalog minus `daex-lanes-git` and `daex-pr-workflows`, through the same per-provider channels as Work chats. Withheld skills are removed by a filtered mirror of the root (`withoutAgentSkills`), since no provider takes a per-skill deny list. | None (Pi reads the env roots) |
| Claude `settingSources` | Caller's value, else `user` (`all` in a user-named folder) | Caller's value, else `none` |
| Pi extensions | Load | Off |
| DAEX browser | `ADE_CHAT_SCOPE=personal` puts tabs in the personal collection (`scopeBuiltInBrowserAdeActionArgs`) | Unchanged |

Row reports are on for `assistant`. The personal runtime has no socket, so the
CLI routes `daex chat activity|note|ask` through the brain with `--personal`
or `ADE_CHAT_SCOPE=personal` (set in every personal chat's environment); the
prompt spells `--personal --session <id>` so OpenCode's shared server, which
has neither variable, works too.

Off for both, on purpose: planning mode, lane guidance and memory, the
worktree directive, the computer-use proof directive. OpenCode shares one
personal server, so assistant OpenCode chats learn skills from the prompt's
roots, not `skills.paths`. A Cursor run moved to the cloud gets the neutral
prompt for both profiles.

## Agent behavior

The session summary carries `surface: "personal"`. A personal chat's shell
runs the CLI at role `agent`. With `--project-root <path>` it can list, read,
create and message chats in any project on this machine, and with `--machine`
on the account's other machines; a child it starts reports back through the
brain's cross-scope router
([Cross-machine agents](../sync-and-multi-device/cross-machine-agents.md)). It
cannot settle sessions or run CTO-only actions and has no durable memory.
Create strips project-only fields (lane/cwd, automation ownership, persistent
identity).

An embedded sidecar uses this scope too; its profile withholds machine-update
and power controls and forces sync off.

## Surfaces

- **Desktop:** works with no project. The pane is `AgentChatPane` with a
  personal `ChatPaneScope`: full composer (no planning modes), transcript and
  approval cards, lane/git/PR/worktree chrome hidden. Suggestion chips fill
  the draft on a new chat (`emptyStateAccessory`, `composerHandleRef`).
  Hidden for now (no backend action): fork, rewind, handoff, import, Codex
  goals, transcript recovery.
- **DAEX browser:** transcript links open the page's Browser panel in the
  personal collection, or the Browser top tab (`/browser`, `BrowserPage.tsx`)
  when it is open. The Browser tab's **Ask agent** docks an assistant personal
  chat with the front tab attached (`formatBrowserTabMentionToken`,
  `handTabToChat`). See "The Browser top tab" in
  [chat/README.md](../chat/README.md).
- **Hosted web:** `/chats` without a project; no local database; terminal IO
  runs on the paired machine.
- **iPhone:** the Hub card is the only entry. The list merges every live
  machine advertising `personalChats.list` (each with a timeout; a failed one
  keeps cached rows with Retry); new chats have a machine picker. Chat Info
  offers schedule Cancel and Pause/Resume; creating schedules stays API-only.
