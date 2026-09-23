# Apple Development pane — round 4 (owner decisions, 2026-09-21 evening)

Round 3 landed (1ddcdb05e). The owner tested it live and approved this plan.
Build it now. Everything below is decided; do not re-litigate it.

## Owner decisions

1. Record lives in the RAIL, not in the drawer.
2. Inspect lives in the RAIL, not in the drawer.
3. Real 3D models on by default. The plain procedural body is DELETED.
4. 3D and Flat become ONE toggle button, 3D selected by default.
5. The four-group drawer split is approved as written below.

## Confirmed defects (verified in code, not opinion)

- `AppleInspectOverlay` is never mounted anywhere. Inspect only disables
  tapping and disables 3D. It is a dead switch.
- `AppleDevicePane.tsx` passes `realistic={false}` hard-coded, so the 3D view
  always draws the procedural slab. The vendored Apple models are unused,
  which is why there is no Apple logo.
- `AppleDeviceFlatView` clamps its fit with `Math.min(fit, 1)`, so the device
  never grows past its point size and a large pane is mostly empty.

## Unit A — viewport and rail (Opus 5, high)

Files: `renderer/components/apple/{AppleDevicePane,AppleDeviceStage,AppleDevice3DView,AppleDeviceFlatView,AppleDeviceRail,AppleInspectOverlay,AppleInspectPanel}.tsx`,
`apple/{appleDeviceModels,appleDeviceOrbit,appleInspectGeometry}.ts`, their
tests, and append-only edits to `apple/appleDeviceState.ts`.
Do NOT touch `apple/drawer/**`, the mini player, `TerminalsPage.tsx`,
`closeWorkToolForReal.ts`, or `workToolPanels.tsx` — those are Unit B's.

A1. **Real models always.** Delete the procedural body path and the
`realistic` prop. The 3D view always loads the vendored GLB for the device
family. If the model fails to load or WebCodecs is missing, fall back to the
FLAT view and say so once in the status strip — never a plain slab.
A2. **One view toggle.** Replace the exclusive 3D/Flat pair with a single
rail button that switches between them and shows which is active. 3D is the
default. Persist the choice per project.
A3. **3D drives the device.** Tap, scroll and typing reach the device through
the existing screen-mesh raycast. A drag that starts on the screen is input;
a drag that starts off the screen orbits; holding Alt forces orbit. Keep
Reset view. Port t3code's `phoneTrackpad.ts` behaviour with a
`// Ported from t3code <path> (MIT, T3 Tools Inc.)` header.
A4. **Inspect, working.** Mount `AppleInspectOverlay`. Inspect is a rail
toggle. On, it draws element frames over the device. Clicking a frame opens a
compact card anchored to it with the element's details and two buttons,
**Insert into chat** (via `workToolContextInsertion`) and **Copy**. Escape or
a second click on the toggle closes it.
A5. **Rail contents, in order:** Home, Rotate, Inspect (toggle), Screenshot,
Record (toggle, clear red active state), View (3D/Flat toggle), More. REMOVE
Appearance and Text size from the rail — they live in the drawer only, and
today they are duplicated in both.
A6. **Scale up.** Remove the `Math.min(fit, 1)` cap so the device fills the
pane. Cap the growth at the stream's pixel size so it never upscales past its
real resolution.
A7. Tests for every item plus the gates below.

## Unit B — drawer, close, float (Opus 5, high)

Files: `renderer/components/apple/drawer/**`,
`apple/{AppleDeviceMiniPlayer.tsx,appleMiniPlayerLayout.ts,appleMiniPlayerStore.ts}`,
`renderer/components/terminals/{closeWorkToolForReal.ts,workToolPanels.tsx}`,
the `AppleDeviceMiniPlayer` mount in `TerminalsPage.tsx` (line ~1502 only),
a new `apple/AppleShutdownConfirm.tsx`, and their tests.
Do NOT touch `AppleDevicePane.tsx`, the rail, the stage, or either view —
those are Unit A's. If you need a prop from them, message Unit A.

B1. **Four collapsible groups.** Replace the nine flat sections with:
| Group | Holds |
|---|---|
| Device | Appearance, Text size, accessibility toggles, Location, Status bar |
| App | Foreground app, Relaunch, Terminate, Open URL, Launch bundle, Permissions, Push notification |
| Capture | Recordings list (Open in proof, Reveal, Delete) |
| Preview Lab | Target, Render, workspace actions |
One group open at a time; remember the last one per chat. The Inspect and
Recording SECTIONS are deleted — Inspect and Record are rail controls now.
Capture keeps only the recordings list; it does not start a recording.
B2. **Visual pass.** Every group is an opaque card in the tools-grid card
language. Muted labels, controls right-aligned, accent colour only on the
active or primary control. No white outlines on every input and button.
B3. **Closing the tab powers the device off.** Extend the `ios` branch of
`closeWorkToolForReal` to release the chat's stream lease and then power the
device off (the lane device stays registered). When the device is BOOTED,
first show an ADE dialog, never a macOS one: title "Shut down ADE Repro?",
body "Closing this tab powers off the simulator.", buttons Cancel and
**Close and shut down**. Minimising the tools pane must never do this.
B4. **Float preview is slow.** Trace why the floating preview takes a visible
moment to appear after the tools pane closes, and remove the gap. The stream
lease is refcounted, so keep the stream alive across the handover and mount
the player with the last frame at once.
B5. Tests for every item plus the gates below.

## Gates (both units)

`cd apps/desktop && node --max-old-space-size=8192 node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
(the 3 `WorkspaceGraphPage.tsx` errors are environmental), `npx vitest run` on
every touched directory, `apps/desktop/node_modules/.bin/eslint` on touched
files. No commits, no `git stash`, no hand-started `ade serve`, never a fresh
`ADE_HOME`. One unit may launch the dev app to verify
(`npm run dev:desktop -- --project-root <this worktree> --skip-runtime-build`);
if you do, use the already-installed simulator, never create one, and stop the
app and its dev brain when you finish.
