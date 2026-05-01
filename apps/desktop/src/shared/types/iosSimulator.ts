export type IosSimulatorDevice = {
  udid: string;
  name: string;
  runtime: string;
  state: string;
  isAvailable: boolean;
};

export type IosSimulatorToolStatus = {
  name: "xcrun" | "xcodebuild" | "iosurface_indigo" | "simulator_window" | "idb" | "idb_companion" | "ffmpeg";
  available: boolean;
  detail: string;
  installHint: string;
};

export const IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE = "IOS_SIMULATOR_OWNED_BY_OTHER_SESSION" as const;

export type IosSimulatorShutdownArgs = {
  force?: boolean | null;
};

export type IosSimulatorShutdownResult = {
  released: boolean;
  previousSession: IosSimulatorSession | null;
};

export type IosSimulatorStatus = {
  platform: NodeJS.Platform;
  supported: boolean;
  tools: IosSimulatorToolStatus[];
  activeDevice: IosSimulatorDevice | null;
  activeSession: IosSimulatorSession | null;
};

export type IosSimulatorLaunchMode = "snapshot" | "live";

export type IosSimulatorLaunchTargetKind = "project" | "built" | "installed";

export type IosSimulatorLaunchTarget = {
  id: string;
  kind: IosSimulatorLaunchTargetKind;
  name: string;
  bundleId: string | null;
  detail: string;
  projectPath: string | null;
  scheme: string | null;
  appBundlePath: string | null;
  installed: boolean;
  canBuild: boolean;
  canLaunch: boolean;
  source: "xcode-project" | "derived-data" | "simctl-listapps";
};

export type IosSimulatorListLaunchTargetsArgs = {
  deviceUdid?: string | null;
  projectRoot?: string | null;
};

export type IosSimulatorLaunchArgs = {
  deviceUdid?: string | null;
  projectRoot?: string | null;
  targetId?: string | null;
  bundleId?: string | null;
  appBundlePath?: string | null;
  projectPath?: string | null;
  scheme?: string | null;
  chatSessionId?: string | null;
  build?: boolean;
  mode?: IosSimulatorLaunchMode;
  keepSimulatorInBackground?: boolean | null;
  force?: boolean | null;
  environment?: Record<string, string> | null;
  arguments?: string[] | null;
};

export type IosSimulatorSession = {
  id: string;
  deviceUdid: string;
  deviceName: string | null;
  bundleId: string;
  appName: string | null;
  appBundlePath: string | null;
  targetId: string | null;
  projectRoot: string | null;
  chatSessionId: string | null;
  mode: IosSimulatorLaunchMode;
  keepSimulatorInBackground?: boolean | null;
  bridgeUrl: string | null;
  startedAt: string;
};

export type IosSimulatorScreenshot = {
  deviceUdid: string;
  dataUrl: string;
  width: number | null;
  height: number | null;
  capturedAt: string;
};

export type IosSimulatorStreamStatus = {
  deviceUdid: string | null;
  running: boolean;
  backend: IosSimulatorStreamBackend | null;
  requestedBackend?: "auto" | IosSimulatorStreamBackend | null;
  fallbackReason?: string | null;
  degradationReason?: string | null;
  fps: number | null;
  targetFps: number | null;
  frameCount: number;
  startedAt: string | null;
  lastFrameAt: string | null;
  lastError: string | null;
  error?: {
    code: string;
    exitCode?: number | null;
    signal?: string | null;
  } | null;
  streamUrl: string | null;
  averageLatencyMs?: number | null;
  latencyP50Ms?: number | null;
  latencyP95Ms?: number | null;
  helperPid?: number | null;
  inputBackend?: "indigo" | "idb" | null;
};

export type IosSimulatorStreamBackend =
  | "iosurface-indigo"
  | "simctl-screenshot-poll"
  | "idb-mjpeg"
  | "idb-h264-ffmpeg-mjpeg"
  | "simulator-window-capture";

export type IosSimulatorWindowSource = {
  id: string;
  name: string;
  thumbnailDataUrl: string | null;
};

export type IosSimulatorWindowIssue =
  | "not-running"
  | "hidden"
  | "minimized"
  | "no-window"
  | "unknown";

export type IosSimulatorWindowState = {
  appRunning: boolean;
  visible: boolean | null;
  windowCount: number | null;
  minimizedWindowCount: number | null;
  capturable: boolean | null;
  issue: IosSimulatorWindowIssue | null;
  message: string | null;
};

export type IosSimulatorPreviewWindow = {
  tabIdentifier: string;
  title: string | null;
  workspacePath: string | null;
  raw: string;
};

export type IosSimulatorPreviewCapability = {
  platform: NodeJS.Platform;
  supported: boolean;
  docsUrl: string;
  xcodeVersion: string | null;
  mcpbridgeAvailable: boolean;
  xcodeRunning: boolean;
  xcodeWindows: IosSimulatorPreviewWindow[];
  selectedWindow: IosSimulatorPreviewWindow | null;
  setupSteps: string[];
  error: string | null;
  checkedAt: string;
};

export type IosSimulatorPreviewTarget = {
  id: string;
  title: string;
  sourceFile: string;
  sourceFilePath: string;
  absoluteSourceFile: string;
  sourceLine: number;
  previewDefinitionIndexInFile: number;
  kind: "preview-macro" | "preview-provider";
  proximity: "selected-file" | "feature-file" | "project";
};

export type IosSimulatorListPreviewsArgs = {
  projectRoot?: string | null;
  sourceFile?: string | null;
  sourceLine?: number | null;
};

