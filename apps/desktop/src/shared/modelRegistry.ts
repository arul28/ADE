// ---------------------------------------------------------------------------
// Model Registry — single source of truth for all AI models
// ---------------------------------------------------------------------------

export type AuthType = "cli-subscription" | "api-key" | "oauth" | "openrouter" | "local";

export type ProviderFamily =
  | "anthropic"
  | "openai"
  | "google"
  | "mistral"
  | "deepseek"
  | "xai"
  | "meta"
  | "openrouter"
  | "ollama"
  | "lmstudio"
  | "vllm"
  | "groq"
  | "together";

export type LocalProviderFamily = Extract<ProviderFamily, "ollama" | "lmstudio" | "vllm">;

export type ModelCapabilities = {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  streaming: boolean;
};

export type ModelDescriptor = {
  id: string;
  shortId: string;
  aliases?: string[];
  displayName: string;
  family: ProviderFamily;
  authTypes: AuthType[];
  contextWindow: number;
  maxOutputTokens: number;
  capabilities: ModelCapabilities;
  reasoningTiers?: string[];
  color: string;
  sdkProvider: string;
  sdkModelId: string;
  cliCommand?: string;
  isCliWrapped: boolean;
  deprecated?: boolean;
  /** Price per million input tokens (USD). Used for cost estimation. */
  inputPricePer1M?: number;
  /** Price per million output tokens (USD). Used for cost estimation. */
  outputPricePer1M?: number;
  /** Curated cost tier for UI display (missions model selector) */
  costTier?: "low" | "medium" | "high" | "very_high";
};

export type WorkerExecutionPath = "cli" | "api" | "local";
export type ModelProviderGroup = "claude" | "codex" | "unified";

// ---------------------------------------------------------------------------
// Registry data
// ---------------------------------------------------------------------------

const ALL_CAPS: ModelCapabilities = { tools: true, vision: true, reasoning: true, streaming: true };
const NO_REASONING: ModelCapabilities = { tools: true, vision: true, reasoning: false, streaming: true };
const BASIC_CAPS: ModelCapabilities = { tools: true, vision: false, reasoning: false, streaming: true };
const LOCAL_PROVIDER_LABELS: Record<LocalProviderFamily, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  vllm: "vLLM",
};
const LOCAL_PROVIDER_COLORS: Record<LocalProviderFamily, string> = {
  ollama: "#71717A",
  lmstudio: "#64748B",
  vllm: "#475569",
};
const LOCAL_PROVIDER_ENDPOINTS: Record<LocalProviderFamily, string> = {
  ollama: "http://localhost:11434",
  lmstudio: "http://localhost:1234",
  vllm: "http://localhost:8000",
};

