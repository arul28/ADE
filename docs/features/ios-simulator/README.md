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

Every device-hub method carries the same gate: device sessions, device tools,
the event log, semantic actions, and proof bundles. Each one shells out to
`xcrun`, so an ungated call answered a Windows or Linux caller with
`spawn xcrun ENOENT`, which reads as a broken install. The gate runs inside the
async method, so the call **rejects** rather than throwing before the promise
exists, and a caller handles one failure shape. Two paths stay open on every
platform. `getStatus` answers with `supported: false`, because that read is how
a non-Mac desktop learns it cannot run a simulator. `releaseIfOwnedBy` still
runs, because a closing chat must release its session anywhere.

A remote Mac runtime supports control, screenshots, and Preview Lab. Its live
view needs the `idb-h264` backend, because `simulator-window-capture` reads a
window on this desktop. See "Live view backends".

`ChatIosSimulatorPanel` takes a `runtimePin` naming the machine it drives, so
the panel follows the chat rather than the project tab: mounted in the Work
tools pane it receives that pane's pin (the machine the active Work session
runs on) and its `projectRoot` is the pinned machine's worktree for the active
lane, not the tab-local checkout. Status reads, device and launch-target lists,
launch / shutdown / screenshot / snapshot / stream / input / Preview Lab calls,
and the `iosSimulator.onEvent` subscription all carry the pin. The event half
matters as much as the reads: without a pinned subscription a pinned panel got
status reads and no live updates, and the bound machine's stream described a
different simulator entirely. The one part that does not follow the pin is the
live view — it captures the Simulator window through this window's own screen
capture — so a chat on another machine gets an explicit message saying the live
view shows the Simulator on this computer while the chat runs elsewhere.
Window parking, Screen Recording / Automation probes, and System Settings
openers stay on local Electron IPC: the brain daemon has no `BrowserWindow`.

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
  reachable from the CLI as `shutdown --ignore-ownership` (and, like any other
  action argument, through the generic `--arg ignoreOwnership=true`).
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
| `apps/desktop/src/main/services/ios/simulatorWindowCapture.ts` | Simulator.app window state, parking, Screen Recording / Automation probes, and System Settings openers. Process-wide follow state lives here so IPC stays handler wiring. |
| `apps/desktop/src/shared/types/iosSimulator.ts` | Cross-process iOS simulator types, including the device hub block: device sessions, stream transports, device tools, element queries, log rows, and proof bundles. `IosSimulatorStreamBackend` is `simulator-window-capture` or `idb-h264`. |
| `apps/desktop/src/main/services/ios/iosDeviceHub.ts` | Device sessions, device tools, semantic actions, the event log, and proof bundles. |
| `apps/desktop/src/main/services/ios/iosDeviceTools.ts` | The `simctl` calls behind every device tool, plus the `notifyutil` announcement the accessibility preferences need. |
| `apps/desktop/src/main/services/ios/iosEventLog.ts` | The `log stream` reader and the ring that interleaves device rows with ADE rows. |
| `apps/desktop/src/main/services/ios/iosSemanticActions.ts` | Pure element matching and the `id:`/`component:`/`label:`/`pos:` ref tiers. |
| `apps/desktop/src/main/services/ios/iosVideoStreamServer.ts` | The token-guarded loopback HTTP endpoint that serves `idb-h264` access units. |
| `apps/desktop/src/main/services/ios/h264AnnexB.ts` | Pure Annex-B framing. It turns pipe chunks into whole access units and reads the SPS to build the decoder's codec string. It does no I/O. |
| `apps/desktop/src/main/services/ipc/registerIpc.ts` | IPC handlers for the simulator domain, including one channel per device-hub action. Window capture and parking are delegated to `simulatorWindowCapture.ts`. |
| `apps/desktop/src/renderer/components/chat/ChatIosSimulatorPanel.tsx` | Work drawer UI: setup checklist, device/target pickers, launch progress, the live view for either backend, interact/inspect modes, the tools column, Preview Lab, and context attachment. Takes `runtimePin` and drives the simulator on that machine — every status read, list, launch/shutdown/capture call, and the `onEvent` subscription carry it. |
| `apps/desktop/src/renderer/components/chat/IosSimToolsColumn.tsx` | The side column of device controls: appearance, text size, accessibility options, location, permissions, push, status bar, app state, and the event log. |
| `apps/desktop/src/renderer/components/chat/useIosSimDeviceTools.ts` | State and polling for that column. It re-reads app state every 4 s and pulls event-log pages every 1.5 s, and it keeps a started log running while the video is expanded. |
| `apps/desktop/src/renderer/components/chat/IosSimH264Video.tsx` | Decodes the `idb-h264` stream with WebCodecs and draws it to a canvas. The canvas holds the device screen and no window chrome, so a click maps straight to a device point. |
| `apps/desktop/src/renderer/components/chat/iosSimVideoRecords.ts` | Parses the 12-byte record header the video server writes. It touches no DOM and no `fetch`, so a test feeds it hand-built chunks. |
| `apps/desktop/src/renderer/components/chat/IosSimWatchRibbon.tsx` | The compact ownership strip over the live view, with Attach and Take over. It replaces the full card, which pushed the video down. |
| `apps/desktop/src/renderer/components/chat/useIosSimBuildDuration.ts` | Remembers the last build duration per build root in `localStorage`, so the launch stepper can state the expected wait for a cold build. |
| `apps/desktop/src/renderer/components/terminals/WorkSidebar.tsx` | Mounts the panel as the Work tools pane's `ios` tool, keyed `work-ios:<pinKey>` so a machine switch remounts it. The pane's shared status reads (`useWorkToolStatuses`) run one pinned `iosSimulator.getStatus` / `onEvent` pair for as long as the pane is open — feeding the picker card, the header's activity dots, and the lane-mismatch banner — resolving lane names against the pinned machine's lanes, and skipping the probe entirely when that machine is known offline or the simulator cannot run here. |
| `apps/ade-cli/src/cli.ts` | `ade ios-sim` typed commands, including the device hub. `window-start` and `live-start` are aliases of `stream-start`, which defaults to `simulator-window-capture` and takes `--backend idb-h264`. |
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
   outside the tree it is proving. A symlink inside the root that points outside
   it is rejected too: ADE resolves both sides against the real filesystem, and
   a lexical check alone cannot see the link. A build root that is itself
   reached through a symlink still works, which is the normal case on macOS.
   Every one of those failures reports
   `IOS_SIMULATOR_OUT_PATH_OUTSIDE_ROOT`. With no `--out` the file lands in
   `<buildRoot>/.ade/cache/ios-simulator/screenshots/` and the newest 20 are
   kept. `proof [--caption <text>]` captures a screenshot and attaches it to
   the ADE proof drawer, mirroring `ade browser proof`.

