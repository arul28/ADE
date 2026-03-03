// ---------------------------------------------------------------------------
// Model configuration types
// ---------------------------------------------------------------------------

export type ModelProvider = "claude" | "codex";

export type ThinkingLevel = "none" | "minimal" | "low" | "medium" | "high" | "max" | "xhigh";

export type ModelConfig = {
  provider: ModelProvider;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
};

/** The types of AI calls the orchestrator makes internally.
 *  The coordinator handles all decision-making (evaluation, diagnosis,
 *  plan adjustment, intervention) through its own reasoning — no separate call types needed. */
export type OrchestratorCallType =
  | "coordinator"
  | "chat_response";

/** Mission-level timeout cap for orchestrator internal AI decision calls. */
export type OrchestratorDecisionTimeoutCapHours = 6 | 12 | 24 | 48;

/** Per-call-type model configuration for orchestrator intelligence */
export type OrchestratorIntelligenceConfig = {
  [K in OrchestratorCallType]?: ModelConfig;
};

/** Per-provider tier ceiling — users set these based on their plan limits */
export type ProviderBudgetLimits = {
  fiveHourTokenLimit: number;
  weeklyTokenLimit: number;
};

/** Named model profile for quick mission configuration */
export type MissionModelProfile = {
  id: string;
  name: string;
  description: string;
  isBuiltIn: boolean;
  orchestratorModel: ModelConfig;
  decisionTimeoutCapHours?: OrchestratorDecisionTimeoutCapHours;
  phaseDefaults: {
    planning: ModelConfig;
    implementation: ModelConfig;
    testing: ModelConfig;
    validation: ModelConfig;
    codeReview: ModelConfig;
    testReview: ModelConfig;
    prReview?: ModelConfig;
  };
  intelligenceConfig: OrchestratorIntelligenceConfig;
  smartBudget?: import("./budget").SmartBudgetConfig;
};

/** The full mission model configuration stored in launch metadata */
export type MissionModelConfig = {
  profileId?: string;
  orchestratorModel: ModelConfig;
  decisionTimeoutCapHours?: OrchestratorDecisionTimeoutCapHours;
  intelligenceConfig?: OrchestratorIntelligenceConfig;
  smartBudget?: import("./budget").SmartBudgetConfig;
};

export type ModelCapabilityProfile = {
  provider: "claude" | "codex" | (string & {});
  modelId: string;
  displayName: string;
  strengths: string[];
  weaknesses: string[];
  costTier: "low" | "medium" | "high" | "very_high";
  bestFor: import("./config").AiTaskRoutingKey[];
  parallelCapable: boolean;
  reasoningTiers?: string[];
};

export type GetModelCapabilitiesResult = {
  profiles: ModelCapabilityProfile[];
};
