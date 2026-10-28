---
name: ade-apple
description: Use this skill when you need to see an iOS app or an iOS SwiftUI view actually running on a simulator — finding or creating the lane's device, booting and streaming it, driving it by element query, screenshotting, recording, capturing proof, or rendering a SwiftUI preview — via `ade apple`.
---

# ADE Apple Development

This skill is for iOS apps and iOS SwiftUI views. For a macOS app, a dev
Electron app or a web page, the **ade-computer-use** skill picks the right
surface.

Drive the lane's Apple simulator with `"$ADE_CLI_PATH" apple <command>`.
`$ADE_CLI_PATH` is the CLI of the ADE that launched you and already targets
its brain, so your calls and the desktop's Apple Development tool share one
session. A bare `ade` goes through PATH and can reach a different ADE.

The pixels come from a vendored Swift helper (`ade-sim-helper`) reading the
device framebuffer. There is no Screen Recording grant, no Simulator window to
keep open, and no backend to choose. If you find advice about `idb`, window
capture, `live-start` or a `--backend` flag, it is describing a version of this
feature that no longer exists.

## Four rules before your first command

- **Always call `"$ADE_CLI_PATH"`, never a bare `ade`.** A bare `ade` can be
  an older install or another ADE's CLI. That shows up as "Unknown command
  'apple'", "Domain 'apple' is unavailable", or a runtime version mismatch.
  Do not add `--socket`: `"$ADE_CLI_PATH"` already names the right one.
- **Never open or script the Simulator app.** No `open -a Simulator`, no
  AppleScript or System Events. ADE drives the device directly; the Simulator
  window is not needed and adds nothing.
- **Never capture proof with `xcrun simctl io … screenshot` or
  `recordVideo`.** `apple screenshot` and `apple record-start` /
  `record-stop` file proof to the lane automatically. See below for why the
  owner matters.
- **Check each step before you report it.** A tap, swipe, button or type
  that returns `ok` only means ADE sent the input. It does not mean the app
  did what you wanted. After each step that matters, confirm it:
  `apple foreground` (which app is in front), `apple assert-visible` or
  `apple wait-for-element` (what is on screen), or `apple snapshot`. Report
  only what you confirmed. If a step failed, say which step, and do not
  describe the result you meant to get. Before `record-stop`, confirm the
  final state, so the video ends on it.

## Common tasks

Use these directly; you do not need `--help` for them. `A="$ADE_CLI_PATH"`.

| Task | Command |
|---|---|
| Open an installed app | `"$A" apple relaunch --bundle-id com.apple.mobilesafari --text` |
| Open a web page or deep link | `"$A" apple open-url "https://www.google.com" --text` |
| Tap a control by its label | `"$A" apple tap-element --label "Address" --text` |
| Long press (a context menu) | `"$A" apple long-press 120 420 --duration-ms 1000 --text`, or `tap-element --label "Everything" --hold-ms 1000` |
| Type, then press Return | `"$A" apple type "reddit" --submit --text` |
| Press one key | `"$A" apple key return --text` (also `escape`, `delete`, `space`, arrows `up`/`down`/`left`/`right`, letters; hold `--cmd`/`--shift`/`--alt`/`--ctrl`: `apple key f --cmd`) |
| Wait for something to appear | `"$A" apple wait-for-element --label "Cancel" --timeout-ms 8000 --text` |
| Which app is in front | `"$A" apple foreground --text` (`--wait 10` right after a launch) |
| Open an app with launch arguments | `"$A" apple relaunch --bundle-id com.ade.ios --text -- -adePreviewScreen duo-home` |
| Take turns with other agents on this device | `"$A" apple lease --wait 300 --text`, later `"$A" apple lease release --token <t> --text` (`--device <udid>` for an extra) |
| Put the lane's app on an extra device | `"$A" apple install --device <udid> --launch --text` |
| Lay out an iPad window | `"$A" apple window --left --text` (also `--right`, `--top`, `--bottom`, `--fill`, `--split`, `--thirds`, `--quarters`, `--slide-over`, `--size 600x800`; bare `window` reads it) |
| Input without a recording | add `--no-record` to `tap`, `type`, `swipe`, `tap-element`, … |
| What is on screen | `"$A" apple snapshot --text` |
| Go home / app switcher | `"$A" apple button home --text` / `"$A" apple button app-switcher --text` |
| Close an app (no gesture) | `"$A" apple terminate --bundle-id com.apple.mobilesafari --text` |
| Show the device to the user | `"$A" apple show --text` (tools pane) or `--floating` |

- Right after `relaunch`, `foreground` can still say `null` for a moment.
  Use `foreground --wait 10`, or wait for an element of that app.
