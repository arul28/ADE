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
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriver/WindowControl.swift` | Window enumeration, parking, and per-pid window watching. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriver/AccessibilityDriver.swift` | The accessibility tree, element actions, value setting, and process-targeted keys. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriver/CaptureEngine.swift` | ScreenCaptureKit screenshots plus the VideoToolbox H.264 stream and recording. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriver/RealInput.swift` | `CGEvent` pointer and keyboard posts. Refuses every call without a lease. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriver/CursorOverlay.swift` | The fake cursor the human sees. The real pointer never moves. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriver/main.swift` | The NDJSON loop and the op dispatcher. stdout is protocol; every log line goes to stderr. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriver/ObjCDynamic.swift` | The Objective-C runtime calls the private display classes need: `objc_msgSend` by `dlsym`, and KVC that probes the setter first. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriver/Permissions.swift` | Screen Recording and Accessibility, probed without prompting; `permissions.request` is the one that prompts. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriver/PhysicalInput.swift` | Seconds since the last physical input, for the idle rate and the takeover check. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriverCore/InputLease.swift` | The lease the driver keeps for itself, and the refusal `RealInput` raises. |
| `apps/desktop/native/ADEDesktopDriver/Sources/ADEDesktopDriverCore/Geometry.swift` | The global/display-local conversion and the offscreen-fallback arithmetic. |
| `apps/desktop/scripts/build-mac-desktop-driver.mjs` | Builds the universal `ade-desktop-driver` into `resources/native`, beside the notch helper. |
| `apps/desktop/src/shared/types/macDesktop.ts` | The cross-process contract, including the `DesktopSeatProvider` interface a later Linux seat backend implements. |
| `apps/desktop/src/main/services/macDesktop/macDesktopService.ts` | The runtime service: lane to display, window ownership, the input lease, idle release, events, and teardown. |
| `apps/desktop/src/main/services/macDesktop/macDesktopDriverClient.ts` | The NDJSON client for the helper, with restart backoff and health. |
| `apps/desktop/src/main/services/macDesktop/macDesktopStreamServer.ts` | The token-guarded loopback HTTP endpoint that serves H.264 access units. |
| `apps/desktop/src/main/services/macDesktop/macDesktopObservations.ts` | Observation storage, the numbered element map image, and the sidecar that binds a frame to a lane. |
| `apps/desktop/src/main/services/macDesktop/macDesktopLease.ts` | The input-lease state machine: agent grant per chat, user takeover, heartbeat renewal, TTL expiry, and the three refusal codes. Pure, injectable clock. |
| `apps/desktop/src/main/services/macDesktop/macDesktopOwnership.ts` | Lane→display, window→lane, window origin, the single-instance rule, and `ade_launched` pid bookkeeping. Pure. |
| `apps/desktop/src/main/services/attention/attentionNotchHelper.ts` | `resolveMacDesktopDriverBinary` lives beside the notch resolver: both binaries come from the same `resources/native` directory, and it also answers in the daemon, which has no Electron `app`. |
| `apps/ade-cli/src/bootstrap.ts` | Creates the service next to `iosSimulatorService` and `appControlService`. |
| `apps/ade-cli/src/cli.ts` | The `ade mac-desktop` command family. |
| `apps/desktop/src/renderer/components/chat/ChatMacDesktopPanel.tsx` | The Work tools pane tool. |
| `apps/desktop/src/renderer/components/chat/useMacDesktopLiveView.ts` | The live view, its low-power idle rate, and its reconnect budget. |
| `apps/desktop/resources/agent-skills/ade-desktop/SKILL.md` | The bundled agent skill. |

## Where this runs

The display, the driver, and the capture all run on the machine that runs the
ADE runtime for the project. Nothing about the display exists on a viewing
client.

- **Local Mac runtime.** The desktop app talks to the service over local IPC,
  reads the stream from loopback, and can offer "Bring to my screen".
- **Remote Mac runtime.** Every call goes over the runtime RPC. The stream is
  read through the same SSH port forward the `idb-h264` simulator backend uses.
  "Bring to my screen" is hidden, because the user's screen is not on that Mac.
