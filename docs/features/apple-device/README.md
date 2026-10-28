# Apple device

ADE drives a per-lane Apple simulator from the Work tab's Apple Development tool and from
`ade apple`. It makes a new device for the lane (or attaches one the user names), builds and launches
the selected app, streams the device framebuffer through a vendored Swift
helper, and turns gestures into simulator input or context items for the
active chat. Agent launches stay in the background.

The feature is macOS-only. `xcrun` and `xcodebuild` must be available on the
runtime host. Frames and input go through `ade-sim-helper` (CoreSimulator /
SimulatorKit). There is no idb, no Screen Recording grant, and no
Simulator.app window. Creating a device never downloads anything; a runtime is
downloaded only when the person asks, from the Runtimes section (see below).

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

When a desktop simulator request is interrupted by a project switch, the error
names the requested action and explains that the active project changed or is
still loading. Wait for loading to finish, return to the simulator's project,
and retry. If the error persists, close and reopen that project tab. ADE keeps
the project-routing guard in place so a request cannot target the wrong project.
Requests started on a loaded project retain that project's runtime until they
finish. Live-view cleanup captures the runtime when it acquires the stream,
so switching tabs does not redirect cleanup or discard a successful shutdown
or recording stop. Ordinary Work tools keep the unpinned route on the tab's
own machine, so their lane list continues to use the loaded project lanes.

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
instead `device-attach` an installed simulator the user names. A model named
with no runtime gets the newest installed runtime that runs it: iOS 27.1 runs
only the iPhone Duo, so `--device-type "iPad Pro 11-inch (M5)"` lands on 27.0.

### Extra devices