export type IosSimulatorRenderPreviewArgs = {
  projectRoot?: string | null;
  sourceFilePath: string;
  previewDefinitionIndexInFile?: number | null;
  tabIdentifier?: string | null;
  timeoutSec?: number | null;
};

export type IosSimulatorRenderPreviewResult = {
  ok: boolean;
  target: {
    sourceFilePath: string;
    previewDefinitionIndexInFile: number;
    tabIdentifier: string | null;
  };
  previewSnapshotPath: string | null;
  dataUrl: string | null;
  width: number | null;
  height: number | null;
  renderedAt: string;
  capability: IosSimulatorPreviewCapability;
  error: string | null;
};

export type IosSimulatorOpenPreviewWorkspaceArgs = {
  projectRoot?: string | null;
};

export type IosSimulatorStartStreamArgs = {
  deviceUdid?: string | null;
  fps?: number | null;
  backend?: "auto" | IosSimulatorStreamBackend | null;
};

export type IosSimulatorFrame = {
  deviceUdid: string;
  dataUrl: string;
  width: number | null;
  height: number | null;
  capturedAt: string;
  frameCount: number;
  backend: IosSimulatorStreamBackend;
};

export type IosSimulatorLaunchStepId =
  | "resolve-device"
  | "boot-simulator"
  | "open-simulator"
  | "resolve-target"
  | "build-app"
  | "install-app"
  | "launch-app"
  | "ready";

export type IosSimulatorLaunchStepStatus = "pending" | "running" | "complete" | "skipped" | "failed";

export type IosSimulatorLaunchProgress = {
  launchId: string;
  step: IosSimulatorLaunchStepId;
  status: IosSimulatorLaunchStepStatus;
  message: string;
  detail?: string | null;
  deviceUdid?: string | null;
  targetId?: string | null;
  updatedAt: string;
};

export type IosSimulatorPoint = {
  deviceUdid?: string | null;
  projectRoot?: string | null;
  x: number;
  y: number;
};

export type IosSimulatorDragArgs = {
  deviceUdid?: string | null;
  projectRoot?: string | null;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  durationMs?: number | null;
  delta?: number | null;
};

export type IosInspectableFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type IosElementContextItem = {
  kind: "ios_element";
  id: string;
  componentId: string;
  sourceFile: string | null;
  sourceLine: number | null;
  frame: IosInspectableFrame | null;
  metadata: Record<string, unknown>;
  accessibilityIdentifier?: string | null;
  screenshotDataUrl?: string | null;
  selectedAt: string;
};

export type IosInspectableScreen = {
  width: number;
  height: number;
  scale: number;
};

export type IosInspectableElement = {
  id: string;
  componentId: string;
  sourceFile: string | null;
  sourceLine: number | null;
  frame: IosInspectableFrame;
  pixelFrame: IosInspectableFrame;
  metadata: Record<string, unknown>;
  accessibilityIdentifier?: string | null;
};

export type IosInspectorSnapshot = {
  deviceUdid: string;
  appContainerPath: string;
  generatedAt: string;
  screen: IosInspectableScreen;
  elements: IosInspectableElement[];
};

export type IosScreenElementSource = "ade-inspector" | "accessibility";

export type IosScreenElementLayer = "app" | "accessibility";

export type IosScreenElement = {
  id: string;
  source: IosScreenElementSource;
  layer: IosScreenElementLayer;
  label: string | null;
  value: string | null;
  role: string | null;
  elementType: string | null;
  identifier: string | null;
  frame: IosInspectableFrame;
  pixelFrame: IosInspectableFrame;
  componentId: string | null;
  sourceFile: string | null;
  sourceLine: number | null;
  metadata: Record<string, unknown>;
};

export type IosScreenSnapshotProvider = {
  source: IosScreenElementSource | "screenshot";
  available: boolean;
  elementCount?: number;
  error?: string | null;
  generatedAt?: string | null;
};

export type IosScreenSnapshotArgs = {
  deviceUdid?: string | null;
  projectRoot?: string | null;
  x?: number | null;
  y?: number | null;
};

export type IosScreenSnapshot = {
  deviceUdid: string;
  capturedAt: string;
  screenshot: IosSimulatorScreenshot;
  screen: IosInspectableScreen;
  elements: IosScreenElement[];
  hitElement: IosScreenElement | null;
  providers: IosScreenSnapshotProvider[];
  inspectorSnapshot: IosInspectorSnapshot | null;
};

export type IosSimulatorInspectPointArgs = {
  deviceUdid?: string | null;
  projectRoot?: string | null;
  x: number;
  y: number;
  includeScreenshot?: boolean | null;
};

export type IosSimulatorInspectResult = {
  item: IosElementContextItem | null;
  source: "ade-inspector" | "accessibility" | "coordinate-fallback" | "none";
  snapshot: IosInspectorSnapshot | null;
  screenSnapshot?: IosScreenSnapshot | null;
};

export type IosSimulatorSelectResult = {
  item: IosElementContextItem;
  source: "ade-inspector" | "accessibility" | "coordinate-fallback";
};

export type IosSimulatorEventPayload =
  | { type: "session-started"; session: IosSimulatorSession }
  | { type: "session-updated"; session: IosSimulatorSession | null }
  | { type: "session-released"; previousSession: IosSimulatorSession | null }
  | { type: "selection"; item: IosElementContextItem }
  | { type: "launch-progress"; progress: IosSimulatorLaunchProgress }
  | { type: "stream-started"; status: IosSimulatorStreamStatus }
  | { type: "stream-status"; status: IosSimulatorStreamStatus }
  | { type: "stream-stopped"; status: IosSimulatorStreamStatus }
  | { type: "stream-frame"; frame: IosSimulatorFrame }
  | { type: "stream-error"; status: IosSimulatorStreamStatus };
