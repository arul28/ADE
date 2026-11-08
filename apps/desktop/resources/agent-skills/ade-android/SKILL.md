---
name: ade-android
description: Use this skill when you need to see an Android app actually running on an emulator — finding or creating the lane's Android emulator, booting it, building and installing the app with Gradle or an APK, driving it by element query, reading logcat, screenshotting, recording, capturing proof, folding a foldable, rendering Compose previews, running instrumentation tests, or setting up the Android SDK — via `ade android`.
---

# ADE Android Development

Drive the lane's Android emulator with `"$ADE_CLI_PATH" android <command>`.
`$ADE_CLI_PATH` is the CLI of the ADE that launched you and already targets
its brain, so your calls and the desktop's Android tool share one emulator. A
bare `ade` goes through PATH and can reach a different ADE.

Each lane has one emulator, on the machine that runs the lane. It works on
macOS, Windows and Linux. ADE starts it without a window and shows it in the
Android tool of the Work pane.

## Five rules before your first command

- **Always call `"$ADE_CLI_PATH"`, never a bare `ade`.** Do not add
  `--socket`: `"$ADE_CLI_PATH"` already names the right brain.
- **Start emulators only with `android start`, never with the raw
  `emulator` binary (`emulator -avd …`).** `android start` checks the
  machine's memory first and refuses (`ANDROID_LOW_MEMORY`) when another
  emulator would make it swap; each emulator takes 5–9 GB, and a machine
  with too many froze. ADE also stops the emulators it starts once nobody
  uses them. An emulator started by hand skips both: it opens a window on
  the user's machine, still counts against the memory limit, and ADE never
  stops it. The lane has its emulator: `android start` boots it.
- **Never run `adb kill-server`, `adb emu kill` or `adb reboot`.** One adb
  server serves every lane's emulator and every live view. Killing it cuts
  them all off. To stop the lane's emulator, use `android stop`.
- **Never make or delete an AVD with `avdmanager`.** Use
  `android device-create` and `android device-detach`, so the lane knows
  its device and other lanes do not take it.
- **Check each step before you report it.** A tap, swipe, button or type
  that returns `ok` only means ADE sent the input. After each step that
  matters, confirm it with `android assert-visible`,
  `android wait-for-element` or `android snapshot`. Report only what you
  confirmed. Before `record-stop`, confirm the final state, so the video
  ends on it.

Plain `adb shell …` reads (`dumpsys`, `getprop`, `pm list`) are fine, with
`-s <serial>` (the serial is in `android status`).

## Start here

```bash
"$ADE_CLI_PATH" android status --text
```

- `sdk: not found`, or a tool that is not available: the SDK is not set up.
  Run `android sdk status --text` and tell the user what it says. Only the
  user can accept Google's licences, so only the user can install it, in the
  ADE desktop app: the setup card in the Android tool, or Settings › Android
  devices. Never accept a licence for them.
- `state: none`: the lane has no emulator yet. Make one:
  `android device-create --profile medium_phone --text`
  (`android devices --profiles --text` lists the profiles), or hold one of
  the user's AVDs that no lane holds: `android device-attach --avd <name>`.
- `state: off`: `android start --text` boots it (about 20 s; a new AVD's first
  boot can take a minute). `ANDROID_LOW_MEMORY` means the machine is short
  of memory: stop an emulator you no longer need (`android stop`), or tell
  the user. Ask the user before `android start --force`.
- `state: booted`: drive it.

ADE stops an emulator it started that nobody has used for 20 minutes
(`keep running: no` in `status`). It boots again with `android start`. If you
need it up through a long pause, run `android keep-running on --text`, and
`off` when you are done.

`status` also shows `capabilities`: whether this machine can record, read the
UI tree (and with which tool), read logcat and build with Gradle, and the
`jdk` that Gradle builds use.

## Common tasks

`A="$ADE_CLI_PATH"`. Points are device pixels, the same pixels as the
screenshot and the snapshot.

