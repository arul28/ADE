# Apple device

ADE drives a per-lane Apple simulator from the Work tab's Apple Development tool and from
`ade apple`. It makes a new device for the lane (or attaches one the user names), builds and launches
the selected app, streams the device framebuffer through a vendored Swift
helper, and turns gestures into simulator input or context items for the
active chat. Agent launches stay in the background.

The feature is macOS-only. `xcrun` and `xcodebuild` must be available on the
runtime host. Frames and input go through `ade-sim-helper` (CoreSimulator /
SimulatorKit). There is no idb, no Screen Recording grant, and no
Simulator.app window. ADE never downloads a simulator runtime.

`ade ios-sim` is a deprecated alias of `ade apple` for one minor release. It
prints one deprecation line to stderr per process.

## Runtime ownership

The simulator service runs where the ADE runtime runs. A local Mac runtime can
build, launch, stream, and control a local simulator. Non-macOS runtimes
report `supported: false`; every CLI command except `status` rejects with the
macOS-only error. `status` is the capability gate and reports
`tools.helper` (`present`, `path`, `version`) instead of `idb` /
`idb_companion`.

A remote Mac runtime supports control, screenshots, recording, and Preview
Lab. Its live view is the same helper H.264 path; a Windows desktop bound to
that Mac watches and drives over the stream.

Each launched simulator session has one owner chat/lane. A second chat trying
to launch against an active session receives
`IOS_SIMULATOR_OWNED_BY_OTHER_SESSION` (and the Apple-prefixed
`APPLE_OWNED_BY_OTHER_SESSION` on device/recording verbs), whose message
carries the owning chat id, lane, and how long ago it claimed. Service
messages state the fact and the code; the "now run this" half lives in the
CLI's `iosSimulatorErrorHint`.

Ownership releases automatically when the owning chat is deleted or archived.
The guard is cooperative: `shutdown --force`, `launch --force`,
`claim --ignore-ownership`, and naming the owner's chat session id all get
through. Ask before evicting another chat.

### Build root

Simulator commands default their build root to the caller's lane worktree, not
the primary checkout. An explicit `--project-root` still wins. Target ids are
validated against the resolved root
(`IOS_SIMULATOR_TARGET_ROOT_MISMATCH`). A `--lane` that resolves to no
worktree is a hard failure (`IOS_SIMULATOR_LANE_NOT_RESOLVED`).

### Per-lane devices

A lane gets no device until asked: the user asks from Apple Development, or an
agent runs `launch` / `open-device` / `start` / `test` / `device-create`.
First ask makes a NEW, empty device with `simctl create` from an installed
runtime, named `ADE · <lane>`. Nothing is copied from another simulator: each
lane builds and installs its own version of the app from its own worktree, so a
copy only carried another device's data and sign-ins, and cost that device's
size on disk. Defaults: the newest installed iOS runtime, and the device type
this project used last (KV `apple:last-device-type`), else the newest iPhone.
The picker offers the runtime (when there is more than one) and the model;
`device-create --runtime --device-type` does the same from the CLI. Only
installed runtimes — `APPLE_NO_INSTALLED_SIMULATORS` when none exist,
`APPLE_RUNTIME_NOT_INSTALLED` when the one named is not there. A lane may
instead `device-attach` an installed simulator the user names.

`origin` on the lane row is `created` for a device ADE made, `clone` for one
made before this change (treated exactly the same), and `attached` for the
user's own simulator (`isAdeOwnedLaneDevice`).

### When a lane ends

Archive and delete both end the lane's hold on its device
(`releaseLaneAppleDevice`, called from `laneService`; the live session is
stopped first through `teardownDeps.iosSimulatorService.stopForLane`):

- An ADE device is powered off and deleted, with all its data.
- An attached device is the user's. ADE uninstalls only the apps ADE installed
  on it, powers it off, and unbinds it. ADE never deletes it. An install counts
  as ADE's only when `simctl get_app_container` said the app was absent before
  and present after (a check that cannot answer counts as "the user had it");
  the list lives on the lane's local-only row
  (`ade_installed_bundle_ids`), never in the synced `kv` table. ADE waits five
  seconds after the last uninstall before the power-off: on iOS 26.3 a
  shutdown straight after `simctl uninstall` sometimes brought the app back.
- When another lane holds the same udid (should not happen, has happened), the
  ending lane only drops its row and the device is left alone.
- When the delete fails, or an app ADE installed is still there after the
  uninstall, the row is kept (with the apps still left). The lane has ended, so
  the cleanup pass tries again. An attached device gets one retry, which leaves
  its power as it found it; an app still there after that, or one whose state
  cannot be read, is logged and left, so a user's device is never booted and
  powered off every pass. The row is removed by lane AND udid, so a new device
  an unarchived lane got meanwhile is never the one removed. While a row waits
  for its retry, the lane counts as ended: it blocks no attach and shows as no
  device's owner.
- The lane's build cache, `<worktree>/.ade/cache/ios-simulator/DerivedData`, is
  deleted. So are test logs and result bundles beside it.
- Recordings stay on archive (they are proof) and go on delete.

