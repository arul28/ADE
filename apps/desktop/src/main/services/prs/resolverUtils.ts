import type { AgentChatPermissionMode, PrAgentPermissionMode, PrComment } from "../../../shared/types";
import { isActionablePrIssueComment } from "../../../shared/prIssueResolution";
import { runGit } from "../git/git";

// ---------------------------------------------------------------------------
// Noisy comment detection — shared by issue inventory and issue resolver
// ---------------------------------------------------------------------------

export function isNoisyIssueComment(comment: PrComment): boolean {
  return !isActionablePrIssueComment(comment);
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
export function mapPermissionMode(mode: PrAgentPermissionMode | undefined): AgentChatPermissionMode {
  if (mode === "full_edit") return "full-auto";
  if (mode === "read_only") return "plan";
  if (mode === "guarded_edit") return "edit";
  if (
    mode === "default" ||
    mode === "plan" ||
    mode === "edit" ||
    mode === "full-auto" ||
    mode === "config-toml"
  ) {
    return mode;
  }
  return "edit";
}

export function mapPermissionModeForModelFamily(
  mode: PrAgentPermissionMode | undefined,
  family: string | undefined,
): AgentChatPermissionMode {
  if (family === "openai" && mode === "guarded_edit") return "default";
  return mapPermissionMode(mode);
}

// ---------------------------------------------------------------------------
// Admin-merge gate detection — shared by the manual merge path (`prService`).
// A branch-protection / base-branch-policy block on an otherwise-ready PR is
// the only thing `gh pr merge --admin` is allowed to bypass.
// ---------------------------------------------------------------------------

function looksLikeBranchPolicyBlock(error: string): boolean {
  return /base branch policy|branch protection|protected branch|required status|required check|required review|review is required|review required|code owner|codeowner/i.test(error);
}

export function shouldAttemptAdminMergeForRestError(
  error: string,
  opts: { allowForceMerge?: boolean; ignoreReview?: boolean } = {},
): boolean {
  if (!looksLikeBranchPolicyBlock(error)) return false;
  if (opts.allowForceMerge) return true;
  return !opts.ignoreReview;
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
