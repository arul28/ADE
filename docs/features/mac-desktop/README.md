# Mac Desktop

Each lane can own a private macOS screen. ADE creates a virtual display named
after the lane, parks the lane's windows on it, and drives those windows through
the Accessibility API. The user's real display and the real pointer stay
untouched.

The Work tools pane shows that screen live, the `ade desktop` command family
drives it, and screenshots and recordings reach the proof drawer through the
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
| `apps/desktop/src/shared/types/macDesktop.ts` | The cross-process contract, including the `DesktopSeatProvider` interface a later Linux seat backend implements. |
| `apps/desktop/src/main/services/macDesktop/macDesktopService.ts` | The runtime service: lane to display, window ownership, the input lease, idle release, events, and teardown. |
| `apps/desktop/src/main/services/macDesktop/macDesktopDriverClient.ts` | The NDJSON client for the helper, with restart backoff and health. |
| `apps/desktop/src/main/services/macDesktop/macDesktopStreamServer.ts` | The token-guarded loopback HTTP endpoint that serves H.264 access units. |
| `apps/desktop/src/main/services/macDesktop/macDesktopObservations.ts` | Observation storage, the numbered element map image, and the sidecar that binds a frame to a lane. |
| `apps/ade-cli/src/bootstrap.ts` | Creates the service next to `iosSimulatorService` and `appControlService`. |
| `apps/ade-cli/src/cli.ts` | The `ade desktop` command family. |
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

1. **ADE launched it.** `ade desktop open <app|path|url>` starts the app, and
   the driver watches that pid for new windows and parks each one. An
   App Control session and an iOS Simulator session owned by a chat in the lane
   park the same way.
2. **Somebody claimed it.** `ade desktop claim --window <id>` moves an existing
   window onto the lane's display. `ade desktop release --window <id>` puts it
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
2. **Permissions.** Screen Recording and Accessibility are checked before the
   first capture. A missing grant is one inline line with a System Settings
   opener, reusing the simulator's probes and openers.
3. **Idle release.** A display with no parked windows and no viewer for
   `MAC_DESKTOP_IDLE_RELEASE_MS` is destroyed. The next open recreates it.
4. **Teardown.** Lane delete and lane archive destroy the display through the
   lane teardown step, next to the file watchers. A chat that ends releases its
   lease through `releaseIfOwnedBy`.
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
- Machine sleep drops the lease for the same reason.

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

Proof stays intentional. A bare `ade desktop screenshot` writes a scratch file
and returns its path. Only `ade desktop proof --caption "<text>"` files a record,
and it re-observes after the capture so the returned state is the state that was
filed.

Records carry `backendName: "ade-mac-desktop"` and `backendStyle: "manual"`,
through the same `ingest_computer_use_artifacts` path `ade ios-sim proof` and
`ade browser proof` use. Owners are resolved the same way too: the lane, the
calling chat, and — when the chat's lane has a primary pull request — that PR,
as a `github_pr` owner with the existing `published_to` relation. There is no
second ingestion path.

A turn that used the desktop also gets a short time-lapse clip in the thread. It
is built from frames the recorder already holds, it is context rather than
proof, and it never files a record.

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

## Not in scope

The Linux seat backend, nested macOS virtual machines, replacing the built-in
Browser, App Control, or the iOS Simulator tool, and any change to how Codex
Computer Use is launched. `DesktopSeatProvider` in
`apps/desktop/src/shared/types/macDesktop.ts` is shaped so a seat backend can be
added later; only the Mac backend exists today.
