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
  sshUser: string | null;
  port: number | null;
  sshKeyPath: string | null;
  routes?: RemoteRuntimeTargetRoute[];
  lastSeenArch: string | null;
  runtimeBinaryVersion: string | null;
  lastConnectedAt: number | null;
  manuallyDisconnectedAt?: number | null;
};

export type RemoteRuntimeTargetInput = {
  name?: string | null;
  hostname: string;
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
};

export type RemoteRuntimeConnectResult = {
  target: RemoteRuntimeTarget;
  arch: string;
  version: string | null;
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

export type RemoteRuntimeConnectionStatus = {
  target: RemoteRuntimeTarget;
  state: RemoteRuntimeConnectionState;
  arch: string | null;
  version: string | null;
  capabilities?: RemoteRuntimeCapabilities;
  compatibilityWarnings?: string[];
  projects: RemoteRuntimeProjectRecord[];
  lastError: string | null;
  lastAttemptedAt: number | null;
  connectedAt: number | null;
};

export type RemoteRuntimeMachineProjectCapability =
  | "browseDirectories"
  | "getDetail"
  | "getWorkSummary"
  | "getDefaultParentDir"
  | "create"
  | "clone"
  | "listMyGitHubRepos";

export type RemoteRuntimeCapabilities = {
  projects: boolean;
  machineProjects: Partial<Record<RemoteRuntimeMachineProjectCapability, boolean>>;
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
};

export type RemoteRuntimeEventNotificationPayload = {
  bindingKey: string;
  event: RemoteRuntimeBufferedEvent;
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
