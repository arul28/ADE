import type { ProjectIcon } from "./core";
import type { SyncPairingHostIdentity } from "./sync";

export type RemoteRuntimeTransportKind = "ssh" | "paired";

export type RemoteRuntimePairedMachineReference = {
  /** Stable host device id in the desktop paired-machine credential store. */
  hostIdentity: string;
  /** Optional tunnel-relay machine key for account internet-route lookup. */
  machineKey?: string | null;
};

export type RemoteRuntimeTargetRouteSource =
  | "manual"
  | "bonjour"
  | "tailscale";

export type RemoteRuntimeTargetRoute = {
  hostname: string;
  port: number | null;
  source: RemoteRuntimeTargetRouteSource;
  lastSucceededAt: number | null;
};

export type RemoteRuntimeTarget = {
  id: string;
  name: string;
  hostname: string;
  /** Missing on older records means SSH. */
  transport?: RemoteRuntimeTransportKind;
  pairedMachine?: RemoteRuntimePairedMachineReference | null;
  /** Account that created this local target. Missing/null means user-paired. */
  accountOwnerUserId?: string | null;
  sshUser: string | null;
  port: number | null;
  sshKeyPath: string | null;
  routes?: RemoteRuntimeTargetRoute[];
  lastSeenArch: string | null;
  runtimeBinaryVersion: string | null;
  lastConnectedAt: number | null;
  /** Whether ADE should reconnect this machine automatically on launch. */
  autoConnect?: boolean;
  /** @deprecated Retained while migrating pre-autoConnect records. */
  manuallyDisconnectedAt?: number | null;
};

export type RemoteRuntimeTargetInput = {
  name?: string | null;
  hostname: string;
  transport?: RemoteRuntimeTransportKind | null;
  pairedMachine?: RemoteRuntimePairedMachineReference | null;
  /** Account that created this local target. Omit for user-paired targets. */
  accountOwnerUserId?: string | null;
  sshUser?: string | null;
  port?: number | null;
  sshKeyPath?: string | null;
  routes?: RemoteRuntimeTargetRoute[] | null;
};

export type RemoteRuntimeDiscoveredMachine = {
  id: string;
  serviceName: string;
  machineName: string;
  hostIdentity: string | null;
  hostName: string | null;
  port: number;
  addresses: string[];
  primaryRoute: string | null;
  tailscaleAddress: string | null;
  runtimeKind: string | null;
  runtimeVersion: string | null;
  os?: string;
  connectable: boolean;
  unsupportedReason?: string;
  projectIds: string[];
  projectCount: number | null;
  lastSeenAt: number;
};

export type RemoteRuntimeDiscoveryDiagnostic = {
  source: "bonjour" | "tailscale";
  severity: "warning";
  code: string;
  message: string;
  detail: string | null;
};

export type RemoteRuntimeDiscoveryResult = {
  machines: RemoteRuntimeDiscoveredMachine[];
  diagnostics: RemoteRuntimeDiscoveryDiagnostic[];
};

export type RemoteRuntimeProjectRecord = {
  projectId: string;
  rootPath: string;
  displayName: string;
  addedAt: number;
  lastOpenedAt: number;
  gitOriginUrl: string | null;
  catalogVisibility?: "recent" | "system";
  registrationSource?: "desktop" | "mobile" | "cli-explicit" | "runtime-auto" | "test";
  /**
   * The project's icon as resolved on the host machine, inlined as a base64
   * data URL so a connected desktop can render the real project logo in its
   * tab instead of a blank folder. Null/absent when the host can't resolve an
   * icon (older host, no icon file, or an oversized icon dropped from the wire).
   */
  icon?: ProjectIcon | null;
};

export type RemoteRuntimeConnectResult = {
  target: RemoteRuntimeTarget;
  arch: string;
  version: string | null;
  route?: RemoteRuntimeConnectionRoute;
  capabilities?: RemoteRuntimeCapabilities;
  compatibilityWarnings?: string[];
  projects: RemoteRuntimeProjectRecord[];
};

export type RemoteRuntimePortForwardRequest = {
  remoteHost?: string | null;
  remotePort: number;
  label?: string | null;
};

export type RemoteRuntimePortForward = {
  targetId: string;
  remoteHost: string;
  remotePort: number;
  localHost: string;
  localPort: number;
  localUrl: string;
  label: string | null;
  createdAt: number;
  lastUsedAt: number;
};

export type RemoteRuntimeSshHostKeyIdentity = {
  targetId: string;
  host: string;
  port: number;
  route: RemoteRuntimeTargetRoute;
  keyType: string;
  fingerprintSha256: string;
  knownHostsPath: string | null;
};

