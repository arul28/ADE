import type { GitCommitSummary } from "../../../shared/types";

export type HistoryGitActionId =
  | "checkout"
  | "create_branch"
  | "create_lane"
  | "create_tag"
  | "cherry_pick"
  | "revert"
  | "reset_soft"
  | "reset_mixed"
  | "reset_hard"
  | "open_commit"
  | "copy_commit_link"
  | "copy_patch"
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

export type HistoryGitActionGroup = {
  id: string;
  label: string;
  actions: HistoryGitAction[];
};

const commitActionGroups: Array<{
  id: string;
  label: string;
  actionIds: HistoryGitActionId[];
}> = [
  {
    id: "inspect",
    label: "Inspect",
    actionIds: ["checkout", "open_lane_git", "compare_parent", "view_files"],
  },
  {
    id: "create",
    label: "Create",
    actionIds: ["create_branch", "create_lane", "create_tag"],
  },
  {
    id: "apply",
    label: "Apply",
    actionIds: ["cherry_pick", "revert", "reset_soft", "reset_mixed", "reset_hard"],
  },
  {
    id: "share",
    label: "Share",
    actionIds: ["open_commit", "copy_commit_link", "copy_patch", "copy_sha", "copy_subject"],
  },
];

const COPY_PATCH_FILE_LIMIT = 50;

const COPY_PATCH_CONCURRENCY = 6;

function validateBranchName(name: string): string | null {
  if (!name.length) return "Branch name is required";
  if (name.startsWith("-")) return "Branch name cannot start with a dash";
  if (/\s/.test(name)) return "Branch name cannot contain whitespace";
  // Invalid git ref characters per git-check-ref-format(1)
  if (/[~^:?*\[\\]/.test(name)) {
    return "Branch name has an invalid character (~ ^ : ? * [ \\)";
  }
  if (name.includes("..")) return "Branch name cannot contain '..'";
  if (name.includes("@{")) return "Branch name cannot contain '@{'";
  if (name.startsWith("/") || name.endsWith("/")) {
    return "Branch name cannot start or end with '/'";
  }
  if (name.endsWith(".") || name.endsWith(".lock")) {
    return "Branch name cannot end with '.' or '.lock'";
  }
  if (name.includes("//")) return "Branch name cannot contain '//'";
  // Control characters and DEL
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(name)) {
    return "Branch name contains a control character";
  }
  return null;
}

function laneCommitDeepLink(laneId: string, commitSha: string): string {
  const params = new URLSearchParams({
    laneId,
    focus: "single",
    commitSha,
  });
  return `/lanes?${params.toString()}`;
}

const GITHUB_REPO_RE = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/(.+)$/;

function githubCommitUrl(remoteUrl: string | null, commitSha: string): string | null {
  if (!remoteUrl) return null;
  const match = GITHUB_REPO_RE.exec(remoteUrl.trim().replace(/\.git$/, ""));
  return match ? `https://github.com/${match[1]}/${match[2]}/commit/${commitSha}` : null;
}

function defaultBranchNameForCommit(commit: GitCommitSummary): string {
  const subjectSlug = commit.subject
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42)
    .replace(/[-/]+$/g, "");
  return `history/${commit.shortSha}${subjectSlug ? `-${subjectSlug}` : ""}`;
}