- Tap, drag and scroll coordinates are the screenshot's and the snapshot's
  points, upright, whichever way the device is held (the Duo's inner display
  included): ADE turns them onto the framebuffer for you. Prefer
  `tap-element` anyway.
- `launch` builds Debug. Pass `--configuration Release` when the app's
  configurations differ in more than speed (ADE's own iOS app signs into a
  test backend in Debug); the summary names the configuration it built.
  Arguments after `--` reach the app, for `launch` and `relaunch`.
- One agent should drive the device. Let it do the taps, screenshots and
  recordings; other agents hand it work, or wait for its results. That is
  simpler and faster than several agents taking turns. Use leases only when
  agents truly must drive the same device in parallel.
- Several agents on one lane share one device. Before a run of builds,
  rotates and shots, take a `lease` (it queues behind whoever has it) and
  release it after. It is advisory, so it only works if every agent uses it.
  Device commands do not renew it: renew with the token before `--ttl` ends.
  It also ends when its chat is archived or deleted.
  Each device has its own lease: the lane's device, and each extra with
  `--device <udid>`. The token is your turn: keep it, renew with
  `lease --token <t>`, release with `lease release --token <t>`. A `lease`
  without the token is a new turn and queues, even from your own chat, so
  subagents of one chat take turns instead of sharing one lease. Give each
  subagent a `--holder <name>` (say `--holder ui-agent`) so `lease status`
  shows who has it.
- A simulator signed in to an Apple Account can show an "Apple Account
  Verification" alert over every app. Dismiss it with
  `tap-element --label "Not Now"`, then continue.

## Start here: ask what you can do

```bash
"$ADE_CLI_PATH" apple status --text
```

`status` is the gate and the map.

- `supported: false` means the runtime is not a Mac. Stop and say so.
- `capabilities` lists every action you may call on this device, by name. Read
  it instead of guessing verbs or reading source.
- `device` tells you whether this lane already owns a simulator, its `origin`
  (`created` or the older `clone` for ADE's own, `attached` for the user's),
  and its `laneId`.
- `tools.helper` (`present`, `path`, `version`) is the check when every device
  call fails at once.

## "Start the app on a simulator" is one command

Before you launch, check the **Project notes** block in your prompt for this project's iOS app (scheme, simulator, runtime); when you had to work something out to get it running, save it with `ade notes add` (see `ade help notes`).

```bash
"$ADE_CLI_PATH" apple launch --follow --open-drawer --text
```

`launch` does the whole chain: find or make the lane's device, boot it,
resolve the target, **build it with xcodebuild**, install it, start it, and
claim the drawer session. Add `--open-drawer` when a human asked to watch.
`--follow` announces the wait up front for a cold build.

So you do **not** run `xcodebuild` by hand to put an app on a screen, and you
do not need to know the scheme. Run `"$ADE_CLI_PATH" apple apps --text` first only
when you must choose between several targets, then pass `--target <id>`.

Use `--no-build` when the app is already installed and you only want it in
front. Use `relaunch` or `terminate` for an app that is already there.

## Use this lane's own device

**Use this lane's own device. `ade apple start` (or `device-create`) gives the
lane its own; do it without asking.**

`start` with no arguments does this for you: when the lane has no device it
makes a new, empty one from the newest installed runtime, boots it, and
streams it. Other simulators in `apple devices` belong to someone else:
another lane, an `xcodebuild test` run, or the user.

- You may make the lane's ONE device without asking, and you never make a
  simulator with `xcrun simctl create` or `simctl clone` — ADE cannot see or
  delete a device made that way.
- Need a second model too (an iPad beside an iPhone Duo)? Give the lane an
  extra device: `device-create --extra --device-type "iPad Pro 11-inch (M5)"`
  (at most 2). It comes up booted; reach it from any command with
  `--device <udid|name>` (`rotate`, `screenshot`, `snapshot`, `relaunch`,
  `tap-element`, …). Without `--device` every command still drives the lane's
  own device. ADE deletes it with the lane; `device-delete --device <udid>`
  deletes it now. `boot --device <udid>` boots an extra that is off and
  answers only once `simctl` lists it Booted.
- An extra cannot stream, record, `launch` or run tests. To put the lane's
  app on it, run `install --device <udid|name>`: it builds once into the
  lane's DerivedData (incremental, so the lane's last build is reused;
  `--no-build` installs it as is), installs, and with `--launch` starts it.
  The lane's own device, its stream and its session are not touched. To make
  an extra the lane's own device (say it already has the build and the
  sign-in), run `device-promote --device <udid|name>`. The old lane device becomes an extra,
  so nothing installed on it is lost. It is refused while the lane device is
  streaming, recording, running tests or held by another chat: stop that
  first.
- You may attach an installed simulator only when the user names it
  (`device-attach --simulator <name>` or `start --udid <udid>`). ADE refuses a
  simulator another lane holds, with `APPLE_DEVICE_NOT_LANE_OWNED`.
