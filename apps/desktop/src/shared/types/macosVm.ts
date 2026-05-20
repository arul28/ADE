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

export type MacosVmLaneAttachmentState = "attached" | "missing";

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
  laneState?: MacosVmLaneAttachmentState;
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
  guestReadiness?: MacosVmGuestReadiness;
  /**
   * Numeric phase 1..10 of the singleton-VM onboarding model. When omitted
   * (older records), renderers should fall back to deriving from
   * lifecycle + guestReadiness state.
   */
  currentPhase?: MacosVmPhaseNumber;
  /**
   * Live + stale share entries. The singleton model attaches one VM lane at
   * a time, so at most one entry is `state: "live"` at any moment.
   */
  shareEntries?: MacosVmShareEntry[];
  runtimeInstall?: MacosVmRuntimeInstallStatus;
  downloadProgress?: MacosVmDownloadProgress | null;
  metadata: Record<string, unknown>;
};

export type MacosVmGuestReadinessState =
  | "not_created"
  | "provisioning"
  | "not_running"
  | "booting"
  | "setup_required"
  | "desktop_unverified"
  | "code_ready"
  | "runtime_installing"
  | "runtime_ready"
  | "blocked"
  | "unknown";

export type MacosVmGuestReadiness = {
  state: MacosVmGuestReadinessState;
  canControlGui: boolean;
  canRunCode: boolean;
  sshAvailable: boolean | null;
  setupAssistantLikely: boolean;
  detail: string;
  nextAction: string;
};

/**
 * The 10-phase onboarding model surfaced in the VM tab stepper.
 * Phases 1..10 monotonically advance; the active phase is the lowest-numbered
 * one that has not yet completed.
 */
export type MacosVmPhaseNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export type MacosVmPhase = {
  number: MacosVmPhaseNumber;
  key:
    | "lane_attached"
    | "download_image"
    | "create_vm"
    | "install_macos"
    | "boot"
    | "first_boot_setup"
    | "remote_login"
    | "save_credentials"
    | "install_runtime"
    | "ready";
  label: string;
};

export type MacosVmDownloadProgress = {
  source: "ipsw" | "ade-runtime";
  downloadedBytes: number;
  totalBytes: number | null;
  etaSeconds: number | null;
  startedAt: string;
  updatedAt: string;
  resumable: boolean;
};

export type MacosVmRuntimeInstallState =
  | "not_installed"
  | "installing"
  | "installed"
  | "failed";

export type MacosVmRuntimeInstallStatus = {
  state: MacosVmRuntimeInstallState;
  detail: string;
  startedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
};

export type MacosVmShareEntry = {
  laneId: string;
  hostPath: string;
  guestPath: string;
  /**
   * `live` shares are mounted in the running VM. `stale` shares are scheduled
   * for cleanup on the next restart/wipe — e.g. left behind by a detach.
   */
  state: "live" | "stale";
  attachedAt: string;
};

export type MacosVmCredentials = {
  vmName: string;
  username: string;
  password: string;
};

export type MacosVmStorageVolume = {
  /** Path checked (resolved to the volume that hosts it). */
  path: string;
  availableBytes: number;
  totalBytes: number;
  /**
   * Stable filesystem device ID from `fs.stat(path).dev`. Two volumes with
   * the same `volumeId` share the same underlying disk, so the preflight
   * collapses them to a single row.
   */
  volumeId: number;
};

export type MacosVmStorageInfo = {
  /** Volume where the IPSW restore image (~16 GB) will be downloaded. */
  ipswCache: MacosVmStorageVolume;
  /** Volume where the Lume VM disk (up to 80 GB sparse) will live. */
  vmDisk: MacosVmStorageVolume;
  /** Approx size of the IPSW restore image — used in the preflight prompt. */
  estimatedIpswBytes: number;
  /** Approx peak size after macOS is installed (IPSW + VM disk usage). */
  estimatedFullSetupBytes: number;
  /** Recommended minimum free bytes on the relevant volume before starting. */
  recommendedFreeBytes: number;
  /**
   * Bytes already on disk for the IPSW (final `.ipsw` or partial `.part`).
   * Renderers subtract this from the "now" estimate so the warning is not
   * falsely raised when a resumable download already covers the cost.
   */
  existingIpswBytes: number;
};