5. **Live view.** `startStream()` starts one of two backends; see "Live view
   backends". The compatibility `backend: "auto"` input normalizes to
   `simulator-window-capture`. For window capture the renderer asks IPC for
   capturable Simulator window sources — the preload derives the binding itself
   — then attaches a desktop-capture stream to a `<video>`. For `idb-h264` the
   result carries a `transport` with a loopback URL and a token, and the
   renderer decodes the access units with WebCodecs.
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

## Device sessions

ADE keeps two kinds of session apart.

- An **app session** names a bundle id, a build root, and a lane. `launch`
  creates it. It builds your code, installs it, and starts it.
- A **device session** is a booted simulator with no app. `openDevice` creates
  it. It builds nothing and installs nothing.

Keeping the two apart lets a chat attach to a simulator it did not launch. Open
a device to watch an app that is already installed. Open a device to drive a
simulator that another tool set up.

`openDevice` boots the device when it is not already booted, then makes it
streamable. It records whether ADE did the boot in `bootedByAde`. `openWindow`
defaults to true and opens Simulator.app; pass `false` for a headless device.
`force` takes a device session another chat owns.

`closeDevice` releases the session. **ADE never shuts down a device it did not
boot.** A user starts a simulator for their own work, and ADE closing it is a
loss the user cannot undo. Pass `shutdownDevice: true` to shut one down anyway.
`force` and `ignoreOwnership` stand the ownership check down, exactly as they do
for `shutdown`.

The CLI entry points are `ade ios-sim open-device` and
`ade ios-sim close-device`.

## Live view backends

Two backends produce the live view. `startStream` takes the choice as
`backend`; the legacy value `auto` normalizes to `simulator-window-capture`.

### `simulator-window-capture`

The renderer captures the real Simulator.app window on this Mac. Chromium hands
the compositor's own frames to a `<video>` element. Nothing encodes and nothing
copies, so this is the cheapest path that exists. It stays the default whenever
the simulator is local.

It needs two things:

