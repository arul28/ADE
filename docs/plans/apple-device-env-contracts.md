# Apple device environment — phase 2 contracts

Shared names for the units that build in parallel. Read together with
`apple-device-env.md` (UI spec, verb map, auto-record contract) and the helper
protocol in `apps/desktop/native/ADESimHelper/Sources/ADESimHelperCore/Protocol.swift`.

## Unit ownership (phase 2)

| Unit | Owner | Owns (may edit) | Must not edit |
|---|---|---|---|
| 2A service | Opus | `apps/desktop/src/main/services/ios/**` except `recording/**`; `apps/desktop/src/shared/types/iosSimulator.ts`; the `iosSimulator` preload namespace (`preload.ts`, `global.d.ts`); its IPC handlers; the `iosSimulator` section of `apps/ade-cli/src/adeRpcServer.ts`; the lane archive/delete hook in `laneService.ts` (one call) | CLI command layer in `cli.ts`, renderer, docs, skill, settings manifest |
| 2C recording | Opus | `apps/desktop/native/ADESimHelper/**`; `apps/desktop/src/main/services/ios/recording/**` (new); one hook call site in the chat turn lifecycle | `iosSimulatorService.ts` (2A integrates via the interfaces below) |
| 2D CLI + docs | Grok | `apps/ade-cli/src/cli.ts` and bootstrap (command layer only); `apps/desktop/resources/agent-skills/ade-apple/**` (new) + old skill stub; `docs/features/apple-device/**` (renamed from `ios-simulator`); `apps/desktop/package.json` dist wiring + `electron-builder` resources filter; `apps/desktop/scripts/build-sim-helper.mjs` dist notes | `adeRpcServer.ts`, services, renderer |
| 2E settings + labels | Grok | `settingsManifest.ts` and settings UI for the new keys; `workTools.ts` tab label; phone `WorkToolsRow.swift` label; web client tab label | services, CLI, the simulator panel |

## Helper transport (2A provides, 2C consumes)

```ts
// apps/desktop/src/main/services/ios/simHelperClient.ts (2A)
export interface SimHelperTransport {
  /** Send one NDJSON command; resolves with the `ok` payload or rejects with SimHelperError {code,message}. */
  send(command: Record<string, unknown> & { type: string; udid?: string }): Promise<Record<string, unknown>>;
  /** Subscribe to helper events (capture-started, capture-stopped, and any new record-* events). */
  onEvent(listener: (event: { type: string } & Record<string, unknown>) => void): () => void;
  /** Absolute path of the helper binary in use, for diagnostics. */
  readonly binaryPath: string;
}
```

2C adds helper commands `record-start {udid, path, overlays: boolean, fps?}`,
`record-stop {udid}`, `overlay-tap {udid, x, y}`, `overlay-text {udid, text}` and
events `record-started {udid, path}`, `record-stopped {udid, path, durationMs, bytes}`.
2C exposes to 2A:

```ts
// apps/desktop/src/main/services/ios/recording/simRecordingService.ts (2C)
export interface SimRecordingService {
  noteInput(input: { laneId: string; udid: string; chatSessionId: string | null; kind: "tap"|"type"|"drag"|"select"|"open-url"; x?: number; y?: number; text?: string }): Promise<void>; // auto-record start + overlay events
  start(args: { laneId: string; udid: string; chatSessionId: string | null; overlays?: boolean; label?: string }): Promise<SimRecording>;
  stop(args: { laneId: string; keep?: boolean; discard?: boolean; chatSessionId: string | null }): Promise<SimRecording | null>;
  list(args: { laneId: string }): Promise<SimRecording[]>;
  remove(args: { laneId: string; id: string; chatSessionId: string | null; force?: boolean }): Promise<void>;
  pinActiveOrLatest(args: { laneId: string; chatSessionId: string | null }): Promise<SimRecording | null>; // proof-bundle
  onTurnEnded(chatSessionId: string): Promise<void>; // stops auto recordings owned by that chat
}
export type SimRecording = { id: string; laneId: string; udid: string; chatSessionId: string | null; path: string; startedAt: string; endedAt: string | null; durationMs: number | null; bytes: number | null; mode: "auto"|"manual"; proof: boolean; label: string | null; overlays: boolean };
```

Storage: `<projectRoot>/.ade/artifacts/apple-recordings/<laneId>/<id>.mp4` with a
sidecar `<id>.json` = SimRecording. Lane delete removes the directory (2A wires
the call next to `removeLaneArtifactFiles`).

## Service API additions (2A) — preload namespace stays `iosSimulator`

New methods, mirrored 1:1 as RPC methods in `adeRpcServer.ts` with the same names:

