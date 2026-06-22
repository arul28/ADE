export const GENERIC_LANE_FALLBACK_NAME = "parallel-task";

export const LANE_FALLBACK_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
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

// Top-level domains we strip when turning a URL or bare domain into name tokens,
// so "github.com" contributes "github" rather than "github com".
const NAMING_TLDS = new Set([
  "com", "org", "io", "net", "dev", "app", "co", "ai", "gov", "edu", "sh", "xyz", "me",
]);

// Filler phrases that add no signal to a name. Politeness lead-ins plus the
// "take a look at …" family that produced names like "take-look-at-https-github".
const NAMING_FILLER_RE =
  /\b(?:please|pls|kindly|can you|could you|would you|will you|help me|i need(?: you)? to|i want(?: you)? to|i'?d like(?: you)? to|let'?s|lets|we need to|take a look at|have a look at|take a look|look at|look into|check out|go over|show me|give me|tell me about)\b/giu;

// A bare domain like "github.com" (no scheme) — keep the significant label, drop the
// TLD. Built from NAMING_TLDS so the two never drift.
const NAMING_BARE_DOMAIN_RE = new RegExp(
  `\\b([a-z0-9][a-z0-9-]*)\\.(?:${[...NAMING_TLDS].join("|")})\\b`,
  "giu",
);

// A full URL with a scheme. Replaced by tokensFromUrl so the host/path contribute words.
const NAMING_URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/giu;

function tokensFromUrl(url: string): string {
  const withoutScheme = url.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, "");
  const segments = withoutScheme.split(/[/?#&=]+/u).filter(Boolean);
  if (!segments.length) return "";
  const [host, ...rest] = segments;
  const hostLabels = host
    .split(".")
    .filter((label) => label.length > 0 && label.toLowerCase() !== "www" && !NAMING_TLDS.has(label.toLowerCase()));
  // Drop overly long opaque path segments (hashes, query blobs) that make poor name words.
  const pathLabels = rest.filter((segment) => segment.length > 0 && segment.length <= 24);
  return [...hostLabels, ...pathLabels].join(" ");
}

/**
 * Strip the noise that makes deterministic names ugly — fenced/inline code, URLs
 * (kept as host/path tokens), bare domains, and filler phrases — while preserving the
 * original casing so this can feed both a lowercase lane slug and a readable session title.
 */
export function cleanPromptForNaming(prompt: string): string {
  return String(prompt ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(NAMING_URL_RE, (match) => ` ${tokensFromUrl(match)} `)
    .replace(NAMING_BARE_DOMAIN_RE, " $1 ")
    .replace(NAMING_FILLER_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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
  const collapsed = cleanPromptForNaming(prompt);
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
