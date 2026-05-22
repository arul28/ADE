import type { GitCommitSummary } from "../../../shared/types";

export type HistoryGitActionId =
  | "checkout"
  | "cherry_pick"
  | "revert"
  | "copy_sha"
  | "copy_subject"
  | "open_lane_git"
  | "compare_parent"
  | "view_files";

export type HistoryGitAction = {
  id: HistoryGitActionId;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  disabledReason?: string;
};

export function buildCommitContextActions(args: {
  commit: GitCommitSummary;
  isHead: boolean;
  hasWorktree: boolean;
}): HistoryGitAction[] {
  const { commit, isHead, hasWorktree } = args;
  const baseDisabled = !hasWorktree;
  const baseReason = baseDisabled ? "Lane worktree is missing" : undefined;

  return [
    {
      id: "checkout",
      label: "Inspect on lane (git pane)",
      disabled: baseDisabled,
      disabledReason: baseReason,
    },
    {
      id: "cherry_pick",
      label: "Cherry-pick",
      disabled: baseDisabled || isHead,
      disabledReason: isHead ? "Cannot cherry-pick HEAD" : baseReason,
    },
    {
      id: "revert",
      label: "Revert commit",
      disabled: baseDisabled,
      disabledReason: baseReason,
    },
    { id: "compare_parent", label: "Compare with parent", disabled: commit.parents.length === 0 },
    { id: "view_files", label: "View changed files", disabled: baseDisabled, disabledReason: baseReason },
    { id: "open_lane_git", label: "Open in Lanes git pane" },
    { id: "copy_sha", label: "Copy full SHA" },
    { id: "copy_subject", label: "Copy subject" },
  ];
}

export async function runHistoryGitAction(args: {
  actionId: HistoryGitActionId;
  laneId: string;
  commit: GitCommitSummary;
  onNotice?: (message: string) => void;
  onError?: (message: string) => void;
  navigate?: (path: string) => void;
}): Promise<void> {
  const { actionId, laneId, commit, onNotice, onError, navigate } = args;

  try {
    switch (actionId) {
      case "copy_sha":
        await navigator.clipboard.writeText(commit.sha);
        onNotice?.("SHA copied");
        return;
      case "copy_subject":
        await navigator.clipboard.writeText(commit.subject);
        onNotice?.("Subject copied");
        return;
      case "checkout":
        navigate?.(`/lanes?laneId=${encodeURIComponent(laneId)}`);
        return;
      case "cherry_pick": {
        if (!window.confirm(`Cherry-pick ${commit.shortSha} onto this lane?`)) return;
        await window.ade.git.cherryPickCommit({ laneId, commitSha: commit.sha });
        onNotice?.(`Cherry-picked ${commit.shortSha}`);
        return;
      }
      case "revert": {
        if (!window.confirm(`Revert ${commit.shortSha}? This creates a new commit.`)) return;
        await window.ade.git.revertCommit({ laneId, commitSha: commit.sha });
        onNotice?.(`Reverted ${commit.shortSha}`);
        return;
      }
      case "open_lane_git":
        navigate?.(`/lanes?laneId=${encodeURIComponent(laneId)}&commitSha=${encodeURIComponent(commit.sha)}`);
        return;
      case "compare_parent":
      case "view_files":
        navigate?.(`/lanes?laneId=${encodeURIComponent(laneId)}`);
        return;
      default:
        return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onError?.(msg.replace(/^Error invoking remote method '[^']+':\s*/i, "").trim());
  }
}
