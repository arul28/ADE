# iOS Simulator

ADE drives the system iOS Simulator from the Work tools pane and from
`ade ios-sim`. It discovers launchable iOS targets, builds and launches the
selected app, mirrors the running Simulator.app window into the drawer when the
user wants to watch, and turns drawer gestures into simulator input or context
items for the active chat. Agent launches stay in the background.

The feature is macOS-only. `xcrun`, `xcodebuild`, and Simulator.app must be
available on the runtime host. `idb` and `idb_companion` are optional but
recommended for direct tap, drag, text, accessibility, and hit-test actions.

## Runtime ownership

The simulator service runs where the ADE runtime runs. A local Mac runtime can
build, launch, mirror, and control the local Simulator.app. Non-macOS runtimes
report `supported: false`; the renderer hides simulator controls and every CLI
command rejects with the macOS-only error. `status` is the capability gate.
A remote Mac runtime supports control, screenshots, and Preview Lab, but not
the drawer live view, which is a local desktop-window capture.

Each launched simulator session has one owner chat/lane. A second chat trying
to launch against an active session receives
`IOS_SIMULATOR_OWNED_BY_OTHER_SESSION`, whose message carries the owning chat
id and lane and how long ago it claimed. Service messages state the fact and
the code and stop there — the drawer and the iOS app read the same string and
cannot run a shell command, so the "now run this" half lives in the CLI's own
hint (`iosSimulatorErrorHint`), keyed off the code.
Ownership releases automatically when the owning chat is deleted or archived —
those are the only two paths that call `notifyChatSessionEnded`, so a chat that
is merely closed or navigated away from still holds the session. `shutdown`
carries the caller's chat session id (the CLI forwards `$ADE_CHAT_SESSION_ID`),
and a shutdown from any other chat — or from a caller with no session id at all
— is refused with the same `IOS_SIMULATOR_OWNED_BY_OTHER_SESSION` code. The
owning chat releases its own session with a plain `shutdown`.

The guard is cooperative, and the docs should not suggest otherwise: it sorts
honest callers so no chat ends another's session by accident, and every way of
stating the intent works.

- `shutdown --force` — the documented escape hatch. It also hard-resets the
  session: tracked `idb` companions are stopped and `activeLaunchId` is
  cleared, which is what makes it the answer to a wedged
  `IOS_SIMULATOR_LAUNCH_IN_PROGRESS`.
- `shutdown({ ignoreOwnership: true })` — the bypass without the hard reset.
  ADE's lane-scoped drawer uses it: that surface deliberately drives whatever
  session its lane is running and hides the ownership card, so it names itself
  and asks the rule to stand down rather than impersonating the owner. It is
  reachable from the CLI through the generic `--arg ignoreOwnership=true`
  escape hatch like any other action argument.
- Naming the owner's own chat session id. `getStatus` is in the agent-allowed
  `ios_simulator` action list and reports `activeSession.chatSessionId`, so any
  caller can read the owner's id and pass it as its own — via `--chat-session`
  or `--arg chatSessionId=…`. A caller that names the owner *is* the owner as
  far as the check is concerned.
- `launch --force`, which validates the new target before evicting, and
  `attachToChatSession({ takeOver: true })`, which transfers ownership without
  a teardown at all.
- `attachToChatSession(<any chat id>, null)` — the cheapest path on the list,
  and the only one that needs no flag at all. The guard only runs when the
  caller supplies a non-empty `callerChatSessionId`, so a caller that passes
  `null` for it skips the check entirely: it can transfer the session to any
  chat, and `attachToChatSession(null, null)` detaches it outright — after
  which any chat's plain `shutdown` is accepted. It is reachable from an agent,
  not just from trusted code: `attachToChatSession` is in the agent-allowed
  `ios_simulator` action list, the RPC tool accepts a positional `argsList`,
  `ios_simulator` has no object-args requirement to force the named form, and
  `argsList` is applied straight to the method. The IPC path is unaffected —
  the renderer always passes both ids. The hole is documented in
  `attachToChatSession` itself and left open on purpose: closing it is a change
  to the ownership rules, not a doc fix.
