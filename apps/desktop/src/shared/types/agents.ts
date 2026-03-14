import type { ModelId } from "./core";
import type { AgentChatPermissionMode, AgentChatProvider } from "./chat";
import type { ExternalMcpAccessPolicy } from "./externalMcp";

export type AgentRole =
  | "cto"
  | "engineer"
  | "qa"
  | "designer"
  | "devops"
  | "researcher"
  | "general";

export type AgentStatus = "idle" | "active" | "paused" | "running";

export type AdapterType = "claude-local" | "codex-local" | "openclaw-webhook" | "process";

export type HeartbeatPolicy = {
  enabled: boolean;
  intervalSec: number;
  wakeOnDemand: boolean;
  activeHours?: {
    start: string;
    end: string;
    timezone: string;
  };
};

export type ClaudeLocalAdapterConfig = {
  model?: string;
  modelId?: ModelId;
  cwd?: string;
  cliArgs?: string[];
  instructions?: string;
  timeoutMs?: number;
};

export type CodexLocalAdapterConfig = {
  model?: string;
  modelId?: ModelId;
  cwd?: string;
  cliArgs?: string[];
  reasoningEffort?: string | null;
  timeoutMs?: number;
};

export type OpenclawWebhookAdapterConfig = {
  url: string;
  method?: "POST";
  headers?: Record<string, string>;
  timeoutMs?: number;
  bodyTemplate?: string;
};

export type ProcessAdapterConfig = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  shell?: boolean;
};

export type AgentAdapterConfig =
  | ClaudeLocalAdapterConfig
  | CodexLocalAdapterConfig
  | OpenclawWebhookAdapterConfig
  | ProcessAdapterConfig
  | Record<string, unknown>;

export type AgentRuntimeConfig = {
  heartbeat?: HeartbeatPolicy;
  maxConcurrentRuns?: number;
};

export type AgentLinearIdentity = {
  userIds?: string[];
  displayNames?: string[];
  aliases?: string[];
};

export type AgentIdentity = {
  id: string;
  name: string;
  slug: string;
  role: AgentRole;
  title?: string;
  reportsTo: string | null;
  capabilities: string[];
  status: AgentStatus;
  adapterType: AdapterType;
  adapterConfig: AgentAdapterConfig;
  runtimeConfig: AgentRuntimeConfig;
  linearIdentity?: AgentLinearIdentity;
  externalMcpAccess?: ExternalMcpAccessPolicy;
  personality?: string;
  communicationStyle?: string;
  constraints?: string[];
  systemPromptExtension?: string;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  lastHeartbeatAt?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
};

export type WorkerTemplate = {
  id: string;
  name: string;
  role: AgentRole;
  title: string;
  capabilities: string[];
  description: string;
  adapterType: AdapterType;
  model?: string;
};

export type AgentCoreMemory = {
  version: number;
  updatedAt: string;
  projectSummary: string;
  criticalConventions: string[];
  userPreferences: string[];
  activeFocus: string[];
  notes: string[];
};

export type AgentSessionLogEntry = {
  id: string;
  prevHash?: string | null;
  sessionId: string;
  summary: string;
  startedAt: string;
  endedAt: string | null;
  provider: string;
  modelId: string | null;
  capabilityMode: "full_mcp" | "fallback";
  createdAt: string;
};

export type AgentSnapshot = {
  identity: AgentIdentity;
  coreMemory: AgentCoreMemory;
  recentSessions: AgentSessionLogEntry[];
};

export type AgentConfigRevision = {
  id: string;
  agentId: string;
  before: AgentIdentity;
  after: AgentIdentity;
  changedKeys: string[];
  hadRedactions: boolean;
  actor: string;
  createdAt: string;
};

export type AgentCostEvent = {
  id: string;
  agentId: string;
  runId?: string | null;
  sessionId?: string | null;
  provider: string;
  modelId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costCents: number;
  estimated: boolean;
  source: "api" | "cli" | "manual" | "reconcile";
  occurredAt: string;
  createdAt: string;
};

export type AgentBudgetSummary = {
  agentId: string;
  name: string;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  exactSpentCents: number;
  estimatedSpentCents: number;
  remainingCents: number | null;
  status: AgentStatus;
};

export type AgentBudgetSnapshot = {
  computedAt: string;
  monthKey: string;
  companyBudgetMonthlyCents: number;
  companySpentMonthlyCents: number;
  companyExactSpentCents: number;
  companyEstimatedSpentCents: number;
  companyRemainingCents: number | null;
  workers: AgentBudgetSummary[];
};

