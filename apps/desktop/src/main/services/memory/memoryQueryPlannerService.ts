import type { MemoryCategory } from "./memoryService";

export type MemoryRetrievalClassification = "none" | "soft" | "required";

export type MemoryQueryPlan = {
  classification: MemoryRetrievalClassification;
  query: string;
  reasons: string[];
  projectLimit: number;
  agentLimit: number;
  injectionLimit: number;
  categories: MemoryCategory[];
};

export const AGENT_SEARCHABLE_MEMORY_CATEGORIES: ReadonlySet<MemoryCategory> = new Set([
  "fact",
  "preference",
  "pattern",
  "decision",
  "gotcha",
  "convention",
  "procedure",
]);

const DEFAULT_CATEGORIES: MemoryCategory[] = [
  "preference",
  "pattern",
  "decision",
  "gotcha",
  "convention",
  "procedure",
];

const REQUIRED_RE = /\b(?:fix|debug|investigat(?:e|ing|ion)|implement|refactor|patch|edit|write|add|remove|rename|update|change|test(?:s|ing)?|failing|error|exception|stack trace|crash|bug|diff|pull request|regression|build|compile|lint|typecheck)\b/i;
const REVIEW_ARCHITECTURE_RE = /\b(?:review|architecture|architectural|design|tradeoff|decision|pattern|convention|gotcha)\b/i;
const SOFT_RE = /\b(?:explain|why|how|walk through|summari[sz]e|context|overview|plan|brainstorm)\b/i;
const META_RE = /^(?:hi|hello|hey|thanks|thank you|ok(?:ay)?|cool|sounds good|nice|what model are you|who are you|are you there|can you help)\b/i;
const TEST_MESSAGE_RE = /^(?:this is\s+)?(?:just\s+)?(?:a\s+)?test message[.!?]*$|^(?:just\s+)?testing[.!?]*$/i;
const FILE_PATH_RE = /(?:^|\s)(?:\/|\.{1,2}\/|[A-Za-z]:\\|[A-Za-z0-9_.-]+\/)[^\s]+\.(?:ts|tsx|js|jsx|json|md|yml|yaml|py|go|rs|java|rb|sh|swift|m|mm|c|cc|cpp|h|hpp)\b/gi;
const INLINE_PATH_RE = /\b[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.(?:ts|tsx|js|jsx|json|md|yml|yaml|py|go|rs|java|rb|sh|swift|m|mm|c|cc|cpp|h|hpp)\b/gi;

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "before",
  "being",
  "could",
  "current",
  "doing",
  "done",
  "from",
  "have",
  "into",
  "just",
  "like",
  "make",
  "need",
  "please",
  "really",
  "should",
  "that",
  "their",
  "there",
  "these",
  "thing",
  "this",
  "those",
  "through",
  "update",
  "using",
  "want",
  "what",
  "when",
  "where",
  "with",
  "work",
  "would",
  "your",
]);

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function uniquePush(values: string[], seen: Set<string>, value: string): void {
  const normalized = value.trim().replace(/[.,;:!?)]$/g, "");
  if (!normalized.length) return;
  const key = normalized.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  values.push(normalized);
}

function extractPathTerms(text: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const pattern of [FILE_PATH_RE, INLINE_PATH_RE]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      uniquePush(terms, seen, String(match[0] ?? "").trim());
      if (terms.length >= 8) return terms;
    }
  }
  return terms;
}

function hasPathSignal(text: string): boolean {
  FILE_PATH_RE.lastIndex = 0;
  INLINE_PATH_RE.lastIndex = 0;
  const hasSignal = FILE_PATH_RE.test(text) || INLINE_PATH_RE.test(text);
  FILE_PATH_RE.lastIndex = 0;
  INLINE_PATH_RE.lastIndex = 0;
  return hasSignal;
}

function extractKeywordTerms(text: string): string[] {
  const normalized = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`"'()[\]{}<>]/g, " ")
    .toLowerCase();
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const token of normalized.split(/[^a-z0-9_.-]+/)) {
    const trimmed = token.trim();
    if (trimmed.length < 4) continue;
    if (/^\d+$/.test(trimmed)) continue;
    if (STOP_WORDS.has(trimmed)) continue;
    uniquePush(terms, seen, trimmed);
    if (terms.length >= 32) break;
  }
  return terms;
}

export function buildMemorySearchQuery(promptText: string): string {
  const trimmed = normalizeWhitespace(promptText);
  if (!trimmed.length) return "";

  const terms: string[] = [];
  const seen = new Set<string>();
  for (const term of extractPathTerms(trimmed)) uniquePush(terms, seen, term);
  for (const term of extractKeywordTerms(trimmed)) uniquePush(terms, seen, term);

  const query = terms.join(" ").slice(0, 300).trim();
  return query || trimmed.slice(0, 300).trim();
}

export function buildMemoryQueryPlan(args: {
  promptText: string;
  attachmentCount?: number;
}): MemoryQueryPlan {
  const promptText = args.promptText ?? "";
  const trimmed = promptText.trim();
  const attachmentCount = Math.max(0, Number(args.attachmentCount ?? 0));
  const reasons: string[] = [];

  let classification: MemoryRetrievalClassification = "none";
  if (trimmed.length < 12) {
    reasons.push("short_turn");
  } else if (trimmed.startsWith("/")) {
    reasons.push("slash_command");
  } else if (TEST_MESSAGE_RE.test(trimmed)) {
    reasons.push("test_message");
  } else if (/^before context compaction runs\b/i.test(trimmed)) {
    reasons.push("context_compaction");
  } else if (/^review this conversation and persist\b/i.test(trimmed)) {
    reasons.push("memory_persistence_request");
  } else if (attachmentCount > 0) {
    classification = "required";
    reasons.push("attachments");
  } else if (/```/.test(trimmed) || hasPathSignal(trimmed)) {
    classification = "required";
    reasons.push("code_or_file_scope");
  } else if (REQUIRED_RE.test(trimmed)) {
    classification = "required";
    reasons.push("mutating_or_debugging_work");
  } else if (REVIEW_ARCHITECTURE_RE.test(trimmed)) {
    classification = "required";
    reasons.push("review_or_architecture_decision");
  } else if (SOFT_RE.test(trimmed)) {
    classification = "soft";
    reasons.push("context_or_explanation");
  } else if (META_RE.test(trimmed) && trimmed.length <= 80) {
    reasons.push("casual_meta");
  } else {
    reasons.push("no_memory_signal");
  }

  const query = classification === "none"
    ? ""
    : buildMemorySearchQuery(trimmed) || (attachmentCount > 0 ? "attached files task context" : "");

  return {
    classification,
    query,
    reasons,
    projectLimit: classification === "required" ? 12 : 8,
    agentLimit: classification === "required" ? 6 : 4,
    injectionLimit: classification === "required" ? 4 : 3,
    categories: DEFAULT_CATEGORIES,
  };
}
