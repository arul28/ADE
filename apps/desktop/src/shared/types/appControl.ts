export type AppControlAppKind = "electron";

export type AppControlProvider = "cdp" | "os-accessibility" | "computer-use" | "external";

export type AppControlFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

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

export type AppControlStatus = {
  platform: NodeJS.Platform;
  supported: boolean;
  activeSession: AppControlSession | null;
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
  chatSessionId: string | null;
  startedAt: string;
  connectedAt: string | null;
  status: "starting" | "running" | "connected" | "stopping" | "exited" | "stopped" | "failed";
  lastError: string | null;
};

export type AppControlStopArgs = {
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

export type AppControlSnapshotArgs = {
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

export type AppControlInspectPointArgs = {
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

export type AppControlClickArgs = {
  x: number;
  y: number;
  scale?: number | null;
  coordinateSpace?: AppControlCoordinateSpace | null;
};

export type AppControlTypeTextArgs = {
  text: string;
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

export type AppControlEventPayload =
  | { type: "session-started"; session: AppControlSession }
  | { type: "session-updated"; session: AppControlSession | null }
  | { type: "session-stopped"; previousSession: AppControlSession | null }
  | { type: "selection"; item: AppControlContextItem }
  | { type: "frame"; frame: AppControlScreencastFrame };
