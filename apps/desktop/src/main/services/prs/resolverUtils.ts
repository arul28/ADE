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
];

export function isNoisyIssueComment(comment: PrComment): boolean {
  const author = comment.author.trim().toLowerCase();
  const body = (comment.body ?? "").trim();
  if (!body) return true;
  if (NOISY_BOT_AUTHORS.has(author)) return true;
  return NOISY_BODY_PATTERNS.some((pattern) => pattern.test(body));
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