- `claim --ignore-ownership` / `claim --force` (or `claim --arg
  ignoreOwnership=true`, which is the same thing). `claim`
  rewrites `activeSession.chatSessionId` outright, and the CLI defaults that id
  to the caller's own `$ADE_CHAT_SESSION_ID`, so `ade ios-sim claim --lane …`
  from a foreign chat used to take ownership with no bypass flag at all — after
  which a plain `shutdown` was accepted. It now carries the same cooperative
  guard as `shutdown`, and the bypass is spelled the same way. Naming no chat
  session id (or the owner's own) still only re-attributes the lane and is not
  a takeover.

Treat it as a guard rail against accidents, not as a lock: nothing here stops a
determined caller, and the agent skill tells agents to ask before evicting
rather than relying on the service to refuse.

### Build root

Simulator commands default their build root to the caller's lane worktree, not
the primary checkout, so a lane builds and launches its own code. An explicit
`--project-root` still wins. Target ids are validated against the resolved
root: an id minted under a different root fails with
`IOS_SIMULATOR_TARGET_ROOT_MISMATCH`, and the caller re-runs `apps` for a fresh
id. A `--lane` that resolves to no worktree is a hard failure
(`IOS_SIMULATOR_LANE_NOT_RESOLVED`), never a quiet fall back to the primary
checkout — that fallback is how a lane agent "verifies" code it never wrote.
The resolved root comes back on the launch result and on the session as
`buildRoot`, and on each `build-app` launch-progress step.

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
   build-app -> install-app -> launch-app -> ready`. The drawer renders those
   steps live. `ade ios-sim launch --follow` waits on a budget sized for a real
   cold build and prints the launch summary when it completes; the CLI does not
   stream per-step progress.

   CLI launches run in the background: Simulator.app is not foregrounded and
   the drawer is not forced open (`openDrawer` defaults to false; the drawer
   passes true for its own launches), so the user gets a "Simulator running"
   pill with an Open action instead. Only `selectPoint` / `inspectPoint` still reveal
   the drawer on their own. `--foreground` opts into the visible open, after
   which IPC parks the real Simulator.app window under the owning ADE window.

   The result carries `capabilities` (`canTap`, `canType`, `canDrag`,
   `canInspect`), the resolved `buildRoot`, and `usedInstalledBinary`. A launch
   that would silently reuse a previously-installed binary instead of the one
   just built fails, unless that installed target was chosen explicitly.

4. **Screenshot and proof.** `screenshot` writes a PNG and always returns an
   absolute `filePath` an agent can read (`dataUrl` remains for the renderer).
   `--out <path>` chooses where, resolving relative paths against the build
   root. The resolved path must stay **inside** that root — a `../` tail or an
   absolute path elsewhere is rejected, so a capture can never overwrite a file
   outside the tree it is proving. With no `--out` the file lands in
   `<buildRoot>/.ade/cache/ios-simulator/screenshots/` and the newest 20 are
   kept. `proof [--caption <text>]` captures a screenshot and attaches it to
   the ADE proof drawer, mirroring `ade browser proof`.

5. **Live view.** `startStream()` starts the Simulator.app window stream; the
   compatibility `backend: "auto"` input normalizes to
   `simulator-window-capture` and there is no separate ADE-managed backend. The
   renderer asks IPC for capturable Simulator window sources — the preload
   derives the binding itself — then attaches a desktop-capture stream to a
   `<video>`.
   `prepareSimulatorWindowForCapture()` unhides, sizes, and parks the simulator
   window under the owning ADE window; `followSimulatorWindowUnderAde()`
   re-parks on ADE move/resize.

6. **Inspect and select.** `getScreenSnapshot()` captures a PNG, reads the
   app's ADEInspector snapshot when present, optionally augments it with idb
   accessibility data, and returns selectable elements. `inspectPoint()` returns
   a single context item; `selectPoint()` also emits a drawer selection event.

7. **Input.** `tap`, `drag`, `swipe`, and `typeText` use idb when both `idb`
   and `idb_companion` are installed. Missing idb does not block the live view;
   it only blocks direct control and accessibility-backed inspection, and shows
   up as false `capabilities` on the launch result.

8. **Preview Lab.** `listPreviewTargets()` discovers nearby `#Preview` and
   `PreviewProvider` definitions. `resolvePreviewMatch()` ranks the best target
   for the selected source file or the drawer's last selected item, using
   inspector label/component metadata only as naming hints when a preview must
   be created. `renderCurrentPreview()` resolves the match, opens/waits for
   Xcode, then calls `renderPreview()` through Xcode MCP.

9. **Shutdown.** `shutdown({ chatSessionId?, force?, ignoreOwnership? })` stops
   live-view status, releases the active session, stops idb companion work,
   clears window parking follow state, and emits `session-released`. The
   ownership check runs before any of that, so a refused shutdown leaves the
   owner's session untouched — including its window-parking follow, which the
   IPC handler drops only after the call resolves. `force` additionally stops
   tracked idb companions and clears `activeLaunchId`; `ignoreOwnership` does
   neither and only stands the ownership check down. The session also releases
   on its own when the owning chat closes.

## CLI

The agent path is `status` (gate on `supported`) → `apps` → `launch` →
`screenshot --out` → `proof`.

```bash
ade --socket ios-sim status --text
ade --socket ios-sim apps --text
ade --socket ios-sim launch --target <id> --follow --text
ade --socket ios-sim screenshot --out .ade/tmp/sim.png --text
ade --socket ios-sim proof --caption "Settings row renders" --text
ade --socket ios-sim shutdown --text
```

Beyond that: `devices`, `launch --foreground`, `live-start --fps 60`,
`stream-status`, `snapshot`, `select --x --y`, `tap --x --y`, `preview-match`,
`preview-ensure`, `preview-current`, `preview-render`, `shutdown --force`.

Use `--socket` whenever the CLI and desktop drawer must share live session,
selection, and proof state. `launch` defaults to the caller's lane worktree and
to a background Simulator.app; `--foreground` opts into the visible window.
`claim --lane <id>` only attaches an already-running session to a lane; it is
not a step in a normal launch.

For current-screen Preview Lab work, run `select` on a source-backed element or
pass an explicit `--source` and `--line`, then `preview-current`. A `no-context`
result means nothing source-backed is selected; it is not a signal to guess the
SwiftUI screen from stale code.

## Troubleshooting

The drawer polls `getSimulatorWindowState()` and renders the specific
`IosSimulatorWindowIssue` as an overlay on the video area with one action:

| Issue | Overlay | Action |
|---|---|---|
| `screen-recording-permission` | ADE can't see the simulator window. | Open Privacy & Security > Screen Recording |
| `automation-denied` | ADE can't control Simulator. | Open Privacy & Security > Automation |
| `not-running` / `no-window` | Simulator not running / no window. | Relaunch |
| `hidden` / `minimized` | Simulator hidden or minimized. | Reveal |

A stream that reports active but delivers no new frame for ~3s shows a
"No frames" overlay with a restart action — a UI-only watchdog, not an `issue`.

- Taps or text fail but the live view works: install `idb` and `idb_companion`.
  The launch result's `capabilities` flags say up front which inputs are usable.
- Live view never renders on a remote Mac runtime: expected. Window capture is
  local-only. Use `screenshot` and `proof`.
- `IOS_SIMULATOR_OWNED_BY_OTHER_SESSION`: see "Runtime ownership". Closing the
  owning chat releases it. The drawer offers Attach (adopt the running session
  without a rebuild) and Take over (force shutdown + relaunch); the CLI
  equivalent is `ade --socket ios-sim shutdown --force --text`.
- `IOS_SIMULATOR_TARGET_ROOT_MISMATCH`: a stored target id points outside the
  resolved root — a `built` id carrying an absolute `.app` path from another
  checkout, or a `project` id naming a `.xcodeproj` that does not exist here.
  Re-run `ade --socket ios-sim apps --text` and relaunch with an id from that
  list.
- `IOS_SIMULATOR_NO_BUILDABLE_TARGET`: nothing buildable under the root and the
  caller named no target, so the only candidates would run stale code. The
  message lists buildable targets when any exist; `--target-id` / `--bundle-id`
  selects an installed app deliberately.
- `IOS_SIMULATOR_LAUNCH_IN_PROGRESS`: a launch is already running; the message
  carries its `launchId`. Wait rather than retrying, or
  `ade --socket ios-sim shutdown --force --text` if it is wedged — a force
  shutdown releases the launch lock as well as the session.
- `IOS_SIMULATOR_LANE_NOT_RESOLVED`: the named lane has no worktree on this
  machine. Pass `--project-root` with the checkout you actually want built.
- Target discovery wrong: run `ade --socket ios-sim apps --text` before creating
  schemes or project shims.