An unarchived lane gets a new device on the next ask. When a duplicate lane is
merged into its keeper and both had a device, the duplicate's device is deleted,
not just forgotten. The delete runs after the merge transaction settles, and
not at all when the row came back in a rollback or the keeper holds the udid.

The module split: `appleSimulatorCatalog.ts` parses `simctl` (devices,
runtimes, `du`) and picks the runtime and model; `appleDeviceMarker.ts` owns the
marker; `laneDeviceRows.ts` owns the rows; `laneDeviceRelease.ts` ends a lane on
disk; `appleTestRun.ts` runs `xcodebuild test`.

### Ownership marker and the cleanup pass

Every device ADE makes carries a marker file,
`~/Library/Developer/CoreSimulator/Devices/<udid>/ade-lane-device.json`
(`projectRoot`, `laneId`, `name`, `createdAt`). The marker, not only the row,
proves a device is ADE's: a row can be lost, and an unmarked leaked device looks
exactly like the user's own. Rows for devices made before markers existed get
one on the first cleanup pass.

The cleanup pass (`registry.reconcile`, `laneDeviceMaintenance.ts`) runs one
minute after the service starts and every 15 minutes in the hosts that pass
`backgroundMaintenance: true` (the desktop and the brain). It never deletes
anything when `simctl list` cannot be read.

- A row whose simulator no longer exists is dropped.
- A row whose lane is archived or gone is released, as above.
- A marked device of this project that no live lane holds is deleted (or
  re-adopted, when its lane is live and lost only its row). A marker younger than
  five minutes is skipped, because create writes the marker before the row. The
  pass reads the rows again right before each delete, so a device another
  process re-adopted or attached meanwhile is kept.
- Another project's marked devices are never touched, even when that project
  looks gone (it may be moved or on an unmounted volume). The storage view
  lists them.

`device-detach` of an ADE device stamps the marker `detachedAt`. The device is
then a leftover: it is never re-adopted, and the pass deletes it five minutes
after the detach unless a lane picks it again. Attaching this project's marked
device (the picker, or an agent for a leftover) makes it that lane's ADE device
again (`origin: created`) and rewrites the marker. Another project's ADE device
attaches as `attached`, marker untouched, so this project never deletes it; an
agent may not attach one at all. Detaching an ATTACHED device uninstalls the
apps ADE installed on it in the background and leaves its power state as it was.

`ade apple device-cleanup` and the picker's **Clean up** run it on demand, with
`--power-off-idle`. A requested power-off always runs, even when a background
pass is already in flight. For an agent caller, the power-off reaches only its
own lane's device. When the power-off is skipped as a whole (Simulator.app is
open, or `ps` failed), the result says so in `powerOffSkipped` and the toast
tells the user.

### Idle power-off

A booted ADE device that nothing touched for 30 minutes is powered off through
`deviceStop` (`ADE_APPLE_IDLE_POWER_OFF_MINUTES`, `0` turns it off). A booted
simulator holds several gigabytes of memory; on a Mac that is short of it, swap
grows on the same disk the devices use. "Touched" is the mtime of
`<device dir>/ade-last-activity`, written (at most once a minute) whenever a call
resolves the lane, including the pane's status poll while it is on screen, and on
every tick while this process streams, records, tests or launches on the device.
It is a file, not memory, so the desktop and the brain see each other's use. A
running `xcodebuild`, `simctl` or `xctest` that names the device by udid or
`name=` also counts. While Simulator.app is running, nothing is powered off: a
person may be driving a device in its window, which leaves no trace ADE can
read. The power-off names the udid the pass checked. Attached devices are never
powered off by the timer.

### Tests

`ade apple test` (`runTests`) runs `xcodebuild test` on the lane's device with
`-parallel-testing-enabled NO`, DerivedData in the lane's cache, and a result
bundle under `.ade/cache/ios-simulator/test-results` (the newest three kept).
Output streams to `.ade/cache/ios-simulator/test-logs/<stamp>.log`. One run at a
time per ADE runtime (`APPLE_TEST_RUN_BUSY`), claimed before the device boots. A failing test resolves with
`passed: false`, the failing lines and the log path. Default timeout 30 minutes,
at most 2 hours.

The verbs that end a lane's hold on its device live in
`laneDeviceLifecycle.ts`. Each one tears down the recording, the stream, the
chat claim and the hub session in the same order.

- `device-detach` (`deviceDetach`) gives up the lane's device and leaves the
  simulator installed, with its power state unchanged. The device then shows
  as free in the picker. Agents may call it.
- `device-delete` (`deviceDelete`) removes an ADE device. The registry powers the
  device off first. An attached device is refused unless `--force`, and
  `--force` only detaches it. ADE never deletes a simulator it did not create.
  The device is also deleted on lane archive and delete.
- Both verbs use the same owner rule as `stop` (`deviceStop`). They are
  refused while another chat drives the device, unless the caller passes
  `--ignore-ownership`. For detach, `--force` also passes. For delete,
  `--force` only means "detach an attached device" and does not pass the
  owner check. A refused call changes nothing.
