/*
 * Plain-text helpers shared by the CTO's notes (`ctoMemoryService`) and its
 * rules and learning journal (`ctoLearningService`): what a note line is, and
 * when two lines say the same thing.
 */

export const CTO_MEMORY_TAG_KEYS = ["lane", "pr", "path", "topic"] as const;
export type CtoMemoryTagKey = (typeof CTO_MEMORY_TAG_KEYS)[number];
export type CtoMemoryTags = Partial<Record<CtoMemoryTagKey, string | number | null>>;

export const TAG_SUFFIX_PATTERN = new RegExp(
  `\\[((?:${CTO_MEMORY_TAG_KEYS.join("|")}):[^\\]\\s]+(?:\\s+(?:${CTO_MEMORY_TAG_KEYS.join("|")}):[^\\]\\s]+)*)\\]\\s*$`,
);

/* ── Near-duplicate check ── */

const SIMILARITY_STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "were", "with", "that", "this", "from", "into", "its", "has", "have",
]);
const NEGATION_WORDS = new Set(["not", "no", "never", "don't", "dont", "doesn't", "isn't", "can't", "cannot", "won't", "avoid", "without", "stop"]);

function isNegated(text: string): boolean {
  return text.replace(/[‘’ʼ]/g, "'").toLowerCase().split(/[^a-z']+/).some((word) => NEGATION_WORDS.has(word));
}

function similarityTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const part of text.replace(TAG_SUFFIX_PATTERN, "").toLowerCase().split(/[^a-z0-9]+/)) {
    // Numbers count however short: "Node 22" and "Node 20" are different notes.
    const numeric = /\d/.test(part);
    if (!part || (!numeric && (part.length < 3 || SIMILARITY_STOPWORDS.has(part)))) continue;
    terms.add(part);
  }
  return terms;
}

/**
 * Overlap of two notes' content words, 0..1 (Dice). A negated note and a plain
 * one are opposites however many words they share: "Use pnpm" / "Do not use pnpm".
 */
export function noteSimilarity(a: string, b: string): number {
  if (isNegated(a) !== isNegated(b)) return 0;
  const left = similarityTerms(a);
  const right = similarityTerms(b);
  if (!left.size || !right.size) return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0;
  let shared = 0;
  for (const term of left) if (right.has(term)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

/** The note lines of a notes file, without their bullets. Headings and blanks are not notes. */
export function parseNoteLines(content: string): string[] {
  return content.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.replace(/^(?:[-*•]\s+)+/, "").trim())
    .filter((line) => line.length > 0);
}
