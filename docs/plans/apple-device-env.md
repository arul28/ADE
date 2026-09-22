# Apple device environment — UI design spec

Status: design spec, not built. Scope: the whole Apple-device surface in ADE —
desktop Work tab, web client, phone, the floating corner card, and the CLI verbs
an agent uses to drive it.

This document is the wireframe + interaction contract. It does not specify the
helper process, the encoder, or the transport beyond what the UI must render.

## 1. Purpose and locked decisions

The simulator today is a drawer inside the Work tools pane
(`ChatIosSimulatorPanel.tsx`, 3070 lines) that mirrors the *Simulator.app window*
through desktop screen capture. That forces a Screen Recording grant, a visible
window on this Mac, a bezel in the picture, and a hard "live view shows the
Simulator on this computer" caveat when the chat runs on a remote Mac. The
overhaul replaces the source of the pixels and promotes the surface from a
drawer to a first-class column.

Locked (do not re-open):

- **Engine.** idb is removed. A vendored Swift helper (from `expo/serve-sim`)
  captures the framebuffer, encodes H.264, injects touches, and returns the
  accessibility tree. No Screen Recording grant, no Simulator window. The live
  canvas **is** the device screen — no bezel, no window chrome.
- **One simulator per lane, many per machine.** A lane gets no device until
  asked: the user asks from the tools tab, or an agent runs `launch` /
  `open-device`. First ask clones the project's last-used installed simulator
  (else newest installed iPhone) via `simctl clone`, named for the lane. A lane
  may instead attach an existing simulator without cloning. Only installed
  simulators/runtimes — ADE never downloads one. The clone is deleted on lane
  archive.
