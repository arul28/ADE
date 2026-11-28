# Mac Desktop

Each lane can own a private macOS screen. DAEX creates a virtual display named
after the lane, parks the lane's windows on it, and drives them through the
Accessibility API and process-targeted events. Without an input lease the
user's pointer stays on a real display.

The Work tools pane shows the screen live. `daex mac-desktop` drives it (aliases
`daex mac-desk`, `daex desk`; `daex desktop` is the app launcher; `ade` works for
all). `daex screen` is the neutral spelling every seat answers. Screenshots and
recordings reach the proof drawer through the computer-use artifact broker.

The feature is macOS-only on the **runtime host**. Windows, Linux, the web client
and the phone all show it for a lane whose host is a Mac. Windows and Linux hosts
have their own seats on the same service, lease, ownership, proof and
streaming: [Windows Desktop](../windows-desktop/README.md),
[Linux Desktop](../linux-desktop/README.md).

## Source file map

Native helper: `apps/desktop/native/ADEDesktopDriver/` (SwiftPM). Below, `Core/` is
`Sources/ADEDesktopDriverCore/` (pure logic) and `Exe/` is `Sources/ADEDesktopDriver/`
(everything that touches AppKit).

| Path | Role |
|---|---|
| `Core/DriverProtocol.swift` | Wire types and the full op table (its doc comment is the wire spec). |
| `Core/HandleRegistry.swift`, `OwnershipRegistry.swift` | Observation handles; window→display ownership and the single-instance rule. |
| `Core/LaneApps.swift` | Blank launches (`BlankLaunch`), which windows still need parking, what `stop` quits, release handover, `LaneAppMatch` for `quit <name>`. |
| `Core/LaneLifecycle.swift` | `LaneStopGate`, `ParkRecheck`, `CaptureStartReservations`. |
| `Core/WindowListScope.swift` | Which window-server entries a listing keeps (`WindowLayerPolicy`), before any AX read. |
| `Core/AXWalkBudget.swift` | Time budgets for every accessibility walk. |
| `Core/GestureGate.swift` | Parks ops that could corrupt a held real drag. |
| `Core/InputLease.swift`, `Geometry.swift`, `BackgroundEventRecord.swift`, `ScrollDelta.swift`, `WindowReadiness.swift`, `WaitCondition.swift`, `TypeCommand.swift`, `WindowHitTest.swift`, `LaneShortcut.swift`, `PendingRequestTracker.swift`, `IdleGapCompressor.swift` | Pure pieces: lease refusal, display geometry and arrangement, background focus records, scroll deltas, AX readiness backoff, waits, `type` parsing, hit tests, ⌘W/⌘Q for lane apps, one reply per request, idle-gap cut. |
| `Exe/main.swift`, `InputCommands.swift`, `RunLoopPump.swift` | NDJSON loop and dispatch (stdout is protocol, logs to stderr), the `input` op, waits that pump the run loop. |
| `Exe/VirtualDisplayHost.swift`, `ObjCDynamic.swift`, `DisplayLayout.swift`, `DisplayRelocation.swift`, `PointerFence.swift` | Private virtual-display classes via the ObjC runtime, display layout, following re-arranged displays, the pointer fence. |
| `Exe/WindowControl.swift`, `WindowWatcher.swift`, `AppLauncher.swift` | Window enumeration, parking, the per-pid watcher and sweep, `app.launch`. |
| `Exe/AccessibilityDriver.swift`, `RealInput.swift`, `BackgroundInput.swift`, `PhysicalInput.swift`, `Permissions.swift` | AX actions and process-targeted keys; leased `CGEvent` posts; background input; physical idle time; permission probes. |
| `Exe/CaptureEngine.swift`, `H264Encoder.swift`, `StreamByteServer.swift` | ScreenCaptureKit screenshots, stream, recording; VideoToolbox H.264; loopback fan-out. |
| `apps/desktop/scripts/build-mac-desktop-driver.mjs` | Builds the universal `ade-desktop-driver` into `resources/native`. |
| `apps/desktop/src/shared/types/macDesktop.ts` | The cross-process contract and the `DesktopSeatProvider` interface every seat implements. |
| `apps/desktop/src/main/services/macDesktop/macDesktopService.ts` | Lane→display, idle release, lease, events, teardown; wires the modules below. |
| `.../macDesktop/macDesktopSeatProvider.ts` | `createMacVirtualDisplayProvider`, the macOS seat; the only file that knows driver op names. |
| `.../macDesktop/macDesktopDriverLifecycle.ts`, `macDesktopDriverClient.ts` | Driver process, permission probes, health; the NDJSON client (per-process binary copy, stderr into the brain log). |
| `.../macDesktop/macDesktopWindows.ts`, `macDesktopHandoff.ts` | Launch, park, unpark, present; restart hand-off. |
| `.../macDesktop/macDesktopInput.ts`, `macDesktopNextStep.ts`, `macDesktopObservations.ts` | Observe and input, the `next:` hint on unconfirmed effects, observation storage. |
| `.../macDesktop/macDesktopLease.ts`, `macDesktopLeaseFlow.ts`, `macDesktopEscapeHotkey.ts` | Lease state machine, the pending-input card, global Escape. |
| `.../macDesktop/macDesktopStreaming.ts`, `macDesktopStreamServer.ts`, `macDesktopSyncStream.ts` | Live view, the token-guarded loopback endpoint, sync push fan-out. |
| `.../macDesktop/macDesktopRecording.ts` | Recording and `startHelperRecording`. |
| `.../macDesktop/macDesktopActionDomain.ts` | The `mac_desktop` action domain and platform gate. |
| `apps/desktop/src/main/services/native/nativeHelperPaths.ts` | `resolveMacDesktopDriverBinary` (`ADE_MAC_DESKTOP_DRIVER_PATH` override, executables only). |
| `apps/ade-cli/src/cliMacDesktop.ts`, `cliMacDesktopFormat.ts` | `daex screen` / `daex mac-desktop` plans and text output. |
| `apps/desktop/src/renderer/components/chat/ChatMacDesktopPanel.tsx`, `useMacDesktopPanelController.ts`, `MacDesktopPaneView.tsx`, `MacDesktopFullscreenView.tsx`, `MacDesktopStatusStrip.tsx`, `MacDesktopPermissionCard.tsx`, `MacDesktopStateCard.tsx`, `MacDesktopStopConfirm.tsx`, `macDesktopStatusStore.ts` | The pane. |
| `.../chat/useMacDesktopLiveView.ts`, `macDesktopLiveViewLease.ts`, `apps/desktop/src/renderer/components/device/h264FrameGate.ts` | Live view, the ref-counted one-decoder-per-lane lease, the keyframe gate. |
| `apps/desktop/src/renderer/components/work/MacDesktopMiniPlayer.tsx`, `shared/FloatingPlayer.tsx`, `shared/RecordingReceipt.tsx` | Floating player and the shell and receipts it shares with Apple. |
| `apps/ios/ADE/Views/Work/MacDesktop*.swift` | Phone card, live mount, viewer, stream math. |
| `apps/desktop/resources/agent-skills/daex-computer-use/SKILL.md` | The agent skill. |