- **Non-Mac runtime.** `getStatus` answers `supported: false`. Every other
  method rejects with `MAC_DESKTOP_UNSUPPORTED_PLATFORM`. The renderer hides the
  tab.
- **Phone and hosted web client.** Both read the `macDesktop` slice of
  `WorkToolsLaneState` (`apps/desktop/src/shared/types/workTools.ts`) and render
  it read-only: the display, its parked windows, the lease line, the stream
  state, and the last frame fetched through `workTools.readObservationPreview`.
  There is no control surface — `WORK_TOOLS_CONTROL_HINT` says so. **Taking
  control from the hosted web client is a follow-up lane**: takeover needs the
  lease heartbeat and an input channel, and neither exists off the desktop
  today. A missing `macDesktop` key, or `supported: false`, hides the tool
  rather than drawing an empty pane.

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
fought.

Single-instance apps are one lane at a time. A second lane asking for the same
bundle id is refused with `MAC_DESKTOP_APP_OWNED_BY_OTHER_LANE`, and the message
names the holding lane.

## Lifecycle

1. **Auto-start.** The first time a chat opens the Mac Desktop tab, or the first
   time an agent is granted the tool, the service creates the display. There is
   no intermediate card.
2. **Permissions.** Screen Recording and Accessibility are reported by the
   helper's own `ping`/`permissions.probe` reply — the service never shells out
   to probe, so nothing runs ungated on a non-Mac host. A missing grant is one
   inline line with a System Settings opener, reusing the simulator's
   `openSystemSettings` route; `IosSimulatorPrivacyPane` gained an
   `accessibility` pane for the second row rather than growing a second opener.
   A grant revoked mid-session arrives as a `permission-changed` event and
   every action then fails with `MAC_DESKTOP_PERMISSION_REQUIRED`.
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
- A remote viewer that disconnects during a takeover loses the lease on the
  socket close. The lease has a heartbeat deadline, so it can never stick.
- Machine sleep drops the lease for the same reason. `powerMonitor` is
  Electron-only and this service also runs in the runtime daemon, so sleep is
  detected as a coarse wall-clock jump on the idle sweep (a tick that arrives
  four intervals late) and the lease TTL is what actually guarantees the lease
  cannot stick — the jump detector only makes the release immediate.

## Streaming

The driver encodes the virtual display with VideoToolbox and writes Annex-B
H.264 access units to a token-guarded loopback HTTP endpoint, exactly like
`iosVideoStreamServer.ts`. The renderer decodes with WebCodecs, using a codec
string built from the stream's own SPS.

The token is minted per `startStream` and returned only by `startStream`.
`getStreamStatus` reports the transport shape with `url` and `token` null,
because that read sits on the agent action allowlist.

The stream runs at a low frame rate while nothing happens — no agent action, no
takeover — and at full rate on activity. The last decoded frame is kept, which
is what the Lanes tab hover peek and the thread mini view render. Neither adds a
poller.

## Proof

Proof stays intentional. A bare `ade mac-desktop screenshot` writes a scratch file
and returns its path. Only `ade mac-desktop proof --caption "<text>"` files a record,
and it re-observes after the capture so the returned state is the state that was
filed.

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
- **Window ids are not stable across relaunch.** A claimed window id dies with
  its process. `windows` re-enumerates; do not cache an id across a restart.
- **Two chats in one lane can race to start.** `start` is idempotent and
  serialized per lane; the second caller receives the first caller's display.
- **`getStreamStatus` must stay redacted.** It is on the action allowlist, so an
  unredacted token would be printed into a durable agent transcript.
- **The agent-facing prompt cost is one line.** The system prompt gains a single
  line, and only when the lane has a display. A lane with the tool off pays
  nothing.

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
`apps/desktop/src/main/services/attention/attentionNotchHelper.ts`, beside the
notch's resolver: both binaries are produced by one build step into one
directory, and two resolvers in two files drift the first time that directory
moves. It returns `null` off macOS rather than throwing, because `getStatus`
answers on every platform.

`swift test --package-path apps/desktop/native/ADEDesktopDriver`
(`npm run test:desktop-driver`) runs the unit suite. The one test that creates a
real virtual display is skipped unless `ADE_DESKTOP_DRIVER_LIVE_TESTS=1`.

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