| Task | Command |
|---|---|
| Build, install and open the lane's app | `"$A" android launch --gradle --text` (`--module app`, `--variant debug`) |
| Build and install only | `"$A" android install --gradle --text` |
| Install an APK | `"$A" android install --apk app/build/outputs/apk/debug/app-debug.apk --text` (inside the lane worktree) |
| Open an installed app | `"$A" android launch --package com.example.app --text` (`--activity .MainActivity`) |
| Open it with intent extras | `"$A" android launch --package <name> --extra user=ada --extra count=3 --text` (true/false, a number or text is typed; `--extra-string k=v` keeps text; `am start` options: `--launch-arg <word>` or `-- <words>`) |
| Restart an app | `"$A" android relaunch --package <name> --text` (takes the launch's `--activity` and extras) |
| Is it installed, running, in front | `"$A" android app-state <name> --text` (pid and version too) |
| Which app is in front | `"$A" android foreground --text` (`--wait 10` asks again until one is; `--package <name>` waits for that one and exits 1 when it does not come) |
| Stop an app / remove it | `"$A" android terminate --package <name> --text` / `uninstall --package <name>` |
| Which apps are on it | `"$A" android apps --text` |
| Open a URL or deep link | `"$A" android open-url "myapp://item/42" --text` |
| What is on screen | `"$A" android snapshot --text` |
| Tap a control | `"$A" android tap-element --text "Sign in" --text` (or `--ref`, `--label`, `--identifier`) |
| Long press a control | `"$A" android tap-element --label "Photo" --hold-ms 1000 --text` |
| Type into a field | `"$A" android fill-element --identifier email --value "ada@example.com" --text` |
| Wait for a screen | `"$A" android wait-for-element --text "Welcome" --timeout-ms 20000 --text` (`--gone` to wait for it to leave) |
| Check a result | `"$A" android assert-visible --text "Hello, Ada" --text` (exits 1 when it is not there) |
| Scroll a list | `"$A" android scroll --direction down --text` (`--amount 0.6`, `--anchor-x/-y`) |
| Drag and drop | `"$A" android drag 200 900 800 900 --duration-ms 800 --text` |
| Back, home, recents | `"$A" android button back --text` |
| Press a key | `"$A" android key tab --text` (return, escape, delete, space, arrows, home, end, page-up/-down, f1-f12, a letter or digit); with modifiers `key ctrl+a` or `key a --ctrl` (`--shift`, `--alt`, `--meta`) |
| Type and submit | `"$A" android type "coffee" --submit --text` (Enter after the text; `type --submit` alone presses Enter) |
| What is at a point, and its code | `"$A" android inspect 540 1200 --text` (the element, and its file:line in the lane's Kotlin/Java/XML when its id, test tag or text names it; `--screenshot` adds a crop) |
| One quick picture, not proof | `"$A" android frame --text` (`--out <path>`) |
| Clean up devices | `"$A" android device-cleanup --dry-run --text` shows what it would do; `--power-off-idle` powers off your lane's emulator now when it is idle |
| Logs of the app | `"$A" android log --package <name> --level warn --text` (then `--since <cursor>` for newer lines) |
| Dark mode, location, a permission | `"$A" android appearance dark`, `android location 37.77 -122.42`, `android permission grant camera --package <name>` (camera, location, microphone, notifications, contacts, photos, calendar, or `android.permission.<NAME>`) |
| Offline, low battery, big text, no animations | `"$A" android settings --airplane on` (one change per call: `--wifi`, `--data`, `--battery 5`, `--charging off`, `--text-size largest`, `--display-size large`, `--animations off`, `--show-taps on`, `--layout-bounds on`); `"$A" android settings` reads them all |
| Turn the device | `"$A" android rotate landscape-left --text` (`portrait`, `portrait-upside-down`, `landscape-left`, `landscape-right`; `landscape` is `landscape-right`) |
| Accessibility | `"$A" android accessibility bold-text on` (`increase-contrast`, `bold-text`, `invert-colors`, `grayscale`, `color-correction`, `talkback`); `"$A" android settings` reads them back |
| Status bar for screenshots | `"$A" android status-bar --time 9:41 --text` (`--data-network wifi\|5g\|lte\|4g\|3g\|e\|g`, `--wifi-bars 0-4`, `--cellular-bars 0-4`, `--battery-level 0-100`, `--battery-state charging\|charged\|discharging`); `status-bar --clear` ends it |
| Clear the location | `"$A" android location --clear --text` (the GPS goes back to the emulator's default point) |
| Google Play screenshots | `"$A" android play-store-shots --text`: one PNG per screen at Play's rules (a foldable: the cover screen shut, the inner screen open), filed as proof |
| Split screen, free windows | `"$A" android window split --package <a> --with <b> --text` (`left`, `right`, `top`, `bottom`, `swap`, `freeform`, `size --size 1200x900`, `move --move 100,200`, `fill`, `close`, `status`); a large screen only, exits 1 when Android did not make the change |
| Screenshot (filed as proof) | `"$A" android screenshot --caption "<what it shows>" --text` |
| Video proof | `"$A" android record-start --label "<what>" --text`, do the steps, then `"$A" android record-stop --text` |
| Proof bundle | `"$A" android proof-bundle --caption "<what>" --package <name> --text` (screenshot, elements, log, meta) |
| Show the emulator to the user | `"$A" android show --text` |
| Fold a foldable / read the hinge | `"$A" android fold half --text` (`open`, `closed`, or `--angle 0-180`) / `"$A" android posture --text` |
| Render Compose previews (no emulator) | `"$A" android preview list --module app --text`, then `"$A" android preview --module app --text` (all, up to 24) or `--fqn <name>` for each one |
| Run instrumentation tests | `"$A" android test --text` (`--class com.example.LoginTest`, `--method signIn`); exits 1 when a test fails |

## Elements

`android snapshot --text` lists the elements worth aiming at, each with a
`ref`. A ref is a name such as `id:email`, `label:search` or `text:sign-in`
(the first name no other element on screen shares), or the role and a path
when the element has no name. Pass it back with `--ref <ref>`. The other
queries:

- `--identifier <id>`: the Android resource id (`email`, or the full
  `com.example:id/email`).
- `--label <text>`: the content description (what TalkBack reads).
- `--text <text>`: the shown text; a part of it is enough.
- `--role <role>`: the class name, short or full, in any case: `Button`,
  `EditText`, `TextView`, `ImageView`, `Switch`, `CheckBox`, ...
- `--index <n>`: which match, when several match (0 is the first).

When nothing matches, the error lists named elements that are on screen.
`fill-element` clears the field, types, and reads the field back: `the field
does NOT show the text` means the keyboard dropped characters (most non-ASCII
characters have no key on the emulator keyboard).

A snapshot is kept for 5 s and dropped after any input, so a read right after
a tap is fresh. `--fresh` reads again anyway.

## Apps

- `--gradle` runs the lane's Gradle wrapper (`gradlew`) with
  `install<Variant>` for the module (default `app`, `debug`). The first build
  downloads Gradle and the Android plugin and can take minutes; later builds
  take seconds. A failed build prints the end of the Gradle output: read it.
- ADE gives the build `JAVA_HOME` (the `jdk` in `status`), `ANDROID_HOME`
  and `ANDROID_SDK_ROOT`. Use `--gradle`, not `./gradlew` in your shell: your
  shell can have no JDK and no SDK path ("Unable to locate a Java Runtime",
  "SDK location not found").
- On an emulator ADE made for the lane, `uninstall` removes any app. On the
  user's own AVD (attached), it removes only apps ADE installed, and ADE
  removes those again when the lane lets the AVD go.

- The 20-minute idle stop counts any call on the lane's emulator, input on
  the device itself, another viewer, a recording, a lease and a test run as use
  (`ADE_ANDROID_IDLE_POWER_OFF_MINUTES`, 0 turns it off). The lane keeps its
  device: `"$A" android start` boots it again, and `status` says when it was
  powered off. ADE never powers off an emulator it did not start. Take a
  `lease`, or `keep-running on`, when you need it to stay up between turns.
- `open-url` with an `http(s)` URL that opens in Chrome skips Chrome's first
  run ("Welcome to Chrome" and the notifications prompt), once per boot.
- You cannot start or stop the live view: it belongs to the user (its start
  hands out the stream's token). `frame` and `screenshot` do not need it.

## Recordings and proof

- `screenshot`, `record-stop` and `proof-bundle` file to this chat's proof
  drawer by themselves. Do not capture with `adb exec-out screencap` or
  `adb shell screenrecord`: those files have no owner and nobody sees them.
- `screenshot` and `record-stop` print a `cite:` line. Paste it to show the
  user that proof. `screenshot --no-proof` writes the file only.
- Your input records itself. A tap, swipe, type, key, button, open-url,
  long-press, drag, scroll, tap-element or fill-element starts a recording
  when none runs, and the recording stops when your turn ends (or after
  2 minutes with no change). The stop files one demo video: idle time cut,
  tap rings, typed-text badges (never a password), `ade proof step`
  chapters, under 10 MB. A rotation stays one video.
- Turn it off for one command with `--no-record`, or for the lane with
  `android auto-record off` (`on`, `status`). The user can turn it off for
  the machine in Settings › Android devices.
- `record-start --label "<what>"` starts a recording you stop yourself; it
  also keeps an automatic one that runs. `--plain` files the video as
  recorded, `--zoom` follows the taps. A recording stops at `--max-seconds`
  (up to 300), after 2 minutes with no change, and when the emulator stops.
- `record-stop --discard` keeps nothing.

## Foldables and Compose previews

- `android fold` works only on a foldable AVD (`android devices --profiles`
  lists the Pixel Fold and Galaxy Z Fold profiles). It waits until Android
  shows the screen that goes with the fold: the cover screen below 30°, the
  inner screen above. `settled: no` means Android was still changing; read
  `android posture` again. After a fold, take a new `snapshot`: the screen
  size and the elements change.
- `android preview` builds the module with Gradle and draws each `@Preview`
  to PNG with Google's Android CLI. It needs no emulator, so use it to check
  a Compose change fast, before a full build and launch. `--module` is the
  module's folder (`app`, `feature/home`), never the project's root. Each
  image is filed as proof; `Read` the printed path to look at it. A preview
  with no image prints `failed:` with the reason.
- Without the Android CLI, `preview` stops with `ANDROID_TOOL_MISSING`. Only
  the user installs it (the setup card's Android CLI part), so ask them.

## Taking turns

One agent should drive the emulator; other agents hand it work. When agents
must share it, take a lease first:

```bash
"$A" android lease --wait 300 --holder "<your name>" --text    # prints a token
"$A" android lease release --token <t> --text
```

The lease is advisory: it works only when every agent uses it. Renew with
`lease renew --token <t>` before `--ttl` ends. It ends when its chat ends.

## A second device beside the lane's

The lane's device is the one `status` shows: it streams, records, runs the
tests, and takes every verb with no `--device`. To check the app on another
form factor (a tablet beside the phone), add an extra device instead of
replacing the lane's one:

```bash
"$A" android device-create --extra --catalog pixel-tablet --text   # boots beside the lane's device
"$A" android launch --gradle --device <avd> --text                 # install and open it there
"$A" android device-promote --device <avd> --text                  # make it the lane's device
"$A" android device-detach --device <avd> --text                   # remove it (deletes the AVD)
```

- `--device <avd>` works on `start`, `stop`, `install`, `launch` and
  `device-detach`. `status` lists the extras with their AVD names.
- Each running emulator holds 2 to 5 GB of RAM. A lane may hold 2 extras.
  Stop an extra you are done with: `android stop --device <avd>`.
- To screenshot, tap or snapshot an extra, promote it first. The old device
  stays as an extra, still running. A promote is refused
  (`ANDROID_LANE_DEVICE_BUSY`) while the lane's device records, streams to
  the user's open view, runs tests or an install, or another agent holds the
  lease: wait, do not force it.

## Another machine

`--machine <name>` runs the command on that machine. Without `--lane`, the
emulator there works for this chat's work copy (made at your commit, which
must be on origin). `install`/`launch` with `--gradle` or `--apk` send your
uncommitted changes first. An APK that git ignores does not travel: use
`--gradle`. `preview` and `test` send them too. Screenshots, recordings,
proof bundles and preview images are filed in this chat's proof drawer.

## The SDK

`android sdk status --text` shows each part (found, or missing and its
size), the folder, the free space and the licences a missing part needs.
`android sdk licenses --text` prints the licence text. An agent may read
both. Installing, cancelling an install and choosing the SDK folder are the
user's, in the ADE desktop app: the setup card in the Android tool, or
Settings › Android devices. `sdk install`, `sdk use` and `sdk cancel` refuse
every terminal, yours too, so ask the user.

## Errors

Each error prints its next step. The common ones:

| Code | What to do |
|---|---|
| `ANDROID_NOT_RUNNING` | `android start`, or `device-create` when the lane has none |
| `ANDROID_ADB_UNAUTHORIZED` | adb refused the device (the error says why). You cannot restart the adb server: every device on it loses its connection, so ADE refuses an agent's `--restart-adb`. Ask the user to press **Restart adb and start** in the Android pane, or to run `ade android start --restart-adb` in a terminal on that machine. If the error says ADE already restarted the server, ask them to cold boot the AVD. Never run `adb kill-server` yourself |
| `ANDROID_ELEMENT_NOT_FOUND` | `android snapshot --text`, then aim again |
| `ANDROID_WAIT_TIMEOUT` | look at the screen; pass a longer `--timeout-ms` |
| `ANDROID_BUILD_FAILED` | read the Gradle output; fix the build. No JDK: ask the user to install Android Studio or a JDK 17+ |
| `ANDROID_INSTALL_FAILED` | read adb's reason; a signature conflict needs `uninstall` first |
| `ANDROID_PACKAGE_NOT_ADE_INSTALLED` | the user's AVD and an app ADE did not install: leave it |
| `ANDROID_AVD_HELD_BY_OTHER_LANE` | pick another AVD, or `device-create` |
| `ANDROID_EXTRA_DEVICE_LIMIT` | the lane holds 2 extras: remove one with `device-detach --device <avd>`, or promote and use one |
| `ANDROID_LANE_DEVICE_BUSY` | the device is in use (a recording, the user's live view, tests, an install, another agent's lease): wait for it, then promote again |
| `ANDROID_DEVICE_IS_EXTRA` | that AVD is one of the lane's extras: `device-promote --device <avd>` |
| `ANDROID_SDK_NOT_FOUND` | `android sdk status`, then ask the user to set it up |
| `ANDROID_NO_ACCELERATION` | on an ADE Cloud box: tell the user the message, then move to a VM (`ade-cloud` skill, "Your chat runs on a box and needs a VM"). Elsewhere: turn on KVM or the Windows Hypervisor Platform |

`"$A" android --help` lists every verb and flag.
