# Personal chats

Personal chats are machine-owned AI conversations that are not attached to an
ADE project, lane, branch, or pull request. They use the same provider and model
catalog as Work chat, but present a general-purpose conversation surface on
desktop, the hosted web client, mobile, and the ADE CLI.

## Source file map

| Path | Role |
|---|---|
| `apps/ade-cli/src/services/personalChats/personalChatScope.ts` | Machine-owned chat runtime, existing-state background prewarm, hidden persistence/scratch roots, personal-surface recovery for legacy session rows, action allowlist (including scheduled-work create/cancel/pause), attachment confinement, terminal ownership, event stream, push `subscribeEvents`, caller MCP forwarding, orchestrator-lead refusal, and the `chat` / `embedded` runtime profile. |
| `apps/ade-cli/src/services/runtime/parentDeathWatchdog.ts` | Embedded-profile parent-death poll. An SDK sidecar sets `ADE_EMBEDDED_PARENT_PID`; if that process vanishes without unwinding, this guest runtime shuts itself down. |
| `apps/desktop/src/shared/callerMcpServers.ts` | Shared caller-MCP validation and per-provider honesty table. Personal create forwards `mcpServers` / `strictMcpConfig` into the chat service; Pi and invalid payloads fail closed. |
| `packages/sdk/` | Embeddable sidecar that speaks this machine RPC. See [ADE SDK](../sdk/README.md). |
| `apps/ade-cli/src/services/imageAttachment.ts` | Shared image validation, MIME sniffing, and bounded temporary-attachment persistence used by project and personal chat ingress. |
| `apps/ade-cli/src/services/projects/machineLayout.ts` | Resolves the channel-local `$ADE_HOME/personal-chats/{state,workspaces}` roots. |
| `apps/ade-cli/src/multiProjectRpcServer.ts` | Project-independent `personalChats.call`, `personalChats.streamEvents`, and `personalChats.subscribeEvents` / `unsubscribeEvents` machine RPC methods plus capability advertisement (`pushEvents`, `mcpServers`). |
| `apps/ade-cli/src/cli.ts` | Typed `ade chat ... --personal` commands; they require the machine brain and never fall back to a project/headless runtime. |
| `apps/ade-cli/src/services/sync/` | Runtime-scoped personal-chat commands, feature advertisement, policy descriptors, and personal transcript subscriptions for controllers. Primary files: `syncService.ts`, `syncHostService.ts`, and `syncRemoteCommandService.ts`. |
| `apps/desktop/src/shared/types/personalChats.ts` | Cross-process action, result, capability, queue-policy, scope, and event contracts, including the scheduled-work create/cancel/pause actions shared with project chat. |
| `apps/desktop/src/main/services/ipc/runtimeBridge.ts` | Routes a local/no-project window to the local brain and a remotely bound project window to that remote machine's personal-chat scope. |
| `apps/desktop/src/main/services/chat/agentChatService.ts` | Durable `personal` chat surface, persisted-surface reconstruction/repair support, and neutral provider guidance/environment. |
| `apps/desktop/src/renderer/components/personalChats/PersonalChatsPage.tsx` | Desktop projectless surface: independently loaded conversation list and model catalog, conversation stream, the hero-vs-docked composer switch once a session is selected, transcript, personal-scoped link routing, and compact Browser/Terminal tool panels. |
| `apps/desktop/src/renderer/components/personalChats/ProjectlessHero.tsx` | Empty-state hero shown before a session is picked — heading, verb-first suggestion chips that prefill the draft, and the docked composer slot. |
| `apps/desktop/src/renderer/components/personalChats/ProjectlessComposer.tsx` | Shared composer rendered in `hero` or `docked` variant, with model/reasoning/permission controls, send/interrupt, and provider-accent send button (`chatAccentContrast`). |
| `apps/desktop/src/renderer/components/personalChats/ProjectlessSidebar.tsx` | Stateful conversation rail: recency-grouped, searchable session list with new-chat and per-session selection state. |
| `apps/desktop/src/renderer/components/personalChats/sessionHelpers.ts` | Pure helpers for session title/preview, relative timestamps, and provider→tool-logo mapping shared by the page and sidebar. |
| `apps/desktop/src/renderer/components/chat/chatSurfaceTheme.ts` | Provider-accent theming for the surface, including `effectiveChatAccent` (accounts for the neutral chrome tint) and `chatAccentContrast` (readable glyph on the `--chat-accent` fill). |
| `apps/desktop/src/renderer/components/app/` | Global `/chats` route, sidebar entry, and project/no-project shell integration in `App.tsx`, `AppShell.tsx`, `TabNav.tsx` (sidebar Chats entry), and `TopBar.tsx`. The Chats top tab is a machine-level tab backed by `personalChatsTabOpen` in `state/appStore.ts` and rendered through the reusable `ShellNavTab.tsx` (shared by the Chats and New Tab shell tabs). |
| `apps/desktop/src/main/services/builtInBrowser/builtInBrowserService.ts` | Global authenticated browser profile plus an independent personal-chat tab collection. Cookies and site storage are shared with project browser collections; visible tabs are not. |
| `apps/desktop/src/renderer/webclient/adapter/personalChats.ts` | Hosted-web adapter over runtime-scoped sync commands. |
| `apps/desktop/src/renderer/webclient/shell/` | Projectless Chats entry and shell routing without choosing an active project in `WebClientRoot.tsx`, `WebShell.tsx`, and `ProjectPicker.tsx`. |
| `apps/ios/ADE/Views/PersonalChats/` | Native mobile list, new-chat, and chat destination flow. |
| `apps/ios/ADE/Services/SyncService.swift` | Runtime-scoped commands and personal chat subscription routing. |