## Gotchas / fragile areas

- **Stop quits every app the lane launched.** Each is asked to quit, then
  force-quit after `WindowControl.quitGrace` (3 s). Unsaved work in a lane copy
  is lost. Claimed user windows go home and are never quit. `appsLeftOpen` lists
  only survivors.
- **Release hands over the whole app.** Releasing one window of a lane-launched
  app moves every window of that instance to the main screen and drops the pid
  from the lane for good. A claimed user window goes back alone.
- **Every lane app is a blank copy.** `BlankLaunch` passes AppKit defaults to
  skip restored windows and the iCloud Open panel. Chromium/Electron/Gecko apps
  get none of those. A single-instance app ignores the new-instance request, so
  a second lane is refused by name (`MAC_DESKTOP_APP_OWNED_BY_OTHER_LANE`).
- **A stop during a wait cannot be undone.** `LaneStopGate` refuses `launch`,
  `park`, `stream.start` and `record.start` for a stopping lane; a park that
  waited re-checks (`ParkRecheck`) and leaves the window if the display was
  replaced, even at the same id.
- **One capture start per lane.** `CaptureStartReservations` refuses a nested
  second start; a stop during the wait cancels it. The service's
  `streamGenerations` tears down a start that resumes after a newer stop.
- **AX walks are on a clock** (`AXWalkBudget`): 1 s per element read, 2 s
  outside a walk, 5 s per `observe` walk, 2 s per `wait` poll, and an app that
  times out is skipped for 5 s.
