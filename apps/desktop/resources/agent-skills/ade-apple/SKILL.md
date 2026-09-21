---
name: ade-apple
description: Use this skill when you need to see an iOS or SwiftUI change actually running on a simulator — creating or attaching a per-lane device, launching the app, driving it by element query, screenshotting or streaming the screen, recording, capturing proof, or rendering a SwiftUI preview through Preview Lab — via `ade apple`.
---

# ADE Apple device and Preview Lab

Drive the lane's Apple simulator through `ade apple`. `ade ios-sim` is a
deprecated alias for one minor release. Use `--socket` so CLI actions and the
desktop Apple column share one session.

The pixels come from a vendored Swift helper (`ade-sim-helper`), not from
Simulator.app window capture and not from idb. There is no Screen Recording
grant, no Simulator window, and no `--backend` flag. The live canvas is the
device framebuffer.

## Quick verify

```bash
ade --socket apple status --text
ade --socket apple device-list --installed --text
ade --socket apple launch --target <id> --text
ade --socket apple proof-bundle --caption "Settings row renders" --text
```

- `status` is the gate. If `supported` is false the runtime is not a Mac — stop
  and say so. It reports `device.origin` (`clone` / `attached`), `device.laneId`,
  and `tools.helper` (`present`, `path`, `version`). It does not report `idb`.
- A lane has no device until asked. `launch` and `open-device` create one on
  first ask (clone of the project's last-used installed simulator, else newest
  installed iPhone). Do not download a runtime. If none are installed, the
  command fails with `APPLE_NO_INSTALLED_SIMULATORS` — tell the user to open
  Xcode ▸ Settings ▸ Components.
- `screenshot --out <path>` round-trips `simctl` and works without a stream.
  `frame --out <path>` grabs one decoded frame from the running stream and
  fails with `APPLE_STREAM_NOT_RUNNING` when there isn't one. Prefer `frame`
  while streaming; use `screenshot` when you only need a still.
