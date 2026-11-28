# App Control

App Control drives a desktop app that a developer builds, from inside a chat.
The only supported `AppControlAppKind` is `electron`: DAEX launches the app (or
connects to a running one) through its Chrome DevTools Protocol (CDP) port. An
agent or the user can then observe and act by handle (the built-in browser's
loop), record the app's window and file it as proof, file a still, attach
screenshot-backed UI context with source matches (`AppControlContextItem`), show
the app in the Work tools pane or a floating card, and watch it from the web
client or phone.

App Control is a bridge: Playwright and other tools can attach to the same app.
It runs on the machine the chat runs on (launch terminal, CDP, captures, source
matching). `ChatAppControlPanel` takes a `runtimePin` and sends it on every call
and on its event subscription.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/appControl/appControlService.ts` | The broker: launch params, the chat-owned PTY, CDP polling, one `CdpClient` per session, every public operation (lifecycle, window controls, capture, context, live input, agent actions, recording, terminal), frame demand. |
| `.../appControl/appControlLaneController.ts` | Lane-scoped operations, point inspection (viewport → document coordinates, same-renderer iframes), `pickCdpTarget`, source matching. |
| `.../appControl/appControlAgentActions.ts`, `appControlObservations.ts` | The agent observe/act loop; observation storage, handle stamping, trace formatting, keep-latest-3. |
| `.../appControl/appControlRecording.ts` | Per-lane recorder and proof filing. |
| `.../appControl/appControlFrameSubscriptions.ts` | Per-window lane holds and the window gate (closed by default). |
| `.../appControl/appControlLaunchCommand.ts` | Launch parsing and rewrites (direct Electron, package scripts, Windows argv descriptors, `{ADE_APP_CONTROL_DEBUG_FLAGS}`). |
| `apps/desktop/src/shared/agentObservation.ts`, `agentObservationNormalizers.ts` | Handle format, CDP key map (`keyEventsForAgentInput`), the in-page collector and element map; CDP shape validation and the shared trace-target redaction. Node- and Electron-free, so it runs in the headless brain. |
| `apps/desktop/src/main/services/shared/agentObservationCache.ts`, `cdpFrameTransform.ts`, `cdpClient.ts` | Observation disk sweeps; iframe geometry; the CDP client (shared with the user-browser attach). |
| `apps/desktop/src/shared/types/appControl.ts`, `appControlFrameDemand.ts` | Types (session, status, capture, context, agent actions, recording, events); the frame-demand codec. |
| `apps/desktop/src/renderer/components/chat/ChatAppControlPanel.tsx`, `AppControlToolbar.tsx` | The panel (Control and Inspect modes) and its 40 px toolbar. Mounted in the chat drawer and as the Work tool `app-control` (keyed `work-appcontrol:<pinKey>`). |
| `apps/ade-cli/src/cli.ts` | `daex app-control` (aliases `daex app`, `daex electron`). |
| `apps/ade-cli/src/connectionFrameDemand.ts` | Per-connection frame demand, replayed onto restarted project scopes. |
| `apps/ade-cli/src/services/sync/appControlSyncStream.ts` | Frames to the web client and phone. |
| `apps/desktop/src/main/services/adeActions/registry.ts` | The `app_control` and `terminal` action domains. |

IPC is under `ade.appControl.*` plus the push channel `ade.appControl.event`;
`registerIpc.ts` rate-limits launch, snapshot, click and type, and heavy calls
bypass the global 30 s IPC timeout. The chat terminal surface is
`ade.terminal.*`.

## Gotchas / fragile areas

- **One session per lane, no fallback.** A call with no resolvable lane is
  refused, never routed to the project's first lane. `force` replaces a session
  only in the same lane.
- **Frames follow demand.** A lane's screencast streams only while a window
  holds it, a sync viewer subscribes, or a recording runs. An always-on
  screencast once filled the brain's heap.
- **zsh does not word-split.** An unquoted `$ADE_APP_CONTROL_DEBUG_FLAGS`
  arrived as one argument, so DAEX substitutes the variable in the command text
  (outside Windows).
- **Debug flags keep covered windows painting**
  (`--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`),
  so a screenshot matches the DOM.
- **Viewport vs document pixels.** `DOM.getNodeForLocation` wants document
  pixels; App Control adds the layout viewport's `pageX`/`pageY`. Cross-site
  iframes resolve only to their `<iframe>`.
- **Screenshot-space clicks scale by the app's device pixel ratio**, not by the
  downscaled live frame.
- **Native menu accelerators** never see CDP key events.
- **Driver vs provider spelling.** The driver `computer_use` is typed but always
  unavailable (it never falls back to CDP); the provider is `computer-use`.
- **A timed-out `record.start` may install late**, so DAEX follows with a stop;
  "already recording" on App Control's exclusive per-lane key is an orphan to
  stop and retry once.

## Sessions are per lane

- Every `app_control` action takes `laneId` and `chatSessionId`
  (`AppControlLaneArgs`). The lane comes from `laneId`, else the caller's chat,
  else the session id it holds.
- `launch`/`connect` on a lane with a live session refuse unless `force`.
- `getStatus` answers for one lane; user clients also get `sessions` for the
  whole project. Every event names its lane.
- `sessionId` picks the session when no lane is named and guards it when one is.
- From the CLI, `--lane` defaults to `ADE_LANE_ID` and `--chat-session` to
  `ADE_CHAT_SESSION_ID`; every call sends `callerRoot`, so a process with no chat
  identity inside a lane worktree is bound to that lane.

## Lifecycle

- **Launch** runs the command in a chat-owned terminal, then attaches.
- **Connect** attaches to an app already exposing a CDP port.
- **Stop** quits a launched app with its process tree; a connected app is only
  detached.
- **Release** happens when the owning chat ends and on lane archive/delete
  (`appControlService.stopForLane`).

### Launch and connect

1. `cwd` resolves against the lane worktree (escape refused); a free `cdpPort` is
   picked; DAEX sets `ADE_APP_CONTROL_CDP_PORT` and `ADE_APP_CONTROL_DEBUG_FLAGS`
   and then substitutes the flags in the command (literal placeholder, or the
   variable outside Windows), adds them to a package script or `electron` /
   `npx electron` launch, or for any other launcher only exports the variables
   (it must forward them).
2. The command runs in the chat's PTY (`terminalSessionId`, `terminalPtyId`).
3. DAEX polls `http://127.0.0.1:<port>/json` (500 ms, then 2 s once a target is
   picked). `pickCdpTarget` prefers `page`, then `webview`, then any
   non-`devtools://` URL.