A lane may hold up to two EXTRA devices beside its own
(`APPLE_LANE_EXTRA_DEVICE_LIMIT`), for a second model in the same piece of work:
an iPad next to an iPhone Duo. `device-create --extra` makes one (an empty ADE
device named `ADE · <lane> · <model>`) and boots it. Extras are their own
local-only table, `lane_apple_extra_devices` (keyed by udid), and their marker
says `extra: true`, so a lost row is re-adopted as an extra, never as the lane's
own device. They are reached only by name: `--device <udid|name>` on any command
an agent may send runs that command on the extra (booted first, and its use
noted for idle power-off); without `--device` everything still drives the lane's
own device, and the pane never streams an extra. `boot --device <udid>` boots one
and answers `Booted` only after `simctl` lists it so, after `bootstatus`. The
cleanup pass treats them as
held, idle power-off turns them off like any ADE device, and the lane's end
(archive or delete) deletes them with the lane's own. `device-delete --device
<udid>` deletes one now. The picker lists them with the held devices, never as
free, and `device-attach` refuses one (`APPLE_DEVICE_IS_EXTRA`).

An extra never streams, records, `launch`es or runs tests: those are the
lane's device. To put the lane's app on an extra, `ade apple install --device
<udid|name> [--launch] [--configuration X] [--target id] [--no-build]`
(`ios_simulator.installApp`) builds once into the lane's DerivedData (an
incremental build, so the lane's last build is reused; `--no-build` installs it
as is), installs with `simctl install`, and with `--launch` starts it. Nothing of
the lane device's session, stream, claim or launch state is touched. One
xcodebuild runs at a time in a lane's DerivedData: an install is refused while a
launch, a test run or another install builds there (`APPLE_BUILD_BUSY`), and a
launch or test run is refused while an install builds. It is an action of the
`ios_simulator` domain with the lane's pin, so it runs on the lane's machine.
`ade apple device-promote --device <udid|name>`
(`ios_simulator.devicePromote`) makes an extra the lane's own device, keeping
what is installed and signed in on it, for the case where the extra already has
the build. The swap runs in the lane's lifecycle queue and is refused with
`APPLE_LANE_DEVICE_BUSY` while the old device is streaming, recording, running
tests or a launch, or while another chat holds the lane's lease. The old device
is kept: an ADE device becomes an extra in the promoted one's slot, and an
attached simulator is detached back to the user. Every path that refuses an
extra prints the promote verb, and a refused `launch` also prints the
`install --device … --launch` that does the build.

### Device leases

One agent should drive a device: it does the taps, screenshots and
recordings, and other agents hand it work or wait for its results. When agents
truly must drive one device in parallel, they take turns with
`ade apple lease` (`ios_simulator.deviceLease`, `appleDeviceLease.ts`).

- Each device has its own line: the lane's device, and each extra with
  `--device`. A lease waits up to `--wait` seconds (max 540) and lasts `--ttl`
  (default 10 minutes) unless renewed.
- The token is the turn. Only it renews (`lease --token`) or releases
  (`lease release --token`); a call without it queues, even from the same
  chat. Status and busy answers name the holder, never the token. A release
  finds the token on any of the lane's devices; one that holds nothing exits 1.
- It is advisory. Device commands neither check nor renew it, and the pane is
  never blocked. Another chat's lease on the lane's device does refuse
  `device-promote` (`APPLE_LANE_DEVICE_BUSY`).
- A lease ends early when its chat is archived or deleted. A waiting call whose
  connection closes (the CLI was killed) leaves the line. Leases live in the
  brain's memory, so a restart ends them.
- A current CLI talking to an older brain (one lease per lane, renewal by
  holder name) never reports a shared or wrong-device lease as a turn: it
  exits 1 and says to update the brain.
- `--machine` sends the call to the lane's machine; the token is that
  machine's.

### Runtimes and Xcode

`appleRuntimeManager.ts` owns the machine's simulator runtimes, reached as
`ios_simulator.runtime*` actions with the lane's pin (so a laptop manages the
desktop's runtimes). There is one download per machine: every open project's
manager shares the install and hears its progress, and a window with no event
stream (the web client) re-reads the list while an install is quiet. Where a
simulator moves when its runtime goes, and which runtime Install & create
builds on, is one rule (`shared/appleRuntimeVersions.ts`): the newest runtime
that runs that model.

- `runtimeList`: every installed runtime with its size (`simctl runtime list`),
  the simulators on it (ADE's or the person's), `newest`, and `superseded` — a
  newer runtime runs every *current* model it runs and every model one of its
  simulators uses. Retired models (their max runtime is below this Xcode's SDK)
  never keep a runtime around. Point releases can be narrow: iOS 27.1 runs only
  the iPhone Duo, so iOS 27.0 stays the newest runtime for every other iPhone.
  `missing` lists current iPhone and iPad models no installed runtime runs,
  grouped by the runtime they need (`missing.runtimes`, `name` joins them):
  a model new in the SDK's release (the Duo) needs the SDK's version; a model
  that an installed point release of the SDK's major does not run (iOS 27.1
  runs only the Duo) needs the major's base release, iOS 27.0, pinned
  (`installVersion`); anything else is named by the SDK version and left to
  Xcode. The Create control offers them as `<name> · Not installed` with
  **Install & create**, which pins the version the picked model needs.
- `runtimeInstall`: `xcodebuild -downloadPlatform iOS` as a background job
  (checks ~10 GB free first, cancellable, `apple.runtime.install` progress
  events). Without a version Xcode fetches every runtime it needs; `--version`
  pins `-buildVersion`. A pinned iOS version that is already installed is
  refused up front (`APPLE_RUNTIME_ALREADY_INSTALLED`, before any install
  state changes), naming what it runs and the version the missing models need;
  xcodebuild alone answered "already downloaded" and nothing else.
- `runtimeDelete` / `runtimePrune` (user-only): lane devices move to the newest
  runtime that runs their model (`simctl upgrade`); the person's own simulators
  move or are erased as they choose in the confirmation; then
  `simctl runtime delete`. The panel re-reads until the runtime is gone
  (CoreSimulator unmounts it a moment after the command returns).
- The Xcode note: `xcodebuild -version`, `-checkFirstLaunchStatus` (with **Run
  setup**, user-only `xcodeRunFirstLaunch`), and Apple's releases RSS read at
  most once a day per machine (betas hidden).

CLI: `ade apple runtimes [list|install [--version x.y]|cancel]`. Removing is the
person's call, from the panel.

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
- Another project's marked devices are checked in THAT project's `ade.db`,
  read-only. While a live lane there holds the device, or the database cannot
  be read, it is left alone. When that project no longer uses it, or the
  project (or its database) is gone, it is a stale leftover and is deleted
  like one of ours. Devices start empty, so a project that was only moved
  loses nothing that matters: its lane gets a new device on its next ask.
- A project that moved is followed first. A move rewrites the markers, but
  one it missed still names the old folder. Before such a device counts as
  "project gone", the pass follows the old folder's `.ade/moved-to.json`, or
  the machine's move journal (`<ADE_HOME>/project-moves/`), to where the
  project went, up to five moves, and asks that project's database. When the
  move ends at this project, the device is this project's, as if the marker
  named it. The current project's own rows are read before every delete.

`device-detach` of an ADE device stamps the marker `detachedAt`. The device is
then a leftover: it is never re-adopted, and the first pass after the 5-minute
grace deletes it (so within about 20 minutes) unless a lane attaches it again.
The detach answer carries `deletesAfter` (detach time plus the grace), and
`device-detach --text` says when, and how to keep it.

A detach with `keep` (`device-detach --keep`, or the box in the desktop's
release confirmation) stamps the marker `keptAt` instead of `detachedAt`. The
pass skips a kept device entirely: it is never deleted and never re-adopted.
Leaving the marker unstamped would not do, because the pass gives an
unstamped marker of a live lane back to that lane as a lost row. A kept device
is `ade-kept` in the picker's ownership read ("Kept"), not a leftover, so
Clean up does not count it. Attaching it again rewrites the marker without
`keptAt`, and it is an ADE device of that lane again. It stays until a lane
takes it or the person deletes it from the picker. Agents pass `--keep` only
when the user asked.

Every desktop path that gives up an ADE-made device says so first (one
helper, `confirmAppleDeviceRelease`, a `checkboxConfirmDialog`): the tools
card's Release device… and the pane's "Choose another device" on an off
device. The confirm says ADE deletes it, with its apps and data, in about
5 minutes unless a lane picks it again, and offers "Keep it as a free
simulator instead". A simulator the user attached is released in one click,
as before, since it stays installed. The rail's "Switch device…" deletes an
ADE device at once; its confirm now says so ("Delete <name> and pick
another?"). The picker shows a released ADE device as "Deletes in N min"
(from `ownership.deletesAfter`, counted down on the shared 30-second ticker),
and starting it takes it back for the lane. The web client runs the same
components through its adapter, with the lane's pin. The phone has no release
or delete path for Apple devices (it reads status, streams, and sends input). Attaching this project's marked
device (the picker, or an agent for a leftover) makes it that lane's ADE device
again (`origin: created`) and rewrites the marker. Another project's ADE device
follows the same check: while that project uses it, nobody here may attach it
(user or agent, `APPLE_DEVICE_NOT_LANE_OWNED`); once it is stale, attaching
takes it over as this lane's ADE device, with the marker rewritten to this
project, so it is deleted when this lane ends. Detaching an ATTACHED device uninstalls the
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
grows on the same disk the devices use. The device is idle since the latest of
these, so use outside ADE counts too: a device `simctl` lists as `Booting` is
never idle (its clock restarts), CoreSimulator's own last-boot time
(`lastBootedAt`, `lastUsedAt` on Xcode 27) covers a raw `simctl boot`, and the
mtime of the device's `data/Containers/Bundle/Application` folder covers a raw
`simctl install`. "Touched" is the mtime of
`<device dir>/ade-last-activity`, written (at most once a minute) whenever a call
resolves the lane, including the pane's status poll while it is on screen, and on
every tick while this process streams, records, tests or launches on the device.
It is a file, not memory, so the desktop and the brain see each other's use. A
running `xcodebuild`, `simctl` or `xctest` that names the device by udid or
`name=` also counts. While Simulator.app is running, nothing is powered off: a
person may be driving a device in its window, which leaves no trace ADE can
read. The power-off names the udid the pass checked. Attached devices are never
powered off by the timer.

The pass also records WHY it powered a device off, in
`<device dir>/ade-powered-off` (`at`, `reason` — `idle` or a Clean up — and the
idle minutes). The next command that boots the device, `ade apple status` and
`device-list` then say so: `ADE powered iPad Air 11 off after 31 min idle at
10:12; the next --device command boots it again.` without it, an agent found its
device off and blamed its own last command. The record is cleared when ADE boots
the device again and ignored while `simctl` lists it Booted; a record from an
earlier day carries its date. Every call that names an extra counts as use,
reads included (`--device` on `screenshot`, `snapshot`, `tap`, …), so the timer
cannot power off a device an agent is reading.

### Tests

`ade apple test` (`runTests`) runs `xcodebuild test` on the lane's device with
`-parallel-testing-enabled NO`, DerivedData in the lane's cache, and a result
bundle under `.ade/cache/ios-simulator/test-results` (the newest three kept).
Output streams to `.ade/cache/ios-simulator/test-logs/<stamp>.log`. One run at a
time per ADE runtime (`APPLE_TEST_RUN_BUSY`), claimed before the device boots. A failing test resolves with
`passed: false`, the failing lines and the log path. Default timeout 30 minutes,
at most 2 hours. `testsExecuted`, `testsFailed` and `testsSkipped` come from the
run-wide `Executed N tests, with K tests skipped and M failures` line — the one
under `Test Suite 'All tests'`/`'Selected tests'`, not the last per-suite line,
which is why a 1,273-test run no longer reported the 48 of its last suite.
Swift Testing's `Test run with N tests … passed|failed` lines are added to that
(one per test process; a bundle with both frameworks prints both), with its
`Test X failed after` and `Test X skipped` lines as the failed and skipped
counts. `failures` lists each failing test once, in log order, as `{test,
file, line, message}`: XCTest's `file:line: error: -[Mod.Class testX] : msg`
becomes `Mod/Class/testX` (what `-only-testing` takes), Swift Testing's
`Test name() recorded an issue at File.swift:6:40: msg` keeps the test's name,
and a test with several issues joins their messages. `ade apple test --text`
prints the counts, that list, xcodebuild's failure lines verbatim, and the log
and result bundle paths (it used to squash them into one 96-character cell).

Before xcodebuild runs (tests and `launch` builds alike), package state in the
lane's DerivedData that names another folder is dropped
(`healMovedDerivedData`): `SourcePackages/workspace-state.json` when a path in
it points into another DerivedData's `SourcePackages` or outside this
DerivedData and the worktree and no longer exists, and `info.plist` when its
`WorkspacePath` is outside the worktree. Paths compare as real paths (`/tmp`
is `/private/tmp`). Checkouts, artifacts and build products stay, so the build
re-resolves without fetching everything. A project move no longer copies
`.ade/cache/ios-simulator/DerivedData` at all (the main checkout's and each
lane's; the size check leaves it out too), so this is for DerivedData copied
before that, or by hand.

The verbs that end a lane's hold on its device live in
`laneDeviceLifecycle.ts`. Each one tears down the recording, the stream, the
chat claim and the hub session in the same order.

- `device-detach` (`deviceDetach`) gives up the lane's device. Nothing is
  deleted now, and the power state is unchanged. A simulator the user
  attached stays installed and shows as free in the picker. A device ADE made
  is a leftover the cleanup pass deletes after its grace (see the marker
  section) unless a lane attaches it again; the answer's `deletesAfter` and
  the `--text` sentence say so. Agents may call it.
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
- When the lane gave up its device (`device-detach`, the pane's "Choose
  another device", the tools card's Release) and that simulator is still
  installed and free, `launch`, `open-device`, `test` and every other driving
  verb, and an agent's `start` without `--udid`, refuse with
  `APPLE_LANE_DEVICE_RELEASED` (`AppleLaneDeviceReleasedError`) instead of
  making a new, empty device. The message names the device, who released it (an agent or the
  pane) and the `device-attach --simulator <udid>` that takes it back. The
  release is remembered by the brain that ran it, until the lane holds a
  device again. `apple.lane_device_detached` logs `by: agent | user`.
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
- Until the lane's device list has answered once, the pane does not show the
  picker: it shows "Loading simulators…", or an inline error banner with the
  reason and **Retry** when the read failed, never the "No Apple simulators are
  installed." card. A read that met a project switch is read again once the
  switch is over.
- The **tools card** names the lane's device and its power state
  (`{name} · Running | Starting | Shut down`) and carries a corner menu that
  boots, opens, releases, or — for an ADE device only — deletes the device
  without opening the pane. Releasing a device with a live session confirms
  first. The mark beside each lane in the Work session list is green while the
  device is booted and muted while it is claimed but off.

### Foldable ("Duo") mode

Validated on the iPhone Duo simulator (Xcode 27.1, iOS 27.1). The gate is
`appleDeviceSupportsDuo` on the CoreSimulator type identifier
(`com.apple.CoreSimulator.SimDeviceType.iPhone-Duo`); the lane device's display
name is never an input.

**Folding.** The helper vendors serve-sim's CoreDevice shim (see
`native/ADESimHelper/.../Vendor/serve-sim/VENDORED.md`): Device Hub's own
`HIDVendorDefined` send (usage page `0xFF61`, usage `0x5B`, an
IOCFSerialize'd `{provider, source: hinge-slider-control|orientation-picker-control, type, value}`)
reaching `dtuhidd` in the guest. ADE's `DevicePosture.swift` adds the
`posture` and `posture-get` commands, and streaming a Duo starts its posture watcher (`posture-changed`). Folds **sweep** in 10°
steps: SpringBoard's fold state machine can stick on a 0°↔180° jump, leaving
the wrong panel lit. A raw angle releases Tent's Table Mode and stands a
face-down phone up. Service: `setPosture` / `getPosture`, events
`apple.device.posture`; CLI `ade apple fold <pose>|--angle N|--sequence a,b,c`
and `ade apple posture`.

**Panels.** Screen 1 is the cover (1398×2034), screen 3 the inner display
(2007×2853, mounted a quarter turn from its framebuffer). Capture follows the
panel CoreDevice reports active (an ADE patch to the vendored `FrameCapture`);
the service republishes the stream's pixel and point sizes on each switch, and
a restarted capture re-applies the panel. Input on a Duo goes through
CoreDevice's digitizer and keyboard services to touchscreen `0x100 + screenId`:
the legacy Indigo inner target is disconnected and can abort `backboardd`.
Both views draw the live panel the way the guest says its picture sits
(the posture's `displayOrientation`, from CoreDevice's display list), so a
panel turned by the phone or kept by an app is drawn upright either way;
`APPLE_DUO_INNER_ORIENTATION` (a quarter turn on) is only the fallback.

**Turning.** The legacy GSEvent rotation never reaches the Duo's inner panel,
so on a hinged device the helper's `orientation` command sends CoreDevice's
`orientation-picker-control` instead (leaving Tent's Table Mode first). Held
`portrait` the inner picture is landscape; the inner display takes all four
orientations, the cover's Home Screen only portrait. `rotate` on a Duo is
verified from the guest's report of the live panel, not the framebuffer read
the rigid path uses (that always names the cover, and the inner panel's
framebuffer never changes shape); the answer carries the posture. When the
picture has not turned by the settle deadline, the turn is sent once more and
waited for again (`apple.rotate_resent`): right after a fold the guest can drop
it. The rail's
orientation control shows how the phone is held (CoreDevice names the
device's orientation, the control the interface's, so the landscapes swap).
The posture watcher also reports a change of the live panel's turn.

A fold to a preset settles on the panel AND the picture: book, laptop and open
all light the inner panel, so a panel-only check returned while the picture was
still turning and printed the old shape (`fold` said wide for a tall laptop).
`fold` now waits for the expected shape (`laptop` tall, `book`/`open` wide), or
for two equal reads on a pose whose hold it cannot predict (cover poses and raw
angles), and it never waits past the settle deadline.

The orientation names are how the PHONE is held, so on the inner display they
read backwards to anyone who means the picture: held portrait (open, book) the
picture is wide (2853x2007), held landscape (laptop) it is tall (2007x2853).
The CLI's `rotate`, `fold` and `posture` print `picture inner display,
tall|wide` (`appleDuoPictureShape`), `held` in `rotate`'s names rather than
CoreDevice's swapped ones, and a note when the hold asked for gives the
opposite shape. A raw `fold --angle` keeps the hold, so `fold laptop` then
`fold --angle 180` is the tall, flat-open screen.

**Accessibility.** The guest answers hit-tests only on the display that is on:
the inner panel is display 3, and a grid probe sent to display 0 there finds
nothing, which left `snapshot` and `tap-element` with only what the tree walk
reaches (no sidebar rows, no toolbar items hidden in groups). The helper's
`ax-describe` asks the live panel's display (`DevicePosture.accessibilityDisplay`)
and turns each grid point by that panel's picture turn before its coverage
check, because the probe space is the app frame while element frames are the
picture's (measured on the iPhone Duo, iOS 27.1; see `VENDORED.md`).

**3D.** Apple's own `V68.usdz` is read from the owning machine's Xcode
(`getDuoModel`, never bundled) and parsed by serve-sim's vendored loader
(`renderer/components/apple/vendor/serve-sim`). `appleV68DuoBody.ts` is a
*physical* body: each panel maps its framebuffer itself, the live stream goes to
the panel that is on, the closed phone turns its cover to the camera, landscape
poses (laptop) turn the phone, and the camera refits on each fold. It also
stands the way the pose sits on a table (`appleDuoStandTilt`): held sideways
and folded, the lower half lies flat and the screen stands, seen from a
little above (fading in from flat to 120° so a hinge drag moves smoothly); a
tent stands hinge up with the cover facing out, also from a little above.
Picking a preset resets the view to that framing. Taps send the
live panel's framebuffer point. The drawn body (`appleDuoScene.ts`) remains the
fallback when the model is missing.

**Controls.** The Duo's own dock (`AppleDuoDock`) is a band under the device,
outside the rail and never over the picture, shown only for a foldable. Left,
**Hinge** in 3D: a continuous slider that previews on drag and folds on
release (detent labels hide in a narrow pane); in flat, where there is no
body to fold, **Screen**: Cover folds the phone shut, Inner unfolds it flat,
both by angle, keeping how it is held. Right, **Orientation**: the four ways
to hold the phone, each drawn as the screen it gives (the inner panel runs
wide with the phone upright), the pressed one being how the simulator says it
is held. A quiet
readout (angle, live screen, wide or tall) follows when the pane is wide. On a
Duo the rail drops its Orientation menu; every other device keeps it. A turn
the app on screen does not follow (`APPLE_ROTATE_NOT_ADOPTED`) is an info
toast, not the error strip, on every device. The angle alone
cannot tell Laptop from Book (both 90°); how the phone is held does, so the
menu's checked posture comes from the angle, the held orientation and Table
Mode (`appleDuoStanceFor`); a phone lying face down counts as Tent, since
nothing else lays it down. A helper that did not set the pose itself reads
how the phone is held from CoreDevice's device-state stream, always releases
Table Mode before a turn, and stands a face-down phone up before a raw angle.
The posture hook reads once more 1.5 s after a first read that does not know
how the phone is held. The rail's Duo menu: presets (Open, Laptop, Book,
Tent, Closed), ±15° steps, and **App Store screenshots** (both
panels at App Store Connect's sizes, filed as proof; `ade apple
app-store-shots`). A drag on the slider settles on Closed, Laptop and Open
within 4°; arrow keys stay exact. The slider is the one source of the hinge
angle: the drawn body is that angle alone (every pose folds both halves the
same way), an orientation press never moves it, and a device report within 2°
(`appleDuoSameHinge`) changes nothing. A release anywhere ends the drag (the
window hears it, off the slider or off the window). A fold that fails puts the
slider back to the device's own angle. The 3D body eases into every pose (hinge,
the landscape turn, the half turn that shows the cover) and the camera eases
to each new fit; while ADE's own fold sweeps (up to 8 s), the simulator's
intermediate reports are held off so the hinge does not jump back. A drag on
the 3D view leaves the device where it was let go; Reset view brings back the
rest pose, and so does an orientation press (also the one already pressed,
which sends the turn again) or a slider release on Closed, Laptop or Open. ⌥[ and ⌥] fold and unfold by the step. A
fold to closed or open reports its posture once the guest has switched panels.
The floating player reads the posture too, so it draws the inner panel upright
and follows folds. Screenshots of a foldable (more than one integrated panel in
`simctl io enumerate`) capture the live panel with `--display`. A device whose
type folds (`appleDeviceTypeSupportsDuo`, shared with the renderer) is never
cached as rigid: a posture read that fails or names no panel right after a
fold is read again (3 times, 250 ms apart), then answered from the last panel
the device or the posture watcher named, or the panel the fold aimed at.
`frame` follows a panel switch the watcher has not applied yet and waits up
to 4 s for the first frame, so a frame right after a fold no longer fails at
one second.

**Apple's Duo skill.** The Duo menu's **Add Apple's Duo skill to this lane**
(`addDuoSkill`, `ade apple duo-skill`) exports Xcode's agent skills
(`xcrun agent skills export`) and copies `app-resizability` into the lane's
`.agents/skills`; a lane that has it keeps its copy. Tested before shipping: an
ADE agent (GPT-6 Luna) following it took a legacy UIKit sample that did not
launch on the iOS 27 SDK (no scene life cycle) and laid itself out from
`UIScreen.main`, to one that refilled the cover (3 columns, 382 pt) and the
inner panel (5 columns, 867 pt) across folds without relaunching. The skill
asks once whether the scene manifest goes in Info.plist or code. Xcode's other
Duo skill, `device-interaction`, drives Xcode's own MCP tools, so ADE leaves it
out: `ade apple` covers the same ground.

### 3D renders

The rail's **Render** sheet renders the live 3D body: Front, ¾ left, ¾ right or
the current camera; Transparent, Studio or Dusk; a contact shadow; a labelled
contact sheet; a 6 s WebM turntable. For a Duo each chosen pose folds the real
simulator (`setPosture` answers once it has landed on the pose's panel) before
the shot. Each image and the video go to `attachRenderProof` on the device's
own machine, which files them to the chat's and lane's proof drawer there, so a
window pinned to another machine files where the chat lives. The answer names
that chat and the file, so the toast says where the renders went ("this
chat's proof drawer", the chat that holds the device, or the lane's proof)
with **Open proof** (when it is the chat on screen) and, on the device's own
machine, **Show in Finder**. `ade apple render` prints a `cite:` line per
proof: the service credits each render filed for the lane while the request
is open to it.

`ade apple render` asks for the same thing from the CLI, and needs no pane:
only an ADE desktop window with the project open, on the device's machine or
bound to it (a project on another machine must be that window's front tab: a
parked remote tab does not hear the request). The service emits `apple.render.request` (with the asking chat)
to every such window, and the first `renderAck` takes the job:

- A live Apple pane for the lane acks at once (a pane whose video stalled
  reconnects first) and renders in its own 3D view, as before.
- Otherwise every project surface's `AppleRenderHost` waits 1.5 s, so a pane
  anywhere wins, then acks with that surface's own binding as the pin (an ack
  only succeeds on the machine that asked). The winner loads
  `AppleRenderHostJob` on demand, reads the lane's device, streams it into a
  3D view mounted far off screen (absolute, left of the page, no pointer
  events, not focusable; never `display: none`, which stops WebGL), renders
  through the pane's own `renderAppleDeviceToProof`, and unmounts, which hands
  the stream lease back. Idle, the host is one event callback: no stream, no
  WebGL, no timer.

Either way the job answers `renderComplete` with the count filed or the
reason it failed (the lane has no device, the device is off, the picture never
came up, the window closed mid-render). The host never boots a device. No ack
within 7.5 s means no desktop window took it, and the error says so:
rendering needs a desktop renderer.

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
| `apps/desktop/src/main/services/ios/appleStreamPacing.ts` | Per-viewer pacing from acks and the lane's adaptive encoder cap. |
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
| `apps/desktop/src/main/services/ios/appleDeviceLease.ts` | `ade apple lease`: the advisory, queued, expiring turn on a lane's device for agents that share it. |
| `apps/desktop/src/main/services/ios/appleDuoService.ts` | The Duo's own service surface: fold and settle, posture, the live panel for screenshots, Apple's model and agent skill, the App Store set, render proofs and the `ade apple render` broker. |
| `apps/desktop/src/shared/appleOrientation.ts` | Orientation facts the service and the pane share: an orientation's axis, the Duo's screen names, the inner panel's quarter turn, CoreDevice's pose names, and Tent. |
| `apps/desktop/src/renderer/components/apple/useAppleDuoPosture.ts`, `AppleDuoDock.tsx`, `appleV68DuoBody.ts` | The simulator's reported posture and the fold call (pane and floating player), the Duo's dock under the device (hinge or screen, and turn), and Apple's physical Duo body. |
| `apps/desktop/src/renderer/components/apple/appleDuo.ts`, `appleDuoScene.ts` | The foldable "Duo" mode: the pure posture state machine, panel rotations, inner-display coordinate mapping and capability matcher, plus the procedural two-panel body builder. Capability-gated; unused on non-foldable devices. |
| `apps/desktop/src/renderer/components/apple/AppleDevicePicker.tsx`, `applePickerInventory.ts` | The picker and its grouping (this lane's device, free devices, devices another lane holds), the Create control (runtime and model), and the Storage section (total size, Leftover / Old ADE? tags, Clean up). |
| `apps/desktop/src/renderer/components/apple/useLaneAppleDevices.ts`, `LaneAppleDeviceMarker.tsx` | The Apple mark beside each lane in the Work session list that holds a device; green while booted, muted while claimed but off. |
| `apps/desktop/src/renderer/components/apple/AppleToolCardMenu.tsx`, `useAppleLaneDeviceCard.ts` | The Work tools picker card's claim state and its corner menu (boot / open / release / delete). |
| `apps/desktop/src/renderer/components/apple/DangerConfirmMenuItem.tsx` | The shared two-row destructive menu item (a disabled idle row plus a confirmation row) used by the card menu and the device picker. |
| `apps/desktop/src/renderer/components/apple/AppleDeviceMiniPlayer.tsx`, `appleMiniPlayerStore.ts` | The floating device player over the chat. |
| `apps/desktop/src/renderer/components/apple/AppleRenderHost.tsx`, `AppleRenderHostJob.tsx`, `useAppleRenderRequests.ts` | `ade apple render`: the pane's render and broker handshake, the shared render body, and the per-project host that renders off screen when no pane takes the request. |
| `apps/ade-cli/src/cli.ts` | `ade apple` typed commands. `ade ios-sim` is the deprecated alias. |
| `apps/ade-cli/src/help/appleHelp.ts` | Help text for each `ade apple` subcommand, and the help aliases. |
| `apps/ade-cli/src/services/sync/appleRemoteCommands.ts` | `apple.*` remote commands for the phone and the web client, including `apple.invoke`. |
| `apps/ade-cli/src/services/workTools/workToolShowRequests.ts` | `ade apple show` / `ade ui show` on the brain side. |
| `apps/desktop/resources/agent-skills/ade-apple/SKILL.md` | Agent skill for the verbs below. |
| `apps/ios/ADE/Views/Work/AppleDeviceViewer.swift`, `AppleDeviceViewerModel.swift` | The phone's full-screen viewer (View only / Control, the speed readout) and the model that owns its ticket, socket, decoder and mode. |
| `apps/ios/ADE/Views/Work/AppleDeviceControl.swift` | The phone's touch mapping, gesture rule, input commands, Control blockers and the tap→screen probe. |
| `apps/ios/ADE/Views/Work/AppleDeviceStream.swift` | The phone's ticket, record parser, health clock, decoder layer and the acking stream socket. |
| `apps/ios/ADE/Services/SyncService+AppleDevice.swift` | The phone's `apple.*` calls, asked of the machine that owns the lane. |
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
ade --socket apple device-promote --device <udid|name> [--ignore-ownership] --text
ade --socket apple device-list [--installed] [--runtimes] [--disk] [--lane <lane-id>] --text
ade --socket apple device-delete [--force] --text
ade --socket apple device-cleanup [--power-off-idle] --text
ade --socket apple test [--target <id>|--scheme <s>] [--only <ids>] [--build-only] --text

ade --socket apple record-start [--overlays on|off] [--label <text>] [--plain] [--max-seconds <n>] --text
ade --socket apple record-stop [--keep|--discard] --text
ade --socket apple record-list --text
ade --socket apple record-delete --id <id> --text

ade --socket apple start [--udid <udid>|--runtime <r> --device-type <t>|--create <sourceUdid>] --text
ade --socket apple stop [--force] --text
ade --socket apple device-detach [--force] --text
ade --socket apple show [--floating] --text
ade --socket apple scroll down [--anchor-x <x> --anchor-y <y>] [--amount <n>] --text
ade --socket apple foreground [--wait <seconds>] --text
ade --socket apple screenshot [--out <path>] [--no-proof] --text
ade --socket apple launch [--configuration <name>] [--launch-arg=<v>] [-- <app args>] --text
ade --socket apple relaunch --bundle-id <id> [-- <app args>] --text
ade --socket apple lease [--device <id>] [--wait <s>] [--ttl <s>] [--holder <name>] [--token <t>] --text
ade --socket apple lease release --token <t> --text
ade --socket apple lease status [--device <id>] --text
ade --socket apple install [--device <id>] [--launch] [--configuration <c>] [--target <id>] [--no-build] --text [-- <app args>]
ade --socket apple window [--size WxH|--fill|--left|--right|--top|--bottom|--split|--thirds|--quarters|--slide-over] [--device <id>] --text
ade --socket apple auto-record [on|off] --text

ade --socket apple frame [--out <path>] --text
ade --socket apple button home --text
ade --socket apple rotate landscape-left --text

ade --socket apple type "reddit" --submit --text
ade --socket apple key return --text
```

