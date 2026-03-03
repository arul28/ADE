import type {
  ModelConfig,
  ModelProvider,
  MissionModelProfile,
  OrchestratorCallType,
  OrchestratorIntelligenceConfig,
  ThinkingLevel
} from "./types";
import {
  MODEL_REGISTRY,
  getModelPricing,
  updateModelPricingInRegistry,
  type ModelDescriptor,
} from "./modelRegistry";

// ─────────────────────────────────────────────────────
// Known model catalogs — derived from MODEL_REGISTRY
// ─────────────────────────────────────────────────────

export type ModelEntry = {
  provider: ModelProvider;
  modelId: string;
  displayName: string;
  costTier: "low" | "medium" | "high" | "very_high";
  recommended?: boolean;
};

/** Map a registry descriptor to a ModelEntry for the missions UI */
function descriptorToEntry(d: ModelDescriptor, overrides?: { recommended?: boolean }): ModelEntry {
  const provider: ModelProvider = d.family === "anthropic" ? "claude" : "codex";
  return {
    provider,
    modelId: d.sdkModelId,
    displayName: d.displayName,
    costTier: d.costTier ?? "medium",
    ...(overrides?.recommended ? { recommended: true } : {}),
  };
}

// CLI-wrapped Anthropic models (claude provider)
export const CLAUDE_MODELS: ModelEntry[] = MODEL_REGISTRY
  .filter((m) => m.family === "anthropic" && m.isCliWrapped && !m.deprecated)
  .map((d) => descriptorToEntry(d, {
    recommended: d.sdkModelId.includes("sonnet"),
  }));

// CLI-wrapped OpenAI models (codex provider)
export const CODEX_MODELS: ModelEntry[] = MODEL_REGISTRY
  .filter((m) => m.family === "openai" && m.isCliWrapped && !m.deprecated)
  .map((d) => descriptorToEntry(d, {
    recommended: d.sdkModelId === "gpt-5.3-codex",
  }));

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
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
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
};