async function copyCommitPatch(args: {
  laneId: string;
  commit: GitCommitSummary;
  onNotice?: (message: string) => void;
}): Promise<void> {
  const files = await window.ade.git.listCommitFiles({
    laneId: args.laneId,
    commitSha: args.commit.sha,
  });
  if (files.length === 0) {
    args.onNotice?.("No changed files found for this commit");
    return;
  }

  const selectedFiles = files.slice(0, COPY_PATCH_FILE_LIMIT);
  const patchResults: PromiseSettledResult<string | null>[] = new Array(selectedFiles.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(COPY_PATCH_CONCURRENCY, selectedFiles.length) },
    async () => {
      while (true) {
        const index = cursor++;
        if (index >= selectedFiles.length) return;
        const path = selectedFiles[index];
        try {
          const patch = await window.ade.diff.getFilePatch({
            laneId: args.laneId,
            path,
            mode: "commit",
            compareRef: args.commit.sha,
            compareTo: "parent",
          });
          const body = patch.patch.trim();
          patchResults[index] = { status: "fulfilled", value: body.length ? body : null };
        } catch (err) {
          patchResults[index] = {
            status: "rejected",
            reason: err,
          };
        }
      }
    },
  );
  await Promise.all(workers);
  const patches = patchResults
    .filter((result): result is PromiseFulfilledResult<string> => (
      result.status === "fulfilled" && result.value != null
    ))
    .map((result) => result.value);
  if (patches.length === 0) {
    args.onNotice?.("No patch available for this commit");
    return;
  }

  const failed = patchResults.filter((result) => result.status === "rejected").length;
  const skipped = failed + Math.max(0, files.length - selectedFiles.length);
  const text = [
    `# ${args.commit.shortSha} ${args.commit.subject}`,
    "",
    ...patches,
    "",
  ].join("\n");
  await window.ade.app.writeClipboardText(text);
  args.onNotice?.(
    skipped > 0
      ? `Patch copied (${patches.length} file${patches.length === 1 ? "" : "s"}, ${skipped} skipped)`
      : `Patch copied (${patches.length} file${patches.length === 1 ? "" : "s"})`,
  );
}

export function buildCommitContextActions(args: {
  commit: GitCommitSummary;
  isHead: boolean;
  hasWorktree: boolean;
  /** When false, commit is visible via shared object db but not on this lane's branch history. */
  commitOnLaneHistory?: boolean;
}): HistoryGitAction[] {
  const { commit, isHead, hasWorktree, commitOnLaneHistory = true } = args;
  const baseDisabled = !hasWorktree;
  const baseReason = baseDisabled ? "Lane worktree is missing" : undefined;
  const laneHistoryDisabled = hasWorktree && !commitOnLaneHistory;
  const laneHistoryReason = laneHistoryDisabled
    ? "Select the lane that contains this commit before changing git state"
    : undefined;
  const gitMutationDisabled = baseDisabled || laneHistoryDisabled;
  const gitMutationReason = baseReason ?? laneHistoryReason;

  return [
    {
      id: "checkout",
      label: "Inspect on lane (git pane)",
      disabled: baseDisabled,
      disabledReason: baseReason,
    },
    {
      id: "create_branch",
      label: "Create branch here",
      disabled: gitMutationDisabled,
      disabledReason: gitMutationReason,
    },
    {
      id: "create_lane",
      label: "Create lane here",
      disabled: gitMutationDisabled,
      disabledReason: gitMutationReason,
    },
    {
      id: "create_tag",
      label: "Create tag here",
      disabled: gitMutationDisabled,
      disabledReason: gitMutationReason,
    },
    {
      id: "cherry_pick",
      label: "Cherry-pick",
      disabled: gitMutationDisabled || isHead,
      disabledReason: isHead ? "Cannot cherry-pick HEAD" : gitMutationReason,
    },
    {
      id: "revert",
      label: "Revert commit",
      disabled: gitMutationDisabled,
      disabledReason: gitMutationReason,
    },
    {
      id: "reset_soft",
      label: "Soft reset lane here",
      disabled: gitMutationDisabled,
      disabledReason: gitMutationReason,
    },
    {
      id: "reset_mixed",
      label: "Mixed reset lane here",
      disabled: gitMutationDisabled,
      disabledReason: gitMutationReason,
    },
    {
      id: "reset_hard",
      label: "Hard reset lane here",
      destructive: true,
      disabled: gitMutationDisabled,
      disabledReason: gitMutationReason,
    },
    { id: "compare_parent", label: "Compare with parent", disabled: commit.parents.length === 0 },
    { id: "view_files", label: "View changed files", disabled: baseDisabled, disabledReason: baseReason },
    { id: "open_lane_git", label: "Open in Lanes git pane" },
    { id: "open_commit", label: "Open commit on GitHub" },
    { id: "copy_commit_link", label: "Copy commit link" },
    { id: "copy_patch", label: "Copy patch", disabled: baseDisabled, disabledReason: baseReason },
    { id: "copy_sha", label: "Copy full SHA" },
    { id: "copy_subject", label: "Copy subject" },
  ];
}