- the Screen Recording grant for ADE,
- a visible, unminimized Simulator window.

It cannot work when the simulator runs on another machine, because the window is
not on this desktop.

### `idb-h264`

The machine that owns the simulator encodes the screen with `idb video-stream`.
That machine serves Annex-B H.264 access units over a loopback HTTP endpoint,
and every request carries a token. The desktop reads the endpoint directly when
the runtime is local. The desktop reads it through an SSH port forward when the
runtime is remote, the same way it forwards a lane preview server. The renderer
decodes with WebCodecs, using a codec string built from the stream's own SPS.

It needs `idb` and `idb_companion` on the machine that owns the simulator. It
needs no Screen Recording grant and no visible Simulator window. It is the only
backend that works when the simulator runs on another machine, so a Mac bound to
another Mac watches the session its agent drives.

The Work tools pane offers the iOS tool on macOS only, so a Windows or Linux
desktop cannot open this drawer even against a remote Mac. Nothing in the
transport prevents it — the gate is `supportsIosSimulator: isMacPlatform()` in
the renderer, which predates this backend.

The token is the stream's only authorization, so two rules protect it. A fresh
token is minted for every `startStream`, and only `startStream` returns it:
`getStreamStatus` reports the transport's shape with `url` and `token` null. That
read is on the action allowlist with no ownership guard, so an unredacted one
would print a live token into any agent's durable transcript.

Measured cost: a quiet iPhone screen costs about 0.5 Mbit/s at 20 fps. The
average access unit is about 4.4 KB. `scaleFactor` sends fewer pixels and
`compressionQuality` spends fewer bits per pixel; both take 0.1 to 1 and both
apply to `idb-h264` only.

## Device tools

Every device tool is one typed action over one `simctl` call.

| Action | `simctl` call |
|---|---|
| `getDeviceSettings` | `simctl ui <udid> appearance` / `content_size`, plus `simctl spawn <udid> defaults read com.apple.Accessibility` |
| `setAppearance` | `simctl ui <udid> appearance light\|dark` |
| `setContentSize` | `simctl ui <udid> content_size <size>` |
| `setAccessibilityOption` (`increase-contrast`) | `simctl ui <udid> increase_contrast enabled\|disabled` |
| `setAccessibilityOption` (every other option) | `simctl spawn <udid> defaults write com.apple.Accessibility <key> -bool`, then `simctl spawn <udid> notifyutil -p <notification>` |
| `setLocation` | `simctl location <udid> set <lat>,<lon>` |
| `clearLocation` | `simctl location <udid> clear` |
| `setPermission` | `simctl privacy <udid> grant\|revoke <service> <bundle-id>`, or `simctl privacy <udid> reset <service>` |
| `sendPushNotification` | `simctl push <udid> <bundle-id> <payload.json>` |
| `openUrl` | `simctl openurl <udid> <url>` |
| `relaunchApp` | `simctl terminate <udid> <bundle-id>`, then `simctl launch <udid> <bundle-id>` |
| `terminateApp` | `simctl terminate <udid> <bundle-id>` |
| `uninstallApp` | `simctl uninstall <udid> <bundle-id>` |
| `setStatusBar` | `simctl status_bar <udid> override [--time --dataNetwork --wifiBars --cellularBars --batteryState --batteryLevel]` |
| `clearStatusBar` | `simctl status_bar <udid> clear` |
| `getAppState` | `simctl spawn <udid> launchctl list` |

Four rules apply to the table above.

**`relaunchApp` does not build.** It restarts the binary that is already
installed. Use `launch` when the point is to see a code change; use
`relaunchApp` when the point is to see the app from its first screen again.

**`uninstallApp` is the only guarded tool.** It accepts three callers: the chat
that owns the device session, the chat that owns the app session, and any caller
when neither session is claimed. It refuses everyone else, unless that caller
passes `force`. The CLI fills the caller's id in from `$ADE_CHAT_SESSION_ID`, so
`ade ios-sim uninstall` from the owning chat needs no flag. Every other
tool here sets a value the owner can see and set back; an uninstall deletes the
app's container and its data. Input — `tap`, `type`, `drag` — stays unguarded for
the same reason it always has: ADE's lane-scoped surface drives whatever session
its lane is running.

