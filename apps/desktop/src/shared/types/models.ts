// ---------------------------------------------------------------------------
// Model configuration types
// ---------------------------------------------------------------------------

export type ModelProvider = "claude" | "codex" | "cursor" | "droid" | "opencode" | (string & {});

export type ThinkingLevel = "none" | "minimal" | "low" | "medium" | "high" | "max" | "xhigh" | "ultracode";

export type ModelConfig = {
  /** Optional provider hint; routing is resolved from modelId via model registry. */
  provider?: ModelProvider;
  /** Canonical registry model id (for example: anthropic/claude-sonnet-4-6, openai/gpt-5.3-codex). */
  modelId: string;
  thinkingLevel?: ThinkingLevel;
};

/** Per-provider tier ceiling — users set these based on their plan limits */
export type ProviderBudgetLimits = {
  fiveHourTokenLimit: number;
  weeklyTokenLimit: number;
};

export type ModelCapabilityProfile = {
  provider: ModelProvider;
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