- `deviceStart`, `deviceStop`, `deviceDetach` and `deviceDelete` run one at a
  time per lane, in the lane's lifecycle queue. A delete decides everything
  inside that queue, from one read of the lane's binding. So a start that is
  already in flight cannot claim the session or change the device between the
  check and the teardown. The standalone `device-create` and `device-attach`
  verbs are not queued. For that reason, the registry delete gets the udid
  that the queue read, and does nothing when the lane holds a different
  device by then.

`deviceDeleteInstalled` deletes a simulator that the user picked in the
desktop picker. It is the one entry in `APPLE_USER_ONLY_ACTIONS`. The
`ios_simulator` action domain allows it, but `getStatus().capabilities` never
lists it. The RPC server refuses it to agent callers, and allows it only to a
user client whose connect name is a desktop client name
(`isDesktopClientName` in `shared/runtimeClientNames.ts`). The name is the
client's own claim, not authentication. It separates the desktop from the
`ade` CLI and TUI, and from an agent shell that has no chat identity.
Automations cannot run it. The phone and the web client reach it through the
`apple.invoke` remote command, which is controller-only. The registry refuses
a device that any lane holds. Before the delete, ADE stops each stream and hub
session that still reads a device no lane holds.

**One lane owns a device at a time.** `device-attach` on a simulator another
lane holds MOVES the binding rather than adding a second one: the losing lane's
stream and session are released, its row is re-keyed to the new lane in one
statement, and `origin`/`ade_installed_bundle_ids` travel with the device so an ADE device stays
ADE's to delete. The simulator is NOT powered off — the new owner is about to
drive it. The losing lane gets `apple.device.state` `phase: "released"` and
re-lists, which lands it on the picker. Attaching the device a lane already
holds is answered as-is; the picker only offers this behind a confirmation that
names the lane being interrupted.

**Agents use only their lane's own device.** The takeover is the user's,
through the picker. For an agent caller, the RPC server sets `agentCaller: true`
on every `ios_simulator` call (a caller cannot set or clear it). The rules:

- An agent may make its lane's ONE device without asking (`start`, `launch`,
  `open-device`, `test` and `device-create` do it). A second is
  `APPLE_DEVICE_EXISTS`.
- An agent may `device-attach` (or `start --udid`) an installed simulator that
  no lane holds — the user naming a device for the lane. A simulator another
  lane holds is refused with `APPLE_DEVICE_NOT_LANE_OWNED`, and nothing is
  bound, released or booted.
- The skill and the device hint tell agents never to make a simulator with
  `simctl create`/`clone` and to keep any hand-run `xcodebuild` DerivedData in
  the lane's cache. ADE cannot block a raw `simctl` call; the cleanup pass and
  the storage view make such a device visible.

Every other device verb follows the same rule for an agent
(`guardAgentDeviceActions` in `iosSimulatorService.ts`): `launch`, input,
screenshots, element queries, recording, streaming, proof and device settings
run on the lane's device only. A `--device`/`--udid` naming another simulator
is refused with `APPLE_DEVICE_NOT_LANE_OWNED`, and so is `stop --udid`. With no
lane device there is no "first booted iPhone" fallback: the call is refused
with a message naming `ade apple start`, except `launch` and `open-device`,
which create the lane's device. User clients keep the fallback.

"Agent caller" means a chat, run, step or attempt identity, or an `ade`
process with no chat identity (`ade-cli:<pid>` / `ade-rpc-stdio-proxy:<pid>`
at role `agent`). The same scoping pins the lane: a bound agent acts on its
chat's lane, an unbound `ade` process standing in a lane worktree (it sends
`callerRoot`) acts on that lane, and naming another lane is refused. With no
lane at all, an agent may only read status and listings (`getStatus`,
`listDevices`, `listLaunchTargets`, `deviceList`, `getStreamStatus`). The
agent's `chatSessionId` is its own chat's, or dropped when it has none. User
clients (the desktop, and the web and phone clients through `apple.*`) are not
affected.

## Desktop surface

The tool is **Apple Development**, one pane inside the Work tools pane. There
is no separate column.

- The floating rail carries Home, a **Hardware buttons** menu (Lock, Volume
  up/down, Siri, app switcher), Rotate, Inspect, Screenshot, Record, the
  3D/Flat view toggle, Tools and More. Every button is labelled. `shake` is
  deliberately not offered: the helper cannot press it and the service refuses
  it, so a control for it could only fail.
- The drawer has four collapsible groups — Device, App, Capture, Preview Lab —
  one open at a time, and a closed group is unmounted so its polling stops.
- 3D is the default view and renders the real Apple body. Flat is the same
  stream without it.
- Closing the tool's **tab** powers the device off, behind a confirmation when
  the device is booted. Minimising the tools pane leaves it running and shows
  a floating preview, which the user can turn off per chat.
- Watching never boots. Opening the pane, the floating preview, a phone or
  web viewer, or a desktop reconnect on a device that is off shows
  "{name} is off." with Start. Only Start, the picker, `apple start`,
  `stream-start`, `open-device` and `launch` power a device on.
