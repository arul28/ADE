import type {
  ModelConfig,
  ModelProvider,
  MissionModelProfile,
  OrchestratorCallType,
  OrchestratorIntelligenceConfig,
  SmartBudgetConfig,
  ThinkingLevel
} from "./types";

// ─────────────────────────────────────────────────────
// Known model catalogs
// ─────────────────────────────────────────────────────

export type ModelEntry = {
  provider: ModelProvider;
  modelId: string;
  displayName: string;
  costTier: "low" | "medium" | "high" | "very_high";
  recommended?: boolean;
};

export const CLAUDE_MODELS: ModelEntry[] = [
  { provider: "claude", modelId: "claude-opus-4-6", displayName: "Claude Opus 4.6", costTier: "very_high" },
  { provider: "claude", modelId: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", costTier: "medium", recommended: true },
  { provider: "claude", modelId: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5", costTier: "low" },
];

export const CODEX_MODELS: ModelEntry[] = [
  { provider: "codex", modelId: "gpt-5.3-codex", displayName: "GPT 5.3 Codex", costTier: "high", recommended: true },
  { provider: "codex", modelId: "gpt-5.3-codex-spark", displayName: "GPT 5.3 Codex Spark", costTier: "medium" },
  { provider: "codex", modelId: "gpt-5.2-codex", displayName: "GPT 5.2 Codex", costTier: "medium" },
  { provider: "codex", modelId: "gpt-5.1-codex-max", displayName: "GPT 5.1 Codex Max", costTier: "high" },
  { provider: "codex", modelId: "codex-mini-latest", displayName: "Codex Mini", costTier: "low" },
  { provider: "codex", modelId: "o4-mini", displayName: "O4 Mini", costTier: "low" },
  { provider: "codex", modelId: "o3", displayName: "O3", costTier: "medium" },
];

export const ALL_MODELS: ModelEntry[] = [...CLAUDE_MODELS, ...CODEX_MODELS];

export function findModel(modelId: string): ModelEntry | undefined {
  return ALL_MODELS.find((m) => m.modelId === modelId);
}

export function getModelsForProvider(provider: ModelProvider): ModelEntry[] {
  return provider === "claude" ? CLAUDE_MODELS : CODEX_MODELS;
}

// ─────────────────────────────────────────────────────
// Thinking levels per provider
// ─────────────────────────────────────────────────────

export type ThinkingOption = { value: ThinkingLevel; label: string };

export const CLAUDE_THINKING_LEVELS: ThinkingOption[] = [
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

export const CODEX_THINKING_LEVELS: ThinkingOption[] = [
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

export function getThinkingLevels(provider: ModelProvider): ThinkingOption[] {
  return provider === "claude" ? CLAUDE_THINKING_LEVELS : CODEX_THINKING_LEVELS;
}

// ─────────────────────────────────────────────────────
// Orchestrator call type metadata (for UI)
// ─────────────────────────────────────────────────────

export type CallTypeInfo = {
  key: OrchestratorCallType;
  label: string;
  description: string;
  defaultProvider: ModelProvider;
  recommended: string;
};

export const ORCHESTRATOR_CALL_TYPES: CallTypeInfo[] = [
  {
    key: "coordinator",
    label: "Coordinator",
    description: "Persistent session that observes the full mission run and can intervene with steer/skip/broadcast commands.",
    defaultProvider: "claude",
    recommended: "claude-sonnet-4-6"
  },
  {
    key: "worker_evaluation",
    label: "Worker Evaluation",
    description: "Evaluates worker-proposed plans before execution. Judges whether the agent's approach is sound.",
    defaultProvider: "claude",
    recommended: "claude-haiku-4-5-20251001"
  },
  {
    key: "quality_gate",
    label: "Quality Gate",
    description: "Evaluates step outputs against quality criteria (code review, test review, validation).",
    defaultProvider: "claude",
    recommended: "claude-sonnet-4-6"
  },
  {
    key: "failure_diagnosis",
    label: "Failure Diagnosis",
    description: "Analyzes why a step failed and classifies the error for recovery routing.",
    defaultProvider: "claude",
    recommended: "claude-haiku-4-5-20251001"
  },
  {
    key: "plan_adjustment",
    label: "Plan Adjustment",
    description: "Suggests modifications to the mission plan based on runtime events (add/skip/reorder steps).",
    defaultProvider: "claude",
    recommended: "claude-sonnet-4-6"
  },
  {
    key: "intervention_handling",
    label: "Intervention Handling",
    description: "Evaluates whether an intervention can be auto-resolved or needs human input.",
    defaultProvider: "claude",
    recommended: "claude-sonnet-4-6"
  },
  {
    key: "chat_response",
    label: "Chat Response",
    description: "Responds to user messages in the mission thread. Conversational and context-aware.",
    defaultProvider: "claude",
    recommended: "claude-sonnet-4-6"
  }
];

// ─────────────────────────────────────────────────────
// Built-in model profiles
// ─────────────────────────────────────────────────────

const CLAUDE_SONNET: ModelConfig = { provider: "claude", modelId: "claude-sonnet-4-6", thinkingLevel: "medium" };
const CLAUDE_HAIKU: ModelConfig = { provider: "claude", modelId: "claude-haiku-4-5-20251001", thinkingLevel: "low" };
const CLAUDE_OPUS: ModelConfig = { provider: "claude", modelId: "claude-opus-4-6", thinkingLevel: "high" };
const CODEX_53: ModelConfig = { provider: "codex", modelId: "gpt-5.3-codex", thinkingLevel: "medium" };
const CODEX_MINI: ModelConfig = { provider: "codex", modelId: "codex-mini-latest", thinkingLevel: "low" };

export const BUILT_IN_PROFILES: MissionModelProfile[] = [
  {
    id: "standard",
    name: "Standard",
    description: "Balanced setup: Codex for implementation/review/verification, Claude for orchestration and planning.",
    isBuiltIn: true,
    orchestratorModel: CLAUDE_SONNET,
    phaseDefaults: {
      planning: CLAUDE_SONNET,
      implementation: CODEX_53,
      testing: CODEX_53,
      validation: CODEX_53,
      codeReview: CLAUDE_SONNET,
      testReview: CODEX_53,
      integration: CODEX_53,
    },
    intelligenceConfig: {
      coordinator: CLAUDE_SONNET,
      worker_evaluation: CLAUDE_HAIKU,
      quality_gate: CLAUDE_SONNET,
      failure_diagnosis: CLAUDE_HAIKU,
      plan_adjustment: CLAUDE_SONNET,
      intervention_handling: CLAUDE_SONNET,
      chat_response: CLAUDE_SONNET,
    }
  },
  {
    id: "fast-cheap",
    name: "Fast & Cheap",
    description: "Minimizes cost and latency. Uses lightweight models everywhere. Good for simple tasks.",
    isBuiltIn: true,
    orchestratorModel: CLAUDE_HAIKU,
    phaseDefaults: {
      planning: CLAUDE_HAIKU,
      implementation: CODEX_MINI,
      testing: CODEX_MINI,
      validation: CODEX_MINI,
      codeReview: CLAUDE_HAIKU,
      testReview: CODEX_MINI,
      integration: CODEX_MINI,
    },
    intelligenceConfig: {
      coordinator: CLAUDE_HAIKU,
      worker_evaluation: CLAUDE_HAIKU,
      quality_gate: CLAUDE_HAIKU,
      failure_diagnosis: CLAUDE_HAIKU,
      plan_adjustment: CLAUDE_HAIKU,
      intervention_handling: CLAUDE_HAIKU,
      chat_response: CLAUDE_HAIKU,
    },
    smartBudget: {
      enabled: true,
      fiveHourThresholdUsd: 5,
      weeklyThresholdUsd: 25,
    }
  },
  {
    id: "max-quality",
    name: "Maximum Quality",
    description: "Uses the most capable models for every task. Higher cost, best results for complex projects.",
    isBuiltIn: true,
    orchestratorModel: CLAUDE_OPUS,
    phaseDefaults: {
      planning: CLAUDE_OPUS,
      implementation: { provider: "codex", modelId: "gpt-5.1-codex-max", thinkingLevel: "high" },
      testing: CODEX_53,
      validation: CLAUDE_OPUS,
      codeReview: CLAUDE_OPUS,
      testReview: CLAUDE_SONNET,
      integration: CODEX_53,
    },
    intelligenceConfig: {
      coordinator: CLAUDE_OPUS,
      worker_evaluation: CLAUDE_SONNET,
      quality_gate: CLAUDE_OPUS,
      failure_diagnosis: CLAUDE_SONNET,
      plan_adjustment: CLAUDE_OPUS,
      intervention_handling: CLAUDE_OPUS,
      chat_response: CLAUDE_SONNET,
    }
  },
  {
    id: "codex-only",
    name: "Codex Only",
    description: "Uses Codex (OpenAI) for everything. No Claude API calls. Good if you only have OpenAI access.",
    isBuiltIn: true,
    orchestratorModel: CODEX_53,
    phaseDefaults: {
      planning: CODEX_53,
      implementation: CODEX_53,
      testing: CODEX_53,
      validation: CODEX_53,
      codeReview: CODEX_53,
      testReview: CODEX_53,
      integration: CODEX_53,
    },
    intelligenceConfig: {
      coordinator: CODEX_53,
      worker_evaluation: CODEX_MINI,
      quality_gate: CODEX_53,
      failure_diagnosis: CODEX_MINI,
      plan_adjustment: CODEX_53,
      intervention_handling: CODEX_53,
      chat_response: CODEX_53,
    }
  },
  {
    id: "claude-only",
    name: "Claude Only",
    description: "Uses Claude for everything. No Codex/OpenAI API calls. Good if you only have Anthropic access.",
    isBuiltIn: true,
    orchestratorModel: CLAUDE_SONNET,
    phaseDefaults: {
      planning: CLAUDE_SONNET,
      implementation: CLAUDE_SONNET,
      testing: CLAUDE_SONNET,
      validation: CLAUDE_SONNET,
      codeReview: CLAUDE_SONNET,
      testReview: CLAUDE_HAIKU,
      integration: CLAUDE_SONNET,
    },
    intelligenceConfig: {
      coordinator: CLAUDE_SONNET,
      worker_evaluation: CLAUDE_HAIKU,
      quality_gate: CLAUDE_SONNET,
      failure_diagnosis: CLAUDE_HAIKU,
      plan_adjustment: CLAUDE_SONNET,
      intervention_handling: CLAUDE_SONNET,
      chat_response: CLAUDE_SONNET,
    }
  }
];

export function getProfileById(id: string): MissionModelProfile | undefined {
  return BUILT_IN_PROFILES.find((p) => p.id === id);
}

// ─────────────────────────────────────────────────────
// Resolution helpers
// ─────────────────────────────────────────────────────

/** Convert a legacy PhaseModelChoice + reasoningEffort to a ModelConfig */
export function legacyToModelConfig(
  model?: string | null,
  reasoningEffort?: string | null
): ModelConfig {
  if (!model || model === "codex") {
    return { provider: "codex", modelId: "gpt-5.3-codex", thinkingLevel: (reasoningEffort as ThinkingLevel) ?? "medium" };
  }
  if (model === "claude") {
    return { provider: "claude", modelId: "claude-sonnet-4-6", thinkingLevel: (reasoningEffort as ThinkingLevel) ?? "medium" };
  }
  // Specific model IDs — detect provider from the ID
  const provider: ModelProvider = model.startsWith("claude") || model.startsWith("opus") || model.startsWith("sonnet") || model.startsWith("haiku")
    ? "claude"
    : "codex";
  return { provider, modelId: model, thinkingLevel: (reasoningEffort as ThinkingLevel) ?? "medium" };
}

/** Convert ModelConfig back to legacy format for backward compat */
export function modelConfigToLegacy(config: ModelConfig): { model: string; reasoningEffort: string } {
  return {
    model: config.provider,
    reasoningEffort: config.thinkingLevel ?? "medium"
  };
}

/** Resolve the model config for a specific orchestrator call type */
export function resolveCallTypeModel(
  callType: OrchestratorCallType,
  intelligenceConfig?: OrchestratorIntelligenceConfig | null,
  fallbackModel?: ModelConfig | null
): ModelConfig {
  const explicit = intelligenceConfig?.[callType];
  if (explicit) return explicit;
  if (fallbackModel) return fallbackModel;
  // Ultimate fallback: Claude Sonnet
  return CLAUDE_SONNET;
}

/** Convert a ModelConfig to the model string used by aiIntegrationService */
export function modelConfigToServiceModel(config: ModelConfig): string {
  // Claude models: use the alias form (opus, sonnet, haiku) if it's a known model
  if (config.provider === "claude") {
    if (config.modelId.includes("opus")) return "opus";
    if (config.modelId.includes("haiku")) return "haiku";
    if (config.modelId.includes("sonnet")) return "sonnet";
    return config.modelId;
  }
  // Codex models: pass through the full model ID
  return config.modelId;
}

/** Convert ThinkingLevel to reasoning effort string for AI service */
export function thinkingLevelToReasoningEffort(level?: ThinkingLevel | null): string {
  if (!level || level === "none") return "low";
  return level;
}

/** Pricing per million tokens (USD) */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4 },
  "gpt-5.3-codex": { input: 2, output: 8 },
  "gpt-5.3-codex-spark": { input: 1, output: 4 },
  "gpt-5.2-codex": { input: 1.5, output: 6 },
  "gpt-5.1-codex-max": { input: 3, output: 12 },
  "codex-mini-latest": { input: 0.3, output: 1.2 },
  "o4-mini": { input: 1.1, output: 4.4 },
  "o3": { input: 2, output: 8 },
};
