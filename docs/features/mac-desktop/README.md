# Mac Desktop

Each lane can own a private macOS screen. ADE creates a virtual display named
after the lane, parks the lane's windows on it, and drives those windows through
the Accessibility API. The user's real display and the real pointer stay
untouched.

The Work tools pane shows that screen live, the `ade mac-desktop` command family
drives it (aliases `ade mac-desk` and `ade desk`; `ade desktop` stays the app
launcher), and screenshots and recordings reach the proof drawer through the
existing computer-use artifact broker.

The feature is macOS-only on the **runtime host**. A Windows desktop, a Linux
desktop, the hosted web client, and the phone all render the tool for a lane
whose runtime host is a Mac, because the display lives on that Mac.

## Why a virtual display

ADE lanes isolate code with git worktrees. They do not isolate a screen. Host
computer use on macOS drives the signed-in desktop: one pointer, one key window.
Two lanes then fight each other and fight the user.

A virtual display solves this because macOS puts every display — real or
virtual — on one global coordinate plane. A window parked at `x = 8000` is a
real window with a real accessibility tree and real ScreenCaptureKit content. It
is simply not where the user is looking.

Three rules make the isolation hold:

- **Capture is window-scoped or display-scoped, never screen-scoped.** ADE
  captures the virtual display, or one window on it.
- **Input is Accessibility-scoped by default.** `AXUIElementPerformAction` and
  `AXUIElementSetAttributeValue` act on a specific element in a specific
  process. They move no pointer and steal no focus.
- **Real pointer and keyboard events need a lease.** `CGEvent` posts are global,
  so they are the one capability that can disturb the user. A chat asks for them
  once, through the normal pending-input card, and holds a lease afterwards.

### The known limit

A single-instance application — Xcode, Finder, Simulator.app — has one process
and one window server connection. Two lanes cannot both own it. ADE's driver is
window-scoped, so a lane binds a **window set**, not an app; but when two lanes
ask for the same single-instance app, the second one is refused by name. The
error carries the holding lane, the same way
`IOS_SIMULATOR_OWNED_BY_OTHER_SESSION` does.

### Relation to Codex Computer Use

The signed OpenAI Codex Computer Use helper stays exactly as it is. It is
app-scoped and window-level, so it keeps working on a parked window with no
change. ADE cannot embed it — it is a signed OpenAI binary — so ADE ships its
own driver. Ghost OS remains an optional user-installed backend and is not
required.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/native/ADEDesktopDriver/` | The native helper. `ADEDesktopDriverCore` holds the wire types and the pure logic; `ade-desktop-driver` is the executable that talks NDJSON over stdin/stdout. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriverCore/DriverProtocol.swift` | Request/response/event wire types and the permissive decoder. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriverCore/HandleRegistry.swift` | Observation handles (`obs-<id>:e:<n>`) and their bounded retention. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriverCore/OwnershipRegistry.swift` | Which window belongs to which display, and the single-instance rule. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriver/VirtualDisplayHost.swift` | The private CoreGraphics virtual-display classes, reached only through the Objective-C runtime, with a fail-closed fallback. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriver/WindowControl.swift` | Window enumeration, parking, and the CGWindowID→AXUIElement bridge. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriver/WindowWatcher.swift` | The per-pid watcher: the AX observer, the 1s poll, and the sweep that parks new windows and drags escaped ones back. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriver/AppLauncher.swift` | `app.launch`: starting an app for a lane and parking whatever it opens. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriver/AccessibilityDriver.swift` | The accessibility tree, element actions, value setting, and process-targeted keys. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriver/CaptureEngine.swift` | ScreenCaptureKit screenshots, the element map, the live stream, and recording. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriver/StreamByteServer.swift` | The loopback TCP fan-out the live stream is served on. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriver/H264Encoder.swift` | VideoToolbox H.264, emitting Annex-B access units with the parameter sets in front of every keyframe. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriver/RunLoopPump.swift` | Spending a wait by pumping the main run loop, so one lane's wait never starves another lane's request or the health `ping`. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriver/RealInput.swift` | `CGEvent` pointer and keyboard posts. Refuses every call without a lease. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriver/main.swift` | The NDJSON loop, the op dispatcher, the periodic permission probe, and the signal-handled shutdown. stdout is protocol; every log line goes to stderr. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriver/InputCommands.swift` | The `input` op: accessibility commands, real-event commands, the wait, and the element resolver they share. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriver/ObjCDynamic.swift` | The Objective-C runtime calls the private display classes need: `objc_msgSend` by `dlsym`, and KVC that probes the setter first. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriver/Permissions.swift` | Screen Recording and Accessibility, probed without prompting; the one prompt it can fire is `request-permission`, which the service allows only for a local user's explicit click. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriver/PhysicalInput.swift` | Seconds since the last physical input, for the idle rate and the takeover check. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriverCore/InputLease.swift` | The lease the driver keeps for itself, and the refusal `RealInput` raises. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriverCore/GestureGate.swift` | While a real drag holds the mouse button, the ops that could corrupt it — any `input` except `wait`, and this lane's `display.destroy`/`present`/`window.unpark` — are parked in order and replayed when the button comes up. A `wait` is not parked: it would poll nested inside the drag's own run-loop pump and hold the button down, so it is refused with `gesture_in_flight` and the client retries against its own deadline. `ping`, `observe`, `window.list` and capture keep answering. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriverCore/Geometry.swift` | The global/display-local conversion and the offscreen-fallback arithmetic. |
| `apps/desktop/scripts/build-mac-desktop-driver.mjs` | Builds the universal `ade-desktop-driver` into `resources/native`, beside the notch helper. |
| `apps/desktop/src/shared/types/macDesktop.ts` | The cross-process contract, including the `DesktopSeatProvider` interface a later Linux seat backend implements. |
| `apps/desktop/src/main/services/macDesktop/macDesktopService.ts` | The runtime service: lane to display, idle release, the lease, events, and teardown. The window lifecycle, observation/input, streaming and recording halves are their own modules and are handed the service's registries and gates. |
| `apps/desktop/src/main/services/macDesktop/macDesktopSeatProvider.ts` | `createMacVirtualDisplayProvider` — the one `DesktopSeatProvider` implementation. One method per driver op; the only file that knows the op names. |
| `apps/desktop/src/main/services/macDesktop/macDesktopInput.ts` | The observation and input half: the one capture path, target→driver payload, who a call claims to be for the lease check, and the eight acting commands built on it. |
| `apps/desktop/src/main/services/macDesktop/macDesktopWindows.ts` | The window and app lifecycle: launching an app onto a lane's display, parking and unparking a window, presenting the set elsewhere, and the one window read every `windows-changed` event is built from. |
| `apps/desktop/src/main/services/macDesktop/macDesktopStreaming.ts` | The live view: the loopback server, the per-lane transport and its token, and who asked for the stream — chats and sync subscriptions tracked separately. |
| `apps/desktop/src/main/services/macDesktop/macDesktopSyncStream.ts` | The fan-out that turns a lane's loopback stream into `macDesktop.streamRecord` / `macDesktop.streamEnded` sync pushes, with per-subscription keyframe-gated backpressure. |
| `apps/desktop/src/main/services/macDesktop/macDesktopRecording.ts` | The two writers of a movie file — the per-turn time-lapse and the captioned recording — serialized against the helper's one recorder per lane. |
| `apps/desktop/src/main/services/macDesktop/macDesktopLeaseFlow.ts` | The pending-input card that asks for real input, and the lease push that makes the helper's own refusal correct. |
| `apps/desktop/src/main/services/macDesktop/macDesktopActionDomain.ts` | The `mac_desktop` action domain: its argument readers and its platform gate. `adeActions/registry.ts` keeps one wiring line. |
| `apps/desktop/src/main/services/macDesktop/macDesktopDriverClient.ts` | The NDJSON client for the helper, with restart backoff and health. |
| `apps/desktop/src/main/services/macDesktop/macDesktopStreamServer.ts` | The token-guarded loopback HTTP endpoint that serves H.264 access units. |
| `apps/desktop/src/main/services/macDesktop/macDesktopObservations.ts` | Observation storage, the numbered element map image, and the sidecar that binds a frame to a lane. |
| `apps/desktop/src/main/services/macDesktop/macDesktopLease.ts` | The input-lease state machine: agent grant per chat, user takeover, heartbeat renewal, TTL expiry, and the three refusal codes. Pure, injectable clock. |
| `apps/desktop/src/main/services/macDesktop/macDesktopOwnership.ts` | Lane→display, window→lane, window origin, the single-instance rule, and `ade_launched` pid bookkeeping. Pure. |
| `apps/desktop/src/main/services/native/nativeHelperPaths.ts` | Where both native helpers are. `resolveMacDesktopDriverBinary` sits beside the notch resolver because both binaries come from the same `resources/native` directory, and it also answers in the daemon, which has no Electron `app`. `ADE_MAC_DESKTOP_DRIVER_PATH` overrides it, but only when it names a file that can actually be executed. |
| `apps/ade-cli/src/bootstrap.ts` | Creates the service next to `iosSimulatorService` and `appControlService`. |
| `apps/ade-cli/src/cli.ts` | The `ade mac-desktop` command family. |
| `apps/desktop/src/renderer/components/chat/ChatMacDesktopPanel.tsx` | The Work tools pane tool. |
| `apps/desktop/src/renderer/components/chat/MacDesktopStatusStrip.tsx` | The pane's one status strip: a sentence, its buttons, and Details. |
| `apps/desktop/src/renderer/components/shared/RecordingReceipt.tsx` | The recording pill and the "Saved to proof" receipt, shared with the Apple device pane. |
| `apps/desktop/src/renderer/components/shared/ToolStatusStrip.tsx` | The opaque status strip shell, shared with the Apple device pane. |
| `apps/desktop/src/renderer/components/chat/useMacDesktopLiveView.ts` | The live view, its low-power idle rate, and its reconnect budget. |
| `apps/desktop/src/renderer/components/chat/macDesktopLiveViewLease.ts` | The renderer-side ref-counted lease: one stream per lane, one decoder, pane outranking the corner card. |
| `apps/desktop/src/renderer/components/chat/h264FrameGate.ts` | The pure sequence-gap/keyframe gate both pushed-source decoders hold P-frames with after a skipped record or a decoder error. |
| `apps/desktop/resources/agent-skills/ade-desktop/SKILL.md` | The bundled agent skill. |

