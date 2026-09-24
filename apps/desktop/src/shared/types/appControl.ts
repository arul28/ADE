import type { MacDesktopPermissions } from "./macDesktop";
import type { ComputerUseArtifactLink, ComputerUseArtifactRecord } from "./computerUseArtifacts";
import type {
  AgentActionTraceEntry,
  AgentDomSnapshot,
  AgentElementSnapshot,
  AgentFrame,
  ComputerUseActionEffect,
} from "./agentObservation";

export type AppControlAppKind = "electron";

/**
 * Where a piece of information about the app came FROM — the provenance of an
 * element, a snapshot, or a selection.
 *
 * Not to be confused with {@link AppControlDriver}, which is how ADE dispatches
 * input. The two unions share member names and differ in spelling on purpose:
 * provenance is hyphenated (`computer-use`), the driver is underscored
 * (`computer_use`, the wire value `ade app-control --driver` takes).
 */
export type AppControlProvider = "cdp" | "os-accessibility" | "computer-use" | "external";

/**
 * How ADE actually drives the controlled app — see {@link AppControlProvider}
 * for the provenance union with the near-identical member names.
 *
 * - `cdp` — Chrome DevTools Protocol against an Electron renderer. Implemented.
 * - `computer_use` — OS-level screen/keyboard/mouse control for non-Electron
 *   apps. Typed and capability-gated here; the driver itself is not built yet.
 */
export type AppControlDriver = "cdp" | "computer_use";

export type AppControlDriverCapability = {
  driver: AppControlDriver;
  status: "available" | "unavailable";
  /** Human-readable reason, always present when status is `unavailable`. */
  reason: string | null;
  implemented: boolean;
};

export type AppControlDriversResult = {
  platform: NodeJS.Platform;
  activeDriver: AppControlDriver | null;
  drivers: AppControlDriverCapability[];
};

export type AppControlFrame = AgentFrame;

export type AppControlCoordinateSpace = "screenshot" | "viewport";

export type AppControlScreen = {
  /** Screenshot/live-frame bitmap width in pixels. */
  width: number;
  /** Screenshot/live-frame bitmap height in pixels. */
  height: number;
  /** Back-compat alias for scaleX. */
  scale: number;
  /** CSS viewport width that CDP input commands expect. */
  viewportWidth?: number;
  /** CSS viewport height that CDP input commands expect. */
  viewportHeight?: number;
  devicePixelRatio?: number;
  /** Bitmap-to-viewport horizontal scale. */
  scaleX?: number;
  /** Bitmap-to-viewport vertical scale. */
  scaleY?: number;
};

/**
 * Which lane an App Control call acts on. App Control keeps one session per
 * lane. A caller names its lane directly, or through its chat, or through the
 * session id it holds. A call that resolves to no lane is refused.
 */
export type AppControlLaneArgs = {
  laneId?: string | null;
  chatSessionId?: string | null;
};

export type AppControlStatus = {
  platform: NodeJS.Platform;
  supported: boolean;
  /** The lane this status answers for. Null when the caller named no lane. */
  laneId: string | null;
  /** The lane's session. Null when the lane has none or no lane was named. */
  activeSession: AppControlSession | null;
  /** Every lane's session in this project, for user clients that list them. */
  sessions: AppControlSession[];
  providers: Array<{
    provider: AppControlProvider;
    available: boolean;
    detail?: string | null;
  }>;
};

export type AppControlClaimArgs = {
  laneId?: string | null;
  chatSessionId?: string | null;
};

export type AppControlLaunchArgs = {
  appKind?: AppControlAppKind | null;
  driver?: AppControlDriver | null;
  projectRoot?: string | null;
  laneId?: string | null;
  command?: string | null;
  cwd?: string | null;
  cdpPort?: number | null;
  debugPort?: number | null;
  env?: Record<string, string | null | undefined> | null;
  label?: string | null;
  chatSessionId?: string | null;
  force?: boolean | null;
};