export const MODEL_REGISTRY: ModelDescriptor[] = [
  // ---- Anthropic (CLI-wrapped via claude) ----
  // Claude chat surfaces in ADE use the native low/medium/high effort ladder.
  {
    id: "anthropic/claude-opus-4-6",
    shortId: "opus",
    displayName: "Claude Opus 4.6",
    family: "anthropic",
    authTypes: ["cli-subscription"],
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high"],
    color: "#D97706",
    sdkProvider: "ai-sdk-provider-claude-code",
    sdkModelId: "opus",
    cliCommand: "claude",
    isCliWrapped: true,
    inputPricePer1M: 5,
    outputPricePer1M: 25,
    costTier: "very_high",
  },
  {
    id: "anthropic/claude-sonnet-4-6",
    shortId: "sonnet",
    displayName: "Claude Sonnet 4.6",
    family: "anthropic",
    authTypes: ["cli-subscription"],
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high"],
    color: "#8B5CF6",
    sdkProvider: "ai-sdk-provider-claude-code",
    sdkModelId: "sonnet",
    cliCommand: "claude",
    isCliWrapped: true,
    inputPricePer1M: 3,
    outputPricePer1M: 15,
    costTier: "medium",
  },
  {
    id: "anthropic/claude-haiku-4-5",
    shortId: "haiku",
    displayName: "Claude Haiku 4.5",
    family: "anthropic",
    authTypes: ["cli-subscription"],
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    capabilities: NO_REASONING,
    color: "#06B6D4",
    sdkProvider: "ai-sdk-provider-claude-code",
    sdkModelId: "haiku",
    cliCommand: "claude",
    isCliWrapped: true,
    inputPricePer1M: 0.8,
    outputPricePer1M: 4,
    costTier: "low",
  },

  // ---- Anthropic (API key direct) ----
  {
    id: "anthropic/claude-opus-4-6-api",
    shortId: "opus-api",
    displayName: "Claude Opus 4.6 (API)",
    family: "anthropic",
    authTypes: ["api-key"],
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high"],
    color: "#D97706",
    sdkProvider: "@ai-sdk/anthropic",
    sdkModelId: "claude-opus-4-6",
    isCliWrapped: false,
    inputPricePer1M: 5,
    outputPricePer1M: 25,
    costTier: "very_high",
  },
  {
    id: "anthropic/claude-sonnet-4-6-api",
    shortId: "sonnet-api",
    displayName: "Claude Sonnet 4.6 (API)",
    family: "anthropic",
    authTypes: ["api-key"],
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high"],
    color: "#8B5CF6",
    sdkProvider: "@ai-sdk/anthropic",
    sdkModelId: "claude-sonnet-4-6",
    isCliWrapped: false,
    inputPricePer1M: 3,
    outputPricePer1M: 15,
    costTier: "medium",
  },
  {
    id: "anthropic/claude-haiku-4-5-api",
    shortId: "haiku-api",
    displayName: "Claude Haiku 4.5 (API)",
    family: "anthropic",
    authTypes: ["api-key"],
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    capabilities: NO_REASONING,
    color: "#06B6D4",
    sdkProvider: "@ai-sdk/anthropic",
    sdkModelId: "claude-haiku-4-5-20251001",
    isCliWrapped: false,
    inputPricePer1M: 0.8,
    outputPricePer1M: 4,
    costTier: "low",
  },

  // ---- OpenAI (CLI-wrapped via codex) ----
  // ADE codex chat surfaces expose a consistent ladder:
  // low | medium | high | xhigh, except Codex Mini which only exposes medium | high.
  {
    id: "openai/gpt-5.4-codex",
    shortId: "gpt-5.4",
    aliases: ["gpt-5.4-codex"],
    displayName: "GPT-5.4",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high", "xhigh"],
    color: "#10A37F",
    sdkProvider: "ai-sdk-provider-codex-cli",
    sdkModelId: "gpt-5.4",
    cliCommand: "codex",
    isCliWrapped: true,
    costTier: "high",
  },
  {
    id: "openai/gpt-5.3-codex",
    shortId: "gpt-5.3-codex",
    displayName: "GPT-5.3 Codex",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high", "xhigh"],
    color: "#10B981",
    sdkProvider: "ai-sdk-provider-codex-cli",
    sdkModelId: "gpt-5.3-codex",
    cliCommand: "codex",
    isCliWrapped: true,
    inputPricePer1M: 1.5,
    outputPricePer1M: 6,
    costTier: "high",
  },
  {
    id: "openai/gpt-5.3-codex-spark",
    shortId: "gpt-5.3-codex-spark",
    displayName: "GPT-5.3 Codex Spark",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 192_000,
    maxOutputTokens: 16_384,
    capabilities: { tools: true, vision: false, reasoning: true, streaming: true },
    reasoningTiers: ["low", "medium", "high", "xhigh"],
    color: "#34D399",
    sdkProvider: "ai-sdk-provider-codex-cli",
    sdkModelId: "gpt-5.3-codex-spark",
    cliCommand: "codex",
    isCliWrapped: true,
    inputPricePer1M: 1,
    outputPricePer1M: 4,
    costTier: "medium",
  },
  {
    id: "openai/gpt-5.2-codex",
    shortId: "gpt-5.2-codex",
    displayName: "GPT-5.2 Codex",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high", "xhigh"],
    color: "#10B981",
    sdkProvider: "ai-sdk-provider-codex-cli",
    sdkModelId: "gpt-5.2-codex",
    cliCommand: "codex",
    isCliWrapped: true,
    inputPricePer1M: 1.5,
    outputPricePer1M: 6,
    costTier: "medium",
  },
  {
    id: "openai/gpt-5.1-codex-max",
    shortId: "gpt-5.1-codex-max",
    displayName: "GPT-5.1 Codex Max",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 192_000,
    maxOutputTokens: 16_384,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high", "xhigh"],
    color: "#10B981",
    sdkProvider: "ai-sdk-provider-codex-cli",
    sdkModelId: "gpt-5.1-codex-max",
    cliCommand: "codex",
    isCliWrapped: true,
    inputPricePer1M: 3,
    outputPricePer1M: 12,
    costTier: "high",
  },
  {
    id: "openai/gpt-5.1-codex",
    shortId: "gpt-5.1-codex",
    displayName: "GPT-5.1 Codex",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high", "xhigh"],
    color: "#14B8A6",
    sdkProvider: "ai-sdk-provider-codex-cli",
    sdkModelId: "gpt-5.1-codex",
    cliCommand: "codex",
    isCliWrapped: true,
    inputPricePer1M: 1.25,
    outputPricePer1M: 10,
    costTier: "medium",
  },
  {
    id: "openai/gpt-5.1-codex-mini",
    shortId: "gpt-5.1-codex-mini",
    displayName: "GPT-5.1 Codex Mini",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["medium", "high"],
    color: "#2DD4BF",
    sdkProvider: "ai-sdk-provider-codex-cli",
    sdkModelId: "gpt-5.1-codex-mini",
    cliCommand: "codex",
    isCliWrapped: true,
    inputPricePer1M: 0.25,
    outputPricePer1M: 2,
    costTier: "low",
  },
  {
    id: "openai/gpt-5-codex",
    shortId: "gpt-5-codex",
    displayName: "GPT-5 Codex",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high", "xhigh"],
    color: "#059669",
    sdkProvider: "ai-sdk-provider-codex-cli",
    sdkModelId: "gpt-5-codex",
    cliCommand: "codex",
    isCliWrapped: true,
    inputPricePer1M: 1.25,
    outputPricePer1M: 10,
    costTier: "medium",
  },
  {
    id: "openai/codex-mini-latest",
    shortId: "codex-mini",
    displayName: "Codex Mini",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["medium", "high"],
    color: "#34D399",
    sdkProvider: "ai-sdk-provider-codex-cli",
    sdkModelId: "codex-mini-latest",
    cliCommand: "codex",
    isCliWrapped: true,
    inputPricePer1M: 1.5,
    outputPricePer1M: 6,
    costTier: "low",
  },
  {
    id: "openai/o4-mini",
    shortId: "o4-mini",
    displayName: "o4-mini",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 192_000,
    maxOutputTokens: 16_384,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high"],
    color: "#6EE7B7",
    sdkProvider: "ai-sdk-provider-codex-cli",
    sdkModelId: "o4-mini",
    cliCommand: "codex",
    isCliWrapped: true,
    inputPricePer1M: 1.1,
    outputPricePer1M: 4.4,
    costTier: "low",
  },
  {
    id: "openai/o3",
    shortId: "o3",
    displayName: "o3",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 192_000,
    maxOutputTokens: 16_384,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high"],
    color: "#059669",
    sdkProvider: "ai-sdk-provider-codex-cli",
    sdkModelId: "o3",
    cliCommand: "codex",
    isCliWrapped: true,
    inputPricePer1M: 2,
    outputPricePer1M: 8,
    costTier: "medium",
  },

  // ---- OpenAI (API key direct) ----
  {
    id: "openai/gpt-5.4",
    shortId: "gpt-5.4",
    aliases: ["gpt-5.4-2026-03-05"],
    displayName: "GPT-5.4",
    family: "openai",
    authTypes: ["api-key"],
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["none", "low", "medium", "high", "xhigh"],
    color: "#10A37F",
    sdkProvider: "@ai-sdk/openai",
    sdkModelId: "gpt-5.4",
    isCliWrapped: false,
    inputPricePer1M: 2.5,
    outputPricePer1M: 15,
    costTier: "high",
  },
  {
    id: "openai/gpt-5-chat-latest",
    shortId: "gpt-5-chat-latest",
    aliases: ["gpt-5-latest"],
    displayName: "GPT-5 Chat Latest",
    family: "openai",
    authTypes: ["api-key"],
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["none", "low", "medium", "high", "xhigh"],
    color: "#22C55E",
    sdkProvider: "@ai-sdk/openai",
    sdkModelId: "gpt-5-chat-latest",
    isCliWrapped: false,
    costTier: "high",
  },
  {
    id: "openai/gpt-5.4-pro",
    shortId: "gpt-5.4-pro",
    aliases: ["gpt-5.4-pro-2026-03-05"],
    displayName: "GPT-5.4 Pro",
    family: "openai",
    authTypes: ["api-key"],
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["medium", "high", "xhigh"],
    color: "#0F766E",
    sdkProvider: "@ai-sdk/openai",
    sdkModelId: "gpt-5.4-pro",
    isCliWrapped: false,
    inputPricePer1M: 30,
    outputPricePer1M: 180,
    costTier: "very_high",
  },
  {
    id: "openai/gpt-5.3-codex-api",
    shortId: "gpt-5.3-codex-api",
    aliases: ["gpt-5.3-codex"],
    displayName: "GPT-5.3 Codex (API)",
    family: "openai",
    authTypes: ["api-key"],
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high", "xhigh"],
    color: "#10B981",
    sdkProvider: "@ai-sdk/openai",
    sdkModelId: "gpt-5.3-codex",
    isCliWrapped: false,
    inputPricePer1M: 1.75,
    outputPricePer1M: 14,
    costTier: "high",
  },
  {
    id: "openai/gpt-5.2-codex-api",
    shortId: "gpt-5.2-codex-api",
    aliases: ["gpt-5.2-codex"],
    displayName: "GPT-5.2 Codex (API)",
    family: "openai",
    authTypes: ["api-key"],
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high", "xhigh"],
    color: "#0EA5A4",
    sdkProvider: "@ai-sdk/openai",
    sdkModelId: "gpt-5.2-codex",
    isCliWrapped: false,
    inputPricePer1M: 1.75,
    outputPricePer1M: 14,
    costTier: "high",
  },
  {
    id: "openai/gpt-5.1-codex-api",
    shortId: "gpt-5.1-codex-api",
    aliases: ["gpt-5.1-codex"],
    displayName: "GPT-5.1 Codex (API)",
    family: "openai",
    authTypes: ["api-key"],
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high", "xhigh"],
    color: "#14B8A6",
    sdkProvider: "@ai-sdk/openai",
    sdkModelId: "gpt-5.1-codex",
    isCliWrapped: false,
    inputPricePer1M: 1.25,
    outputPricePer1M: 10,
    costTier: "medium",
  },
  {
    id: "openai/gpt-5-codex-api",
    shortId: "gpt-5-codex-api",
    aliases: ["gpt-5-codex"],
    displayName: "GPT-5 Codex (API)",
    family: "openai",
    authTypes: ["api-key"],
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high", "xhigh"],
    color: "#059669",
    sdkProvider: "@ai-sdk/openai",
    sdkModelId: "gpt-5-codex",
    isCliWrapped: false,
    inputPricePer1M: 1.25,
    outputPricePer1M: 10,
    costTier: "medium",
  },
  {
    id: "openai/gpt-5.2",
    shortId: "gpt-5.2",
    aliases: ["gpt-5.2-2025-12-11"],
    displayName: "GPT-5.2",
    family: "openai",
    authTypes: ["api-key"],
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["none", "low", "medium", "high", "xhigh"],
    color: "#0EA5A4",
    sdkProvider: "@ai-sdk/openai",
    sdkModelId: "gpt-5.2",
    isCliWrapped: false,
    inputPricePer1M: 1.75,
    outputPricePer1M: 14,
    costTier: "high",
  },
  {
    id: "openai/gpt-5.2-pro",
    shortId: "gpt-5.2-pro",
    aliases: ["gpt-5.2-pro-2025-12-11"],
    displayName: "GPT-5.2 Pro",
    family: "openai",
    authTypes: ["api-key"],
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["medium", "high", "xhigh"],
    color: "#0F766E",
    sdkProvider: "@ai-sdk/openai",
    sdkModelId: "gpt-5.2-pro",
    isCliWrapped: false,
    inputPricePer1M: 21,
    outputPricePer1M: 168,
    costTier: "very_high",
  },
  {
    id: "openai/gpt-5.1",
    shortId: "gpt-5.1",
    aliases: ["gpt-5.1-2025-10-06"],
    displayName: "GPT-5.1",
    family: "openai",
    authTypes: ["api-key"],
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["none", "low", "medium", "high"],
    color: "#14B8A6",
    sdkProvider: "@ai-sdk/openai",
    sdkModelId: "gpt-5.1",
    isCliWrapped: false,
    inputPricePer1M: 1.25,
    outputPricePer1M: 10,
    costTier: "medium",
  },
  {
    id: "openai/gpt-5-pro",
    shortId: "gpt-5-pro",
    aliases: ["gpt-5-pro-2025-10-06"],
    displayName: "GPT-5 Pro",
    family: "openai",
    authTypes: ["api-key"],
    contextWindow: 400_000,
    maxOutputTokens: 272_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["high"],
    color: "#115E59",
    sdkProvider: "@ai-sdk/openai",
    sdkModelId: "gpt-5-pro",
    isCliWrapped: false,
    inputPricePer1M: 15,
    outputPricePer1M: 120,
    costTier: "very_high",
  },
  {
    id: "openai/gpt-5",
    shortId: "gpt-5",
    aliases: ["gpt-5-2025-08-07"],
    displayName: "GPT-5",
    family: "openai",
    authTypes: ["api-key"],
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["minimal", "low", "medium", "high"],
    color: "#10B981",
    sdkProvider: "@ai-sdk/openai",
    sdkModelId: "gpt-5",
    isCliWrapped: false,
    inputPricePer1M: 1.25,
    outputPricePer1M: 10,
    costTier: "medium",
  },
  {
    id: "openai/gpt-5-mini",
    shortId: "gpt-5-mini",
    aliases: ["gpt-5-mini-2025-08-07"],
    displayName: "GPT-5 Mini",
    family: "openai",
    authTypes: ["api-key"],
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["minimal", "low", "medium", "high"],
    color: "#34D399",
    sdkProvider: "@ai-sdk/openai",
    sdkModelId: "gpt-5-mini",
    isCliWrapped: false,
    inputPricePer1M: 0.25,
    outputPricePer1M: 2,
    costTier: "low",
  },
  {
    id: "openai/gpt-5-nano",
    shortId: "gpt-5-nano",
    aliases: ["gpt-5-nano-2025-08-07"],
    displayName: "GPT-5 Nano",
    family: "openai",
    authTypes: ["api-key"],
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["minimal", "low", "medium", "high"],
    color: "#6EE7B7",
    sdkProvider: "@ai-sdk/openai",
    sdkModelId: "gpt-5-nano",
    isCliWrapped: false,
    inputPricePer1M: 0.05,
    outputPricePer1M: 0.4,
    costTier: "low",
  },
  {
    id: "openai/gpt-4.1",
    shortId: "gpt-4.1",
    displayName: "GPT-4.1",
    family: "openai",
    authTypes: ["api-key"],
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    capabilities: NO_REASONING,
    color: "#10B981",
    sdkProvider: "@ai-sdk/openai",
    sdkModelId: "gpt-4.1",
    isCliWrapped: false,
    inputPricePer1M: 2,
    outputPricePer1M: 8,
  },
  {
    id: "openai/gpt-4.1-mini",
    shortId: "gpt-4.1-mini",
    displayName: "GPT-4.1 Mini",
    family: "openai",
    authTypes: ["api-key"],
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    capabilities: NO_REASONING,
    color: "#34D399",
    sdkProvider: "@ai-sdk/openai",
    sdkModelId: "gpt-4.1-mini",
    isCliWrapped: false,
    inputPricePer1M: 0.4,
    outputPricePer1M: 1.6,
  },
  {
    id: "openai/o4-mini-api",
    shortId: "o4-mini-api",
    displayName: "o4-mini (API)",
    family: "openai",
    authTypes: ["api-key"],
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high"],
    color: "#6EE7B7",
    sdkProvider: "@ai-sdk/openai",
    sdkModelId: "o4-mini",
    isCliWrapped: false,
    inputPricePer1M: 1.1,
    outputPricePer1M: 4.4,
  },

  // ---- Google (Gemini 3.x — current) ----
  {
    id: "google/gemini-3.1-pro",
    shortId: "gemini-pro",
    displayName: "Gemini 3.1 Pro",
    family: "google",
    authTypes: ["api-key"],
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high"],
    color: "#F59E0B",
    sdkProvider: "@ai-sdk/google",
    sdkModelId: "gemini-3.1-pro-preview",
    isCliWrapped: false,
    inputPricePer1M: 1.25,
    outputPricePer1M: 5,
  },
  {
    id: "google/gemini-3-flash",
    shortId: "gemini-flash",
    displayName: "Gemini 3 Flash",
    family: "google",
    authTypes: ["api-key"],
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "high"],
    color: "#FBBF24",
    sdkProvider: "@ai-sdk/google",
    sdkModelId: "gemini-3-flash-preview",
    isCliWrapped: false,
    inputPricePer1M: 0.15,
    outputPricePer1M: 0.6,
  },

  // ---- DeepSeek ----
  {
    id: "deepseek/deepseek-r1",
    shortId: "deepseek-r1",
    displayName: "DeepSeek R1",
    family: "deepseek",
    authTypes: ["api-key"],
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    capabilities: { tools: true, vision: false, reasoning: true, streaming: true },
    color: "#3B82F6",
    sdkProvider: "@ai-sdk/deepseek",
    sdkModelId: "deepseek-reasoner",
    isCliWrapped: false,
    inputPricePer1M: 0.55,
    outputPricePer1M: 2.19,
  },
  {
    id: "deepseek/deepseek-chat",
    shortId: "deepseek-chat",
    displayName: "DeepSeek Chat",
    family: "deepseek",
    authTypes: ["api-key"],
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    capabilities: BASIC_CAPS,
    color: "#60A5FA",
    sdkProvider: "@ai-sdk/deepseek",
    sdkModelId: "deepseek-chat",
    isCliWrapped: false,
    inputPricePer1M: 0.27,
    outputPricePer1M: 1.10,
  },

  // ---- Mistral ----
  {
    id: "mistral/codestral-latest",
    shortId: "codestral",
    displayName: "Codestral",
    family: "mistral",
    authTypes: ["api-key"],
    contextWindow: 256_000,
    maxOutputTokens: 8_192,
    capabilities: BASIC_CAPS,
    color: "#F97316",
    sdkProvider: "@ai-sdk/mistral",
    sdkModelId: "codestral-latest",
    isCliWrapped: false,
    inputPricePer1M: 0.3,
    outputPricePer1M: 0.9,
  },

  // ---- xAI ----
  {
    id: "xai/grok-3",
    shortId: "grok-3",
    displayName: "Grok 3",
    family: "xai",
    authTypes: ["api-key"],
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    capabilities: ALL_CAPS,
    color: "#EF4444",
    sdkProvider: "@ai-sdk/xai",
    sdkModelId: "grok-3",
    isCliWrapped: false,
    inputPricePer1M: 3,
    outputPricePer1M: 15,
  },

  // ---- OpenRouter ----
  {
    id: "openrouter/auto",
    shortId: "openrouter-auto",
    displayName: "OpenRouter Auto",
    family: "openrouter",
    authTypes: ["openrouter"],
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    capabilities: ALL_CAPS,
    color: "#A855F7",
    sdkProvider: "@openrouter/ai-sdk-provider",
    sdkModelId: "openrouter/auto",
    isCliWrapped: false,
  },

  // ---- Local (Ollama) ----
  {
    id: "ollama/llama-3.3",
    shortId: "llama-3.3",
    displayName: "Llama 3.3 (Local)",
    family: "ollama",
    authTypes: ["local"],
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    capabilities: BASIC_CAPS,
    color: "#71717A",
    sdkProvider: "@ai-sdk/openai-compatible",
    sdkModelId: "auto",
    isCliWrapped: false,
  },
  {
    id: "lmstudio/auto",
    shortId: "lmstudio-auto",
    displayName: "LM Studio (Auto)",
    family: "lmstudio",
    authTypes: ["local"],
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    capabilities: BASIC_CAPS,
    color: "#64748B",
    sdkProvider: "@ai-sdk/openai-compatible",
    sdkModelId: "auto",
    isCliWrapped: false,
  },
  {
    id: "vllm/auto",
    shortId: "vllm-auto",
    displayName: "vLLM (Auto)",
    family: "vllm",
    authTypes: ["local"],
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    capabilities: BASIC_CAPS,
    color: "#475569",
    sdkProvider: "@ai-sdk/openai-compatible",
    sdkModelId: "auto",
    isCliWrapped: false,
  },
];