- `--device <udid>` on any other command must be this lane's device or one of
  its extra devices. With no device yet, the command tells you to run
  `ade apple start`.

**A busy device is not a blocker, and it is not a reason to ask a human.**
Make the lane's own with `start`. It takes seconds (see "The lane's device").

## Tests run on the lane's device

```bash
"$ADE_CLI_PATH" apple test --scheme <scheme> --text
"$ADE_CLI_PATH" apple test --target <id> --only ADETests/SyncTests --text
```

`apple test` runs `xcodebuild test` on this lane's device, with parallel
testing off and DerivedData in the lane's cache
(`.ade/cache/ios-simulator/DerivedData`), which ADE deletes with the lane. One
test run goes at a time on the Mac (`APPLE_TEST_RUN_BUSY`: wait, then run
again). A failing test comes back as `passed: false` with the failures and the
log path; it is not an error. `--text` prints the counts (XCTest and Swift
Testing together), each failing test with its file, line and message, then
xcodebuild's own failure lines, the log and the result bundle; `--json` has
the same as `failures: [{test, file, line, message}]`. An XCTest name there
(`ADETests/SyncTests/testX`) is what `--only` takes.

Do not run `xcodebuild test` by hand against a simulator you made. If you must
run `xcodebuild` yourself, pass `-derivedDataPath .ade/cache/ios-simulator/DerivedData`
from the lane worktree, never `/tmp` or `~/Library/Developer/Xcode/DerivedData`.

This is worth saying plainly because the failure looks reasonable from the
inside: you find a booted simulator, the guard tells you another chat owns it,
and stopping to ask seems polite. It is not. It blocks the work for no reason
and hands the human a decision they should never have been given.

**And when the request was for simulator proof, simulator proof is what you
owe.** A passing unit test is not a substitute for a screen. If you cannot
reach the screen, say exactly what stopped you rather than offering evidence of
a different kind and calling it done.

## The lane's device

One simulator per lane. ADE creates one on first ask, or binds one you already
have. Creating a device never downloads anything. With no runtime installed you
get `APPLE_NO_INSTALLED_SIMULATORS`: run `ade apple runtimes` to see what this
Xcode needs, and `ade apple runtimes install` to fetch it (about 8 GB per
runtime, in the background; re-run `ade apple runtimes` for progress). Tell the
user before you start a download. Removing a runtime erases or moves every
simulator on it, so it is the user's call, from the Apple Development panel's
Runtimes section; agents cannot do it.

Two facts that decide what you should do:

- A **runtime** is the iOS image. It is the large download (about 8 GB),
  one per iOS version, fetched only by `ade apple runtimes install` after you
  tell the user. Point releases can be narrow: iOS 27.1 runs only the iPhone
  Duo, and every other current iPhone runs on iOS 27.0.
- A **device** is an instance made from a runtime. Creating one copies no iOS,
  so it is cheap. A new lane device is empty: it copies nothing from any other
  simulator and grows only with what the lane installs. A device that is
  `Shutdown` is installed and ready — it needs a boot, which takes seconds.

So "no device free" is almost never true: one runtime serves any number of
devices, and a new one is a folder of app data, not another copy of iOS.
A new device has no sign-ins, so the app starts at its first-run state.

```bash
"$ADE_CLI_PATH" apple device-list --installed --text   # what a picker shows
"$ADE_CLI_PATH" apple device-list --runtimes --text    # installed runtimes and models
"$ADE_CLI_PATH" apple device-list --text               # the one this lane owns ($ADE_LANE_ID)
"$ADE_CLI_PATH" apple start --text                     # make one if the lane has none, boot, stream
"$ADE_CLI_PATH" apple start --device-type "iPad Air 11-inch (M4)" --text   # a specific model
"$ADE_CLI_PATH" apple stop --text                      # power the device OFF
```

- `start` is the one-step bring-up: make a device when the lane has none, boot it
  if it is off, wait for the boot, then stream. Prefer it. `start --udid` works
  only for the device this lane already holds.
- `stop` powers the device **off**. `shutdown` only ends this chat's session
  and leaves the simulator running — the two are not the same, and a verb named
  `stop` that left a booted device behind was a real bug.
- `device-create` and `device-attach` never boot (`device-create --extra` does). `device-delete` removes the
  lane's ADE device and refuses an attached device unless `--force`, which only
  detaches. Like `stop`, it is refused while another chat is driving the device.
- `device-detach` gives the device up without deleting it now. A simulator
  the user attached stays installed. A device ADE made becomes a leftover,
  and the cleanup pass deletes it 5 to 20 minutes later; the answer prints
  the time. To keep it, `device-attach --simulator <udid>` before then.
  When the user wants it kept as a free simulator, `device-detach --keep`:
  nothing deletes it then, and the user deletes it from the picker.
