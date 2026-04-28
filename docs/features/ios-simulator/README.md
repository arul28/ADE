# iOS Simulator

ADE drives the system iOS Simulator from inside any Agent Chat pane: it
discovers Xcode projects in the active project root, builds and launches
the selected scheme onto a booted simulator, mirrors the running app
into a chat-side panel, and turns taps inside that panel into either
context items the user attaches to the next prompt or input events
(tap, drag, swipe, type) replayed against the simulator. The same
surface is exposed to agents through the `ade ios-sim` CLI and the
generic `actions run ios_simulator.<verb>` action surface, so a chat
agent and the user share one drawer state.

The feature is **macOS-only** (`xcrun` / `xcodebuild` / Simulator.app
are not available on Linux or Windows). The button that opens the panel
is hidden on non-darwin platforms, and `iosSimulatorService.launch`
throws `"iOS Simulator control is only available on macOS."` when
called from a non-darwin host.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/ios/iosSimulatorService.ts` | The whole feature backend: tool-readiness probes (xcrun, xcodebuild, idb, idb_companion, ffmpeg), simctl device + app discovery, build/install/launch with progress events, screenshot + ADEInspector + accessibility hit-test, three streaming backends (`simctl-screenshot-poll`, `idb-h264-ffmpeg-mjpeg`, `simulator-window-capture`), tap/drag/swipe/type via idb, single-owner session locking, Preview Lab integration via Xcode MCP, and selection emission. ~3,400 lines. |
| `apps/desktop/src/main/services/ios/iosSimulatorService.test.ts` | Service unit tests. |
| `apps/desktop/src/shared/types/iosSimulator.ts` | All cross-process types: `IosSimulatorStatus`, `IosSimulatorDevice`, `IosSimulatorLaunchTarget`, `IosSimulatorSession`, `IosSimulatorLaunchProgress`, `IosSimulatorStreamStatus`, `IosScreenSnapshot`, `IosScreenElement`, `IosInspectorSnapshot`, `IosInspectableElement`, `IosElementContextItem`, `IosSimulatorEventPayload`, plus the `IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE` error sentinel. |
| `apps/desktop/src/shared/ipc.ts` | `IPC.iosSimulator*` channel constants (one per service method, plus a single push channel `ade.iosSimulator.event`). |
| `apps/desktop/src/main/services/ipc/registerIpc.ts` | `ade.iosSimulator.*` invoke handlers, the chat-session-aware arg validator (`incomingChatSessionId` must match the active drawer owner), and `ade.iosSimulator.event` push relay. |
| `apps/desktop/src/main/services/adeActions/registry.ts` | Maps the service onto the `ios_simulator` action namespace consumed by the ADE CLI / agent tools (`getStatus`, `listDevices`, `listLaunchTargets`, `launch`, `shutdown`, `screenshot`, `getScreenSnapshot`, `getInspectorSnapshot`, `inspectPoint`, `getPreviewCapability`, `listPreviewTargets`, `renderPreview`, `openPreviewWorkspace`, `startStream`, `stopStream`, `getStreamStatus`, `tap`, `typeText`, `drag`, `swipe`, `selectPoint`). |
| `apps/desktop/src/preload/preload.ts` | `window.ade.iosSimulator` bridge and `onEvent(listener)` push subscription. |
| `apps/desktop/src/renderer/components/chat/ChatIosSimulatorPanel.tsx` | Drawer UI: tool-readiness checklist, device + target pickers, launch progress, three-backend live preview switcher (window capture / MJPEG / screenshot poll), `interact` vs `inspect` mode, hit-test overlay drawn from `getScreenSnapshot`, Preview Lab tab (`renderPreview` + workspace open), and attachment + context emission. ~2,600 lines. |
| `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx` | Mounts `ChatIosSimulatorPanel` behind a header toggle (`iosSimulatorAvailable`), brokers the screenshot-attachment + context-item flow into the composer, and gates the toggle on `iosSimulatorStatus.supported`. |
| `apps/desktop/src/renderer/components/chat/AgentChatComposer.tsx` | Renders `IosElementContextItem[]` as inline composer chips: switches to a contenteditable rich-input variant when the user has attached one or more iOS elements, serialises chip nodes back into the prompt on submit, and pairs each element with its captured screenshot when one was added in the same gesture. |
| `apps/desktop/src/renderer/components/chat/ChatAttachmentTray.tsx` | Includes iOS-element instance handling: `createIosContextInstanceId`, `getIosContextAttachmentPath`, and `formatIosElementContextForPrompt` (the prompt-side serialisation). |
| `apps/desktop/src/shared/adeCliGuidance.ts` | Mentions `ade ios-sim` so prompts know the surface exists. |
| `apps/ade-cli/src/cli.ts` | `ade ios-sim` (aliased `ade ios`, `ade simulator`) subcommand: status / devices / apps / launch / shutdown / actions / screenshot / snapshot / inspector / inspect / preview-status / previews / preview-render / preview-open / window-start / live-start / preview-start / stream-status / stream-stop / select / tap / drag / swipe / type, with focused `ade help ios-sim <subcommand>` pages for agent discovery. |
| `apps/ios/ADE/Debug/ADEInspectorKit/ADEInspectable.swift` | The Swift side: the `.adeInspectable("componentId", ...)` view modifier and the `.adeInspectorHost()` host modifier that publish per-frame element snapshots (component id, source file/line, accessibility identifier, point + pixel frames) into `Documents/ade-inspector-elements.json` inside the running app's data container. DEBUG-only — release builds compile to a no-op. |

## Detail docs

- [inspector.md](inspector.md) — how the Swift `ADEInspectorKit`
  publishes element frames and how the Electron service correlates
  them with screenshots and accessibility data to produce
  `IosScreenSnapshot`, `IosElementContextItem`, and the `selectPoint`
  hit-test that powers the chat panel's tap-to-attach interaction.

## Lifecycle

1. **Status probe.** `getStatus()` runs the cached
   `commandExists` checks (10 s TTL) for `xcrun`, `xcodebuild`, `idb`,
   `idb_companion`, `ffmpeg`, fingerprints the booted iPhone simulator,
   surfaces the active session, and returns
   `IosSimulatorStatus { platform, supported, tools, activeDevice,
   activeSession }`. The renderer hides the iOS toggle whenever
   `supported` is false (non-darwin or `xcrun + xcodebuild` missing).

2. **Device + target discovery.** `listDevices()` parses
   `xcrun simctl list -j devices` and keeps `isAvailable` rows;
   `listLaunchTargets({ deviceUdid?, projectRoot? })` unions three
   sources tagged on each target: `xcode-project` (running
   `xcodebuild -list -json` against `apps/ios/ADE.xcodeproj` or any
   `*.xcodeproj` discovered under the project root, filtered by
   `IOS_APPLICATION_PRODUCT_TYPE`), `derived-data` (built `.app`
   bundles already present under `~/Library/Developer/Xcode/DerivedData`),
   and `simctl-listapps` (apps already installed on the chosen
   simulator). `canBuild` is true for project sources; `canLaunch`
   depends on whether a usable bundle id is known.

3. **Launch.** `launch(args)` walks an eight-step pipeline and emits
   one `launch-progress` event per step transition:
   `resolve-device → boot-simulator → open-simulator → resolve-target
   → build-app → install-app → launch-app → ready`. Each step has a
   typed `IosSimulatorLaunchStepStatus`
   (`pending | running | complete | skipped | failed`). Build runs
   `xcodebuild -scheme ... -destination 'generic/platform=iOS Simulator'
   -configuration Debug build`; install uses `xcrun simctl install`;
   launch uses `xcrun simctl launch --terminate-running-process
   <udid> <bundleId>`. Simulator.app is opened with `-g -a Simulator`
   by default so it stays in the background; pass
   `keepSimulatorInBackground: false` to bring it forward.

4. **Single-owner lock.** The service tracks one `activeSession` at a
   time with a `chatSessionId` field. A second `launch` call from a
   different chat session throws `IosSimulatorOwnedBySessionError`
   (code `IOS_SIMULATOR_OWNED_BY_OTHER_SESSION`). Callers can pass
   `force: true` to forcibly tear down the current session before
   launching, or call `shutdown({ force: true })` to release the
   lock from any session. The renderer surfaces this as a "claimed by
   another chat" lock card with a "Force release" affordance.

5. **Streaming.** Three backends share one `IosSimulatorStreamStatus`:
   - `simulator-window-capture` (`window-start`) — picks the
     Simulator.app window via `desktopCapturer`/`getDisplayMedia`
     constraints inside the renderer; lowest CPU, no idb required.
     Source picking lives in `pickSimulatorWindowSource` and prefers
     windows whose name contains the device name.
   - `idb-h264-ffmpeg-mjpeg` (`live-start`) — exact-screen
     pixel-perfect stream pumped through `idb video-stream` and
     transcoded to MJPEG via `ffmpeg`. Requires idb + idb_companion +
     ffmpeg.
   - `simctl-screenshot-poll` (`preview-start`) — fallback that polls
     `simctl io ... screenshot` at low fps. No external deps; works
     anywhere `xcrun` works.
   The HTTP MJPEG server sits on a free port; `streamUrl`,
   `targetFps`, current `fps`, `frameCount`, `lastFrameAt`, and
   `averageLatencyMs` are reported through `getStreamStatus()` and
   the `stream-status` event (throttled to 500 ms).

6. **Inspect + select.** `getScreenSnapshot({ x?, y? })` captures a
   screenshot, reads the latest `Documents/ade-inspector-elements.json`
   from the launched app's data container (when the bundle published
   one — see [inspector.md](inspector.md)), optionally falls back to
   `idb ui describe-all --json --nested`, merges the two layers,
   and returns the union plus a `hitElement` resolved against (x, y).
   `inspectPoint` returns the same payload wrapped in a context item.
   `selectPoint` builds an `IosElementContextItem`, emits
   `{ type: "selection", item }` so any subscribed renderer can fold
   it into its composer state, and stores it as `lastSelectedItem`.
   Coordinate-only fallback selections are tagged
   `source: "coordinate-fallback"`.

7. **Input.** `tap`, `drag`, `swipe` (alias of `drag`), and `typeText`
   all route through idb against the active companion; `idb_companion`
   is launched lazily and torn down 30 s after last use
   (`COMPANION_IDLE_STOP_MS`).

8. **Shutdown.** `shutdown({ force? })` stops the stream, kills the
   transcoder, releases the idb companion, clears `activeSession`,
   and emits `session-released`. App shutdown calls `dispose()` from
   `main.ts` so streams and child processes do not leak across
   project switches.

## IPC surface

Channel constants live in `apps/desktop/src/shared/ipc.ts`. Handlers
live in `registerIpc.ts`. The renderer talks to these through
`window.ade.iosSimulator.*`.

| Channel | Method | Purpose |
|---|---|---|
| `ade.iosSimulator.getStatus` | `getStatus()` | Tool readiness + active device + active session. |
| `ade.iosSimulator.listDevices` | `listDevices()` | Available simulators. |
| `ade.iosSimulator.listLaunchTargets` | `listLaunchTargets({ deviceUdid?, projectRoot? })` | Union of project / derived-data / simctl-listapps targets. |
| `ade.iosSimulator.launch` | `launch(args)` | Boot + build + install + launch with progress events. |
| `ade.iosSimulator.shutdown` | `shutdown({ force? })` | Tear down session, streams, and idb companion. |
| `ade.iosSimulator.screenshot` | `screenshot()` | One-shot PNG via simctl. |
| `ade.iosSimulator.getScreenSnapshot` | `getScreenSnapshot({ x?, y? })` | Screenshot + selectable elements + optional hit element. |
| `ade.iosSimulator.getInspectorSnapshot` | `getInspectorSnapshot()` | Latest ADEInspector frames only. |
| `ade.iosSimulator.inspectPoint` | `inspectPoint({ x, y })` | Hit-test a point; returns a context item without committing it. |
| `ade.iosSimulator.getPreviewCapability` | `getPreviewCapability({ sourceFile?, sourceLine? })` | Xcode MCP / Preview Lab readiness and setup warnings. |
| `ade.iosSimulator.listPreviewTargets` | `listPreviewTargets({ sourceFile?, sourceLine? })` | Discover nearby `#Preview` / `PreviewProvider` targets. |
| `ade.iosSimulator.renderPreview` | `renderPreview({ sourceFilePath, previewDefinitionIndexInFile? })` | Render a SwiftUI preview through Xcode MCP and return its snapshot. |
| `ade.iosSimulator.openPreviewWorkspace` | `openPreviewWorkspace()` | Open the lane's iOS project in Xcode. |
| `ade.iosSimulator.startStream` | `startStream({ backend?, fps? })` | Start one of the three streaming backends. |
| `ade.iosSimulator.stopStream` | `stopStream()` | Stop streaming. |
| `ade.iosSimulator.getStreamStatus` | `getStreamStatus()` | Backend, fps, latency, URL. |
| `ade.iosSimulator.listWindowSources` | `listWindowSources()` | Renderer-side helper for picking the Simulator.app window. |
| `ade.iosSimulator.tap` / `typeText` / `drag` / `swipe` | input verbs | Routed through idb. |
| `ade.iosSimulator.selectPoint` | `selectPoint({ x, y })` | Hit-test + emit a `selection` event so the chat composer can attach the resulting `IosElementContextItem`. |
| `ade.iosSimulator.event` | (push) | `IosSimulatorEventPayload` union: `session-started`, `session-updated`, `session-released`, `selection`, `launch-progress`, `stream-started`, `stream-status`, `stream-stopped`, `stream-frame`, `stream-error`. |