- **So is capture.** `CaptureEngine.observeScreenshotBudget` (5 s) bounds one
  observe's screenshot so observe stays under the driver's 15 s watchdog; a
  frame that never arrives still returns the element tree. A screenshot that
  arrives while another waits more than `nestedScreenshotPatience` (1 s) is
  refused (observe returns no frame), so `ping` keeps answering.
- **Each driver runs from its own binary copy.** `replayd` keys
  ScreenCaptureKit clients by executable path; two live drivers on one path
  cancel each other forever (NSXPC 4097, completions never called).
  `macDesktopDriverClient` spawns an APFS clone at
  `<tmp>/ade-desktop-driver-bin/<node pid>-<client>/`. Links do not help. If
  you see `RPDaemonProxy: connection INTERRUPTED`, look for a second process on
  the same path.
- **Driver logs** go to stderr and into the brain log as
  `mac_desktop.driver_stderr` (`~/.ade/runtime/brain.jsonl` in the brain).
- **The virtual display API is private** (`CGVirtualDisplay*` via
  `NSClassFromString`). If it disappears, `status` reports
  `mode: "offscreen-region"` with a reason and windows park past the main
  display's visible frame. Never hidden.
- **DAEX only destroys displays it created**, by exact id (BetterDisplay and
  friends make their own).
- **Never post a `CGEvent` without the lease.** `RealInput.swift` checks the
  lease itself. Turning a `postToPid` key path into `post(tap:)` would hand every
  accessibility caller the user's keyboard.