`screenshot` reads no accessibility tree, so it prints no `elements` line
(`snapshot` does). It files the shot as proof and prints its `cite:` line; a later
`proof attach` of the same bytes is refused as `PROOF_DUPLICATE` and that
refusal names the earlier proof's `cite:` line. `--no-proof` takes a scratch
shot that files nothing, for a validation loop. `--out <path>` resolves
against the caller's directory, and the CLI copies the shot there, so any path
the caller can write (`/tmp` included) works; on a brain on another machine it
says the file stayed there.

`snapshot --text` lists every element with its `ref`, role, label and frame
(device points). The `ref` comes from the identifier, else the label, so it is
the same in the next snapshot; `tap-element --ref` takes it, and also the tree
`id` (`accessibility:0.1.2`), which moves with the layout. `--label` matches
the whole label first. With no exact match, `find-element`, `tap-element` and
`fill` take the one label that starts with those words ("Work" finds "Work, 3
need you"); two such labels are no match, and `wait` and `assert-visible` take
exact labels only. `--contains` is `--text` without the
clash with the `--text` output flag.

A tap's touch-down and touch-up, and a drag's steps, go to the helper as one
block (`sendGesture`): a `snapshot` from another caller can no longer run
between them and turn a tap into a long press, or a slow drag into a tap.
`drag`, `swipe` and `scroll` answer with their own `action`.

`launch` builds `Debug` unless `--configuration` names another (an app whose
Debug and Release reach different backends needs the one under test), and
says which it built. Everything after `--` goes to the app as launch
arguments, for `launch` and `relaunch` alike (`--launch-arg=<v>` adds one at a
time; the `=` lets a value start with a dash).

`foreground --wait` keeps asking for up to that many seconds (default 10,
max 30) until an app is in front: right after a launch the accessibility tree
still names none.

`lease` is a turn on one of the lane's devices for agents that share it (a
coordinator and its subagents). Each device has its own: the lane's device
under the lane's key (it follows the device the lane holds), each extra under
its udid (`--device`). It queues: `--wait` stands in line, `release` hands the
device to the next holder, and a lease nobody renews lapses after `--ttl`. The
token is the turn. Subagents of one chat share `ADE_CHAT_SESSION_ID`, so the
holder name cannot tell them apart: the CLI sends `distinct: true`, and then
only the token renews (`lease --token <t>`) or releases a turn, while a lease
call without it is a new turn that queues, even under the same name (a busy
answer says `sameHolder`). One subagent's release can therefore never free
another's turn. An older CLI sends no `distinct`, and the same holder name
renews as before. `--holder <name>` names a subagent for `status`. A release
that names no device (an older CLI) is matched by its token across the lane's
devices. It is advisory: no command checks it, so the pane and an agent that
never asked are not blocked. `status` and a busy answer name the holder but
never its token. The lane's device hint (`laneAppleDeviceDirective.ts`) tells every
agent in the lane to take one before a run of builds, folds and shots. A lease
that was not granted (`acquired no`) exits 1, so `lease --wait N && <work>`
never runs the work without it.