## ADE CLI surface

`apps/ade-cli/src/cli.ts` exposes `ade ios-sim` (aliases: `ade ios`,
`ade simulator`). Every subcommand maps to one `ios_simulator.<verb>`
action, so a chat agent calling `actions run ios_simulator.launch
--target <id>` and a user typing `ade --socket ios-sim launch
--target <id>` share one drawer state.

Discovery + lifecycle:

```
ade ios-sim status              # getStatus
ade ios-sim devices             # listDevices (alias: list, ls)
ade ios-sim apps --device <udid># listLaunchTargets
ade --socket ios-sim launch --target <id>
ade --socket ios-sim launch --bundle-id com.example
ade --socket ios-sim shutdown   # alias: stop. --force releases another chat's lock
ade ios-sim actions             # listActions for the namespace
```

Capture + inspection:

```
ade ios-sim screenshot          # one-shot PNG
ade ios-sim snapshot            # screenshot + selectable elements
ade ios-sim inspector           # ADEInspector snapshot only
ade ios-sim inspect --x 120 --y 420
```

Preview Lab:

```
ade ios-sim preview-status --text
ade ios-sim previews --source apps/ios/ADE/Views/Home.swift --text
ade ios-sim preview-render --source apps/ios/ADE/Views/Home.swift --index 0 --text
ade ios-sim preview-open
```