4. A `CdpClient` opens; status goes `starting` → `running` → `connected`.
5. If the socket drops: `running` (terminal alive) or `failed` (exited).

`connect` skips steps 1–2. Capture and input never raise or move the window;
Show/Minimize call `focusWindow` / `minimizeWindow` only on request.

## Agent action model

The loop mirrors the built-in browser. `observe` takes a screenshot, runs the
shared collector (document, same-origin iframes, `webview`s, open shadow roots),
stamps `obs-<id>:e:<n>` handles, optionally paints the element map (`--map`), and
attaches diagnostics. Files go to
`<projectRoot>/.ade/cache/app-control-observations/<sessionId>/` (newest 3 per
session; older than 30 minutes swept). A hidden page adds a `warnings` entry.

`agentClick`, `agentHover`, `agentFill`, `agentClear`, `agentPress` and
`agentWait` resolve a target from a handle, selector, text, test id, element
index, or `x`/`y` (click and hover). A text match prefers exact, then the
smallest element carrying the text, lifted to its clickable ancestor. Disabled
targets are refused; `fill`/`clear` need an editable target. `agentType` types
into the focused element; `agentScroll` takes coordinates. Each action records a
redacted trace entry (last 80) and answers with a post-action observation after
150 ms (`--fast` skips the settle, `--no-observe` the observation), led by the
shared `hit:` / `effect:` lines ([README.md](./README.md#one-action-answer)).
`switchWindow` re-attaches and resets the trace; a handle from another window is
refused.

Keys go through `keyEventsForAgentInput`: `keyDown` with `text` for typing keys
(Enter types `"\r"`), `rawKeyDown` otherwise, plus modifiers. Live-frame input
from the renderer (`click`, `typeText`, `scroll`, `dispatchKey`) is not reachable
from the CLI.

## Snapshot and source matching

`getSnapshot()` runs the in-page collector (up to 450 elements, with a stable
selector and `data-component` / `data-source-file` / `data-source-line`
metadata), then `findSourceMatches` searches a capped index of the project's
`.ts`/`.tsx`/`.js`/`.jsx`/`.html`/`.css` files for each element's tokens
(`exact` or `candidate`). `inspectPoint` hit-tests through CDP
(`DOM.getNodeForLocation` with `ignorePointerEventsNone: false`) and commits
nothing; `selectPoint` makes the context item. Both fall back to a
`coordinate-fallback` provider.

## Recording

App Control records the app's own window. `startRecording` (`laneId`,
`chatSessionId?`, `caption?`, `plain?`, `maxSeconds?`), `stopRecording` and
`getRecordingStatus` return `AppControlRecordingStatus`, which uses
`MacDesktopRecordingStatus`'s field names plus `engine` and `sessionId`.

- One recording per lane, started through `startHelperRecording`.
- Stops after 5 minutes (`maxSeconds` less; `stopReason: "cap"`), 2 minutes
  without action (`"idle"`), a nearly full disk (`"disk"`) or the app closing
  (`"app-closed"`).
- The raw file becomes a demo ([Demo videos](../proof.md#demo-videos)) unless
  `plain`.
- The starting chat owns it. A captioned recording is filed as proof on stop
  (provenance `ade-recorder`, owners lane, chat and the lane's primary PR via
  `resolvePrimaryPrUrl`). An uncaptioned one stays scratch, unless the cap or the
  app closing ended it, which files it with a default caption.
- Engines: `window-capture` on macOS (the ADEDesktopDriver `CaptureEngine`
  captures only the app's window; needs Screen Recording, else the status carries
  `permissions`), `screencast` on Windows and Linux (CDP frames to `.aderaw`,
  made into MP4 by the desktop app; a machine with no desktop app cannot record).

## Proof

`daex app-control proof --caption "…"` runs `observe` and files the screenshot
through `ingest_computer_use_artifacts` (`backendName: "ade-app-control"`), on the
caller's lane, chat and the lane's PR. `screenshot`, `snapshot` and `observe` only
write scratch files.

## Show surfaces

`daex app-control show [--floating]` (or `daex ui show app-control|floating-app-control`)
goes through `work_tools.show`: answers `shown`, `held` or `no_desktop` (exit 1).
An agent driving App Control may raise the floating card itself (`auto`), unless
the chat's "Show preview when minimized" is off.

## Frames follow demand

Sources declare the lanes they show:

- Desktop windows hold lanes through the preload
  (`window.ade.appControl.holdFrames(laneId?)`; no lane admits all), counted per
  window in `appControlFrameSubscriptions.ts`; `runtimeBridge.ts` gates each
  forwarded `frame` event on the window's holds.
- The sync stream declares the lanes it has viewers for.
- A recording demands its lane while it runs.

The desktop sends the union to the brain with `appControl.setFrameDemand`. A
client that subscribes without ever declaring keeps the old always-on stream.
A lane with no demand pauses after 5 s, keeps its CDP client and drops its cached
frame, so the next capture is fresh. Frames are never retained in the event
buffer.

## Remote viewing

`appControlSyncStream.ts` forwards screencast frames over sync (no encoding):
`appControl.status`, `appControl.streamSubscribe` (pushes
`appControl.streamFrame`), `appControl.streamUnsubscribe`, `appControl.streamEnded`.
Each subscription is throttled to `maxFps` (default 10) and a byte budget,
keeping only the newest frame. `SyncAppControlSession` nulls host-only fields
(launch command, CDP endpoint, pid, terminal ids).

## Chat-owned terminal

The launch terminal is a normal chat terminal: `terminal_sessions` has an indexed
`chat_session_id`; `ptyService` tracks each chat's terminals and its active one.
Terminal calls take a `terminalId`, `ptyId` or `chatSessionId`. Agents get
`ADE_CHAT_SESSION_ID`, `ADE_LANE_ID`, `ADE_PROJECT_ROOT` and `ADE_WORKSPACE_ROOT`
(named `ADE_*` for historical reasons), so `daex app-control logs` or
`daex terminal read --chat-session "$ADE_CHAT_SESSION_ID"` work directly.

## Cross-links

- [README.md](./README.md): the proof broker and the shared action answer.
- [Mac Desktop](../mac-desktop/README.md): an App Control window can be claimed
  onto the lane display (optional).
- [Composer and UI](../chat/composer-and-ui.md): `AppControlContextItem` chips.
- [Terminals and sessions](../terminals-and-sessions/README.md).
- [Tool registration](../agents/tool-registration.md).
