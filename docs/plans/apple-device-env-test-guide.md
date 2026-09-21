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

## 1. The walk-through, in order

### 1. Apple tab

Work tab → tools pane → **Apple** (the tab formerly called "iOS"; tooltip
"Apple simulators and previews").

*Expect:* the pane shows the **No device yet** empty state — one icon, one line
("This lane has no simulator."), and two actions: **Create a device** and
**Attach…**. The tools pane is the ONLY place that empty state lives.

### 2. Create a device

Press **Create a device**.

*Expect:* the create dialog, with **Clone a fresh simulator** pre-selected and
pre-filled with the project's last-used installed simulator (newest installed
iPhone if the project has no history). The new device will be named
`<source name> — <lane name>`.

Press **Create**.

*Expect, and this is the point of task 1:* the device does **not** appear in the
tools pane. A **new full-height column opens beside the chat**, with its own
splitter between the chat and it. The tools pane, still on Apple, now reads
"Apple device is open in its own column".

Grab the splitter. The column resizes, the chat gives way, and the width
survives a project-tab switch and an app restart. Drag it left: it stops at
**200px** and refuses to go narrower.

### 3. Live

*Expect:* the launch stepper (Create → Boot → Ready), then a black stage with
the device screen on it — **no bezel, no window chrome, no Screen Recording
prompt**. The header chip reads `Live`; hover it for fps and bitrate.

Click and drag on the stage. Input goes to the device.

Now narrow the column and watch the breakpoints, all measured on the **column**:

| Column width | Expect |
|---|---|
| ≥ 700px | advanced drawer docks beside the stage |
| 420–700px | drawer overlays the stage from the right, with a scrim |
| 280–420px | the floating toolbar moves into the column header as a scrollable row |
| < 280px | the quick-control strip hides |
| < 200px | the splitter stops |

The stream must survive every one of those swaps. A mode change that
black-frames the device is a bug.

### 4. 3D / flat

Toolbar → **3D**.

*Expect:* the device body appears, the live frames still playing on its screen.
Drag orbits; release springs back to the nearest screen-facing view; pinch
zooms. **Flat** returns to the plain stage. Neither switch tears the stream
down — the decoder keeps running and the frame is handed to the new presenter.

3D is refused, with the reason in its tooltip, when WebGL is unavailable, when
inspect is on, when the column is under 420px, or when the stream is not
running.

### 5. Inspect

Toolbar → **Inspect**.

*Expect:* the view drops to flat, rectangles are drawn over the **live** frame,
and the cursor becomes a crosshair. Hover highlights the deepest element (cyan
1px); `alt` cycles outward; click **selects** rather than tapping. The side
panel replaces the drawer and shows label / role / identifier / frame / source.

Press **Copy as ade command** → the clipboard holds something like
`ade apple tap-element --identifier signInButton`. Press **Insert into chat** →
the element lands in the active chat's composer. (That path is why the column
has its own context wiring: it is no longer inside the tools pane that used to
supply it.)

`Esc` clears the selection; toggling Inspect off restores input.

### 6. Record

Toolbar → **Record**.

*Expect:* a red dot and an elapsed timer in the header and the quick strip.
**Live viewers never show the overlays** — the tap rings and typed-text badges
are composited into the saved file only.

Tap a few things, type into a field, then **Stop and keep**. Open the saved
`.mp4` from the drawer's Recording section.

*Expect in the file:* a ring at each tap point in **ADE's accent purple**
(`#A78BFA`, `shared/themeTokens.ts`, guarded against `renderer/index.css` by
`themeTokens.test.ts`) — not the placeholder blue it used to draw. A typed-text
chip at the bottom for what you typed, and **nothing at all** for a secure text
field.

Also check an **auto** recording: send an agent turn that taps the device
without asking for a recording. One should start by itself, tagged `auto`, and
stop when the turn ends.

### 7. Proof

Run `ade --socket apple proof-bundle --caption "..." --text`, or hold the
column's **Screenshot** button.

*Expect:* the current (or most recent) recording is marked `proof`, copied into
the chat's proof drawer, and pinned. It shows a pin glyph in the Recent list
and **has no delete action** — an agent asking to remove it is refused with
`APPLE_RECORDING_PINNED`.

### 8. Storage row

Settings → Diagnostics.

*Expect:* nothing at all, unless recordings exceed the warning size
(`apple.recordingsWarnBytes`, default 5 GiB). Over it, one read-only row naming
the total. It never deletes.

Under the hood this now reads `iosSimulator.recordingsTotalBytes()` — one number
from the recorder's own sidecars — instead of walking
`.ade/artifacts/apple-recordings/` through the files API. The directory walk is
still there as a fallback for a remote Mac running an older brain, so the row
does not silently go quiet against one.

### 9. Corner card

Switch the tools pane to **Git**, then close the Apple column with its `×`.

*Expect:* the device keeps running — closing the column never shuts it down —
and the floating corner card takes over, playing the same H.264 at 240×320. The
tools pane's Apple tab now offers **Open column** to get back.

*The regression to watch for (task 3):* with the column open **and** the card
visible, dismiss the card. The column must keep its frames. `stopStream` is
lane-scoped, so before the viewer lease the first viewer to leave stopped the
other one's capture. Two viewers, one lease count, last one out turns it off.

### 10. Picture in picture

Corner card → **⧉ PiP**.

*Expect:* a native PiP window, and the card collapses to a one-line pill so the
lane still says the device is live. Switch to another app entirely — the device
is still on screen. Leaving PiP restores the card.

### 11. Web client

Open the web client against this machine and go to the same lane's Work tab.

*Expect:* the **same column, same layout** — the web client mounts the same
components, so there is no separate web layout to check. Full interact: tap,
drag, type, scroll, inspect, 3D, record. **Open in Simulator.app** is absent
(local-only). The live chip names the machine. The encode is capped by
`apple.remoteBitrateKbpsCap` (default 2 Mb/s) because a web viewer is a remote
viewer even on the same LAN.

Then close the web tab while the desktop column is still open. **The desktop
must keep its frames.** The brain-side rule is "the relay stops only what the
relay started", now backed by `appleLocalViewers.ts` so the relay also knows
when a renderer on this Mac is still watching.

### 12. Phone

iOS app → the lane's chat → **Tools** row → **Simulator**.

*Expect:* the live stream, view-only. Touching the frame shows a "View only"
chip for 1.5s and does nothing else. The card names the device, the lane, and
the bitrate, and shows a recording dot while one is running. **Reconnect** on a
stall, **⧉ PiP** via `AVPictureInPictureController` so the device survives
backgrounding. It streams on cellular with no gate and no warning.

The ownership line reads the chat's **title** (`owner.chatTitle`, resolved on
the host), and so does the desktop's watch ribbon now — both surfaces name the
same chat the same way instead of one showing eight characters of a session id.

---

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
