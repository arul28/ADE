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
};

export type ExternalMcpUsageEvent = {
  id: string;
  serverName: string;
  toolName: string;
  namespacedToolName: string;
  safety: ExternalMcpToolSafety;
  callerRole: "cto" | "orchestrator" | "agent" | "external" | "evaluator";
  callerId: string;
  missionId?: string | null;
  runId?: string | null;
  stepId?: string | null;
  attemptId?: string | null;
  ownerId?: string | null;
  costCents: number;
  estimated: boolean;
  occurredAt: string;
};
