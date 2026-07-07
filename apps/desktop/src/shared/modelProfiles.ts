import type {
  ModelConfig,
  ModelProvider,
  ThinkingLevel
} from "./types";
import {
  getDefaultModelDescriptor,
  MODEL_REGISTRY,
  getModelPricing,
  listModelDescriptorsForProvider,
  resolveModelDescriptor,
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

/** Map a registry descriptor to a model picker entry. */
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

const DEFAULT_CLAUDE_MODEL_ID = getDefaultModelDescriptor("claude")?.id ?? "anthropic/claude-sonnet-5";
const DEFAULT_CODEX_MODEL_ID = getDefaultModelDescriptor("codex")?.id ?? "openai/gpt-5.5";

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
  const descriptor = resolveModelDescriptor(modelId);
  const resolvedModelId = descriptor?.id ?? modelId;
  return ALL_MODELS.find((m) => m.modelId === resolvedModelId);
}

export function getModelsForProvider(provider: ModelProvider): ModelEntry[] {
  return ALL_MODELS.filter((entry) => entry.provider === provider);
}

// ─────────────────────────────────────────────────────
// Thinking levels per provider
// ─────────────────────────────────────────────────────

export type ThinkingOption = { value: ThinkingLevel; label: string };

export const CLAUDE_THINKING_LEVELS: ThinkingOption[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
  { value: "max", label: "Max" },
  { value: "ultracode", label: "Ultracode" },
];

export const CODEX_THINKING_LEVELS: ThinkingOption[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
];

export function getThinkingLevels(provider: ModelProvider): ThinkingOption[] {
  if (provider === "claude") return CLAUDE_THINKING_LEVELS;
  if (provider === "codex") return CODEX_THINKING_LEVELS;
  return [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
  ];
}

/** Convert a ModelConfig to the model string used by aiIntegrationService */
export function modelConfigToServiceModel(config: ModelConfig): string {
  const modelId = config.modelId?.trim();
  if (modelId && modelId.length > 0) return modelId;
  if (config.provider === "codex") return DEFAULT_CODEX_MODEL_ID;
  return DEFAULT_CLAUDE_MODEL_ID;
}

/** Convert ThinkingLevel to reasoning effort string for AI service */
export function thinkingLevelToReasoningEffort(level?: ThinkingLevel | null): string {
  if (!level || level === "none" || level === "minimal") return "low";
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
      return MODEL_REGISTRY.map((m) => m.providerModelId);
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
