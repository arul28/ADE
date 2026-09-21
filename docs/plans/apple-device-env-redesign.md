# Apple device pane — redesign (round 2)

Supersedes the UI sections of `apple-device-env.md`. The transport, the
helper, the per-lane device registry, recording, the relay pipe, the web
client, and the phone viewer stay as built. Everything the user sees in the
desktop Work tab is rebuilt to the shape below. Reference: t3code PR 12813
(`apps/web/src/components/device/*`), checked out at `$TMPDIR/t3code-ref`
on branch `pr12813`. Copy its structure and restraint, not its code.

## 0. Verdict on round 1 (what must not survive)

- The Apple sibling column, its gutter, `appleColumnWidthPct`,
  `appleColumnClosedUdid`, `WorkAppleColumnPane.tsx`, `appleColumnLayout.ts`,
  `paneSplitterDrag.ts` use for the column, `useAppleLaneDevice.ts` at the
  layout level, and the "Apple device is open in its own column" placeholder.
- The `Device / Preview Lab` header toggle and the `No device · Primary`
  header row. The pane has NO header bar.
- `AppleDeviceCreateDialog.tsx`. There is no modal in this feature.
- The twelve-icon vertical stack and the bottom "Relaunch / Advanced" strip.
- Any raw IPC text on screen (`Error invoking remote method …`).
- Attach or Create without boot. Start must boot and connect video.
- The tools-grid card label "Simulator". It is "Apple".

## 1. Placement

The pane renders INSIDE the Work tools pane as the body of the Apple tab
(`workToolPanels.tsx` case for tool id `ios`). It fills the pane. Width is
whatever the tools pane is; the pane adapts with a container query (see §4).
There is one optional detached form: the floating mini player (§7).

## 2. Layout, top to bottom

```
[ status strip ]            optional, one line, dismissible (§6)
[ body ]                    flex-1, min-h-0, `@container relative`
   ├─ viewport              flex-1: picker | loading | stream | preview
   ├─ rail                  absolute, right, inside the viewport (§5)
   └─ tools drawer          absolute overlay (narrow) or static column ≥700px (§8)
```

No title row. The device name appears only in the loading card, the tools
grid card subtitle, and the rail's "More" menu header.

## 3. States (exact copy)

State is derived from `deviceList({laneId})`, `getStreamStatus`, and the
simulator state. One machine in `appleDeviceState.ts` (rewrite):

| state | viewport | strip |
|---|---|---|
| `unsupported` | centered `EmptyState`: "Apple simulators need a Mac runtime." + tooltip chip with the host reason | none |
| `helper-missing` | `EmptyState`: "ADE's simulator helper is missing from this install." secondary: "Reinstall ADE to restore it." | none |
| `no-device` | the picker (§3.1) | none |
| `starting` | loading card (§3.2) | none |
| `live` | stream (§3.3) | none |
| `video-lost` | last frame stays, dimmed 40% | "Video stopped. [Reconnect]" |
| `stopped` (device shut down) | flat frame placeholder with device silhouette | "iPhone 17 Pro is off. [Start]" |
| `preview` | rendered SwiftUI preview (§8, Preview Lab) with a top-left chip "← Back to device" | none |

### 3.1 Picker (state `no-device`)

Scroll column, content centered, `max-w-xl`, `px-5 py-8`.

```
iOS Simulators                       (heading: Smartphone icon + text-sm font-medium)
┌──────────────────────────────────────────────────────────┐
│ ▢ iPhone 17 Pro       iOS 26.2 · Running          Open   │   booted first
│ ▢ iPhone 17 Pro Max   iOS 26.2 · Stopped          Start  │
│ ▢ ADE Unit C          iOS 26.2 · Stopped          Start  │
├──────────────────────────────────────────────────────────┤
│ + New simulator for this lane   [iPhone Air · iOS 26.2 ▾]  Create │
└──────────────────────────────────────────────────────────┘
Only simulators already installed appear here.        Refresh
```

- Rows: `rounded-xl border divide-y`, each a full-width button, boxed icon,
  title = device name, description = `{runtime} · Running|Stopped`, trailing
  text action `Open` (booted) or `Start` (shut down). Pending → spinner.
  `aria-label` "Start iPhone 17 Pro".
- No pre-selected row. Booted first, then alphabetical.
- Start/Open = `deviceAttach({laneId, udid})` then boot then stream, in one
  click, with the loading card between. Attaching never clones.
