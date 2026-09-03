/**
 * The iOS simulator shapes, copied down from the app's own.
 *
 * These are `apps/desktop/src/shared/types/iosSimulator.ts` narrowed to what
 * the page actually draws. Copied rather than imported because the page builds
 * separately from the app it ships inside and no type crosses the bridge — the
 * seam is `pageActions.js` plus `host/actions.ts`, and `test/seam.test.tsx` is
 * what proves the two halves still agree.
 *
 * `NodeJS.Platform` is spelled as a plain string here for the same reason: the
 * page has no `@types/node` platform union to widen, and the only thing it does
 * with the value is print it.
 */

export type IosSimulatorDevice = {
  udid: string;
  name: string;
  runtime: string;
  state: string;
  isAvailable: boolean;
};

export type IosSimulatorToolName =
  | "xcrun"
  | "xcodebuild"
  | "simulator_window"
  | "idb"
  | "idb_companion";

export type IosSimulatorToolStatus = {
  name: IosSimulatorToolName;
  available: boolean;
  detail: string;
  installHint: string;
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
  mode: "snapshot" | "live";
  bridgeUrl: string | null;
  startedAt: string;
  claimedAt: string | null;
  buildRoot?: string | null;
  usedInstalledBinary?: boolean | null;
};

export type IosSimulatorStatus = {
  platform: string;
  supported: boolean;
  tools: IosSimulatorToolStatus[];
  activeDevice: IosSimulatorDevice | null;
  activeSession: IosSimulatorSession | null;
};

export type IosSimulatorLaunchTarget = {
  id: string;
  kind: "project" | "built" | "installed";
  name: string;
  bundleId: string | null;
  detail: string;
  projectPath: string | null;
  scheme: string | null;
  productName: string | null;
  appTargetId: string | null;
  appBundlePath: string | null;
  installed: boolean;
  canBuild: boolean;
  canLaunch: boolean;
  source: "xcode-project" | "derived-data" | "simctl-listapps";
};

export type IosSimulatorStreamStatus = {
  deviceUdid: string | null;
  running: boolean;
  backend: string | null;
  fps: number | null;
  targetFps: number | null;
  startedAt: string | null;
  lastFrameAt: string | null;
  lastError: string | null;
  streamUrl: string | null;
  /** Short, actionable blocker text. Null when the host has a window to capture. */
  message: string | null;
};

export type IosInspectableFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type IosScreenElement = {
  id: string;
  source: "ade-inspector" | "accessibility";
  layer: "app" | "accessibility";
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
};

export type IosScreenSnapshot = {
  deviceUdid: string;
  capturedAt: string;
  screen: { width: number; height: number; scale?: number | null };
  elements: IosScreenElement[];
  hitElement: IosScreenElement | null;
};

export type IosSimulatorPreviewWindow = {
  tabIdentifier: string;
  title: string | null;
  workspacePath: string | null;
};

export type IosSimulatorPreviewCapability = {
  platform: string;
  supported: boolean;
  docsUrl: string;
  xcodeVersion: string | null;
  mcpbridgeAvailable: boolean;
  xcodeRunning: boolean;
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

export type IosSimulatorPreviewMatch = {
  status: "matched" | "missing-source" | "missing-preview" | "no-context";
  target: IosSimulatorPreviewTarget | null;
  confidence: "exact" | "nearby" | "fallback" | "none";
  reason: string;
  selectedSourceFile: string | null;
  selectedSourceLine: number | null;
  suggestedTitle: string | null;
  suggestedSourceFile: string | null;
  suggestedSourceFilePath: string | null;
};

/** What a rendered preview came back as. `dataUrl` is a PNG the page paints. */
export type IosSimulatorRenderPreviewResult = {
  ok: boolean;
  dataUrl: string | null;
  width: number | null;
  height: number | null;
  renderedAt: string | null;
  error: string | null;
};

/** One screenshot, as the host answers it. */
export type IosSimulatorScreenshot = {
  deviceUdid: string;
  dataUrl: string;
  filePath: string;
  width: number | null;
  height: number | null;
  capturedAt: string;
};

/** What an inspect answered about one point. */
export type IosSimulatorInspectResult = {
  element: IosScreenElement | null;
  source: "ade-inspector" | "accessibility" | "coordinate-fallback" | "none";
};

/** The two surfaces, and the three modes inside them. */
export type SimulatorSurface = "simulator" | "preview";
export type SimulatorMode = "interact" | "inspect" | "preview";
