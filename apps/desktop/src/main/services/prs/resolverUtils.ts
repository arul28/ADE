import type { AgentChatPermissionMode, AiPermissionMode, PrComment } from "../../../shared/types";
import { runGit } from "../git/git";

// ---------------------------------------------------------------------------
// Noisy comment detection — shared by issue inventory and issue resolver
// ---------------------------------------------------------------------------

const NOISY_BOT_AUTHORS = new Set(["vercel", "vercel[bot]", "mintlify", "mintlify[bot]"]);

const NOISY_BODY_PATTERNS = [
  /\[vc\]:/i,
  /mintlify-preview/i,
  /this is an auto-generated comment/i,
  /pre-merge checks/i,
  /thanks for using \[coderabbit\]/i,
  /<!-- internal state/i,
  /walkthrough/i,
  /@codex review/i,
  /^@(copilot|coderabbitai|greptile|codex)\s+review\b/i,
  /\bship-lane handoff\b/i,
  /\bclear-to-merge\b/i,
  /\bci green\b/i,
];

export function isNoisyIssueComment(comment: PrComment): boolean {
  const author = comment.author.trim().toLowerCase();
  const body = (comment.body ?? "").trim();
  if (!body) return true;
  if (NOISY_BOT_AUTHORS.has(author)) return true;
  return NOISY_BODY_PATTERNS.some((pattern) => pattern.test(body));
}

const RESOLUTION_NEGATION_PATTERNS = [
  /\bnot\s+(fixed|addressed|resolved|done|handled)\b/i,
  /\b(still|isn'?t|is not|not yet)\s+(an issue|fixed|addressed|resolved|done|handled|working)\b/i,
  /\b(no|doesn'?t|does not|won'?t|can'?t|cannot|hasn'?t|haven'?t)\s+(fix|address|resolve|handle|be\s+(fixed|addressed|resolved|done|handled))\b/i,
  /\b(will|to\s+be)\s+(fixed|addressed|resolved|done|handled)\s+(in|by)\b/i,
  /\bstill\s+(broken|failing|an\s+issue)\b/i,
];

// ACK patterns are intentionally narrow: they must look like an actual
// acknowledgement rather than any mention of the verbs "fixed/resolved/done".
// `looksLikeResolutionAck` auto-flips issue inventory items to `"fixed"`, so
// false positives silently drop live review threads from the convergence loop.
const RESOLUTION_ACK_PATTERNS = [
  // Terse standalone acks: "fixed.", "done!", "resolved"
  /^\s*(fixed|addressed|resolved|done|handled)[.! ]*$/i,
  // First-person / subject acks: "I fixed", "we addressed", "this is fixed"
  /\b(i|we|i've|we've|this\s+(is|was)|that\s+(is|was)|it\s+(is|was))\s+(now\s+)?(fixed|addressed|resolved|done|handled)\b/i,
  // Commit/PR-reference acks: "Fixed in commit abc", "addressed in #123",
  // "resolved in the latest push". Scoped to concrete references to avoid
  // matching deferrals like "addressed in a follow-up PR".
  /^\s*(fixed|addressed|resolved|handled)\s+(in|by)\s+(the\s+latest|commit\b|#\d+|[0-9a-f]{7,40}\b|pr\s*#?\d+|my\s+(latest|most\s+recent))/i,
  /\bshould be (good|fixed|resolved)\b/i,
  /\bno longer (an issue|applies|reproduces)\b/i,
  /\bthanks[,! ]+(fixed|addressed|resolved)\b/i,
  /\bclear-to-merge\b/i,
  /\bci green\b/i,
];

export function looksLikeResolutionAck(body: string | null | undefined): boolean {
  const text = (body ?? "").trim();
  if (!text) return false;
  if (RESOLUTION_NEGATION_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return RESOLUTION_ACK_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Map ADE's permission mode to the agent chat permission mode.
 * Shared by both the issue resolver and rebase resolver.
 */
export function mapPermissionMode(mode: AiPermissionMode | undefined): AgentChatPermissionMode {
  if (mode === "full_edit") return "full-auto";
  if (mode === "read_only") return "plan";
  return "edit";
}

export function mapPermissionModeForModelFamily(
  mode: AiPermissionMode | undefined,
  family: string | undefined,
): AgentChatPermissionMode {
  if (family === "openai" && mode === "guarded_edit") return "default";
  return mapPermissionMode(mode);
}

/**
 * Read the most recent N commits from a worktree as {sha, subject} pairs.
 * Shared by both the issue resolver and rebase resolver.
 */
export async function readRecentCommits(
  worktreePath: string,
  count = 8,
  ref = "HEAD",
): Promise<Array<{ sha: string; subject: string }>> {
  const result = await runGit(
    ["log", "--format=%H%x09%s", "-n", String(count), ref],
    { cwd: worktreePath, timeoutMs: 10_000 },
  );
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, ...subjectParts] = line.split("\t");
      return { sha: (sha ?? "").trim(), subject: subjectParts.join("\t").trim() };
    })
    .filter((entry) => entry.sha.length > 0 && entry.subject.length > 0);
}
