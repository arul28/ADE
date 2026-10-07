const KNOWN_PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  claude: "Claude",
  codex: "Codex",
  copilot: "Copilot",
  cursor: "Cursor",
  "cursor-agent": "Cursor Agent",
  deepseek: "DeepSeek",
  droid: "Droid",
  gemini: "Gemini",
  google: "Google",
  lmstudio: "LM Studio",
  mistral: "Mistral",
  ollama: "Ollama",
  opencode: "OpenCode",
  openai: "OpenAI",
  openclaw: "OpenClaw",
  openrouter: "OpenRouter",
  xai: "xAI",
};

/** A provider id as a person would write it: "lmstudio" → "LM Studio". */
export function humanizeProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return (
    KNOWN_PROVIDER_NAMES[normalized]
    ?? provider
      .split(/[-_/\s]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}
