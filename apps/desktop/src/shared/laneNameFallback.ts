export const GENERIC_LANE_FALLBACK_NAME = "parallel-task";

export const LANE_FALLBACK_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "can",
  "could",
  "for",
  "from",
  "have",
  "help",
  "how",
  "i",
  "in",
  "into",
  "is",
  "it",
  "just",
  "let",
  "make",
  "me",
  "my",
  "of",
  "on",
  "please",
  "pls",
  "the",
  "this",
  "to",
  "use",
  "we",
  "with",
  "you",
]);

function normalizeGenericSuffix(raw: string | null | undefined): string | null {
  const normalized = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24)
    .replace(/^-|-$/g, "");
  return normalized.length ? normalized : null;
}

export function genericLaneFallbackName(genericSuffix?: string | null): string {
  const suffix = normalizeGenericSuffix(genericSuffix);
  return suffix ? `${GENERIC_LANE_FALLBACK_NAME}-${suffix}` : GENERIC_LANE_FALLBACK_NAME;
}

export function deriveDeterministicLaneNameFromPrompt(
  prompt: string,
  options: { genericSuffix?: string | null } = {},
): string {
  const collapsed = prompt
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\b(?:please|pls|can you|could you|help me|i need(?: you)? to|let'?s|we need to)\b/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed.length) return genericLaneFallbackName(options.genericSuffix);
  const tokens = collapsed.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const meaningfulWords = tokens
    .filter((token) => token.length > 1 && !LANE_FALLBACK_STOPWORDS.has(token))
    .slice(0, 5);
  const fallbackWords = tokens
    .filter((token) => token.length > 1)
    .slice(0, 4);
  const words = meaningfulWords.length ? meaningfulWords : fallbackWords;
  const slug = words
    .join("-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.length ? slug.slice(0, 48) : genericLaneFallbackName(options.genericSuffix);
}

export function genericSuffixFromLaneFallbackName(fallbackName: string | null | undefined): string | null {
  const normalized = normalizeGenericSuffix(fallbackName);
  if (!normalized) return null;
  if (normalized.startsWith(`${GENERIC_LANE_FALLBACK_NAME}-`)) {
    return normalized.slice(GENERIC_LANE_FALLBACK_NAME.length + 1) || null;
  }
  const chatMatch = normalized.match(/^chat-(\d{8}-\d{6}(?:-[a-z0-9]+)?)/u);
  return chatMatch?.[1] ?? null;
}
