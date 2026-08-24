export type IosSimulatorDevice = {
  udid: string;
  name: string;
  runtime: string;
  state: string;
  isAvailable: boolean;
};

export type IosSimulatorToolStatus = {
  name: "xcrun" | "xcodebuild" | "simulator_window" | "idb" | "idb_companion";
  available: boolean;
  detail: string;
  installHint: string;
};

export const IOS_SIMULATOR_OWNED_BY_OTHER_SESSION_CODE = "IOS_SIMULATOR_OWNED_BY_OTHER_SESSION" as const;
/** A stored target id points at a project/app bundle that is not under the resolved build root. */
export const IOS_SIMULATOR_TARGET_ROOT_MISMATCH_CODE = "IOS_SIMULATOR_TARGET_ROOT_MISMATCH" as const;
/** A second launch arrived while one was still running. */
export const IOS_SIMULATOR_LAUNCH_IN_PROGRESS_CODE = "IOS_SIMULATOR_LAUNCH_IN_PROGRESS" as const;
/** Only a previously installed app resolved, and the caller did not ask for it by name. */
export const IOS_SIMULATOR_NO_BUILDABLE_TARGET_CODE = "IOS_SIMULATOR_NO_BUILDABLE_TARGET" as const;

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
  /**
   * Xcode product name produced by the application target this launch target
   * resolves to. Distinct from `scheme` because a scheme can build multiple
   * `.app` bundles or a scheme name can differ from the produced `.app`.
   * Used to disambiguate target ids and to resolve the right `.app` bundle
   * after a build (`findAppBundle` prefers `${productName}.app`).
   */
  productName: string | null;
  /**
   * Internal Xcode target identifier (PBXNativeTarget id). Only populated
   * for `kind === "project"`. Carries the discriminator into the target id
   * so two app targets that share a scheme don't collapse onto the same id.
   */
  appTargetId: string | null;
  appBundlePath: string | null;
  installed: boolean;
  canBuild: boolean;
  canLaunch: boolean;
  source: "xcode-project" | "derived-data" | "simctl-listapps";
};

export type IosSimulatorListLaunchTargetsArgs = {
  deviceUdid?: string | null;
  projectRoot?: string | null;
  /**
   * Lane the caller is working in. When no explicit `projectRoot` is given the
   * service resolves this lane's worktree and uses it as the build root, so an
   * agent running in a lane never builds the primary checkout by accident.
   */
  laneId?: string | null;
};

export type IosSimulatorClaimArgs = {
  laneId?: string | null;
  chatSessionId?: string | null;
};

export type IosSimulatorLaunchArgs = {
  deviceUdid?: string | null;
  projectRoot?: string | null;
  laneId?: string | null;
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
  /**
   * Ask the desktop shell to open the iOS simulator drawer for this launch.
   * Defaults to false: agent launches must not steal the user's screen. The
   * drawer passes true for its own launches.
   */
  openDrawer?: boolean | null;
};

export type IosSimulatorCapabilities = {
  canTap: boolean;
  canType: boolean;
  canDrag: boolean;
  canInspect: boolean;
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
  laneId: string | null;
  chatSessionId: string | null;
  mode: IosSimulatorLaunchMode;
  keepSimulatorInBackground?: boolean | null;
  bridgeUrl: string | null;
  startedAt: string;
  claimedAt: string | null;
};

export type IosSimulatorLaunchResult = IosSimulatorSession & {
  /** Absolute directory xcodebuild ran in. Equals the lane worktree for lane launches. */
  buildRoot: string;
  /** True when nothing was rebuilt, so the running app can predate the caller's code changes. */
  usedInstalledBinary: boolean;
  capabilities: IosSimulatorCapabilities;
};

export type IosSimulatorScreenshotArgs = {
  deviceUdid?: string | null;
  projectRoot?: string | null;
  laneId?: string | null;
  /** Where to write the PNG. Relative paths resolve against the build root. */
  outPath?: string | null;
};

export type IosSimulatorScreenshot = {
  deviceUdid: string;
  dataUrl: string;
  /** Absolute path of the written PNG. Agents read this instead of the data URL. */
  filePath: string;
  width: number | null;
  height: number | null;
  capturedAt: string;
};

export type IosSimulatorStreamStatus = {
  deviceUdid: string | null;
  running: boolean;
  backend: IosSimulatorStreamBackend | null;
  requestedBackend?: IosSimulatorStreamBackend | null;
  fallbackReason?: string | null;
  degradationReason?: string | null;
  /**
   * Measured frame rate. The service never measures frames — the renderer owns
   * the Simulator.app window capture — so this stays null service-side instead
   * of reporting a number nobody counted.
   */
  fps: number | null;
  targetFps: number | null;
  /** Null service-side for the same reason as `fps`. */
  frameCount: number | null;
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
  inputBackend?: "idb" | null;
};

export type IosSimulatorStreamBackend = "simulator-window-capture";

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
  | "screen-recording-permission"
  | "automation-denied"
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

export type IosSimulatorPreviewMatchStatus =
  | "matched"
  | "missing-source"
  | "missing-preview"
  | "no-context";

export type IosSimulatorPreviewMatch = {
  status: IosSimulatorPreviewMatchStatus;
  target: IosSimulatorPreviewTarget | null;
  confidence: "exact" | "nearby" | "fallback" | "none";
  reason: string;
  selectedSourceFile: string | null;
  selectedSourceLine: number | null;
  suggestedTitle: string | null;
  suggestedSourceFile: string | null;
  suggestedSourceFilePath: string | null;
};

export type IosSimulatorListPreviewsArgs = {
  projectRoot?: string | null;
  laneId?: string | null;
  sourceFile?: string | null;
  sourceLine?: number | null;
  elementLabel?: string | null;
  componentId?: string | null;
};

export type IosSimulatorEnsurePreviewWorkspaceArgs = {
  projectRoot?: string | null;
  laneId?: string | null;
  sourceFile?: string | null;
  sourceLine?: number | null;
  openIfNeeded?: boolean | null;
  timeoutMs?: number | null;
};

export type IosSimulatorEnsurePreviewWorkspaceResult = {
  ok: boolean;
  opened: boolean;
  path: string | null;
  capability: IosSimulatorPreviewCapability;
  error: string | null;
};

export type IosSimulatorRenderPreviewArgs = {
  projectRoot?: string | null;
  laneId?: string | null;
  sourceFilePath: string;
  previewDefinitionIndexInFile?: number | null;
  tabIdentifier?: string | null;
  timeoutSec?: number | null;
  manageXcode?: boolean | null;
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

export type IosSimulatorRenderCurrentPreviewArgs = IosSimulatorListPreviewsArgs & {
  tabIdentifier?: string | null;
  timeoutSec?: number | null;
};

export type IosSimulatorRenderCurrentPreviewResult = {
  ok: boolean;
  match: IosSimulatorPreviewMatch;
  target: IosSimulatorPreviewTarget | null;
  render: IosSimulatorRenderPreviewResult | null;
  error: string | null;
};

export type IosSimulatorOpenPreviewWorkspaceArgs = {
  projectRoot?: string | null;
  laneId?: string | null;
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
  laneId?: string | null;
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
  laneId?: string | null;
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
  laneId?: string | null;
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

export type IosSimulatorDrawerMode = "interact" | "inspect" | "preview";

export type IosSimulatorEventPayload =
  | {
    type: "drawer-open-requested";
    action: string;
    mode: IosSimulatorDrawerMode;
    chatSessionId?: string | null;
    laneId?: string | null;
  }
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