export type MacosVmStoredCredentialsSummary = {
  vmName: string;
  username: string | null;
  hasPassword: boolean;
  savedAt: string | null;
};

export type MacosVmGlobalLease = {
  projectRoot: string;
  laneId: string;
  laneName: string;
  vmId: string;
  vmName: string;
  updatedAt: string;
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
  globalLease: MacosVmGlobalLease | null;
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
  laneId?: string | null;
  vmName?: string | null;
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

export type MacosVmDisplaySessionArgs = {
  laneId: string;
};

export type MacosVmDisplaySession = {
  ok: true;
  laneId: string;
  vmName: string;
  websocketUrl: string;
  password: string;
  width: number;
  height: number;
  expiresAt: string;
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
  imageState?: "visible" | "blank" | "unknown";
  imageDetail?: string | null;
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

export type MacosVmRestartArgs = {
  vmName?: string | null;
  laneId?: string | null;
  force?: boolean | null;
};

export type MacosVmWipeArgs = {
  vmName?: string | null;
  laneId?: string | null;
  /**
   * Must be `true`; the renderer is responsible for the user-facing confirm.
   * Typed as the literal `true` so accidentally passing `false` at a call
   * site is a compile-time error instead of silently routing to the service
   * (which still enforces the same check at runtime).
   */
  confirm: true;
};

export type MacosVmWipeResult = {
  wiped: boolean;
  previousVm: MacosVmRecord | null;
  /**
   * Paths the main process could not remove — most commonly a root-owned
   * `.Trashes/` macOS auto-creates inside any directory that was mounted as
   * a shared volume in the VM. The renderer surfaces a copyable
   * `sudo rm -rf <paths>` so the user can finish cleanup themselves.
   */
  unreachablePaths: string[];
};

export type MacosVmInstallRuntimeArgs = {
  vmName?: string | null;
  laneId?: string | null;
};

export type MacosVmSetCredentialsArgs = {
  vmName: string;
  username: string;
  /** Plaintext only on the IPC boundary; main persists via Keychain. */
  password: string;
};

export type MacosVmGetCredentialsArgs = {
  vmName: string;
};

export type MacosVmDetachLaneArgs = {
  laneId: string;
};

export type MacosVmDetachLaneResult = {
  laneId: string;
  previousPlacement: "macos-vm" | "local";
  newPlacement: "local";
  mirrorRemoved: boolean;
  shareMarkedStale: boolean;
  /**
   * True when the call was a no-op because the lane was already local.
   * Renderers should suppress the "Lane detached from Mac VM" toast in this
   * case so the user isn't told a transition happened when nothing changed.
   */
  noOp: boolean;
};

export type MacosVmOperation =
  | "status"
  | "provision"
  | "start"
  | "stop"
  | "restart"
  | "delete"
  | "wipe"
  | "install-runtime"
  | "set-credentials"
  | "detach-lane"
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
    }
  | {
      type: "download-progress";
      vmName: string | null;
      progress: MacosVmDownloadProgress;
    }
  | {
      type: "phase-changed";
      vmName: string | null;
      phase: MacosVmPhase;
      previousPhaseNumber: MacosVmPhaseNumber | null;
    }
  | {
      type: "runtime-install";
      vmName: string;
      status: MacosVmRuntimeInstallStatus;
    }
  | {
      type: "resume-available";
      vmName: string | null;
      source: "ipsw" | "ade-runtime";
      bytesAvailable: number;
    };

/**
 * Canonical phase descriptors for the 10-phase onboarding stepper.
 * Imported by both renderer (PhaseStepper) and main (phase computation).
 */
export const MACOS_VM_PHASES: readonly MacosVmPhase[] = [
  { number: 1, key: "lane_attached", label: "Lane attached" },
  { number: 2, key: "download_image", label: "Download restore image" },
  { number: 3, key: "create_vm", label: "Create VM" },
  { number: 4, key: "install_macos", label: "Install macOS" },
  { number: 5, key: "boot", label: "Boot" },
  { number: 6, key: "first_boot_setup", label: "First-boot setup" },
  { number: 7, key: "remote_login", label: "Enable Remote Login" },
  { number: 8, key: "save_credentials", label: "Save credentials" },
  { number: 9, key: "install_runtime", label: "Install agent runtime" },
  { number: 10, key: "ready", label: "Ready for VM lanes" },
] as const;