**Only `increase-contrast` is a `simctl ui` option.** Reduce Motion, Reduce
Transparency, Bold Text, Invert Colors, Grayscale and VoiceOver are not. ADE
writes each of them to the device's own `com.apple.Accessibility` preferences
and then announces the change with `notifyutil`. The announcement is required: a
preference written without the notification is read by nothing until the app
relaunches, so the write alone looks like a silent failure.

**`simctl location` and `simctl status_bar` are write-only.** The device cannot
report either value back. `getDeviceSettings` therefore reports ADE's own record
of the last location it set in this process, and reports `null` after a runtime
restart rather than guessing. `statusBarOverridden` is the same kind of record.

`sendPushNotification` writes the APNs payload to a temporary file, passes that
file to `simctl push`, and deletes it afterwards, because a payload can hold
user text. It fills `aps.alert` in from `title` and `body` when the payload omits
it.

## Semantic actions

A coordinate tap is a guess that the layout did not move. The guess fails
silently: the tap lands on whatever moved into that rectangle, and the run
reports success. A query is a claim about the app instead — "the button labelled
Continue". `findElement`, `tapElement`, `fillElement`, `waitForElement` and
`assertVisible` all take the same `IosSimulatorElementQuery`: `ref`,
`identifier`, `label`, `text`, `role` and `index`. Every result reports
`matchCount`, so an ambiguous query is visible rather than silent.

ADE derives a `ref` for every element in a screen snapshot. The positional id of
an accessibility element is a tree path such as `accessibility:0.3.1`, and that
path changes as soon as a sibling appears. The ref replaces the path with the
most durable identity the element carries, and names the tier it used:

| Tier | Source | Survives |
|---|---|---|
| `id:` | The author's accessibility identifier. | A re-render and a layout change. |
| `component:` | A SwiftUI component matched by the ADE inspector. | A re-render, but not a rename. |
| `label:` | Role, element type, label and value together. | A re-render, but not a copy change. Two identical rows share one ref. |
| `pos:` | The positional id, because nothing better existed. | Nothing. |

Read a `pos:` ref as a warning. The element carries no identity of its own. Ask
the app author for an accessibility identifier instead of storing that ref.

Two results report refs. Each element action returns the `ref` of the element it
matched, and the proof bundle's `elements.json` carries one ref per element.
`getScreenSnapshot` itself still reports each element's positional `id`, which
is what `snapshot --text` prints.

`fillElement` taps the field before typing so the keyboard targets it; pass
`focusFirst: false` to skip that. `waitForElement` defaults to a 5000 ms budget,
caps at 60000 ms, and takes `state: "gone"` to wait for a disappearance. Use it
after a tap instead of a fixed sleep.

## Event log and proof bundles

`startEventLog` runs
`xcrun simctl spawn <udid> log stream --style compact --level info` on the
device and keeps the rows in a ring of 500. It requires a `bundleId`, and there
is no raw-predicate option, for the same reason: `log stream` reads the whole
device, so a run with no scope hands the caller every other app's rows and the
system's. There is also one log process per host, so `startEventLog` and `stopEventLog`
refuse a chat that owns neither half of the simulator unless it passes `force`.
Either claim counts, like `uninstallApp`: the common shape is a chat that ran
`launch`, which holds an app session and no device session at all. A proof
bundle leaves out `log.json` when the log follows a different device from the
one it captured, and records why in the metadata. `getEventLog` returns a page plus a
`cursor`; pass the cursor back as `sinceId` to read only new rows. The page also
reports `dropped`, the number of rows the ring discarded since the last read, so
a gap is stated rather than hidden. `stopEventLog` ends the stream and returns
the final page.

The log holds two kinds of row in one list. `device` rows are the app's own
`os_log` output. `ade` rows are what ADE did, and each carries the
`ade ios-sim` command that reproduces it. One list keeps the order visible, so a
reader sees that the dark-mode switch happened between two app log lines. Two
side-by-side lists would hide that order, because nothing ties the clocks
together.

`captureProofBundle` writes a directory instead of a lone PNG. A bare PNG does
not say which machine, which simulator, which build root, or what the agent had
just done, and those are the first questions a reviewer asks. The bundle writes:

- `screen.png` — the screenshot,
- `metadata.json` — machine, device, build root, caption, capture time,
- `elements.json` — every element on screen with its ref, unless
  `includeElements` is false,
- `log.json` — the most recent event log rows, up to `logRowLimit`.