// ---------------------------------------------------------------------------
// Index maps (built once, refreshed on enrichment)
// ---------------------------------------------------------------------------

let byId = new Map<string, ModelDescriptor>();
let byShortId = new Map<string, ModelDescriptor | null>();
let byAlias = new Map<string, ModelDescriptor>();
let bySdkModelId = new Map<string, ModelDescriptor>();

function rebuildIndexes() {
  byId = new Map<string, ModelDescriptor>();
  byShortId = new Map<string, ModelDescriptor | null>();
  byAlias = new Map<string, ModelDescriptor>();
  bySdkModelId = new Map<string, ModelDescriptor>();
  for (const m of MODEL_REGISTRY) {
    byId.set(m.id, m);
    const existingShortId = byShortId.get(m.shortId);
    if (existingShortId) {
      byShortId.set(m.shortId, null);
    } else if (!byShortId.has(m.shortId)) {
      byShortId.set(m.shortId, m);
    }
    bySdkModelId.set(m.sdkModelId, m);
    for (const alias of m.aliases ?? []) {
      const normalized = alias.trim().toLowerCase();
      if (normalized.length) byAlias.set(normalized, m);
    }
  }
}

export function validateModelRegistry(models: ModelDescriptor[] = MODEL_REGISTRY): void {
  const ids = new Set<string>();
  const aliases = new Set<string>();

  for (const model of models) {
    if (!model.id.trim()) {
      throw new Error("Model registry contains an entry with an empty id.");
    }
    if (ids.has(model.id)) {
      throw new Error(`Model registry contains a duplicate id: ${model.id}`);
    }
    ids.add(model.id);

    if (!model.shortId.trim()) {
      throw new Error(`Model registry entry ${model.id} is missing a shortId.`);
    }

    for (const alias of model.aliases ?? []) {
      const normalizedAlias = alias.trim().toLowerCase();
      if (!normalizedAlias) continue;
      if (aliases.has(normalizedAlias)) {
        throw new Error(`Model registry contains a duplicate alias: ${normalizedAlias}`);
      }
      aliases.add(normalizedAlias);
    }
  }
}