## Where this runs

The display, the driver, and the capture all run on the machine that runs the
ADE runtime for the project. Nothing about the display exists on a viewing
client.

- **Local Mac runtime.** The desktop app talks to the service over local IPC,
  reads the stream from loopback, and can offer "Bring to my screen".
- **Remote Mac runtime.** Every call is routed to the FOCUSED CHAT's machine —
  the session machine the Work tools already follow — not to whichever project
  tab happens to be bound. A chat whose lane lives on another Mac gets that
  Mac's `getStatus`, `start`, input, and stream calls even while the tab sits on
  a laptop checkout, and switching focus between a Studio chat and a local chat
  flips the tool's availability with it, because the capability answer is cached
  per session machine. Only an unpinned chat (one that already lives on the
  tab's bound machine) takes the bound path.
  The stream is read through a local port forward: an SSH target gets the same
  SSH forward the `idb-h264` simulator backend uses, and a paired target gets a
  forward opened on the authenticated sync channel (`syncPortForwardClient.ts`)
  whichever route carried it — direct LAN, tailnet, or the ADE account relay.
  The loopback URL and its token never leave the two machines. "Bring to my
  screen" is hidden, because the user's screen is not on that Mac. Over an SSH
  target, the remote setup installs this desktop's driver beside the remote
  brain (`~/.ade-<channel>/bin/resources/native/ade-desktop-driver`), only when
  its hash changed: the remote Mac's Screen Recording and Accessibility grants
  belong to that exact binary, so a needless re-upload would take them away. When the
  remote brain predates this feature and has no `mac_desktop` domain at all, the
  pane says so in the machine's own terms — "<Machine name> runs ADE
  <version>, which has no Mac Desktop. Update ADE there." — instead of printing
  the action-domain refusal.
- **Non-Mac runtime.** `getStatus` answers `supported: false`. Every other
  method rejects with `MAC_DESKTOP_UNSUPPORTED_PLATFORM`. The renderer hides the
  tab.
- **Phone and hosted web client.** Both read the `macDesktop` slice of
  `WorkToolsLaneState` (`apps/desktop/src/shared/types/workTools.ts`): the
  display, its parked windows, the lease line, the stream state, and the last
  frame fetched through `workTools.readObservationPreview`. The phone and the
  hosted web client can both take over when the host advertises
  `hello.features.macDesktopControl`: each gets a Take control affordance,
  forwards pointer events (and a hardware keyboard, where the client has one)
  through `macDesktop.input`, heartbeats the lease, and treats Escape as the
  way out — it lifts a held button and returns the lease, and it is never
  typed into the lane. A phone has no system pointer of its own, so the same
  key is also the Return to agent button. Without that bit (an older host, a
  chat-only runtime) the phone stays on the still image and
  `WORK_TOOLS_CONTROL_HINT` still says control stays on the desktop. A missing
  `macDesktop` key, or `supported: false`, hides the tool rather than drawing
  an empty pane. Clicks from any of these clients land on the host's cursor,
  which nobody at the viewing machine is holding, so they do not jump the
  person's own pointer. Driving from the Mac that owns the display still does,
  and the pane says so.

  Both gain a live picture when the host advertises
  `hello.features.macDesktopStream` and the `macDesktop.streamSubscribe`
  command. The runtime opens a reader on the lane's loopback stream in-process
  and re-publishes its framed records as `macDesktop.streamRecord` push
  notifications on the sync socket, ending a subscription with
  `macDesktop.streamEnded`; the loopback URL and its token never cross that
  boundary. Each subscription joins the stream's owner set keyed by its
  `subscriptionId`, so one browser tab closing never stops the encoder under a
  chat that is still watching, and an explicit unsubscribe or a closed socket
  releases it like a closing chat would. Once the peer's queued bytes pass
  2 MiB the push drops frames until the next keyframe, so no client ever gets
  a P-frame whose reference was skipped.

  On the web client the live pane can also `macDesktop.start`/`stop` the lane's
  display. The phone never calls either: watching and driving a display the
  Mac already started is the phone's job, and creating one from a pocket is not.
  Both keep the still image until the first keyframe and when the feature (or a
  WebCodecs decoder) is absent.

  The phone subscribes while the sheet is visible and foregrounded, decodes the
  pushed `macDesktop.streamRecord` Annex-B H.264 frames with VideoToolbox,
  keeps the still image as the placeholder until the first keyframe, and
  unsubscribes on disappear, background, sheet close, or socket teardown. The
  hosted web client does the same with WebCodecs, unsubscribing on unmount, tab
  hidden, or socket close and re-subscribing after a reconnect.

  A second ADE desktop, pointed at a remote lane, uses the same panel as the
  host Mac. Its stream is the port-forwarded loopback the live view already
  opened, and pointer events — including hover, which the host Mac deliberately
  does not post — go to that stream's input endpoint. Escape there omits
  `home`: those coordinates are the viewer's screen, and the host would warp
  its own cursor to a point it has never drawn. The host falls back to the
  cursor hold it recorded itself.

  Phone takeover is the same four commands over the sync socket
  (`macDesktop.takeControl` / `returnControl` / `renewLease` / `input`). The
  sheet maps a finger through the shared letterbox arithmetic, refuses a
  display that did not report its origin (a click without one would land on
  the person's real screen), and gives the lease back when the sheet closes,
  the app backgrounds, or the socket drops. It does not send `home`.

  Web takeover is the desktop interaction over that same socket:
  `macDesktop.takeControl` / `returnControl` / `renewLease` / `input`, all
  controller-only (never `viewerAllowed`) and advertised with
  `hello.features.macDesktopControl`. The browser pane draws the same strip
  state ("You have control · Return to agent"), forwards pointer and keyboard
  through `useMacDesktopRealInput` with a sync sender, draws the same local
  cursor glyph, and renews the lease every TTL/3. It gives control back when
  the user hands it back, the tab hides, the page unloads, the socket closes,
  or the stream ends; and if the polled lease changes holder, it says "Control
  ended" rather than showing a stuck error. The controller id is never taken
  from the wire: see "The input lease" below.

## Ownership

One display per lane. Every chat in the lane sees the same tab and the same
display.

A window joins the lane's display in one of two ways.

1. **ADE launched it.** `ade mac-desktop open <app|path|url>` starts the app, and
   the driver watches that pid for new windows and parks each one. An
   App Control session and an iOS Simulator session owned by a chat in the lane
   park the same way.
2. **Somebody claimed it.** `ade mac-desktop claim --window <id>` moves an existing
   window onto the lane's display. `ade mac-desktop release --window <id>` puts it
   back where it came from.

A window that moves itself off the display is re-parked once per move, with a
bounded retry. A window that keeps leaving is released and reported, rather than
fought. "Reported" is a `window-not-parked` event, and it is shown: the desktop
panel prints one line under the parked-windows footer ("Window 42 stayed on your
screen (window_not_ready)") with a dismiss, and the same newest line appears in
the Work tools mirror on the phone and the web client via
`WorkToolsMacDesktopState.notParked`. Each surface keeps the three newest, one
entry per window, and drops an entry when a later `windows-changed` shows the
window parked after all.

Single-instance apps are one lane at a time. A second lane asking for the same
bundle id is refused with `MAC_DESKTOP_APP_OWNED_BY_OTHER_LANE`, and the message
names the holding lane.

## Lifecycle

1. **Auto-start.** The first time a chat opens the Mac Desktop tab, or the first
   time an agent is granted the tool, the service creates the display. There is
   no intermediate card.
2. **Permissions.** Screen Recording and Accessibility are reported by the
   helper's own `ping` reply — the service never shells out
   to probe, so nothing runs ungated on a non-Mac host. A missing grant is a
   card (`MacDesktopPermissionCard`) with one row per grant: its name ("Screen &
   System Audio Recording", "Accessibility"), what it is for, On or Off, and for
   an Off row the exact path in words and one "Open Settings" button that
   deep-links to that list (the `com.apple.settings.PrivacySecurity.extension`
   address form — the older `com.apple.preference.security` one opens the
   Privacy & Security root on macOS 26). "Check again" shows a spinner, then
   what it found ("Still off: …" or "All set."). With no display it restarts the
   helper before re-probing (`recheckPermissions`): macOS often does not show a
   grant made after a process started to that same process. With a live display
   it does not restart the helper, because that would close the display. It
   never starts a display; Start is the only start. A folded help line, "It's
   on, but still says missing?", gives the fix for a stale macOS entry: select
   the app (`responsibleAppName`, `ADE`/`ADE Alpha`/`ADE Beta`), press −, add
   it again with +, and press Check again. It is open by default when the build
   is ad-hoc (`signing === "adhoc"`), because macOS forgets the grant on every
   rebuild of such a build. While a viewer is reading the lane's status the service tells
   the helper to watch for a transition (`watch-permissions`), so an already
   open pane flips off "denied" by itself within 3 seconds of the toggle; with
   no watch and no display the helper probes nothing. A grant revoked mid-session
   otherwise arrives as a `permission-changed` event (10-second cadence while a
   display exists, emitted only on a transition), and every action then fails
   with `MAC_DESKTOP_PERMISSION_REQUIRED`. The driver can fire the system
   prompt through `request-permission` (only when the window asking is on the
   host, and the action is CTO-only), but the pane no longer offers it: macOS
   shows that prompt only once, and it only offers to open the same list.
   Accessibility missing while the picture already streams is the same card,
   listing only the missing grant, under the pane's top row, because a
   synthetic event posted without Accessibility is dropped by macOS with no
   error: the service refuses real input with `MAC_DESKTOP_PERMISSION_REQUIRED`
   naming the grant (`macDesktopInput.ts`) instead of letting a takeover look
   like a dead screen.
3. **Idle release.** A display with no parked windows, no stream reader and no
   running recording for `MAC_DESKTOP_IDLE_RELEASE_MS` is destroyed on a 30s
   sweep. The next open recreates it. The display size comes from the
   `macDesktop.resolution` KV setting, defaulting to
   `MAC_DESKTOP_DEFAULT_RESOLUTION`.
4. **Teardown.** Lane delete and lane archive destroy the display through the
   lane teardown step, next to the file watchers — a `destroy_mac_desktop` step
   that runs on every platform and reports "no display" off macOS. A chat that
   ends releases its lease through `releaseIfOwnedBy`, bound in `bootstrap.ts`
   through the same chat-session-ended listener the simulator uses.
5. **Reconciliation.** On service start, every ADE-created virtual display that
   no live lane claims is destroyed. A crashed run never leaks a display.

## The input lease

Accessibility actions need no lease. Real pointer and keyboard events do.

- A chat asks once, through the same pending-input card path `ade chat ask` and
  Codex MCP elicitation use. After one approval, that chat keeps using real
  input for the rest of its life.
- Only one controller holds the lease at a time.
- While the user holds control (takeover), agent input is refused with
  `MAC_DESKTOP_USER_HAS_CONTROL` and the agent waits.
- A web takeover holds the lease under an id the brain derives, never one the
  wire supplies: `web:<connectionId>:<clientToken>`, where the connection id is
  the host's per-socket identity and the token is the tab's own. A second
  socket can therefore never return or renew the first's lease, and a token
  lifted from one tab is inert on another.
- A remote viewer that disconnects during a takeover loses the lease on the
  socket close. The sync host returns it immediately through the same
  `returnControl` path a client uses (the command service records which derived
  ids a connection took), rather than waiting for the TTL. The lease has a
  heartbeat deadline, so it can never stick either way.
- Machine sleep drops the lease for the same reason. `powerMonitor` is
  Electron-only and this service also runs in the runtime daemon, so sleep is
  detected as a coarse wall-clock jump on the idle sweep (a tick that arrives
  four intervals late) and the lease TTL is what actually guarantees the lease
  cannot stick — the jump detector only makes the release immediate.
- **An agent cannot wear the human's holder id.** `getStatus().lease.holderId`
  prints the takeover's controller id to anyone who can read the lane, and the
  service prefers `controllerId` over the chat id when it decides who is
  holding the lease. There are two writers of those fields, and both strip
  them: the RPC scope in `adeRpcServer.ts` (`scopeMacDesktopAdeActionArgs`)
  cuts `chatSessionId`, `controllerId` and `holderId` from every agent-shaped
  call and re-fills the chat id from the caller's own session, and the
  automation runner in `automationService.ts`
  (`scopeAutomationAdeActionArgs`) cuts the same three from an `ade-action`
  step's resolved args, which call the domain service in-process and never pass
  through the RPC scope. Reading the holder id stays possible; using it does
  not.
- **An agent with no resolvable lane acts on nothing.** Accessibility-mode
  input is behind no lease at all, so an orchestration step or a chat whose
  session record is gone is refused every acting command rather than passed
  through naming someone else's lane. `getStatus` and `listWindows` still
  answer, because `getStatus` is the domain's capability probe.

## Streaming

The driver encodes the virtual display with VideoToolbox and writes Annex-B
H.264 access units to a token-guarded loopback HTTP endpoint, exactly like
`iosVideoStreamServer.ts`. The renderer decodes with WebCodecs, using a codec
string built from the stream's own SPS.

Latency is a set of deliberate choices, measured against the open-source
screen streamers that feel live on a LAN (SameDesk, OpenDisplay, VoidDisplay):

- **Input rides the stream port, not the brain RPC.** A takeover used to send
  every pointer event renderer → IPC → main → brain RPC → service → driver
  stdin, one full round trip each (about the cost of a whole CLI call), so at
  sixty moves a second the queue never drained and clicks lined up behind
  moves. `POST /mac-desktop/input?lane=…&token=…` on the same loopback server
  (`MAC_DESKTOP_INPUT_PATH`) takes `{controllerId, chatSessionId?, command,
  payload}` straight into `macDesktopInput.postRealInput`, which runs the same
  lease, Accessibility and display gates as the RPC path and skips only the
  observation a takeover never wanted. The renderer builds the sender from the
  stream URL it already holds (`createMacDesktopFastInputSender`), so only a
  viewer that was handed the lane's transport can reach it; a refusal comes
  back as 409 with the service's error code and lands on the input error line.
- **Main profile, low-latency rate control, zero frame delay.** WebCodecs
  holds up to four frames before it outputs the first one on a High-profile
  H.264 stream ([w3c/webcodecs#732](https://github.com/w3c/webcodecs/issues/732)),
  which is over a hundred milliseconds of built-in lag at thirty frames a
  second. The encoder now asks for Main, sets
  `EnableLowLatencyRateControl` (the setting every fast streamer names) and
  `MaxFrameDelayCount = 0`.
- **Newest frame wins in the decoder.** `H264VideoCanvas` drops a delta frame
  while the decoder still holds more than one, so the picture never shows where
  the pointer *was*; keyframes are always decoded because the next delta needs
  them.
- **60 fps active, 10 idle.** The idle floor was 3, so every first drag after a
  pause started as a slideshow and ramped up.
- **The floating preview is a JPEG snapshot of the live canvas, four times a
  second** (`FRAME_SNAPSHOT_MS`), not a second stream; at once a second it read
  as broken.

A still desktop produces no frames at all. ScreenCaptureKit delivers a frame
when the content changes and not otherwise, so a lane whose screen nobody has
touched stops sending within a second of the display appearing — which is the
state a viewer opening the tab arrives in, and the reason the first version of
this pane sat on a black rectangle reading "Starting" forever. Two things in the
driver make the picture unconditional: a reader attaching forces the encoder to
re-submit the last captured frame as an IDR (`CaptureEngine.refreshKeyframe`),
and while a reader is attached and nothing has been encoded for a second, the
same re-encode runs on a keepalive. The codec record is broadcast on the
transition as well as sent on attach, so a reader that arrived before the first
keyframe can still configure its decoder.

The pane is the picture, a 40px strip above it, and an Apps section under it.
The strip carries only a small coloured state dot at the far left (green live,
amber starting, red reconnecting) with the state in its tooltip, plus the icon
controls on the right — Record, Save screenshot, Present, Take over / Return to
agent, and Full screen / Exit full screen. There is no lane name, no status sentence, and no
Windows dropdown: the `ADE · <lane>` name and the window count were what made
the pane read as confusing. The Apps section names each window parked on this
desktop in the user's own vocabulary — app icon, app name, its window title
muted, and one Release button — and its heading row carries an Add app button.
Add app opens the window picker INLINE, replacing the list in place: no portal,
no sheet over the chat, and an opaque surface. The picker's copy matches
("Add an app to this desktop", "Add", "Moves the window onto this lane's
desktop."), and the word "lease" never appears in the pane. An empty desktop
reads "No apps on this desktop yet." with the Add app button in its heading.

Under the chrome row sits one status strip, in the Apple device pane's style
(`MacDesktopStatusStrip.tsx` over the shared `shared/ToolStatusStrip.tsx`). It
says one thing at a time, most pressing first: a capture that failed or a note
about one, a refused real input, a missing grant (with Open settings and Check
again), and a stopped video. The stopped video reads "Video stopped." with a
Reconnect button, which calls the live view's `restart` — a fresh `startStream`
with the retry budget reset — and the reason folded behind Details. Only the
wait ("Connecting to the lane's screen…") is painted on the picture itself.
Full screen draws the same strip under its own chrome row.

While a recording runs, a pill sits at the bottom centre of the picture: a red
dot that pulses only when motion is allowed, "Recording 00:12", and Stop. After
a capture is filed, a "Saved to proof · 00:12 · 3 MB" receipt replaces it for six
seconds (a screenshot's receipt has no running time), with Open and a dismiss.
Open scrolls to the proof row when the chat's proof panel is on screen, falls
back to opening the file when the lane's Mac is this one, and otherwise says the
capture is in the chat's proof drawer. The pill and the receipt are the Apple
pane's own components (`shared/RecordingReceipt.tsx`), drawn as siblings of the
picture so a click on them never takes control.

The token is minted per `startStream` and returned only by `startStream`.
`getStreamStatus` reports the transport shape with `url` and `token` null,
because that read sits on the agent action allowlist. It also reports
`viewerChatSessionIds` — the chats recorded as viewers of the current stream,
as ids and nothing else. The Work tab's floating preview reads that (plus the
lease holder) to decide whether the chat you are reading is actually watching
the lane's desktop; a chat that is neither a viewer nor the lease holder does
not get the lane's screen as a corner card.

The corner card is itself a viewer, not a picture someone else happens to
leave on screen. On the driver side a real event is delivered to the
PROCESS under the point (`WindowHitTest` in Core, `postToPid` in
`RealInput`), not to the HID tap: a tap post moves the one system cursor to
the event's coordinate, which on the Mac that hosts the display is the user's
own mouse being yanked onto a screen they cannot see on every click, and the
restore warp only softened that. A process post lands at the same coordinate
and leaves the cursor alone; keys go to the lane's frontmost window's process
for the same reason (the tap would type into whatever is frontmost on the
user's own screen). Only empty desktop, which has no process, still takes the
tap and the restore. Pointer, wheel and key input are bound to the surface as
native DOM listeners, never React props: the decoder's canvas is a React portal
into a host node parked inside the surface, and a portal's synthetic events
bubble to the portal's owner, not to the surface that is its DOM parent, which
is how every click and hover on the picture itself was lost while the letterbox
still responded. The first click on the picture takes control (the strip's
"Take over" button is the same action), and the picture shows a pointer cursor
until it does. Inside the Work sidebar, "full screen" is the pane's own
maximise (`workToolsMaximize`): the Work page hides the columns beside the
pane and lets it grow to the page, tab strip included, so Browser and Terminal
stay one click away, and Esc or the header button restores it. The state is
page-owned and nothing remounts (a portal did, and restarted the stream on
every toggle). The panel's own overlay is only the fallback where no sidebar
hosts it. The pane, full screen and the card share one decoder per lane
through a renderer-side ref-counted lease (`macDesktopLiveViewLease.ts`): the
first holder starts the stream, the last release stops it, and the decoder
belongs to the highest-priority holder — the pane (and with it full screen)
outranks the card. While the pane is open the card is a passive holder that
keeps the stream up without reading it; the moment the pane switches tools the
card is promoted and decodes into an off-screen canvas, so frames keep
reaching `macDesktopFrameStore` and the chat stays in `viewerChatSessionIds`.
Hiding the pane is not an unsubscribe, and a pane→card hand-off never reaches
zero holders, so the encoder is not stopped and restarted under the card.
Unmounting the last holder is what stops the lane's stream.

An explicit `stopStream` is not a per-watcher unsubscribe: it is CTO/human-only
and it stops the encoder for every watcher of that lane at once, because the
owner set goes with it. A chat ENDING is the gentle path — `stopOwnedBy` drops
only that chat and stops the stream only if the set empties.

An anonymous viewer — a live view opened with no chat session — is a member of
the owner set like any other, so no closing chat can ever empty a set it is in.
A stream only that viewer is watching is reclaimed by the idle path instead:
the stream server's zero-clients timer, or the lane's display teardown
(`forgetLane`).

The stream runs at a low frame rate while nothing happens — no agent action, no
takeover — and at full rate on activity. The last decoded frame is kept, which
is what the Lanes tab hover peek and the thread mini view render. Neither adds a
poller.

The phone and the hosted web client watch the same encoder through the sync
socket when `hello.features.macDesktopStream` is advertised.
`macDesktop.streamSubscribe` opens a loopback reader in the runtime
(`macDesktopSyncStream.ts`) and records the viewer as a **subscription** owner
keyed by its `subscriptionId`, kept out of `viewerChatSessionIds` because a
subscription is not a chat. The `config` and `frame` records arrive as
`macDesktop.streamRecord` pushes with the frames already keyframed-first, and
`macDesktop.streamUnsubscribe` — or the socket closing — removes the owner. It
uses the same keyframe-on-attach path every other reader gets, so a viewer
opening the card never waits on a still desktop. The phone can take over a
display the Mac already started, and never calls `macDesktop.start`/`stop`;
the web client can also start and stop the display. Pushes are best-effort: past
2 MiB queued they skip to the next keyframe instead of growing the socket
buffer without bound, and a record the sync host's own 4 MiB gate refuses is
treated as a broken reference chain — the next record sent is a keyframe.

A subscription is also activity. Subscribing notes activity on the stream
server immediately and every delivered record notes it again, throttled to once
a second, so a passive phone or browser keeps the lane at full rate instead of
letting it fall to the idle rate five quiet seconds after the last input. The
fan-out refuses a `subscriptionId` longer than 128 characters and a third live
subscription on one connection for one lane, with
`MAC_DESKTOP_STREAM_SUBSCRIPTION_ID_TOO_LONG` and
`MAC_DESKTOP_STREAM_SUBSCRIPTION_LIMIT` on the command result.

Both clients gate their decoders on the host's sequence numbers: a `seq` gap,
a decoder error, or a config rebuild holds P-frames until the next keyframe, and
"playing" means the first frame actually drawn rather than the first chunk
submitted. While the picture is playing the web pane skips the still-frame fetch
and lengthens its state poll to 15 s, because the pushes carry the picture. The
phone decodes pushed records through a serial queue per subscription so a large
keyframe cannot be overtaken by the P-frames behind it, writes
`DisplayImmediately` and `NotSync` into each sample's per-sample attachment
dictionary — the display layer reads the sample dictionary, not a buffer-level
attachment — labels itself `iPhone`/`iPad` rather than the device name, and
resubscribes by itself when a lane's display reports running again after a
`stopped` stream.

### Floating card, lane mark, and web client header

These follow the Apple device tool's surfaces, using only state the renderer
already had.

- **Floating card tags.** The Work tab's corner card (`WorkLiveCornerCard.tsx`)
  reads the lease holder and the recording from the one `getStatus` it already
  makes, then keeps them current from `lease-changed` and `recording-changed`
  events. The adapter in `workLiveCard.ts` turns them into the tags every
  other source shows: `· agent` when an agent holds the lease, `· you` when a
  person does, nothing when nobody does, and the pulsing red dot while the
  lane records. The card is still view-only for Mac Desktop. Driving needs the
  lease, and clicking the card opens the pane.
- **Picture in picture.** The card's hover pill has the same Picture in
  picture button as the Apple mini player. It reuses
  `enterCanvasPictureInPicture` from `workLiveIosPictureInPicture.ts` on the
  card's own off-screen decoder canvas. The button is enabled only while the
  card holds the lane's decoder and a frame has been drawn. While the picture
  is in PiP, the card inside ADE is hidden. PiP ends when the card loses the
  decoder: the pane took it back, the card was closed, or the display went
  away.
- **Lane mark.** The Work session list puts a small `Monitor` glyph beside the
  lane name when the lane holds a display. It sits in the same slot as the
  Apple mark, both on the lane header and on a headerless lane's lone card.
  `useLaneMacDesktops` makes one `getStatus({})` read (`lanes`) for the whole
  list, and after that `display-created` / `display-destroyed` update the set
  without another read. There is no timer and nothing runs per row. A host
  that cannot host a display stops listening, and the web client is excluded,
  as it is for the Apple mark.
- **Web client header.** The read-only view (`WorkToolReadOnlyView.tsx`) adds
  two badges beside the Live badge. A Recording badge appears while
  `macDesktop.recording.running` is true; an older host sends no `recording`,
  which reads as not recording. An owner badge says "You have control" when
  this tab holds the lease, "Agent driving" when an agent does, "Someone has
  control" when a person holds it from another client, and nothing when
  nobody holds it.

## Proof

Proof stays intentional, and a caption is what makes a capture proof. A bare
`ade mac-desktop screenshot` writes a scratch file and returns its path.
`ade mac-desktop proof --caption "<text>"` files a record and re-observes after
the capture so the returned state is the state that was filed. `record start`
files the finished movie only when it was given `--caption`. Agents keep writing
their own captions; the CLI never invents one.

The pane is the one caller that supplies a default. A person pressing Record or
Save screenshot has already said they want the capture kept, so the pane sends
`macDesktopPaneCaption` — "Mac Desktop recording · <lane>" or "Mac Desktop
screenshot · <lane>" — and every pane capture reaches the proof drawer. The
screenshot action takes an optional `caption` for this; the CLI's `screenshot`
never sends one. `stopRecording` and a captioned `screenshot` return the filed
record's `proofArtifactId` and the file's `bytes`, which is what the pane's
receipt shows. A filing that fails leaves `proofArtifactId` null, and the pane
says the capture was saved but not filed.

Records carry `backendName: "ade-mac-desktop"` and `backendStyle: "manual"`,
through the same `ingest_computer_use_artifacts` path `ade ios-sim proof` and
`ade browser proof` use. Owners are resolved the same way too: the lane, the
calling chat, and — when the chat's lane has a primary pull request — that PR,
as a `github_pr` owner with the existing `published_to` relation. There is no
second ingestion path.

A turn that used the desktop also gets a short time-lapse clip in the thread. It
is context rather than proof and never files a record.

**How the clip is actually made.** There is no frame assembler in the runtime —
no ffmpeg, no encoder — so stitching kept stills was not a cheap path, it was a
missing one. The clip is instead the helper's own recording at 4 fps: the
service opens it on the turn's first desktop action (`beginTurn`) and closes it
in `noteTurnEnded`. A user-started `record start` wins: one lane has one writer,
and the reviewer-facing capture is the one that matters, so a turn that overlaps
a real recording produces no clip. Action frames are still counted, capped at
one a second and 120 total, and that count is what `frameCount` reports.

**Where the files live.** Observation frames and element maps go to
`.ade/cache/mac-desktop-observations/<laneId>/`, with a `<name>.json` sidecar
carrying `ownerLaneId` — that is the one root `workToolsStateService.readObservationPreview`
serves from, so a frame written anywhere else is invisible to the phone and the
hosted web client. Recordings and turn clips go to the computer-use artifact
store under `.ade/artifacts`, because the thread plays them through
`ade-artifact://` and main serves that scheme only from inside that root. A bare
screenshot with no `--out` stays in the computer-use scratch root.

A caller-supplied `--out` may land inside the lane worktree or the OS temp
directory (`$TMPDIR`), both of which are agent-owned scratch space; the proof
skill documents `$TMPDIR` paths, and the earlier worktree-only rule refused the
documented command. Everything else is still refused by code, with symlink
checks on both the directories on the way and the leaf itself.

**Recording state is one truth.** `record stop` waits at most
`CaptureEngine.recordingFinalizeBudget` (2 s) for `AVAssetWriter.finishWriting`.
If the writer does not settle, the driver answers with a coded failure naming
the partial path and keeps the writer alive until its completion fires, rather
than parking its single main thread for fifteen seconds. The service mirrors
that: a failed stop flips `running` to `false`, records `lastError`, keeps the
intended `filePath`, and emits `recording-changed`, so `status` and a second
`stop` agree. A recording that captured no frames is refused and its empty file
removed — it never reaches the proof drawer.

## Gotchas and fragile areas

- **The virtual display API is private.** `CGVirtualDisplay`,
  `CGVirtualDisplayDescriptor`, `CGVirtualDisplaySettings`, and
  `CGVirtualDisplayMode` are reached through `NSClassFromString` and the
  Objective-C runtime. The driver never links them. A macOS release that removes
  them makes `virtualDisplay.available` false with a reason, and the service
  falls back to parking windows in an off-screen region of the main display.
  That fallback is reported in `status`, never hidden.
- **Off-screen parking is a real fallback, not a lie.** In fallback mode the
  windows are on the user's display, just outside its visible frame. `status`
  says `mode: "offscreen-region"` so the UI can say so.
- **Another virtual-display tool may be installed.** BetterDisplay and similar
  tools create their own virtual displays. ADE only ever destroys a display it
  created, tracked by the exact display id it received at creation.
- **Never post a `CGEvent` without the lease.** `RealInput.swift` refuses the
  call itself rather than trusting its caller. The lease check is in the driver,
  not only in the service.
- **Human takeover keeps the system cursor on ADE.** Posting `mouseDown` at a
  virtual-display coordinate teleports the one system pointer onto that
  display. The helper posts through a `CGEventSource` with suppression
  interval 0 (otherwise the warp eats the next ~250ms of Electron events),
  then warps the cursor back, and repeats the warp on the next turns of the
  main queue so the clicked window becoming key cannot keep it. Hover
  `mouseMoved` events are not posted during takeover: a 60Hz warp+post flood
  stalls ScreenCaptureKit and is what made the yellow glyph vanish. The live
  view draws a local pointer instead. Agent real-input does not restore: the
  pointer stays where the action put it. The flag is `restoreCursor` on the
  nested input payload, and the service only sets it when the call is a
  silent takeover (`silent` plus a `controllerId`). A remote controller —
  web, phone, or another computer's ADE window — does not send `home` on
  Escape. That point is the viewer's own screen, and applying it on the host
  would throw the host's cursor at an arbitrary coordinate. The sync host
  drops `homeX`/`homeY` for the same reason; the desktop pane only attaches
  them when the lane's Mac is the one the person is sitting at.
- **Window ids are not stable across relaunch.** A claimed window id dies with
  its process. `windows` re-enumerates; do not cache an id across a restart.
- **Two chats in one lane can race to start.** `start` is idempotent and
  serialized per lane; the second caller receives the first caller's display.
- **A stream outlives all but its last asker.** Two chats watching one lane are
  both recorded as owners; the first to end drops out of the set and only an
  empty set stops the encoder.
- **The pane and the corner card share one decoder per lane.** The renderer's
  ref-counted live-view lease elects the pane (highest priority) and promotes
  the card when the pane unmounts; a surface in the tree for another reason
  still holds the count, so a pane that switches tools is not an unsubscribe.
  Two decoders for one lane is a defect, not a fallback.
- **The corner card's session is the display, not the lane.** The × marker is
  keyed `display:<displayId>:<createdAt>` (creation time carries the
  off-screen-region fallback), so a destroyed-and-recreated display may show
  the card again while the same display stays closed.
- **A recording failure is not a display failure.** The pane's display-state
  slot titles the empty state; a refused `stopRecording` (a stale "running"
  flag after the display died) goes in the status strip, and
  `display-destroyed` clears the recording with the display. Error text never
  carries a raw lane id: `macDesktopErrorText` replaces it with the lane's name
  when known and drops it otherwise.
- **The strip is a state dot and icon controls, nothing else.** The lane name,
  the status sentence and the Windows dropdown were removed: `ADE · <lane>`
  stays as the display's Mission Control name but is no longer printed in the
  pane, and the live/idle status is a small coloured dot whose tooltip carries
  the words. The window list lives in the Apps section under the picture, so a
  window's state is never inferred from a strip count.
- **`getStreamStatus` must stay redacted.** It is on the action allowlist, so an
  unredacted token would be printed into a durable agent transcript.
- **The agent-facing prompt cost is one line.** The system prompt gains a single
  line, and only when the lane has a display. A lane with the tool off pays
  nothing.
- **A chat-bound `--lane` is refused, not swapped.** The daemon pins every
  `mac_desktop` action to the calling chat's lane. A bound caller that names a
  different lane gets `This chat is bound to lane <a>; --lane <b> was ignored.`
  rather than silently targeting lane `<a>` and failing with a message about it.
  User clients (desktop, web, phone) keep the lane their UI is showing.
- **Full-auto answers `external_directory` asks for the project's own `.ade`.**
  The mac-desktop artifacts and observations live under `<project>/.ade`, which
  is outside the lane worktree, so OpenCode's default ask fired and full-auto
  never answered — the test drive blocked for eleven minutes on its own
  workspace. Full-auto now replies `always` before any card exists when every
  pattern is a literal path inside `<project>/.ade` (a mid-path glob keeps the
  card). No card means the card and `chat status` cannot disagree about it.
- **Recording stop cannot wedge the driver.** `markAsFinished` raises an ObjC
  exception on a writer that never started, which is exactly the state a still
  display leaves; the finalize only touches a `.writing` writer. The wait is
  bounded at 2 s, and a late writer is retained until its completion runs so a
  slow mux still lands in the reported file.

## The native helper, as built

The helper is `apps/desktop/native/ADEDesktopDriver`, a SwiftPM package laid out
like `ADEAttentionNotch`: a pure `ADEDesktopDriverCore` library holding the wire
types and the rules that must be testable without a window server, and an
`ade-desktop-driver` executable holding everything that touches AppKit.

### The wire

One JSON object per line over stdin/stdout. `DriverProtocol.swift` carries the
full op table in its doc comment — read that file and you know the wire.

Ops accept **two spellings**: the camelCase name (`createDisplay`) and the
grouped one the rest of this document uses (`display.create`). Both resolve to
the same case through `DriverOp(wireName:)`, and `health` also answers to
`ping`. That is not indecision; the doc, the CLI and the service were written in
parallel, and accepting both cost less than a migration.

A request carrying an `id` is always answered. An unknown op is
`ok:false, code:"unknown_op"` — never silence, never a crash — because a newer
Node talking to an older helper is a normal state during an update.

### Build, sign, bundle

`npm --prefix apps/desktop run build:mac-native` builds both native helpers;
`build:desktop-driver` builds this one alone. It materializes a universal
(arm64 + x86_64) binary at `apps/desktop/resources/native/ade-desktop-driver`,
which `build.mac.extraResources` copies to `Contents/Resources/native/` and
`validate-mac-artifacts.mjs` then asserts exists, is executable, and carries
both architectures — the same three assertions the notch helper gets. The
release workflow picks all of this up because every `dist:mac:*` script now runs
`build:mac-native` where it used to run `build:notch`.

The Node side finds it with `resolveMacDesktopDriverBinary` in
`apps/desktop/src/main/services/native/nativeHelperPaths.ts`, beside the
notch's resolver: both binaries are produced by one build step into one
directory, and two resolvers in two files drift the first time that directory
moves. It returns `null` off macOS rather than throwing, because `getStatus`
answers on every platform.

`swift test --package-path apps/desktop/native/ADEDesktopDriver`
(`npm run test:desktop-driver`) runs the unit suite. The tests that create a
real virtual display and record it are skipped unless
`ADE_DESKTOP_DRIVER_LIVE_TESTS=1`; `RecordingFinalizeTests` covers the finalize
path against real `AVAssetWriter`s without a window server.

### What the private API actually does, measured on macOS 27

`CGVirtualDisplay` and its three companions are all present on macOS 27
(Darwin 27) and a display created through them appears in
`CGGetActiveDisplayList` within a few hundred milliseconds.

Two behaviours differ from what the names suggest, and the driver reports rather
than assumes:

- **`maxPixelsWide`/`maxPixelsHigh` decide the display's *point* size**, not its
  pixel buffer. A descriptor capped at 2560 comes up as a 2560-point display
  whatever `CGVirtualDisplayMode` was initialised with. So the cap is set to the
  requested working size and the mode matches it.
- **`hiDPI = 1` did not produce a 2x backing scale** on this release. A lane that
  asks for `scale: 2` gets the working area it asked for at whatever scale the
  window server gave, and the `scale` in the reply is *measured* from
  `CGDisplayCopyDisplayMode` rather than echoed from the request. Nothing
  downstream should assume the requested scale came true.

If any of the four classes goes missing, or `applySettings:` refuses, the driver
answers `displayMode: "offscreen-region"` with a reason and parks windows past
the main display's visible frame. It never reports `virtual` for a display it
did not get.

### Keyboard without a lease

`AccessibilityDriver` types by setting `kAXValueAttribute` where the element has
one. Where it does not — a canvas, a terminal view, some Electron text areas —
it falls back to `CGEvent` keyboard events posted with **`CGEventPostToPid`**.
That is process-targeted: the event goes to one application's event queue and
never enters the window server's global stream, so it cannot land in the user's
window. This is why it is allowed without the input lease, while every post in
`RealInput.swift` (`CGEvent.post(tap:)`, global) is not. Turning one of those
`postToPid` calls into a `post(tap:)` would silently hand every accessibility
caller the user's keyboard.

### A new window is not drivable the instant it exists

A window appears in `CGWindowListCopyWindowInfo` before its application has
published it to the Accessibility API — measured at a few hundred milliseconds
for a new TextEdit document. The pid watcher looks exactly in that gap, so the
first AX lookup legitimately finds nothing.

The driver retries the lookup on a bounded backoff (50/100/200/400/800 ms,
~1.5 s total, in `WindowReadiness`) and then classifies what is left:

- `AXIsProcessTrusted()` false → `MAC_DESKTOP_PERMISSION_REQUIRED`, a grant the
  user has to give.
- otherwise → `window_not_ready`, a `window-not-parked` event carrying
  `reason: "not_ready"`, and the window stays on the watch list for the next
  poll.

The service forwards that event as `MacDesktopEventPayload`'s
`window-not-parked`, because the window is on the user's own screen until
something moves it and only the surface watching the lane can say so.

Reporting the second as the first is the bug this exists to prevent: it sends
somebody to System Settings to fix a permission that was never missing.

### Reconciliation is narrower than it sounds

`display.reconcile` destroys displays *this process* created whose lane is not
in the live set. There is nothing else it could do: a `CGVirtualDisplay` dies
with the process that created it, so a crashed previous run leaks nothing for a
later run to sweep. The service's start-up reconciliation is therefore about
this run's own bookkeeping, not about orphans on disk.

## Not in scope

The Linux seat backend, nested macOS virtual machines, replacing the built-in
Browser, App Control, or the iOS Simulator tool, and any change to how Codex
Computer Use is launched. `DesktopSeatProvider` in
`apps/desktop/src/shared/types/macDesktop.ts` is shaped so a seat backend can be
added later; only the Mac backend exists today.