With no `outDir` the bundle lands in `<buildRoot>/.ade/proof/ios-sim-<stamp>/`.
A relative `outDir` resolves against the build root. `outDir` reaches the
service from an agent's tool call, so it obeys the same containment rule as
`screenshot --out`: an absolute path elsewhere, a `../` tail, and a symlink
inside the root that points outside it all fail with
`IOS_SIMULATOR_OUT_PATH_OUTSIDE_ROOT`.

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

### Device hub subcommands

| Subcommand (aliases) | Action | Flags |
|---|---|---|
| `open-device` (`open-sim`, `boot`) | `openDevice` | `--device/--udid`, `--lane`, `--chat-session`, `--no-window`, `--force` |
| `close-device` (`close-sim`) | `closeDevice` | `--device`, `--chat-session`, `--force`, `--ignore-ownership`, `--shutdown` |
| `settings` (`device-settings`) | `getDeviceSettings` | `--device` |
| `appearance` | `setAppearance` | positional `light\|dark` or `--appearance`, `--device` |
| `content-size` (`text-size`) | `setContentSize` | positional size or `--content-size`, `--device` |
| `accessibility` (`a11y`) | `setAccessibilityOption` | positional `<option> <on\|off>` or `--option` with `--enabled`/`--disabled`, `--device` |
| `location` | `setLocation`, or `clearLocation` with `--clear` | positionals `<lat> <lon>` or `--latitude`/`--longitude`, `--clear`, `--device` |
| `permission` (`privacy`) | `setPermission` | positional `<grant\|revoke\|reset> <service>`, `--bundle-id`, `--device` |
| `push` | `sendPushNotification` | `--bundle-id`, `--title`, `--body`, `--payload`, `--device` |
| `open-url` | `openUrl` | positional url or `--url`, `--device` |
| `relaunch` | `relaunchApp` | `--bundle-id`, `--device` |
| `terminate` (`kill-app`) | `terminateApp` | `--bundle-id`, `--device` |
| `uninstall` | `uninstallApp` | `--bundle-id`, `--device`, `--force` (the caller's chat id comes from `$ADE_CHAT_SESSION_ID`) |
| `status-bar` | `setStatusBar`, or `clearStatusBar` with `--clear` | `--time`, `--data-network`, `--wifi-bars`, `--cellular-bars`, `--battery-level`, `--battery-state`, `--clear`, `--device` |
| `app-state` | `getAppState` | `--bundle-id`, `--device` |
| `log-start` (`logs-start`) | `startEventLog` | `--device`, `--bundle-id` (required), `--force` |
| `log-stop` (`logs-stop`) | `stopEventLog` | `--force` |
| `log` (`logs`) | `getEventLog` | `--device`, `--since`, `--limit` |
| `find-element` (`find`) | `findElement` | `--ref`, `--identifier`, `--label`, `--text`, `--role`, `--index`, `--device`, `--lane`, `--project` |
| `tap-element` | `tapElement` | the same element query |
| `fill-element` (`fill`) | `fillElement` | the same element query, plus `--value` or a positional, plus `--no-focus` |
| `wait-for-element` (`wait-for`) | `waitForElement` | the same element query, plus `--timeout-ms`, `--gone` |
| `assert-visible` (`assert`) | `assertVisible` | the same element query |
| `proof-bundle` | `captureProofBundle` | `--out`, `--caption`, `--no-elements`, `--log-rows`, `--device`, `--lane`, `--project` |
| `stream-start` | `startStream` | `--backend auto\|simulator-window-capture\|idb-h264`, `--fps`, `--scale-factor`, `--compression-quality`, `--device` |

`--text` is the one flag that reads two ways. A bare `--text` selects ADE's
human-readable output. `--text <value>` is the element query's substring match.
Write `--text-match <value>` when you want no ambiguity.

The semantic loop replaces a coordinate script:

```bash
ade --socket ios-sim open-device --text
ade --socket ios-sim snapshot --text
ade --socket ios-sim tap-element --label "Sign in" --text
ade --socket ios-sim fill-element --identifier email-field --value ada@example.com --text
ade --socket ios-sim wait-for-element --label "Welcome" --timeout-ms 8000 --text
ade --socket ios-sim assert-visible --label "Welcome" --text
ade --socket ios-sim proof-bundle --caption "Sign-in succeeds" --text
```

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
- Live view never renders on a remote Mac runtime: `simulator-window-capture`
  is local-only. Start the stream with `--backend idb-h264`, which encodes on
  the machine that owns the simulator. Install `idb` and `idb_companion` there
  first.
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
