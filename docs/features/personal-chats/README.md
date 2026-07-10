# Personal chats

Personal chats are machine-owned AI conversations that are not attached to an
ADE project, lane, branch, or pull request. They use the same provider and model
catalog as Work chat, but present a general-purpose conversation surface on
desktop, the hosted web client, mobile, and the ADE CLI.

## Source file map

| Path | Role |
|---|---|
| `apps/ade-cli/src/services/personalChats/personalChatScope.ts` | Lazy machine-owned chat runtime, hidden persistence/scratch roots, action allowlist, attachment confinement, terminal ownership, and event stream. |
| `apps/ade-cli/src/services/imageAttachment.ts` | Shared image validation, MIME sniffing, and bounded temporary-attachment persistence used by project and personal chat ingress. |
| `apps/ade-cli/src/services/projects/machineLayout.ts` | Resolves the channel-local `$ADE_HOME/personal-chats/{state,workspaces}` roots. |
| `apps/ade-cli/src/multiProjectRpcServer.ts` | Project-independent `personalChats.call` and `personalChats.streamEvents` machine RPC methods plus capability advertisement. |
| `apps/ade-cli/src/cli.ts` | Typed `ade chat ... --personal` commands; they require the machine brain and never fall back to a project/headless runtime. |
| `apps/ade-cli/src/services/sync/` | Runtime-scoped personal-chat commands, feature advertisement, policy descriptors, and personal transcript subscriptions for controllers. Primary files: `syncService.ts`, `syncHostService.ts`, and `syncRemoteCommandService.ts`. |
| `apps/desktop/src/shared/types/personalChats.ts` | Cross-process action, result, capability, queue-policy, scope, and event contracts. |
| `apps/desktop/src/main/services/ipc/runtimeBridge.ts` | Routes a local/no-project window to the local brain and a remotely bound project window to that remote machine's personal-chat scope. |
| `apps/desktop/src/main/services/chat/agentChatService.ts` | Durable `personal` chat surface and neutral provider guidance/environment. |
| `apps/desktop/src/renderer/components/personalChats/` | Desktop conversation list, transcript, composer, and compact tool controls. |
| `apps/desktop/src/renderer/components/app/` | Global `/chats` route, sidebar entry, standalone top tab, and project/no-project shell integration in `App.tsx`, `AppShell.tsx`, `TabNav.tsx`, and `TopBar.tsx`. |
| `apps/desktop/src/main/services/builtInBrowser/builtInBrowserService.ts` | Explicit global browser profile used by personal chat so project cookies, tabs, and storage never bleed into it. |
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
lazy and chat-only, does not run its own sync listener, and suppresses the
project-oriented push/deeplink publisher because those links would otherwise
open a project Work surface.

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
session metadata/lifecycle, model inventory, paged event history, bounded image
attachment ingress/readback, and a chat-owned shell PTY. Every action rechecks
that a supplied session id belongs to `surface: "personal"`; terminal calls
also check that the PTY was created by this personal scope. Attachment
readback resolves real paths and refuses anything outside the hidden
attachment store.

Over sync the same actions are registered as `personalChats.*` with
`scope: "runtime"`, so command envelopes carry no active `projectId` or project
root. Only `personalChats.send` is offline-queueable. Creating a conversation
requires a live host because there is no stable optimistic session id and
replaying a queued create could duplicate chats.

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

On desktop, `/chats` is a global route. It can be opened as a standalone
machine tab from the welcome screen or as a global sidebar surface while a
project remains selected. In the latter case the window's existing project
binding is intentionally retained so a remote-bound window addresses the
remote machine's personal chats. Returning to a project route does not require
reopening the project.

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

Personal chat creation strips or overrides project-only fields such as a
caller-supplied lane/cwd, orchestration metadata, automation ownership, and
persistent project identity. The CLI separately rejects Linear attachment
flags. Machine RPC actions are allowlisted rather than forwarding arbitrary ADE
domains into the hidden runtime.

## Surface contract

| Surface | Entry and behavior |
|---|---|
| Desktop | **Chats** sits above the profile control and stays enabled with no project selected. The welcome screen has a **Start a chat** action. A standalone `/chats` visit gets a machine-level top tab; visiting from an open project keeps that project tab/binding. The page has a searchable recency-grouped conversation rail, shared model/reasoning/permission controls, transcript/approval handling, and compact Browser and Terminal buttons. |
| ADE Browser | Personal chat uses the explicit global browser profile (`profileScope: "global"`). It is isolated from every project's persistent browser partition, tabs, cookies, and local storage. |
| Hosted web | The project picker and shell can enter `/chats` without selecting a project. The adapter uses runtime-scoped commands and personal chat subscriptions; browser-native ADE Browser is absent, while terminal IO runs on the paired machine. |
| iOS | The Hub card is the only entry. It shows live count/attention state and pushes a native searchable list, new-chat model sheet, and reused Work transcript destination with project/lane actions suppressed. Personal summaries are cached per paired host for offline list display; create requires a live host, while sends may queue. |
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
- Keep personal browser calls on `profileScope: "global"`; omitting the scope
  lets Electron fall back to the source window's active project profile.
- Older runtimes should report the feature as unavailable. Do not silently
  create a normal project chat.
- The hosted web client has no local database. Lists and transcript updates
  come from runtime commands and the chat stream.
- Personal chat content may be more sensitive than repository chat. Do not log
  prompts or message bodies in machine RPC/sync diagnostics.
- Do not enable project push notifications for the hidden runtime until push
  links and notification actions have an explicit personal-chat route.
