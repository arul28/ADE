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

## Detail files

Rarely needed detail lives next to this file. Read one when its topic comes
up (or `ade skill show ade-apple references/<file>`):

| Topic | File |
| --- | --- |
| Extra devices, runtimes, device lifecycle, idle power-off, per-device leases, the desktop pane | `references/devices-and-runtimes.md` |
| iPad windows: `apple window` layouts, sizes, moves | `references/ipad-windows.md` |
| Rotation, iPhone Duo folding, `duo-skill`, 3D renders | `references/rotation-fold-and-render.md` |
| Element query edge cases; closing an app with the App Switcher | `references/driving-details.md` |
| `apple test` output, `--only`, DerivedData | `references/tests.md` |
| Why captures go through `ade apple`; external drives; how a recording becomes a demo | `references/recording-and-proof-details.md` |
| Device settings, the device log, previews, live view flags | `references/device-settings-and-logs.md` |
| Every error code and what to do | `references/troubleshooting.md` |

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
  simpler and faster than several agents taking turns. When agents truly
  must drive the same device in parallel, take a `lease` before a run of
  builds, rotates and shots (it queues behind whoever has it) and release it
  after. It is advisory, so it only works if every agent uses it.
  Device commands do not renew it: renew with the token before `--ttl` ends.
  It also ends when its chat is archived or deleted.
  Each device has its own lease. Tokens, renewing, and `--holder` for
  subagents: `references/devices-and-runtimes.md`.
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
A project that has only a `project.yml` (XcodeGen) is generated before the
build when `xcodegen` is installed there; if it is not, the error says how.
From a machine with no simulator (Windows, Linux), the same commands take
`--machine "<Mac>"`; see ade-computer-use `references/other-machines.md`.

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
  extra device: `device-create --extra --device-type "<model>"` (at most 2),
  then reach it from any command with `--device <udid|name>`. An extra cannot
  stream, record, `launch` or run tests. Extras, `install --device` and
  `device-promote`: `references/devices-and-runtimes.md`.
- You may attach an installed simulator only when the user names it
  (`device-attach --simulator <name>` or `start --udid <udid>`). ADE refuses a
  simulator another lane holds, with `APPLE_DEVICE_NOT_LANE_OWNED`.
- `--device <udid>` on any other command must be this lane's device or one of
  its extra devices. With no device yet, the command tells you to run
  `ade apple start`.

**A busy device is not a blocker, and it is not a reason to ask a human.**
Make the lane's own with `start`. It takes seconds (see "The lane's device").

This is worth saying plainly because the failure looks reasonable from the
inside: you find a booted simulator, the guard tells you another chat owns it,
and stopping to ask seems polite. It is not. It blocks the work for no reason
and hands the human a decision they should never have been given.

## Tests run on the lane's device

```bash
"$ADE_CLI_PATH" apple test --scheme <scheme> --text
"$ADE_CLI_PATH" apple test --target <id> --only ADETests/SyncTests --text
```

`apple test` runs `xcodebuild test` on this lane's device, one run at a time
on the Mac. A failing test comes back as `passed: false` with the failures;
it is not an error. Output, `--only` names and DerivedData:
`references/tests.md`.

Do not run `xcodebuild test` by hand against a simulator you made. If you must
run `xcodebuild` yourself, pass `-derivedDataPath .ade/cache/ios-simulator/DerivedData`
from the lane worktree, never `/tmp` or `~/Library/Developer/Xcode/DerivedData`.

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

A runtime (the iOS image, about 8 GB) is a download; a device made from one
is cheap, and a device that is `Shutdown` only needs a boot. So "no device
free" is almost never true. Runtimes and devices in full:
`references/devices-and-runtimes.md`.

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
- `device-create`, `device-attach`, `device-delete`, `device-detach`, what
  ADE deletes with the lane, the 30-minute idle power-off, and runtime naming:
  `references/devices-and-runtimes.md`. Closing the Apple Development tab in
  the desktop powers the device off.