Streaming:

```
ade ios-sim window-start --fps 60   # simulator-window-capture
ade ios-sim live-start --fps 30     # idb-h264-ffmpeg-mjpeg
ade ios-sim preview-start --fps 8   # simctl-screenshot-poll
ade ios-sim stream-status
ade ios-sim stream-stop
```

Input + selection:

```
ade --socket ios-sim select --x 120 --y 420  # selectPoint, attaches to active drawer
ade ios-sim tap 120 420
ade ios-sim drag 120 700 120 250
ade ios-sim swipe 120 700 120 250
ade ios-sim type "hello" --text
ade ios-sim type --value "hello" --text
```

Use `--socket` for any verb that mutates drawer state (`launch`,
`shutdown`, `select`) so the running ADE service is the single owner;
capture-only verbs work in headless mode too.

## Renderer integration

`AgentChatPane` polls `getStatus()` once on mount and on
`session-started/-released/-updated/launch-progress` events. When
`status.supported` is true, the header renders a `DeviceMobile` toggle
that mounts `ChatIosSimulatorPanel` in place of the work-log panel.
The panel:

- Renders a tool-readiness checklist when any required tool is missing,
  with platform-specific install hints from the service
  (`INSTALL_HINT_XCODE`, `INSTALL_HINT_XCODE_CLI`, `INSTALL_HINT_IDB`,
  `INSTALL_HINT_IDB_COMPANION`, `INSTALL_HINT_FFMPEG`).
