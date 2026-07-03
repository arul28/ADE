import type { ProviderFamily } from "../../../desktop/src/shared/modelRegistry";
import type { AgentChatModelCatalogRefreshProvider } from "../../../desktop/src/shared/types/chat";
import type { AdeCodeProvider } from "./types";

export const TUI_PROVIDER_OPTIONS: Array<{ value: AdeCodeProvider; label: string }> = [
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "cursor", label: "Cursor" },
  { value: "droid", label: "Droid" },
  { value: "opencode", label: "OpenCode" },
  { value: "ollama", label: "Ollama" },
  { value: "lmstudio", label: "LM Studio" },
];

export const TUI_PROVIDERS = new Set<AdeCodeProvider>(TUI_PROVIDER_OPTIONS.map((provider) => provider.value));

const PROVIDER_FAMILY_LABELS: Record<AdeCodeProvider, string> = {
  codex: "OpenAI",
  claude: "Anthropic",
  opencode: "OpenCode",
  cursor: "Cursor",
  droid: "Droid",
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
  droid: "Droid",
  factory: "Droid",
  cursor: "Cursor",
  kimi: "Kimi",
  moonshot: "Kimi",
  ollama: "Ollama",
  lmstudio: "LM Studio",
};

export function providerLabel(provider: AdeCodeProvider): string {
  return TUI_PROVIDER_OPTIONS.find((entry) => entry.value === provider)?.label ?? provider;
}

export function providerFamilyLabel(provider: AdeCodeProvider): string {
  return PROVIDER_FAMILY_LABELS[provider] ?? provider;
}

export function normalizeProvider(value: ProviderFamily | string | null | undefined): AdeCodeProvider {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "anthropic") return "claude";
  if (normalized === "openai") return "codex";
  if (normalized === "factory") return "droid";
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

export function refreshProviderForModelPicker(provider: AdeCodeProvider): AgentChatModelCatalogRefreshProvider | null {
  return provider === "opencode" || provider === "cursor" || provider === "droid" || provider === "lmstudio" || provider === "ollama"
    ? provider
    : null;
}