- ADE deletes the lane's own device, with all its data and the lane's build
  cache, when the lane is archived or deleted. An attached device is powered
  off and loses only the apps ADE installed. ADE never deletes a simulator it
  did not create.
- An ADE device that nothing uses for 30 minutes is powered off, extras too
  (`ADE_APPLE_IDLE_POWER_OFF_MINUTES` in ADE's environment changes the
  minutes; `0` turns it off). Every command that names a device counts as
  use, and so do a boot or an app install outside ADE (a raw `simctl boot` or
  `simctl install`) and a device still booting. Prefer `apple install
  --device` and `boot --device` anyway. `status` and `device-list` then say so, for example `note: ADE powered
  iPad Air 11 off after 31 min idle at 10:12; the next --device command boots
  it again.` `start` boots the lane's device again, and the next `--device`
  command boots an extra. Do not `simctl boot` it yourself.
- Deleting an installed simulator from the list is the user's call, made in
  the desktop picker. ADE refuses it from an agent; do not try.
- `runtimes` names a missing runtime by what its models need: on Xcode 27.1
  with only iOS 27.1 installed (it runs only the iPhone Duo), every other
  iPhone needs iOS 27.0, so it says `iOS 27.0`. `runtimes install --version
  <x>` for a runtime the Mac already has is refused with
  `APPLE_RUNTIME_ALREADY_INSTALLED` and the version to install instead.

## iPad windows

On an iPad in windowed mode (iPadOS 26+, the default), `apple window` lays
out the app in front and reads the frame back:

```bash
"$ADE_CLI_PATH" apple window --text                 # where the window is
"$ADE_CLI_PATH" apple window --size 600x800 --text  # resize
"$ADE_CLI_PATH" apple window --move 0,0 --text      # top-left corner to 0,0
"$ADE_CLI_PATH" apple window --left --text          # also --right, --top, --bottom
"$ADE_CLI_PATH" apple window --split --text         # also --thirds, --quarters
"$ADE_CLI_PATH" apple window --fill --text          # full screen
"$ADE_CLI_PATH" apple window --slide-over --text
```

- `--size` drags the window's resize grabber, correcting until it is within
  3 points. The layouts are the window's own menu (a long press on its green
  button). Either way the answer says `applied` and exits 1 when the window
  did not land; read the `reason`.
- The frame is the real one, off-screen parts included: `window` says when
  the window hangs past an edge, and a layout never counts as landed while
  part of it is off the screen. A layout first drags such a window back on.
- A size that does not fit from the window's top-left corner is refused:
  move it first (`--move 0,0`, `--left`, `--top`).