`long-press x y` is a real hold: the helper's touch begins, stays down for
`--duration-ms` and ends, as one `sendGesture` so nothing lands while the
finger is down. `tap-element --hold-ms` does the same on an element. The
desktop pane sends a press held still for half a second as a long press of
the length it was held; the phone's live finger holds by itself.

`type " "` types a space: only an empty value is refused. For an agent,
`type` first asks the helper which element has keyboard focus (`ax-focused`,
about 10 ms warm) and answers `focus: "none"` with a message when none has,
since the text then went nowhere.

`type --submit` presses Return after the text, so a search or form submits.
With `--submit` and no text, it presses Return alone. `key` presses one real key
through the helper's HID keyboard (`pressKey`), held with `--cmd`, `--shift`,
`--alt` or `--ctrl`: `return` (alias `enter`), `escape` (`esc`), `delete`
(`backspace`), `forward-delete`, `tab`, `space`, `up`, `down`, `left`, `right`,
`home`, `end`, `page-up`, `page-down`, or one letter or digit (`key f --cmd`).
Every modifier is released even when the press fails, so the device never keeps
⌘ held. `typeText` only spells characters, which is why arrows and shortcuts
needed this path.

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
identical and is deliberately not claimed. An iPhone Duo is
verified from its posture instead (see Foldable mode).