```
deviceCreate({ laneId, from?, name? })      -> LaneDevice
deviceAttach({ laneId, simulator })         -> LaneDevice
deviceList({ installed?: boolean, laneId? })-> { installed: InstalledSimulator[]; lane: LaneDevice | null }
deviceDelete({ laneId, force? })            -> void
recordStart / recordStop / recordList / recordDelete  (delegate to SimRecordingService)
frame({ laneId, outPath? })                 -> { filePath, width, height }   // helper screenshot, no simctl
```

`LaneDevice = { laneId, udid, name, origin: "clone"|"attached", family: "iphone"|"ipad"|"watch", runtime, createdAt, templateUdid: string|null }`.
Persist lane devices in the lanes DB (new table via the project's migration
convention) and the project's last-used template in project settings.

Removed: everything idb (`ensureCompanion`, companion registry, `idb-h264`
backend name, `simulator-window-capture` backend, `live-start`, `--backend`,
`tools.idb`/`tools.idb_companion`). `status.tools` gains `helper: { present, path, version }`.
Window-capture preload methods (`getSimulatorWindowState`, `listSimulatorWindowSources`,
parking holds) stay exported but return inert results until phase 3 deletes their callers.

## Error codes

`APPLE_NO_INSTALLED_SIMULATORS`, `APPLE_DEVICE_EXISTS`, `APPLE_DEVICE_ATTACHED_NOT_DELETABLE`,
`APPLE_RECORDING_PINNED`, `APPLE_OWNED_BY_OTHER_SESSION` (reuse existing ownership error shape),
`APPLE_HELPER_UNAVAILABLE`, `APPLE_STREAM_NOT_RUNNING`.

## Settings keys (2E)

`apple.realisticBody` (bool, default true), `apple.recordingOverlays.tapRings` (true),
`apple.recordingOverlays.keyBadges` (true), `apple.remoteBitrateKbpsCap` (number, default 2500),
`apple.recordingsWarnBytes` (number, default 5 GiB; warn only, never delete).

## CLI (2D)

`ade apple <verb>` per the verb map in the spec; `ade ios-sim` alias prints one
deprecation line to stderr per process. New verbs call the RPC methods above.
Do not add SDK surface: `packages/sdk` has no simulator API today (verify).

# Phase 3 contracts — renderer components

All new files live under `apps/desktop/src/renderer/components/apple/`. Units 3B
and 3C create files only; unit 3A (the column) integrates them.

| Unit | Owner | Creates | Must not edit |
|---|---|---|---|
| 3A column | Opus | `AppleDeviceColumn.tsx`, `AppleDeviceToolbar.tsx`, `AppleDeviceStage.tsx`, `AppleDeviceFlatView.tsx`, `AppleDeviceCreateDialog.tsx`, `useAppleDeviceStream.ts`, `appleRecording.ts`; rewrites `ChatIosSimulatorPanel.tsx` to host the column; deletes the window-capture branch of `useIosSimLiveView.ts` | 3B/3C/3D files beyond wiring their props |
| 3B 3D viewer | Grok | `AppleDevice3DView.tsx`, `appleDeviceModels.ts`, `appleDeviceOrbit.ts` (spring math, pure), `renderer/assets/apple-device-models/*.glb` + `sources.json`, tests; adds `three` to `apps/desktop/package.json` | anything else |
| 3C inspect | Grok | `AppleInspectOverlay.tsx`, `AppleInspectPanel.tsx`, `appleInspectGeometry.ts` (pure hit-test/ancestor math), tests | anything else |
| 3D corner card + PiP | Grok | `workLiveCard.ts` + `WorkLiveCornerCard.tsx` changes (ios keyed by device id, H.264 source via `useAppleDeviceStream` once 3A lands it, `recording` field, native PiP via canvas.captureStream) and the "Simulator running" pill | the column |

## 3B — `AppleDevice3DView`