- Shows a launch progress strip while a launch is in-flight,
  collapsing back to the live preview once `ready` lands.
- Surfaces a "claimed by another chat" lock card with the owning chat
  id and a "Force release" button when the user opens the panel for a
  chat that does not own the active session.
- Switches between `interact` and `inspect` modes. Inspect mode draws
  the `IosScreenElement` rectangles returned from `getScreenSnapshot`
  on top of the live preview; clicking a rectangle calls `selectPoint`
  and the resulting `IosElementContextItem` is attached to the
  composer. Interact mode forwards pointer events as `tap` / `drag` /
  `swipe` and keyboard input as `typeText` against the same coordinate
  space.
- When a tap selects an element and a fresh screenshot was attached in
  the same gesture (within 10 s), the panel pairs them by stamping
  `metadata.attachmentPath` on the context item, so the composer can
  render one chip that links the element to the screenshot
  (`createIosContextInstanceId` keeps duplicates separable across
  multiple selections of the same element).

`AgentChatComposer` switches to a richer contenteditable mode whenever
`iosElementContextItems.length > 0`: each chip is a `data-ios-context`
node that is round-tripped through the editor and serialised back into
the agent prompt via `formatIosElementContextForPrompt` so the model
sees a structured tag rather than a raw string. The send button is
enabled when the draft has either text *or* at least one iOS element
chip attached.