validateModelRegistry();
rebuildIndexes();

function isLocalProviderFamily(value: string): value is LocalProviderFamily {
  return value === "ollama" || value === "lmstudio" || value === "vllm";
}

function parseDynamicLocalModelRef(modelRef: string): { provider: LocalProviderFamily; modelId: string } | null {
  const normalized = modelRef.trim();
  if (!normalized.length) return null;
  const separatorIndex = normalized.indexOf("/");
  if (separatorIndex <= 0) return null;
  const provider = normalized.slice(0, separatorIndex).trim().toLowerCase();
  if (!isLocalProviderFamily(provider)) return null;
  const modelId = normalized.slice(separatorIndex + 1).trim();
  if (!modelId.length || modelId === "auto") return null;
  return { provider, modelId };
}

function toDynamicLocalDisplayName(provider: LocalProviderFamily, modelId: string): string {
  return `${modelId} (${LOCAL_PROVIDER_LABELS[provider]})`;
}

export function createDynamicLocalModelDescriptor(
  provider: LocalProviderFamily,
  modelId: string,
): ModelDescriptor {
  const normalizedModelId = modelId.trim();
  return {
    id: `${provider}/${normalizedModelId}`,
    shortId: normalizedModelId,
    displayName: toDynamicLocalDisplayName(provider, normalizedModelId),
    family: provider,
    authTypes: ["local"],
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    capabilities: { ...BASIC_CAPS },
    color: LOCAL_PROVIDER_COLORS[provider],
    sdkProvider: "@ai-sdk/openai-compatible",
    sdkModelId: normalizedModelId,
    aliases: [`${provider}:${normalizedModelId}`],
    isCliWrapped: false,
  };
}

