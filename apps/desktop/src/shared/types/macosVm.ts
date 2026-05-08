export type MacosVmProviderKind = "apple-virtualization-helper";

export type MacosVmLifecycleState =
  | "not_created"
  | "creating"
  | "installing"
  | "setup_required"
  | "ready"
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "paused"
  | "failed"
  | "unknown";

export type MacosVmToolStatus = {
  name: "apple-virtualization";
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

export type MacosVmBaseRecord = {
  id: string;
  provider: MacosVmProviderKind;
  name: string;
  state: MacosVmLifecycleState;
  cpuCores: number;
  memory: string;
  diskSize: string;
  display: string;
  guestSharedPath: string;
  createdAt: string;
  updatedAt: string;
  lastStartedAt: string | null;
  lastStoppedAt: string | null;
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
  defaultBase: MacosVmBaseRecord | null;
  bases: MacosVmBaseRecord[];
  docs: {
    appleVirtualization: string;
    appleSharedDirectories: string;
  };
};

export type MacosVmStatusArgs = {
  laneId?: string | null;
};

export type MacosVmProvisionMode = "create";

export type MacosVmProvisionArgs = {
  laneId: string;
  name?: string | null;
  cpuCores?: number | null;
  memory?: string | null;
  diskSize?: string | null;
  display?: string | null;
  mode?: MacosVmProvisionMode | null;
  ipsw?: string | null;
  force?: boolean | null;
  fromBase?: boolean | null;
  baseName?: string | null;
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
  fromBase?: boolean | null;
  baseName?: string | null;
};

export type MacosVmStopArgs = {
  laneId: string;
  force?: boolean | null;
};

export type MacosVmDeleteArgs = {
  laneId: string;
  force?: boolean | null;
};

export type MacosVmBaseCreateArgs = {
  name?: string | null;
  cpuCores?: number | null;
  memory?: string | null;
  diskSize?: string | null;
  display?: string | null;
  ipsw?: string | null;
  force?: boolean | null;
};

export type MacosVmBaseStartArgs = {
  name?: string | null;
  openDisplay?: boolean | null;
};

export type MacosVmBaseStopArgs = {
  name?: string | null;
  force?: boolean | null;
};

export type MacosVmBaseMarkReadyArgs = {
  name?: string | null;
};

export type MacosVmBaseDeleteArgs = {
  name?: string | null;
  force?: boolean | null;
};

export type MacosVmClearIpswCacheResult = {
  cleared: boolean;
  path: string;
  bytesFreed: number;
};

export type MacosVmIpswHostProbe = {
  pendingBuild: string | null;
  pendingProductVersion: string | null;
  currentBuild: string | null;
  model: string | null;
};

export type MacosVmIpswManifestEntry = {
  build: string;
  productVersion: string;
  supportedDeviceModels: string[];
  firmwareUrl: string;
  sizeBytes: number | null;
};

export type MacosVmIpswResolution = {
  url: string;
  build: string;
  productVersion: string;
  sizeBytes: number | null;
  source: "pending-build" | "current-build" | "newest-supported";
  supportedDeviceModels: string[];
  alternatives: MacosVmIpswManifestEntry[];
  host: MacosVmIpswHostProbe;
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
  processId?: number | null;
  windowId?: number | null;
  windowTitle: string;
  frame: MacosVmWindowFrame | null;
  focusedAt: string;
};

export type MacosVmFocusWindowArgs = {
  laneId: string;
  windowTitleQuery?: string | null;
};

export type MacosVmFocusBaseWindowArgs = {
  name?: string | null;
  windowTitleQuery?: string | null;
};

export type MacosVmSaveLaneAsSnapshotArgs = {
  laneId: string;
  name: string;
  description?: string | null;
};

export type MacosVmRenameBaseArgs = {
  from: string;
  to: string;
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
  captureMode: "window-id" | "window-region" | "full-screen";
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
  source: "coordinate-fallback";
  screenshot: MacosVmCaptureScreenshotResult | null;
};

export type MacosVmOperation =
  | "status"
  | "base-create"
  | "base-start"
  | "base-stop"
  | "base-mark-ready"
  | "base-delete"
  | "base-rename"
  | "base-save-from-lane"
  | "ipsw-cache-clear"
  | "provision"
  | "start"
  | "stop"
  | "delete"
  | "agent-guide"
  | "focus-window"
  | "focus-base-window"
  | "screenshot"
  | "click"
  | "select-point"
  | "type-text";

export type MacosVmScreenRecordingStatus =
  | "granted"
  | "denied"
  | "restricted"
  | "not-determined"
  | "unknown";

export type MacosVmScreenRecordingProbeResult = {
  status: MacosVmScreenRecordingStatus;
  detail: string;
};

export type MacosVmHostCapabilitiesRecommendation = {
  cpuCores: number;
  memory: string;
  diskSize: string;
};

export type MacosVmHostCapabilities = {
  model: string;
  cpuCount: number;
  memoryBytes: number;
  freeMemoryBytes: number;
  freeDiskBytes: number;
  totalDiskBytes: number;
  recommended: MacosVmHostCapabilitiesRecommendation;
};

export type MacosVmEventPayload =
  | { type: "status"; status: MacosVmStatus }
  | { type: "vm-updated"; vm: MacosVmRecord }
  | { type: "base-updated"; base: MacosVmBaseRecord }
  | {
      type: "operation";
      operation: MacosVmOperation;
      state: "started" | "progress" | "completed" | "failed";
      laneId: string | null;
      vmName: string | null;
      message: string;
      occurredAt: string;
      stage?: string | null;
      progress?: number | null;
    };
