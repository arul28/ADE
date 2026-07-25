export type ClaudeCliModelAlias =
  | "claude-fable-5"
  | "claude-opus-5"
  | "claude-opus-4-8"
  | "claude-sonnet-5"
  | "claude-haiku-4-5"
  | "claude-opus-4-7[1m]";

export const CLAUDE_CLI_MODEL_ALIAS_MAP: Readonly<Record<string, ClaudeCliModelAlias>> = {
  fable: "claude-fable-5",
  "claude-fable-5": "claude-fable-5",
  "anthropic/claude-fable-5": "claude-fable-5",
  "anthropic/claude-fable-5-api": "claude-fable-5",
  opus: "claude-opus-5",
  "opus-5": "claude-opus-5",
  "opus-5.0": "claude-opus-5",
  "opus-5-0": "claude-opus-5",
  "claude-opus-5": "claude-opus-5",
  "anthropic/claude-opus-5": "claude-opus-5",
  "anthropic/claude-opus-5-api": "claude-opus-5",
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
  "opus-4-7": "claude-opus-4-8",
  "claude-opus-4-7": "claude-opus-4-8",
  "anthropic/claude-opus-4-7": "claude-opus-4-8",
  "anthropic/claude-opus-4-7-api": "claude-opus-4-8",
  "opus[1m]": "claude-opus-4-7[1m]",
  "opus-1m": "claude-opus-4-7[1m]",
  "opus-4-7-1m": "claude-opus-4-7[1m]",
  "claude-opus-4-7[1m]": "claude-opus-4-7[1m]",
  "claude-opus-4-7-1m": "claude-opus-4-7[1m]",
  "anthropic/claude-opus-4-7-1m": "claude-opus-4-7[1m]",
  sonnet: "claude-sonnet-5",
  "sonnet-5": "claude-sonnet-5",
  "claude-sonnet-5": "claude-sonnet-5",
  "anthropic/claude-sonnet-5": "claude-sonnet-5",
  "anthropic/claude-sonnet-5-api": "claude-sonnet-5",
  "sonnet-4-6": "claude-sonnet-5",
  "sonnet-4-5": "claude-sonnet-5",
  "claude-sonnet-4-6": "claude-sonnet-5",
  "claude-sonnet-4-5": "claude-sonnet-5",
  "claude-sonnet-4-5-20241022": "claude-sonnet-5",
  "anthropic/claude-sonnet-4-6": "claude-sonnet-5",
  "anthropic/claude-sonnet-4-6-api": "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
  "haiku-4-5": "claude-haiku-4-5",
  "claude-haiku-4-5": "claude-haiku-4-5",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5",
  "anthropic/claude-haiku-4-5": "claude-haiku-4-5",
  "anthropic/claude-haiku-4-5-api": "claude-haiku-4-5",
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
    return /4[-.]8/.test(normalized) ? "claude-opus-4-8" : "claude-opus-4-7[1m]";
  }
  if (normalized.includes("fable")) return "claude-fable-5";
  if (normalized.includes("sonnet")) return "claude-sonnet-5";
  if (normalized.includes("opus-5") || normalized.includes("opus 5")) return "claude-opus-5";
  if (normalized.includes("opus")) return "claude-opus-4-8";
  if (normalized.includes("haiku")) return "claude-haiku-4-5";

  // Preserve custom IDs for forward compatibility.
  return raw;
}
