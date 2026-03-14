import { getDefaultModelDescriptor, getModelById, resolveModelAlias } from "../../../shared/modelRegistry";

export type ClaudeCliModelAlias = "opus" | "sonnet" | "haiku";

const CLAUDE_CLI_MODEL_ALIAS_MAP: Record<string, ClaudeCliModelAlias> = {
  opus: "opus",
  "opus-4-6": "opus",
  "claude-opus-4-6": "opus",
  "anthropic/claude-opus-4-6": "opus",
  "anthropic/claude-opus-4-6-api": "opus",
  sonnet: "sonnet",
  "sonnet-4-6": "sonnet",
  "sonnet-4-5": "sonnet",
  "claude-sonnet-4-6": "sonnet",
  "claude-sonnet-4-5": "sonnet",
  "claude-sonnet-4-5-20241022": "sonnet",
  "anthropic/claude-sonnet-4-6": "sonnet",
  "anthropic/claude-sonnet-4-6-api": "sonnet",
  haiku: "haiku",
  "haiku-4-5": "haiku",
  "claude-haiku-4-5": "haiku",
  "claude-haiku-4-5-20251001": "haiku",
  "anthropic/claude-haiku-4-5": "haiku",
  "anthropic/claude-haiku-4-5-api": "haiku",
};

/**
 * Normalize arbitrary Claude model strings into the CLI-safe aliases expected
 * by Claude Code (`opus`, `sonnet`, `haiku`) where possible.
 */
export function resolveClaudeCliModel(model: string | null | undefined): string {
  const raw = String(model ?? "").trim();
  const normalized = raw.toLowerCase();
  if (!normalized.length) return "sonnet";

  const mapped = CLAUDE_CLI_MODEL_ALIAS_MAP[normalized];
  if (mapped) return mapped;

  if (normalized.includes("sonnet")) return "sonnet";
  if (normalized.includes("opus")) return "opus";
  if (normalized.includes("haiku")) return "haiku";

  // Preserve custom IDs for forward compatibility.
  return raw;
}

/**
 * Normalize model identifiers for Codex CLI invocation. Supports registry IDs,
 * short aliases, and "openai/<model>" prefixed strings.
 */
export function resolveCodexCliModel(model: string | null | undefined): string {
  const raw = String(model ?? "").trim();
  if (!raw.length) return getDefaultModelDescriptor("codex")?.sdkModelId ?? "gpt-5.4";

  const descriptor = getModelById(raw) ?? resolveModelAlias(raw);
  if (descriptor?.isCliWrapped && descriptor.family === "openai") {
    return descriptor.sdkModelId;
  }

  const lower = raw.toLowerCase();
  if (lower.startsWith("openai/")) {
    const sdk = raw.slice("openai/".length).trim();
    if (sdk.length) return sdk;
  }

  return raw;
}