### Auto-record contract

1. An agent's first injected input (`tap`, `tap-element`, `type`,
   `fill-element`, `drag`, `select`, `open-url`) against a device with no
   running recording starts one automatically, tagged `auto`, owned by that
   chat, overlays per Settings. Three opt-outs, all "never start one" (a
   recording already running still overlays the input): `--no-record` on
   the command (the CLI sends `noRecord: true`; the service runs the call in
   a no-record async scope, so every input path inside it is covered), `ade
   apple auto-record off` for the lane (`setAutoRecord`/`getAutoRecord`, kept
   in the project's KV as `apple.autoRecord.lane.<laneId>`), and the
   machine's "Record agent input" switch in Settings ▸ Apple Development
   (`apple.autoRecordAgentInput`, an account setting per device, read by the
   brain). The default stays on.
2. It stops at the end of the chat's turn, or after 5 minutes, whichever
   comes first. `record-start` while an auto recording is running converts it
   to manual (no restart, no gap) and swaps the auto cap for the manual one.
   Every manual recording stops itself after 5 minutes of real time, counted
   from its start or conversion (`--max-seconds` sets less), and files as
   proof with `stopReason: "cap"`. Two minutes with no input stops it too
   (`"idle"`), as does a nearly full disk (`"disk"`).

   The helper records a raw MP4 at wall clock with no overlays
   (`idleCompression: false`, `overlays: false`, path `<id>.raw.mp4`). At the
   stop the service turns it into a demo at `<id>.mp4` (see
   [Demo videos](../proof.md#demo-videos)): still time cut, waits sped up,
   zoom to each tap, tap rings, under 10 MB. The ring and badge settings still
   decide whether the demo shows tap rings and typed text. The sidecar and
   `record-stop` carry `durationMs` (the demo), `wallDurationMs` (real time)
   and `idleCutMs`; the proof keeps wall-clock `recordedFrom`/`recordedTo`.
   `--plain` (older name `--keep-idle`) files it as recorded, sized to fit.
   A raw recording the service lost is still made into a demo when it is
   reclaimed.
3. An agent may `record-delete` a recording it owns that is not marked
   `proof`. Anything else is `APPLE_RECORDING_PINNED`.
4. **Every recording files itself in the proof drawer the moment it stops**,
   whoever started it, and carries the resulting `proofArtifactId`. A
   screenshot does the same. There is no pin step; `proof-bundle` exists to
   add the machine, device, elements and log alongside the picture, not to
   make a recording count as proof.
5. There is no auto-delete. Recordings live under
   `<projectRoot>/.ade/artifacts/apple-recordings/<laneId>/`. Pruning auto
   recordings an agent never cited was considered and left out: each one is
   already a proof row the user may have opened, and nothing tells ADE that
   they did not. The opt-outs above stop the ones nobody wants.
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
| `key` | `pressKey` | positional key (named, or one letter/digit), `--cmd`/`--shift`/`--alt`/`--ctrl`, `--device` |
| `show` (`reveal`) | show request (not an `ios_simulator` action) | `--floating`, `--session` |
| `open-device` (`open-sim`, `boot`) | `openDevice` | `--device/--udid`, `--lane`, `--chat-session`, `--no-window`, `--force` |
| `close-device` (`close-sim`) | `closeDevice` | `--device`, `--chat-session`, `--force`, `--ignore-ownership`, `--shutdown` |
| `record-start` | `recordStart` | `--overlays on\|off`, `--label`, `--plain`, `--max-seconds`, `--lane` |
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
| `relaunch` | `relaunchApp` | `--bundle-id`, `--launch-arg=<v>`, `-- <app args>`, `--device` |
| `lease` | `deviceLease`, `deviceLeaseRelease` (`release`), `deviceLeaseStatus` (`status`) | `--wait`, `--ttl`, `--holder`, `--token`, `--lane` |
| `terminate` (`kill-app`) | `terminateApp` | `--bundle-id`, `--device` |
| `uninstall` | `uninstallApp` | `--bundle-id`, `--device`, `--force` |
| `status-bar` | `setStatusBar`, or `clearStatusBar` with `--clear` | `--time`, `--data-network`, `--wifi-bars`, `--cellular-bars`, `--battery-level`, `--battery-state`, `--clear`, `--device` |
| `app-state` | `getAppState` | `--bundle-id`, `--device` |
| `log-start` (`logs-start`) | `startEventLog` | `--device`, `--bundle-id` (required), `--subsystem`, `--process`, `--force` |
| `log-stop` (`logs-stop`) | `stopEventLog` | `--force` |
| `log` (`logs`) | `getEventLog` | `--device`, `--since`, `--limit` |
| `find-element` (`find`) | `findElement` | `--ref`, `--identifier`, `--label`, `--text`, `--role`, `--index`, `--device`, `--lane`, `--project` |
| `tap-element` | `tapElement` | the same element query, plus `--hold-ms` (a long press) |
| `long-press` (`longpress`, `press-and-hold`) | `longPress` | positionals `<x> <y>` or `--x`/`--y`, `--duration-ms` (default 1000, 100–5000), `--device` |
| `fill-element` (`fill`) | `fillElement` | the same element query, plus `--value` or a positional, plus `--no-focus` |
| `wait-for-element` (`wait-for`) | `waitForElement` | the same element query, plus `--timeout-ms`, `--gone` |
| `assert-visible` (`assert`) | `assertVisible` | the same element query |
| `proof-bundle` | `captureProofBundle` | `--out`, `--caption`, `--no-elements`, `--log-rows`, `--device`, `--lane`, `--project` |

Input coordinates are what the agent sees: a screenshot's and the
accessibility tree's points, upright. When the picture sits turned on the
framebuffer (any device held landscape, and the iPhone Duo's inner display
always, since it is mounted a quarter turn), the helper turns an agent's
`tap`, `drag`, `swipe` and `scroll` onto the framebuffer before it sends them
(`space: "screen"` on the helper's touch and scroll commands, read from the
live display's orientation at each gesture's start). A viewer (the pane, a
remote window, the phone) maps clicks onto the framebuffer it draws turned,
so its input (`source: "user"`) goes as is.

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

### iPad windows

`ade apple window` (`ios_simulator.windowLayout`) lays out the front app's
window on an iPad in windowed mode (iPadOS 26+). No simctl or CoreSimulator
call sets a window's frame or the multitasking mode, so it works the way a
person does, through the accessibility tree and the helper's touches, and
checks the result:

- The window's frame is the app's Application element, which the helper
  places in screen points (`WindowPlacement`), off-screen parts included
  (`x` below 0 for a window hanging off the left edge). When the helper could
  not place it (`ADEUnplaced`, often for an app with few elements), the frame
  is read from SpringBoard's own elements, which are always screen points: a
  `Window Controls, <app>` button (`window-controls:<bundle id>`) about 21
  points in from the window's top left (43 under the status bar), and a
  `Resize <app>` grabber (`resize-grabber`, value `Bottom Right`, or `Bottom
  Left` on a Slide Over window) on a bottom corner. The grid walk often
  misses them, so ADE hit-tests (`ax-hit`) where they can be: near the last
  frame it saw or the place it just sent the window, on the slots a window
  that size tiles into, the corners 20 points apart, and last the whole
  screen for the controls, 30 by 18 points apart. All point reads for one
  window read stop after 30 seconds (while the helper cannot place a window,
  each point read searches too). The answer says `frameSource: placed |
  inferred`; `status` adds `offScreen` (points past each edge).
- `--size WxH` drags the grabber, correcting until it is within 3 points.
  A free window keeps its top-left corner and follows about 92% of a drag; a
  window iPadOS centred (out of Fill) grows on both sides and follows about
  200%, so each drag is scaled by what the last one did. A filled window is
  first taken out of Fill by a drag of its own (that drag only restores its
  last size). A size that does not fit is refused.
- `--move X,Y` drags the window's top strip (14 points under its top edge,
  clear of the controls), which moves a free window point for point; a drag on
  the controls or the content does not move it. iPadOS stashes a window
  pushed past the right edge (a sliver at the edge): `window` then says it
  cannot find it, and `relaunch` brings it back on screen.
- `--fill`, `--left`, `--right`, `--top`, `--bottom`, `--split` (Left and
  Right), `--thirds`, `--quarters` and `--slide-over` are the window's own
  menu: a long press on Zoom opens Move & Resize, Fill & Arrange and Enter
  Slide Over, and ADE taps the item by its label. A filled window has no
  controls, so ADE first takes it out of Fill; a window partly off the screen
  (its controls can be off it) is first dragged wholly onto it. A menu
  without the item answers with what it offers and closes with Escape.
- `applied` is `judgeAppleWindowLayout` (`appleWindowLayout.ts`): the frame
  read afterwards against the layout's slots for THIS orientation's screen
  (halves, thirds or quarters with a 10-point gap; a full-height slot stops
  above the 123-point Dock when it shows, so only "most of the height" is
  checked), 24 points of slack. Measured on an iPad Pro 11-inch (M5),
  iPadOS 27.0:

  | layout | portrait 834x1210 | landscape 1210x834 |
  |---|---|---|
  | left / right | 412x1087 at 0,0 / 422,0 | 600x711 at 0,0 / 610,0 |
  | top / bottom | 834x600 at 0,0 / 0,610 | 1210x486 at 0,0 / 0,385 |
  | split | 412x1210 at 0,0 | 600x834 at 0,0 |
  | thirds | 375x1210 at 0,0 | 396x834 at 0,0 |
  | quarters | 412x600 at 0,0 | 600x486 at 0,0 |
  | slide over | 375x1031 at 439,44 | 375x655 at 815,44 |

  A window cannot shrink below its app's minimum size. Along an axis where it
  outgrows its slot, iPadOS centres it on the slot (landscape bottom: 486 on
  a 412-point slot lands at 385, running 37 points past the bottom edge) or
  keeps it flush with the screen edge the slot touches; that lands, with a
  `note` saying so, and only there may the window run off the screen. A
  window off the screen anywhere else never lands: the reason names the edge
  and the points past it. The CLI exits 1 when it did not land.
- `--move` reports where iPadOS left the window. It snaps a window within
  about 10 points of a screen edge to that edge (700,300 became 710,300,
  flush right), keeps a window's bottom above the Dock (100,100 became
  100,111 for a 600-point window in landscape), and a tiled or filled window
  leaves its tile and takes back its old size on the first drag. The reason
  says which; one more drag is made when the first lands short.
- Before a menu layout, a window is dragged back onto the screen only when
  its controls (its top-left 62x65 points) are off it; a window that outgrew
  a bottom or right slot keeps its controls, and dragging it would untile it.
- `APPLE_WINDOWING_UNAVAILABLE`: no window (an iPhone, or an iPad set to Full
  Screen Apps), or a window ADE cannot find. Held landscape works too: the
  helper turns SpringBoard's elements, which come back in the portrait
  framebuffer's points, onto the screen (see below).
- Measured both ways up on that iPad: `status`, `--size`, `--move`
  (including a window 150 points off the left edge), `--fill`, `--left`,
  `--right`, `--top`, `--bottom`, `--split`, `--thirds`, `--quarters` and
  `--slide-over` landed, most in 9–15 s; a window found only by the last
  sweep takes up to about 30 s more.
- Element frames are screen points for any window. The accessibility
  translator reports an app's own elements relative to their window, while
  hit-tests take screen points and SpringBoard's elements (status bar,
  window controls, grabbers) are already screen points. The helper's
  `WindowPlacement` finds each window context's origin (`_windowContextId`):
  a remembered or zero offset is confirmed by the window's edges or most of
  its small leaves; otherwise an element found on a coarse lattice is
  binary-searched on each side (the middle of the span it answers over, so
  touch padding cancels), a side the screen cuts off is decided by the leaves
  or by a second element that agrees within 5 points, and a window within
  3 points of a screen edge is snapped to it. A window hanging off the
  screen's edge hit-tests in a shifted space, so where the app's own resize
  grabber is in the tree its corner wins and the grid is sampled again. The
  offset is kept per device and context; an app that fills the display, an
  iPhone and the Duo's turned inner panel skip all of it. A window that
  cannot be placed leaves its elements marked `ADEUnplaced` (the provider
  says `unplaced`, the snapshot prints `(unplaced)`) and `tap-element`
  refuses them. A sparse window answers hit-tests only on its few elements
  (its empty background answers nothing), so the app's window is found by
  its own largest elements, first at the snapped layouts' origins, then
  sampled finer than the element over every place the window can be; and its
  own resize grabber (SpringBoard's, in screen points, its centre the
  window's corner) makes the answer exact wherever it shows. A point read
  (`ax-hit`, the focused element) never searches: it uses the remembered
  offset, so a sweep of point reads stays fast. Held sideways, a rigid
  device's hit-tests take the framebuffer's portrait points and SpringBoard's
  frames come back in them (the battery at 10,15, 13x29 on a landscape
  iPad), while the app's frames are the landscape picture's: the helper turns
  each screen point onto the framebuffer with the touch path's turn
  (`ScreenTurn`, from CoreDevice's display list) and SpringBoard's frames
  back onto the screen, and samples the grid in screen points. A foldable's
  panels keep their own path. Measured on an iPad Air 11-inch (M4), iPadOS 27.0:
  `tap-element` opened its tile with the window at 415,0, 415,595, 0,595,
  0,0 (left, top, split) and hanging off the left edge at −55,0; a warm
  snapshot cost the same as before or less (the grid samples only the
  window).

## Live view

One backend: the helper encodes H.264 from the simulator's IOSurface
framebuffer. `stream-start` takes `--fps`, `--scale-factor`, and
`--bitrate-kbps`. It does not take `--backend`. `getStreamStatus` reports
shape, fps, and bitrate with `url` and `token` null; only `stream-start`
returns those. It also lifts the transport's point size to the top as
`pointWidth`/`pointHeight` (`screen points` in `--text`), the plane `tap`,
`drag` and `swipe` take; both are null while no stream runs, so `stream-start`
first. A snapshot taken while a stream runs scales its elements from that point
size (both axes must agree), which is how the Duo's inner panel reads @3x
instead of the @2x the element-frame guess picked. With no stream it reads the
device type's own scale: `simctl list devicetypes -j` names the profile bundle,
and its `Contents/Resources/capabilities.plist` lists each display's `scale`
(`deviceTypeScreenScale`; the iPhone Duo's two integrated panels are both @3x).
A screenshot is in the device's native pixels, so that scale holds; it is read
once per device. The element-frame guess is left for a profile that names no
scale, or whose screens disagree.

A viewer that is not visible stops its stream. A stall of ~3s shows
Reconnect. First frame timeout is 5s.

### Remote viewers and pacing

A phone, a web tab or another desktop gets the stream through
`appleStreamRelay.ts`: a single-use ticket over sync (`apple.streamTicket`,
which starts capture at `apple.remoteBitrateKbpsCap`, default 2500 kb/s), then
a second WebSocket that carries the helper's records unchanged. The ticket
carries the transport's pixel size and its POINT size; a viewer needs both to
turn a touch into a tap.

A remote viewer that joins a stream that is already running gets the cached
config and keyframe at once, then no delta frames until a fresh keyframe,
which the relay asks for: the deltas in between reference frames it never saw.

A viewer that sends `{t:"ack",n}` (records received so far) is **paced**
(`appleStreamPacing.ts`). Over the tunnel relay the socket the brain writes to
is a loopback pipe, so its `bufferedAmount` cannot show a queue building on the
way to the phone; the acks can. The relay keeps the send time of every record
and compares the oldest unacked one's age with the best round trip of the last
5–10 s. Nothing is paced until a round trip has been measured.

- Past `APPLE_STREAM_LAG_BUDGET_MS` (250 ms) the viewer stops getting delta
  frames. Once it is back within 60 ms it resumes at a keyframe; the relay
  gets one by attaching a short second loopback reader, which makes the helper
  rebuild its encoder (there is no keyframe command, and none is needed).
  Config records are never skipped. A viewer never receives a delta frame it
  cannot decode.
- Each stall lowers the lane's encoder cap to 60% (at most every 2 s, never
  under 400 kb/s); 15 s without a stall raises it by a quarter, every 10 s, up
  to the configured cap. The change goes through `capLiveStream`, which only
  re-caps the capture that is running and never starts one. The cap is the
  lane's, so it also applies to the Mac's own view while a remote viewer is
  attached, as the remote cap already did. When the paced viewers leave and
  an unpaced one still watches, the configured cap comes back.
- About once a second the relay answers with `{t:"stats"}`: `rttMs`,
  `baseRttMs`, `lagMs`, `skipped`, `bitrateKbps`.

The phone, the hosted web client and a desktop bound to another Mac all ack
(the web and desktop reader is `readSocket` in `h264StreamPlayer.ts`). A viewer
that never acks (an older client) is forwarded every record. The measured effect is the "Apple stream relay" row in
[the performance baseline](../../perf/macos-baseline.md#brain-and-services)
(`scripts/perf/service/apple-stream-pacing.bench.mts`): on a 1 Mb/s link a
paced viewer stays about 50 ms behind, an unpaced one tens of seconds.

**Over the tunnel relay the Mac speaks first.** The stream's loopback socket
sends its config and keyframe as soon as it opens, so those bytes can reach
the relay on the pipe socket before the brain's `{t:"ready"}` reaches it on
the control socket. The relay holds them (in order, up to 4 MiB a pipe) and sends them
right after the viewer's ready. Before that Worker change it closed the pair
with `4510` "relay bridge not ready". A viewer still redials a transient drop
by itself, with a fresh single-use ticket each time:

- The phone tries up to three times (0.5 s, 1.5 s, 3 s) on `4510`, `4509`,
  `4506`, `1001`, `1006`, a lost connection, or a first frame that never comes
  (unless the Mac reported a capture error). It shows "Reconnecting…", not an
  error. The first frame refills the budget. It never redials an expired pass
  (`4401`), a stream it cannot decode, the Mac's own error, a hidden viewer or
  a closed one. After the last try it shows the reason and Reconnect.
- The web client and a desktop bound to another Mac treat every close but
  `4401`, and a socket error, as the stream ending: `useAppleDeviceStream`
  asks for a new stream up to three times, then shows "Video stopped." with
  Reconnect.

When the Mac's ADE cannot find its simulator helper, the phone says the
helper is missing on the Mac and that reinstalling or updating ADE there
restores it. "Update ADE on your Mac" is kept for a Mac that lacks the
commands, or whose ticket has no point size.

### The phone: watch and control

`AppleDeviceViewer` opens full screen from the simulator chip in a chat.
**View only** is the default: the picture fills the screen and a tap shows or
hides the bars. **Control** is a press-and-hold (0.6 s, the half fills as it
is held); a tap only says "Hold to take control". While controlling, the
picture sits between the bars in an orange frame, the bar says "Controlling",
and Home, a hardware-buttons menu (Lock, Volume up and down, Siri, App
switcher), a keyboard and **Done** are on it. The keyboard bar has its own hide
button and the keyboard a Done key. System edge gestures are deferred so a
swipe up from the bottom reaches the simulator.

Control is not offered, with the reason shown, when the host lacks
`apple.input`/`apple.invoke` or the point size, when the device shown is not
the lane's own (`laneDevice` must match), when another chat claimed the device
(the chat the viewer was opened from does not count — its id rides as
`chatSessionId`, the same rule as the desktop pane), or before the picture is
live. It ends by itself on background, a lost or stalled picture, a claim by
another chat, a different device behind the picture, a refused gesture, or
5 minutes without a touch.

Input is the desktop's contract (`useAppleDeviceInput`): a touch is a fraction
of the drawn picture, turned back through the phone's own display rotation,
then multiplied by the helper's current point metrics. Those metrics come from
the stream's config record (the helper's metrics in pixels, re-sent when a Duo
folds) times the ticket's points-per-pixel, never from the decoded frame size,
because an app drawing landscape turns the framebuffer while the helper still
normalises against portrait. When the stream ticket says `liveTouch: true`,
the finger is sent as it moves: `apple.input` kind `touch` with phase `begin`,
`move` and `end`, one call in flight, a waiting `move` replaced by the newer one
(`AppleLiveTouchSender`). The device moves under the finger rather than after
it lifts. While the finger is down its point is repeated every 500 ms, so a
long press or a pause mid-drag keeps it held. The host (`touch` in
`iosSimulatorService.ts`) holds at most one finger per lane, lifts one the
viewer stops updating after 4 s (a phone off the network never leaves a touch
held down), lifts it before any other tap or drag on the lane, and changes its
held state before calling the helper so a failed or slow send cannot strand
one. Against an older host the gesture leaves as one call instead: a `tap`
under 10 points of travel, else a `drag` replayed at its real duration
(60 ms–2 s). Buttons are `apple.invoke pressButton`. Text is `apple.input
type`. Nothing is retried, and nothing but a live finger's own moves waits
behind another call.

On the host, `apple.input` stamps `source: "user"` (a person's tap never
starts an agent's auto-recording) and reads the owner from memory
(`getControlOwner`) instead of a full status read, which ran `simctl` on most
taps because the status throttle is 500 ms. Remote input (`apple.input`, and
the input methods behind `apple.invoke`) drives only the lane's own claimed
device (`getClaimedDevice`), named explicitly to the service: a lane with no
device is refused with `APPLE_NO_LANE_DEVICE` instead of falling back to the
first booted iPhone, which could be another lane's screen. The desktop pane
keeps that fallback.

A lane on another machine: `apple.*` commands route by the lane's namespaced
id, and the video socket resolves the ticket against **that** machine's live
address (`SyncService.appleStreamEndpoint`), not the focused machine's.

The speed readout (speedometer button) shows received fps, received kb/s, the
relay's round trip, skipped frames, and the median tap→screen time. The fps is
what the Mac sends: a screen that is not changing is captured at a 5 fps floor,
so a still picture reads 5 fps however fast the link is. The phone
cannot read pixels, so "the screen changed" is read from the stream: an idle
device is captured at a 5 fps floor with tiny frames, and a change starts a
burst of frames a refresh apart, or a frame several times the recent size.
On the Mac's helper (iPhone 17 Pro, 2.5 Mb/s) the first changed frame leaves
17–130 ms after a tap is applied (median 103 ms).

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

With several matches the order is: elements read from the screen before ones
ADE inferred, the app layer before the accessibility layer, a control (a
Button, cell, link) before text or an image inside it, then the snapshot's own
order (smallest first). `find` and `tap-element` say which match they used,
why, list the others with their points, and name the `--index` for the next.

`fill-element` taps, types, then reads the field back with one point read at
its centre (the helper's `ax-hit`: one hit-test, no tree walk, no grid probe,
150 ms after typing and once more 350 ms later if the text is not there yet).
It answers `typed`: `verified` (the field holds the text, compared without
case, so autocapitalisation passes), `not-seen` (with a warning and what the
field reads) or `unknown` (a secure field, the field is gone from its place,
an older helper).

**SwiftUI tabs.** When the screen has a Tab Bar, the lane's Swift sources are
read for each `TabView`'s tabs (`.tabItem { Label("…") }`, read inside the
closure, and `Tab("…", role:)`). Real tab items in the bar get the declaring
file and line. Only a bar that exposes no items gets slices, and only when
they can be right: one `TabView`, no search-role tab (drawn apart), no more
than an iPhone bar shows, each slice at least 44 pt (a minimised bar is
narrower). Slices carry `metadata.synthetic`, show as `(inferred)` in the
snapshot, sort last, and `tap-element` and `fill-element` refuse them with
the point to tap.

**Caps.** The helper's walk stops at 500 elements, depth 80 and 600 grid
probe points. The accessibility provider then carries `truncated: true` and
`truncatedBy`, and `snapshot --text` prints a `truncated` row and a note.

**Values.** The helper emits `AXValueDescription` beside `AXValue`, and a
non-finite number is no value. The element's `value` prefers the
description, so a SwiftUI slider reads "0:29 of 0:49", not "nan".

The snapshot's label column prints a real label bare; an element without one
shows `#name` for its accessibility identifier, `component:name`, or
`value:text`, and a line above the table says so when any row uses one. A
`--label` that no element carries still matches an exact identifier, and the
result's `note` says which flag to use next time. A miss names the field the
closest match was found in and the flag that queries it (`The closest is the
identifier "BackButton"; query it with --identifier "BackButton".`).

Snapshot and inspect are served by the helper's accessibility tree, with the
DEBUG ADE Inspector kit as a source overlay. See [inspector.md](./inspector.md).

## Event log and proof bundles

`startEventLog` runs `xcrun simctl spawn <udid> log stream` scoped to a
required `bundleId`. The predicate is `(subsystem BEGINSWITH "<bundle id or
--subsystem>" OR process == "<executable>")`: the executable is the installed
app's `CFBundleExecutable` (`simctl get_app_container … app`), or `--process`.
Each value is refused, not escaped, when it holds a quote, a backslash or a
line break, and a process name must look like one. Every row carries
`deviceUdid` (an ADE row names the device it drove), and `getEventLog` keeps
the named device's rows, else the followed device's. After 8 s with no app
row the page carries a `hint` that names the predicate and the flags to widen
it; `print()` never reaches the log. `captureProofBundle` writes `screen.png`,
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
| `APPLE_HELPER_UNAVAILABLE` | No usable helper: missing everywhere ADE looked (the message lists the folders: the app's `resources/native`, a standalone brain's `$ADE_RUNTIME_ROOT/native`, the installed ADE app), or one that speaks another helper protocol. |
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
| `IOS_SIMULATOR_OUT_PATH_OUTSIDE_ROOT` | `--out` must be inside the build root (the lane worktree); a relative path resolves there. |
| `APPLE_EXTRA_DEVICE_LIMIT` | The lane holds two extra devices. `device-delete --device <udid>` one first. |
| `APPLE_DEVICE_IS_EXTRA` | That simulator is a lane's extra device; drive it with `--device`, do not attach it. |
| Push banners on screenshots | The simulator is signed in and paired, so it gets the machine's real pushes. Capture on an unpaired device (a fresh lane or extra device) or sign the app out. |
| Several agents on one device | Take turns with `apple lease` (the lane device hint tells every agent about it). |
