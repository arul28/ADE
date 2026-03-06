/** Strip refs/heads/ and origin/ prefixes to get a clean branch name. */
export function normalizeBranchName(ref: string): string {
  const trimmed = ref.trim();
  const branch = trimmed.startsWith("refs/heads/") ? trimmed.slice("refs/heads/".length) : trimmed;
  return branch.startsWith("origin/") ? branch.slice("origin/".length) : branch;
}

export type BackgroundResolverSession = {
  ptyId: string;
  sessionId: string;
  provider: "codex" | "claude";
  startedAt: string;
  exitCode: number | null;
};