export type RemoteRuntimeSshHostKeyTrustStatus =
  | ({
      state: "trusted";
    } & Partial<RemoteRuntimeSshHostKeyIdentity>)
  | ({
      state: "needs_trust";
    } & RemoteRuntimeSshHostKeyIdentity)
  | ({
      state: "changed";
    } & RemoteRuntimeSshHostKeyIdentity);

export type RemoteRuntimeTrustSshHostKeyResult = {
  trusted: boolean;
  identity: RemoteRuntimeSshHostKeyIdentity;
};

export type RemoteRuntimeConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "error";

export type RemoteRuntimeRouteKind = "lan" | "tailnet" | "relay" | "ssh";

export type RemoteRuntimeConnectionAttemptFailure =
  | "unreachable"
  | "timeout"
  | "authentication"
  | "identity"
  | "capability"
  | "protocol"
  | "unknown";

export type RemoteRuntimeConnectionAttempt = {
  kind: RemoteRuntimeRouteKind;
  /** Host and optional port only. Paths, query strings, and credentials are excluded. */
  host: string;
  startedAt: number;
  durationMs: number;
  outcome: "connected" | "failed" | "skipped";
  failure?: RemoteRuntimeConnectionAttemptFailure;
};

export type RemoteRuntimeConnectionRoute = {
  kind: RemoteRuntimeRouteKind;
  endpoint: string;
  latencyMs?: number;
  /** Correlates the bounded route attempts for this connection without exposing secrets. */
  correlationId?: string;
  /** At most eight privacy-safe attempts, ordered exactly as they were tried. */
  attempts?: RemoteRuntimeConnectionAttempt[];
  /** Number of route attempts omitted from the bounded diagnostic list. */
  omittedAttemptCount?: number;
};

export type RemoteRuntimeConnectErrorInfo = {
  kind: "disk_full" | "ssh_auth" | "unsupported_os" | "auth_required" | "generic";
  message: string;
  detail?: string;
  freeBytes?: number;
  requiredBytes?: number;
  correlationId?: string;
  attempts?: RemoteRuntimeConnectionAttempt[];
  omittedAttemptCount?: number;
};

const REMOTE_RUNTIME_ERROR_DETAIL_MAX_CHARS = 4_000;
const REMOTE_RUNTIME_ERROR_DETAIL_HEAD_CHARS = 3_000;
const REMOTE_RUNTIME_ERROR_DETAIL_TAIL_CHARS = 1_000;

export function capRemoteRuntimeErrorDetail(detail: string): string {
  if (detail.length <= REMOTE_RUNTIME_ERROR_DETAIL_MAX_CHARS) return detail;
  let tailChars = REMOTE_RUNTIME_ERROR_DETAIL_TAIL_CHARS;
  let marker = "";
  for (;;) {
    const omitted = detail.length
      - REMOTE_RUNTIME_ERROR_DETAIL_HEAD_CHARS
      - tailChars;
    marker = `\n… [truncated ${omitted} bytes] …\n`;
    const nextTailChars = Math.min(
      REMOTE_RUNTIME_ERROR_DETAIL_TAIL_CHARS,
      REMOTE_RUNTIME_ERROR_DETAIL_MAX_CHARS
        - REMOTE_RUNTIME_ERROR_DETAIL_HEAD_CHARS
        - marker.length,
    );
    if (nextTailChars === tailChars) break;
    tailChars = nextTailChars;
  }
  return `${detail.slice(0, REMOTE_RUNTIME_ERROR_DETAIL_HEAD_CHARS)}${marker}${detail.slice(-tailChars)}`;
}

export class RemoteRuntimeConnectError extends Error {
  readonly info: RemoteRuntimeConnectErrorInfo;

  constructor(info: RemoteRuntimeConnectErrorInfo, cause?: unknown) {
    super(info.message);
    this.name = "RemoteRuntimeConnectError";
    this.info = {
      ...info,
      ...(info.detail
        ? { detail: capRemoteRuntimeErrorDetail(info.detail) }
        : {}),
    };
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: cause,
      });
    }
  }
}

export type RemoteRuntimeConnectionStatus = {
  target: RemoteRuntimeTarget;
  state: RemoteRuntimeConnectionState;
  arch: string | null;
  version: string | null;
  route?: RemoteRuntimeConnectionRoute;
  capabilities?: RemoteRuntimeCapabilities;
  compatibilityWarnings?: string[];
  projects: RemoteRuntimeProjectRecord[];
  lastError: string | null;
  lastErrorInfo?: RemoteRuntimeConnectErrorInfo | null;
  lastAttemptedAt: number | null;
  connectedAt: number | null;
};