## Fragile and tricky wiring

- **Single-owner errors must keep their code.** Renderer code uses
  `IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE` (string sentinel) to
  decide between "show the lock card" and "surface the raw error".
  Wrapping the service error with a generic `Error` strips the code
  and breaks the lock UI. Always re-throw the original
  `IosSimulatorOwnedBySessionError` from helpers.
- **Force-release semantics.** `launch({ force: true })` only tears
  down the active session when the incoming `chatSessionId` is missing
  or different from the current owner. Same-owner `force: true` is a
  no-op, intentionally — re-launching from the same chat must not
  bounce the simulator.
- **`open -g -a Simulator` matters.** Dropping `-g` brings
  Simulator.app to the front on every launch. This was a frequent
  user complaint when the desktop is in the background; keep `-g`
  unless `keepSimulatorInBackground === false`.
- **Stream backend stickiness.** Switching backends mid-session must
  call `stopStream()` first; the renderer relies on
  `stream-stopped → stream-started` ordering to clear the previous
  preview node. Issuing two `startStream` calls back-to-back without
  the stop produces overlapping fps tickers.
- **Inspector JSON path is bundle-scoped.** The service reads from the
  active `bundleId`'s data container, not from the project filesystem.
  Closing the app, reinstalling, or switching apps invalidates the
  snapshot — `getScreenSnapshot` reports
  `providers[].error: "No ADEInspector snapshot has been published by
  the active app."` and falls back to accessibility-only data.
- **idb_companion is reference-counted.** `ensureCompanion` increments
  on every input/accessibility call and the timer only fires after
  `COMPANION_IDLE_STOP_MS` of zero refcount. Bypassing
  `ensureCompanion` for one verb leaves the timer dangling and the
  companion gets killed mid-call.
- **Screenshot pairing window.** `AgentChatPane` tracks the most
  recent attachment via `latestAttachmentRef` and only stamps an
  `attachmentPath` onto the iOS element if the attachment was added
  in the last 10 s and the path has not been linked yet. The 10 s
  window is intentional — longer windows mis-pair across unrelated
  taps.

## Cross-links

- [inspector.md](inspector.md) — Swift `ADEInspectorKit` mechanics.
- [`features/chat/README.md`](../chat/README.md) — chat session
  lifecycle, IPC, and the surrounding panes.
- [`features/chat/composer-and-ui.md`](../chat/composer-and-ui.md) —
  the composer that consumes `IosElementContextItem` chips.
- [`features/sync-and-multi-device/ios-companion.md`](../sync-and-multi-device/ios-companion.md)
  — the iOS companion app whose DEBUG builds publish the inspector
  snapshot.
- [`features/computer-use/README.md`](../computer-use/README.md) —
  ADE's other capture-and-replay surface; the iOS simulator panel
  is intentionally separate so it can use simctl/idb/Simulator.app
  primitives without going through the proof artifact broker.
