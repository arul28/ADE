---
name: ade-apple
description: Use this skill when you need to see an iOS or SwiftUI change actually running on a simulator — finding or creating the lane's device, booting and streaming it, driving it by element query, screenshotting, recording, capturing proof, or rendering a SwiftUI preview — via `ade apple`.
---

# ADE Apple Development

This skill is for iOS and SwiftUI apps. For a macOS app, a dev Electron app or
a web page, the **ade-computer-use** skill picks the right surface.

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
| Type, then press Return | `"$A" apple type "reddit" --submit --text` |
| Press one key | `"$A" apple key return --text` (also `tab`) |
| Wait for something to appear | `"$A" apple wait-for-element --label "Cancel" --timeout-ms 8000 --text` |
| Which app is in front | `"$A" apple foreground --text` |
| What is on screen | `"$A" apple snapshot --text` |
| Go home / app switcher | `"$A" apple button home --text` / `"$A" apple button app-switcher --text` |
| Close an app (no gesture) | `"$A" apple terminate --bundle-id com.apple.mobilesafari --text` |
| Show the device to the user | `"$A" apple show --text` (tools pane) or `--floating` |

- Right after `relaunch`, `foreground` can still say `null` for a moment.
  Wait for an element of that app instead of checking at once.
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
  (`clone` or `attached`), and its `laneId`.
- `tools.helper` (`present`, `path`, `version`) is the check when every device
  call fails at once.

## "Start the app on a simulator" is one command

```bash
"$ADE_CLI_PATH" apple launch --follow --open-drawer --text
```

`launch` does the whole chain: find or clone the lane's device, boot it,
resolve the target, **build it with xcodebuild**, install it, start it, and
claim the drawer session. Add `--open-drawer` when a human asked to watch.
`--follow` announces the wait up front for a cold build.

So you do **not** run `xcodebuild` by hand to put an app on a screen, and you
do not need to know the scheme. Run `"$ADE_CLI_PATH" apple apps --text` first only
when you must choose between several targets, then pass `--target <id>`.

Use `--no-build` when the app is already installed and you only want it in
front. Use `relaunch` or `terminate` for an app that is already there.

## Use this lane's own device

**Use this lane's own device. Never attach a simulator you did not create;
`ade apple device-create` (or `start --create`) gives the lane its own.**

`start` with no arguments does this for you: when the lane has no device it
clones the project's last-used simulator (never a running one), boots the
clone, and streams it. Other booted simulators in `apple devices` belong to
someone else: another lane, an `xcodebuild test` run, or the user. ADE refuses
`start --udid` and `device-attach` from an agent for any simulator this lane
does not already hold, with `APPLE_DEVICE_NOT_LANE_OWNED`. The same goes for
`--device <udid>` on any other command: every command runs on this lane's
device, and with no device yet it tells you to run `ade apple start`.

**A busy device is not a blocker, and it is not a reason to ask a human.**
Make your own with `start` or `start --create <sourceUdid>`. It takes seconds
(see "The lane's device" for why).

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
have. **ADE never downloads a runtime.** With none installed you get
`APPLE_NO_INSTALLED_SIMULATORS` — tell the user to open Xcode ▸ Settings ▸
Components.

Two facts that decide what you should do:

- A **runtime** is the iOS image. It is the large download, one per iOS
  version, and ADE will not fetch one.
- A **device** is an instance made from a runtime. Creating one copies no iOS,
  so it is cheap. A device that is `Shutdown` is installed and ready — it needs
  a boot, which takes seconds, not an install.

So "no device free" is almost never true: one runtime serves any number of
devices, and a new one is a folder of app data, not another copy of iOS.

```bash
"$ADE_CLI_PATH" apple device-list --installed --text   # what a picker shows
"$ADE_CLI_PATH" apple device-list --text               # the one this lane owns ($ADE_LANE_ID)
"$ADE_CLI_PATH" apple start --text                     # clone one if the lane has none, boot, stream
"$ADE_CLI_PATH" apple start --create <sourceUdid> --text   # clone a specific (stopped) simulator
"$ADE_CLI_PATH" apple stop --text                      # power the device OFF
```

- `start` is the one-step bring-up: clone when the lane has no device, boot it
  if it is off, wait for the boot, then stream. Prefer it. `start --udid` works
  only for the device this lane already holds.
- `stop` powers the device **off**. `shutdown` only ends this chat's session
  and leaves the simulator running — the two are not the same, and a verb named
  `stop` that left a booted device behind was a real bug.
- `device-create` and `device-attach` never boot. `device-delete` removes a
  clone and refuses an attached device unless `--force`, which only detaches.
  Like `stop`, it is refused while another chat is driving the device.
- A clone is deleted when the lane is archived. ADE never deletes a simulator
  it did not create.
- Deleting an installed simulator from the list is the user's call, made in
  the desktop picker. ADE refuses it from an agent; do not try.

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
- A `ref` names its own tier. `id:` and `component:` survive a re-render;
  `pos:` survives nothing, so ask for an accessibility identifier instead.
- `wait-for-element` replaces a sleep. Add `--gone` to wait for a disappearance.
- Fall back to coordinates only when no query matches: `tap`, `drag`, `swipe`,
  `scroll`, `select`.
- `type` and `key` act on the focused field, so tap the field first.
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
  (`pointWidth` × `pointHeight`); the example is an iPhone 16 Pro (402 × 874).
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
- **every screenshot** you take.

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
   the user's and starts nothing.
2. It stops at the end of your turn, or after ten minutes, whichever is first.
   `record-start` during an auto recording converts it to manual with no gap.
   A manual recording you own stops itself after ten minutes of real time
   (`stopReason: "cap"`) and files as proof; `--max-seconds <n>` changes it.
   Still call `record-stop` when you are done.

   Still screens are cut: a still longer than 2 s keeps 0.75 s in the video.
   `record-stop` reports `durationMs` (video), `wallDurationMs` (real time)
   and `idleCutMs`. Pass `--keep-idle` when the waiting itself is the point.
3. It files itself as proof on stop. There is **no auto-delete**; recordings
   accumulate until the user clears them.
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
"$ADE_CLI_PATH" apple log-start --bundle-id <id> --text
"$ADE_CLI_PATH" apple preview-current --text
```

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
- `APPLE_HELPER_UNAVAILABLE` — the helper binary is missing from this install.
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
- `APPLE_DEVICE_EXISTS` — this lane already owns a device. Use it, or remove it
  first.
- `APPLE_DEVICE_NOT_LANE_OWNED` — you named a simulator this lane does not
  hold. Do not look for a way around it. Run `ade apple device-create` or
  `ade apple start` to get the lane's own.
- `IOS_SIMULATOR_TARGET_ROOT_MISMATCH` — re-run `"$ADE_CLI_PATH" apple apps --text`.
- `IOS_SIMULATOR_NO_BUILDABLE_TARGET` — pass `--target-id` or `--bundle-id`
  only when you deliberately want the installed app.
- `screenshot --out` and `frame --out` must land inside the build root.
- `--text` reads two ways. A bare `--text` is ADE's output mode;
  `--text-match <value>` is the element query's substring match.
