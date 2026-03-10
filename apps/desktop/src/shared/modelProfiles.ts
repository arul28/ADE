import type {
  ModelConfig,
  ModelProvider,
  MissionModelProfile,
  OrchestratorCallType,
  OrchestratorIntelligenceConfig,
  ThinkingLevel
} from "./types";
import {
  getDefaultModelDescriptor,
  MODEL_REGISTRY,
  getModelPricing,
  listModelDescriptorsForProvider,
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

function providerFromFamily(family: ModelDescriptor["family"]): ModelProvider {
  if (family === "anthropic") return "claude";
  if (family === "openai") return "codex";
  return family;
}

/** Map a registry descriptor to a ModelEntry for the missions UI */
function descriptorToEntry(d: ModelDescriptor, overrides?: { recommended?: boolean }): ModelEntry {
  const provider: ModelProvider = providerFromFamily(d.family);
  return {
    provider,
    modelId: d.id,
    displayName: d.displayName,
    costTier: d.costTier ?? "medium",
    ...(overrides?.recommended ? { recommended: true } : {}),
  };
}

const DEFAULT_CLAUDE_MODEL_ID = getDefaultModelDescriptor("claude")?.id ?? "anthropic/claude-sonnet-4-6";
const DEFAULT_CODEX_MODEL_ID = getDefaultModelDescriptor("codex")?.id ?? "openai/gpt-5.4-codex";

// CLI-wrapped Anthropic models (claude provider)
export const CLAUDE_MODELS: ModelEntry[] = MODEL_REGISTRY
  .filter((m) => m.family === "anthropic" && m.isCliWrapped && !m.deprecated)
  .map((d) => descriptorToEntry(d, {
    recommended: d.id === DEFAULT_CLAUDE_MODEL_ID,
  }));

// CLI-wrapped OpenAI models (codex provider)
export const CODEX_MODELS: ModelEntry[] = listModelDescriptorsForProvider("codex")
  .map((d) => descriptorToEntry(d, {
    recommended: d.id === DEFAULT_CODEX_MODEL_ID,
  }));

export const ALL_MODELS: ModelEntry[] = MODEL_REGISTRY
  .filter((m) => !m.deprecated)
  .map((m) => descriptorToEntry(m));

export function findModel(modelId: string): ModelEntry | undefined {
  return ALL_MODELS.find((m) => m.modelId === modelId);
}

export function getModelsForProvider(provider: ModelProvider): ModelEntry[] {
  return ALL_MODELS.filter((entry) => entry.provider === provider);
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
  if (provider === "claude") return CLAUDE_THINKING_LEVELS;
  if (provider === "codex") return CODEX_THINKING_LEVELS;
  return [
    { value: "minimal", label: "Minimal" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
  ];
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

const CLAUDE_SONNET: ModelConfig = { provider: "claude", modelId: "anthropic/claude-sonnet-4-6", thinkingLevel: "medium" };
const CLAUDE_HAIKU: ModelConfig = { provider: "claude", modelId: "anthropic/claude-haiku-4-5", thinkingLevel: "low" };
const CLAUDE_OPUS: ModelConfig = { provider: "claude", modelId: "anthropic/claude-opus-4-6", thinkingLevel: "high" };
const CODEX_STANDARD: ModelConfig = { provider: "codex", modelId: DEFAULT_CODEX_MODEL_ID, thinkingLevel: "medium" };
const CODEX_MINI: ModelConfig = { provider: "codex", modelId: "openai/codex-mini-latest", thinkingLevel: "low" };

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
      implementation: CODEX_STANDARD,
      testing: CODEX_STANDARD,
      validation: CODEX_STANDARD,
      codeReview: CLAUDE_SONNET,
      testReview: CODEX_STANDARD,
      prReview: CODEX_STANDARD,
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
      implementation: { provider: "codex", modelId: "openai/gpt-5.1-codex-max", thinkingLevel: "high" },
      testing: CODEX_STANDARD,
      validation: CLAUDE_OPUS,
      codeReview: CLAUDE_OPUS,
      testReview: CLAUDE_SONNET,
      prReview: CODEX_STANDARD,
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
    orchestratorModel: CODEX_STANDARD,
    decisionTimeoutCapHours: 24,
    phaseDefaults: {
      planning: CODEX_STANDARD,
      implementation: CODEX_STANDARD,
      testing: CODEX_STANDARD,
      validation: CODEX_STANDARD,
      codeReview: CODEX_STANDARD,
      testReview: CODEX_STANDARD,
      prReview: CODEX_STANDARD,
    },
    intelligenceConfig: {
      coordinator: CODEX_STANDARD,
      chat_response: CODEX_STANDARD,
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
  const modelId = config.modelId?.trim();
  if (modelId && modelId.length > 0) return modelId;
  if (config.provider === "codex") return DEFAULT_CODEX_MODEL_ID;
  return "anthropic/claude-sonnet-4-6";
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