- The last row is Create: a select of installed device types + runtimes
  (default = the project's last used, else newest iPhone) and a `Create`
  action = `deviceCreate` (clone) then boot then stream. Name stays
  `<source> — <lane>`.
- Empty: `EmptyState` "No iOS simulators are installed." secondary "Install
  one in Xcode → Settings → Components." with `Refresh`.
- A lane already owning a device never shows the picker (state is
  `starting|live|stopped|video-lost`). To switch device: rail More →
  "Switch device…" which deletes/detaches after an inline confirm row, then
  returns to the picker. `APPLE_DEVICE_EXISTS` can therefore never reach the
  user.

### 3.2 Loading card (state `starting`)

Centered, `bg-background`, `px-6 py-10`: 48px tile with a phone icon, device
name `text-sm font-medium`, `{runtime}` `text-xs muted`, spinner + message,
and a two-segment progress bar (`w-24`, two `h-1 rounded-full` segments).
Messages, in order: "Starting device…" (segment 1) → "Connecting video…"
(segment 2). On failure the spinner and bar hide and the message is the
mapped sentence (§6) with a `Try again` ghost button.

### 3.3 Stream (state `live`)

`AppleDeviceStage` keeps the 3D body and the flat view. Fit rule: measure the
host with a `ResizeObserver`, compute the largest box at the device aspect
(fit by height first, else width). Never use CSS `aspect-ratio` for the
frame. Landscape rotates the media inside a transposed box. Focus ring on
the frame (`role="application"`, `aria-label="iOS Simulator screen"`,
`tabIndex=0`); keyboard forwards while focused. Input-socket loss shows a
bottom-centre pill "Input disconnected, reconnecting…" and disables the rail.

Recording state is a bottom-centre pill: red dot + "Recording 0:42" and a
`Stop` text button. No other recording chrome in the viewport.

## 4. Responsive

Body is a Tailwind container-query root. Below 700px container width the
tools drawer overlays the viewport (`absolute inset-y-0 right-0 w-full
max-w-72 border-l shadow-lg`). At ≥700px it is a static 288px column. The
rail is always present; below 360px the rail collapses to `Home`, `Tools`,
`More` only.

## 5. Rail

`<aside aria-label="Device controls">`, 56px wide, absolute right inside the
viewport, one pill `rounded-full border bg-background/80 p-1 shadow-sm`,
buttons `icon-sm ghost`, `secondary` when pressed. Every button: `aria-label`
+ left tooltip. Dividers `h-px w-5`. Groups:

1. Home · Rotate
2. Dark/Light mode · Text size (menu: Small/Default/Large/Extra large) ·
   Tools (toggles drawer, pressed state) · Screenshot · More
3. 3D · Flat (exclusive pair) · Reset view (3D only)

`More` menu: header line = device name + runtime; items: Record / Stop
recording, Float over chat, Switch device…, separator, Power off (destructive,
last). No Shake anywhere.

Actions serialize through one `act()` with a generation counter; the UI shows
only device-confirmed values (no optimistic toggles). `disabled = pending ||
!detail || !visible`.

## 6. Errors

`apple/appleErrors.ts` maps every helper/simctl/IPC error to
`{ sentence, detail }`. The sentence is ≤ 12 words, plain English. Examples:

| source | sentence |
|---|---|
| helper `Device not booted` | "The device is off." (+ Start action) |
| `APPLE_HELPER_UNAVAILABLE` | "ADE's simulator helper is missing from this install." |
| brain "cannot start the ADE brain directly" | "Install ADE into Applications, then relaunch." |
| `APPLE_STREAM_NOT_RUNNING` | "Video stopped." |
| `APPLE_BUTTON_UNSUPPORTED` | never shown; the control does not exist |
| anything else | "Something went wrong with the simulator." |

Rendering: a status strip at the top of the pane, `role="alert"`,
`border-b bg-destructive/5 px-3 py-2 text-xs text-destructive`, the sentence,
an optional inline action, and a `Details` toggle that reveals `detail` in a
`font-mono text-[11px]` block. Dismiss X at the right. No toasts. Never
`String(error)` in JSX.

## 7. Mini player (replaces the corner card)

Rail More → "Float over chat" closes the pane's stream lease handoff and opens
the floating player: same flat stream, interactive, no rail, `rounded-xl`
frame, `bg-muted shadow-2xl ring-1 ring-inset`, default 320px box fitted to
the device aspect, min 240×150, 12px edge gap, draggable, eight invisible
resize zones. Chrome: an 8px dot top-right (red pulsing while recording)
that expands on hover into a small bar with "Open in pane" and "Close".
Picture-in-picture (native) stays available from that bar.

## 8. Tools drawer

288px, `border-l bg-background text-sm`. Header `h-9 border-b px-3`: "Tools"
+ spinner while pending + close X. Body scrolls. Sections uniform:
`flex flex-col gap-2 border-b px-3 py-2.5`, `h3 text-xs font-medium muted`,
rows `min-h-7 justify-between`, label left, control right. Unsupported
controls render disabled, never hidden.

1. **App** — Foreground (mono, `—`), `Relaunch` `Terminate`; input+button
   rows "https://… or myapp://" → Open, "Bundle ID" → Launch. Existing IPC:
   `getAppState`, `relaunchApp`, `terminateApp`, `openUrl`, `launch`.
2. **Simulator** — Appearance Light/Dark; Text size; switches Reduce Motion,
   Increase Contrast, Reduce Transparency, Show Borders, VoiceOver.
   IPC: `getDeviceSettings`, `setAppearance`, `setContentSize`,
   `setAccessibilityOption`.
3. **Inspect** — one switch "Overlay element frames" (= existing
   `AppleInspectOverlay`); clicking a frame fills a details block below the
   switch (= existing `AppleInspectPanel` content, restyled to the row grid).
4. **Recording** — status row (Idle / Recording 0:42 + Stop), then the lane's
   recordings as rows: name, duration · size, trailing `Pin to proof` and a
   `⋯` menu (Reveal, Delete). IPC: `recordStart/Stop/List/Delete`,
   `captureProofBundle` for pinning.
5. **Location** — Latitude/Longitude mono inputs, Preset select, `Set`
   `Clear`. IPC `setLocation`, `clearLocation`.
6. **Permissions** — app id input, permission select, `Grant` `Revoke`
   `Reset`. IPC `setPermission`.
7. **Push notification** — "Alert text" → `Send`. IPC `sendPushNotification`.
8. **Preview Lab** — the SwiftUI preview feature (`IosSimPreviewLab.tsx`)
   reduced to this section: target picker (from `listPreviewTargets`,
   grouped by file), a `Render` button, and a "Watch file" switch
   (`renderCurrentPreview` on change). Rendering swaps the viewport into
   state `preview` (§3) with the "← Back to device" chip. Workspace actions
   (`ensurePreviewWorkspace`, `openPreviewWorkspace`) live under a `⋯` in the
   section header. No other Preview Lab UI exists anywhere.
9. **Event log** — collapsible, mono 11px, HH:MM:SS + summary, max 100,
   subscribes only while open. IPC `startEventLog/stopEventLog/getEventLog`.

## 9. Elsewhere

- Tools grid card (`workTools.ts`): label "Apple", subtitle = "No device" |
  "{name} · Starting" | "{name} · Running" | "{name} · Off".
- Command palette entries say "Apple".
- Settings › Apple devices section keeps the storage row.
- Web client: same pane (it already mounts the desktop App). Phone: unchanged.
- `ade apple` CLI: unchanged.

## 10. Boot contract (main process)

`iosSimulatorService.deviceStart({laneId, udid?})` (new): attach if the lane
has no device (or create when `create: {sourceUdid}` is given), then
`simctl boot` if state ≠ Booted, then `simctl bootstatus -b`, then
`startStream`. Emits `apple.device.state` events `starting → booted →
streaming` on `onEvent` so the loading card advances. `startStream` itself
also boots when the device is shut down (idempotent), so the phone/web path
never sees "Device not booted". `deviceAttach`/`deviceCreate` keep their
current no-boot semantics for the CLI, documented.

## 11. Ownership

- **Unit R1 (Opus 5, high):** everything under `renderer/components/apple/`
  except `drawer/**` and `appleErrors.ts`; `workToolPanels.tsx` Apple case;
  removal of the column from `TerminalsPage.tsx`, `appStore.ts`,
  `WorkSidebar.tsx`; the tools grid card; the mini player in
  `components/work/`; tests for all of it. Mounts `<AppleToolsDrawer>` from
  `apple/drawer/AppleToolsDrawer.tsx` with the props contract below.
- **Unit R2 (Fable):** `main/services/ios/**` boot contract (§10) + IPC/preload
  + CLI `ade apple start`; `apple/appleErrors.ts` (§6); `apple/drawer/**`
  (§8) including the Preview Lab section that replaces `IosSimPreviewLab.tsx`;
  tests.

Drawer props contract (R1 consumes, R2 provides):

```ts
export interface AppleToolsDrawerProps {
  pin: string | null;            // runtime pin
  laneId: string;
  device: AppleLaneDevice;       // udid, name, runtime, state
  visible: boolean;              // drawer open
  onClose: () => void;
  inspect: { enabled: boolean; setEnabled: (v: boolean) => void; selected: AppleInspectNode | null };
  recording: { active: SimRecording | null; start: () => void; stop: () => void };
  onPreviewRendered: (preview: { dataUrl: string; targetLabel: string } | null) => void; // null = back to device
}
```

`appleErrors.ts` contract (R1 consumes):

```ts
export function describeAppleError(error: unknown): { sentence: string; detail: string; action?: "start" | "reconnect" | "reinstall" };
```

## 12. Acceptance (the user's screenshots, inverted)

1. Tools grid shows "Apple · No device".
2. Apple tab shows the picker list at readable size; no header, no toggle.
3. Clicking Start on a stopped simulator shows the loading card, then the
   live 3D device, in one click, with no dialog.
4. Nothing on screen is truncated, overlapped, or transparent over content.
5. Every rail button has a tooltip. No icon without a name.
6. Killing the simulator externally shows "iPhone 17 Pro is off. [Start]".
7. Preview Lab is a drawer section; rendering shows the preview in the
   viewport with a Back chip.
8. No string starting with "Error invoking remote method" is reachable.
