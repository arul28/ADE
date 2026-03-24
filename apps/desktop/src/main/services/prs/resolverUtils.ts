import type { AgentChatPermissionMode, AiPermissionMode } from "../../../shared/types";
import { runGit } from "../git/git";

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
): Promise<Array<{ sha: string; subject: string }>> {
  const result = await runGit(
    ["log", "--format=%H%x09%s", "-n", String(count)],
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
