import type { ModelId } from "./core";
import type { AgentChatPermissionMode } from "./chat";

export type CtoCapabilityMode = "full_mcp" | "fallback";

export type CtoIdentity = {
  name: string;
  version: number;
  persona: string;
  modelPreferences: {
    provider: string;
    model: string;
    modelId?: ModelId;
    reasoningEffort?: string | null;
  };
  memoryPolicy: {
    autoCompact: boolean;
    compactionThreshold: number;
    preCompactionFlush: boolean;
    temporalDecayHalfLifeDays: number;
  };
  updatedAt: string;
};

export type CtoCoreMemory = {
  version: number;
  updatedAt: string;
  projectSummary: string;
  criticalConventions: string[];
  userPreferences: string[];
  activeFocus: string[];
  notes: string[];
};

export type CtoSessionLogEntry = {
  id: string;
  sessionId: string;
  summary: string;
  startedAt: string;
  endedAt: string | null;
  provider: string;
  modelId: string | null;
  capabilityMode: CtoCapabilityMode;
  createdAt: string;
};

export type CtoSubordinateActivityEntry = {
  id: string;
  agentId: string;
  agentName: string;
  activityType: "chat_turn" | "worker_run";
  summary: string;
  sessionId?: string | null;
  taskKey?: string | null;
  issueKey?: string | null;
  createdAt: string;
};

export type CtoSnapshot = {
  identity: CtoIdentity;
  coreMemory: CtoCoreMemory;
  recentSessions: CtoSessionLogEntry[];
  recentSubordinateActivity: CtoSubordinateActivityEntry[];
};

export type CtoGetStateArgs = {
  recentLimit?: number;
};

export type CtoEnsureSessionArgs = {
  laneId?: string | null;
  modelId?: ModelId | null;
  reasoningEffort?: string | null;
  permissionMode?: AgentChatPermissionMode;
};

export type CtoUpdateCoreMemoryArgs = {
  patch: Partial<Omit<CtoCoreMemory, "version" | "updatedAt">>;
};

export type CtoListSessionLogsArgs = {
  limit?: number;
};