export type AppControlConnectArgs = {
  appKind?: AppControlAppKind | null;
  driver?: AppControlDriver | null;
  projectRoot?: string | null;
  laneId?: string | null;
  cdpPort: number;
  label?: string | null;
  chatSessionId?: string | null;
  force?: boolean | null;
};

export type AppControlSession = {
  id: string;
  appKind: AppControlAppKind;
  label: string;
  projectRoot: string | null;
  laneId: string | null;
  cwd: string | null;
  command: string | null;
  pid: number | null;
  terminalSessionId: string | null;
  terminalPtyId: string | null;
  cdpPort: number | null;
  cdpEndpoint: string | null;
  cdpTargetId: string | null;
  provider: AppControlProvider;
  driver: AppControlDriver;
  chatSessionId: string | null;
  startedAt: string;
  connectedAt: string | null;
  status: "starting" | "running" | "connected" | "stopping" | "exited" | "stopped" | "failed";
  lastError: string | null;
  /** Id of the most recent observation captured for this session. */
  lastObservationId: string | null;
  /** Id of the most recent trace entry recorded for this session. */
  lastTraceEntryId: string | null;
};

export type AppControlStopArgs = AppControlLaneArgs & {
  sessionId?: string | null;
  force?: boolean | null;
};

export type AppControlScreenshot = {
  sessionId: string;
  cdpTargetId?: string | null;
  capturedAt: string;
  width: number;
  height: number;
  dataUrl: string;
};

export type AppControlElement = {
  id: string;
  ref: string;
  provider: AppControlProvider;
  tagName: string | null;
  role: string | null;
  label: string | null;
  value: string | null;
  selector: string | null;
  testId: string | null;
  frame: AppControlFrame;
  pixelFrame: AppControlFrame;
  metadata: Record<string, unknown>;
};

export type AppControlSourceMatch = {
  sourceFile: string;
  sourceLine: number;
  confidence: "exact" | "candidate";
  reason: string;
  snippet?: string | null;
};

export type AppControlSnapshotProvider = {
  provider: AppControlProvider | "screenshot";
  available: boolean;
  elementCount?: number;
  error?: string | null;
};

export type AppControlSnapshotArgs = AppControlLaneArgs & {
  sessionId?: string | null;
  projectRoot?: string | null;
  x?: number | null;
  y?: number | null;
  coordinateSpace?: AppControlCoordinateSpace | null;
};

export type AppControlSnapshot = {
  session: AppControlSession | null;
  capturedAt: string;
  screenshot: AppControlScreenshot | null;
  screen: AppControlScreen;
  elements: AppControlElement[];
  hitElement: AppControlElement | null;
  providers: AppControlSnapshotProvider[];
  url: string | null;
  title: string | null;
};

export type AppControlInspectPointArgs = AppControlLaneArgs & {
  sessionId?: string | null;
  projectRoot?: string | null;
  x: number;
  y: number;
  scale?: number | null;
  coordinateSpace?: AppControlCoordinateSpace | null;
  includeScreenshot?: boolean | null;
};

export type AppControlContextItem = {
  kind: "app_control_element";
  id: string;
  appKind: AppControlAppKind;
  sessionId: string | null;
  provider: AppControlProvider | "coordinate-fallback";
  componentId: string;
  sourceFile: string | null;
  sourceLine: number | null;
  frame: AppControlFrame | null;
  metadata: Record<string, unknown>;
  screenshotDataUrl?: string | null;
  selectedAt: string;
};

export type AppControlInspectResult = {
  item: AppControlContextItem | null;
  source: AppControlProvider | "coordinate-fallback" | "none";
  snapshot: AppControlSnapshot;
};

export type AppControlSelectResult = {
  item: AppControlContextItem;
  source: AppControlProvider | "coordinate-fallback";
  snapshot?: AppControlSnapshot;
};

export type AppControlClickArgs = AppControlLaneArgs & {
  sessionId?: string | null;
  x: number;
  y: number;
  scale?: number | null;
  coordinateSpace?: AppControlCoordinateSpace | null;
};