- `--move` says where iPadOS left the window: it snaps a window near a
  screen edge to that edge and keeps its bottom above the Dock, so a few
  points off is iPadOS, not a failed drag. A layout whose window is larger
  than its slot (the app's minimum size) lands with a `note`; it may then run
  past one screen edge.
- A window pushed past the right edge is stashed by iPadOS; when `window`
  says it cannot find the window, `relaunch --bundle-id <id>` brings it back.
- `APPLE_WINDOWING_UNAVAILABLE`: the app in front is not in a window (an
  iPhone, or an iPad set to Full Screen Apps in Settings ▸ Multitasking &
  Gestures), or ADE cannot find the window. Portrait and landscape both
  work.
- `snapshot`, `find` and `tap-element` give screen points wherever the
  window is. If a read could not place a window (one still opening), its rows
  say `(unplaced)` and `tap-element` refuses them: run it again.

## Drive the app

Name elements, not pixels.

```bash
"$ADE_CLI_PATH" apple snapshot --text
"$ADE_CLI_PATH" apple tap-element --label "Sign in" --text
"$ADE_CLI_PATH" apple fill-element --identifier email-field --value ada@example.com --text
"$ADE_CLI_PATH" apple wait-for-element --label Welcome --timeout-ms 8000 --text
"$ADE_CLI_PATH" apple assert-visible --label Welcome --text
```

- Run `snapshot` first. Query with `--ref`, `--identifier`, `--label`,
  `--text-match`, `--role` and `--index`.
- In the snapshot's label column, a bare word is a label (`--label`). An
  element with no label shows `#name` for its accessibility identifier (query
  `--identifier name`), `component:name` or `value:text`. A `--label` that no
  element carries still finds an exact identifier, and the answer says it did.
  A miss names the closest field and flag: `The closest is the identifier
  "BackButton"; query it with --identifier "BackButton".`
- A `ref` names its own tier. `id:` and `component:` survive a re-render;
  `pos:` survives nothing, so ask for an accessibility identifier instead.
- `wait-for-element` replaces a sleep. Add `--gone` to wait for a disappearance.
- When several elements match, the answer says which one it used and why,
  lists the others with their points, and names the `--index` that picks the
  next. A control that holds the matching text wins over the text inside it.
- `fill-element` reads the field back and prints `typed: verified`,
  `not-seen` (the field does not hold the text: focus never arrived, or the
  app dropped it; check a screenshot) or `unknown` (a secure field, or the
  field moved). `type` prints `focus none` when no element had keyboard
  focus, so the text most likely went nowhere: tap the field first.
- A row marked `(inferred)` is a SwiftUI tab ADE placed from source because
  the Tab Bar showed no tab items. Its frame is a guess, so `tap-element`
  refuses it and prints the point to `tap` instead. A real tab item carries
  its source file and line.
- `snapshot` says `truncated` when the accessibility walk hit its cap
  (500 elements, depth 80, 600 probe points). Elements past it are missing
  from `find` and `tap-element` too; scroll or open the part you need, then
  snapshot again.
- Fall back to coordinates only when no query matches: `tap`, `drag`, `swipe`,
  `scroll`, `select`.
- `type` and `key` act on the focused field, so tap the field first.
  `type " "` sends a space; whitespace passed on purpose is text.
- `long-press x y` holds the finger down (default 1000 ms, 100–5000) and
  lifts it: what opens a context menu. Do not fake it with a one-point swipe.
- `foreground` reports which app the device has in front, read from the device
  rather than from what ADE last launched.
- Hardware buttons: `button home` (also `lock`, `volume-up`, `volume-down`,
  `siri`, `app-switcher`). `shake` is refused with `APPLE_BUTTON_UNSUPPORTED`,
  because neither the helper nor `simctl` has it. `app-switcher` is
  Simulator's own App Switcher command, two home presses 150 ms apart; do not
  press `home` twice yourself, the gap between two calls is too long.
- Orientation: `rotate landscape-left` (also `portrait`,
  `portrait-upside-down`, `landscape-right`). **Read the answer.** `rotate`
  turns the device and then reads the screen, so `applied: true` means the
  framebuffer was seen on the requested axis — not that a request was sent.
  iOS always accepts the device orientation and then lets the foreground app
  decide, so `applied: false` with `reason: APPLE_ROTATE_NOT_ADOPTED` means
  that app kept its own orientation. The Home Screen and Settings are
  portrait-only on an iPhone, and no iPhone supports portrait upside down —
  put the app you are testing in front before you rotate, and do not treat a
  refusal as a broken simulator. `verification: already-on-axis` means the
  screen was on that axis before you asked; turning within one axis leaves
  the pixel size unchanged, so the exact side is not confirmed.
  On an iPhone Duo, `rotate` names how the PHONE is held, not the shape of
  the picture, and the inner display runs a quarter turn from the phone:

  | You want (inner display) | Do | Screenshot |
  |---|---|---|
  | Wide, flat open | `fold open` (or, already flat open, `rotate portrait`) | 2853x2007 |
  | Tall (upright), flat open | `fold laptop`, then `fold --angle 180` (or, already flat open, `rotate landscape-left`) | 2007x2853 |
  | Laptop (half open, tall) | `fold laptop` | 2007x2853 |
  | Book (half open, wide) | `fold book` | 2853x2007 |

  `rotate`, `fold` and `posture` print `picture inner display, tall|wide`;
  trust that line over the orientation name. A raw `fold --angle` keeps how
  the phone is held; `fold open` and `rotate portrait` turn it back to wide.
  The cover's Home Screen is portrait-only.

- Folding (iPhone Duo only): `fold closed|open|laptop|book|tent` or
  `fold --angle 120`, then read `posture` back. The answer is what the
  simulator did: `activeScreenId` 1 is the cover, 3 the inner display, and the
  live view, taps and typing follow it. On any other device it answers
  `supported: false`. Test a layout in more than one pose, and fold during a
  session, not only at launch. For a demo, `fold --sequence closed,open,tent`
  inside a recording adds a caption per pose. Tent reads `orientation
  facedown, tableMode yes, activeScreenId 1`: that is Device Hub's Tent (the
  phone stands on its outer edges, the cover faces the viewer), not a fault.
  Screenshots are the panel's own pixels and look the same in book, laptop
  and tent; to show the fold itself, `render --poses`.
- A simulator that is signed in and paired with an ADE machine gets that
  machine's real push notifications, and their banners land on screenshots.
  Capture fixtures on a device that was never paired (a fresh lane device or
  an extra device is not), or sign the app out first.

