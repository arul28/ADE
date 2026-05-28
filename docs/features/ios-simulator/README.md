# iOS Simulator

ADE drives the system iOS Simulator from the Work tools pane. It discovers
launchable iOS targets, builds and launches the selected app, mirrors the
running Simulator.app window into the drawer, and turns drawer gestures into
simulator input or context items for the active chat.

The feature is macOS-only. `xcrun`, `xcodebuild`, and Simulator.app must be
available on the runtime host. `idb` and `idb_companion` are optional but
recommended for direct tap, drag, text, accessibility, and hit-test actions.

## Runtime ownership

The simulator service runs where the ADE runtime runs. A local Mac runtime can
build, launch, mirror, and control the local Simulator.app. Non-macOS runtimes
report `supported: false`; the renderer hides simulator controls and CLI calls
reject with the macOS-only error.

Each launched simulator session has one owner chat/lane. A second chat trying
to launch against an active session receives
`IOS_SIMULATOR_OWNED_BY_OTHER_SESSION` until the current owner releases it or a
force shutdown is requested.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/ios/iosSimulatorService.ts` | Tool readiness, device/target discovery, build/install/launch, screenshots, ADEInspector/accessibility snapshots, Simulator.app live-view status, idb-backed input, Preview Lab, and single-owner session locking. |
| `apps/desktop/src/shared/types/iosSimulator.ts` | Cross-process iOS simulator types. `IosSimulatorStreamBackend` is `simulator-window-capture`. |
| `apps/desktop/src/main/services/ipc/registerIpc.ts` | IPC handlers plus macOS Simulator.app window state and parking. The owning ADE `BrowserWindow` keeps Simulator.app unminimized and parked behind itself. |
| `apps/desktop/src/renderer/components/chat/ChatIosSimulatorPanel.tsx` | Work drawer UI: setup checklist, device/target pickers, launch progress, live Simulator.app window video, interact/inspect modes, Preview Lab, and context attachment. |
| `apps/ade-cli/src/cli.ts` | `ade ios-sim` typed commands. `window-start` and `live-start` both start the same Simulator.app window stream. |
| `apps/ios/ADE/Debug/ADEInspectorKit/ADEInspectable.swift` | DEBUG-only Swift helpers that publish element frames into the app container for accurate inspect/select context. |

## Lifecycle

1. **Status.** `getStatus()` checks macOS support plus `xcrun`,
   `xcodebuild`, `idb`, and `idb_companion` readiness. The returned tool list
   drives the drawer checklist.

2. **Device and target discovery.** `listDevices()` parses
   `xcrun simctl list -j devices`. `listLaunchTargets()` combines Xcode
   projects, DerivedData app bundles, and already-installed simulator apps.
   Stale saved target ids are recovered when there is one clear replacement.

3. **Launch.** `launch(args)` emits progress for
   `resolve-device -> boot-simulator -> open-simulator -> resolve-target ->
   build-app -> install-app -> launch-app -> ready`. The default opens
   Simulator.app. Passing `keepSimulatorInBackground: true` skips that visible
   open step. IPC then parks the real Simulator.app window under the owning ADE
   window so the drawer can mirror it without leaving an extra foreground
   window in the user's way.

4. **Live view.** `startStream()` starts the Simulator.app window stream. The
   compatibility `backend: "auto"` input is normalized to
   `simulator-window-capture`; there is no separate ADE-managed streaming
   backend. The service records running status and opens Simulator.app with
   `open -g -a Simulator`. The renderer asks IPC for capturable Simulator window
   sources and attaches a desktop-capture stream to a `<video>`.

5. **Window parking.** `prepareSimulatorWindowForCapture()` opens Simulator.app,
   unhides/unminimizes its windows, sizes the simulator window, and places it
   under the ADE window that owns the active session. `followSimulatorWindowUnderAde()`
   re-parks the window on ADE move/resize. `iosSimulatorListWindowSources` uses
   the existing owner instead of stealing placement from another ADE window.

6. **Inspect and select.** `getScreenSnapshot()` captures a PNG, reads the
   app's ADEInspector snapshot when present, optionally augments it with idb
   accessibility data, and returns selectable elements. `inspectPoint()` returns
   a single context item; `selectPoint()` also emits a drawer selection event.

7. **Input.** `tap`, `drag`, `swipe`, and `typeText` use idb when both `idb`
   and `idb_companion` are installed. Missing idb does not block the live view;
   it only blocks direct control and accessibility-backed inspection.

8. **Shutdown.** `shutdown({ force? })` stops live-view status, releases the
   active session, stops idb companion work, clears window parking follow state,
   and emits `session-released`.

## CLI

```bash
ade --socket ios-sim status --text
ade --socket ios-sim devices --text
ade --socket ios-sim apps --text
ade --socket ios-sim launch --target <id> --text
ade --socket ios-sim live-start --fps 60 --text
ade --socket ios-sim stream-status --text
ade --socket ios-sim snapshot --text
ade --socket ios-sim select --x 120 --y 420 --text
ade --socket ios-sim tap --x 120 --y 420 --text
ade --socket ios-sim shutdown --text
```

Use `--socket` whenever the CLI and desktop drawer must share live session,
selection, and proof state.

## Troubleshooting

- If the live view is blank, verify Simulator.app is running and not minimized.
  The drawer polls `getSimulatorWindowState()` and shows the specific macOS
  window issue when capture is blocked.
- If taps or text fail but the live view works, install `idb` and
  `idb_companion`.
- If a launch is blocked by another owner, run
  `ade --socket ios-sim shutdown --force --text` or use the drawer's takeover
  action.
- If target discovery is wrong, run `ade --socket ios-sim apps --text` before
  creating schemes or project shims.
