/**
 * Pure helpers for the lane story: commit trailer parsing and the head-watch
 * attribution chooser. Kept free of db/git/service imports so both hosts and
 * the tests can use them directly.
 */

export type TrailerIdentity = { provider: string | null; model: string | null };

/**
 * Map one `Co-Authored-By:` value onto a provider (and, when the trailer names
 * the model, a human-facing model label).
 *
 * The shapes ADE sees in the wild:
 *   `Claude Opus 5 <noreply@anthropic.com>`  → claude / "Opus 5"
 *   `Cursor Agent <cursoragent@cursor.com>`  → cursor
 *   `Codex <noreply@openai.com>` / ChatGPT   → codex
 *   `Droid <noreply@factory.ai>`             → droid
 */
export function parseCoAuthorTrailer(value: string): TrailerIdentity {
  const raw = value.trim();
  if (!raw) return { provider: null, model: null };
  const name = raw.replace(/<[^>]*>\s*$/, "").trim();
  const email = /<([^>]*)>/.exec(raw)?.[1]?.trim().toLowerCase() ?? "";
  const haystack = `${name} ${email}`.toLowerCase();

  if (/\bcursor\b/.test(haystack) || email.endsWith("@cursor.com")) {
    return { provider: "cursor", model: modelFromName(name, "cursor") };
  }
  if (/\bclaude\b/.test(haystack) || email.endsWith("@anthropic.com")) {
    return { provider: "claude", model: modelFromName(name, "claude") };
  }
  if (/\b(codex|chatgpt|openai)\b/.test(haystack) || email.endsWith("@openai.com")) {
    return { provider: "codex", model: modelFromName(name, "codex") };
  }
  if (/\b(droid|factory)\b/.test(haystack) || email.endsWith("@factory.ai")) {
    return { provider: "droid", model: modelFromName(name, "droid") };
  }
  if (/\bopencode\b/.test(haystack)) {
    return { provider: "opencode", model: modelFromName(name, "opencode") };
  }
  return { provider: null, model: null };
}

/**
 * `"Claude Opus 5"` → `"Opus 5"`. A bare vendor name carries no model, so it
 * yields null rather than an empty string the UI would have to special-case.
 */
function modelFromName(name: string, provider: string): string | null {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return null;
  const first = words[0]?.toLowerCase() ?? "";
  const rest = first.startsWith(provider) || provider.startsWith(first) ? words.slice(1) : words;
  const model = rest.join(" ").trim();
  return model.length > 0 ? model : null;
}

/** First recognizable provider across all of a commit's trailers. */
export function identityFromCoAuthors(coAuthors: readonly string[]): TrailerIdentity {
  for (const value of coAuthors) {
    const identity = parseCoAuthorTrailer(value);
    if (identity.provider) return identity;
  }
  return { provider: null, model: null };
}

export type HeadWatchCandidate = {
  chatSessionId: string;
  /** ISO timestamp of the session's most recent PTY output, when known. */
  lastOutputAt?: string | null;
};

/**
 * Pick which mid-flight chat session gets credit for an out-of-band commit.
 *
 * Exactly one candidate is unambiguous. Several means the lane is running a
 * fleet, and the honest guess is the one that was talking most recently. None
 * means the commit stays `unknown` — a wrong name is worse than no name.
 */
export function chooseHeadWatchSession(candidates: readonly HeadWatchCandidate[]): string | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!.chatSessionId;
  let best: HeadWatchCandidate | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const ms = candidate.lastOutputAt ? Date.parse(candidate.lastOutputAt) : Number.NaN;
    const score = Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
    if (best === null || score > bestMs) {
      best = candidate;
      bestMs = score;
    }
  }
  return best?.chatSessionId ?? null;
}