- Getting an app ready for the Duo: `duo-skill` copies Apple's
  `app-resizability` skill (from Xcode 27) into the lane's
  `.agents/skills`; read it and follow it. It moves a UIKit app onto the scene
  life cycle (iOS 27 SDK apps without one do not launch) and off
  `UIScreen.main`, the idiom and the interface orientation. Then prove it:
  `fold closed`, `screenshot`, `fold open`, `screenshot`, without relaunching.
  It stops to ask whether the scene setup goes in Info.plist or code.

- 3D renders: `render --angles front,three-quarter-left --poses closed,open`
  (`--lighting studio|dusk`, `--sheet`, `--video`, `--no-shadow`) files stills
  of the 3D device with its live screen to the proof drawer. No pane needs to
  be open: any ADE desktop window with the project open renders it off
  screen (a project on another machine must be the window's front tab);
  with none, it says so. The device must be on (`apple start`). On a
  Duo each pose folds the simulator first. It prints a `cite:` line per
  image; paste them to show the renders.

Agent launches stay in the background; `apple show` brings the device up at
any time.

### Close an app the way a person does

Bottom-edge swipes do not work: the helper sends them as ordinary touches, so
iOS never sees the home-indicator gesture, and a swipe from the bottom edge
opens nothing. Use the App Switcher instead.

```bash
"$ADE_CLI_PATH" apple button app-switcher --text
"$ADE_CLI_PATH" apple screenshot --out switcher.png --text   # check it opened
"$ADE_CLI_PATH" apple swipe 201 480 201 80 --duration-ms 150 --text
"$ADE_CLI_PATH" apple button home --text
```

- Coordinates are points. Read the screen size from `apple stream-status`
  (`screen points` in `--text`, `pointWidth` × `pointHeight` in `--json`).
  Both are empty while no stream runs; then read `screen` from `apple
  snapshot` (`402x874 @3x`), which needs no stream. The example is an
  iPhone 16 Pro (402 × 874).
- The front app's card sits in the middle of the switcher. Swipe it up from
  about (W/2, 0.55 H) to (W/2, 0.09 H), fast: 150 ms. A slow drag only lifts
  the card.
- Take a screenshot after `app-switcher`. If the switcher is not showing, do
  not keep swiping: say so, and use `apple terminate --bundle-id <id>` to stop
  the app without showing it (Safari is `com.apple.mobilesafari`).
- While a recording runs, every failed try is in the video. Check the screen
  after each step instead of repeating a gesture.

## Show the device to the user

When the user asks to see the device ("open the sim drawer", "show me"):

```bash
"$ADE_CLI_PATH" apple show --text              # the Apple tool in the tools pane
"$ADE_CLI_PATH" apple show --floating --text   # the floating player over the chat
"$ADE_CLI_PATH" ui show proof --text           # this chat's proof drawer
```

It targets your own chat and reports what really happened. A shell with no
ADE chat identity (`ADE_CHAT_SESSION_ID` unset, e.g. an OpenCode agent shell)
cannot use `apple show` or `ui show`; ask the user to open the tool.

- `shown` — it is on screen now.
- `held` — a desktop window has this project open but the user cannot see
  it yet (your chat is not in front, or the window is hidden). It opens when
  the user goes to your chat. Say so.
- `no_desktop` (exit 1) — no desktop window is open for this chat, so nothing
  was shown. Tell the user; do not claim you opened it.

A desktop on another machine that has your chat open answers too. You do not
need `show` just to be seen working: while you drive the device and the Apple
tool is not open, the desktop floats the device over your chat by itself,
unless the user closed that player (then only `apple show` or the user brings
it back).

## Proof is automatic, and only on this path

You do not pin anything. Both of these file themselves in the proof drawer and
return a `proofArtifactId`:

- **every recording**, the moment it stops, whoever started it;
- **every screenshot** you take. It prints a `cite:` line: paste that to
  show the shot. Do not `proof attach` the same file again; it is refused
  as a duplicate (the refusal prints the same `cite:` line).
  For a validation loop of throwaway shots, add `--no-proof`.

```bash
"$ADE_CLI_PATH" apple screenshot --out shot.png --text
"$ADE_CLI_PATH" apple frame --out shot.png --text
"$ADE_CLI_PATH" apple proof-bundle --caption "Settings row renders" --text
```

**Capture through these commands, not through `xcrun simctl io screenshot`.**
The difference is not the picture, it is the owner. An `ade apple` capture is
filed against the lane and the asking chat, so it appears in the drawer the
human is looking at. A picture you take with `simctl` and then hand to
`ade proof attach` is filed against whatever ADE can work out about your shell,
and a shell with no chat session — every OpenCode agent has one, because a
single `opencode serve` is shared across chats — used to produce a record owned
by nothing, invisible to everyone, while every command reported success. That
now fails loudly instead of lying, which is better and still not proof.

**Projects on an external drive.** macOS won't let the Simulator's own service
write to a removable or external volume, and it can't ask for permission, so
`xcrun simctl io … screenshot <path>` or `recordVideo <path>` into a project on
such a drive fails with "Operation not permitted". `ade apple` handles this (it
captures on the internal disk and saves the file into the lane for you). If you
ever run `simctl io` by hand, write to `/tmp`. Builds, installs and tests work
from the drive.

If you must attach a file from elsewhere, run `ade proof attach` from **inside
the lane worktree** so ADE can place it, and read the last line: it names the
lane and the chat the artifact landed on. `lane none / chat none` is a failure,
not a detail.

- `screenshot` round-trips `simctl` and works with no stream running.
- `frame` grabs one decoded frame from the live stream and fails with
  `APPLE_STREAM_NOT_RUNNING` when there is none. Prefer it while streaming.
- `proof-bundle` files the same single drawer row as `screenshot`, and also
  writes `elements.json`, the log and `metadata.json` next to `screen.png` in a
  directory under the build root. Use it when a reviewer wants the whole
  context; the row it returns is the picture.

## Recording, and what starts one

```bash
"$ADE_CLI_PATH" apple record-start --overlays on --label "signup" --text
"$ADE_CLI_PATH" apple record-stop --keep --text
"$ADE_CLI_PATH" apple record-list --text
"$ADE_CLI_PATH" apple record-delete --id <id> --text
```

1. **Your input starts a recording; the user's never does.** Any input from
   the CLI, an agent action or a semantic action counts as evidence and starts
   one automatically, tagged `auto`. Input from the desktop pane is stamped as
   the user's and starts nothing. When the user asked for no recordings, opt
   out: `--no-record` on one command, `apple auto-record off` for the lane
   (`auto-record on` and `auto-record` to check), or the user's "Record agent
   input" switch in Settings ▸ Apple Development for the whole Mac. A
   recording that is already running still sees the input.
2. It stops at the end of your turn, or after five minutes, whichever is
   first. `record-start` during an auto recording converts it to manual with
   no gap. A manual recording stops itself after five minutes of real time
   (`stopReason: "cap"`), or after two minutes with no input (`"idle"`), and
   files as proof; `--max-seconds <n>` sets a shorter limit. Still call
   `record-stop` when you are done.

   When it stops, the recording becomes a demo: still time is cut, waits play
   faster, tap rings are drawn, and the file ends under 10 MB. The camera
   does not zoom on a phone; pass `record-start --zoom` only when the user
   asks for zoom. Mark each step with `ade proof step "<what happens
   next>"`: a caption in the video and a chapter in ADE's player.
   `record-stop` reports `durationMs` (the demo), `wallDurationMs` (real time)
   and `idleCutMs`. Pass `--plain` only when the user asks for the recording
   as it was recorded.
3. It files itself as proof on stop. There is **no auto-delete**; recordings
   accumulate until the user clears them (the user may have watched one you
   never cited). Opt out up front instead of making ones nobody wants.
4. You may delete a recording you own. Anything else is
   `APPLE_RECORDING_PINNED`.
5. A second chat gets `APPLE_OWNED_BY_OTHER_SESSION` with the owning chat,
   lane and age.
6. If recording fails, say so. Never attach an older recording or a file you
   did not just record.

Overlays, meaning tap rings and typed-text badges, land in the saved file only
and never on a live viewer. Secure text is never badged.

## Live view

```bash
"$ADE_CLI_PATH" apple stream-start --fps 60 --text
"$ADE_CLI_PATH" apple stream-start --scale-factor 0.5 --bitrate-kbps 2500 --text
"$ADE_CLI_PATH" apple stream-status --text
"$ADE_CLI_PATH" apple stream-stop --text
```

`stream-status` reports the shape and never the address or the token. A status
of `running: true` means the capture is alive, not that a picture is arriving.

## Device settings, log, previews

```bash
"$ADE_CLI_PATH" apple appearance dark --text
"$ADE_CLI_PATH" apple accessibility reduce-motion on --text
"$ADE_CLI_PATH" apple location 37.7749 -122.4194 --text
"$ADE_CLI_PATH" apple permission grant photos --bundle-id <id> --text
"$ADE_CLI_PATH" apple push --bundle-id <id> --title Hi --body "You have mail" --text
"$ADE_CLI_PATH" apple log-start --bundle-id <id> --text   # then: apple log --text
"$ADE_CLI_PATH" apple preview-current --text
```

`log-start` keeps the app's own process (its installed executable) and the
bundle id's `os_log` subsystem. If the app logs under another subsystem, add
`--subsystem <prefix>`; `--process <name>` follows another process. `print()`
never reaches the device log. When no app line has arrived after a few
seconds, `apple log` says so with a hint. ADE's own rows name the device they
drove, so the log of one device leaves out taps on the lane's other devices.

Also `content-size`, `status-bar`, `open-url`, `relaunch`, `terminate`,
`uninstall`, `app-state`, `log`, `log-stop`, `preview-status`, `previews`,
`preview-match`, `preview-ensure`, `preview-render`.

## What the user sees in the desktop

Worth knowing, because it changes what is running under you.

- The tool is **Apple Development**, one pane inside the Work tools pane.
- Closing its **tab** powers the device off, behind a confirmation when the
  device is booted. Minimising the tools pane leaves it running and shows a
  floating preview.
- The rail carries Home, Rotate, Inspect, Screenshot, Record, the 3D/Flat
  view toggle, Tools and More. The drawer has four groups: Device, App,
  Capture and Preview Lab.

## Ownership

One chat owns a simulator session at a time. A second launch fails with
`APPLE_OWNED_BY_OTHER_SESSION`.

- Ownership releases when the owning chat is deleted or archived.
- The guard is cooperative: `shutdown --force`, `launch --force` and
  `claim --ignore-ownership` get through. Ask before you evict another chat.
- `claim --lane <lane-id>` attaches a running session to a lane.

## Gotchas

- `APPLE_NO_INSTALLED_SIMULATORS` — no installed runtime. Point at Xcode ▸
  Settings ▸ Components. Never try to download one.
- `APPLE_HELPER_UNAVAILABLE` — no usable helper on that Mac: missing (the message lists where ADE looked) or from another ADE version. Tell the user; updating ADE.app or the brain fixes it.
  `status` → `tools.helper.present` is the check.
- `APPLE_STREAM_NOT_RUNNING` — `frame` needs a live stream; use `screenshot`.
- `APPLE_DEVICE_OFF` — the lane's device is powered off, and watching never
  boots it. `apple start` (or `stream-start`) powers it on.
- `APPLE_ROTATE_NOT_ADOPTED` — the device turned and the app on screen did
  not. Launch a landscape-capable app first; it is not a fault to report.
- `APPLE_ROTATE_UNMEASURABLE` — the screen could not be read, so the rotation
  is unconfirmed either way. Check the device is still booted.
- `APPLE_BUTTON_UNSUPPORTED` — that button has no helper or `simctl`
  equivalent. Today: `shake`.
- `APPLE_DEVICE_ATTACHED_NOT_DELETABLE` — `device-delete` without `--force` on
  an attached simulator. `--force` detaches; it does not delete.
- `APPLE_DEVICE_EXISTS` — this lane already owns a device. Use it, remove it
  first, or add another model beside it with `device-create --extra`.
- `APPLE_EXTRA_DEVICE_LIMIT` — the lane already has 2 extra devices. Delete
  one with `device-delete --device <udid>`.
- `APPLE_DEVICE_IS_EXTRA` — that command needs the lane's own device and you
  named an extra. For a build on the extra, `install --device <udid>
  --launch`; or run the `device-promote --device <udid>` the message prints
  to make the extra the lane's device.
- `APPLE_LANE_DEVICE_BUSY` — `device-promote` found the lane's device
  streaming, recording, testing, launching or leased. Finish or stop that, then
  promote again.
- `APPLE_DEVICE_NOT_LANE_OWNED` — you named a simulator this lane does not
  hold, or another lane holds it. Do not look for a way around it. Run
  `ade apple start` to get the lane's own, or attach it first if the user named it.
- `APPLE_RUNTIME_NOT_INSTALLED` — the runtime or model you named is not on
  this Mac. The message lists what is; ADE never downloads one.
- `APPLE_RUNTIME_ALREADY_INSTALLED` — `runtimes install --version` named a
  runtime the Mac has. The message names the version the missing models need.
- `APPLE_BUILD_BUSY` — a launch, a test run or an `install` is already
  building in the lane's DerivedData. Wait for it, then run again.
- `APPLE_WINDOWING_UNAVAILABLE` — `window` found no resizable window; see
  "iPad windows".
- `APPLE_TEST_RUN_BUSY` — another `apple test` is running. Wait and run again.
- `IOS_SIMULATOR_TARGET_ROOT_MISMATCH` — re-run `"$ADE_CLI_PATH" apple apps --text`.
- `IOS_SIMULATOR_NO_BUILDABLE_TARGET` — pass `--target-id` or `--bundle-id`
  only when you deliberately want the installed app.
- `screenshot --out` and `frame --out` must land inside the build root (the
  lane worktree). A relative path resolves there (`--out .ade/tmp/shot.png`);
  `/tmp` is refused with `IOS_SIMULATOR_OUT_PATH_OUTSIDE_ROOT`.
- `--text` reads two ways. A bare `--text` is ADE's output mode;
  `--text-match <value>` is the element query's substring match.