- The **tools card** names the lane's device and its power state
  (`{name} · Running | Starting | Shut down`) and carries a corner menu that
  boots, opens, releases, or — for an ADE device only — deletes the device
  without opening the pane. Releasing a device with a live session confirms
  first. The mark beside each lane in the Work session list is green while the
  device is booted and muted while it is claimed but off.

### Foldable ("Duo") mode

A device whose simulator record reports fold/dual-screen support (a `Duo` —
or `Fold` — in the CoreSimulator
type identifier, which the installed-simulator record carries) renders an
articulated two-panel body instead of a GLB: two screen halves, two body slabs
and a hinge barrel, built procedurally and sized from the streamed inner display
(`appleDuoScene.ts`). The rail grows a **Duo** menu with the four postures —
Open (180°), Laptop (flat base), Tent, Closed (0°) — plus `Close/Open hinge 15°`
nudge items, and a trackpad pinch on the glass moves the hinge instead of
zooming the camera.

The whole mode is capability-gated by `appleDeviceSupportsDuo`, which the pane
feeds the CoreSimulator **type identifier** only. The lane device's display name
is deliberately not a gate input: for an ADE device it is `ADE · <lane>`, so a
lane named e.g. `duo-hinge` would otherwise mark a rigid iPhone as foldable. A
device that does not fold gets no `duo` prop, the procedural body is never
built, and the imported GLB path (and its per-frame work) is byte-for-byte
unchanged. The state machine, panel rotations, continuous inner-display
coordinate mapping and the capability matcher live in `appleDuo.ts`, away from
three.js, so they are tested without a GPU.

> **Not validated on a real Duo.** No iOS 27.1 iPhone Duo runtime exists on the
> build host, so this mode is written from the documented foldable behaviour and
> tested only by the pure geometry/state/control tests above. Live posture
> handoff, the native fold API, and real dual-screen touch are UNVERIFIED.

## Agent discovery

`getStatus` returns `capabilities`, the list of every `ios_simulator` action an
agent may call, spread from `APPLE_AGENT_ACTIONS` in
`shared/types/iosSimulator.ts`. That same constant feeds the action allowlist,
so the surface an agent is told about and the surface it is allowed to use
cannot drift apart. An agent landing in a lane reads `status` and learns the
device, its state and what it may do, without reading source. The
user-only verbs (`APPLE_USER_ONLY_ACTIONS`) are added to the allowlist but
never to `capabilities`.

Agents often see only a skill index, not the `ade-apple` skill body. So when a
lane holds a device, the chat service adds a short hint to the
provider-bound prompt (`laneAppleDeviceDirective.ts`). The hint names the
device and points the agent at `ade apple`, not at `simctl` or
`Simulator.app`. It is sent on the first turn after a device is bound, and
again only when the bound udid changes. It never enters the transcript. Off
macOS there is no lookup and no hint.

