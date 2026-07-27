# Personal chats

Personal chats are machine-owned AI conversations that are not attached to an
ADE project, lane, branch, or pull request. They use the same provider and model
catalog as Work chat, but present a general-purpose conversation surface on
desktop, the hosted web client, mobile, and the ADE CLI.

## Source file map

| Path | Role |
|---|---|
| `apps/ade-cli/src/services/personalChats/personalChatScope.ts` | Machine-owned chat runtime, existing-state background prewarm, hidden persistence/scratch roots, personal-surface recovery for legacy session rows, action allowlist (including scheduled-work create/cancel/pause), attachment confinement, terminal ownership, and event stream. |
| `apps/ade-cli/src/services/imageAttachment.ts` | Shared image validation, MIME sniffing, and bounded temporary-attachment persistence used by project and personal chat ingress. |
| `apps/ade-cli/src/services/projects/machineLayout.ts` | Resolves the channel-local `$ADE_HOME/personal-chats/{state,workspaces}` roots. |
| `apps/ade-cli/src/multiProjectRpcServer.ts` | Project-independent `personalChats.call` and `personalChats.streamEvents` machine RPC methods plus capability advertisement. |
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

The machine RPC exposes two methods outside project dispatch:

- `personalChats.call({ action, args })` executes one allowlisted action;
- `personalChats.streamEvents({ cursor, limit })` drains the personal runtime's
  bounded chat/PTY event buffer.

`runtime/info.capabilities.personalChats` advertises version 1 and the exact
action set. Clients must capability-gate the surface; an older runtime is an
unsupported host, not an invitation to create a normal project chat.

The action family covers list/create/read/send and interactive turn controls,
session metadata/lifecycle, scheduled-work create/cancel/pause, model inventory,
paged event history, bounded image attachment ingress/readback, and a chat-owned
shell PTY. Scheduled-work mutations call the same chat service methods as
project chat after rechecking that the supplied session belongs to
`surface: "personal"`. Terminal calls also check that the PTY was created by
this personal scope. Attachment readback resolves real paths and refuses
anything outside the hidden attachment store.

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

The page's machine picker rebinds that window, so its **This Mac** option
resolves through `renderer/components/chat/thisMachineProjectRoot.ts`: it finds
*this repository's* local checkout by repo identity rather than taking whichever
local tab happens to be first, and reports "Open this repository on This Mac
first, then switch back here." when there is none instead of silently switching
the window to an unrelated repo. Machine ids and the "This Mac" name come from
`shared/machineIdentity.ts`.

The ADE CLI uses the same machine endpoint through explicit `--personal`
commands, for example:

```bash
ade chat list --personal --text
ade chat create --personal --provider codex --model openai/gpt-5.5 --prompt "Help me plan a trip"
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
persistent project identity. The CLI separately rejects Linear attachment
flags. Machine RPC actions are allowlisted rather than forwarding arbitrary ADE
domains into the hidden runtime.

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
  App Control, and CLI-launch affordances are absent. The desktop Browser uses
  its global profile; terminal commands run in the personal scratch workspace.
- iOS: the Hub is the only entry point. It pushes a native Chats page, then a
  new-chat or existing-chat destination without selecting a project.
- TUI: deliberately out of scope for the initial release. The regular `ade`
  CLI commands are supported.

## Gotchas

- Never add the internal personal-chat root to the machine project registry.
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
