export type MacosVmProviderKind = "lume" | "apple-virtualization-helper";

export type MacosVmLifecycleState =
  | "not_created"
  | "creating"
  | "installing"
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "paused"
  | "failed"
  | "unknown";

export type MacosVmToolStatus = {
  name: "apple-virtualization" | "lume";
  available: boolean;
  detail: string;
  installHint: string;
  docsUrl: string;
};

export type MacosVmProviderStatus = {
  kind: MacosVmProviderKind;
  available: boolean;
  version: string | null;
  detail: string;
  docsUrl: string;
};

export type MacosVmSharePolicy = {
  hostPath: string;
  guestPath: string;
  readOnly: boolean;
  allowed: boolean;
  blockedReason: string | null;
  syncMode?: "direct" | "sanitized-mirror";
  mirrorPath?: string | null;
  originalHostPath?: string | null;
  excludedPaths?: string[];
  detail?: string | null;
};

export type MacosVmRecord = {
  id: string;
  provider: MacosVmProviderKind;
  name: string;
  laneId: string;
  laneName: string;
  laneRoot: string;
  state: MacosVmLifecycleState;
  cpuCores: number;
  memory: string;
  diskSize: string;
  display: string;
  guestSharedPath: string;
  sharedDirectory: string;
  createdAt: string;
  updatedAt: string;
  lastStartedAt: string | null;
  lastStoppedAt: string | null;
  ipAddress: string | null;
  sshCommand: string | null;
  vncUrl: string | null;
  lastError: string | null;
  metadata: Record<string, unknown>;
};

export type MacosVmStatus = {
  platform: NodeJS.Platform;
  arch: string;
  supported: boolean;
  checkedAt: string;
  activeProvider: MacosVmProviderStatus;
  tools: MacosVmToolStatus[];
  laneVm: MacosVmRecord | null;
  vms: MacosVmRecord[];
  docs: {
    appleVirtualization: string;
    appleSharedDirectories: string;
    lume: string;
  };
};

export type MacosVmStatusArgs = {
  laneId?: string | null;
};

export type MacosVmProvisionMode = "create" | "pull-image";

export type MacosVmProvisionArgs = {
  laneId: string;
  name?: string | null;
  cpuCores?: number | null;
  memory?: string | null;
  diskSize?: string | null;
  display?: string | null;
  mode?: MacosVmProvisionMode | null;
  ipsw?: string | null;
  sourceImage?: string | null;
  unattendedPreset?: string | null;
  force?: boolean | null;
};

export type MacosVmStartArgs = {
  laneId: string;
  openDisplay?: boolean | null;
  createIfMissing?: boolean | null;
  cpuCores?: number | null;
  memory?: string | null;
  diskSize?: string | null;
  display?: string | null;
  mode?: MacosVmProvisionMode | null;
  ipsw?: string | null;
  sourceImage?: string | null;
  unattendedPreset?: string | null;
};

export type MacosVmStopArgs = {
  laneId: string;
  force?: boolean | null;
};

export type MacosVmDeleteArgs = {
  laneId: string;
  force?: boolean | null;
};

export type MacosVmAgentGuideArgs = {
  laneId: string;
};

export type MacosVmWindowFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type MacosVmWindowTarget = {
  laneId: string;
  vmName: string;
  windowTitleQuery: string;
  processName: string;
  windowTitle: string;
  frame: MacosVmWindowFrame | null;
  focusedAt: string;
};

export type MacosVmFocusWindowArgs = {
  laneId: string;
  windowTitleQuery?: string | null;
};

export type MacosVmCaptureScreenshotArgs = {
  laneId: string;
  windowTitleQuery?: string | null;
  outputPath?: string | null;
};

export type MacosVmCaptureScreenshotResult = {
  ok: true;
  laneId: string;
  vmName: string;
  path: string;
  dataUrl?: string | null;
  capturedAt: string;
  captureMode: "direct-vnc" | "window-region" | "full-screen";
  window: MacosVmWindowTarget;
};

export type MacosVmCoordinateSpace = "window" | "screen";

export type MacosVmClickArgs = {
  laneId: string;
  x: number;
  y: number;
  coordinateSpace?: MacosVmCoordinateSpace | null;
  windowTitleQuery?: string | null;
};

export type MacosVmTypeTextArgs = {
  laneId: string;
  text: string;
  windowTitleQuery?: string | null;
};

export type MacosVmSelectPointArgs = {
  laneId: string;
  x: number;
  y: number;
  coordinateSpace?: MacosVmCoordinateSpace | null;
  windowTitleQuery?: string | null;
  includeScreenshot?: boolean | null;
};

export type MacosVmContextItem = {
  kind: "macos_vm_target";
  id: string;
  laneId: string;
  laneName: string;
  vmName: string;
  provider: MacosVmProviderKind;
  state: MacosVmLifecycleState;
  hostLanePath: string;
  guestLanePath: string;
  runCommand: string;
  sshCommand: string | null;
  vncUrl: string | null;
  windowTitleQuery: string;
  screenshotDataUrl?: string | null;
  selectedAt: string;
  metadata: Record<string, unknown>;
};

export type MacosVmAgentGuide = {
  laneId: string;
  vmName: string;
  text: string;
  target: MacosVmContextItem;
};

export type MacosVmSelectPointResult = {
  item: MacosVmContextItem;
  source: "direct-vnc" | "coordinate-fallback";
  screenshot: MacosVmCaptureScreenshotResult | null;
};

export type MacosVmOperation =
  | "status"
  | "provision"
  | "start"
  | "stop"
  | "delete"
  | "agent-guide"
  | "focus-window"
  | "screenshot"
  | "click"
  | "select-point"
  | "type-text";

export type MacosVmEventPayload =
  | { type: "status"; status: MacosVmStatus }
  | { type: "vm-updated"; vm: MacosVmRecord }
  | {
      type: "operation";
      operation: MacosVmOperation;
      state: "started" | "completed" | "failed";
      laneId: string | null;
      vmName: string | null;
      message: string;
      occurredAt: string;
    };