An agent can put its device on the user's screen with `ade apple show`
(or `ade ui show apple`). `--floating` shows the floating player instead of
the pane. The brain publishes a show request on the runtime event stream. The
desktop renderer that shows the chat opens the surface and answers. The CLI
prints `shown`, `held` (a window has the project open but not this chat), or
`no_desktop` (exit 1). An agent's input to the device can also raise the
floating player by itself, unless the user turned off "Show preview when
minimized" for that chat.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/native/ADESimHelper/` | Vendored Swift helper: framebuffer capture, H.264 encode, HID input, accessibility tree, recording (`RecordingSession.swift`, idle-gap cut in `IdleGapCompressor.swift`). |
| `apps/desktop/scripts/build-sim-helper.mjs` | Builds `resources/native/ade-sim-helper` for macOS dist. |
| `apps/desktop/src/main/services/ios/` | Device lifecycle, launch, screenshots, helper transport, recording, Preview Lab. Preload namespace stays `iosSimulator`. |
| `apps/desktop/src/main/services/ios/iosSimulatorService.ts` | The `ios_simulator` service: app sessions, input, streams, screenshots, and the wiring of the modules below. |
| `apps/desktop/src/main/services/ios/laneDeviceRegistry.ts` | One device per lane: create, attach, takeover, the `lane_apple_devices` rows, the ownership marker, the cleanup pass (`reconcile`), and `releaseLaneAppleDevice` / `endLaneDeviceOnDisk` for a lane that ends. |
| `apps/desktop/src/main/services/ios/laneDeviceMaintenance.ts` | The background cleanup timer and idle power-off, with the shared activity file. |
| `apps/desktop/src/main/services/ios/laneDeviceLifecycle.ts` | `deviceDetach`, `deviceDelete`, the takeover release, and `deviceDeleteInstalled`. Runs each verb's teardown in one order. |
| `apps/desktop/src/main/services/ios/simulatorPower.ts` | The one place ADE boots or powers off a simulator. It resets the helper session, stops a recording, and drops the cached `simctl list`. |
| `apps/desktop/src/main/services/ios/iosDeviceHub.ts`, `simHelperClient.ts` | Device sessions, and the NDJSON client that supervises the helper. |
| `apps/desktop/src/main/services/ios/appleStreamRelay.ts`, `appleLocalViewers.ts` | Brain-side forwarder for the H.264 stream, and which lanes have a viewer on this machine. |
| `apps/desktop/src/main/services/ios/recording/simRecordingService.ts` | Recording rules: auto-record, caps, orphan recovery, filing each recording as proof. |
| `apps/desktop/src/main/services/ios/recording/appleRecordingsStore.ts` | The on-disk layout `<projectRoot>/.ade/artifacts/apple-recordings/<laneId>/<id>.mp4` plus the `<id>.json` sidecar. Every walk of that layout goes through it. |
| `apps/desktop/src/main/services/chat/laneAppleDeviceDirective.ts` | The turn-time hint that tells an agent its lane has a device. |
| `apps/desktop/src/shared/types/iosSimulator.ts` | Cross-process types, including `LaneDevice`, recording records, `APPLE_AGENT_ACTIONS` and `APPLE_USER_ONLY_ACTIONS`. |
| `apps/desktop/src/shared/runtimeClientNames.ts` | `DESKTOP_CLIENT_NAMES` and `isDesktopClientName`, the gate for user-only verbs on the RPC server. |
| `apps/desktop/src/shared/types/workToolShow.ts` | The show-request surfaces (`apple`, `floating-apple`, `browser`, `proof`) and event shape. |
| `apps/desktop/src/renderer/components/apple/AppleDevicePane.tsx` | The pane body. It composes the picker, stage, rail, drawer and status strip. |
| `apps/desktop/src/renderer/components/apple/useAppleLaneDeviceList.ts` | Service status (polled while on screen) and the lane's device list for the pane. |
| `apps/desktop/src/renderer/components/apple/useAppleDeviceStartTracker.ts` | Tracks a device start for the loading card, and re-reads the truth when the card stops moving. |
| `apps/desktop/src/renderer/components/apple/useAppleInspect.tsx` | Inspect mode: one snapshot per switch-on, the hovered and selected element, and the overlay. |
| `apps/desktop/src/renderer/components/apple/appleDeviceScene.ts`, `appleDeviceModelLoader.ts`, `AppleDevice3DView.tsx` | The 3D body and screen math, the GLB loader, and the 3D presenter. |
| `apps/desktop/src/renderer/components/apple/appleDuo.ts`, `appleDuoScene.ts` | The foldable "Duo" mode: the pure posture state machine, panel rotations, inner-display coordinate mapping and capability matcher, plus the procedural two-panel body builder. Capability-gated; unused on non-foldable devices. |
| `apps/desktop/src/renderer/components/apple/AppleDevicePicker.tsx`, `applePickerInventory.ts` | The picker and its grouping (this lane's device, free devices, devices another lane holds), the Create control (runtime and model), and the Storage section (total size, Leftover / Old ADE? tags, Clean up). |
| `apps/desktop/src/renderer/components/apple/useLaneAppleDevices.ts`, `LaneAppleDeviceMarker.tsx` | The Apple mark beside each lane in the Work session list that holds a device; green while booted, muted while claimed but off. |
| `apps/desktop/src/renderer/components/apple/AppleToolCardMenu.tsx`, `useAppleLaneDeviceCard.ts` | The Work tools picker card's claim state and its corner menu (boot / open / release / delete). |
| `apps/desktop/src/renderer/components/apple/DangerConfirmMenuItem.tsx` | The shared two-row destructive menu item (a disabled idle row plus a confirmation row) used by the card menu and the device picker. |
| `apps/desktop/src/renderer/components/apple/AppleDeviceMiniPlayer.tsx`, `appleMiniPlayerStore.ts` | The floating device player over the chat. |
| `apps/ade-cli/src/cli.ts` | `ade apple` typed commands. `ade ios-sim` is the deprecated alias. |
| `apps/ade-cli/src/help/appleHelp.ts` | Help text for each `ade apple` subcommand, and the help aliases. |
| `apps/ade-cli/src/services/sync/appleRemoteCommands.ts` | `apple.*` remote commands for the phone and the web client, including `apple.invoke`. |
| `apps/ade-cli/src/services/workTools/workToolShowRequests.ts` | `ade apple show` / `ade ui show` on the brain side. |
| `apps/desktop/resources/agent-skills/ade-apple/SKILL.md` | Agent skill for the verbs below. |
| `apps/ios/ADE/Debug/ADEInspectorKit/ADEInspectable.swift` | DEBUG-only Swift helpers that publish element frames into the app container. See [inspector.md](./inspector.md). |

## CLI

Canonical group: `ade apple`. Alias: `ade ios-sim` (one deprecation line per
process). New verbs call `deviceCreate`, `deviceAttach`, `deviceList`,
`deviceDelete`, `recordStart`, `recordStop`, `recordList`, `recordDelete`,
and `frame` on the `ios_simulator` RPC namespace.

```bash
ade --socket apple status --text
ade --socket apple device-create --text
ade --socket apple apps --text
ade --socket apple launch --target <id> --follow --text
ade --socket apple stream-start --fps 60 --text
ade --socket apple frame --out .ade/tmp/sim.png --text
ade --socket apple proof-bundle --caption "Settings row renders" --text
ade --socket apple shutdown --text
```

### Verb map

Existing verbs keep their RPC methods: `status` → `getStatus`, `apps` →
`listLaunchTargets`, `launch` → `launch`, `open-device` → `openDevice`,
`close-device` → `closeDevice`, `shutdown` → `shutdown`, `claim` → `claim`,
`snapshot` → `getScreenSnapshot`, `tap-element` / `fill-element` /
`wait-for-element` / `assert-visible` / `select`, `tap` / `drag` / `type`,
`button` / `rotate`, `screenshot`, `proof` / `proof-bundle`, device tools, `log-*`,
`stream-start` / `stream-status` / `stream-stop`, `preview-*`.

`live-start` is deleted. `--backend` is deleted. `--fps`, `--scale-factor`,
and `--bitrate-kbps` survive on `stream-start`.

### New verbs

```bash
ade --socket apple device-create [--runtime <r>] [--device-type <t>] [--from <simulator>] [--name <name>] --text
ade --socket apple device-attach --simulator <udid|name> --text
ade --socket apple device-list [--installed] [--runtimes] [--disk] [--lane <lane-id>] --text
ade --socket apple device-delete [--force] --text
ade --socket apple device-cleanup [--power-off-idle] --text
ade --socket apple test [--target <id>|--scheme <s>] [--only <ids>] [--build-only] --text

ade --socket apple record-start [--overlays on|off] [--label <text>] [--keep-idle] [--max-seconds <n>] --text
ade --socket apple record-stop [--keep|--discard] --text
ade --socket apple record-list --text
ade --socket apple record-delete --id <id> --text

ade --socket apple start [--udid <udid>|--runtime <r> --device-type <t>|--create <sourceUdid>] --text
ade --socket apple stop [--force] --text
ade --socket apple device-detach [--force] --text
ade --socket apple show [--floating] --text
ade --socket apple scroll --x <x> --y <y> --dy <delta> --text
ade --socket apple foreground --text

ade --socket apple frame [--out <path>] --text
ade --socket apple button home --text
ade --socket apple rotate landscape-left --text

ade --socket apple type "reddit" --submit --text
ade --socket apple key return --text
```

`type --submit` presses Return after the text, so a search or form submits.
With `--submit` and no text, it presses Return alone. `key` presses one named
key: `return` (alias `enter`) or `tab`. Both send the key through `typeText`.

`frame` grabs a decoded stream frame and fails with
`APPLE_STREAM_NOT_RUNNING` when no stream is running. `screenshot` does not
need a stream.

`button` presses Home, lock, volume-up, volume-down, or Siri through the
helper. `shake` is a named button so the column can call it, but this Xcode's
`simctl` has no shake verb and the helper does not implement it — the service
refuses with `APPLE_BUTTON_UNSUPPORTED`. `rotate` sets portrait,
portrait-upside-down, landscape-left, or landscape-right.

`rotate` verifies itself. The helper's `orientation` command answers `true`
once its GSEvent reaches `PurpleWorkspacePort` with `KERN_SUCCESS`, which is a
statement about a mach message and nothing else, so the service reads the real
framebuffer either side of the send instead. A measurement on a machine with
no `Simulator.app` installed showed:

- the send always succeeds and the **device** orientation really does change —
  rotation does not need `Simulator.app`;
- whether the **screen** turns is the foreground app's decision. SpringBoard
  and Settings on an iPhone are portrait-only, so four landscape rotates
  reported success while the framebuffer stayed 1179x2556; Safari, launched
  afterwards onto the already-turned device, came up at 2556x1179 on its first
  frame;
- `portrait-upside-down` is refused the same way on an iPhone.

So `applied: true` means the framebuffer was seen on the requested axis.
`applied: false` carries `reason`: `APPLE_ROTATE_NOT_ADOPTED` (the app kept its
own orientation), `APPLE_ROTATE_SEND_FAILED` (the helper never delivered the
event) or `APPLE_ROTATE_UNMEASURABLE` (the screen could not be read, so nothing
is claimed). `verification: already-on-axis` means the screen was already on
that axis — a 180-degree turn inside one axis leaves the pixel geometry
identical and is deliberately not claimed.

### Auto-record contract

1. An agent's first injected input (`tap`, `tap-element`, `type`,
   `fill-element`, `drag`, `select`, `open-url`) against a device with no
   running recording starts one automatically, tagged `auto`, owned by that
   chat, overlays per Settings.