## Storage and runtime scope

Personal chats deliberately do not make the existing project chat schema
nullable. The machine runtime lazily creates an internal state root beneath the
active channel's `ADE_HOME` and an internal primary lane because the mature
chat/provider/session stack requires a lane. That internal project and lane are
implementation details only:

- they are never registered in `projects.json`;
- they never appear in recents, project catalogs, lane lists, or the mobile
  all-project roster;
- state/transcripts and agent scratch files live in separate roots;
- project delete/forget operations cannot remove personal chat state.

The runtime is channel-scoped with the rest of ADE machine state, so stable,
beta, alpha, and isolated development homes do not share conversations. It is
chat-only and remains lazy for fresh installs; when existing personal-chat
state is present, the brain prewarms it in the background so opening Chats does
not pay the cold-start cost. It does not run its own sync listener and
suppresses the project-oriented push/deeplink publisher because those links
would otherwise open a project Work surface.

Personal-chat provider processes run from the separate workspace root. Their
environment retains the session identity needed by the provider bridge but
removes `ADE_PROJECT_ROOT`, `ADE_WORKSPACE_ROOT`, `ADE_REPO_ROOT`,
`ADE_LANE_ID`, `INIT_CWD`, and `OLDPWD`; `PWD` points at the personal scratch
workspace. The hidden lane exists for internal service compatibility, not as
agent-visible project context.

## Protocol and capabilities

The machine RPC exposes five methods outside project dispatch:

- `personalChats.call({ action, args })` executes one allowlisted action;
- `personalChats.streamEvents({ cursor, limit })` drains the personal runtime's
  bounded chat/PTY event buffer;
- `personalChats.subscribeEvents` / `personalChats.unsubscribeEvents` push
  `runtime/event` notifications (`scope: "personal"`, `projectId: null`) to a
  client holding the connection open. They are machine RPC methods, not entries
  in the `personalChats.call` action registry, so they are absent from
  `ade chat actions --personal`. The one-shot CLI still polls via
  `streamEvents`;
