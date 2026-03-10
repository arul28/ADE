import type { ModelId } from "./core";
import type { AgentChatPermissionMode } from "./chat";

export type CtoCapabilityMode = "full_mcp" | "fallback";

export type CtoPersonalityPreset = "professional" | "casual" | "minimal" | "custom";

export type CtoCommunicationStyle = {
  verbosity: "concise" | "detailed" | "adaptive";
  proactivity: "reactive" | "balanced" | "proactive";
  escalationThreshold: "low" | "medium" | "high";
};

export type CtoIdentity = {
  name: string;
  version: number;
  persona: string;
  personality?: CtoPersonalityPreset;
  customPersonality?: string;
  communicationStyle?: CtoCommunicationStyle;
  constraints?: string[];
  systemPromptExtension?: string;
  onboardingState?: CtoOnboardingState;
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

/* ── Onboarding ── */

export type CtoOnboardingState = {
  completedSteps: string[];
  dismissedAt?: string;
  completedAt?: string;
};

export type CtoSystemPromptPreview = {
  prompt: string;
  tokenEstimate: number;
};

export type CtoGetOnboardingStateResult = CtoOnboardingState;

export type CtoCompleteOnboardingStepArgs = {
  stepId: string;
};

export type CtoDismissOnboardingArgs = Record<string, never>;

export type CtoResetOnboardingArgs = Record<string, never>;

export type CtoPreviewSystemPromptArgs = {
  identityOverride?: Partial<CtoIdentity>;
};

export type CtoGetLinearProjectsArgs = Record<string, never>;

export type CtoLinearProject = {
  id: string;
  name: string;
  slug: string;
  teamName: string;
};
