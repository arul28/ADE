export type IosSimulatorDevice = {
  udid: string;
  name: string;
  runtime: string;
  state: string;
  isAvailable: boolean;
};

export type IosSimulatorToolStatus = {
  name: "xcrun" | "xcodebuild" | "idb" | "idb_companion" | "ffmpeg";
  available: boolean;
  detail: string;
};

export type IosSimulatorStatus = {
  platform: NodeJS.Platform;
  supported: boolean;
  tools: IosSimulatorToolStatus[];
  activeDevice: IosSimulatorDevice | null;
  activeSession: IosSimulatorSession | null;
};

export type IosSimulatorLaunchMode = "snapshot" | "live";

export type IosSimulatorLaunchArgs = {
  deviceUdid?: string | null;
  chatSessionId?: string | null;
  build?: boolean;
  mode?: IosSimulatorLaunchMode;
};

export type IosSimulatorSession = {
  id: string;
  deviceUdid: string;
  deviceName: string | null;
  bundleId: string;
  chatSessionId: string | null;
  mode: IosSimulatorLaunchMode;
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
  fps: number | null;
  frameCount: number;
  startedAt: string | null;
  lastFrameAt: string | null;
  lastError: string | null;
};

export type IosSimulatorStreamBackend = "simctl-screenshot-poll" | "idb-h264-ffmpeg-mjpeg";

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

export type IosSimulatorPoint = {
  deviceUdid?: string | null;
  x: number;
  y: number;
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

export type IosSimulatorInspectPointArgs = {
  deviceUdid?: string | null;
  x: number;
  y: number;
  includeScreenshot?: boolean | null;
};

export type IosSimulatorInspectResult = {
  item: IosElementContextItem | null;
  source: "ade-inspector" | "coordinate-fallback" | "none";
  snapshot: IosInspectorSnapshot | null;
};

export type IosSimulatorSelectResult = {
  item: IosElementContextItem;
  source: "ade-inspector" | "coordinate-fallback";
};

export type IosSimulatorEventPayload =
  | { type: "session-started"; session: IosSimulatorSession }
  | { type: "session-updated"; session: IosSimulatorSession | null }
  | { type: "selection"; item: IosElementContextItem }
  | { type: "stream-started"; status: IosSimulatorStreamStatus }
  | { type: "stream-stopped"; status: IosSimulatorStreamStatus }
  | { type: "stream-frame"; frame: IosSimulatorFrame }
  | { type: "stream-error"; status: IosSimulatorStreamStatus };