- **Families.** iPhone and iPad first. Watch later.
- **3D body viewer** (t3code PR #12787 shape): real Apple body models, Three.js,
  orbit + pinch, flat mode always available. "Realistic body" toggle, default ON;
  off = plain procedural body.
- **Web client:** full interact. **Phone (native iOS app):** view only, streams
  on cellular, no gating.
- **Recording.** Agents auto-record for their own verification and may delete
  their own recordings. Proof-requested recordings stay. Overlays (tap rings +
  typed-text badges, t3 #12779 pattern) ON by default, each switchable in
  Settings. No auto-delete.
- **Stream health.** Frame-time watchdog, first-frame timeout, Reconnect on every
  viewer. No MJPEG, ever. Stream only while visible. Per-remote-viewer bitrate cap
  in Settings.
- **Tools tab rename.** "iOS" → "Apple", tooltip "Apple simulators and previews".
  Same label on phone and web.
- **Desktop layout.** An open device gets its **own full-height column** in the
  Work tab, not the shared tools pane. Floating toolbar beside the screen, quick
  controls next to the screen, advanced drawer for the rest. When the column is
  too narrow the toolbar moves into the header.
- **Corner card.** The per-lane floating card (`WorkLiveCornerCard.tsx`) plays
  the H.264 stream, is keyed by device, and offers native picture-in-picture.
- **Live inspect overlay.** Element rectangles from the accessibility snapshot
  drawn over the *live* frame; hover highlights, click selects, side panel shows
  label/role/identifier/source, "copy as ade command", "insert into chat". The
  existing frozen-snapshot inspect stays as the fallback.
- **Sharing.** A second chat can watch an owned device with input locked
  ("Watching · owned by &lt;chat&gt;" ribbon — `IosSimWatchRibbon.tsx` already has
  this shape).
- **Windows desktop bound to a remote Mac runtime** can watch and drive over the
  H.264 path.

### What t3 #12787 contributes, restated in ADE terms

| t3 (`apps/web/src/components/device/`) | ADE equivalent |
|---|---|
| `DeviceWorkspace` — stage + rail + drawer, drawer is `absolute inset-y-0 right-0 max-w-72` below `@700px`, `static w-72` above | `AppleDeviceColumn` — same three parts; drawer overlays below 700px column width, docks beside above it |
| `DeviceControlsRail` — `pointer-events-none absolute inset-y-0 right-0 w-14`, pill of icon buttons, vertically centred, overlays the stage with no reserved gutter | `AppleDeviceToolbar` — same geometry, ADE `.ade-shell-control` skin instead of shadcn `Button variant=ghost` |
| Rail order: Home / (Android back, recents) / Rotate · divider · Appearance / Text size / Tools / Screenshot / More · divider · 3D / Flat / Keyboard / Reset view | ADE order in §2a. Android rows dropped, recording + inspect added |
| `DeviceToolsPanel` sections: App, Simulator, Accessibility, Location, Permissions, Push notification, Event log | ADE advanced drawer, §2b — same section list, reusing `IosSimToolsColumn.tsx`'s existing controls |
| AX overlay forces flat mode (`phoneUnavailableReason`) | Same rule (§2c) |
| MJPEG fallback forces flat mode | N/A — no MJPEG in ADE |
| "Float device over chat" in the More menu | Corner card + PiP (§2e) |
| Pinch zoom removed from the stage | Same: pinch orbits in 3D, does nothing in flat |

Not copied: t3's device-hub discovery model, its host/environment concepts, its
Magic Keyboard accessory, and any of its code.

---

## 2. Surfaces

### (a) Work tab — Apple column open

The Apple column is a sibling of the chat column and the tools pane, full height,
owned by the lane. It is opened by the Apple tool in the tools picker
(`workTools.ts`), by the "Simulator running" pill's **Open**, or by a deeplink.

```
┌── Work tab ────────────────────────────────────────────────────────────────────┐
│ ┌ sessions ─┐┌ chat column ─────────────┐┌ Apple column ───────────────────────┐│
│ │           ││                          ││ ┌ header (h-10) ──────────────────┐ ││
│ │ lane A  ● ││  agent: built the app,   ││ │ [] iPhone 17 · lane-ab3   [Live]│ ││
│ │ lane B    ││  tapping Sign in…        ││ │ MyApp · 60fps · 1.4 Mb/s   ⋯  ×│ ││
│ │           ││                          ││ └─────────────────────────────────┘ ││
│ │           ││  ┌ tool card ─────────┐  ││ ┌ stage ──────────────────────────┐ ││
│ │           ││  │ tapped 'Sign in'   │  ││ │                        ┌──────┐ │ ││
│ │           ││  └────────────────────┘  ││ │   ┌──────────────┐     │ ⌂    │ │ ││
│ │           ││                          ││ │   │              │     │ ⟳    │ │ ││
│ │           ││                          ││ │   │   device     │     │ ⊙REC │ │ ││
│ │           ││                          ││ │   │   screen     │     ├──────┤ │ ││
│ │           ││                          ││ │   │  (H.264)     │     │ ☾    │ │ ││
│ │           ││                          ││ │   │              │     │ Aa   │ │ ││
│ │           ││                          ││ │   │              │     │ ⊞    │ │ ││
│ │           ││                          ││ │   └──────────────┘     │ ⌕    │ │ ││
│ │           ││                          ││ │                        │ ⧉    │ │ ││
│ │           ││                          ││ │                        │ ⋯    │ │ ││
│ │           ││                          ││ │                        ├──────┤ │ ││
│ │           ││ ┌ composer ────────────┐ ││ │                        │ ◧ 3D │ │ ││
│ │           ││ │ >                    │ ││ │                        │ ▭ Fl │ │ ││
│ │           ││ └──────────────────────┘ ││ │                        └──────┘ │ ││
│ └───────────┘└──────────────────────────┘│ └─────────────────────────────────┘ ││
│                                          │ ┌ quick controls (h-9) ───────────┐ ││
│                                          │ │ [Relaunch] [Home] [Rotate] [⚙]  │ ││
│                                          │ └─────────────────────────────────┘ ││
│                                          └─────────────────────────────────────┘│
└────────────────────────────────────────────────────────────────────────────────┘
```

**Column header** (reuse `PaneHeader.tsx` + `WORK_TOOL_CHROME_ROW`):

| Slot | Content |
|---|---|
| Icon | Family glyph — `DeviceMobile` (iPhone) / `DeviceTablet` (iPad) |
| Title | Device name, then lane name in `text-muted-fg`. Click opens the device menu (switch device, attach existing, create new) |
| Live chip | Reuse the existing live chip from `useIosSimLiveView.ts`: `Live` / `Starting` / `Reconnecting` / `Stalled`, plus fps and bitrate on hover. On a remote Mac it names the machine. |
| Subtitle | Foreground app bundle, or `no app` |
| `⋯` | Overflow: Float over chat, Picture in picture, Open in Simulator.app (local only), Copy device UDID, Power off, Delete clone |
| `×` | Close the column. Does **not** shut the device down; it keeps running and the corner card takes over. |

**Stage.** Black. The frame is `object-contain`, centred, never upscaled past 1×
device pixels. No bezel in flat mode — the frame *is* the screen. Rounded corners
and a 1px `border-white/[0.06]` ring are the only chrome, so the screen still
reads as a surface against the black stage.

**Floating toolbar** (`AppleDeviceToolbar`): absolutely positioned
`inset-y-0 right-0 w-14`, `pointer-events-none` on the rail and
`pointer-events-auto` on the pill, vertically centred, scrollable when it
overflows. It **overlays** the stage — it never reserves a gutter, so the device
never shrinks when the toolbar grows. Buttons wear `.ade-shell-control` (same
skin `IosSimToolsColumn.tsx` uses) at `h-7 w-7`.

Toolbar order, top to bottom:

| Group | Buttons |
|---|---|
| Device input | Home, Rotate, Shake |
| Recording | Record / Stop (red dot while recording, elapsed time on hover) |
| Device state | Appearance toggle (light/dark), Text size menu, Advanced drawer toggle |
| Capture | Screenshot, Inspect (toggle), Float over chat |
| Overflow | `⋯` — PiP, Open in Simulator.app, Copy UDID, Power off, Delete clone |
| View | 3D, Flat, Reset view (3D only) |

Every button is a `PaneTooltip` with the action name; a disabled button whose
reason is known shows the reason instead of the name (t3's `description`
pattern — e.g. "3D view needs WebGL", "Inspect is flat-view only").

**Quick controls** (`h-9` strip under the stage, `WORK_TOOL_CHROME_ROW`): the
four things a person reaches for every minute — **Relaunch**, **Home**,
**Rotate**, and **⚙ Advanced** (opens the drawer). The strip also carries the
recording pill and the ownership ribbon's collapsed form when either is active.
Everything else lives in the drawer. The strip hides entirely below 280px column
width; its four actions are then all present in the floating toolbar.

**Header fallback when narrow.** Below **420px** column width the floating
toolbar would cover more than a third of the device. At that point:

1. The toolbar rail unmounts.
2. Its buttons move into the column header as a single horizontally scrollable
   row under the title, `h-8`, same `.ade-shell-control` skin.
3. The View group (3D / Flat) collapses to one toggle button showing the
   *other* mode.
4. The Device input group keeps Home and Rotate; Shake moves to `⋯`.

Above 420px the rail comes back and the header row unmounts. The transition is
a layout swap, not an animation; the stream is never torn down by it.

Breakpoints, all measured on the **column**, not the window:

| Width | Behaviour |
|---|---|
| ≥ 700px | Advanced drawer docks beside the stage (`w-72`, static) |
| 420–700px | Drawer overlays the stage from the right, `max-w-72`, with a scrim |
| 280–420px | Toolbar moves into the header; drawer still overlays |
| < 280px | Quick-control strip hides; column shows stage + header only |
| < 200px | Column refuses to shrink further (min width), the splitter stops |

### (b) Advanced drawer

Opened by the toolbar's slider icon or the quick strip's **⚙**. One column of
sections, each `border-b`, scrollable. Sections and their controls are the ones
`IosSimToolsColumn.tsx` already implements; this spec only re-homes them.

```
┌ Advanced ───────────────────────── × ┐
│ App                                  │
│   Foreground   com.acme.MyApp        │
│   [Terminate] [Relaunch] [Uninstall] │
│   ┌ open url ──────────┐ [Open]      │
│   ┌ bundle id ─────────┐ [Launch]    │
│ ─────────────────────────────────────│
│ Simulator                            │
│   Appearance    [Light][Dark]        │
│   Text size     [ Default      ▾ ]   │
│   Orientation   [ Portrait     ▾ ]   │
│   Reduce Motion            ( ●— )    │
│   Increase Contrast        (—○  )    │
│   Reduce Transparency      (—○  )    │
│   Bold Text                (—○  )    │
│   Invert Colours           (—○  )    │
│   Greyscale                (—○  )    │
│   VoiceOver                (—○  )    │
│ ─────────────────────────────────────│
│ View                                 │
│   Realistic body           ( ●— )    │
│   Live inspect overlay     (—○  )    │
│   Bitrate cap   [ 2 Mb/s      ▾ ]    │
│ ─────────────────────────────────────│
│ Recording                            │
│   ⊙ 00:42  agent · auto              │
│   Tap rings                ( ●— )    │
│   Typed-text badges        ( ●— )    │
│   [Stop and keep] [Stop and discard] │
│   Recent:  run-3.mp4  18s   ⌄        │
│            run-2.mp4  41s   ⌄        │
│ ─────────────────────────────────────│
│ Location                             │
│   [ San Francisco ▾ ] [Set] [Clear]  │
│   ┌ lat ────┐ ┌ lon ────┐  [Set]     │
│ ─────────────────────────────────────│
│ Permissions                          │
│   [ Photos ▾ ] [Grant][Revoke][Reset]│
│ ─────────────────────────────────────│
│ Status bar                           │
│   Time 9:41  Wifi ▮▮▮  Batt 100%     │
│   [Apply] [Clear]                    │
│ ─────────────────────────────────────│
│ Push notification                    │
│   ┌ alert text ────────┐ [Send]      │
│ ─────────────────────────────────────│
│ Device                               │
│   iPhone 17 · iOS 26.0               │
│   UDID  A1B2…F9   [copy]             │
│   Clone of "iPhone 17"  · lane-ab3   │
│   [Attach a different simulator]     │
│   [Power off]  [Delete clone]        │
│ ─────────────────────────────────────│
│ Event log                            │
│   09:41:02 tap 'Sign in'      [copy] │
│   09:41:04 fill email-field   [copy] │
└──────────────────────────────────────┘
```

Rules:

- Every row is `ROW` / `ROW_LABEL` from `IosSimToolsColumn.tsx`; every picker is
  that file's `ToolMenu` (Radix, `MENU_CONTENT_CLASS`), never a native `<select>`.
- Each change writes an event-log row carrying the `ade apple …` command that
  repeats it, and the row's `[copy]` copies that command. This already exists.
- **Push notification** is disabled with the line "Open an app first" when there
  is no foreground app (t3's rule).
- **Delete clone** is destructive-tone and confirms. It is disabled when the
  device was attached rather than cloned — an attached simulator is the user's,
  and ADE never deletes it.
- Section state (which sections are collapsed) persists per project, not per lane.

### (c) 3D view, flat view, and the Realistic body toggle

Two presentations of one stream. The stream, the input path, the inspect data
and the recording are identical in both; only the projection differs.

```
  FLAT                                3D
┌ stage ───────────────┐   ┌ stage ───────────────────────┐
│                      │   │         ▁▁▁▁▁▁▁▁             │
│   ┌────────────┐     │   │       ╱          ╲           │
│   │            │     │   │      │   screen   │  ← body  │
│   │   screen   │     │   │      │  (H.264)   │    mesh  │
│   │  (H.264)   │     │   │       ╲          ╱           │
│   │            │     │   │         ▔▔▔▔▔▔▔▔             │
│   └────────────┘     │   │   drag to orbit · pinch zoom │
│                      │   │   [Reset view]               │
└──────────────────────┘   └──────────────────────────────┘
```

| | Flat | 3D |
|---|---|---|
| Projection | 2D canvas, `object-contain`, centred | Three.js scene, camera frames the body's real bounds |
| Input | Pointer → screen coordinates, 1:1 | Pointer raycast onto the screen plane, then the same mapping |
| Orbit | none | drag = orbit, release springs to the nearest screen-facing view |
| Pinch | does nothing | zoom |
| Scroll wheel | forwarded to the device as a scroll | zoom |
| Inspect overlay | available | **not** available — selecting Inspect switches to flat |
| Recording | records the device frames | records the device frames, not the 3D scene |
| Default | for iPad, for column width < 420px, and when WebGL is unavailable | for iPhone at ≥ 420px |

**Realistic body toggle** (Settings and the drawer's View section, default **ON**):

- ON + a model exists for this device family → the real Apple body mesh loads
  lazily, only in 3D mode.
- ON + no model for this family, or the download/asset fails → the plain
  procedural body renders and the toggle stays on. The failure is silent in the
  stage and appears as one line in the drawer: "Realistic body unavailable for
  this device."
- OFF → the plain procedural body, always. Models are not fetched.

Mode is remembered per device, so returning to a device returns to the view you
left it in. Switching modes must preserve the stream: the decoder keeps running
and the frame is handed to the new presenter. A mode switch that black-frames
the device is a bug.

3D is disabled, with the reason in its tooltip, when: WebGL is unavailable, the
inspect overlay is on, the column is under 420px, or the stream is not running.

### (d) Live inspect overlay + side panel

Inspect is a **toggle on the live stream**, not a separate mode that freezes it.
The accessibility snapshot is re-read on a cadence and after every injected
input; rectangles are drawn over the live frame in the frame's own coordinate
space, so they track a scrolling list.

```
┌ stage (inspect on) ──────────────────┐┌ Inspect ──────────────── × ┐
│  ┌────────────────────┐              ││ Sign in                    │
│  │ ┌────────────────┐ │              ││ Button                     │
│  │ │ Email      [ ] │ │ ← hover:     ││                            │
│  │ └────────────────┘ │   cyan       ││ identifier  signInButton   │
│  │ ┌════════════════┐ │   1px ring   ││ ref         id:signInButton│
│  │ ║   Sign in      ║ │ ← selected:  ││ frame       24,412 327×50  │
│  │ └════════════════┘ │   accent 2px ││ source      SignInView     │
│  │                    │   + label    ││             .swift:42      │
│  └────────────────────┘              ││ traits      button, enabled│
│                                      ││                            │
│  12 elements · refreshed 0.4s ago    ││ [Copy as ade command]      │
└──────────────────────────────────────┘│ [Insert into chat]         │
                                        │ [Open source]              │
                                        │ ────────────────────────── │
                                        │ Tree                       │
                                        │  ▾ NavigationStack         │
                                        │    ▾ Form                  │
                                        │      · Email               │
                                        │      · Sign in       ◀     │
                                        └────────────────────────────┘
```

Interaction rules:

- **Hover** highlights one rectangle (cyan 1px) and shows its label in a small
  tag at the rectangle's top-left. Only the deepest element under the pointer
  highlights; `alt` cycles outward through ancestors.
- **Click selects** — it does **not** tap the device. While inspect is on, the
  stage does not forward input. This is the one difference from interact mode,
  and the cursor changes to a crosshair to say so.
- **Escape** clears the selection; toggling Inspect off restores input.
- The side panel opens in the advanced-drawer slot (same `w-72`, same overlay
  rules) and replaces the drawer while inspect is on.
- **Copy as ade command** copies the strongest available query, in ref-tier
  order: `--identifier` &gt; `--ref component:` &gt; `--label` &gt; `--ref pos:`.
  Example: `ade apple tap-element --identifier signInButton`. When the best
  available tier is `pos:` the button copies it anyway and the panel shows one
  line: "This element carries no identity — add an accessibility identifier."
- **Insert into chat** pushes an `IosElementContextItem` into the active chat's
  composer, exactly as the existing frozen-snapshot inspect does.
- **Open source** opens the file:line in the configured editor. Absent when the
  element has no source (accessibility-only rows).
- **Tree** mirrors the snapshot hierarchy; selecting in the tree selects on the
  stage and vice versa.
- **Fallback.** When the live accessibility read fails or the helper does not
  answer, the overlay degrades to the existing frozen-snapshot inspect: one
  captured PNG plus its rectangles, with a chip reading "Snapshot · frozen" and
  a Refresh button. This is the current `mode === "inspect"` path in
  `ChatIosSimulatorPanel.tsx` and it stays.

### (e) Corner card and picture-in-picture

`WorkLiveCornerCard.tsx` already floats a per-lane preview for `browser`,
`app-control`, and `ios` (`WORK_LIVE_SCREEN_TOOLS`), sized 240×320 portrait for
`ios` (`WORK_LIVE_CARD_PORTRAIT_SIZE`), draggable within the chat column,
dismissible per tool. Three changes:

1. It plays the **H.264 stream**, not a still. Same `<video>` element the column
   uses, `object-contain`, muted.
2. It is **keyed by device**, not by tool. Two devices in one lane (an iPhone
   and an iPad) are two cards; the card's dismissal stamp is per device.
3. It offers **native picture-in-picture** — `requestPictureInPicture()` on the
   video element, so the device survives switching away from ADE entirely.

```
                    ┌ corner card (240×320) ─┐
                    │ ⊙ iPhone 17 · agent  × │
                    │ ┌────────────────────┐ │
                    │ │                    │ │
                    │ │   device screen    │ │
                    │ │     (H.264)        │ │
                    │ │                    │ │
                    │ └────────────────────┘ │
                    │ tapped 'Sign in' · 2s  │
                    │           [⧉ PiP] [↗]  │
                    └────────────────────────┘
```

- Header: family glyph tinted `#60a5fa` (the Apple tool's colour in
  `workTools.ts`), device name, `· agent` when an agent owns it, recording dot
  when recording, `×` to dismiss.
- Footer: the last action caption and its age
  (`formatWorkLiveActionCaption` / `formatWorkLiveAge`), then **⧉ PiP** and
  **↗ Open** (opens the Apple column and dismisses the card).
- Clicking the video body is **Open**, not a tap on the device. The card is a
  monitor, never an input surface.
- The card never appears while the Apple column is the active tool
  (`selectWorkLiveCardTool` already excludes the active tool).
- In PiP the card itself collapses to a one-line pill so the lane still says the
  device is live; leaving PiP restores the card.
- Existing placement rules are unchanged: 12px inset, clamped travel, never over
  the composer (`workLiveBottomReserve`).

### (f) Pill and empty states

**"Simulator running" pill.** Unchanged in placement (above the composer,
`AgentChatPane.tsx`), relabelled and given a second action:

```
  ┌───────────────────────────────────────────────┐
  │ ▸ Simulator running on iPhone 17   [Open] [⧉] │
  └───────────────────────────────────────────────┘
```

Agent launches never open the column. The pill is how the user learns a device
exists; **Open** opens the column, **⧉** floats the corner card.

Every empty/blocked state uses one shape: icon, one short label, at most one
detail line, at most one action — the `IosSimVideoOverlay.tsx` contract. The
`IosSimBlocker` union gains the new kinds and loses the capture-specific ones
(`screen-recording-permission`, `no-window`, `hidden`, `minimized` all go away
with window capture).

```
┌ stage ───────────────────────────────┐
│                                      │
│            ┌──────────┐              │
│            │    []    │              │
│            └──────────┘              │
│          No device yet               │
│    This lane has no simulator.       │
│   [Create a device]  [Attach…]       │
│                                      │
└──────────────────────────────────────┘
```

| State | Icon | Label | Detail | Action |
|---|---|---|---|---|
| No device yet | `DeviceMobile` | No device yet | This lane has no simulator. | **Create a device** / **Attach…** |
| No installed simulator | `DeviceMobile` rose | No simulators installed | ADE only uses simulators you already have. | **Open Xcode** → opens Xcode Settings ▸ Components. Secondary: copy `xcodebuild -downloadPlatform iOS`. ADE never downloads one itself. |
| Runtime is not a Mac | `Desktop` rose | macOS only | Simulators run on a Mac. This lane runs on &lt;machine&gt;. | **Bind to a Mac** → the runtime picker. Reuses `IosSimUnsupportedCard`'s chip row. |
| Watching someone else's device | `Eye` amber | — | Ribbon, not an overlay: "Watching · owned by &lt;chat&gt; · 12m" | **Attach** / **Take over** (`IosSimWatchRibbon.tsx`, unchanged) |
| Stream stalled | `WarningCircle` amber | No frames | Nothing for 3s. | **Reconnect** |
| First frame never arrived | `SpinnerGap` | Starting stream | — | after 8s → **Reconnect** |
| Stream error | `WarningCircle` | Stream stopped | the host's own error line | **Reconnect** |
| Device off | `Power` | Device powered off | — | **Boot** |
| Building | see §2f stepper | | | |

**Stalled / Reconnect is on every viewer** — column, corner card, PiP pill, web,
and phone. The watchdog is the existing `FRAME_STALL_MS = 3_000` constant in
`useIosSimLiveView.ts`; the first-frame timeout is new (8s). A viewer that is not
visible stops its stream and shows "Paused — not visible" with a **Resume**
action rather than a stall.

**Launch/build progress** keeps `IosSimLaunchStepper.tsx` verbatim (Device, Boot,
Resolve target, Build, Install, Launch, Ready; elapsed on the running step; build
root tail on Build; "~4m last time"). Two step labels change: **Boot** replaces
"Boot Simulator" and "Open Simulator" is deleted — there is no Simulator.app to
open. A **Create** step is prepended when the launch had to clone.

### (g) Create-on-ask device flow

Entered from the tools tab's **Apple** empty state, from the header's device
menu, or implicitly by an agent's `launch` / `open-device`.

```
┌ New device for lane-ab3 ──────────────────── × ┐
│                                                │
│  ( • ) Clone a fresh simulator     recommended │
│        ┌────────────────────────────────────┐  │
│        │ iPhone 17 · iOS 26.0          ▾    │  │
│        └────────────────────────────────────┘  │
│        Last used in this project.              │
│        Named  "iPhone 17 — lane-ab3"           │
│        Deleted when the lane is archived.      │
│                                                │
│  (   ) Attach an existing simulator            │
│        ┌────────────────────────────────────┐  │
│        │ iPad Pro 13" (booted)         ▾    │  │
│        └────────────────────────────────────┘  │
│        Not cloned, not deleted. Shared with    │
│        anything else using it.                 │
│                                                │
│  ────────────────────────────────────────────  │
│  Only simulators already installed appear here.│
│  [Open Xcode to install more]                  │
│                                                │
│                        [Cancel]  [Create]      │
└────────────────────────────────────────────────┘
```

Rules:

- The **Clone** picker is pre-selected with the project's last-used installed
  simulator; with no history, the newest installed iPhone. The list is grouped by
  family (iPhone, iPad) and sorted newest first. Watch models are listed but
  disabled with "Watch support is coming".
- The **Attach** picker lists every installed simulator, booted ones first, each
  with a note when another lane already uses it ("in use by lane-cc1"). Choosing
  one shows an inline warning: "Another lane is using this simulator. Changes
  affect both."
- **Create** is the primary; it runs `simctl clone` and goes straight to the
  Boot step of the stepper. Naming is `<source name> — <lane name>`, truncated
  to 60 chars, deduped with a numeric suffix.
- Agent-triggered creation uses exactly these defaults with no dialog, and the
  user learns about it through the "Simulator running" pill.
- One device per lane: creating a second device in a lane asks "Replace
  &lt;current&gt;?" and, on confirm, powers off and deletes the previous clone
  (an attached device is only detached).
- On lane archive the clone is deleted. On lane delete, same. The confirmation
  for archiving a lane gains one line when a clone exists: "Also deletes the
  lane's simulator."

### (h) Recording indicator, overlay look, proof handoff

```
 during a recording, in the header and the quick strip:
   ┌──────────────────────────┐
   │ ⊙ REC 01:24 · agent      │   red dot, pulses at 1Hz (static under
   └──────────────────────────┘   prefers-reduced-motion)

 overlays, composited into the SAVED FILE only:
   ┌────────────────┐
   │        ◎       │  tap ring: accent circle, 320ms expand+fade,
   │                │  drawn at the touch point
   │  ┌──────────┐  │
   │  │ "ada@…"  │  │  typed-text badge: rounded chip, bottom-centre,
   │  └──────────┘  │  1.2s hold, coalesces a burst into one chip
   └────────────────┘
```

- **Live viewers never show the overlays.** Following t3 #12779, a detached
  compositor adds tap rings and typed-text badges to the recording only. The
  live stream stays the untouched decode path, so overlays cost a viewer nothing.
- **Secure text entry is excluded before it is forwarded.** A badge is never
  produced for a field the accessibility tree reports as secure, and the
  exclusion happens on the helper side, not in the compositor.
- Both overlays default **ON** and each has its own switch (Settings, and the
  drawer's Recording section). With both off the saved file is the raw stream.
- **Auto-record contract.** An agent's first injected input on a device with no
  running recording starts one, tagged `auto`, owner = that chat. It stops when
  the chat's turn ends, or after 10 minutes, whichever is first. An agent may
  delete a recording it owns. It may not delete one marked `proof`.
- **Proof handoff.** `ade apple proof-bundle` (and the column's Screenshot
  button, held) marks the current or most recent recording `proof`, copies it
  into the proof drawer with the existing caption/machine/device/elements/log
  payload (`docs/features/proof.md`), and pins it so no cleanup touches it.
  Proof-marked recordings show a pin glyph in the drawer's Recent list and their
  delete action is absent. **No auto-delete anywhere** — the Recent list shows
  total size and a manual **Clear unpinned** at the bottom.

### (i) Web client viewer — full interact

`apps/desktop/src/renderer/webclient/adapter/misc.ts:776` currently stubs
`iosSimulator` with `createNativeUnavailableNamespace()`. That stub is replaced
by a relay-backed namespace. The web client renders the **same** Apple column
component as the desktop — same header, toolbar, quick strip, drawer, stage,
inspect overlay, 3D/flat.

Differences, all of them capability-driven rather than a separate layout:

| Capability | Web |
|---|---|
| Stream | H.264 over the relay, same decoder |
| Input | full: tap, drag, type, scroll, hardware buttons |
| Inspect | full |
| 3D | full, subject to WebGL |
| Recording | start/stop; the file is written on the Mac and appears in the proof drawer |
| Screenshot | downloads through the browser |
| Open in Simulator.app | absent (local-only) |
| Bitrate | capped by the **remote viewer** cap from Settings (§2k) |
| Create/attach device | full |

A web viewer counts as a remote viewer for the bitrate cap even when the Mac is
on the same LAN. The live chip names the machine, as it does for a remote-Mac
desktop today.

### (j) Phone viewer — view only

The phone's Work tools row (`WorkToolsRow.swift`) is a read-only disclosure
today; it gains a device card, and the sheet (`WorkToolsSheet.swift`) gains a
live player.

```
 chat transcript
 ┌────────────────────────────────────────┐
 │ 🔧 Tools · Simulator live · MyApp    › │  ← existing row, new summary
 └────────────────────────────────────────┘

 WorkToolsSheet ▸ Simulator
 ┌────────────────────────────────────────┐
 │  Simulator                             │
 │  ┌──────────────────────────────────┐  │
 │  │                                  │  │
 │  │        device screen             │  │
 │  │          (H.264)                 │  │
 │  │                                  │  │
 │  │   ┌──────────────────────────┐   │  │
 │  │   │ 👁 View only             │   │  │
 │  │   └──────────────────────────┘   │  │
 │  └──────────────────────────────────┘  │
 │  iPhone 17 · lane-ab3 · 1.1 Mb/s       │
 │  ⊙ recording                           │
 │  [Reconnect]            [⧉ PiP]        │
 └────────────────────────────────────────┘
```

Rules:

- **View only.** Touches on the frame do nothing but show the "View only" chip
  for 1.5s. There is no take-over, no toolbar, no drawer.
- **Streams on cellular too**, with no gate and no warning. The bitrate cap
  applies (remote viewer).
- **PiP** uses `AVPictureInPictureController`, so the device survives
  backgrounding ADE.
- The stream stops when the sheet is dismissed or the app backgrounds without
  PiP, and the same **Reconnect** action appears on a stall.
- The tools row's summary line gains "Simulator live" and, while an agent is
  driving it, the existing "something is happening now" glyph treatment — a
  phone glyph beside the accent, outside the elastic text so truncation cannot
  eat it.
- The row and sheet label the tool **Apple** in the picker and **Simulator** on
  the card, matching `WorkToolsRow.swift`'s existing `case "ios": return
  "Simulator"`.

### (k) Settings entries

New rows, all under an **Apple** subsection of the existing `appearance`
preferences tab (`settingsManifest.ts` group `preferences`), because they are
per-account presentation choices rather than machine state:

| id | Label | Control | Default | Note |
|---|---|---|---|---|
| `appearance.apple-realistic-body` | Realistic body | switch | **on** | "Show the real device body in 3D view. Off draws a plain body." |
| `appearance.apple-tap-rings` | Tap rings in recordings | switch | **on** | "Draw a ring where each tap lands. Recordings only." |
| `appearance.apple-typed-badges` | Typed text in recordings | switch | **on** | "Show what was typed. Password fields are never shown." |
| `appearance.apple-remote-bitrate` | Remote viewer bitrate | menu: 500 kb/s · 1 Mb/s · 2 Mb/s · 4 Mb/s · Unlimited | **2 Mb/s** | "Applies to the web client, the phone, and a desktop bound to another Mac. A viewer on the same machine is never capped." |

All four sync across machines with the rest of the account preferences. The
drawer's View and Recording sections show the same three switches and the cap,
writing the same keys — a per-device override is deliberately **not** offered.

---

## 3. States and transitions

`deviceState` is the column's one state value. The stream has its own
`streamState`, because a ready device with a dead stream is a real and different
thing from a device that is not there.

| State | Stage shows | Header chip | Toolbar | Enters from | Leaves to |
|---|---|---|---|---|---|
| `no-device` | "No device yet" empty state + Create/Attach | — | hidden | column opened on a lane with no device; device deleted | `creating`, `booting` (attach) |
| `creating` | stepper at the **Create** step | `Creating` | hidden | Create pressed; agent `launch`/`open-device` first ask | `booting`, `error` |
| `booting` | stepper at **Boot** | `Booting` | hidden | `creating` done; attach chosen; **Boot** from `powered-off` | `ready-no-app`, `error` |
| `ready-no-app` | live stream of the home screen | `Live` | full | boot complete; app terminated | `building`, `app-running`, `stalled`, `powered-off` |
| `building` | stepper at **Build / Install / Launch**; stream stays live underneath when one exists | `Live` + `Building` | full, input allowed | `launch` with a build | `app-running`, `error` |
| `app-running` | live stream, header subtitle = bundle id | `Live` | full | launch complete; app brought to foreground | `ready-no-app`, `stalled`, `watching`, `powered-off` |
| `watching` | live stream, input ignored, amber ribbon on top | `Live` | input group disabled; view/capture enabled | another chat owns the session | `app-running` (Take over), `no-device` |
| `stalled` | last frame dimmed + "No frames" overlay with **Reconnect** | `Stalled` | view + capture only | watchdog fired; first-frame timeout | `app-running` / `ready-no-app` on reconnect; `error` |
| `powered-off` | "Device powered off" + **Boot** | — | hidden | Power off; `simctl` reports shutdown | `booting`, `no-device` |
| `error` | blocker overlay with the host's own line + one action | `Error` | view only | any step failed; stream refused; runtime not a Mac | whatever the action leads to |

Cross-cutting:

- `recording` is orthogonal — any of `ready-no-app`, `building`, `app-running`,
  `watching`, `stalled` may be recording. A stall does not stop the recording;
  the file simply holds the frozen frame.
- `not-visible` is orthogonal: the stream stops in every state that has one, and
  the stage shows "Paused — not visible / Resume". Re-entering visibility resumes
  without a state change.
- `watching` never transitions to `building`. A watcher cannot launch.

---

## 4. Theme notes — reuse vs new

Reuse, unchanged:

| Thing | File |
|---|---|
| Blocker overlay shape and `IosSimBlocker` union | `apps/desktop/src/renderer/components/chat/IosSimVideoOverlay.tsx` |
| Watch ribbon | `apps/desktop/src/renderer/components/chat/IosSimWatchRibbon.tsx` |
| Ownership card (used in the device menu, not over the stage) | `apps/desktop/src/renderer/components/chat/IosSimOwnershipCard.tsx` |
| Launch stepper | `apps/desktop/src/renderer/components/chat/IosSimLaunchStepper.tsx` |
| Tool chips + unsupported card | `apps/desktop/src/renderer/components/chat/IosSimToolChips.tsx` |
| Every drawer control, `ToolMenu`, `ROW`, `CONTROL`, `BUTTON`, `INPUT` | `apps/desktop/src/renderer/components/chat/IosSimToolsColumn.tsx` |
| H.264 `<video>` element and its status union | `apps/desktop/src/renderer/components/chat/IosSimH264Video.tsx` |
| Stream lifecycle, retry, watchdog, live chip, analytics | `apps/desktop/src/renderer/components/chat/useIosSimLiveView.ts` |
| Corner card placement, drag, dismissal, captions | `apps/desktop/src/renderer/components/work/workLiveCard.ts` + `WorkLiveCornerCard.tsx` |
| Header row metrics and control skin | `apps/desktop/src/renderer/components/terminals/workToolChrome.ts` (`WORK_TOOL_CHROME_ROW`, `_BUTTON`, `_CHIP`, `WORK_TOOL_SECTION_LABEL_TEXT`, `WORK_TOOL_SURFACE`) |
| Menus | `apps/desktop/src/renderer/components/ui/paneMenuTokens.ts` |
| Tooltips | `apps/desktop/src/renderer/components/ui/PaneTooltip.tsx` / `SmartTooltip.tsx` |
| Pane header | `apps/desktop/src/renderer/components/ui/PaneHeader.tsx` |
| Tool identity (label, icon, colour `#60a5fa`, hint) | `apps/desktop/src/renderer/components/terminals/workTools.ts` |
| Phone colours and row shape | `ADEColor.*`, `WorkToolsRow.swift`, `WorkToolsSheet.swift` |

Changed:

- `workTools.ts` — the `ios` entry's `label` stays **"Simulator"** on the card,
  but the tools **tab** is renamed **"Apple"** with tooltip "Apple simulators and
  previews". `hint` becomes "Open an Apple device".
- `IosSimBlocker` — drop `screen-recording-permission`, `no-window`, `hidden`,
  `minimized`, `automation-denied`; add `no-device`, `powered-off`, `not-visible`,
  `no-simulators-installed`, `not-a-mac`.
- `IosSimToolChips` — drop the **Controls** (idb) chip entirely; add a **Helper**
  chip for the vendored Swift helper's presence.
- `workLiveCard.ts` — the `ios` source keys by device id; add a `recording` field
  for the simulator (it is currently hardcoded `null`).
- `webclient/adapter/misc.ts` — replace the `iosSimulator` native-unavailable stub.
- `ChatIosSimulatorPanel.tsx` — its `SimulatorMode` union loses `interact` /
  `inspect` as *modes* (inspect becomes an overlay toggle on the live stream) and
  keeps `preview` as a separate surface. This is where most of the 3070 lines go.

New components:

| Component | Role |
|---|---|
| `AppleDeviceColumn.tsx` | The column: header, stage, toolbar, quick strip, drawer slot |
| `AppleDeviceToolbar.tsx` | The floating rail, plus its header-fallback rendering |
| `AppleDeviceStage.tsx` | Stage that owns the decoder and hands frames to the flat or 3D presenter |
| `AppleDeviceFlatView.tsx` | Canvas presenter + pointer→device mapping |
| `AppleDevice3DView.tsx` | Three.js presenter, orbit spring, body model loading, screen-plane raycast |
| `appleDeviceModels.ts` | Family → model asset map, fallback to procedural |
| `AppleInspectOverlay.tsx` | Live rectangles, hover/select, ancestor cycling |
| `AppleInspectPanel.tsx` | The side panel and tree |
| `AppleDeviceCreateDialog.tsx` | Clone vs attach |
| `appleRecording.ts` | Recording state, auto-record contract, proof marking |
| `useAppleDeviceStream.ts` | Successor to `useIosSimLiveView` with the window-capture branch removed |

---

## 5. Agent-facing changes

### CLI verb map

The CLI is renamed **`ade apple`**. `ade ios-sim` stays as an alias for **one
release**, printing a one-line deprecation note on stderr the first time per
process. The skill file
`apps/desktop/resources/agent-skills/ade-ios-simulator/SKILL.md` is renamed
`ade-apple/SKILL.md` and rewritten against the new verbs.

| Old | New | Note |
|---|---|---|
| `ios-sim status` | `apple status` | Gains `device.origin` (`clone` / `attached`), `device.laneId`, and `helper` in `tools`; loses `idb` / `idb_companion` |
| `ios-sim apps` | `apple apps` | unchanged |
| `ios-sim launch` | `apple launch` | Creates the lane's device on first ask when none exists |
| `ios-sim open-device` | `apple open-device` | Same; creates on first ask |
| `ios-sim close-device` | `apple close-device` | unchanged |
| `ios-sim shutdown` | `apple shutdown` | unchanged |
| `ios-sim claim` | `apple claim` | unchanged |
| `ios-sim snapshot` | `apple snapshot` | Now served by the helper's accessibility tree |
| `ios-sim tap-element` / `fill-element` / `wait-for-element` / `assert-visible` / `select` | `apple tap-element` / … | unchanged |
| `ios-sim tap` / `drag` / `type` | `apple tap` / `drag` / `type` | Injected by the helper; no idb requirement |
| `ios-sim screenshot` | `apple screenshot` | unchanged |
| `ios-sim proof` / `proof-bundle` | `apple proof` / `proof-bundle` | `proof-bundle` also pins the active recording |
| `ios-sim appearance` / `content-size` / `accessibility` / `location` / `permission` / `push` / `open-url` / `status-bar` / `settings` | `apple <same>` | unchanged |
| `ios-sim relaunch` / `terminate` / `uninstall` / `app-state` | `apple <same>` | unchanged |
| `ios-sim log-start` / `log` / `log-stop` | `apple log-start` / `log` / `log-stop` | unchanged |
| `ios-sim live-start` / `stream-start` / `stream-status` / `stream-stop` | `apple stream-start` / `stream-status` / `stream-stop` | `live-start` is deleted — there is only one backend now. `--backend` is deleted. `--fps`, `--scale-factor`, `--bitrate-kbps` survive |
| `ios-sim preview-*` | `apple preview-*` | unchanged |

### New verbs

```bash
ade --socket apple device-create [--from <simulator>] [--name <name>] --text
ade --socket apple device-attach --simulator <udid|name> --text
ade --socket apple device-list [--installed] [--lane] --text
ade --socket apple device-delete [--force] --text

ade --socket apple record-start [--overlays on|off] [--label <text>] --text
ade --socket apple record-stop [--keep|--discard] --text
ade --socket apple record-list --text
ade --socket apple record-delete --id <id> --text

ade --socket apple frame [--out <path>] --text
```

- `device-create` with no `--from` clones the project's last-used installed
  simulator, else the newest installed iPhone. It never downloads a runtime; with
  none installed it fails with `APPLE_NO_INSTALLED_SIMULATORS` and a hint naming
  Xcode ▸ Settings ▸ Components.
- `device-attach` binds an existing simulator to the lane without cloning.
  `device-delete` refuses an attached device unless `--force`, and `--force` only
  detaches it — ADE never deletes a simulator it did not create.
- `device-list --installed` is what a human-facing picker shows;
  `device-list --lane` is the one device this lane owns.
- `frame` grabs a single decoded frame from the running stream — cheaper than
  `screenshot`, which round-trips `simctl`. `frame` fails when the stream is not
  running; `screenshot` does not need one.
- `record-stop --discard` is only permitted for a recording this chat owns and
  that is not marked `proof`.

### Auto-record contract

1. An agent's first injected input (`tap`, `tap-element`, `type`, `fill-element`,
   `drag`, `select`, `open-url`) against a device with no running recording
   **starts one automatically**, tagged `auto`, owned by the calling chat, with
   overlays per Settings.
2. It stops at the end of the chat's turn, or after 10 minutes, whichever comes
   first. `record-start` while an auto recording is running converts it to a
   manual one (no restart, no gap) and clears the 10-minute cap.
3. An agent may `record-delete` a recording it owns and did not mark `proof`.
   Anything else is refused with `APPLE_RECORDING_PINNED`.
4. `proof-bundle` pins the active recording — or the most recent one from this
   chat if none is active — copies it to the proof drawer, and makes it
   undeletable by any agent.
5. There is **no auto-delete**. Recordings accumulate until the user clears
   unpinned ones from the drawer's Recording section.
6. The verbs report ownership the same way sessions do, so a second chat sees
   `APPLE_OWNED_BY_OTHER_SESSION` with the owning chat, lane, and age — the
   existing cooperative-guard language, unchanged.

---

## 6. Decisions on the open questions (2026-09-21)

1. **Body models.** Bundle the GLB files in the app. Licensing is accepted as an
   open-source risk to fix later if asked.
2. **Recording retention.** No auto-delete. The Diagnostics/Storage section warns
   at a size ceiling. It warns only; it never deletes.
3. **`ade ios-sim` alias window.** One minor release. The published `@ade-dev`
   SDK carries both names for that window.
4. **Preview Lab.** Stays a mode toggle in the Apple column header.
5. **Two devices in one lane.** One at a time, with the "Replace?" prompt. No
   device switcher in the first version.
6. **Watch simulators.** Listed disabled with "Watch support is coming".
