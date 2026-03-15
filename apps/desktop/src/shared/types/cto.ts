import type { ModelId } from "./core";
import type { AgentChatPermissionMode } from "./chat";
import type { ExternalMcpAccessPolicy } from "./externalMcp";
import type {
  OpenclawBridgeConfig,
  OpenclawBridgeState,
  OpenclawBridgeStatus,
  OpenclawContextPolicy,
  OpenclawMessageRecord,
  OpenclawOutboundEnvelope,
} from "./openclaw";

export type CtoCapabilityMode = "full_mcp" | "fallback";

export type CtoPersonalityPreset = "strategic" | "professional" | "hands_on" | "casual" | "minimal" | "custom";

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
  externalMcpAccess?: ExternalMcpAccessPolicy;
  openclawContextPolicy?: OpenclawContextPolicy;
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
  prevHash?: string | null;
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

export type CtoUpdateIdentityArgs = {
  patch: Partial<Omit<CtoIdentity, "version" | "updatedAt">>;
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

export type CtoStartLinearOAuthArgs = Record<string, never>;

export type CtoSetLinearOAuthClientArgs = {
  clientId: string;
  clientSecret?: string | null;
};

export type CtoClearLinearOAuthClientArgs = Record<string, never>;

export type CtoStartLinearOAuthResult = {
  sessionId: string;
  authUrl: string;
  redirectUri: string;
};

export type CtoLinearOAuthSessionState = "pending" | "completed" | "failed" | "expired";

export type CtoGetLinearOAuthSessionArgs = {
  sessionId: string;
};

export type CtoGetLinearOAuthSessionResult = {
  status: CtoLinearOAuthSessionState;
  connection?: import("./linearSync").LinearConnectionStatus;
  error?: string | null;
};

export type CtoRunProjectScanArgs = Record<string, never>;

export type CtoRunProjectScanResult = {
  detection: import("./core").OnboardingDetectionResult | null;
  coreMemoryPatch: Partial<Omit<CtoCoreMemory, "version" | "updatedAt">>;
  createdMemoryIds: string[];
};

export type CtoGetOpenclawStateArgs = Record<string, never>;

export type CtoUpdateOpenclawConfigArgs = {
  patch: Partial<OpenclawBridgeConfig>;
};

export type CtoTestOpenclawConnectionArgs = {
  reconnect?: boolean;
};

export type CtoListOpenclawMessagesArgs = {
  limit?: number;
};

export type CtoSendOpenclawMessageArgs = OpenclawOutboundEnvelope;

export type CtoGetOpenclawStateResult = OpenclawBridgeState;
export type CtoTestOpenclawConnectionResult = OpenclawBridgeStatus;
export type CtoListOpenclawMessagesResult = OpenclawMessageRecord[];
