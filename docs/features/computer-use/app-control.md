# App Control

App Control drives a desktop app that a developer builds, from inside a chat.
The one supported `AppControlAppKind` is `electron`. ADE launches an Electron
app (or connects to one that is running) through its Chrome DevTools Protocol
(CDP) port. Then an agent or the user can:

- observe the app and act on it by handle (the same loop as the built-in
  browser);
- record a video of the app's window and file it as proof;
- file a still as proof;
- attach screenshot-backed UI context, with source-file matches, to a chat as
  an `AppControlContextItem`;
- show the app to the user in the Work tools pane or as a floating card;
- watch it live from the web client or the phone.

App Control is a bridge. Playwright, agent-browser and other tools can attach to
the same Electron app. ADE keeps the session, the launch terminal, the captures
and the chat context consistent across them.

App Control runs on the machine the chat runs on. The launch terminal, the CDP
connection, captures and source matching all run on that host. A renderer only
shows the frames and chips. `ChatAppControlPanel` takes a `runtimePin` and sends
it on every call and on its event subscription.

## Sessions are per lane

App Control keeps **one session per lane**, keyed by `laneId`.

- Every `app_control` action accepts `laneId`, plus `chatSessionId` for
  ownership (`AppControlLaneArgs` in `shared/types/appControl.ts`). A caller
  acts on its own lane's session.
- The lane comes from `laneId`, else from the caller's chat, else from the
  session id it holds. A call with no resolvable lane is refused. There is no
  fallback to the project's first lane.
- `launch` and `connect` on a lane that has a live session refuse unless
  `force` is set. `force` replaces a session only in the same lane.
- `getStatus` answers for one lane: `laneId` and `activeSession` are that lane's.
  User clients also get `sessions`, the list of every lane's session in the
  project.
- Every `AppControlEventPayload` names its lane, so a pane or a remote viewer
  picks its own lane's session out of one project stream.
- `sessionId` on an action picks the session when no lane is named, and guards
  it when one is: a `sessionId` that is not the lane's session is refused.

From the ADE CLI, `--lane` defaults to `ADE_LANE_ID` and `--chat-session` to
`ADE_CHAT_SESSION_ID`. Every `ade app-control` call also sends `callerRoot` and
`callerRootSource` (the same pair `ade mac-desktop` sends). An `ade` process
with no chat identity that runs inside a lane worktree is bound to that lane.

## Lifecycle

- **Launch.** `launch` runs the command in a chat-owned terminal and attaches
  over CDP. See "Launch and connect".
- **Connect.** `connect` attaches to an app that already exposes a CDP port.
- **Stop.** `stop` quits an app ADE launched, with its whole process tree. It
  only detaches from an app that `connect` attached to; that app keeps running.
- **Release.** ADE releases a lane's session when the chat that owns it ends,
  and when the lane is archived or deleted (`laneService` calls
  `appControlService.stopForLane(laneId)` in its teardown).
- `dispose()` is the shutdown path for the whole service.

## Recording

App Control records the app's own window, not the screen. The contract matches
Mac Desktop recording.

| Action | Arguments | Answer |
|---|---|---|
| `app_control.startRecording` | `laneId`, `chatSessionId?`, `caption?`, `keepIdle?`, `maxSeconds?` | `AppControlRecordingStatus` |
| `app_control.stopRecording` | `laneId`, `chatSessionId?` | `AppControlRecordingStatus` with `filePath`, `durationMs`, `wallDurationMs`, `idleCutMs`, `proofArtifactId`, `lastError` |
| `app_control.getRecordingStatus` | `laneId` | `AppControlRecordingStatus` |

`AppControlRecordingStatus` uses the field names of `MacDesktopRecordingStatus`
(`running`, `startedAt`, `caption`, `chatSessionId`, `filePath`, `durationMs`,
`wallDurationMs`, `idleCutMs`, `maxDurationMs`, `stopReason`, `proofArtifactId`,
`lastError`) and adds `engine` and `sessionId`.

Rules:

- **One per lane.** A lane has at most one recording.
- **Cap.** A chat's recording stops itself after 10 minutes of real time
  unless `maxSeconds` sets another limit (`stopReason: "cap"`). A recording no
  chat owns has no cap unless one is asked for. A recording also stops when the
  app closes (`stopReason: "app-closed"`).
- **Idle cut.** Still stretches are cut from the video unless `keepIdle` is
  set. `durationMs` is the video; `wallDurationMs` is the real time it covers;
  `idleCutMs` is the difference.
- **Chat-bound.** The chat that starts a recording owns it. The proof is filed
  under that chat, whichever chat stops it.
- **Proof.** A captioned recording is filed as proof when it stops, with
  provenance `ade-recorder`. With no caption it stays a scratch file, except
  when the cap or the app closing ended a chat's recording: then it files
  itself with a default caption, as the Mac Desktop cap does. Its owners are the lane, the chat and the lane's
  primary PR (resolved the same way as Mac Desktop, through
  `resolvePrimaryPrUrl`). The chat turn shows the recording card, the same as a
  Mac Desktop recording.
- **Events.** A start, stop or failure emits `recording-changed` with the lane
  and the status.

Engines (`engine`):

- `window-capture` (macOS). The ADEDesktopDriver `CaptureEngine` captures only
  the App Control app's window (`SCContentFilter(desktopIndependentWindow:)`).
  It reuses the Mac Desktop writer: `AVAssetWriter`, the idle cut and the cap.
  A start that lacks the Screen Recording grant is refused, and the status
  carries `permissions`.
- `screencast` (Windows and Linux). The desktop renderer draws the CDP
  screencast frames onto a canvas and records it with `MediaRecorder` (MP4 when
  supported, else WebM). The status contract is the same. A machine with no
  ADE desktop app has no encoder, and the start says so.

## Proof

- `ade app-control proof --caption "…"` runs `observe` and files the screenshot
  through `ingest_computer_use_artifacts` with `backendName: "ade-app-control"`.
  The CLI names the lane and the chat explicitly, so the proof lands on the
  caller's lane and chat, and on the lane's PR.
- A captioned recording is filed when it stops (see "Recording").
- `screenshot`, `snapshot` and `observe` write scratch files and file nothing.

## Show surfaces

`WorkToolShowSurface` has `app-control` (the App Control tool in the Work tools
pane) and `floating-app-control` (the floating card over the chat). They go
through `work_tools.show`, the same path as `mac-desktop`:

- `ade app-control show` and `ade ui show app-control`;
- `ade app-control show --floating` and `ade ui show floating-app-control`.

The answer is `shown`, `held` (a desktop has the project open but the chat is
not in front) or `no_desktop` (exit 1). When an agent drives App Control, the
brain may offer the floating card by itself (an `auto` request), like Mac
Desktop's driven-device path. The per-chat "Show preview when minimized" choice
can refuse an auto request.

## Remote viewing

The web client and the phone watch a lane's session over the sync socket.
`apps/ade-cli/src/services/sync/appControlSyncStream.ts` forwards the frames
App Control already gets from the CDP screencast. It never starts the
screencast and never encodes video.

| Command | Purpose |
|---|---|
| `appControl.status` | The lane's session (or every session, for a project-wide read) and the stream state: `live`, `lastFrameAt`, size, `viewerCount`. |
| `appControl.streamSubscribe` | Start receiving `appControl.streamFrame` for a lane. |
| `appControl.streamUnsubscribe` | Stop. `appControl.streamEnded` tells a client the stream ended. |

Each subscription is throttled on the brain: at most `maxFps` frames a second
(10 by default), a byte budget per second, and only the newest frame is kept. A
frame that cannot go out is replaced by the next one; nothing queues. A new
viewer gets the newest frame at once. `SyncAppControlSession` leaves out
host-only state: the launch command, the CDP endpoint, the pid and the terminal
ids are always null.

## Source file map

### Service (`apps/desktop/src/main/services/appControl/`)