export function groupCommitContextActions(actions: HistoryGitAction[]): HistoryGitActionGroup[] {
  const byId = new Map(actions.map((action) => [action.id, action]));
  return commitActionGroups
    .map((group) => ({
      id: group.id,
      label: group.label,
      actions: group.actionIds
        .map((id) => byId.get(id))
        .filter((action): action is HistoryGitAction => action != null),
    }))
    .filter((group) => group.actions.length > 0);
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
        await window.ade.app.writeClipboardText(commit.sha);
        onNotice?.("SHA copied");
        return;
      case "copy_subject":
        await window.ade.app.writeClipboardText(commit.subject);
        onNotice?.("Subject copied");
        return;
      case "open_commit":
      case "copy_commit_link": {
        const remote = await window.ade.git.getOriginRemote({ laneId });
        const url = githubCommitUrl(remote.remoteUrl, commit.sha);
        if (!url) {
          onNotice?.("No GitHub remote found for this commit");
          return;
        }
        if (actionId === "open_commit") {
          await window.ade.app.openExternal(url);
          onNotice?.("Opened commit on GitHub");
        } else {
          await window.ade.app.writeClipboardText(url);
          onNotice?.("Commit link copied");
        }
        return;
      }
      case "copy_patch":
        await copyCommitPatch({ laneId, commit, onNotice });
        return;
      case "checkout":
        navigate?.(laneCommitDeepLink(laneId, commit.sha));
        return;
      case "create_branch": {
        const branchName = window.prompt(`Create branch at ${commit.shortSha}`);
        const trimmed = branchName?.trim();
        if (!trimmed) return;
        const validationError = validateBranchName(trimmed);
        if (validationError) {
          onError?.(validationError);
          return;
        }
        await window.ade.git.checkoutBranch({
          laneId,
          branchName: trimmed,
          mode: "create",
          startPoint: commit.sha,
        });
        onNotice?.(`Created ${trimmed}`);
        return;
      }
      case "create_lane": {
        const fallbackBranchName = defaultBranchNameForCommit(commit);
        const branchName = window.prompt(`Create lane branch at ${commit.shortSha}`, fallbackBranchName);
        const trimmedBranchName = branchName?.trim();
        if (!trimmedBranchName) return;
        const branchValidationError = validateBranchName(trimmedBranchName);
        if (branchValidationError) {
          onError?.(branchValidationError);
          return;
        }
        const laneName = window.prompt("Lane name", trimmedBranchName)?.trim();
        if (!laneName) return;
        const remote = await window.ade.git.getOriginRemote({ laneId });
        const lane = await window.ade.lanes.create({
          name: laneName,
          parentLaneId: laneId,
          branchName: trimmedBranchName,
          startPoint: commit.sha,
          ...(remote.branch ? { baseBranch: remote.branch } : {}),
        });
        onNotice?.(`Created lane ${lane.name}`);
        navigate?.(`/lanes?laneId=${encodeURIComponent(lane.id)}`);
        return;
      }
      case "create_tag": {
        const tagName = window.prompt(`Create tag at ${commit.shortSha}`);
        const trimmed = tagName?.trim();
        if (!trimmed) return;
        const message = window.prompt("Tag message (optional)")?.trim();
        await window.ade.git.createTag({
          laneId,
          tagName: trimmed,
          commitSha: commit.sha,
          ...(message ? { message } : {}),
        });
        onNotice?.(`Created tag ${trimmed}`);
        return;
      }
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
      case "reset_soft":
      case "reset_mixed":
      case "reset_hard": {
        const resetModes = {
          reset_soft: { mode: "soft" as const, detail: " This keeps changes staged." },
          reset_mixed: { mode: "mixed" as const, detail: " This keeps file changes but unstages them." },
          reset_hard: { mode: "hard" as const, detail: " This discards uncommitted worktree changes." },
        };
        const { mode, detail } = resetModes[actionId];
        if (!window.confirm(`Reset this lane to ${commit.shortSha}?${detail}`)) return;
        await window.ade.git.resetToCommit({ laneId, commitSha: commit.sha, mode });
        onNotice?.(`Reset lane to ${commit.shortSha}`);
        return;
      }
      case "open_lane_git":
      case "compare_parent":
      case "view_files":
        navigate?.(laneCommitDeepLink(laneId, commit.sha));
        return;
      default:
        return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onError?.(msg.replace(/^Error invoking remote method '[^']+':\s*/i, "").trim());
  }
}