2. It stops at the end of the chat's turn, or after 10 minutes, whichever
   comes first. `record-start` while an auto recording is running converts it
   to manual (no restart, no gap) and swaps the auto cap for the manual one.
   A manual recording a chat owns stops itself after 10 minutes of real time,
   counted from its start or conversion (`--max-seconds` changes it, up to 4
   hours), and files as proof with `stopReason: "cap"`. A person's recording
   from the pane has no cap unless it asks for one.

   Still time is cut by default. When no new picture and no overlay arrives
   for more than 2 s, the helper keeps 0.75 s of the still and shifts later
   frames back (`IdleGapCompressor` in the helper). A blinking caret or a
   status-bar clock does not count as a new picture (`ScreenChange` compares
   small grey thumbnails). The sidecar and `record-stop` carry `durationMs`
   (the video), `wallDurationMs` (real time) and `idleCutMs`; the proof keeps
   wall-clock `recordedFrom`/`recordedTo`, and its caption and drawer line say
   "idle cut 2:07". `--keep-idle` sends `idleCompression: false` and records
   at wall-clock length. An older helper ignores the field and does not echo
   it, so the record says `idleCompression: false` and `idleCutMs: 0`.
3. An agent may `record-delete` a recording it owns that is not marked
   `proof`. Anything else is `APPLE_RECORDING_PINNED`.