export const ORCHESTRATOR_CALL_TYPES: CallTypeInfo[] = [
  {
    key: "coordinator",
    label: "Coordinator",
    description: "Persistent AI session that manages the mission — spawns workers, makes decisions, handles failures",
    defaultProvider: "claude",
  },
  {
    key: "chat_response",
    label: "Chat Response",
    description: "Handles user chat messages when no coordinator is active",
    defaultProvider: "claude",
  },
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
    decisionTimeoutCapHours: 24,
    phaseDefaults: {
      planning: CLAUDE_SONNET,
      implementation: CODEX_53,
      testing: CODEX_53,
      validation: CODEX_53,
      codeReview: CLAUDE_SONNET,
      testReview: CODEX_53,
      prReview: CODEX_53,
    },
    intelligenceConfig: {
      coordinator: CLAUDE_SONNET,
      chat_response: CLAUDE_SONNET,
    }
  },
  {
    id: "fast-cheap",
    name: "Fast & Cheap",
    description: "Minimizes cost and latency. Uses lightweight models everywhere. Good for simple tasks.",
    isBuiltIn: true,
    orchestratorModel: CLAUDE_HAIKU,
    decisionTimeoutCapHours: 24,
    phaseDefaults: {
      planning: CLAUDE_HAIKU,
      implementation: CODEX_MINI,
      testing: CODEX_MINI,
      validation: CODEX_MINI,
      codeReview: CLAUDE_HAIKU,
      testReview: CODEX_MINI,
      prReview: CODEX_MINI,
    },
    intelligenceConfig: {
      coordinator: CLAUDE_HAIKU,
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
    decisionTimeoutCapHours: 24,
    phaseDefaults: {
      planning: CLAUDE_OPUS,
      implementation: { provider: "codex", modelId: "gpt-5.1-codex-max", thinkingLevel: "high" },
      testing: CODEX_53,
      validation: CLAUDE_OPUS,
      codeReview: CLAUDE_OPUS,
      testReview: CLAUDE_SONNET,
      prReview: CODEX_53,
    },
    intelligenceConfig: {
      coordinator: CLAUDE_OPUS,
      chat_response: CLAUDE_SONNET,
    }
  },
  {
    id: "codex-only",
    name: "Codex Only",
    description: "Uses Codex (OpenAI) for everything. No Claude API calls. Good if you only have OpenAI access.",
    isBuiltIn: true,
    orchestratorModel: CODEX_53,
    decisionTimeoutCapHours: 24,
    phaseDefaults: {
      planning: CODEX_53,
      implementation: CODEX_53,
      testing: CODEX_53,
      validation: CODEX_53,
      codeReview: CODEX_53,
      testReview: CODEX_53,
      prReview: CODEX_53,
    },
    intelligenceConfig: {
      coordinator: CODEX_53,
      chat_response: CODEX_53,
    }
  },
  {
    id: "claude-only",
    name: "Claude Only",
    description: "Uses Claude for everything. No Codex/OpenAI API calls. Good if you only have Anthropic access.",
    isBuiltIn: true,
    orchestratorModel: CLAUDE_SONNET,
    decisionTimeoutCapHours: 24,
    phaseDefaults: {
      planning: CLAUDE_SONNET,
      implementation: CLAUDE_SONNET,
      testing: CLAUDE_SONNET,
      validation: CLAUDE_SONNET,
      codeReview: CLAUDE_SONNET,
      testReview: CLAUDE_HAIKU,
      prReview: CLAUDE_SONNET,
    },
    intelligenceConfig: {
      coordinator: CLAUDE_SONNET,
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

const VALID_THINKING_LEVELS: Set<string> = new Set([
  "none", "minimal", "low", "medium", "high", "max", "xhigh",
]);

function toThinkingLevel(value?: string | null): ThinkingLevel {
  if (value && VALID_THINKING_LEVELS.has(value)) return value as ThinkingLevel;
  return "medium";
}

/** Convert a legacy PhaseModelChoice + reasoningEffort to a ModelConfig */
export function legacyToModelConfig(
  model?: string | null,
  reasoningEffort?: string | null
): ModelConfig {
  const trimmedModel = (model ?? "").trim();
  const normalizedModel = trimmedModel.toLowerCase();
  const thinking = toThinkingLevel(reasoningEffort);
  if (!normalizedModel || normalizedModel === "codex") {
    return { provider: "codex", modelId: "gpt-5.3-codex", thinkingLevel: thinking };
  }
  if (normalizedModel === "claude") {
    return { provider: "claude", modelId: "claude-sonnet-4-6", thinkingLevel: thinking };
  }
  // Specific model IDs - detect provider from namespaced IDs first, then aliases.
  const namespacedFamily = normalizedModel.includes("/") ? normalizedModel.split("/", 1)[0] : null;
  if (namespacedFamily === "anthropic") {
    return { provider: "claude", modelId: trimmedModel, thinkingLevel: thinking };
  }
  if (namespacedFamily === "openai") {
    return { provider: "codex", modelId: trimmedModel, thinkingLevel: thinking };
  }
  const provider: ModelProvider = normalizedModel.includes("claude")
    || normalizedModel.startsWith("opus")
    || normalizedModel.startsWith("sonnet")
    || normalizedModel.startsWith("haiku")
    ? "claude"
    : "codex";
  return { provider, modelId: trimmedModel, thinkingLevel: thinking };
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

// ─────────────────────────────────────────────────────
// Pricing — delegates to modelRegistry
// ─────────────────────────────────────────────────────

/**
 * Pricing per million tokens (USD).
 * Delegates to getModelPricing() in modelRegistry.
 * Preserved as a Proxy for backward compatibility with existing consumers
 * that read `MODEL_PRICING[modelId]`.
 */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = new Proxy(
  {} as Record<string, { input: number; output: number }>,
  {
    get(_target, prop: string) {
      return getModelPricing(prop);
    },
    has(_target, prop: string) {
      return getModelPricing(prop) !== undefined;
    },
    ownKeys() {
      return MODEL_REGISTRY.map((m) => m.sdkModelId);
    },
    getOwnPropertyDescriptor(_target, prop: string) {
      const value = getModelPricing(prop);
      if (value) {
        return { configurable: true, enumerable: true, value };
      }
      return undefined;
    },
  },
);

/**
 * Merge dynamic pricing updates (e.g. from models.dev) into MODEL_PRICING.
 * Delegates to updateModelPricingInRegistry in modelRegistry.
 * Returns the number of entries updated.
 */
export function updateModelPricing(updates: Record<string, { input: number; output: number }>): number {
  return updateModelPricingInRegistry(updates);
}
