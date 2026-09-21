# Apple Development — round 5 (owner live test after 3a7170389)

Round 4 shipped. The owner tested it and found five defects plus a program.
Build all of it. The 3D body itself was praised — do not restyle it.

## Verified causes (checked in code before writing this)

- `AppleDeviceFlatView.tsx` contains the word `orientation` **zero** times.
  Only the 3D view receives it. So a landscape device draws its landscape
  picture inside a portrait box, rotated on its side. That is the owner's
  screenshot of the ADE sign-in page lying sideways.
- `workToolPanels.tsx:471` does pass `onAddContext={canInsertContext ? … }`,
  so the inspect card's chat insert is gated on `canInsertContext` and on
  `onAddIosContext` actually reaching the composer. One of those is false at
  runtime. Trace it; do not assume.
- `closeWorkToolForReal.ts` `ios` branch calls `ios.shutdown(...)`, which ends
  the chat's *device session*. That is not a power off. The simulator stays
  Booted, the tools card keeps saying "ADE Repro · Running", and the tool
  comes straight back.

## Unit V — viewport (Opus 5, high)

Files: `renderer/components/apple/{AppleDeviceFlatView,AppleDeviceStage,AppleDevice3DView,AppleDevicePane,AppleDeviceRail,AppleInspectOverlay}.tsx`,
`apple/appleDeviceState.ts` (append-only), their tests, and
`terminals/workToolPanels.tsx` ONLY for the context-prop trace in V4.

V1. **Orientation reaches the flat view.** Transpose the picture when the
device is landscape, the way t3code's `DeviceStreamView.tsx` does — rotate the
media inside a swapped box rather than distorting it, because the helper
streams the raw portrait framebuffer. Pointer mapping, inspect frames and the
fit rule must all follow the rotation. Port with the usual attribution header.

V2. **A real orientation control.** The rail's single "Rotate device" is not
enough and the owner could not find it. Give the rail an orientation control
that shows the current orientation and offers Portrait, Portrait upside down,
Landscape left and Landscape right. Drive the existing `rotate` IPC.

V3. **3D paints on first open.** Opening the tool with 3D selected shows
nothing until the owner toggles Flat and back. Find why the first mount does
not present a frame — most likely the screen texture is bound before the first
decoded frame arrives and nothing re-binds it — and make the first paint
arrive without a toggle. Add a test that a mount with frames already flowing
renders a textured screen.

V4. **Inspect inserts into chat again.** Clicking an element in the inspect
card must put that element into the chat composer, as it did in round 4's
proof. Trace `canInsertContext` and `onAddIosContext` from
`workToolPanels.tsx` to the composer and fix the break. Add a test that
survives a refactor of the panel props.

## Unit S — shutdown, agent control, skills (Opus 5, high)

Files: `renderer/components/terminals/closeWorkToolForReal.ts`,
`main/services/ios/**`, `shared/types/iosSimulator.ts`, `preload/**`,
`apps/ade-cli/**`, `apps/desktop/resources/agent-skills/**`, `docs/**`.
Do not touch Unit V's renderer files.

S1. **Close and shut down must power the device off.** Today it ends the chat
session and the device stays Booted and returns at once. Power the simulator
off for real, leave the lane device registered, and make sure nothing
re-adopts or re-boots it afterwards. The pane must then offer Start. Test the
whole path.

S2. **Agents drive the device as a first-class citizen.** Audit every
`ios_simulator` action an agent can call and close the gaps so an agent can,
without a human: find the lane's device or create one, boot and stream it,
tap, type, scroll, press buttons, rotate, read the accessibility tree, find
and act on elements by query, screenshot, record, and read the app's log.
Every one must be reachable from the ADE actions surface and from `ade apple`,
with the same names in both. Fix any that is missing, misnamed or broken.

S3. **Proof by default for agents.** A screenshot an agent takes and a
recording an agent makes both land in the proof drawer with a useful caption,
with no extra step. Video already auto-files; make screenshots match, and make
`ade apple screenshot`/`proof` consistent with the desktop behaviour.

S4. **Auto-binding and discovery.** An agent starting in a lane must be able to
learn, from the tools it already has, that this lane has an Apple device, what
state it is in, and what it can do with it — without reading source. Provide
the status/discovery call that answers that in one shot, and make the skill
point at it.

S5. **Rewrite the skills and docs.** `resources/agent-skills/ade-apple/SKILL.md`
is rewritten from scratch against the shipped product: the name is Apple
Development, the rail and four-group drawer, `deviceStart`, recordings filing
themselves as proof, the close rules. Purge every stale mention of idb, of
"ios-sim" as the primary name, of window capture, and of the removed column
and Preview Lab toggle, across `resources/agent-skills/**` and `docs/**`.
Regenerate `resources/ade-cli-help.txt`. Any instruction that no longer matches
the product is deleted, not softened.

## Gates (both units)

`cd apps/desktop && node --max-old-space-size=8192 node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
(3 `WorkspaceGraphPage.tsx` errors are environmental), `npx vitest run` on each
touched directory, `apps/desktop/node_modules/.bin/eslint` on touched files.
For the CLI, `npx tsc -p tsconfig.json --noEmit` and its vitest. No commits, no
`git stash`, no hand-started `ade serve`, never a fresh `ADE_HOME`. Unit V owns
the live check: `npm run dev:desktop -- --project-root <this worktree>
--skip-runtime-build`, existing "ADE Repro" only, never create a simulator,
screenshots to `$TMPDIR/apple-round5-proof/`, then stop the app and its dev
brain and confirm the installed brain still runs.
