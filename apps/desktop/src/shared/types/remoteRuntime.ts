export type RemoteRuntimeTarget = {
  id: string;
  name: string;
  hostname: string;
  sshUser: string | null;
  port: number | null;
  sshKeyPath: string | null;
  lastSeenArch: string | null;
  runtimeBinaryVersion: string | null;
  lastConnectedAt: number | null;
};

export type RemoteRuntimeTargetInput = {
  name?: string | null;
  hostname: string;
  sshUser?: string | null;
  port?: number | null;
  sshKeyPath?: string | null;
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
  projects: RemoteRuntimeProjectRecord[];
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
  projects: RemoteRuntimeProjectRecord[];
  lastError: string | null;
  lastAttemptedAt: number | null;
  connectedAt: number | null;
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
  | "mission";

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
};

export type RemoteRuntimeStreamEventsResult = {
  events: RemoteRuntimeBufferedEvent[];
  nextCursor: number;
  hasMore: boolean;
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
};

export type RemoteRuntimeLocalWorkCheckResult = {
  remoteProjectId: string;
  remoteDisplayName: string;
  remoteGitOriginUrl: string | null;
  matches: RemoteRuntimeLocalWorkMatch[];
  hasDirtyWork: boolean;
};
