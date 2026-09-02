import type { ProviderFamily } from "../../../desktop/src/shared/modelRegistry";
import { MODEL_PICKER_PROVIDER_ORDER } from "../../../desktop/src/shared/modelCatalog";
import type { AgentChatModelCatalogRefreshProvider } from "../../../desktop/src/shared/types/chat";
import type { AdeCodeProvider } from "./types";

const TUI_PROVIDER_LABELS: Record<AdeCodeProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  pi: "Pi",
  copilot: "GitHub Copilot",
  grok: "Grok",
  droid: "Droid",
  kimi: "Kimi",
  qwen: "Qwen",
  ollama: "Ollama",
  lmstudio: "LM Studio",
};

export const TUI_PROVIDER_OPTIONS: Array<{ value: AdeCodeProvider; label: string }> =
  MODEL_PICKER_PROVIDER_ORDER.map((value) => ({ value, label: TUI_PROVIDER_LABELS[value] }));

export const TUI_PROVIDERS = new Set<AdeCodeProvider>(TUI_PROVIDER_OPTIONS.map((provider) => provider.value));

const PROVIDER_FAMILY_LABELS: Record<AdeCodeProvider, string> = {
  codex: "OpenAI",
  claude: "Anthropic",
  opencode: "OpenCode",
  cursor: "Cursor",
  droid: "Droid",
  pi: "Pi",
  qwen: "Qwen",
  kimi: "Moonshot",
  grok: "xAI",
  copilot: "GitHub Copilot",
  ollama: "Ollama",
  lmstudio: "LM Studio",
};

export const PROVIDER_TOKEN_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  claude: "Anthropic",
  openai: "OpenAI",
  codex: "OpenAI",
  google: "Google",
  gemini: "Google",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  xai: "xAI",
  grok: "xAI",
  groq: "Groq",
  together: "Together",
  openrouter: "OpenRouter",
  opencode: "OpenCode",
  pi: "Pi",
  droid: "Droid",
  factory: "Droid",
  cursor: "Cursor",
  qwen: "Qwen",
  copilot: "GitHub Copilot",
  githubcopilot: "GitHub Copilot",
  github: "GitHub Copilot",
  kimi: "Kimi",
  moonshot: "Kimi",
  // Canonical opencode catalog ids for the Kimi/Moonshot brand. Keys are the
  // normalizeProviderToken() form (lowercased, non-alphanumerics stripped), so
  // "kimi-for-coding" resolves as "kimiforcoding".
  moonshotai: "Kimi",
  kimiforcoding: "Kimi",
  ollama: "Ollama",
  lmstudio: "LM Studio",
};

export function providerLabel(provider: AdeCodeProvider): string {
  return TUI_PROVIDER_OPTIONS.find((entry) => entry.value === provider)?.label ?? provider;
}

export function providerFamilyLabel(provider: AdeCodeProvider): string {
  return PROVIDER_FAMILY_LABELS[provider] ?? provider;
}

/**
 * `ProviderFamily` values that name a brand rather than an ADE provider, and
 * the TUI provider that hosts them. Only consulted when the caller has no
 * provider group (a bare model family), so an OpenCode-hosted model still
 * resolves through its group key first.
 */
const PROVIDER_FAMILY_ALIASES: Record<string, AdeCodeProvider> = {
  anthropic: "claude",
  openai: "codex",
  factory: "droid",
  moonshot: "kimi",
  moonshotai: "kimi",
  xai: "grok",
  "github-copilot": "copilot",
  githubcopilot: "copilot",
};

export function normalizeProvider(value: ProviderFamily | string | null | undefined): AdeCodeProvider {
  const normalized = (value ?? "").trim().toLowerCase();
  const alias = PROVIDER_FAMILY_ALIASES[normalized];
  if (alias) return alias;
  return TUI_PROVIDERS.has(normalized as AdeCodeProvider) ? normalized as AdeCodeProvider : "codex";
}

export function normalizeCatalogProvider(value: string | null | undefined): AdeCodeProvider {
  return normalizeProvider(value);
}

export function normalizeProviderToken(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function titleCaseProviderName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const known = PROVIDER_TOKEN_LABELS[normalizeProviderToken(trimmed)];
  if (known) return known;
  return trimmed
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .replace(/\bAi\b/g, "AI");
}

/**
 * Providers whose model list is discovered at runtime, so /model can offer a
 * refresh. Exhaustive over `AdeCodeProvider`: a new provider is a compile error
 * here rather than a silently un-refreshable rail.
 */
const REFRESH_PROVIDERS: Record<AdeCodeProvider, AgentChatModelCatalogRefreshProvider | null> = {
  claude: null,
  codex: null,
  cursor: "cursor",
  droid: "droid",
  opencode: "opencode",
  pi: "pi",
  qwen: "qwen",
  kimi: "kimi",
  grok: "grok",
  copilot: "copilot",
  ollama: "ollama",
  lmstudio: "lmstudio",
};

export function refreshProviderForModelPicker(provider: AdeCodeProvider): AgentChatModelCatalogRefreshProvider | null {
  return REFRESH_PROVIDERS[provider] ?? null;
}