export type RemoteRuntimeParsedPairingInput = {
  hostIdentity: SyncPairingHostIdentity;
  machineName?: string;
  endpoints: string[];
  relayUrl?: string;
  runtimeHostGrant?: string;
  requiresPin: true;
};

export type RemoteRuntimePairWithMachineArgs = {
  input: string;
  pin: string;
  deviceName: string;
};

export type RemoteRuntimePairWithMachineResult = {
  targetId: string;
};

export type RemoteRuntimeLocalPairingInfo = {
  url: string;
  pin: string | null;
  machineName: string;
  relayAvailable: boolean;
};

export type RemoteRuntimeDoctorCheck = {
  route: RemoteRuntimeRouteKind;
  endpoint: string;
  ok: boolean;
  latencyMs?: number;
  error?: string;
};

export type RemoteRuntimeDoctorResult = {
  checks: RemoteRuntimeDoctorCheck[];
};

export type RemoteRuntimeMachineProjectCapability =
  | "browseDirectories"
  | "getDetail"
  | "getWorkSummary"
  | "getDefaultParentDir"
  | "handoffStoragePreflight"
  | "create"
  | "clone"
  | "listMyGitHubRepos";

export type RemoteRuntimeCapabilities = {
  projects: boolean;
  machineProjects: Partial<Record<RemoteRuntimeMachineProjectCapability, boolean>>;
};

export type RemoteRuntimeHandoffStoragePreflightArgs = {
  parentDir: string;
  repoName: string;
  originUrl?: string;
  branchRef?: string;
  sourceHeadSha?: string;
};

export type RemoteRuntimeCloneProjectOptions = {
  /** Resolve Git credentials exclusively on the destination machine. */
  credentialMode?: "destination_only" | "source_forwarded";
};

export type RemoteRuntimeHandoffStoragePreflightResult = {
  parentDir: string;
  targetPath: string;
  freeBytes: number;
  requiredBytes: number;
  hasEnoughSpace: boolean;
  targetExists: boolean;
  blockingErrors: string[];
  warnings: string[];
};

export type RemoteRuntimeConnectionSnapshot = {
  connections: RemoteRuntimeConnectionStatus[];
  connectedCount: number;
  updatedAt: number;
};

export type RemoteRuntimeActionRequest = {
  domain: string;
  action: string;
  args?: Record<string, unknown>;
  arg?: unknown;
  argsList?: unknown[];
  /**
   * Local transport guard. This is enforced before the action leaves the
   * source machine and is never forwarded to the destination runtime.
   */
  requiredRouteKind?: RemoteRuntimeRouteKind;
};

export type RemoteRuntimeActionResult = {
  domain: string;
  action: string;
  result: unknown;
  statusHints: Record<string, unknown>;
};

export type RemoteRuntimeEventCategory =
  | "orchestrator"
  | "dag_mutation"
  | "runtime"
  | "pty";

export type RemoteRuntimeBufferedEvent = {
  id: number;
  timestamp: string;
  category: RemoteRuntimeEventCategory;
  payload: Record<string, unknown>;
};

export type RemoteRuntimeStreamEventsRequest = {
  cursor?: number;
  limit?: number;
  category?: RemoteRuntimeEventCategory;
  replay?: boolean;
};

export type RemoteRuntimeStreamEventsResult = {
  events: RemoteRuntimeBufferedEvent[];
  nextCursor: number;
  hasMore: boolean;
  eventEpoch?: string | null;
  gap?: boolean;
  oldestCursor?: number | null;
};

export type RemoteRuntimeEventNotificationPayload = {
  bindingKey: string;
  event: RemoteRuntimeBufferedEvent;
  eventEpoch?: string | null;
};

export type RemoteRuntimeLocalWorkMatch = {
  rootPath: string;
  displayName: string;
  gitOriginUrl: string;
  dirtyCount: number;
  workSummary?: RemoteRuntimeProjectWorkSummary | null;
};

export type RemoteRuntimeProjectWorktreeSummary = {
  rootPath: string;
  name: string;
  branchName: string | null;
  dirtyCount: number;
  isPrimary: boolean;
};

export type RemoteRuntimeProjectWorkSummary = {
  rootPath: string;
  laneCount: number;
  checkedLaneCount: number;
  dirtyLaneCount: number;
  dirtyFileCount: number;
  primaryDirtyCount: number;
  lanes: RemoteRuntimeProjectWorktreeSummary[];
};

export type RemoteRuntimeLocalWorkCheckResult = {
  remoteProjectId: string;
  remoteDisplayName: string;
  remoteGitOriginUrl: string | null;
  remoteWorkSummary?: RemoteRuntimeProjectWorkSummary | null;
  matches: RemoteRuntimeLocalWorkMatch[];
  hasDirtyWork: boolean;
};
