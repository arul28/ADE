# Apple device environment — how to test it

Companion to `apple-device-env.md` (the UI spec) and
`apple-device-env-contracts.md` (the unit contracts). This one is for a person
sitting in front of the app: how to run the branch, what to click, and what
each step should look like when it is working.

Everything below assumes the lane worktree
`/.ade/worktrees/github-pingdotgg-t3code-pull-12813-dca9f144` and a Mac with at
least one **already-installed** iOS simulator runtime. ADE never downloads one.

---

## 0. Run the dev app from this worktree

```bash
cd <worktree>
npm --prefix apps/ade-cli run build     # the launcher runs the CLI it finds on disk
npm run dev:desktop                     # = node scripts/dev-desktop.mjs --auto
```

Two rules that will cost you an afternoon if you skip them:

- **Build the CLI first.** `dev:desktop` launches the brain from
  `apps/ade-cli/dist/`. A stale `dist` means the app starts against yesterday's
  `apple` verbs and the column reports methods that do not exist.
- **Never restart the lane's dev brain on its own** while `dev:desktop` is up.
  Killing the brain and starting another one leaves the desktop talking to a
  socket nobody owns. Rebuild the CLI, then re-run the launcher — the launcher
  owns the brain's lifecycle, not you.

The native helper is built by `apps/desktop/scripts/build-sim-helper.mjs` and
lands at `apps/desktop/resources/native/ade-sim-helper`. If it is missing,
`apple status` reports `tools.helper.present: false` and every device action
fails with `APPLE_HELPER_UNAVAILABLE` — that is the first thing to check when
nothing works at all.

---

## 1. The walk-through, in order (round 2 pane)

The pane lives inside the tools pane as the **Apple** tab. There is no column,
no header bar, no dialog. Spec: `apple-device-env-redesign.md`.

1. **Tools grid.** The card reads **Apple · No device**.
2. **Picker.** Open the Apple tab. Expect a list titled *iOS Simulators*: each
   installed simulator as a row with `iOS 26.x · Stopped|Running` and a
   trailing **Start** or **Open**. The last row is *New simulator for this
   lane* with a device select and **Create**.
3. **Start.** Press Start on a stopped simulator. Expect the loading card
   (device name, runtime, two-segment bar: "Starting device…" then
   "Connecting video…"), then the live device. One click, no dialog.
4. **Live.** Tap and type on the screen. Expect the screen to follow. Hover
   every rail button: each has a tooltip. Home and Rotate work. There is no
   Shake.
5. **3D / Flat.** The bottom rail group toggles the 3D body and the flat
   view. A narrow pane shows a shorter phone, never a squeezed one.
6. **Tools drawer.** Press the rail's *Tools*. Expect a 288 px drawer with
   sections App, Simulator, Inspect, Recording, Location, Permissions, Push
   notification, Preview Lab, Event log. Unsupported rows are disabled, not
   hidden.
7. **Inspect.** Drawer › Inspect › *Overlay element frames*. Click a frame;
   its details fill the rows below.
8. **Record.** Rail › More › Record, or ask an agent to tap. Expect the
   bottom pill "● Recording 0:42 · Stop". Drawer › Recording lists the file
   with **Pin to proof**.
9. **Preview Lab.** Drawer › Preview Lab: pick a target, press Render.
   Expect the preview in the viewport with a **← Back to device** chip.
10. **Float.** Rail › More › *Float over chat*. Expect the mini player: flat
    stream, a dot top-right that becomes a bar on hover (Open in pane, Close).
11. **Errors.** Shut the simulator down in Simulator.app. Expect a one-line
    strip "iPhone 17 Pro is off. [Start]". No text starting with
    "Error invoking remote method" anywhere.
12. **CLI.** `ade-alpha apple start --lane <id>` boots and streams.

## 2. Relay redeploy — read this before blaming NAT

Video takes the direct path when the client can reach the brain's sync listener,
and the tunnel relay's pipe when it cannot. The relay half needs a **deploy**:
`apps/tunnel-relay/src/tunnelDo.ts` learned a pipe `kind` (`apple-stream`) and a
`path` parameter on this branch, and the deployed Worker does not have them yet.

```bash
cd apps/tunnel-relay && npx wrangler deploy
```

Until that lands, a phone or web viewer that cannot reach the Mac directly —
different network, CGNAT, coffee shop — will get a ticket and then no frames.
On the same LAN everything works without the deploy, which is exactly how this
hides during local testing.

---

## 3. Known gaps

- **Closed 2026-09-21:** Show Borders is the device's Button Shapes flag
  (`accessibility button-shapes`), so the drawer row is live. The App section
  reads the frontmost app from the helper every two seconds, so an app opened
  from the home screen or Xcode shows up and the Event log follows it.
- **Remote desktop live view is no longer a gap.** A Windows or Linux desktop bound to a Mac runtime can watch and drive the lane's simulator over H.264; test it by opening this desktop app on Windows/Linux against that Mac runtime and using the Apple tool (the picker follows `iosSimulator.status().supported`, not the viewer's OS).
- **`apple.streamTicket` has no ownership guard — product decision needed.**
  It is `viewerAllowed: true` (deliberately: the phone is view-only and streams
  with no gating), but its handler calls `service.startStream(...)`. So any
  paired viewer can **start** a capture on a device another chat owns, and can
  restart the encode at the remote bitrate cap. `apple.input` is properly
  `viewerAllowed: false`, so nobody can *drive* the device this way — but
  "watching starts the camera" is a state change from a read-role client, and
  whether that is acceptable is a product call, not a bug fix.
- **`hasLocalViewer` is desktop-only.** The embedded host (`main.ts`) passes it;
  the headless brain (`bootstrap.ts`) has no renderer and passes nothing, which
  is correct. A *second* desktop on another machine watching through the relay
  is not counted — it is a remote viewer like any other.
- **The `ade ios-sim` alias still exists** for one release and prints a
  deprecation line to stderr once per process. `live-start` and `--backend` are
  already hard errors.
- **`ChatIosSimulatorPanel` keeps the Preview Lab toggle in the column header**
  per spec §6.4. Preview Lab itself is unchanged by this work and needs Xcode
  rather than a simulator.
- **Watch simulators** are listed in the create dialog and disabled with "Watch
  support is coming".
- **One device per lane.** Creating a second asks "Replace <current>?" and, on
  confirm, powers off and deletes the previous clone (an attached device is only
  detached). There is no device switcher in this version.
- **Shake is refused.** The toolbar's Shake button reaches the helper and comes
  back with `APPLE_BUTTON_UNSUPPORTED`; the column shows that message. Home and
  Rotate work. Shake needs a helper command that does not exist yet.
- **`idb` references that remain in the code are historical**, and deliberately
  so: a handful of comments explain why a frame is in device points or why a
  gesture takes no duration by naming what the shape used to come from. No code
  path, CLI flag, help line or status field mentions idb any more.