- **Takeover cursor.** A HID-tap click moves the one system pointer. A takeover
  saves the pointer once and warps it back when control returns; a silent
  takeover click sets `restoreCursor`. Hover moves are not posted during a local
  takeover (a 60 Hz warp flood stalls ScreenCaptureKit); the pane draws a local
  pointer. Remote controllers never send `home` (their coordinates are the
  viewer's screen), and the sync host drops `homeX`/`homeY`.
- **Window ids die with their process.** Re-enumerate; never cache across a
  restart.
- **One decoder per lane.** The renderer's ref-counted lease elects the pane over
  the corner card and promotes the card when the pane unmounts. Two decoders for
  one lane is a defect.
- **`getStreamStatus` must stay redacted** (`url`/`token` null): it is on the
  agent allowlist and would land in transcripts.
- **A chat-bound `--lane` is refused, not swapped** ("This chat is bound to lane
  <a>; --lane <b> was ignored.").
- **Recording stop cannot wedge the driver.** Finalize only touches a `.writing`
  writer and waits at most `recordingFinalizeBudget` (2 s).

## Why a virtual display

Lanes isolate code with worktrees, not screens. macOS puts every display on one
global coordinate plane, so a window parked on a virtual display is a real
window with a real accessibility tree and real ScreenCaptureKit content, just
not where the user looks.

Four rules make the isolation hold:

- **Capture** is window- or display-scoped, never the whole screen.
- **Input** is Accessibility-scoped by default: no pointer move, no focus steal.
- **Pointer input** at a point is posted to the owning process
  ([Background input](#background-input)): no lease needed.
- **Real pointer and keyboard events need a lease.** Only hover and a drop onto
  another app still need them.

A single-instance app (Xcode, Finder, Simulator.app) can belong to one lane at a
time; the second lane is refused naming the holder. The signed Codex Computer
Use helper keeps working on parked windows unchanged; DAEX ships its own driver.

### Display placement and the pointer fence

Lane displays sit in a diagonal corner chain off the real displays, in a
session-only arrangement (saved preferences untouched), reapplied on display
changes (three refused placements per layout, then it stops).

A listen-only event tap returns an unleased physical pointer (or drag) that
enters a lane display to the real display it came from. It runs only while the
driver owns a virtual display. On macOS 27 the tap needs Input Monitoring, so
without the grant (`CGPreflightListenEventAccess`) the fence logs
`pointer fence off` and retries on each permission probe; the pointer can then
cross at a shared corner.

**A real display must never sit behind a lane display.** A newly connected
monitor can land beside a lane display only. The placement pass finds real
displays the main display cannot reach through real displays
(`Geometry.cutOffRealDisplays`) and moves them flush (three tries per cut-off).
If one is still unreachable, the fence stops guarding lane displays on the route
to it (`laneDisplaysOnRouteToCutOffRealDisplays`) rather than trap the person.

When macOS re-arranges displays, `DisplayRelocation.swift` moves each lane's
windows by the display's offset and emits `display-moved`; the service
republishes the display as `display-created`.

## Where this runs

The display, driver and capture run on the project's runtime host.

- **Local Mac runtime**: local IPC, loopback stream, "Bring to my screen".
- **Remote Mac runtime**: every call goes to the focused chat's machine (the
  session pin), not the tab's binding. The stream is read through a port forward
  (SSH, or the authenticated sync channel's `syncPortForwardClient.ts` over LAN,
  tailnet or relay); the loopback URL and token never leave the two machines.
  Over SSH the remote setup installs this desktop's driver beside the remote
  brain only when its hash changed, because the remote Mac's grants belong to
  that exact binary. A remote brain with no `mac_desktop` domain gets "<Machine>
  runs DAEX <version>, which has no Mac Desktop. Update DAEX there."
- **Other runtimes**: `getStatus` answers `supported: false`; every other method
  fails with `MAC_DESKTOP_UNSUPPORTED_PLATFORM`; the tab is hidden.
- **Phone and web client** read the `macDesktop` slice of `WorkToolsLaneState`
  (`shared/types/workTools.ts`). With `hello.features.macDesktopStream` they
  subscribe (`macDesktop.streamSubscribe`) and get `macDesktop.streamRecord`
  pushes (see Streaming). With `hello.features.macDesktopControl` they can take
  control via the controller-only `macDesktop.takeControl` / `returnControl` /
  `renewLease` / `input`, heartbeat the lease, and treat Escape as "give it back"
  (never typed into the lane). The web client can start and stop the display;
  the phone can start it from the Off card and never stops it.

## Ownership

One display per lane; every chat in the lane sees it. A window joins by:

1. **Launch**: `daex mac-desktop open <app|path|url>` starts a new copy; the
   driver watches the pid and parks each window. Apps get a user-process
   environment (`userProcessEnv`), not the brain's (`ELECTRON_RUN_AS_NODE=1`
   would break Electron apps).
2. **Claim**: `claim --window <id>` moves an existing window over; `release`
   puts it back.

App Control and iOS Simulator windows stay where they are (each captures its
own); claim one only to keep it fully off the user's screen.

Listings are filtered by lane, pid or window id before any AX read
(`WindowListScope`); only the claim picker lists every window. A window that
moves itself off is re-parked once per move, and one that keeps leaving is
released and reported as `window-not-parked` (shown in the pane and in
`WorkToolsMacDesktopState.notParked`). Minimized windows are not escapes.

**Panels and sheets.** `WindowLayerPolicy` admits layer 0 for everyone and
layers 1–23 only for lane apps, named lookups, or the Open/Save panel service in
a lane listing; nothing at 24+. Listings mark `[panel]`, `[modal panel]`,
`[sheet of #id]`. `observe` walks panels and sheets first; `press` with no
target goes to the newest modal panel or sheet. On macOS 27 a sandboxed app's
Open/Save panel window belongs to the app, so it is a lane window; a window the
panel service itself owns is never taken. A bare Escape/Return aimed at a lane
dialog presses its cancel/default button through Accessibility (`pressedButton`),
because posted keys never reach the out-of-process panel content. When the
sweep cannot move a lane app's panel, `observe` returns a `warnings` line so the
agent stops instead of typing into the user's display.

**Opening a document** (`documentInstance` in `AppLauncher.swift`): if only the
lane runs the app, the file goes to the lane's copy; if the lane and someone
else both run it, refused (macOS might pick the user's copy); if only someone
else runs it, a new copy with a warning; `--new-instance` always opens a new
copy.

**Quitting by name.** `quit <name>` matches the lane's own apps by any name they
go by (case and `.app` ignored; a unique prefix works) and refuses an ambiguous
match listing both.

## Lifecycle

1. **Auto-start** when a chat first opens the tab or an agent is granted the
   tool.
2. **Permissions** come from the helper's `ping` (no shelling out).
   `MacDesktopPermissionCard` shows one row per grant (Screen & System Audio
   Recording, Accessibility) with Open Settings (the
   `com.apple.settings.PrivacySecurity.extension` URL form) and Check again.
   With no display, Check again restarts the helper (macOS often hides a later
   grant from a running process). A help line explains removing and re-adding a
   stale entry, open by default on ad-hoc builds. While a viewer reads status
   the helper watches for transitions (`watch-permissions`, within 3 s);
   revocation emits `permission-changed`. Missing grants make actions fail with
   `MAC_DESKTOP_PERMISSION_REQUIRED`, and `takeControl` refuses on the host.
   macOS ignores synthetic clicks on privacy switches, so grants are made on the
   real screen.
3. **Idle release**: no windows, no reader and no recording for
   `MAC_DESKTOP_IDLE_RELEASE_MS` (10 minutes) destroys the display on a 30 s
   sweep. Size comes from KV `macDesktop.resolution`, default
   `MAC_DESKTOP_DEFAULT_RESOLUTION` (`1440p`).
4. **Stop** (pane, tab-close confirm, `daex mac-desktop stop`, lane removal,
   quitting DAEX, idle release, lost display) quits every lane-launched app as
   above.
5. **A brain restart is not a stop.** The brain (`bootstrap.ts`,
   `handOffAppsOnExit`) spawns the driver with `ADE_DESKTOP_DRIVER_HANDOFF_PATH`.
   On exit with it set, the driver quits nothing: it records each display's size
   and window frames, moves lane apps to the main screen, sends borrowed windows
   home and writes `<project>/.ade/cache/mac-desktop-handoff.json`. The next
   service claims the file atomically, recreates displays and takes apps back
   with `app.adopt` (matching pid, bundle id and kernel start time); transient
   failures retry until 15 minutes. The driver ignores `SIGPIPE` so the brain's
   exit cannot kill it mid hand-off. The in-app runtime (`main.ts`) does not set
   the path, so quitting the app still quits lane apps.
6. **Teardown**: lane delete/archive run the `destroy_mac_desktop` step; a chat
   ending releases its lease (`releaseIfOwnedBy`).
7. **Reconciliation**: `display.reconcile` destroys this process's displays
   whose lane is gone. A `CGVirtualDisplay` dies with its process, so a crash
   leaks nothing.

## The input lease

Accessibility and background input need no lease; real pointer and keyboard
events do.

- A chat asks once through the pending-input card (the same path as
  `daex chat ask`) and keeps real input for its life. One controller at a time.
- While a person holds control, agent input (real, background or accessibility)
  is refused with `MAC_DESKTOP_USER_HAS_CONTROL`.
- A web takeover's holder id is derived by the brain:
  `web:<connectionId>:<clientToken>`, never taken from the wire. A dropped socket
  returns the lease at once; the TTL guarantees it cannot stick. Sleep is
  detected as a wall-clock jump on the idle sweep (the service also runs in the
  daemon, where `powerMonitor` does not exist).
- **Agents cannot wear the human's id.** `scopeMacDesktopAdeActionArgs`
  (`adeRpcServer.ts`) and `scopeAutomationAdeActionArgs` (`automationService.ts`)
  strip `chatSessionId`, `controllerId` and `holderId` from agent calls and
  refill the chat id from the caller's session.
- **An agent with no resolvable lane acts on nothing**; `getStatus` and
  `listWindows` still answer.
- **An `ade` process with no chat identity** (`ade-cli:<pid>`, e.g. OpenCode
  agents' shells) has those fields stripped
  (`scopeUnboundMacDesktopAdeActionArgs`): accessibility input works, real input
  and `requestInputLease` are refused. Its `callerRoot` binds it to the lane
  worktree it runs in.
- **The caller waits longer than the card.** The card is withdrawn after
  `MAC_DESKTOP_INPUT_LEASE_WAIT_MS` (170 s); the CLI floor is the brain's budget
  plus 15 s (`macDesktopInteractiveClientFloorMs`). The result's `outcome` is
  `granted`, `not_required`, `declined`, `unanswered`, `unasked`, `no_chat` or
  `held`; anything but a grant exits 1.

## Text targets

`click --text`, `type --target` and `wait --label` pick one element of the newest
observation by title, label, value or identifier, case-insensitive: exact name
with a press action, then any match with an action, then exact name, then any
match. (A window titled "Save Probe" must not beat its own "Save" button.) The
Windows and Linux drivers use the same order.

## Background input

`mode: "background"` delivers pointer events to the process owning the lane
window under the point, and nothing else. A Mac seat uses it for point clicks,
right/double clicks, scrolls and drags unless `--real`. An AX click on an
element with no press action falls back to it (`deliveredMode: background`).
Windows seats have no background path.

A bare `CGEventPostToPid` is dropped. What makes it land (measured on macOS 27
against AppKit, Electron 41 and Ableton Live 12):

1. **Route**: window id and pid in the event's routing fields, click group,
   button, subtype, pressure, and a window-local location via the private
   `CGEventSetWindowLocation`, after a `mouseMoved` at the target.
2. **Focus without activation**: `BackgroundEventRecord` focus and make-key
   records posted to the target with `SLPSPostEventRecordTo`. The user's app is
   not touched; but a window of the app the user is in front of is refused
   (their next keys would land in it).
3. **SkyLight posting** (`SLEventPostToPid`, falling back to
   `CGEventPostToPid`).
4. **Guard**: if the target makes itself frontmost, the user's app is put back.

Missing private symbols are listed in `background.degraded`; nothing falls back
to the HID tap. The target is the frontmost lane-app window under the point on
the lane's display (`WindowHitTest.backgroundCandidates`).

Points are global. Observations carry the display's `origin` and `bounds`
(printed as the `points` line). `--local` on `click`, `scroll`, `drag` takes a
display-local point; the CLI converts it to global itself so it works against
older brains. Off-display points are refused with the display's range
(`Geometry.offDisplayRefusal`). A drag must end in the window it started in; a
background drag cannot move a window (`effect.next` suggests `claim`).

Limits: hover is not delivered (needs `--real`); Chromium sees no held button
during a background drag; Chromium's AX tree stays closed on macOS 27, so an
Electron window lists only its frame (click by point or use App Control).

**Mixed versions.** `getStatus` lists `capabilities`
(`MAC_DESKTOP_BRAIN_CAPABILITIES`). The CLI refuses flags an older brain would
drop silently (`open --new-instance` needs `open.newInstance`, `proof record
--plain` needs `proof.plain`).

### Keyboard without a lease

`AccessibilityDriver` types by setting `kAXValueAttribute`. Where an element has
none (a canvas, a terminal, some Electron text areas) it posts keyboard events
with `CGEventPostToPid` to the lane process, which never enters the global event
stream. That is why it needs no lease.

### A new window is not drivable at once

A window shows in `CGWindowListCopyWindowInfo` before its app publishes it to
Accessibility. `WindowReadiness` retries (50–800 ms, about 1.5 s total), then
reports `MAC_DESKTOP_PERMISSION_REQUIRED` only when `AXIsProcessTrusted()` is
false, else `window_not_ready` (a `window-not-parked` event; the window stays on
the watch list). Never report the second as the first.

## Streaming

The driver encodes the display with VideoToolbox and serves Annex-B H.264 on a
token-guarded loopback endpoint (`macDesktopStreamServer.ts`). The renderer
decodes with WebCodecs.

Latency choices:

- **Input rides the stream port.** `POST /mac-desktop/input?lane=…&token=…`
  (`MAC_DESKTOP_INPUT_PATH`) goes straight to `macDesktopInput.postRealInput`
  with the same lease, AX and display gates, skipping the RPC round trip. Only a
  viewer holding the lane's transport can reach it; refusals come back as 409.
- **Main profile, low-latency rate control, `MaxFrameDelayCount = 0`.** WebCodecs
  buffers frames on High profile (w3c/webcodecs#732).
- **Newest frame wins** in `h264StreamPlayer.ts`: a stale delta is skipped and
  the picture holds until the next keyframe rather than painting corruption.
- **60 fps active, 10 idle.** The floating preview is a JPEG snapshot of the live
  canvas every 250 ms, not a second stream.

A still desktop produces no frames. So a reader attaching forces an IDR of the
last frame (`CaptureEngine.refreshKeyframe`), a keepalive re-encodes after a
second of silence, and if ScreenCaptureKit never delivers a first frame
(`-3805`), `refreshFallbackFrame` takes `SCScreenshotManager` stills until a real
frame arrives. The renderer keeps retrying every 30 s (`RECOVER_SLOW_MS`) while
someone watches.

The token is minted per `startStream` and returned only there. `getStreamStatus`
reports `viewerChatSessionIds`, which the corner card reads to decide whether the
chat in front is actually watching.

**Owners.** Every asker (chat, anonymous viewer, sync subscription) joins the
stream's owner set; the encoder stops only when it empties. `stopStream` is
CTO/human-only and stops it for everyone; a chat ending uses `stopOwnedBy`.

**Sync pushes.** `macDesktopSyncStream.ts` reads the loopback stream in-process
and pushes `macDesktop.streamRecord` (ending with `macDesktop.streamEnded`); the
URL and token never cross. Past 2 MiB queued it skips to the next keyframe; a
record the host's 4 MiB gate refuses counts as a broken chain. Subscription ids
over 128 characters, or a third subscription per connection and lane, are
refused (`MAC_DESKTOP_STREAM_SUBSCRIPTION_ID_TOO_LONG`,
`MAC_DESKTOP_STREAM_SUBSCRIPTION_LIMIT`). A subscription counts as activity, so
the lane stays at full rate. Clients gate decoders on `seq` gaps and only call it
"playing" after the first drawn frame.

### The pane

The picture, a 40 px strip (state dot plus icon controls: Record, Save
screenshot, Present, Take over / Return to agent, Full screen) and an **Apps**
section listing parked windows with Release and an inline Add app picker. No lane
name, status sentence or the word "lease" in the pane. One status strip
(`MacDesktopStatusStrip.tsx`) shows the most pressing problem (capture failure,
refused input, missing grant, "Video stopped." with Reconnect). Recording shows a
pill and then a "Saved to proof" receipt (`shared/RecordingReceipt.tsx`).

Pointer, wheel and key listeners are native DOM listeners on the surface, not
React props: the decoder canvas is a React portal, and portal synthetic events
bubble to the wrong owner. The first click takes control. Real pointer events go
through the HID tap (a `postToPid` mouse event carries window number 0 and is
dropped); keys go by `postToPid` to the lane's frontmost process. "Full screen"
inside the Work sidebar is the pane's own maximise (`workToolsMaximize`), so
nothing remounts.

### Floating player and lane mark

`MacDesktopMiniPlayer` floats on the shared `FloatingPlayer` shell (drag, resize,
status dot, hover bar with Open in pane, picture in picture, Close). It shows
for the chat in front when that chat may see the desktop and the pane is not
showing it (`macDesktopFloatState`). The hover bar names who drives. Picture in
picture uses `enterCanvasPictureInPicture` while the player holds the decoder.
The Work list shows a `Monitor` mark beside lanes with a display
(`useLaneMacDesktops`: one `getStatus({})`, then events; no timer). The web
read-only view shows Recording and owner badges.

## Proof

A caption makes a capture proof. `daex mac-desktop screenshot` writes a scratch
file; `proof --caption "<text>"` files a record and re-observes; `record start`
files the movie only with `--caption`. The CLI never invents a caption. The pane
does (`macDesktopPaneCaption`), since a person pressing Record wants it kept.
`record start --plain` keeps real time; `--real-screen` is always real time.

Records use `backendName: "ade-mac-desktop"` through
`ingest_computer_use_artifacts`, owned by the lane, the chat and the lane's PR.

- Observation frames: `.ade/cache/mac-desktop-observations/<laneId>/` with an
  `ownerLaneId` sidecar (the root `workToolsStateService.readObservationPreview`
  serves).
- Recordings: the computer-use artifact store under `.ade/artifacts`
  (`ade-artifact://` serves only there).
- `--out` may be inside the lane worktree or `$TMPDIR`; anything else is refused,
  with symlink checks.
- Every recording start goes through `startHelperRecording`; a start the
  watchdog timed out is followed by a stop only while it still owns the slot.
  Only App Control treats "already recording" as an orphan.
- A failed stop sets `running: false` and `lastError`, keeping `status` and a
  second stop consistent. A recording with no frames is refused and removed.

## The native helper

`DriverProtocol.swift` is the wire spec: one JSON object per line; a request with
an `id` is always answered; unknown ops answer `code: "unknown_op"` (a newer Node
talking to an older helper is normal during updates).

`npm --prefix apps/desktop run build:mac-native` builds every macOS helper
(`build:desktop-driver` this one): a universal binary at
`apps/desktop/resources/native/ade-desktop-driver`, copied into
`Contents/Resources/native/` and checked by `validate-mac-artifacts.mjs`.
`npm --prefix apps/desktop run test:desktop-driver` runs the Swift suite; live display tests need
`ADE_DESKTOP_DRIVER_LIVE_TESTS=1`.

Measured private-API behavior on macOS 27: `maxPixelsWide`/`High` set the
display's **point** size, so the cap equals the requested working size; and
`hiDPI = 1` does not give a 2× scale, so the reply's `scale` is measured, never
echoed. If any class is missing or `applySettings:` refuses, the driver answers
`displayMode: "offscreen-region"`.

## Not in scope

Nested macOS VMs; replacing the built-in Browser, App Control or the iOS
Simulator tool; changing how Codex Computer Use launches.