export function getLocalProviderDefaultEndpoint(provider: LocalProviderFamily): string {
  return LOCAL_PROVIDER_ENDPOINTS[provider];
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

export function getModelById(id: string): ModelDescriptor | undefined {
  return byId.get(id) ?? (() => {
    const dynamic = parseDynamicLocalModelRef(id);
    return dynamic ? createDynamicLocalModelDescriptor(dynamic.provider, dynamic.modelId) : undefined;
  })();
}

export function getAvailableModels(
  detectedAuth: Array<{ type: AuthType; cli?: string; provider?: string }>,
): ModelDescriptor[] {
  const hasAuth = (matcher: (auth: { type: AuthType; cli?: string; provider?: string }) => boolean): boolean =>
    detectedAuth.some((auth) => matcher(auth));

  const FAMILY_TO_CLI: Partial<Record<ProviderFamily, string>> = {
    openai: "codex",
    anthropic: "claude",
    google: "gemini",
  };

  const hasMappedCli = (family: ProviderFamily): boolean => {
    const requiredCli = FAMILY_TO_CLI[family] ?? null;
    if (!requiredCli) return hasAuth((auth) => auth.type === "cli-subscription");
    return hasAuth(
      (auth) => auth.type === "cli-subscription" && (!auth.cli || auth.cli === requiredCli)
    );
  };

  const hasMappedLocal = (family: ProviderFamily): boolean => {
    const requiredProvider = family === "ollama" || family === "lmstudio" || family === "vllm"
      ? family
      : null;
    if (!requiredProvider) return hasAuth((auth) => auth.type === "local");
    return hasAuth(
      (auth) => auth.type === "local" && (!auth.provider || auth.provider === requiredProvider)
    );
  };

  const hasAuthForModel = (model: ModelDescriptor): boolean =>
    model.authTypes.some((authType) => {
      if (authType === "cli-subscription") return hasMappedCli(model.family);
      if (authType === "api-key") {
        return hasAuth(
          (auth) => auth.type === "api-key" && (!auth.provider || auth.provider === model.family)
        );
      }
      if (authType === "openrouter") return hasAuth((auth) => auth.type === "openrouter");
      if (authType === "local") return hasMappedLocal(model.family);
      if (authType === "oauth") return hasAuth((auth) => auth.type === "oauth");
      return false;
    });

  return MODEL_REGISTRY.filter((model) => !model.deprecated && hasAuthForModel(model));
}

export function resolveModelAlias(alias: string): ModelDescriptor | undefined {
  const normalized = alias.trim().toLowerCase();
  return byId.get(normalized) ?? byShortId.get(normalized) ?? byAlias.get(normalized) ?? undefined;
}

export function resolveModelDescriptor(modelRef: string): ModelDescriptor | undefined {
  const normalized = modelRef.trim();
  if (!normalized.length) return undefined;
  return getModelById(normalized) ?? resolveModelAlias(normalized);
}

export function resolveCliProviderForModel(
  descriptor: ModelDescriptor,
): "claude" | "codex" | null {
  if (!descriptor.isCliWrapped) return null;
  if (descriptor.family === "anthropic") return "claude";
  if (descriptor.family === "openai") return "codex";
  return null;
}

export function classifyWorkerExecutionPath(
  descriptor: ModelDescriptor,
): WorkerExecutionPath {
  if (resolveCliProviderForModel(descriptor)) return "cli";
  if (descriptor.authTypes.includes("local")) return "local";
  return "api";
}

function listProviderModelsInternal(provider: ModelProviderGroup): ModelDescriptor[] {
  return MODEL_REGISTRY.filter((descriptor) => {
    if (descriptor.deprecated) return false;
    if (provider === "claude") return descriptor.isCliWrapped && descriptor.family === "anthropic";
    if (provider === "codex") return descriptor.isCliWrapped && descriptor.family === "openai";
    return !descriptor.isCliWrapped;
  });
}

function parseVersionSegments(value: string): number[] {
  const match = value.match(/gpt-(\d+(?:\.\d+)*)-codex$/i);
  if (!match?.[1]) return [];
  return match[1]
    .split(".")
    .map((part) => Number(part))
    .filter((part) => Number.isFinite(part));
}

function compareVersionSegmentsDesc(left: number[], right: number[]): number {
  const maxLength = Math.max(left.length, right.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    if (leftValue !== rightValue) return rightValue - leftValue;
  }
  return 0;
}

function pickPreferredModel(
  models: ModelDescriptor[],
  predicates: Array<(model: ModelDescriptor) => boolean>,
): ModelDescriptor | undefined {
  for (const predicate of predicates) {
    const match = models.find(predicate);
    if (match) return match;
  }
  return models[0];
}

function pickDefaultClaudeModel(models: ModelDescriptor[]): ModelDescriptor | undefined {
  return pickPreferredModel(models, [
    (model) => /\bsonnet\b/i.test(model.displayName) || /\bsonnet\b/i.test(model.sdkModelId),
    (model) => /\bopus\b/i.test(model.displayName) || /\bopus\b/i.test(model.sdkModelId),
    (model) => /\bhaiku\b/i.test(model.displayName) || /\bhaiku\b/i.test(model.sdkModelId),
  ]);
}

function pickDefaultCodexModel(models: ModelDescriptor[]): ModelDescriptor | undefined {
  const standard = models
    .filter((model) => /gpt-\d+(?:\.\d+)*-codex$/i.test(model.sdkModelId))
    .sort((left, right) => {
      const versionCompare = compareVersionSegmentsDesc(
        parseVersionSegments(left.sdkModelId),
        parseVersionSegments(right.sdkModelId),
      );
      if (versionCompare !== 0) return versionCompare;
      return left.displayName.localeCompare(right.displayName);
    });
  if (standard[0]) return standard[0];
  return pickPreferredModel(models, [
    (model) => /codex-mini/i.test(model.sdkModelId),
    (model) => /spark/i.test(model.sdkModelId),
  ]);
}

function pickDefaultUnifiedModel(models: ModelDescriptor[]): ModelDescriptor | undefined {
  return pickPreferredModel(models, [
    (model) => model.family === "openai" && /\bgpt-5\.4\b/i.test(`${model.displayName} ${model.sdkModelId}`),
    (model) => model.id === "anthropic/claude-sonnet-4-6-api",
    (model) => model.family === "anthropic" && /\bsonnet\b/i.test(model.displayName),
    (model) => model.family === "anthropic",
    (model) => model.family === "openai",
  ]);
}

function pickDefaultModelForProvider(
  provider: ModelProviderGroup,
  models: ModelDescriptor[],
): ModelDescriptor | undefined {
  if (provider === "claude") return pickDefaultClaudeModel(models);
  if (provider === "codex") return pickDefaultCodexModel(models);
  return pickDefaultUnifiedModel(models);
}

export function getDefaultModelDescriptor(
  provider: ModelProviderGroup,
): ModelDescriptor | undefined {
  return pickDefaultModelForProvider(provider, listProviderModelsInternal(provider));
}

export function listModelDescriptorsForProvider(
  provider: ModelProviderGroup,
): ModelDescriptor[] {
  const models = listProviderModelsInternal(provider);
  const preferred = pickDefaultModelForProvider(provider, models);
  if (!preferred) return models;
  return [preferred, ...models.filter((model) => model.id !== preferred.id)];
}

// ---------------------------------------------------------------------------
// Runtime enrichment — mutate existing entries in-place with fresh data
// ---------------------------------------------------------------------------

export type ModelEnrichment = {
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: Partial<ModelCapabilities>;
};

/**
 * Enrich existing registry entries in-place with fresh data (e.g. from models.dev).
 * Only updates fields that are provided and truthy.
 */
export function enrichModelRegistry(enrichments: Map<string, ModelEnrichment>): number {
  let updated = 0;
  for (const descriptor of MODEL_REGISTRY) {
    const enrichment = enrichments.get(descriptor.sdkModelId);
    if (!enrichment) continue;

    if (enrichment.contextWindow && enrichment.contextWindow > 0) {
      descriptor.contextWindow = enrichment.contextWindow;
    }
    if (enrichment.maxOutputTokens && enrichment.maxOutputTokens > 0) {
      descriptor.maxOutputTokens = enrichment.maxOutputTokens;
    }
    if (enrichment.capabilities) {
      Object.assign(descriptor.capabilities, enrichment.capabilities);
    }
    updated++;
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Pricing helpers
// ---------------------------------------------------------------------------

/**
 * Get pricing for a model by its sdkModelId (e.g. "claude-sonnet-4-6").
 * Returns per-million-token pricing. Checks dynamic overrides first,
 * then falls back to the static pricing in MODEL_REGISTRY.
 */
export function getModelPricing(sdkModelId: string): { input: number; output: number } | undefined {
  const override = _dynamicPricingOverrides[sdkModelId];
  if (override) return override;
  const model = bySdkModelId.get(sdkModelId);
  if (model?.inputPricePer1M != null && model?.outputPricePer1M != null) {
    return { input: model.inputPricePer1M, output: model.outputPricePer1M };
  }
  return undefined;
}

/** Dynamic pricing overrides — merged from models.dev at runtime */
const _dynamicPricingOverrides: Record<string, { input: number; output: number }> = {};

/**
 * Merge dynamic pricing updates (e.g. from models.dev) into the pricing system.
 * Returns the number of entries updated.
 */
export function updateModelPricingInRegistry(updates: Record<string, { input: number; output: number }>): number {
  let count = 0;
  for (const [modelId, pricing] of Object.entries(updates)) {
    if (pricing.input >= 0 && pricing.output >= 0) {
      _dynamicPricingOverrides[modelId] = pricing;
      count++;
    }
  }
  return count;
}