4. **Every recording files itself in the proof drawer the moment it stops**,
   whoever started it, and carries the resulting `proofArtifactId`. A
   screenshot does the same. There is no pin step; `proof-bundle` exists to
   add the machine, device, elements and log alongside the picture, not to
   make a recording count as proof.
5. There is no auto-delete. Recordings live under
   `<projectRoot>/.ade/artifacts/apple-recordings/<laneId>/`.
6. A second chat sees `APPLE_OWNED_BY_OTHER_SESSION` with the owning chat,
   lane, and age.
7. The helper keeps one recording per **device**; the service keeps one per
   **lane**. The helper is the truth. When the service has no recording but
   the helper refuses `record-start` with `already-recording`, the service
   stops the orphan, files its video as proof, and starts again. When
   another lane holds the device, the refusal is
   `APPLE_DEVICE_ALREADY_RECORDING` and names that lane. `record-stop` asks the
   helper about the lane's device even when the service has no recording.
8. A recording ends before its device goes away: `device-stop`,
   `device-delete`, and a takeover by another lane each stop it first. A
   recording that outlives its device blocks every later `record-start` on
   that device until the helper process stops.

Overlays (tap rings and typed-text badges) are composited into the saved file
only. Live viewers never show them. Secure text is excluded before it is
forwarded.

### Device hub subcommands

| Subcommand (aliases) | Action | Flags |
|---|---|---|
| `device-create` | `deviceCreate` | `--runtime`, `--device-type/--model`, `--from/--simulator`, `--name`, `--lane` |
| `device-cleanup` (`cleanup`) | `deviceCleanup` | `--power-off-idle` |
| `test` (`tests`) | `runTests` | `--target`, `--scheme`, `--project/--workspace`, `--test-plan`, `--only`, `--skip`, `--build-only`, `--timeout-ms`, `--lane` |
| `device-attach` | `deviceAttach` | `--simulator/--device/--udid` (required), `--lane` |
| `device-list` | `deviceList` | `--installed`, `--runtimes`, `--disk`, `--lane <lane-id>` (defaults to `$ADE_LANE_ID`) |
| `device-detach` (`detach`) | `deviceDetach` | `--force`, `--ignore-ownership`, `--chat-session`, `--lane` |
| `device-delete` | `deviceDelete` | `--force`, `--ignore-ownership`, `--chat-session`, `--lane` |
| `start` | `deviceStart` | `--udid`, `--runtime`, `--device-type`, `--create`, `--lane` |
| `stop` (`device-stop`, `power-off`, `poweroff`) | `deviceStop` | `--udid/--device`, `--force`, `--ignore-ownership`, `--chat-session`, `--lane` |
| `type` (`text`) | `typeText` | positional text or `--value`, `--submit`, `--device` |
| `key` | `typeText` | positional `return\|enter\|tab`, `--device` |
| `show` (`reveal`) | show request (not an `ios_simulator` action) | `--floating`, `--session` |
| `open-device` (`open-sim`, `boot`) | `openDevice` | `--device/--udid`, `--lane`, `--chat-session`, `--no-window`, `--force` |
| `close-device` (`close-sim`) | `closeDevice` | `--device`, `--chat-session`, `--force`, `--ignore-ownership`, `--shutdown` |
| `record-start` | `recordStart` | `--overlays on\|off`, `--label`, `--keep-idle`, `--max-seconds`, `--lane` |
| `record-stop` | `recordStop` | `--keep`, `--discard`, `--lane` |
| `record-list` | `recordList` | `--lane` |
| `record-delete` | `recordDelete` | `--id` (required), `--force`, `--lane` |
| `frame` | `frame` | `--out`, `--lane` |
| `stream-start` | `startStream` | `--fps`, `--scale-factor`, `--bitrate-kbps`, `--device` |
| `settings` (`device-settings`) | `getDeviceSettings` | `--device` |
| `appearance` | `setAppearance` | positional `light\|dark` or `--appearance`, `--device` |
| `content-size` (`text-size`) | `setContentSize` | positional size or `--content-size`, `--device` |
| `accessibility` (`a11y`) | `setAccessibilityOption` | positional `<option> <on\|off>` or `--option` with `--on`/`--off`, `--device` |
| `location` | `setLocation`, or `clearLocation` with `--clear` | positionals `<lat> <lon>` or `--latitude`/`--longitude`, `--clear`, `--device` |
| `permission` (`privacy`) | `setPermission` | positional `<grant\|revoke\|reset> <service>`, `--bundle-id`, `--device` |
| `push` | `sendPushNotification` | `--bundle-id`, `--title`, `--body`, `--payload`, `--device` |
| `open-url` | `openUrl` | positional url or `--url`, `--device` |
| `relaunch` | `relaunchApp` | `--bundle-id`, `--device` |
| `terminate` (`kill-app`) | `terminateApp` | `--bundle-id`, `--device` |
| `uninstall` | `uninstallApp` | `--bundle-id`, `--device`, `--force` |
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

