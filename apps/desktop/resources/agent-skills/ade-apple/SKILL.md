---
name: ade-apple
description: Use this skill when you need to see an iOS or SwiftUI change actually running on a simulator — finding or creating the lane's device, booting and streaming it, driving it by element query, screenshotting, recording, capturing proof, or rendering a SwiftUI preview — via `ade apple`.
---

# ADE Apple Development

Drive the lane's Apple simulator through `ade apple`. Pass `--socket` so your
CLI calls and the desktop's Apple Development tool share one session.

The pixels come from a vendored Swift helper (`ade-sim-helper`) reading the
device framebuffer. There is no Screen Recording grant, no Simulator window to
keep open, and no backend to choose. If you find advice about `idb`, window
capture, `live-start` or a `--backend` flag, it is describing a version of this
feature that no longer exists.

## Start here: ask what you can do

```bash
ade --socket apple status --text
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
ade --socket apple launch --follow --open-drawer --text
```

`launch` does the whole chain: find or clone the lane's device, boot it,
resolve the target, **build it with xcodebuild**, install it, start it, and
claim the drawer session. Add `--open-drawer` when a human asked to watch.
`--follow` announces the wait up front for a cold build.

So you do **not** run `xcodebuild` by hand to put an app on a screen, and you
do not need to know the scheme. Run `ade --socket apple apps --text` first only
when you must choose between several targets, then pass `--target <id>`.

Use `--no-build` when the app is already installed and you only want it in
front. Use `relaunch` or `terminate` for an app that is already there.

## A busy device is not a blocker

**Reuse before you create.** `start` with no arguments already does this: it
binds a free installed device, boots it if it is off, and streams it. A device
listed as `Shutdown` is installed and ready — it needs a boot, measured in
seconds, not an install. Reach for a new one only when every installed device
is owned by another lane.

**And when the device you find is owned by another chat or lane, do not ask a
human for it. Make your own.** One simulator runtime serves an unlimited number
of devices, so creating one for your lane is cheap and takes seconds — it is a new
folder of app data, not another copy of iOS. `start --create <sourceUdid>` does
it in a single call.

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

So "no device free" is almost never true. If every installed device is busy,
clone one.

```bash
ade --socket apple device-list --installed --text   # what a picker shows
ade --socket apple device-list --lane --text        # the one this lane owns
ade --socket apple start --text                     # attach or clone, boot, stream
ade --socket apple start --udid <udid> --text       # bind a specific installed one
ade --socket apple start --create <sourceUdid> --text
ade --socket apple stop --text                      # power the device OFF
```

- `start` is the one-step bring-up: bind or clone when the lane has no device,
  boot it if it is off, wait for the boot, then stream. Prefer it.
- `stop` powers the device **off**. `shutdown` only ends this chat's session
  and leaves the simulator running — the two are not the same, and a verb named
  `stop` that left a booted device behind was a real bug.
- `device-create` and `device-attach` never boot. `device-delete` removes a
  clone and refuses an attached device unless `--force`, which only detaches.
- A clone is deleted when the lane is archived. ADE never deletes a simulator
  it did not create.

## Drive the app

Name elements, not pixels.

```bash
ade --socket apple snapshot --text
ade --socket apple tap-element --label "Sign in" --text
ade --socket apple fill-element --identifier email-field --value ada@example.com --text
ade --socket apple wait-for-element --label Welcome --timeout-ms 8000 --text
ade --socket apple assert-visible --label Welcome --text
```

- Run `snapshot` first. Query with `--ref`, `--identifier`, `--label`,
  `--text-match`, `--role` and `--index`.
- A `ref` names its own tier. `id:` and `component:` survive a re-render;
  `pos:` survives nothing, so ask for an accessibility identifier instead.
- `wait-for-element` replaces a sleep. Add `--gone` to wait for a disappearance.
- Fall back to coordinates only when no query matches: `tap`, `drag`, `swipe`,
  `scroll`, `type`, `select`.
- `foreground` reports which app the device has in front, read from the device
  rather than from what ADE last launched.
- Hardware buttons: `button home` (also `lock`, `volume-up`, `volume-down`,
  `siri`). `shake` is refused with `APPLE_BUTTON_UNSUPPORTED`, because neither
  the helper nor `simctl` has it.
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

Agent launches stay in the background. Add `--open-drawer` when the user asked
to watch. `launch --follow` waits out a cold build and prints the summary.

## Proof is automatic, and only on this path

You do not pin anything. Both of these file themselves in the proof drawer and
return a `proofArtifactId`:

- **every recording**, the moment it stops, whoever started it;
- **every screenshot** you take.

```bash
ade --socket apple screenshot --out shot.png --text
ade --socket apple frame --out shot.png --text
ade --socket apple proof-bundle --caption "Settings row renders" --text
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
ade --socket apple record-start --overlays on --label "signup" --text
ade --socket apple record-stop --keep --text
ade --socket apple record-list --text
ade --socket apple record-delete --id <id> --text
```

1. **Your input starts a recording; the user's never does.** Any input from
   the CLI, an agent action or a semantic action counts as evidence and starts
   one automatically, tagged `auto`. Input from the desktop pane is stamped as
   the user's and starts nothing.
2. It stops at the end of your turn, or after ten minutes, whichever is first.
   `record-start` during an auto recording converts it to manual with no gap
   and clears the cap.
3. It files itself as proof on stop. There is **no auto-delete**; recordings
   accumulate until the user clears them.
4. You may delete a recording you own. Anything else is
   `APPLE_RECORDING_PINNED`.
5. A second chat gets `APPLE_OWNED_BY_OTHER_SESSION` with the owning chat,
   lane and age.

Overlays, meaning tap rings and typed-text badges, land in the saved file only
and never on a live viewer. Secure text is never badged.

## Live view

```bash
ade --socket apple stream-start --fps 60 --text
ade --socket apple stream-start --scale-factor 0.5 --bitrate-kbps 2500 --text
ade --socket apple stream-status --text
ade --socket apple stream-stop --text
```

`stream-status` reports the shape and never the address or the token. A status
of `running: true` means the capture is alive, not that a picture is arriving.

## Device settings, log, previews

```bash
ade --socket apple appearance dark --text
ade --socket apple accessibility reduce-motion on --text
ade --socket apple location 37.7749 -122.4194 --text
ade --socket apple permission grant photos --bundle-id <id> --text
ade --socket apple push --bundle-id <id> --title Hi --body "You have mail" --text
ade --socket apple log-start --bundle-id <id> --text
ade --socket apple preview-current --text
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
- `IOS_SIMULATOR_TARGET_ROOT_MISMATCH` — re-run `ade --socket apple apps --text`.
- `IOS_SIMULATOR_NO_BUILDABLE_TARGET` — pass `--target-id` or `--bundle-id`
  only when you deliberately want the installed app.
- `screenshot --out` and `frame --out` must land inside the build root.
- `--text` reads two ways. A bare `--text` is ADE's output mode;
  `--text-match <value>` is the element query's substring match.