export type AppControlTypeTextArgs = AppControlLaneArgs & {
  sessionId?: string | null;
  text: string;
};

export type AppControlScrollArgs = AppControlLaneArgs & {
  sessionId?: string | null;
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  scale?: number | null;
  coordinateSpace?: AppControlCoordinateSpace | null;
};

export type AppControlDispatchKeyArgs = AppControlLaneArgs & {
  sessionId?: string | null;
  type: "keyDown" | "keyUp" | "rawKeyDown" | "char";
  key?: string | null;
  code?: string | null;
  text?: string | null;
  unmodifiedText?: string | null;
  modifiers?: number | null;
  autoRepeat?: boolean | null;
  isKeypad?: boolean | null;
  location?: number | null;
  windowsVirtualKeyCode?: number | null;
  nativeVirtualKeyCode?: number | null;
};

export type AppControlAttachToTargetArgs = AppControlLaneArgs & {
  sessionId?: string | null;
  targetId: string;
};

export type AppControlTarget = {
  id: string;
  title: string | null;
  url: string | null;
  type: string;
  active: boolean;
};

export type AppControlScreencastFrame = {
  sessionId: string;
  /** The lane whose session produced the frame. */
  laneId?: string | null;
  cdpTargetId?: string | null;
  /** PNG/JPEG bytes encoded as base64 (no data: prefix). */
  data: string;
  mimeType: "image/jpeg" | "image/png";
  /** Encoded bitmap width in pixels. */
  width: number;
  /** Encoded bitmap height in pixels. */
  height: number;
  /** Back-compat alias for scaleX. */
  scale: number;
  viewportWidth?: number;
  viewportHeight?: number;
  devicePixelRatio?: number;
  scaleX?: number;
  scaleY?: number;
  capturedAt: string;
};

/**
 * Every event names its lane, so a pane or a remote viewer picks its own
 * lane's session out of one project stream.
 */
export type AppControlEventPayload =
  | { type: "session-started"; laneId: string | null; session: AppControlSession }
  | { type: "session-updated"; laneId: string | null; session: AppControlSession | null }
  | { type: "session-stopped"; laneId: string | null; previousSession: AppControlSession | null }
  | { type: "selection"; laneId: string | null; item: AppControlContextItem }
  | { type: "frame"; laneId: string | null; frame: AppControlScreencastFrame }
  /** A lane's recording started, stopped, or failed. */
  | { type: "recording-changed"; laneId: string; status: AppControlRecordingStatus }
  /**
   * The session's error tally changed. Mirrors the built-in browser's
   * `diagnostics` event so the Work tools pane lights the same red dot for App
   * Control that it lights for the Browser, push-driven rather than polled.
   * Counts are since the app's last navigation or reattach.
   */
  | {
      type: "diagnostics";
      laneId: string | null;
      sessionId: string;
      consoleErrorCount: number;
      failedRequestCount: number;
      updatedAt: string;
    };

/* ---------------------------------------------------------------------------
 * Agent action model
 *
 * Mirrors the built-in browser's observe/act contract (stable `obs-…:e:N`
 * element handles, per-session action traces, post-action observations) so an
 * agent drives an Electron app the same way it drives a page.
 * ------------------------------------------------------------------------- */

export type AppControlSessionTargetArgs = AppControlLaneArgs & {
  /**
   * Picks the session by id when no lane is named, and guards it when one is:
   * rejected when it names a session that is not the lane's.
   */
  sessionId?: string | null;
};

export type AppControlObservationArgs = AppControlSessionTargetArgs & {
  keepCount?: number | null;
  includeDataUrl?: boolean;
  includeDom?: boolean;
  includeElementMap?: boolean;
  includeDiagnostics?: boolean;
  maxElements?: number | null;
};

export type AppControlObservationCleanup = {
  keepCount: number;
  keptCount: number;
  deletedCount: number;
};