`--text` is the one flag that reads two ways. A bare `--text` selects ADE's
human-readable output. `--text <value>` is the element query's substring
match. Write `--text-match <value>` when you want no ambiguity.

The semantic loop:

```bash
ade --socket apple open-device --text
ade --socket apple snapshot --text
ade --socket apple tap-element --label "Sign in" --text
ade --socket apple fill-element --identifier email-field --value ada@example.com --text
ade --socket apple wait-for-element --label "Welcome" --timeout-ms 8000 --text
ade --socket apple assert-visible --label "Welcome" --text
ade --socket apple proof-bundle --caption "Sign-in succeeds" --text
```

## Live view

One backend: the helper encodes H.264 from the simulator's IOSurface
framebuffer. `stream-start` takes `--fps`, `--scale-factor`, and
`--bitrate-kbps`. It does not take `--backend`. `getStreamStatus` reports
shape, fps, and bitrate with `url` and `token` null; only `stream-start`
returns those.

A viewer that is not visible stops its stream. A stall of ~3s shows
Reconnect. First frame timeout is 5s.

## Semantic actions

A coordinate tap is a guess that the layout did not move. `findElement`,
`tapElement`, `fillElement`, `waitForElement` and `assertVisible` take the
same query: `ref`, `identifier`, `label`, `text`, `role`, `index`. Every
result reports `matchCount`.

| Tier | Source | Survives |
|---|---|---|
| `id:` | Accessibility identifier | Re-render and layout change |
| `component:` | ADE Inspector component id | Re-render, not a rename |
| `label:` | Role, type, label, value | Re-render, not a copy change |
| `pos:` | Tree path | Nothing |

Read a `pos:` ref as a warning. Ask for an accessibility identifier.

Snapshot and inspect are served by the helper's accessibility tree, with the
DEBUG ADE Inspector kit as a source overlay. See [inspector.md](./inspector.md).

## Event log and proof bundles

`startEventLog` runs `xcrun simctl spawn <udid> log stream` scoped to a
required `bundleId`. `captureProofBundle` writes `screen.png`,
`metadata.json`, `elements.json`, and `log.json`, and pins the active
recording. With no `outDir` the bundle lands in
`<buildRoot>/.ade/proof/ios-sim-<stamp>/`. `screenshot --out` and
`proof-bundle --out` stay inside the build root
(`IOS_SIMULATOR_OUT_PATH_OUTSIDE_ROOT`).

## Troubleshooting

| State | What to do |
|---|---|
| No installed simulator | Open Xcode ▸ Settings ▸ Components. ADE never downloads one. |
| `APPLE_RUNTIME_NOT_INSTALLED` | The runtime or model named is not on this Mac; the message lists what is. |
| `APPLE_TEST_RUN_BUSY` | Another `apple test` is running. Wait, then run again. |
| Disk full of simulators | Open Apple Development's picker and press **Clean up**, or run `ade apple device-cleanup --power-off-idle`. Delete an "Old ADE?" device from its own menu. |
| `APPLE_HELPER_UNAVAILABLE` | The vendored helper binary is missing from `resources/native/ade-sim-helper`. |
| `APPLE_STREAM_NOT_RUNNING` | `frame` needs a live stream. Use `screenshot`, or `stream-start` first. |
| `APPLE_DEVICE_OFF` | A viewer asked to watch a device that is off. Watching never boots; `apple start` does. |
| `APPLE_BUTTON_UNSUPPORTED` | That button is not a helper `button` name, and this Xcode's `simctl` has no equivalent (today: `shake`). |
| `APPLE_DEVICE_ATTACHED_NOT_DELETABLE` | `device-delete --force` detaches; it does not delete the user's simulator. |
| `APPLE_RECORDING_PINNED` | Proof-marked recordings cannot be deleted by an agent. |
| `APPLE_DEVICE_ALREADY_RECORDING` | Another lane records this device. Run `record-stop --lane <that lane>`. |
| `IOS_SIMULATOR_OWNED_BY_OTHER_SESSION` | Ask, then `shutdown --force` / `open-device --force` / `claim --ignore-ownership`. |
| `IOS_SIMULATOR_TARGET_ROOT_MISMATCH` | Re-run `ade --socket apple apps --text`. |
| `IOS_SIMULATOR_LAUNCH_IN_PROGRESS` | Wait, or `ade --socket apple shutdown --force --text`. |
| `IOS_SIMULATOR_LANE_NOT_RESOLVED` | Pass `--project-root`. |
