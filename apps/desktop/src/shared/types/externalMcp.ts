export type ExternalMcpTransport = "stdio" | "http" | "sse";

export type ExternalMcpResolvedTransport = "stdio" | "http";

export type ExternalMcpConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "draining"
  | "failed";

export type ExternalMcpToolSafety = "read" | "write" | "unknown";

export type ExternalMcpToolPermissionConfig = {
  allowedTools?: string[];
  blockedTools?: string[];
};

export type ExternalMcpCostHints = {
  defaultCostCents?: number;
  perToolCostCents?: Record<string, number>;
};

export type ExternalConnectionAuthMode = "none" | "api_key" | "bearer" | "oauth";

export type ExternalConnectionAuthPlacement = {
  target: "header" | "env";
  key: string;
  prefix?: string;
};

export type ExternalConnectionOAuthConfig = {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  scope?: string | null;
  audience?: string | null;
  extraAuthorizeParams?: Record<string, string>;
  extraTokenParams?: Record<string, string>;
  clientSecretId?: string | null;
  accessTokenId?: string | null;
  refreshTokenId?: string | null;
  expiresAt?: string | null;
  lastAuthenticatedAt?: string | null;
};

export type ExternalConnectionAuthRecord = {
  id: string;
  displayName: string;
  mode: ExternalConnectionAuthMode;
  secretId?: string | null;
  oauth?: ExternalConnectionOAuthConfig;
  createdAt: string;
  updatedAt: string;
  lastError?: string | null;
};

export type ExternalConnectionAuthRecordInput = {
  id?: string;
  displayName: string;
  mode: ExternalConnectionAuthMode;
  secret?: string | null;
  oauth?: {
    authorizeUrl: string;
    tokenUrl: string;
    clientId: string;
    clientSecret?: string | null;
    scope?: string | null;
    audience?: string | null;
    extraAuthorizeParams?: Record<string, string>;
    extraTokenParams?: Record<string, string>;
  };
};

export type ExternalConnectionAuthState =
  | "ready"
  | "missing"
  | "needs_auth"
  | "expired"
  | "refreshing"
  | "authorizing"
  | "error";

export type ExternalConnectionAuthStatus = {
  authId?: string | null;
  mode: ExternalConnectionAuthMode;
  state: ExternalConnectionAuthState;
  summary: string;
  materializationPreview?: string[];
  lastAuthenticatedAt?: string | null;
  expiresAt?: string | null;
  lastError?: string | null;
  updatedAt?: string | null;
};

export type ExternalConnectionOAuthSessionStartResult = {
  sessionId: string;
  authId: string;
  authUrl: string;
  redirectUri: string;
};

export type ExternalConnectionOAuthSessionResult = {
  authId: string;
  status: "pending" | "completed" | "failed" | "expired";
  error?: string | null;
};

export type ExternalMcpManagedAuthConfig = {
  authId: string;
  mode: ExternalConnectionAuthMode;
  placement: ExternalConnectionAuthPlacement;
};

export type ExternalMcpServerConfig = {
  name: string;
  transport: ExternalMcpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  autoStart?: boolean;
  healthCheckIntervalSec?: number;
  permissions?: ExternalMcpToolPermissionConfig;
  costHints?: ExternalMcpCostHints;
  auth?: ExternalMcpManagedAuthConfig;
};

export type ExternalMcpResolvedServerConfig = Omit<ExternalMcpServerConfig, "transport"> & {
  transport: ExternalMcpResolvedTransport;
};

export type ExternalMcpAccessPolicy = {
  allowAll: boolean;
  allowedServers: string[];
  blockedServers: string[];
};

export type ExternalMcpMissionSelection = {
  enabled?: boolean;
  selectedServers?: string[];
  selectedTools?: string[];
};

export type ExternalMcpToolManifest = {
  serverName: string;
  name: string;
  namespacedName: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  safety: ExternalMcpToolSafety;
  enabled: boolean;
  disabledReason?: string;
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
};

export type ExternalMcpServerSnapshot = {
  config: ExternalMcpResolvedServerConfig;
  state: ExternalMcpConnectionState;
  toolCount: number;
  tools: ExternalMcpToolManifest[];
  lastConnectedAt?: string | null;
  lastHealthCheckAt?: string | null;
  consecutivePingFailures: number;
  lastError?: string | null;
  autoStart: boolean;
  authStatus?: ExternalConnectionAuthStatus;
};

export type ExternalMcpUsageEvent = {
  id: string;
  serverName: string;
  toolName: string;
  namespacedToolName: string;
  safety: ExternalMcpToolSafety;
  callerRole: "cto" | "orchestrator" | "agent" | "external" | "evaluator";
  callerId: string;
  chatSessionId?: string | null;
  missionId?: string | null;
  runId?: string | null;
  stepId?: string | null;
  attemptId?: string | null;
  ownerId?: string | null;
  costCents: number;
  estimated: boolean;
  occurredAt: string;
};

export type ExternalMcpEventPayload = {
  type: "configs-changed" | "server-state-changed" | "tools-refreshed" | "usage-recorded";
  at: string;
  serverName?: string | null;
  state?: ExternalMcpConnectionState | null;
  toolCount?: number;
  usageEvent?: ExternalMcpUsageEvent;
};
