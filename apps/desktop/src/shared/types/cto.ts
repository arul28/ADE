import type { ModelId, OnboardingDetectionResult } from "./core";
import type {
  LinearCatalogState,
  LinearCatalogUser,
  LinearConnectionStatus,
  NormalizedLinearIssue,
} from "./linearSync";

export type CtoCapabilityMode = "full_tooling" | "fallback";

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
  onboardingState?: CtoOnboardingState;
  modelPreferences: {
    provider: string;
    model: string;
    modelId?: ModelId;
    reasoningEffort?: string | null;
  };
  updatedAt: string;
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
  recentSessions: CtoSessionLogEntry[];
  recentSubordinateActivity: CtoSubordinateActivityEntry[];
};

export type CtoGetStateArgs = {
  recentLimit?: number;
};

export type CtoEnsureSessionArgs = {
  modelId?: ModelId | null;
  reasoningEffort?: string | null;
};

export type CtoUpdateIdentityArgs = {
  patch: Partial<Omit<CtoIdentity, "version" | "updatedAt">>;
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

export type CtoSystemPromptPreviewSection = {
  id: "doctrine" | "personality" | "continuity" | "knowledge" | "capabilities";
  title: string;
  content: string;
};

export type CtoSystemPromptPreview = {
  prompt: string;
  tokenEstimate: number;
  sections: CtoSystemPromptPreviewSection[];
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
  teamKey?: string | null;
  icon?: string | null;
  color?: string | null;
};

export type CtoSearchLinearIssuesArgs = {
  projectId?: string | null;
  projectSlug?: string | null;
  teamKey?: string | null;
  stateTypes?: string[];
  assigneeId?: string | null;
  priority?: number | null;
  query?: string | null;
  first?: number;
  after?: string | null;
  includeArchived?: boolean;
};

export type CtoSearchLinearIssuesResult = {
  issues: NormalizedLinearIssue[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
};

export type CtoGetLinearIssuePickerDataResult = {
  projects: CtoLinearProject[];
  users: LinearCatalogUser[];
  states: LinearCatalogState[];
};

export type CtoLinearQuickViewProject = CtoLinearProject & {
  url: string | null;
  color: string | null;
  icon: string | null;
  description: string | null;
  statusName: string | null;
  statusType: string | null;
  health: string | null;
  progress: number | null;
  scope: number | null;
  priority: number | null;
  priorityLabel: string | null;
  issueCount: number | null;
  completedIssueCount: number | null;
  startDate: string | null;
  targetDate: string | null;
  leadName: string | null;
  teamKeys: string[];
};

export type CtoLinearQuickViewTeam = {
  id: string;
  key: string;
  name: string;
  displayName: string;
  color: string | null;
  issueCount: number | null;
  cyclesEnabled: boolean | null;
  private: boolean | null;
};

export type CtoLinearQuickView = {
  connection: LinearConnectionStatus;
  organization: {
    id: string;
    name: string;
    urlKey: string | null;
    logoUrl: string | null;
    gitBranchFormat: string | null;
    createdIssueCount: number | null;
    roadmapEnabled: boolean | null;
    customersEnabled: boolean | null;
    releasesEnabled: boolean | null;
  } | null;
  viewer: {
    id: string;
    name: string;
    displayName: string;
    email: string | null;
    avatarUrl: string | null;
    admin: boolean | null;
    guest: boolean | null;
    url: string | null;
  } | null;
  projects: CtoLinearQuickViewProject[];
  teams: CtoLinearQuickViewTeam[];
  assignedIssues: NormalizedLinearIssue[];
  recentIssues: NormalizedLinearIssue[];
  fetchedAt: string;
  sdk: {
    packageName: "@linear/sdk";
    surfaces: string[];
  };
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
  connection?: LinearConnectionStatus;
  error?: string | null;
};

export type CtoRunProjectScanArgs = Record<string, never>;

export type CtoRunProjectScanResult = {
  detection: OnboardingDetectionResult | null;
};
