# Apple Development pane — round 3 (make it usable, make it solid)

Supersedes the visual and behaviour rules in `apple-device-env-redesign.md`
where they conflict. Round 2 shipped one pane and a working stream (after the
CORS fix, 78ae89c6c). The 2026-09-21 live test on the dev app found it still
not usable. This round fixes function first, then makes every surface solid
and consistent with the tools grid the user likes (the purple gradient page
with translucent cards).

Reference code you MAY port (t3code is MIT; keep a `// Ported from t3code
<path> (MIT, T3 Tools Inc.)` header on any file that carries their code):
`$TMPDIR/t3code-ref` branch `pr12813`, `apps/web/src/components/device/*`,
`apps/web/src/components/preview/ThreadPreviewMiniPlayer.tsx`,
`previewMiniPlayerLayout.ts`, `phoneTrackpad.ts`. Port the pieces that work
there instead of re-deriving them: DeviceStreamView's fit + pointer
normalisation + keyboard forwarding, the controls rail, the mini player
layout and hover chrome, the tools drawer section grid.

## A. Function (Unit F, Opus 5 high)

A1. **Input does nothing.** The desktop log (`$TMPDIR/apple-round3-logs/desktop.log`)
shows dozens of `Remote ADE service timed out waiting for method
ade/actions/call (25000ms)` while the user tapped the live device. Find which
action hangs (add the action name to that log line), why (`enqueueControl` →
helper `touch`? a lease/ownership wait? the `noteInput` recording start
blocking the control queue?), fix it, and add a test that a tap resolves in
well under a second with a fake helper. Pointer → device mapping must use the
ported DeviceStreamView normalisation (0..1 of the drawn frame, begin/move/end,
pointer capture), not ad-hoc math.

A2. **Recording starts by itself.** `iosSimulatorService.tap/typeText` call
`noteInput` for every input. Rule: auto-record starts only for AGENT input
(a call carrying a `chatSessionId` that belongs to an agent chat), never for
a human driving the pane. Human input during an agent recording is still
captured (it is on screen) but never starts one. The user's manual Record
button is the only other way to start.

A3. **Recordings vanish → every recording is proof.** Three files sat in
`.ade/artifacts/apple-recordings/<lane>/*.mp4` with nothing on screen. Rule
(user decision 2026-09-21): when a recording stops, for any reason, it is
registered as a proof artifact (kind: video) in the proof drawer at once —
attributed to the chat whose input started it, or to the user's active chat
for a manual recording — with caption "Simulator recording · {device} ·
{duration}". No "Pin to proof" button anywhere; the drawer's Recording section
lists the same items with **Open in proof** and a `⋯` menu (Reveal in Finder,
Delete, which also removes the proof artifact). After Stop an inline row
appears at the bottom of the viewport for 6 s: "Saved to proof · 0:23 ·
8.5 MB · [Open]". Recordings also appear in the lane's Files tool under
`.ade/artifacts/apple-recordings`. Use the existing proof artifact service
(`ade proof attach` path / `captureProofBundle` plumbing), not a new store.

A4. **Close / minimize rules (owner decision 2026-09-21, shared with every
screen tool).** Closing the Apple Development TAB closes the tool for real:
stream lease released, this chat's device session released (the lane device
stays). Closing only the tools PANE, or switching tool, keeps it running and
shows the floating corner preview (A5). Per-chat toggle "Show preview when
minimized", default ON; X on the floating preview turns it OFF for that chat;
turning it back ON shows the preview at the next minimize. Float and maximize
live in the tool's own header/rail, never in the tools tab strip. State is the
shared `renderer/state/workLiveCardState.ts` (from lane mac-desktop) and
`chat/chatCompanionUiState.ts` — no parallel store.

A5. **The floating player is blank.** "Float over chat" showed an empty
transparent box with a permanently visible menu. Port
`ThreadPreviewMiniPlayer` + `previewMiniPlayerLayout`: same flat stream as
the pane (shares the stream lease), opaque `bg-surface` frame with `ring-1`,
`rounded-xl`, default 320px box at the device aspect, min 240×150, draggable,
resizable from invisible edge zones, chrome = an 8px dot top-right that
expands into a small opaque bar ONLY on hover/focus ("Open in pane", "Close").
Native picture-in-picture stays in that bar. Drive: taps and keys pass
through exactly as in the pane.