- Deleting an installed simulator from the list is the user's call, made in
  the desktop picker. ADE refuses it from an agent; do not try.

## iPad windows

On an iPad in windowed mode, `apple window` lays out the app in front and
reads the frame back (`--left`, `--split`, `--fill`, `--size 600x800`,
`--move 0,0`, …). The answer says `applied` and exits 1 when the window did
not land; read the `reason`. Detail: `references/ipad-windows.md`.

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
- `fill-element` reads the field back and prints `typed: verified`,
  `not-seen` (the field does not hold the text: focus never arrived, or the
  app dropped it; check a screenshot) or `unknown` (a secure field, or the
  field moved). `type` prints `focus none` when no element had keyboard
  focus, so the text most likely went nowhere: tap the field first.
- Several matches, `(inferred)` tab rows and a `truncated` snapshot:
  `references/driving-details.md`.
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
  `portrait-upside-down`, `landscape-right`). **Read the answer.**
  `applied: false` with `reason: APPLE_ROTATE_NOT_ADOPTED` means the app in
  front kept its own orientation, not a broken simulator: put the app you
  are testing in front before you rotate. iPhone Duo folding (`fold`,
  `posture`, which way the inner display runs), `duo-skill` and 3D renders
  (`render`): `references/rotation-fold-and-render.md`.
- A simulator that is signed in and paired with an ADE machine gets that
  machine's real push notifications, and their banners land on screenshots.
  Capture fixtures on a device that was never paired (a fresh lane device or
  an extra device is not), or sign the app out first.

Agent launches stay in the background; `apple show` brings the device up at
any time.

### Close an app the way a person does

Bottom-edge swipes do not work. Use the App Switcher (`button app-switcher`,
check it opened with a screenshot, then a fast swipe up on the card), or
`apple terminate --bundle-id <id>`. Steps and coordinates:
`references/driving-details.md`.

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
human is looking at. Why a `simctl` capture handed to `proof attach` is not
proof: `references/recording-and-proof-details.md`.

**Projects on an external drive:** `ade apple` captures fine there. If you
ever run `simctl io` by hand, write to `/tmp`. Detail:
`references/recording-and-proof-details.md`.

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

   When it stops, the recording becomes a demo (still time cut, tap rings,
   under 10 MB). Mark each step with `ade proof step "<what happens next>"`.
   Zoom, `--plain` and the durations `record-stop` reports:
   `references/recording-and-proof-details.md`.
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

`start` already streams. `stream-start` (`--fps`, `--scale-factor`,
`--bitrate-kbps`), `stream-status` and `stream-stop`:
`references/device-settings-and-logs.md`.

## Device settings, log, previews

`appearance`, `accessibility`, `location`, `permission`, `push`,
`log-start` / `log`, `content-size`, `status-bar`, `uninstall`, `app-state`
and the `preview-*` commands: `references/device-settings-and-logs.md`.

## Ownership

One chat owns a simulator session at a time. A second launch fails with
`APPLE_OWNED_BY_OTHER_SESSION`.

- Ownership releases when the owning chat is deleted or archived.
- The guard is cooperative: `shutdown --force`, `launch --force` and
  `claim --ignore-ownership` get through. Ask before you evict another chat.
- `claim --lane <lane-id>` attaches a running session to a lane.

## Gotchas

Every error code and what to do: `references/troubleshooting.md`. These
change what you do on the common path:

- `APPLE_DEVICE_NOT_LANE_OWNED` — you named a simulator this lane does not
  hold, or another lane holds it. Do not look for a way around it. Run
  `ade apple start` to get the lane's own, or attach it first if the user named it.
- `screenshot --out` and `frame --out` must land inside the build root (the
  lane worktree). A relative path resolves there (`--out .ade/tmp/shot.png`);
  `/tmp` is refused with `IOS_SIMULATOR_OUT_PATH_OUTSIDE_ROOT`.
- `--text` reads two ways. A bare `--text` is ADE's output mode;
  `--text-match <value>` is the element query's substring match.