export type AppControlElementSnapshot = AgentElementSnapshot;

export type AppControlDomSnapshot = AgentDomSnapshot;

export type AppControlObservationElementMap = {
  filePath: string;
  relativePath: string | null;
  width: number;
  height: number;
  mimeType: string;
  elementCount: number;
  dataUrl?: string;
};

export type AppControlConsoleDiagnostic = {
  level: "debug" | "info" | "warning" | "error";
  message: string;
  sourceId: string | null;
  line: number | null;
  column: number | null;
  timestamp: string;
};

export type AppControlNetworkDiagnostic = {
  url: string;
  method: string | null;
  resourceType: string | null;
  statusCode: number | null;
  error: string | null;
  startedAt: string | null;
  endedAt: string;
  durationMs: number | null;
};

export type AppControlDiagnostics = {
  capturedAt: string;
  pendingRequestCount: number;
  console: AppControlConsoleDiagnostic[];
  network: AppControlNetworkDiagnostic[];
};

export type AppControlObservation = {
  id: string;
  sessionId: string | null;
  cdpTargetId: string | null;
  url: string | null;
  title: string | null;
  capturedAt: string;
  width: number;
  height: number;
  mimeType: string;
  filePath: string;
  relativePath: string | null;
  dataUrl?: string;
  dom?: AppControlDomSnapshot | null;
  elementMap?: AppControlObservationElementMap | null;
  diagnostics?: AppControlDiagnostics | null;
  laneId: string | null;
  chatSessionId: string | null;
  cleanup: AppControlObservationCleanup;
};

export type AppControlElementTargetArgs = {
  selector?: string | null;
  text?: string | null;
  testId?: string | null;
  elementIndex?: number | null;
  handle?: string | null;
};

export type AppControlAgentActionArgs = AppControlObservationArgs & {
  observe?: boolean;
  waitAfterMs?: number | null;
};

export type AppControlAgentClickArgs = AppControlAgentActionArgs & AppControlElementTargetArgs & {
  x?: number | null;
  y?: number | null;
  scale?: number | null;
  coordinateSpace?: AppControlCoordinateSpace | null;
  button?: "left" | "middle" | "right";
  clickCount?: number | null;
};

export type AppControlAgentHoverArgs = AppControlAgentActionArgs & AppControlElementTargetArgs & {
  x?: number | null;
  y?: number | null;
  scale?: number | null;
  coordinateSpace?: AppControlCoordinateSpace | null;
};

export type AppControlAgentFillArgs = AppControlAgentActionArgs & AppControlElementTargetArgs & {
  /** The payload to type. `text` stays reserved for matching the element. */
  value?: string | null;
};

export type AppControlAgentClearArgs = AppControlAgentActionArgs & AppControlElementTargetArgs;

export type AppControlAgentTypeArgs = AppControlAgentActionArgs & {
  text: string;
};

export type AppControlAgentPressArgs = AppControlAgentActionArgs & AppControlElementTargetArgs & {
  key: string;
};

export type AppControlAgentScrollArgs = AppControlAgentActionArgs & {
  x?: number | null;
  y?: number | null;
  deltaX?: number | null;
  deltaY?: number | null;
  scale?: number | null;
  coordinateSpace?: AppControlCoordinateSpace | null;
};

export type AppControlAgentWaitArgs = AppControlAgentActionArgs & AppControlElementTargetArgs & {
  url?: string | null;
  loadState?: "domcontentloaded" | "load" | "network-idle";
  timeoutMs?: number | null;
  networkIdleMs?: number | null;
};

export type AppControlActionTraceEntry = AgentActionTraceEntry & { cdpTargetId: string | null };

export type AppControlTraceArgs = AppControlSessionTargetArgs & {
  limit?: number | null;
};

export type AppControlTraceResult = {
  sessionId: string | null;
  entries: AppControlActionTraceEntry[];
};