```ts
export type AppleDeviceFamily = "iphone" | "ipad";
export type AppleDeviceOrientation = "portrait" | "portrait-upside-down" | "landscape-left" | "landscape-right";
export type AppleDevice3DViewProps = {
  /** The decoded device screen. The stage draws every frame into this canvas; the view samples it as a texture. */
  screenCanvas: HTMLCanvasElement | null;
  /** Increments once per drawn frame; the view re-uploads the texture when it changes and otherwise renders only on interaction. */
  frameVersion: number;
  family: AppleDeviceFamily;
  /** Product hint from the simulator device type, e.g. "iPhone 17 Pro"; the model map picks the closest body. */
  deviceTypeName: string | null;
  realistic: boolean;               // false = procedural body (rounded slab with bezel), no GLB load
  orientation: AppleDeviceOrientation;
  screenPixelSize: { width: number; height: number };
  interactive: boolean;             // false = watching; pointer never reaches onDeviceInput
  onDeviceInput: (input: { phase: "begin" | "move" | "end"; x: number; y: number }) => void; // device POINTS (not pixels), origin top-left, already orientation-corrected
  onReady?: (info: { modelId: string | null; procedural: boolean }) => void;
  className?: string;
};
```
Rules: load Three.js lazily (dynamic import) so the flat view never pays for it;
orbit with trackpad drag + pinch zoom, spring release that latches the nearest
screen-facing view (t3 #12787 feel: gain ~0.006 rad/pt, limits 7.5–9 rad/s,
release prediction 85 ms, response/damping 0.5/0.78 — see t3 #12813 text);
render on demand only (frame, interaction, resize); raycast pointer to the
screen node's UV and convert to device points; dispose everything on unmount;
GLB load failure or unknown device => procedural body and `onReady({procedural:true})`.
Assets: fetch the four GLBs and `sources.json` from
`https://raw.githubusercontent.com/pingdotgg/t3code/playful-device-panel/apps/web/src/components/device/models/<file>`
into `renderer/assets/apple-device-models/`; import with Vite `?url`. Map:
iPhone Pro Max names -> `iphone-18-pro-max`, other iPhones -> `iphone-18-pro`,
any iPad -> `ipad-pro-13-m5` (keyboard accessory out of scope for now).

## 3C — inspect overlay + panel

```ts
import type { IosSimulatorSnapshotElement } from "../../../shared/types/iosSimulator"; // existing snapshot element type; check the exact export name
export type AppleInspectOverlayProps = {
  elements: IosSimulatorSnapshotElement[];   // frames in device POINTS
  /** Maps a device point to overlay-local CSS pixels; supplied by the presenter (flat or 3D). Null while the presenter cannot map (3D mid-orbit). */
  deviceToView: ((point: { x: number; y: number }) => { x: number; y: number }) | null;
  hoveredRef: string | null;
  selectedRef: string | null;
  onHover: (ref: string | null) => void;
  onSelect: (ref: string | null) => void;
  /** Alt/Option cycles to the ancestor of the hovered element; the overlay owns the key handling while focused. */
  className?: string;
};
export type AppleInspectPanelProps = {
  elements: IosSimulatorSnapshotElement[];
  selectedRef: string | null;
  onSelect: (ref: string | null) => void;
  onCopyCommand: (command: string) => void;     // e.g. `ade --socket apple tap-element --ref id:xyz`
  onInsertIntoChat: (context: string) => void;  // the existing "insert inspect context" text shape
  refreshing: boolean;
  onRefresh: () => void;
};
```
Rules: pure geometry in `appleInspectGeometry.ts` (smallest-area hit under a
point, ancestor chain by containment when the snapshot has no parent ids,
label/identifier/role/source formatting); overlay draws rectangles with the
ADE cyan inspect tone already used by `ChatIosSimulatorPanel.tsx` (`bg-cyan-500/22`);
hover = outline + label chip, selected = filled tint; keyboard: Esc clears
selection, Alt cycles ancestors; the panel shows a tree with the selected node
expanded and a details block (label, role, identifier, ref tier, source file:line).

# Phase 4 contracts — cross-machine

| Unit | Owner | Owns | Must not edit |
|---|---|---|---|
| 4A video pipe + web viewer | Opus | brain-side stream forwarder (`services/ios/appleStreamRelay.ts`), sync protocol additions for `apple.*` (device state, stream ticket, input), tunnel-relay pipe kind if one is needed, web client `iosSimulator` adapter (replaces the native-unavailable stub) and the web Apple column mount with interact | the desktop column internals, the phone app |
| 4B phone viewer | Opus | `apps/ios/ADE/Views/Work/AppleDevice*.swift` (view-only viewer with VideoToolbox decode into `AVSampleBufferDisplayLayer`), `WorkToolsSheet.swift` Simulator card, `SyncService.swift` additions for the same `apple.*` messages | web client, desktop |

## Wire

- Control and state ride the existing JSON sync protocol: `apple.status` (per lane: device, session, stream, recording, owner), `apple.input` (web only: touch/type/drag in device points, guarded by ownership), `apple.streamTicket` (returns `{ url, token, codec, width, height, expiresAt }` for the requester's transport).
- Video rides a dedicated binary channel, never the JSON envelope. Direct path first: when the client can reach the brain's sync listener, it opens a second WebSocket to the brain at `/apple/stream/<ticket>` and the brain pipes the helper's loopback record stream through unchanged (12-byte records, Annex-B keyframes carry SPS/PPS). Relay path: the same WebSocket dialed through the tunnel relay's pipe mechanism (it forwards binary frames verbatim; add a pipe "kind" only if the brain-side bridge needs it to pick the local target port).
- Viewer must send `{t:"visible"}` / `{t:"hidden"}` and the brain stops forwarding (and asks the helper to stop capture when no local viewer either) on hidden. Bitrate: the brain restarts capture with `apple.remoteBitrateKbpsCap` when the first remote viewer attaches.
- Health: first-frame timeout 5 s, frame-time watchdog 3 s, Reconnect = new ticket + new socket. Web decodes with WebCodecs (HTTPS origin). Phone decodes natively.