- `appControlService.ts` — the broker. It resolves launch parameters, runs the
  app in a chat-owned PTY, polls the CDP endpoint, keeps one `CdpClient`
  WebSocket per session, and exposes the operations used by IPC and the CLI:
  - lifecycle: `getStatus`, `launch` / `launchInTerminal`, `connect`, `stop`,
    `stopForLane`, `dispose`, `listTargets`, `attachToTarget`, `claim`;
  - window controls: `focusWindow`, `minimizeWindow`;
  - capture: `screenshot`, `getSnapshot`;
  - context: `inspectPoint`, `selectPoint`;
  - live-frame input (renderer only): `click`, `typeText`, `scroll`,
    `dispatchKey`;
  - agent actions: `observe`, `agentClick`, `agentHover`, `agentFill`,
    `agentClear`, `agentType`, `agentPress`, `agentScroll`, `agentWait`,
    `getTrace`, `windows`, `switchWindow`;
  - recording: `startRecording`, `stopRecording`, `getRecordingStatus`;
  - capability: `listDrivers`;
  - launch terminal: `readTerminal`, `writeTerminal`, `signalTerminal`;
  - screencast frames go out on `onEvent` (`type: "frame"`).
- `appControlAgentActions.ts` — the agent observe/act loop.
- `appControlRecording.ts` — the per-lane recorder: start, stop, status, the
  cap, and filing a captioned video as proof.
- `appControlLaunchCommand.ts` — launch parsing and rewrites for direct
  Electron and package-script commands. On Windows, a resolvable `electron`,
  `npx electron` or package-script launch becomes a structured
  command/argv/env descriptor; a shell fallback uses explicit PowerShell or cmd
  syntax. POSIX keeps its shell rewrite. The `{ADE_APP_CONTROL_DEBUG_FLAGS}`
  placeholder works on every platform.
- `appControlObservations.ts` — observation storage: cache paths and bounds,
  DOM normalizers, `obs-…:e:N` handle stamping, trace target formatting, and the
  keep-latest-3 pruner.
- Tests: `appControlService.test.ts`, `appControlLaunchCommand.test.ts`.

### Shared agent-observation modules

- `apps/desktop/src/shared/agentObservation.ts` — handle format and parse, path
  sanitizing, the CDP key map, the in-page element collector
  (`AGENT_DOM_COLLECTOR_FUNCTION`) and the element-map overlay
  (`AGENT_ELEMENT_MAP_OVERLAY_FUNCTION`). It imports nothing from Electron or
  Node, so App Control works inside the headless `ade` brain.
- `apps/desktop/src/shared/agentObservationNormalizers.ts` — validates the
  untrusted shapes CDP returns and owns the one trace-target redaction rule.
  The browser and App Control share it, so typed secrets are redacted the same
  way on both.
- `apps/desktop/src/main/services/shared/agentObservationCache.ts` — the two
  disk sweeps (keep the newest N per live owner; drop aged-out directories)
  for `.ade/cache/browser-observations` and
  `.ade/cache/app-control-observations`.

### Shared types (`apps/desktop/src/shared/types/appControl.ts`)

- Identity: `AppControlAppKind`, `AppControlProvider`, `AppControlDriver`,
  `AppControlSession` (status `starting` | `running` | `connected` |
  `stopping` | `exited` | `stopped` | `failed`; carries `projectRoot`,
  `laneId`, `chatSessionId`, `driver`, `lastObservationId`,
  `lastTraceEntryId`).
- Lane scope: `AppControlLaneArgs`, `AppControlSessionTargetArgs`.
- Status: `AppControlStatus` (`platform`, `supported`, `laneId`,
  `activeSession`, `sessions`, `providers`).
- Capture and context: `AppControlScreenshot`, `AppControlSnapshot`,
  `AppControlElement`, `AppControlScreencastFrame` (carries `laneId`),
  `AppControlContextItem`, `AppControlSourceMatch`, `AppControlInspectResult`,
  `AppControlSelectResult`.
- Coordinates: `AppControlCoordinateSpace` is `screenshot` (bitmap pixels) or
  `viewport` (CSS viewport). Live renderer clicks use `viewport`.
