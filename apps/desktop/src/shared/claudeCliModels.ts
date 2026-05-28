export type ClaudeCliModelAlias = "opus" | "opus[1m]" | "claude-opus-4-8" | "sonnet" | "haiku";

export const CLAUDE_CLI_MODEL_ALIAS_MAP: Readonly<Record<string, ClaudeCliModelAlias>> = {
  opus: "opus",
  "opus-4.8": "claude-opus-4-8",
  "opus-4-8": "claude-opus-4-8",
  "opus-4.8-1m": "claude-opus-4-8",
  "opus-4.8[1m]": "claude-opus-4-8",
  "opus-4-8-1m": "claude-opus-4-8",
  "claude-opus-4-8": "claude-opus-4-8",
  "claude-opus-4-8-1m": "claude-opus-4-8",
  "claude-opus-4-8[1m]": "claude-opus-4-8",
  "anthropic/claude-opus-4-8": "claude-opus-4-8",
  "anthropic/claude-opus-4-8-1m": "claude-opus-4-8",
  "anthropic/claude-opus-4-8-api": "claude-opus-4-8",
  "opus-4-7": "opus",
  "claude-opus-4-7": "opus",
  "anthropic/claude-opus-4-7": "opus",
  "anthropic/claude-opus-4-7-api": "opus",
  "opus[1m]": "opus[1m]",
  "opus-1m": "opus[1m]",
  "opus-4-7-1m": "opus[1m]",
  "claude-opus-4-7[1m]": "opus[1m]",
  "claude-opus-4-7-1m": "opus[1m]",
  "anthropic/claude-opus-4-7-1m": "opus[1m]",
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

export function resolveClaudeCliModelAlias(
  model: string | null | undefined,
  emptyFallback: string | null,
): string | null {
  const raw = String(model ?? "").trim();
  const normalized = raw.toLowerCase();
  if (!normalized.length) return emptyFallback;

  const mapped = CLAUDE_CLI_MODEL_ALIAS_MAP[normalized];
  if (mapped) return mapped;

  const hasOpus1mToken =
    normalized.includes("[1m]") || /(^|[^0-9])1m($|[^0-9])/.test(normalized);
  if (normalized.includes("opus") && hasOpus1mToken) {
    return /4[-.]8/.test(normalized) ? "claude-opus-4-8" : "opus[1m]";
  }
  if (normalized.includes("sonnet")) return "sonnet";
  if (normalized.includes("opus")) return "opus";
  if (normalized.includes("haiku")) return "haiku";

  // Preserve custom IDs for forward compatibility.
  return raw;
}