export type AppControlAgentActionResult = {
  ok: true;
  observation: AppControlObservation | null;
  session: AppControlSession | null;
  trace: AppControlActionTraceEntry | null;
  /**
   * The element the target resolved to, or null when the action went to a
   * point or to whatever had focus. Read before the input was sent.
   */
  resolved: AppControlElementSnapshot | null;
  /** Whether anything visibly changed between the state before the input and the post-action observation. */
  effect: ComputerUseActionEffect;
};

export type AppControlWindowsResult = {
  sessionId: string | null;
  activeTargetId: string | null;
  windows: AppControlTarget[];
};

export type AppControlSwitchWindowArgs = AppControlSessionTargetArgs & {
  targetId: string;
};

/* ---------------------------------------------------------------------------
 * Recording
 *
 * The same contract as Mac Desktop's recording. One recording per lane, chat
 * owned, capped at ten minutes when a chat owns it, idle time cut unless
 * `keepIdle`, and filed as proof when it has a caption.
 * ------------------------------------------------------------------------- */

/**
 * How the video is made.
 *
 * - `window-capture` — macOS. The desktop helper records the app's own window
 *   with ScreenCaptureKit. Needs Screen Recording permission.
 * - `screencast` — Windows and Linux. The ADE desktop app encodes the CDP
 *   screencast frames with MediaRecorder. Needs the desktop app on this machine.
 */
export type AppControlRecordingEngine = "window-capture" | "screencast";

export type AppControlRecordingStopReason = "requested" | "cap" | "app-closed";

/** Field names mirror `MacDesktopRecordingStatus`. */
export type AppControlRecordingStatus = {
  laneId: string;
  running: boolean;
  startedAt: string | null;
  /** Host-absolute path. Set once the recording stops, or the partial file when a stop failed. */
  filePath: string | null;
  /** The video's own length, after the idle cut. */
  durationMs: number | null;
  /** Set when the recording was started with one; it files the video as proof. */
  caption: string | null;
  lastError?: string | null;
  /** The proof record the video was filed as, or null. */
  proofArtifactId?: string | null;
  bytes?: number | null;
  /** The chat that started it. The proof is filed under this chat. */
  chatSessionId?: string | null;
  /** Real time the video covers. */
  wallDurationMs?: number | null;
  /** Still time cut from the video: `wallDurationMs - durationMs`. */
  idleCutMs?: number | null;
  /** Wall-clock cap, or null for none. */
  maxDurationMs?: number | null;
  stopReason?: AppControlRecordingStopReason | null;
  engine: AppControlRecordingEngine;
  /** The App Control session the recording belongs to. */
  sessionId?: string | null;
  /**
   * macOS only: the Screen Recording and Accessibility grants, the same
   * values the Mac Desktop pane shows. Set when a start was refused for them.
   */
  permissions?: MacDesktopPermissions | null;
};

export type AppControlRecordStartArgs = AppControlLaneArgs & {
  caption?: string | null;
  /** Keep still stretches. By default they are cut. */
  keepIdle?: boolean | null;
  /** Wall-clock cap in seconds. A chat's recording defaults to ten minutes. */
  maxSeconds?: number | null;
  fps?: number | null;
};

export type AppControlRecordStopArgs = AppControlLaneArgs;

export type AppControlRecordingStatusArgs = AppControlLaneArgs;

/** `app_control.captureProof`: one still of the lane's app, filed as proof. */
export type AppControlCaptureProofArgs = AppControlLaneArgs & {
  /** What the still shows. Defaults to "App Control screenshot · <app>". */
  caption?: string | null;
};

/**
 * The filed still. `artifacts` and `links` are the proof broker's own answer,
 * so a caller can name the record and its owners.
 */
export type AppControlCaptureProofResult = {
  artifactId: string;
  /** Host-absolute path of the captured PNG. */
  filePath: string;
  width: number;
  height: number;
  caption: string;
  laneId: string;
  chatSessionId: string | null;
  artifacts: ComputerUseArtifactRecord[];
  links: ComputerUseArtifactLink[];
  warnings?: string[];
};
