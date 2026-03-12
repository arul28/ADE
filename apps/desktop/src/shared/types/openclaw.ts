export type OpenclawTargetHint = "cto" | `agent:${string}`;

export type OpenclawNotificationType = "mission_complete" | "ci_broken" | "blocked_run";

export type OpenclawContextPolicy = {
  shareMode: "full" | "filtered";
  blockedCategories: string[];
};

export type OpenclawNotificationRoute = {
  notificationType: OpenclawNotificationType;
  agentId?: string | null;
  sessionKey?: string | null;
  enabled?: boolean;
};

export type OpenclawBridgeConfig = {
  enabled: boolean;
  bridgePort: number;
  gatewayUrl?: string | null;
  gatewayToken?: string | null;
  deviceToken?: string | null;
  hooksToken?: string | null;
  allowedAgentIds: string[];
  defaultTarget: OpenclawTargetHint;
  allowEmployeeTargets: boolean;
  notificationRoutes: OpenclawNotificationRoute[];
};

export type OpenclawBridgeStatus = {
  state: "disabled" | "disconnected" | "connecting" | "connected" | "reconnecting" | "error";
  enabled: boolean;
  fallbackMode: boolean;
  httpListening: boolean;
  bridgePort: number;
  gatewayUrl?: string | null;
  deviceId?: string | null;
  paired: boolean;
  deviceTokenStored: boolean;
  lastConnectedAt?: string | null;
  lastEventAt?: string | null;
  lastMessageAt?: string | null;
  lastError?: string | null;
  queuedMessages: number;
};

export type OpenclawInboundEnvelope = {
  requestId?: string;
  idempotencyKey?: string;
  agentId?: string | null;
  sessionKey?: string | null;
  channel?: string | null;
  replyChannel?: string | null;
  accountId?: string | null;
  replyAccountId?: string | null;
  threadId?: string | null;
  message: string;
  targetHint?: OpenclawTargetHint | null;
  context?: Record<string, unknown> | null;
  timeoutMs?: number | null;
};

export type OpenclawOutboundEnvelope = {
  requestId?: string;
  sessionKey?: string | null;
  agentId?: string | null;
  channel?: string | null;
  replyChannel?: string | null;
  accountId?: string | null;
  replyAccountId?: string | null;
  threadId?: string | null;
  message: string;
  context?: Record<string, unknown> | null;
  notificationType?: OpenclawNotificationType | null;
  label?: string | null;
  timeoutMs?: number | null;
  deliver?: boolean;
  bestEffort?: boolean;
};

export type OpenclawMessageRecord = {
  id: string;
  requestId: string;
  direction: "inbound" | "outbound";
  mode: "hook" | "query" | "reply" | "notification" | "manual";
  status: "received" | "queued" | "sent" | "failed" | "duplicate";
  agentId?: string | null;
  sessionKey?: string | null;
  targetHint?: OpenclawTargetHint | null;
  resolvedTarget?: OpenclawTargetHint | null;
  body: string;
  summary: string;
  context?: Record<string, unknown> | null;
  createdAt: string;
  error?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type OpenclawBridgeState = {
  config: OpenclawBridgeConfig;
  status: OpenclawBridgeStatus;
  endpoints: {
    healthUrl: string | null;
    hookUrl: string | null;
    queryUrl: string | null;
  };
};
