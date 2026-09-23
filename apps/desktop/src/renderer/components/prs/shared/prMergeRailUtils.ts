import type {
  MergeMethod,
  PrCommit,
  PrStatus,
  PrWithConflicts,
} from "../../../../shared/types/prs";

/** The merge method the user picked last. The key is shared by every merge surface. */
export const LAST_MERGE_METHOD_KEY = "ade:prs:lastMergeMethod";

export function readLastMergeMethod(fallback: MergeMethod): MergeMethod {
  try {
    const raw = window.localStorage.getItem(LAST_MERGE_METHOD_KEY);
    if (raw === "squash" || raw === "merge" || raw === "rebase") return raw;
  } catch {
    // Storage can be unavailable; the fallback is fine.
  }
  return fallback;
}

export function writeLastMergeMethod(method: MergeMethod): void {
  try {
    window.localStorage.setItem(LAST_MERGE_METHOD_KEY, method);
  } catch {
    // Storage can be unavailable; the choice is then not remembered.
  }
}

export function mergeMethodLabel(method: MergeMethod): string {
  switch (method) {
    case "squash":
      return "Squash and merge";
    case "rebase":
      return "Rebase and merge";
    default:
      return "Create merge commit";
  }
}

export function mergeMethodShortLabel(method: MergeMethod): string {
  switch (method) {
    case "squash":
      return "Squash";
    case "rebase":
      return "Rebase";
    default:
      return "Merge";
  }
}

export function buildMergeCommandLineInstructions(args: {
  repoOwner: string;
  repoName: string;
  prNumber: number;
  method: MergeMethod;
  bypassRules?: boolean;
}): string {
  const methodFlag = `--${args.method}`;
  const adminFlag = args.bypassRules ? " --admin" : "";
  return `gh pr merge ${args.prNumber} ${methodFlag}${adminFlag} --repo ${args.repoOwner}/${args.repoName}`;
}

export function canAttemptMerge(args: {
  pr: PrWithConflicts;
  status: PrStatus | null;
  bypassRules: boolean;
}): boolean {
  const { pr, status, bypassRules } = args;
  if (pr.state !== "open") return false;
  const mergeState = status?.mergeStateStatus;
  // Prefer GitHub's merge-box state when the runtime reports it.
  if (mergeState) {
    if (mergeState === "dirty" || mergeState === "draft") return false;
    if (status?.mergeConflicts) return false;
    // Admin bypass can land anything that isn't conflicted/draft, as long as we
    // have a status snapshot to merge against.
    if (bypassRules) return Boolean(status);
    return mergeState === "clean" || mergeState === "has_hooks" || mergeState === "unstable";
  }
  // Fallback to the legacy boolean when mergeStateStatus is absent.
  if (status?.mergeConflicts) return false;
  if (bypassRules) return Boolean(status);
  return Boolean(status?.isMergeable);
}

/**
 * Builds GitHub-fidelity default merge commit messages for the dialog editor.
 * - `squash` → title `"<prTitle> (#<n>)"`, body = each commit subject/message.
 * - `merge`  → title `"Merge pull request #<n> from <owner>/<head>"`, body = PR title.
 * - `rebase` → empty (no commit message editor).
 */
export function buildDefaultCommitMessage(args: {
  method: MergeMethod;
  prTitle: string;
  prNumber: number;
  headBranch: string;
  baseBranch: string;
  repoOwner: string;
  commits: PrCommit[];
}): { title: string; body: string } {
  const { method, prTitle, prNumber, headBranch, repoOwner, commits } = args;
  if (method === "rebase") {
    return { title: "", body: "" };
  }
  if (method === "merge") {
    return {
      title: `Merge pull request #${prNumber} from ${repoOwner}/${headBranch}`,
      body: prTitle,
    };
  }
  // squash: concatenate the commit subjects/messages like GitHub does.
  const body = commits
    .map((commit) => {
      const message = (commit.message ?? "").trim();
      // GitHub bullets each commit's full message; collapse trailing blank lines.
      return message ? `* ${message.replace(/\n{3,}/g, "\n\n")}` : null;
    })
    .filter((line): line is string => Boolean(line))
    .join("\n\n");
  return {
    title: `${prTitle} (#${prNumber})`,
    body,
  };
}