- `providers.status({ refresh? })` reports what each CLI-backed provider
  actually is on this machine — binary path, version, credentials, and the
  install and login commands ADE knows for it. It is a machine-scope method, not
  a `personalChats.call` action, advertised as
  `capabilities.providers = { status: true, cacheTtlMs: 60000 }`. Each record is
  cached 60 s; `refresh: true` bypasses that and is the "I just installed it"
  button, never a poll. See
  [Provider status](../sdk/README.md#provider-status).

`runtime/info.capabilities.personalChats` advertises version 1, the exact
action set, and two optional flags: `pushEvents` and `mcpServers`. An older
runtime omits both; a client must keep draining and must not send MCP fields
it would silently ignore. Clients must capability-gate the surface; an older
runtime is an unsupported host, not an invitation to create a normal project
chat.

`create` accepts caller-injected `mcpServers` and a tristate `strictMcpConfig`
(see [Caller-injected MCP](../chat/README.md#caller-injected-mcp)). There are
no typed `--mcp-servers` / `--strict-mcp` CLI flags in v1 — nested JSON is
what `--arg-json` already carries, and the ADE SDK is the intended embedder
API. The created session carries `mcpCapability`; branch on `level ===
"enforced"`, never on the object's presence.

`create` also accepts three host session arguments. `instructions`
(`{ mode: "append" | "replace", text }`, or a bare string meaning append)
replaces or extends ADE's own personal-chat prompt. `requestedCwd` names the
absolute directory the provider runs in, replacing the 0700 scratch workspace.
`settingSources` (`"none" | "project" | "user" | "all"`, default `"none"`) says
which on-disk configuration layers the provider loads. The created session
carries `instructionsCapability` and `settingSourcesCapability`; branch on
`level`, never on the object's presence. See
[Instructions, cwd, settingSources](../sdk/README.md#instructions-cwd-settingsources)
for the per-provider tables.

`requestedCwd` is validated in the scope before any session row is written, and
the refusal message starts with `invalid_argument:`. The scope refuses a relative
path, anything starting with `~`, a filesystem root, a Windows drive root, a bare
UNC share root, the home directory itself, and any path inside ADE's own state
directory. An accepted directory is created recursively at mode 0755, because the
reason a host names one is a folder the user can open. The default scratch
workspace is still created either way.

An accepted path is canonicalized before it is stored, resolving symlinks and,
on Windows, the real casing. The session summary echoes the canonical form, not
the caller's string. That is a containment rule rather than a tidiness one: a
symlink into ADE's own state directory, or a path differing only in case, would
otherwise pass a check the real directory fails. ADE's own directories are
canonicalized the same way before they are compared.

`create` also accepts a structured `permissionPolicy`, which is the third form
of the permission surface alongside the two presets. The created session carries
`permissionCapability`; branch on `level`, never on the object's presence. See
[Caller-supplied permission policy](../chat/README.md#caller-supplied-permission-policy).

Two actions serve the approval loop. `approve`
(`{ sessionId, itemId, decision, responseText? }`, decision one of `accept`,
`accept_for_session`, `decline`, `cancel`) answers one blocked request.
`pendingInputs` (`{ sessionId }` → `{ requests }`) lists every request still
awaiting an answer, so a host that reloaded its UI can redraw the cards. It is
read-only and viewer-allowed, and it reads resident runtime state only — after a
runtime restart it is empty, because the provider process that raised each
request died with it. An unanswered approval blocks the turn with no timeout.

`pendingInputs` lists question-shaped requests too — `question`,
`structured_question`, `plan_approval`, `model_selection` — because a host has
to redraw those cards as well. They cannot be answered through `approve`: they
want prose or a choice, and the engine would take the decision while the request
stayed unanswered. The SDK refuses them client-side with `invalid_option`.

Create refuses `interactionMode: "orchestrator-lead"` and
`orchestrationRole: "lead"`. A projectless chat that led a run would report
`strictRequested: false` while running under locked, always-strict lead
isolation. Start a lead inside a project instead.

The action family covers list/create/read/send and interactive turn controls,
session metadata/lifecycle, scheduled-work create/cancel/pause, model inventory,
paged event history, bounded image attachment ingress/readback, and a chat-owned
shell PTY. Scheduled-work mutations call the same chat service methods as
project chat after rechecking that the supplied session belongs to
`surface: "personal"`. Terminal calls also check that the PTY was created by
this personal scope. Attachment readback resolves real paths and refuses
anything outside the hidden attachment store.

Personal transcripts use the same bounded cursor pager as project chats:
1,000 events / 256 KiB for the initial snapshot, 256 KiB older pages, and a
60,000-event / 32 MiB selected-view cap. Paging survives empty physical
transcript regions, retains a retryable cursor on transport or protocol
failure, and rejects late responses after a chat switch or cursor change.
Manual retry is one immediate request; automatic near-top loading owns the
bounded retry ladder. Live events and older pages share the canonical
event-identity key so provider sequence numbers that restart do not collapse
distinct rows.

Over sync the same actions are registered as `personalChats.*` with
`scope: "runtime"`, so command envelopes carry no active `projectId` or project
root. Only `personalChats.send` is offline-queueable. Creating a conversation
requires a live host because there is no stable optimistic session id and
replaying a queued create could duplicate chats.
Scheduled-work create/cancel/pause are also live-only; controllers must gate
each control on the matching `personalChats.*` descriptor. Create remains
owner-only; paired viewers may pause/resume or cancel as recovery actions.

## Client routing

Desktop calls the machine RPC directly. A local or no-project window targets
the local ADE brain; a window opened against a remote runtime targets that
remote machine. The hosted web client and iOS use runtime-scoped sync commands,
so no active `projectId` is inferred or attached.

The shared chat stream carries `chatScope: "personal"`. That discriminator
routes transcript snapshots, live events, active-turn state, and interactive
follow-up actions through the personal scope. A missing project id alone must
never mean "personal": older project chat paths treat an unscoped subscription
as the active project.

On desktop, `/chats` is a global route surfaced through a real machine-level
**Chats** top tab rather than a route-derived pseudo-tab. Its existence is held
in session-only `personalChatsTabOpen` app state (set on any `/chats` visit —
from the projectless shell or a project's sidebar link); its active-ness is
derived from the current route. The tab is a plain clickable tab: clicking it
navigates to `/chats`, and it can sit alongside project tabs and the New Tab as
an inactive tab. While it is the foreground surface, the bound project tab
stays rendered but drops its active styling. Opening it as a global sidebar
surface while a project remains selected keeps the window's existing project
binding, so a remote-bound window still addresses the remote machine's personal
chats. Returning to a project route does not require reopening the project.

The page's machine picker rebinds that window, so its **This computer** option
resolves through `renderer/components/chat/thisMachineProjectRoot.ts`: it finds
*this repository's* local checkout by repo identity rather than taking whichever
local tab happens to be first, and reports "Open this repository on This computer
first, then switch back here." when there is none instead of silently switching
the window to an unrelated repo. Machine ids and the "This computer" name come
from `shared/machineIdentity.ts`.

The ADE CLI uses the same machine endpoint through explicit `--personal`
commands, for example:

```bash
ade chat list --personal --text
ade chat create --personal --provider codex --model openai/gpt-5.5 --prompt "Help me plan a trip"
ade chat create --personal --provider claude --model anthropic/claude-opus-5 \
  --arg-json mcpServers='{"docs":{"type":"http","url":"https://mcp.example/mcp"}}'
ade chat read <session-id> --personal --text
ade chat send <session-id> --personal --text "Make it a three-day itinerary"
```

Project and personal flags are mutually exclusive.

## Agent behavior

The public session summary carries `surface: "personal"`, while the synthetic
lane remains hidden. Provider launches receive neutral general-assistant
guidance rather than ADE's coding-agent prompt. The environment exposes the
chat session and personal scope, but omits project/lane/workspace identity
variables.

The hidden runtime is authoritative for personal-chat ownership. Session
reconstruction must preserve the persisted `surface`, and the personal scope
repairs older non-automation rows whose marker is missing or stale before
listing, reading, or continuing them. A missing marker must not hide an intact
transcript from the conversation rail.

Personal chat creation strips or overrides project-only fields such as a
caller-supplied lane/cwd, orchestration metadata, automation ownership, and
persistent project identity. It also refuses orchestrator-lead markers
outright rather than stripping them and opening a mis-isolated chat. The CLI
separately rejects Linear attachment flags. Machine RPC actions are
allowlisted rather than forwarding arbitrary ADE domains into the hidden
runtime.

An embedded sidecar (`ade runtime run --profile embedded`) uses this same
personal scope. The profile withholds machine-update and power controls and
forces sync off so a guest cannot restart the machine's ADE. Personal chats
themselves are not trimmed.

## Surface contract

| Surface | Entry and behavior |
|---|---|
| Desktop | **Chats** sits above the profile control and stays enabled with no project selected. The welcome screen has a **Start a chat** action. Visiting `/chats` from the projectless shell opens a real machine-level **Chats** top tab (backed by `personalChatsTabOpen`) that stays present as a clickable tab across project open/switch/close. The "+" on `/chats` opens and activates Home/New Tab while the Chats tab stays as an inactive tab; closing New Tab returns to `/chats` when projectless; closing an inactive Chats tab does not navigate. The surface itself is a hero empty state — heading plus verb-first suggestion chips — whose composer docks to the bottom once a session is selected, alongside a stateful searchable recency-grouped conversation rail, shared model/reasoning/permission controls, provider-accent send button, transcript/approval handling, and compact Browser and Terminal buttons. |
| ADE Browser | Personal chat uses the global authenticated browser profile and an explicit personal tab collection (`tabCollection: "personal"`). HTTP(S) links in the transcript are intercepted by the active personal-chat surface, open its Browser panel, and navigate with projectless scope so they cannot land invisibly in a retained project's collection. Navigation failures stay in ADE as a visible error instead of surprise-opening the system browser later. Cookies and site storage are shared across ADE, while personal visible tabs remain separate from project/window tabs. |
| Hosted web | The project picker and shell can enter `/chats` without selecting a project. The adapter uses runtime-scoped commands and personal chat subscriptions; browser-native ADE Browser is absent, while terminal IO runs on the paired machine. |
| iOS | The Hub card is the only entry. It shows live count/attention state and pushes a native searchable list, new-chat model sheet, and reused Work transcript destination with project/lane actions suppressed. Chat Info uses the personal action descriptors for durable-schedule Cancel and per-chat Pause/Resume; schedule creation remains an API capability rather than a native control. Personal summaries are cached per paired host for offline list display; create and schedule mutations require a live host, while sends may queue. |
| ADE CLI | `ade chat ... --personal` reaches the machine RPC directly. `--personal` is mutually exclusive with lane/Linear project context and requires a running brain. |
| ADE Code TUI | Deliberately out of scope for the initial release. No personal-chat drawer or slash command is added. |

## UX contract

- Desktop/web: a global `/chats` route with a conversation rail, focused
  transcript, and shared model/reasoning/access controls. The sidebar entry is
  available even on the welcome screen. Project-only Work, Git, Files, iOS,
  App Control, CLI-launch, lane, repo, PR, and **Open in** editor affordances
  are absent. The desktop Browser uses
  its global profile; terminal commands run in the personal scratch workspace.
- iOS: the Hub is the only entry point. It pushes a native Chats page, then a
  new-chat or existing-chat destination without selecting a project.
- TUI: deliberately out of scope for the initial release. The regular `ade`
  CLI commands are supported.

## Gotchas

- Never add the internal personal-chat root to the machine project registry.
- Never expose lane, repo, PR, or **Open in** editor actions on the
  projectless surface. The hidden personal lane exists so the chat stack
  has a lane id; it is not a worktree the user can open in VS Code or Zed.
- Never route a personal command through the active project as a fallback.
- Never infer personal scope from a null/missing project id; require the
  personal RPC/action or `chatScope: "personal"` explicitly.
- Keep state and scratch roots separate; the provider cwd must not expose the
  hidden database or transcript directory.
- Keep personal browser calls on `tabCollection: "personal"`; omitting it routes
  the call to the source window's active project tab collection. This changes
  visible tab routing only, never the global authentication storage profile.
- Preserve `surface: "personal"` whenever a persisted session is reconstructed.
  The hidden personal runtime may repair missing legacy markers, but regular
  project runtimes must never relabel a session across surfaces.
- Older runtimes should report the feature as unavailable. Do not silently
  create a normal project chat.
- The hosted web client has no local database. Lists and transcript updates
  come from runtime commands and the chat stream.
- Personal chat content may be more sensitive than repository chat. Do not log
  prompts or message bodies in machine RPC/sync diagnostics.
- Do not enable project push notifications for the hidden runtime until push
  links and notification actions have an explicit personal-chat route.
- Never create a personal chat as an orchestration lead. The create refuses
  those markers; do not strip them and continue.
- Treat `capabilities.personalChats.mcpServers` / `pushEvents` as optional.
  An older runtime omitting them would ignore the fields rather than error.
- Strict MCP on this surface is Claude-only as a guarantee. Read
  `mcpCapability.level`, not the object's presence. See [ADE SDK](../sdk/README.md#strict-mcp-honesty).