export type AgentTaskSession = {
  id: string;
  agentId: string;
  adapterType: AdapterType;
  taskKey: string;
  payload: Record<string, unknown>;
  clearedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkerRuntimeSurface =
  | "claude_sdk"
  | "codex_app_server"
  | "unified_chat"
  | "process"
  | "openclaw_webhook";

export type WorkerContinuationHandle = {
  surface: WorkerRuntimeSurface;
  provider?: AgentChatProvider | null;
  model?: string | null;
  modelId?: ModelId | string | null;
  sessionId?: string | null;
  threadId?: string | null;
  sdkSessionId?: string | null;
  reasoningEffort?: string | null;
};

export type WorkerTaskSessionScope = {
  runId?: string | null;
  laneId?: string | null;
  issueId?: string | null;
  issueIdentifier?: string | null;
};

export type WorkerTaskSessionWakeState = {
  lastRunId?: string | null;
  lastWakeReason?: WorkerAgentWakeupReason | null;
  lastIssueKey?: string | null;
  lastWakeAt?: string | null;
};

export type WorkerTaskSessionPayload = {
  source?: string;
  workflowId?: string;
  workflowName?: string;
  issueId?: string;
  issueIdentifier?: string;
  issueTitle?: string;
  issueUrl?: string;
  laneId?: string;
  runId?: string;
  continuity?: {
    scope?: WorkerTaskSessionScope;
    providerSurface?: WorkerRuntimeSurface | null;
    handle?: WorkerContinuationHandle | null;
  };
  wake?: WorkerTaskSessionWakeState;
  [key: string]: unknown;
};

export type WorkerAgentWakeupReason =
  | "timer"
  | "manual"
  | "user_message"
  | "assignment"
  | "api"
  | "deferred_promotion"
  | "startup_recovery";

export type WorkerAgentRunStatus =
  | "queued"
  | "deferred"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "skipped";

export type WorkerAgentRun = {
  id: string;
  agentId: string;
  status: WorkerAgentRunStatus;
  wakeupReason: WorkerAgentWakeupReason;
  taskKey?: string | null;
  issueKey?: string | null;
  executionRunId?: string | null;
  executionLockedAt?: string | null;
  context: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  errorMessage?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentUpsertInput = {
  id?: string;
  name: string;
  role: AgentRole;
  title?: string;
  reportsTo?: string | null;
  capabilities?: string[];
  status?: AgentStatus;
  adapterType: AdapterType;
  adapterConfig?: Record<string, unknown>;
  runtimeConfig?: AgentRuntimeConfig;
  linearIdentity?: AgentLinearIdentity;
  externalMcpAccess?: ExternalMcpAccessPolicy;
  budgetMonthlyCents?: number;
};

export type CtoListAgentsArgs = {
  includeDeleted?: boolean;
};

export type CtoSaveAgentArgs = {
  agent: AgentUpsertInput;
  actor?: string;
};

export type CtoRemoveAgentArgs = {
  agentId: string;
  actor?: string;
};

export type CtoSetAgentStatusArgs = {
  agentId: string;
  status: AgentStatus;
};

export type CtoListAgentRevisionsArgs = {
  agentId: string;
  limit?: number;
};

export type CtoRollbackAgentRevisionArgs = {
  agentId: string;
  revisionId: string;
  actor?: string;
};

export type CtoEnsureAgentSessionArgs = {
  agentId: string;
  laneId?: string | null;
  modelId?: ModelId | null;
  reasoningEffort?: string | null;
  permissionMode?: AgentChatPermissionMode;
  taskKey?: string | null;
};

export type CtoListAgentTaskSessionsArgs = {
  agentId: string;
  limit?: number;
};

export type CtoClearAgentTaskSessionArgs = {
  agentId: string;
  adapterType?: AdapterType;
  taskKey?: string;
};

export type CtoGetBudgetSnapshotArgs = {
  monthKey?: string;
};

export type CtoTriggerAgentWakeupArgs = {
  agentId: string;
  reason?: WorkerAgentWakeupReason;
  taskKey?: string | null;
  issueKey?: string | null;
  prompt?: string | null;
  context?: Record<string, unknown>;
};

export type CtoTriggerAgentWakeupResult = {
  runId: string;
  status: WorkerAgentRunStatus;
};

export type CtoListAgentRunsArgs = {
  agentId?: string;
  limit?: number;
  statuses?: WorkerAgentRunStatus[];
};

export type CtoGetAgentCoreMemoryArgs = {
  agentId: string;
};

export type CtoUpdateAgentCoreMemoryArgs = {
  agentId: string;
  patch: Partial<Omit<AgentCoreMemory, "version" | "updatedAt">>;
};

export type CtoListAgentSessionLogsArgs = {
  agentId: string;
  limit?: number;
};
