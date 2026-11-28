# Apple device

DAEX drives a per-lane Apple simulator from the Work tab's **Apple Development**
tool and from `daex apple` (`ade apple` still works; `daex ios-sim` is a
deprecated alias that prints one stderr line per process). It makes a new
device for the lane (or attaches one the user names), builds and launches the
app, streams the framebuffer through a vendored Swift helper, and turns
gestures into simulator input.

macOS only: `xcrun` and `xcodebuild` must be on the runtime host. Frames and
input go through `ade-sim-helper` (CoreSimulator / SimulatorKit). No idb, no
Screen Recording grant, no Simulator.app window. Windows and Linux use the
DAEX Cloud iPhone (`ios@cloud`), the same `daex apple` surface on a rented
simulator: [ade-cloud-iphone.md](./ade-cloud-iphone.md).

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/native/ADESimHelper/` | Swift helper: capture, H.264 encode, HID input, accessibility tree, posture (`DevicePosture.swift`), recording (`RecordingSession.swift`, `IdleGapCompressor.swift`). Device lookups go through `SimServiceContextCache.swift`. Vendored serve-sim code is described in its `VENDORED.md`. |
| `apps/desktop/scripts/build-sim-helper.mjs` | Builds `resources/native/ade-sim-helper` for macOS dist. |
| `apps/desktop/src/main/services/ios/iosSimulatorService.ts` | The `ios_simulator` service: sessions, input, streams, screenshots, agent guards (`guardAgentDeviceActions`), live touch. Preload namespace stays `iosSimulator`. |
| `.../ios/laneDeviceRegistry.ts` | One device per lane: create, attach, takeover, extras, the cleanup pass (`reconcile`), `releaseLaneAppleDevice`. |
| `.../ios/laneDeviceRows.ts`, `appleDeviceMarker.ts`, `laneDeviceRelease.ts` | `lane_apple_devices` / extra rows, the ownership marker, ending a lane on disk. |
| `.../ios/laneDeviceLifecycle.ts` | `deviceDetach`, `deviceDelete`, takeover release, `deviceDeleteInstalled`; one teardown order. |
| `.../ios/laneDeviceMaintenance.ts` | Background cleanup timer, idle power-off, the shared activity file. |
| `.../ios/simulatorPower.ts` | The one place DAEX boots or powers off a simulator. |
| `.../ios/simulatorMemoryReclaim.ts` | Pure memory-guard rules (`classifySimulatorForMemoryReclaim`) and the "a tool uses this device" check. |
| `apps/ade-cli/src/services/runtime/simulatorMemoryReclaimer.ts` | The brain's memory guard: warnings and idle shutdowns. |
| `.../ios/appleSimulatorCatalog.ts`, `appleRuntimeManager.ts`, `shared/appleRuntimeVersions.ts` | `simctl` parsing and picks; runtime list/install/delete; the "newest runtime that runs this model" rule. |
| `.../ios/xcodeDerivedData.ts`, `xcodeGenProjects.ts`, `appleTestRun.ts` | Xcode's machine-wide DerivedData; XcodeGen generation before a build; `xcodebuild test`. |
| `.../ios/iosDeviceHub.ts`, `simHelperClient.ts` | Device sessions; the NDJSON client that supervises the helper. |
| `.../ios/appleStreamRelay.ts`, `appleStreamRelayForService.ts`, `appleStreamPacing.ts`, `appleLocalViewers.ts` | Remote stream forwarding, per-viewer pacing and adaptive cap, which lanes have a local viewer. |
| `.../ios/recording/simRecordingService.ts`, `appleRecordingsStore.ts` | Recording rules (auto-record, caps, orphans, proof filing); the on-disk layout. |
| `.../ios/appleDuoService.ts`, `apps/desktop/src/shared/appleOrientation.ts` | The foldable (Duo): posture, live panel, Apple's model and skill, App Store shots, render broker; shared orientation facts. |
| `.../ios/appleWindowLayout.ts` | iPad window layout judging (`judgeAppleWindowLayout`). |
| `apps/desktop/src/main/services/device/deviceLease.ts` | `daex apple lease` (shared with Android). |
| `apps/desktop/src/main/services/chat/laneAppleDeviceDirective.ts` | Turn-time hint that the lane has a device. |
| `apps/desktop/src/shared/types/iosSimulator.ts` | Cross-process types, `APPLE_AGENT_ACTIONS`, `APPLE_USER_ONLY_ACTIONS`, limits. |
| `apps/desktop/src/shared/runtimeClientNames.ts` | `isDesktopClientName`, the gate for user-only verbs. |
| `apps/desktop/src/renderer/components/apple/` | Pane (`AppleDevicePane.tsx`), picker (`AppleDevicePicker.tsx`, `applePickerInventory.ts`), tools card (`AppleToolCardMenu.tsx`), lane marker, mini player, inspect, 3D view, Duo dock and body, render host (`AppleRenderHost*.tsx`). |
| `apps/desktop/src/renderer/components/device/` | Pieces shared with Android: 3D scene and orbit, procedural fold body, hinge slider, render sheet, tools drawer, inspect state. |
| `apps/ade-cli/src/cli.ts`, `help/appleHelp.ts`, `cliAppleFormat.ts` | `daex apple` commands, help, `--text` output. |
| `apps/ade-cli/src/services/sync/appleRemoteCommands.ts` | `apple.*` remote commands for phone and web, including `apple.invoke`. |
| `apps/ade-cli/src/services/workTools/workToolShowRequests.ts` | `daex apple show` / `daex ui show` on the brain. |
| `apps/desktop/resources/agent-skills/daex-apple/SKILL.md` | Agent skill. |
| `apps/ios/ADE/Views/Work/` | Phone viewer: `AppleDeviceViewer*.swift`, `AppleStreamSession.swift`, `AppleDeviceStream.swift`, `AppleDeviceControl.swift`, `LiveStage*.swift`. |
| `apps/ios/ADE/Services/SyncService+AppleDevice.swift` | Phone `apple.*` calls, sent to the lane's machine. |
| `apps/ios/ADE/Debug/ADEInspectorKit/` | DEBUG-only inspector kit; see [inspector.md](./inspector.md). |

## Gotchas / fragile areas

- **Nothing downloads by itself.** Creating a device never downloads; a runtime
  downloads only when the person asks in the Runtimes section.
- **DAEX never deletes a simulator it did not create.** Attached devices are
  only detached, never idle-powered-off, and the cleanup pass deletes nothing
  when `simctl list` cannot be read.
- **Stale CoreSimulator context.** After CoreSimulatorService restarts, the
  helper's shared context keeps the old device list. `SimServiceContextCache.swift`
  asks a new context (at most once a second) when a lookup misses or finds a
  device not booted.
- **Agents cannot be stopped from a raw `simctl create`.** The skill and the
  device hint say not to; the marker and the cleanup pass catch leftovers.
- **Push banners** show on screenshots from a signed-in, paired simulator.
  Capture on a fresh lane or extra device.
- **Rotation is the app's choice.** The helper's send always succeeds; whether
  the screen turns depends on the foreground app (SpringBoard on iPhone is
  portrait-only). `rotate` checks the framebuffer, so trust `applied`.
- **Duo folds sweep in 10° steps.** SpringBoard's fold state machine can stick
  on a 0°↔180° jump and light the wrong panel.
- **The Duo's legacy Indigo inner target is disconnected**; input goes through
  CoreDevice's digitizer to touchscreen `0x100 + screenId`, or `backboardd` can
  abort.
- **Never `display: none` an off-screen WebGL view** (`AppleRenderHostJob.tsx`);
  it stops rendering.

## Runtime ownership

The simulator service runs where the DAEX runtime runs. Non-macOS runtimes
report `supported: false`, and every command except `status` fails with the
macOS-only error. `status` is the capability gate and reports `tools.helper`
(`present`, `path`, `version`).

A remote Mac runtime supports everything; a Windows desktop bound to it watches
and drives over the helper's H.264 stream.

**DAEX Cloud** computers are Linux and run no simulator. The Apple tool still
shows for a cloud chat, says "Apple simulators stream here from a Mac", and
offers the person's Macs in its **Runs on** row (`useToolMachines`,
`workToolStartState.tsx`). The chat's cloud computer shows as "DAEX Cloud".

Requests started on a loaded project keep that project's runtime until they
finish, and live-view cleanup keeps the runtime it acquired the stream on, so a
tab switch never redirects a stop. A request interrupted by a project switch
fails with a message naming the action; retry after the switch.

**Session ownership.** Each launched session has one owner chat/lane. A second
chat gets `IOS_SIMULATOR_OWNED_BY_OTHER_SESSION` (device/recording verbs:
`APPLE_OWNED_BY_OTHER_SESSION`) naming the owner chat, lane and age. The CLI's
`iosSimulatorErrorHint` adds the next command. Ownership ends when the owner
chat is archived or deleted. `shutdown --force`, `launch --force`,
`claim --ignore-ownership` and naming the owner's chat id get through; ask
before evicting another chat.

**Build root.** Commands default to the caller's lane worktree; `--project-root`
wins. Target ids are validated against it (`IOS_SIMULATOR_TARGET_ROOT_MISMATCH`).
A `--lane` with no worktree fails (`IOS_SIMULATOR_LANE_NOT_RESOLVED`). A
`project.yml` with no tracked `.xcodeproj` beside it is generated by XcodeGen
before a launch, install, test or target listing; a tracked `.xcodeproj` is
never rewritten.

## Per-lane devices

A lane gets no device until asked (the pane, or an agent's `launch`,
`open-device`, `start`, `test`, `device-create`). The first ask runs
`simctl create` from an installed runtime, named `ADE · <lane>`. Nothing is
copied from another simulator. Defaults: the newest installed iOS runtime and
the project's last device type (KV `apple:last-device-type`), else the newest
iPhone. A model named with no runtime gets the newest installed runtime that
runs it. Errors: `APPLE_NO_INSTALLED_SIMULATORS`, `APPLE_RUNTIME_NOT_INSTALLED`.
A lane may instead `device-attach` a simulator the user names.

`origin` on the row is `created` (DAEX's), `clone` (older DAEX device, treated
the same) or `attached` (the user's; `isAdeOwnedLaneDevice`).

**One lane owns a device at a time.** `device-attach` on a simulator another lane
holds moves the binding: the old lane's stream and session are released, its
row is re-keyed (with `origin` and `ade_installed_bundle_ids`), the simulator
stays on, and the old lane gets `apple.device.state` `phase: "released"`. The
picker asks first, naming the lane being interrupted.

### Extra devices

A lane may hold up to `APPLE_LANE_EXTRA_DEVICE_LIMIT` (2) extras beside its own
device; `ADE_APPLE_LANE_EXTRA_DEVICES` raises it up to 8. `device-create --extra`
makes and boots one (`ADE · <lane> · <model>`). Extras live in the local-only
`lane_apple_extra_devices` table, their marker says `extra: true` (a lost row is
re-adopted as an extra), and they end with the lane.

- They are reached only by `--device <udid|name>`. Without it, commands drive
  the lane's own device. The pane never streams an extra.
- An extra never streams, records, `launch`es or runs tests. To put the lane's
  app on one: `daex apple install --device <id> [--launch] [--no-build]`
  (`ios_simulator.installApp`), which builds once into the lane's DerivedData.
  One xcodebuild runs per lane DerivedData at a time (`APPLE_BUILD_BUSY`).
- `daex apple device-promote --device <id>` makes an extra the lane's device,
  keeping what is installed on it. Refused with `APPLE_LANE_DEVICE_BUSY` while
  the old device streams, records, tests, launches, or another chat holds the
  lane's lease. The old device becomes an extra (DAEX's) or is detached
  (attached).
- `device-attach` refuses an extra (`APPLE_DEVICE_IS_EXTRA`).

### Device leases

One agent should drive a device; others hand it work. When agents must share,
they take turns with `daex apple lease` (`ios_simulator.deviceLease`,
`device/deviceLease.ts`):

- One queue per device (the lane's device, and each extra by `--device`).
  `--wait` up to 540 s; `--ttl` default 10 minutes unless renewed.
- The token is the turn. Only it renews (`lease --token`) or releases
  (`lease release --token`). Subagents of one chat share `ADE_CHAT_SESSION_ID`,
  so the CLI sends `distinct: true` and a call without the token queues even
  under the same holder name. Status names the holder, never the token.
- Advisory: device commands neither check nor renew it, and the pane is never
  blocked. It does block `device-promote` from another chat.
- A lease ends when its chat is archived or deleted, when a waiting CLI
  disconnects, or when the brain restarts (memory only). A refused lease exits 1,
  so `lease --wait N && <work>` is safe.
- `--machine` sends it to the lane's machine; the token is that machine's.

### Runtimes and Xcode

`appleRuntimeManager.ts` owns the machine's runtimes as `ios_simulator.runtime*`
actions with the lane's pin. One download per machine; every open project hears
its progress.

- `runtimeList`: installed runtimes with size, their simulators, `newest`,
  `superseded` (a newer runtime runs every current model it does), `missing`
  (current models no installed runtime runs, grouped by the runtime they need),
  and `leftovers` (macOS asset folders `simctl` no longer lists; SIP-protected,
  so the panel shows manual steps and DAEX never removes them).
- `runtimeInstall`: `xcodebuild -downloadPlatform iOS` as a cancellable
  background job (~10 GB free check, `apple.runtime.install` events);
  `--version` pins `-buildVersion`. Installing a pinned version already present
  fails with `APPLE_RUNTIME_ALREADY_INSTALLED`.
- `runtimeDelete` / `runtimePrune` (user-only): lane devices move to the newest
  runtime that runs their model (`simctl upgrade`); the person chooses for their
  own simulators.
- Xcode note: version, first-launch status (user-only `xcodeRunFirstLaunch`),
  Apple's releases feed at most once a day, `developerDir`, `appPath`.

CLI: `daex apple runtimes [list|install [--version x.y]|cancel]`. Removing is
the person's call, from the panel.

### Xcode DerivedData

`xcodeDerivedData.ts` lists and deletes Xcode's machine-wide DerivedData
(custom location from `IDECustomDerivedDataLocation` when absolute), not a
lane's `.ade/cache/ios-simulator/DerivedData`. Both go to the lane's machine by
pin.

- `derivedDataList` (agents may call it): folders Xcode made (project folders
  with a `WorkspacePath`, flagged `workspaceMissing`, and Xcode's named caches).
  Sizes only with `measure: true`; cached a minute; never measured on a timer.
- `derivedDataDelete` (user-only, `confirmedByUser: true`): refused while Xcode
  or xcodebuild runs; each folder must be one Xcode made. Folders are renamed to
  `.ade-deleting-` trash first, measured under a 20 s deadline
  (`freedIsLowerBound`), then removed in the background (`shared/deletingTrash.ts`).

CLI: `daex apple derived-data [--measure]` (read only).

Before any xcodebuild, `healMovedDerivedData` drops package state in the lane's
DerivedData that points at another folder, so a copied DerivedData re-resolves
without refetching.

### When a lane ends

Archive and delete call `releaseLaneAppleDevice` (from `laneService`, after
`iosSimulatorService.stopForLane`):

- A DAEX device is powered off and deleted, with its data. Extras too.
- An attached device is the user's: DAEX uninstalls only apps it installed
  (absent before, present after, per `simctl get_app_container`; kept in the
  local-only `ade_installed_bundle_ids`, never synced), waits 5 s, powers it off
  and unbinds it. The wait exists because a shutdown right after
  `simctl uninstall` sometimes brought the app back.
- If another lane holds the same udid, only the row is dropped.
- A failed delete or leftover app keeps the row for the cleanup pass. An
  attached device gets one retry and is then left alone. Rows are removed by lane
  and udid, so an unarchived lane's new device is safe.
- The lane's build cache and test output under `.ade/cache/ios-simulator/` are
  deleted. Recordings stay on archive and go on delete.

When duplicate lanes merge and both had a device, the duplicate's device is
deleted after the merge commits.

### Ownership marker and the cleanup pass

Every DAEX device carries
`~/Library/Developer/CoreSimulator/Devices/<udid>/ade-lane-device.json`
(`projectRoot`, `laneId`, `name`, `createdAt`). The marker, not the row, proves a
device is DAEX's.

The cleanup pass (`registry.reconcile`) runs 1 minute after start and every
15 minutes (`APPLE_DEVICE_CLEANUP_INTERVAL_MS`) in hosts with
`backgroundMaintenance: true`:

- Rows for missing simulators are dropped; rows of ended lanes are released.
- A marked device of this project no live lane holds is deleted, or re-adopted
  when its lane is live. Markers younger than 5 minutes are skipped (create
  writes the marker before the row). Rows are re-read before each delete.
- Another project's marked device is checked read-only in that project's
  `ade.db`; it is deleted only when that project no longer uses it or is gone.
  A moved project is followed first through `.ade/moved-to.json` or the move
  journal (`<ADE_HOME>/project-moves/`), up to five hops.

**Detach.** `device-detach` acts on the lane's own device only. Detaching a DAEX
device stamps `detachedAt`; the device is then a leftover that the first pass
after the 5-minute grace deletes unless a lane attaches it. The answer carries
`deletesAfter`. `--keep` stamps `keptAt` instead: never deleted, never
re-adopted, shown as "Kept". Agents pass `--keep` only when the user asked.
Detaching an attached device uninstalls DAEX's apps in the background.

Every desktop path that gives up a DAEX device confirms first
(`confirmAppleDeviceRelease`), offering "Keep it as a free simulator instead".
The picker shows a released DAEX device as "Deletes in N min". The phone has no
release or delete path.

`daex apple device-cleanup [--power-off-idle]` and the picker's **Clean up** run
the pass now. An agent's power-off reaches only its own lane's device. A skipped
power-off (Simulator.app open, or `ps` failed) is reported in `powerOffSkipped`.

### Idle power-off

A booted DAEX device untouched for 30 minutes is powered off
(`ADE_APPLE_IDLE_POWER_OFF_MINUTES`; `0` disables). Use is the latest of:
`<device dir>/ade-last-activity` (written at most once a minute by any call that
resolves the lane, and while DAEX streams, records, tests or launches),
CoreSimulator's last-boot time, the app bundle folder's mtime, and any outside
process whose command line names the udid. A `Booting` device is never idle.
Nothing is powered off while Simulator.app runs. Attached devices are never
powered off.

The reason is written to `<device dir>/ade-powered-off`; the next boot,
`status` and `device-list` report it so an agent does not blame its own command.

### Memory guard

The brain's `resourcePressureMonitor.ts` calls the reclaimer during a memory or
swap episode when simulators hold at least 3 GB and 10% of RAM (macOS only):

1. **Warn** each lane with a booted simulator (agent terminals, the chat that
   booted it, and a `deviceNotice` on the next simulator call).
2. **Shut down idle devices** 10 minutes later or on a critical sample
   (`simctl shutdown`, never erase or delete), then wait 60 minutes.

A device stays on if DAEX streams, records, tests or launches on it, a viewer
watches, it was used in the last 15 minutes, an outside process names it, or
it is not DAEX's and booted under 2 hours ago (see
`classifySimulatorForMemoryReclaim`). `ADE_APPLE_MEMORY_POWER_OFF=0` keeps
warnings and disables shutdowns.

### Tests

`daex apple test` (`runTests`) runs `xcodebuild test` on the lane's device with
`-parallel-testing-enabled NO`, DerivedData in the lane's cache, result bundles
under `.ade/cache/ios-simulator/test-results` (newest three) and logs under
`test-logs/`. One run per runtime (`APPLE_TEST_RUN_BUSY`). Default timeout
30 minutes, max 2 hours. Counts come from the run-wide XCTest summary (corrected
to failed tests, not assertions) plus Swift Testing's summary lines; `failures`
lists each failing test once as `Mod/Class/testX` (what `-only-testing` takes).

### Teardown verbs

`deviceStart`, `deviceStop`, `deviceDetach` and `deviceDelete` run one at a time
per lane in the lane's lifecycle queue; a delete decides everything from one
read inside the queue. `device-create` and `device-attach` are not queued.

- `device-detach`: no delete now, power unchanged (see marker section).
- `device-delete`: powers off and deletes a DAEX device. An attached device is
  refused unless `--force`, which only detaches it. Answer names `deleted`,
  `detached`, or `notFound`.
- Both use `stop`'s owner rule: refused while another chat drives the device
  unless `--ignore-ownership` (detach also accepts `--force`).

`deviceDeleteInstalled` deletes a simulator the user picked. It is the
user-only action: allowed only to a user client whose connect name passes
`isDesktopClientName` (a claim, not authentication), never listed in
`capabilities`, and reachable from phone and web only through controller-only
`apple.invoke`. It refuses a device any lane holds.

### Agent scoping

The RPC server sets `agentCaller: true` on every `ios_simulator` call from an
agent (a chat, run, step or attempt identity, or an `ade` process with no chat
identity). Rules (`guardAgentDeviceActions`):

- An agent may make its lane's one device without asking; a second is
  `APPLE_DEVICE_EXISTS`.
- When the lane gave up its device and that simulator is still free, driving
  verbs refuse with `APPLE_LANE_DEVICE_RELEASED`, naming the
  `device-attach --simulator <udid>` that takes it back, instead of making a
  new device.
- An agent may attach a simulator no lane holds; another lane's is
  `APPLE_DEVICE_NOT_LANE_OWNED`.
- Every device verb runs on the lane's device only. A `--device`/`--udid`
  naming another simulator is refused. With no lane device there is no "first
  booted iPhone" fallback (except `launch`/`open-device`, which create one).
  User clients keep the fallback.
- The lane is the chat's lane, or for an unbound `ade` process, the lane of its
  `callerRoot`. With no lane, an agent may only read status and listings.

## Desktop surface

**Apple Development** is one pane inside the Work tools pane.

- The rail: Home, Hardware buttons (Lock, Volume, Siri, app switcher), Rotate,
  Inspect, Screenshot, Record, 3D/Flat, Tools, More. `shake` is not offered:
  the helper cannot press it (`APPLE_BUTTON_UNSUPPORTED`).
- The drawer: Device, App, Capture, Preview Lab; one open at a time, closed
  groups unmounted so their polling stops.
- Closing the tool's tab powers the device off (confirmed when booted).
  Minimising the tools pane shows a floating player (per-chat opt-out).
- **Watching never boots.** A device that is off shows "{name} is off." with
  Start. Only Start, the picker, `start`, `stream-start`, `open-device` and
  `launch` power one on.
- Until the device list answers once, the pane shows "Loading simulators…" or
  an error with Retry, never the "No Apple simulators" card.
- The tools card shows `{name} · Running | Starting | Shut down` and a menu to
  boot, open, release or (DAEX device only) delete. The lane marker in the Work
  list is green while booted, muted while claimed but off.

### Foldable (Duo) mode

Gated by `appleDeviceSupportsDuo` on the CoreSimulator type identifier
(`...SimDeviceType.iPhone-Duo`), never the display name. Validated on Xcode 27.1,
iOS 27.1.

- **Folding.** The helper sends Device Hub's `HIDVendorDefined` hinge/orientation
  messages to `dtuhidd` (vendored serve-sim shim). `DevicePosture.swift` adds
  `posture`, `posture-get` and a watcher; the relay forwards
  `{t:"posture", angle, screen, displayOrientation, tableMode}` notes to remote
  viewers (replayed to a joiner before its first frame). `setPosture` with
  `follow: true` answers at once (used for phone mirroring). CLI:
  `daex apple fold <pose>|--angle N|--sequence a,b,c`, `daex apple posture`.
- **Panels.** Screen 1 is the cover, screen 3 the inner display (mounted a
  quarter turn from its framebuffer). Capture follows the active panel; the
  service republishes sizes on each switch. Views draw the panel by the guest's
  `displayOrientation`; `APPLE_DUO_INNER_ORIENTATION` is the fallback.
- **Turning.** On a hinged device `orientation` sends CoreDevice's
  orientation-picker control (leaving Table Mode first). `rotate` is verified
  from the guest's live-panel report and resent once if the picture did not
  turn. Orientation names describe how the phone is held, so on the inner
  display "portrait" gives a wide picture; the CLI prints `picture inner
  display, tall|wide`.
- **Settling.** `fold` waits for the expected shape (`laptop` tall, `book`/`open`
  wide) or two equal reads, never past the deadline; otherwise `settled: false`.
- **Accessibility.** Hit-tests answer only on the live display; `ax-describe`
  probes that display and turns grid points by its picture turn.
- **3D.** Apple's `V68.usdz` is read from the owning machine's Xcode
  (`getDuoModel`, never bundled); `appleV68DuoBody.ts` maps each panel, faces
  the panel the fold ends on (`appleDuoFacingScreen`), and stands the pose on a
  table. `device/proceduralFoldBody.ts` is the fallback.
- **Controls.** `AppleDuoDock` sits under the device: Hinge slider (3D) or
  Cover/Inner (flat), plus the four orientations. The slider is the one source of
  the hinge angle; reports within 2° (`appleDuoSameHinge`) change nothing, and
  DAEX's own sweep (up to 8 s) holds off intermediate reports. Laptop vs Book
  (both 90°) comes from the hold (`appleDuoStanceFor`). The Duo menu has
  presets, ±15° steps and **App Store screenshots** (`daex apple app-store-shots`).
- **Recording a Duo.** A recording that starts its own capture applies the live
  panel first (the default surface is the dark inner panel). A fold mid-recording
  draws the other panel upright, fitted inside the first frame's size.
- **Apple's Duo skill.** `addDuoSkill` / `daex apple duo-skill` exports Xcode's
  agent skills and copies `app-resizability` into the lane's `.agents/skills`.

### 3D renders

The rail's **Render** sheet renders the 3D body (angles, backgrounds, contact
sheet, 6 s WebM turntable). For a Duo each pose folds the real simulator first.
Files go to `attachRenderProof` on the device's machine, into the chat's and
lane's proof drawer there.

`daex apple render` does the same without a pane. The service emits
`apple.render.request` to every desktop window with the project open on (or
bound to) the device's machine; a live pane acks at once, otherwise each
`AppleRenderHost` waits 1.5 s, acks with its own binding as pin, renders off
screen and unmounts. No ack within 7.5 s fails: rendering needs a desktop
window. The host never boots a device and is idle (no stream, no WebGL) between
jobs.

## Agent discovery

`getStatus` returns `capabilities`, built from `APPLE_AGENT_ACTIONS`, the same
constant that feeds the action allowlist, so what agents are told and what they
may call cannot drift. `APPLE_USER_ONLY_ACTIONS` join the allowlist but never
`capabilities`.

When a lane holds a device, `laneAppleDeviceDirective.ts` adds a short hint to
the provider prompt naming the device, pointing at `daex apple` and leases. It is
sent on the first turn after binding and when the udid changes, never in the
transcript, and not off macOS.

`daex apple show [--floating]` (or `daex ui show apple`) asks the desktop showing
the chat to open the pane or floating player. The CLI prints `shown`, `held`, or
`no_desktop` (exit 1). Agent input can also raise the floating player unless
the user turned "Show preview when minimized" off for that chat.

## CLI

Run `daex apple --help` (and `daex apple <verb> --help`, from
`help/appleHelp.ts`) for the full verb and flag list. Most verbs map to an
`ios_simulator` action of a similar name (`status` → `getStatus`, `apps` →
`listLaunchTargets`, `snapshot` → `getScreenSnapshot`, `start` → `deviceStart`).

```bash
daex apple status --text
daex apple device-create [--runtime r] [--device-type t] [--extra] --text
daex apple launch [--target id] [--configuration Release] [-- <app args>] --text
daex apple snapshot --text
daex apple tap-element --label "Sign in" --text
daex apple fill-element --identifier email-field --value ada@example.com --text
daex apple wait-for-element --label "Welcome" --timeout-ms 8000 --text
daex apple proof-bundle --caption "Sign-in works" --text
daex apple test [--only ids] --text
```

Behavior worth knowing:

- `screenshot` files proof and prints `cite:`; `--no-proof` takes a scratch
  shot. `--out` resolves against the caller's directory and the CLI copies the
  shot there (`copyAppleScreenshotTo`). `proof-bundle --out` must stay inside
  the build root (`IOS_SIMULATOR_OUT_PATH_OUTSIDE_ROOT`).
- `snapshot --text` prints each element's stable `ref` (from identifier, else
  label), role, label and frame. `--label` matches exactly first, then a unique
  prefix (`wait`/`assert-visible` take exact only). A bare `--text` means text
  output; use `--text-match` or `--contains` for the element query.
- A tap's down/up and a drag's steps go to the helper as one `sendGesture`
  block, so another caller's snapshot cannot split them. `long-press` and
  `tap-element --hold-ms` are real holds.
- `type` checks keyboard focus first (`focus: "none"` when nothing has it);
  `--submit` presses Return. `key` presses a real HID key with modifiers, and
  always releases them.
- `launch` builds `Debug` unless `--configuration`; args after `--` go to the
  app (`--launch-arg=<v>` for dash-leading values).
- `frame` needs a running stream (`APPLE_STREAM_NOT_RUNNING`); `screenshot`
  does not.
- `rotate` answers `applied: true` only when the framebuffer is seen on the
  requested axis; otherwise `reason` is `APPLE_ROTATE_NOT_ADOPTED`,
  `APPLE_ROTATE_SEND_FAILED` or `APPLE_ROTATE_UNMEASURABLE`. A turn inside one
  axis is `verification: already-on-axis`.
- Agent coordinates are upright screen points (what screenshots and the tree
  show); the helper turns them onto the framebuffer (`space: "screen"`). Viewer
  input (`source: "user"`) is already in framebuffer space.

### Auto-record contract

1. An agent's first injected input (`tap`, `tap-element`, `type`,
   `fill-element`, `drag`, `select`, `open-url`) on a device with no recording
   starts one, tagged `auto`, owned by that chat. Opt-outs: `--no-record` on the
   command, `daex apple auto-record off` for the lane (KV
   `apple.autoRecord.lane.<laneId>`), or Settings ▸ Apple Development "Record
   agent input" (`apple.autoRecordAgentInput`). Default on.
2. It stops at the end of the chat's turn or after 5 minutes. `record-start`
   during an auto recording converts it to manual. Manual recordings stop after
   5 minutes (`--max-seconds` for less), 2 minutes without input, or a nearly
   full disk (`stopReason`: `cap`, `idle`, `disk`).
3. The helper records raw MP4 (`<id>.raw.mp4`); at stop the service makes a demo
   at `<id>.mp4` ([Demo videos](../proof.md#demo-videos)). `--plain` files it as
   recorded.
4. Every recording and screenshot files itself as proof when it stops.
   Recordings live under `<projectRoot>/.ade/artifacts/apple-recordings/<laneId>/`
   and are never auto-deleted. An agent may `record-delete` only its own
   recording not marked proof (`APPLE_RECORDING_PINNED`).
5. The helper keeps one recording per device; the service one per lane. The
   helper is the truth: an orphaned helper recording is stopped, filed and
   restarted. Another lane's recording is `APPLE_DEVICE_ALREADY_RECORDING`.
6. A recording ends before its device goes away (stop, delete, takeover).
7. Overlays (tap rings, typed text) go in the saved file only; secure text is
   excluded.

### iPad windows

`daex apple window` (`ios_simulator.windowLayout`) lays out the front app's
window on an iPad in windowed mode (iPadOS 26+). No simctl call sets a window
frame, so DAEX works like a person: it reads the frame from the accessibility
tree (helper `WindowPlacement`, else SpringBoard's window-controls and resize
grabber elements), drags the grabber (`--size WxH`) or top strip (`--move X,Y`),
or opens the window's own menu (`--fill`, `--left`, `--right`, `--top`,
`--bottom`, `--split`, `--thirds`, `--quarters`, `--slide-over`). `applied` comes
from `judgeAppleWindowLayout` against the slots for the current orientation,
with 24 points of slack. The CLI exits 1 when the window did not land.
`APPLE_WINDOWING_UNAVAILABLE` means no window (iPhone, or Full Screen Apps) or
one DAEX cannot find. Elements the helper cannot place are marked `ADEUnplaced`
and `tap-element` refuses them.

## Live view

The helper encodes H.264 from the simulator's IOSurface. `stream-start` takes
`--fps`, `--scale-factor`, `--bitrate-kbps`. `getStreamStatus` reports shape,
fps, bitrate and `pointWidth`/`pointHeight` (the plane `tap` and `drag` take),
with `url`/`token` null; only `stream-start` returns those. Snapshot element
scale comes from the stream's point size when one runs, else from the device
type's `capabilities.plist` (`deviceTypeScreenScale`).

A hidden viewer stops its stream. A ~3 s stall shows Reconnect; first-frame
timeout is 5 s.

### Remote viewers and pacing

Phone, web and other desktops get the stream through `appleStreamRelay.ts`: a
single-use ticket over sync (`apple.streamTicket`, capture capped at
`apple.remoteBitrateKbpsCap`, default 2500 kb/s), then a WebSocket carrying the
helper's records. The ticket carries pixel and point size. A joiner gets the
cached config and keyframe, then no deltas until a fresh keyframe.

A viewer that sends `{t:"ack",n}` is paced (`appleStreamPacing.ts`): past
`APPLE_STREAM_LAG_BUDGET_MS` (250 ms) it stops getting deltas and resumes at a
keyframe. Stalls lower the lane's encoder cap to 60% (floor 400 kb/s) through
`capLiveStream`; calm periods raise it back. The relay sends `{t:"stats"}` about
once a second. Non-acking viewers get every record. See the "Apple stream relay"
row in [the performance baseline](../../perf/macos-baseline.md#brain-and-services).

Over the tunnel relay the Mac's config and keyframe can arrive before the
brain's `{t:"ready"}`; the relay buffers them (up to 4 MiB per pipe). The phone
redials transient closes up to three times; web and bound desktops ask for a new
stream up to three times, then show "Video stopped." with Reconnect.

### The phone: watch and control

The phone draws the stream on the **live stage** (`LiveStage.swift`): one view
at the window root, laid out full screen or over the Duo's tools pane, so moving
or folding never reconnects. Placement per posture is remembered
(`LiveStagePlacements`); Mac Desktop and App Control share the stage and its
quarter Turn (`liveStageQuarterTurn`).

- **Watching** is default. A tap opens the floating menu (Take control,
  keyboard, Home, hardware buttons, Turn, speed, Inspect, Placement, Reconnect,
  Close); holding the picture 0.6 s takes control.
- **Controlling** sends every touch to the simulator and defers system edge
  gestures. It ends on background, a lost picture, another chat's claim, a
  different device, a refused gesture, or 5 minutes idle. It is not offered when
  the host lacks `apple.input`/`apple.invoke` or point size, the device is not
  the lane's own, or another chat claimed it.
- **Fold mirroring.** An iPhone Duo controlling a Duo simulator folds it to the
  phone's hinge angle (`mirrorFold`, `setPosture` with `follow: true`, one in
  flight).
- **Input** follows `useAppleDeviceInput`: a fraction of the drawn picture,
  turned back, times the helper's point metrics from the stream config. With
  `liveTouch: true` the finger streams as `apple.input` `touch` begin/move/end
  (`AppleLiveTouchSender`), repeated every 500 ms while held. The host holds one
  finger per lane and lifts it after 4 s without updates.
- Host-side, `apple.input` stamps `source: "user"` (never starts auto-record)
  and drives only the lane's claimed device (`getClaimedDevice`); a lane with no
  device is `APPLE_NO_LANE_DEVICE`.
- A lane on another machine: `apple.*` routes by the lane's namespaced id, and
  the video socket uses **that** machine's address
  (`SyncService.appleStreamEndpoint`).

## Semantic actions

`findElement`, `tapElement`, `fillElement`, `waitForElement` and
`assertVisible` take `ref`, `identifier`, `label`, `text`, `role`, `index`, and
report `matchCount`.

| Tier | Source | Survives |
|---|---|---|
| `id:` | Accessibility identifier | Re-render and layout change |
| `component:` | DAEX Inspector component id | Re-render, not a rename |
| `label:` | Role, type, label, value | Re-render, not a copy change |
| `pos:` | Tree path | Nothing |

A `pos:` ref is a warning; ask for an accessibility identifier. With several
matches: screen-read before inferred, app layer before accessibility layer,
controls before their text, then snapshot order; the answer names the `--index`
for the next.

- `fill-element` reads the field back with one `ax-hit` and answers `typed`:
  `verified`, `not-seen` or `unknown`.
- When a Tab Bar exposes no items, tab slices are inferred from the lane's
  SwiftUI `TabView` sources (`metadata.synthetic`, shown `(inferred)`), and
  `tap-element` refuses them with the point to tap.
- The helper's walk stops at 500 elements, depth 80, 600 grid probes
  (`truncated: true`).
- A miss names the closest match's field and the flag that queries it.

Snapshot and inspect use the helper's accessibility tree with the DEBUG DAEX
Inspector kit as overlay: [inspector.md](./inspector.md).

## Event log and proof bundles

`startEventLog` runs `simctl spawn <udid> log stream` for a required
`bundleId`, matching the subsystem or the app's executable (`--subsystem`,
`--process` override; quotes and backslashes are refused). After 8 s with no
app row the page carries a `hint`; `print()` never reaches the log. Lane device
only.

`captureProofBundle` writes `screen.png`, `metadata.json`, `elements.json`,
`log.json` (default `<buildRoot>/.ade/proof/ios-sim-<stamp>/`) and pins the
active recording.

## Troubleshooting

| State | What to do |
|---|---|
| No installed simulator | Xcode ▸ Settings ▸ Components. DAEX never downloads one. |
| `APPLE_HELPER_UNAVAILABLE` | Helper missing (the message lists where DAEX looked) or speaks another protocol. Reinstall or update DAEX on that Mac. |
| `APPLE_DEVICE_OFF` | Watching never boots; run `daex apple start`. |
| `APPLE_DEVICE_ATTACHED_NOT_DELETABLE` | `device-delete --force` detaches; it never deletes the user's simulator. |
| `APPLE_EXTRA_DEVICE_LIMIT` | `device-delete --device <udid>` an extra first. |
| `IOS_SIMULATOR_OWNED_BY_OTHER_SESSION` | Ask, then `shutdown --force` / `open-device --force` / `claim --ignore-ownership`. |
| `IOS_SIMULATOR_TARGET_ROOT_MISMATCH` | Re-run `daex apple apps --text`. |
| `IOS_SIMULATOR_LAUNCH_IN_PROGRESS` | Wait, or `daex apple shutdown --force --text`. |
| Disk full of simulators | Picker ▸ **Clean up**, or `daex apple device-cleanup --power-off-idle`. |
| Several agents on one device | Take turns with `daex apple lease`. |