- Agent actions: `AppControlObservation`, `AppControlAgentActionResult`, the
  per-action argument types, `AppControlTraceResult`,
  `AppControlWindowsResult`, `AppControlSwitchWindowArgs`.
- Recording: `AppControlRecordingStatus`, `AppControlRecordingEngine`,
  `AppControlRecordingStopReason`.
- Events: `AppControlEventPayload` (`session-started`, `session-updated`,
  `session-stopped`, `selection`, `frame`, `recording-changed`,
  `diagnostics`). `diagnostics` mirrors the browser event of the same name
  (`consoleErrorCount`, `failedRequestCount`), is sent on change only, and
  resets on a main-frame navigation or a reattach.

### IPC and preload

Channels live under `ade.appControl.*`: `getStatus`, `launch` /
`launchInTerminal`, `connect`, `stop`, `focusWindow` / `minimizeWindow`,
`screenshot`, `getSnapshot`, `inspectPoint` / `selectPoint`, `click` /
`typeText` / `scroll` / `dispatchKey`, `listTargets` / `attachToTarget`, and the
push channel `ade.appControl.event`.

`registerIpc.ts` rate-limits launch, snapshot, click and type, and validates
argument shapes. Heavy calls bypass the global 30 s IPC timeout, because CDP
captures can take longer.

The chat terminal surface is `ade.terminal.*` (`list`, `read`, `write`,
`signal`, `activeForChat`). `preload.ts` exposes `window.ade.appControl` and
`window.ade.terminal`; `global.d.ts` has their types.

### Renderer

- `ChatAppControlPanel.tsx` — the App Control panel. It mounts in two places:
  - the chat drawer in `AgentChatPane` (chat-scoped), and
  - the `app-control` tool in the Work tools pane (`WorkSidebar.tsx`,
    lane-scoped, keyed `work-appcontrol:<pinKey>` so a machine switch remounts
    it). Its state key includes the machine key, because a launch command and
    a CDP port describe a process on one machine.

  Both mounts take `runtimePin`. Every read, action and the `onEvent`
  subscription carry it. The panel has two modes:
  - **Control** — live screencast frames, launch/connect, Show/Minimize window,
    click/type input, and terminal quick actions.
  - **Inspect** — a DevTools-style outline. Hover calls `inspectPoint`; click
    calls `selectPoint` and attaches the context item to the chat composer.

  `AppControlToolbar.tsx` owns the 40 px control row: the app picker, a status
  dot, window segments (more than 3 fold into a "Windows…" menu), and a 2 px
  progress bar while a connect or attach runs. The bar parks at 90 % because
  the real progress is unknown, and is static under `prefers-reduced-motion`.
- `AgentChatPane.tsx` mounts the chat-scoped panel and owns the App Control
  chips. It asks the chat's own machine whether App Control is supported. As a
  Work tile (`hideLaneToolDrawers`), the Work sidebar owns the drawer instead,
  and sidebar selections reach the composer through the
  `ade:agent-chat:add-app-control-context` window event.
- `ChatTerminalDrawer.tsx` gives the App Control launch terminal tab a status
  tone.

### ADE CLI (`apps/ade-cli/src/cli.ts`)

`ade app-control <sub>` (aliases `ade app`, `ade electron`):

- session: `status`, `launch`, `connect`, `claim`, `stop`, `show [--floating]`,
  `actions`;
- agent loop: `observe`, `click`, `hover`, `fill`, `clear`, `type`, `press` /
  `key`, `scroll`, `wait`, `trace` — the same target flags as `ade browser`
  (`--handle`, `--selector`, `--text-match`, `--test-id`, `--element`,
  `--x --y`), plus `--map`, `--fast`, `--no-observe`, `--session`. Each one maps
  to the `agent*` action; the live-frame primitives are not reachable from the
  CLI;
- capture and proof: `screenshot`, `snapshot`, `inspect`, `select`, `proof`,
  `record start [--caption] [--keep-idle] [--max-seconds N]`, `record stop`,
  `record status`;