- `proof-bundle` writes the screenshot plus machine/device/elements/log and
  pins the active recording (or this chat's most recent one). `proof` still
  files a lone screenshot in the proof drawer.
- Release when done: `ade --socket apple shutdown --text` for an app session,
  `close-device` for a device session. `device-delete` removes a clone; it
  refuses an attached device unless `--force`, and `--force` only detaches.

## Per-lane devices

One simulator per lane. Create on first ask, or attach an existing one. ADE
never downloads a runtime.

```bash
ade --socket apple device-create --text
ade --socket apple device-create --from "iPhone 17" --name "iPhone 17 — lane-ab3" --text
ade --socket apple device-attach --simulator <udid|name> --text
ade --socket apple start [--udid <udid>|--create <sourceUdid>] --text
ade --socket apple device-list --installed --text
ade --socket apple device-list --lane --text
ade --socket apple device-delete --text
```

- `device-create` with no `--from` clones the project's last-used installed
  simulator, else the newest installed iPhone.
- `device-attach` binds an existing simulator without cloning. ADE never
  deletes a simulator it did not create.
- `start` is the one-step bring-up: attach (`--udid`) or clone (`--create`)
  when the lane has no device, boot it if it is off, wait, then stream.
  `device-create`/`device-attach` never boot; `start` always does.
- `device-list --installed` is what a picker shows. `device-list --lane` is
  the one device this lane owns.
- The clone is deleted when the lane is archived.

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
  `--text`, `--role`, and `--index`.
- A `ref` names its own tier: `id:` and `component:` survive a re-render.
  `pos:` survives nothing — ask for an accessibility identifier.
- `wait-for-element` replaces a sleep. Add `--gone` to wait for a disappearance.
- Fall back to a coordinate tap only when no query matches: `tap`, `drag`,
  `type`, `select`. Input is injected by the helper.
- Hardware buttons: `ade --socket apple button home --text` (also `lock`,
  `volume-up`, `volume-down`, `siri`). `shake` is refused with
  `APPLE_BUTTON_UNSUPPORTED` — it is not a helper button and this Xcode's
  `simctl` has no shake verb.
- Orientation: `ade --socket apple rotate landscape-left --text` (also
  `portrait`, `portrait-upside-down`, `landscape-right`). The helper reports
  `applied: false` when Simulator.app is not running.

Agent launches stay in the background. Add `--open-drawer` when the user asked
to watch. `launch --follow` waits out a cold build (17 min) and prints the
launch summary.

## Recording and auto-record

```bash
ade --socket apple record-start --overlays on --label "signup" --text
ade --socket apple record-stop --keep --text
ade --socket apple record-list --text
ade --socket apple record-delete --id <id> --text
ade --socket apple frame --out shot.png --text
```

Auto-record contract:

1. The first injected input (`tap`, `tap-element`, `type`, `fill-element`,
   `drag`, `select`, `open-url`) against a device with no running recording
   starts one automatically, tagged `auto`, owned by this chat, overlays per
   Settings.
2. It stops at the end of this chat's turn, or after 10 minutes, whichever
   comes first. `record-start` while an auto recording is running converts it
   to manual (no restart, no gap) and clears the 10-minute cap.
3. You may `record-delete` a recording you own that is not marked `proof`.
   Anything else is `APPLE_RECORDING_PINNED`.
4. `proof-bundle` pins the active recording — or this chat's most recent one —
   copies it to the proof drawer, and makes it undeletable by any agent.
5. There is **no auto-delete**. Recordings accumulate until the user clears
   unpinned ones.
6. A second chat sees `APPLE_OWNED_BY_OTHER_SESSION` with the owning chat,
   lane, and age — same cooperative-guard language as sessions.

`record-stop --discard` is only permitted for a recording this chat owns that
is not marked `proof`. Overlays (tap rings + typed-text badges) land in the
saved file only, never on live viewers. Secure text is never badged.

## Live view

```bash
ade --socket apple stream-start --fps 60 --text
ade --socket apple stream-start --scale-factor 0.5 --bitrate-kbps 2500 --text
ade --socket apple stream-status --text
ade --socket apple stream-stop --text
```

`live-start` and `--backend` are gone. `--fps`, `--scale-factor`, and
`--bitrate-kbps` survive. `stream-status` never returns the stream URL or token.

## Device tools, logs, Preview Lab

Unchanged verbs: `appearance`, `content-size`, `accessibility`, `location`,
`permission`, `push`, `open-url`, `status-bar`, `settings`, `relaunch`,
`terminate`, `uninstall`, `app-state`, `log-start`, `log`, `log-stop`,
`preview-status`, `previews`, `preview-match`, `preview-ensure`,
`preview-current`, `preview-render`.

```bash
ade --socket apple appearance dark --text
ade --socket apple log-start --bundle-id <id> --text
ade --socket apple preview-current --text
```

## Ownership

One chat owns a simulator session at a time. A second launch fails with
`APPLE_OWNED_BY_OTHER_SESSION` / `IOS_SIMULATOR_OWNED_BY_OTHER_SESSION`.

- Ownership releases when the owning chat is deleted or archived.
- The guard is cooperative. `shutdown --force`, `launch --force`, and
  `claim --ignore-ownership` get through. Ask before you evict another chat.
- `claim --lane <lane-id>` attaches an already-running session to a lane.

## Gotchas

- `APPLE_NO_INSTALLED_SIMULATORS` — no installed runtime. Point at Xcode ▸
  Settings ▸ Components. Never try to download one.
- `APPLE_DEVICE_ATTACHED_NOT_DELETABLE` — `device-delete` without `--force` on
  an attached simulator. `--force` detaches; it does not delete.
- `APPLE_HELPER_UNAVAILABLE` — the vendored helper binary is missing. Status
  `tools.helper.present` is the check.
- `APPLE_STREAM_NOT_RUNNING` — `frame` needs a live stream; use `screenshot`.
- `APPLE_BUTTON_UNSUPPORTED` — that button is not a helper `button` name, and
  this Xcode's `simctl` has no equivalent (today: `shake`).
- `IOS_SIMULATOR_TARGET_ROOT_MISMATCH` — re-run `ade --socket apple apps --text`.
- `IOS_SIMULATOR_NO_BUILDABLE_TARGET` — pass `--target-id` / `--bundle-id` only
  if you deliberately want the installed app.
- `screenshot --out` and `frame --out` must land inside the build root.
- `--text` reads two ways. A bare `--text` is ADE's output mode.
  `--text-match <value>` is the element query's substring match.