A6. **Dev-mode fallback error.** `Error occurred in handler for
'ade.iosSimulator.getStatus': iOS Simulator service is not available` — a
status read fell to the local IPC path when the project runtime was bound.
Route every `iosSimulator.*` read through the bound runtime when one exists;
the local IPC path is only for the packaged in-process runtime.

A7. Tests for A1–A6. Verify A1 and A5 against the real dev app: launch with
`npm run dev:desktop -- --project-root <lane worktree>` (it shares ~/.ade,
brain is --no-sync, prints an isolation report), open the ADE project's lane,
Start the device, tap, float. Screenshot proof into `$TMPDIR`, not the proof
drawer.

## B. Design (Unit D, Opus 5 high)

Rule zero: **no translucent surface anywhere in this feature.** Every panel,
drawer, rail, menu, strip, card, and player frame is opaque `bg-surface` (or
the gradient card style below). Backdrop blur is allowed only on the gradient
cards, never on text-bearing overlays over the device. The two screenshots
that triggered this: the drawer showing the simulator through it, and the
mini player showing the chat through it.

B1. **Name and icon.** The tool is **Apple Development** everywhere: tools
grid card, tab, palette, settings section, docs, `workTools.ts` label, CLI
help title. Icon = the Apple logo (add an `AppleLogo` SVG to the icon set;
monochrome, currentColor). Card subtitle stays "No device" | "{name} ·
Starting" | "{name} · Running" | "{name} · Off".

B2. **Picker.** Replace the flat list with the tools-grid card language on
the gradient background:
- A hero card for the lane's device (or, with none, for the newest iPhone):
  large device silhouette, name, model, runtime, state, one primary
  **Start/Open** button.
- Below: sections by family — **iPhone**, **iPad**, **Apple Watch**,
  **Apple TV**, **Apple Vision** — each a row of smaller cards with the
  family silhouette, name, model line ("ADE Repro · iPhone 17 Pro"), runtime,
  state, and Start/Open. Custom-named simulators always show the model.
- A final card "New simulator for this lane" with the device-type select and
  Create.
- Footer line "Only simulators already installed appear here. Refresh".
Families come from `deviceTypeIdentifier`. The heading is never "iOS
Simulators".

B3. **Live surface.** The viewport sits on the gradient (same page background
as the tools grid), not pure black. The device is centred with the ported fit
rule. The rail is an opaque pill. The status strip is an opaque bar.

B4. **Drawer.** Opaque `bg-surface`, `border-l`, the ported section grid.
Rows never wrap a label and its control onto two lines; at narrow widths the
drawer overlays (opaque) and the viewport does not shrink under 200px. Fix the
Simulator section's clipped rows seen in the screenshot (labels colliding with
switches).

B5. **Loading card and error strip** restyled as gradient cards; copy stays as
in round 2.

B6. **Consistency pass.** Every button in the feature uses the shared
`Button` primitive and the tools-grid type scale. No icon without tooltip.
Snapshot tests for the picker (family grouping, model line for custom names)
and the drawer rows (no wrap, disabled-not-hidden).

## Ownership

- Unit F: `apps/desktop/src/main/services/ios/**`, `preload/**` (routing),
  `renderer/components/apple/{useAppleDeviceStream,appleStreamLease,appleRecording,AppleDeviceMiniPlayer,appleMiniPlayerLayout,appleMiniPlayerStore,useAppleDeviceControls}.ts(x)`,
  `renderer/components/apple/AppleDeviceStage.tsx` (pointer + fit port),
  `renderer/components/work/**`, `renderer/components/terminals/workToolPanels.tsx`
  (close → mini player), tests.
- Unit D: `renderer/components/apple/{AppleDevicePane,AppleDevicePicker,AppleDeviceRail,AppleDeviceStatusStrip,AppleDeviceLoadingCard}.tsx`,
  `renderer/components/apple/drawer/**`, `renderer/components/terminals/workTools.ts`,
  `commandPaletteWork.tsx`, settings section copy, icons, docs. Do not touch
  Unit F's files; if a prop is needed from them, define it in
  `apple/appleDeviceState.ts` (shared, append-only) and tell the coordinator.

Gates for both: desktop tsc (`node --max-old-space-size=8192
node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`), vitest on the
touched dirs, eslint on touched files. No commits, no stash, no `ade serve` by
hand, no fresh `ADE_HOME`.