- windows: `windows`, `switch-window`, `targets`, `attach-target`, `focus`,
  `minimize`, `drivers`;
- terminal: `logs`, `terminal read|write|signal`.

`launch`, `connect` and `claim` read `--session` as the chat. Every other
subcommand reads `--session` as the App Control session guard. `--cwd` on
`launch` resolves a relative path from the shell's own directory. `record`
prints the same lines as `ade mac-desktop record` plus `engine` and a `proof`
line with the filed artifact id.

`ade ui show app-control|floating-app-control` requests the same surfaces as
`ade app-control show`.

`apps/ade-cli/src/bootstrap.ts` builds an `AppControlService` for the headless
brain with the same lane resolution as the desktop main process.

### Action registry

`apps/desktop/src/main/services/adeActions/registry.ts` registers the
`app_control` domain (every public service method, so a runtime-pinned call can
resolve it on another machine) and the `terminal` domain (`list`, `read`,
`write`, `signal`, `activeForChat`).

## Launch and connect

`launch(args)`:

1. **Arguments.** `appKind` defaults to `electron`. `cwd` is resolved against the
   lane worktree and refused if it escapes it. A free `cdpPort` is picked when
   none is given. ADE sets `ADE_APP_CONTROL_CDP_PORT` and
   `ADE_APP_CONTROL_DEBUG_FLAGS`, then:
   - substitutes a literal `{ADE_APP_CONTROL_DEBUG_FLAGS}` in the command; or
   - for a package script (`npm`/`pnpm`/`yarn`/`bun run …`), resolves the
     script and adds the debug flags; or
   - for `electron` / `npx electron`, appends the flags; or
   - for any other launcher, only exports the variables. That launcher must
     forward `ADE_APP_CONTROL_DEBUG_FLAGS`, or read `ADE_APP_CONTROL_CDP_PORT`
     and pass `--remote-debugging-port`.
2. **Visible terminal.** The command runs in the chat-owned PTY, so the user
   sees its output. The session records `terminalSessionId` and
   `terminalPtyId`.
3. **CDP discovery.** ADE polls `http://127.0.0.1:<port>/json` every 500 ms,
   then every 2 s once a target is picked. `pickCdpTarget` prefers `page`, then
   `webview`, then any non-`devtools://` URL.
4. **Attach.** A `CdpClient` WebSocket opens. The session moves `starting` →
   `running` → `connected`. The screencast starts when a viewer needs frames.
5. **Health.** If the socket drops, the session goes back to `running`
   (terminal alive) or `failed` (terminal exited), with `lastError` set.

`connect(args)` is the same flow without step 1 and 2. Capture and input never
raise or move the app window. The panel's Show and Minimize buttons call
`focusWindow()` and `minimizeWindow()` when the user asks.

## Snapshot and source matching

`getSnapshot()` has two parts:

1. **DOM collector** in the page. It ranks elements by interactivity and returns
   up to 450 with tag, role, label, value, a stable selector (id → test id →
   tag.class), test ids, geometry and a small metadata bag (including
   `data-component`, `data-source-file`, `data-source-line`).
2. **Source matching** in the main process. `collectSourceFiles(projectRoot)`
   indexes a capped set of `.ts`/`.tsx`/`.js`/`.jsx`/`.html`/`.css` files, and
   `findSourceMatches` searches them for the element's component, test id, id,
   label or selector tokens. Each match is `exact` or `candidate`.

`inspectPoint` hit-tests with CDP `DOM.getNodeForLocation`, `DOM.resolveNode`
and `Runtime.callFunctionOn`, so the outline snaps to the real control. An
in-page script is the fallback. It commits nothing. `selectPoint` makes the
final `AppControlContextItem` for the chat. Both fall back to a
`coordinate-fallback` provider when the hit-test misses (for example, inside an
iframe ADE cannot reach).

## Input (renderer live-frame path)

- `click` sends `Input.dispatchMouseEvent`. Screenshot-space points are scaled
  to viewport space with separate x and y factors from the latest screencast
  frame. A hidden renderer tries an in-page DOM click first.
- `typeText` uses `Input.insertText`; `dispatchKey` is the escape hatch for
  shortcuts.
- `scroll` is a `mouseWheel` event.
- All input shares one `CdpClient` per session.

## Agent action model

The agent loop mirrors the built-in browser.

`observe` captures a fresh screenshot, runs the shared element collector
(document, same-origin iframes, `webview`s and open shadow roots, to depth 4),
stamps each element with an `obs-<id>:e:<n>` handle, optionally paints the
numbered element map (`--map`), and attaches diagnostics (console entries,
failed requests, in-flight request count). The `diagnostics` event is coalesced
on a 250 ms trailing edge; a reset publishes at once. Files go to
`<projectRoot>/.ade/cache/app-control-observations/<sessionId>/`. Each session
keeps its newest 3 observations; records older than 30 minutes are swept.

Actions: `agentClick`, `agentHover`, `agentFill`, `agentClear`, `agentPress` and
`agentWait` resolve a target from a handle, `selector`, `text`, `testId`,
`elementIndex`, or `x`/`y` (click and hover only). A handle is read back from
its saved observation, so a pruned or foreign handle fails with a clear error.
The target is scrolled into view and focused; a disabled target is refused.
`fill` and `clear` need an editable target, and `fill` types only an explicit
`value`. `agentType` has no target: it types into the focused element.
`agentScroll` takes coordinates only.

Every action then dispatches CDP input, records a trace entry (the last 80 are
kept, with a redacted target), and answers with a post-action observation after
a 150 ms settle (`waitAfterMs: 0` / `--fast` skips the settle; `observe: false`
/ `--no-observe` skips the observation). The answer starts with the shared
`hit:` and `effect:` lines (see [`README.md`](./README.md), "One action
answer").

`switchWindow({ targetId })` re-attaches to another window and resets the trace.
A handle records the `cdpTargetId` it was minted against, and a handle from
another window is refused ("Observe again after switching windows").

## Drivers and providers

A **driver** is how input is sent. `cdp` is the only implemented driver and the
default. `computer_use` is typed and listed by `listDrivers()`, but always
`unavailable`; passing it to `launch` or `connect` fails with that reason
instead of falling back to CDP.

A **provider** is where an element or point came from. `getStatus().providers`
reports `cdp` (available while a session is connected) and `computer-use`
(available on macOS as a complement to CDP, not a driver). The union also has
`os-accessibility` and `external`, used only as provenance values. Note the
spelling: the driver is `computer_use`, the provider is `computer-use`.

## Chat-owned terminal

The launch terminal is a normal ADE chat terminal. `terminal_sessions` has a
nullable, indexed `chat_session_id` column. `ptyService` tracks the terminals of
each chat and its active one; when the active terminal closes, the newest
sibling becomes active. `listTerminals`, `readTerminal`, `writeTerminal`,
`signalTerminal` and `activeForChat` accept a `terminalId`, a `ptyId` or a
`chatSessionId`.

`agentChatService` sets `ADE_CHAT_SESSION_ID`, `ADE_LANE_ID`,
`ADE_PROJECT_ROOT` and `ADE_WORKSPACE_ROOT` for agents, so an agent can run
`ade app-control logs` or `ade terminal read --chat-session "$ADE_CHAT_SESSION_ID"`
without looking anything up.

## Cross-links

- [`README.md`](./README.md) — the proof broker and the shared action answer.
- [`../mac-desktop/README.md`](../mac-desktop/README.md) — the lane's private
  macOS display. An App Control window can be moved there with
  `ade mac-desktop claim --window <id>` (optional).
- [`../chat/composer-and-ui.md`](../chat/composer-and-ui.md) — chips for
  `AppControlContextItem`s.
- [`../terminals-and-sessions/README.md`](../terminals-and-sessions/README.md) —
  the `chat_session_id` column and the `ade.terminal.*` IPC surface.
- [`../agents/tool-registration.md`](../agents/tool-registration.md) — how the
  agent environment and the `app_control` / `terminal` domains reach agents.
