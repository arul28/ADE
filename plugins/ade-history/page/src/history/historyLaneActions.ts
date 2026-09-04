import * as actions from "../host/actions";
import { confirm as hostConfirm, openLink, prompt as hostPrompt, toast, writeClipboard } from "../host/ui";
import type { GitConflictState, GitStashSummary, PageActionResult } from "../lib/types";

export type HistoryLaneActionId =
  | "fetch"
  | "pull"
  | "pull_rebase"
  | "pull_merge"
  | "undo_last_head_change"
  | "redo_last_head_change"
  | "push"
  | "force_push_lease"
  | "copy_branch_name"
  | "open_branch"
  | "copy_branch_link"
  | "open_pr"
  | "copy_pr_link"
  | "rename_lane"
  | "archive_lane"
  | "delete_lane_worktree"
  | "delete_lane_branch"
  | "merge_upstream"
  | "rebase_upstream"
  | "rebase_continue"
  | "rebase_abort"
  | "merge_continue"
  | "merge_abort"
  | "stash"
  | "stash_apply_latest"
  | "stash_pop_latest"
  | "stash_drop_latest"
  | "stash_clear"
  | "open_lane_git";

export type HistoryLaneAction = {
  id: HistoryLaneActionId;
  label: string;
  description: string;
  destructive?: boolean;
  external?: boolean;
  disabled?: boolean;
  disabledReason?: string;
};

export type HistoryLaneActionGroup = {
  id: string;
  label: string;
  actions: HistoryLaneAction[];
};

const laneActionGroups: Array<{
  id: string;
  label: string;
  actionIds: HistoryLaneActionId[];
}> = [
  {
    id: "remote",
    label: "Remote",
    actionIds: ["fetch", "pull", "pull_rebase", "pull_merge", "push", "force_push_lease"],
  },
  {
    id: "recover",
    label: "Recover",
    actionIds: ["undo_last_head_change", "redo_last_head_change"],
  },
  {
    id: "branch",
    label: "Branch and PR",
    actionIds: ["copy_branch_name", "open_branch", "copy_branch_link", "open_pr", "copy_pr_link"],
  },
  {
    id: "lane",
    label: "Lane",
    actionIds: ["rename_lane", "archive_lane", "delete_lane_worktree", "delete_lane_branch"],
  },
  {
    id: "integrate",
    label: "Integrate",
    actionIds: ["merge_upstream", "rebase_upstream"],
  },
  {
    id: "stash",
    label: "Stash",
    actionIds: ["stash", "stash_apply_latest", "stash_pop_latest", "stash_drop_latest", "stash_clear"],
  },
  {
    id: "conflict",
    label: "Conflict",
    actionIds: ["rebase_continue", "rebase_abort", "merge_continue", "merge_abort"],
  },
  {
    id: "open",
    label: "Open",
    actionIds: ["open_lane_git"],
  },
];

const GITHUB_REPO_RE = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/(.+)$/;

function githubBranchUrl(remoteUrl: string | null, branch: string | null): string | null {
  if (!remoteUrl || !branch) return null;
  const match = GITHUB_REPO_RE.exec(remoteUrl.trim().replace(/\.git$/, ""));
  if (!match) return null;
  const encodedBranch = branch.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${match[1]}/${match[2]}/tree/${encodedBranch}`;
}

export function buildHistoryLaneActions(args: {
  hasLane: boolean;
  conflictState?: GitConflictState | null;
}): HistoryLaneAction[] {
  const disabled = !args.hasLane;
  const disabledReason = disabled ? "Select a lane first" : undefined;
  const laneAction = (
    action: Omit<HistoryLaneAction, "disabled" | "disabledReason">,
  ): HistoryLaneAction => ({
    ...action,
    disabled,
    disabledReason,
  });

  const conflictActions: HistoryLaneAction[] = [];
  if (args.conflictState?.inProgress) {
    const isRebase = args.conflictState.kind === "rebase";
    const isMerge = args.conflictState.kind === "merge";
    const conflictCount = args.conflictState.conflictedFiles.length;
    const continueReason = conflictCount ? "Resolve conflicted files first" : undefined;
    const conflictDescription = (kind: string) =>
      conflictCount
        ? `${conflictCount} conflicted file${conflictCount === 1 ? "" : "s"} left`
        : `Resume the interrupted ${kind}`;

    conflictActions.push(
      {
        id: "rebase_continue",
        label: "Continue rebase",
        description: conflictDescription("rebase"),
        disabled: disabled || !isRebase || !args.conflictState.canContinue,
        disabledReason: disabledReason ?? (!isRebase ? "No rebase in progress" : continueReason),
      },
      {
        id: "rebase_abort",
        label: "Abort rebase",
        description: "Roll back the interrupted rebase",
        destructive: true,
        disabled: disabled || !isRebase || !args.conflictState.canAbort,
        disabledReason: disabledReason ?? (!isRebase ? "No rebase in progress" : undefined),
      },
      {
        id: "merge_continue",
        label: "Continue merge",
        description: conflictDescription("merge"),
        disabled: disabled || !isMerge || !args.conflictState.canContinue,
        disabledReason: disabledReason ?? (!isMerge ? "No merge in progress" : continueReason),
      },
      {
        id: "merge_abort",
        label: "Abort merge",
        description: "Roll back the interrupted merge",
        destructive: true,
        disabled: disabled || !isMerge || !args.conflictState.canAbort,
        disabledReason: disabledReason ?? (!isMerge ? "No merge in progress" : undefined),
      },
    );
  }

  return [
    laneAction({
      id: "fetch",
      label: "Fetch",
      description: "Refresh remote refs",
    }),
    laneAction({
      id: "pull",
      label: "Pull fast-forward",
      description: "Fast-forward from upstream",
    }),
    laneAction({
      id: "pull_rebase",
      label: "Pull with rebase",
      description: "Replay local commits after upstream",
    }),
    laneAction({
      id: "pull_merge",
      label: "Pull with merge",
      description: "Merge upstream into this lane",
    }),
    laneAction({
      id: "undo_last_head_change",
      label: "Undo last head change",
      description: "Reset to the previous recorded HEAD",
      destructive: true,
    }),
    laneAction({
      id: "redo_last_head_change",
      label: "Redo last head change",
      description: "Restore the last undone HEAD",
      destructive: true,
    }),
    laneAction({
      id: "push",
      label: "Push",
      description: "Publish commits to upstream",
      external: true,
    }),
    laneAction({
      id: "force_push_lease",
      label: "Force push with lease",
      description: "Rewrite upstream if it still matches",
      destructive: true,
      external: true,
    }),
    laneAction({
      id: "copy_branch_name",
      label: "Copy branch name",
      description: "Copy the current lane branch ref",
    }),
    laneAction({
      id: "open_branch",
      label: "Open branch on GitHub",
      description: "Open the current lane branch in the remote repo",
      external: true,
    }),
    laneAction({
      id: "copy_branch_link",
      label: "Copy branch link",
      description: "Copy a GitHub link for this lane branch",
      external: true,
    }),
    laneAction({
      id: "open_pr",
      label: "Open branch PR",
      description: "Open the pull request for this lane",
      external: true,
    }),
    laneAction({
      id: "copy_pr_link",
      label: "Copy PR link",
      description: "Copy the lane pull request URL",
      external: true,
    }),
    laneAction({
      id: "rename_lane",
      label: "Rename lane",
      description: "Update the ADE lane name",
    }),
    laneAction({
      id: "archive_lane",
      label: "Archive lane",
      description: "Hide this lane without deleting its worktree",
      destructive: true,
    }),
    laneAction({
      id: "delete_lane_worktree",
      label: "Delete lane worktree",
      description: "Remove the ADE lane and worktree, keep the local branch",
      destructive: true,
    }),
    laneAction({
      id: "delete_lane_branch",
      label: "Delete lane + branch",
      description: "Remove the ADE lane, worktree, and local branch",
      destructive: true,
    }),
    laneAction({
      id: "merge_upstream",
      label: "Merge base",
      description: "Fetch, then merge the lane base",
    }),
    laneAction({
      id: "rebase_upstream",
      label: "Rebase onto base",
      description: "Fetch, then replay on the lane base",
    }),
    laneAction({
      id: "stash",
      label: "Stash changes",
      description: "Save current worktree changes",
    }),
    laneAction({
      id: "stash_apply_latest",
      label: "Apply latest stash",
      description: "Restore latest branch stash and keep it saved",
    }),
    laneAction({
      id: "stash_pop_latest",
      label: "Pop latest stash",
      description: "Restore latest branch stash and remove it",
    }),
    laneAction({
      id: "stash_drop_latest",
      label: "Drop latest stash",
      description: "Delete latest branch stash",
      destructive: true,
    }),
    laneAction({
      id: "stash_clear",
      label: "Clear branch stashes",
      description: "Delete every stash saved for this branch",
      destructive: true,
    }),
    ...conflictActions,
    laneAction({
      id: "open_lane_git",
      label: "Open Lanes git pane",
      description: "Jump to the full lane git surface",
    }),
  ];
}

export function groupHistoryLaneActions(actions: HistoryLaneAction[]): HistoryLaneActionGroup[] {
  const byId = new Map(actions.map((action) => [action.id, action]));
  return laneActionGroups
    .map((group) => ({
      id: group.id,
      label: group.label,
      actions: group.actionIds
        .map((id) => byId.get(id))
        .filter((action): action is HistoryLaneAction => action != null),
    }))
    .filter((group) => group.actions.length > 0);
}

function stripIpcError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+':\s*/i, "").trim();
}

async function requireOk(result: PageActionResult, fallback: string): Promise<void> {
  if (!result.ok) throw new Error(result.message ?? fallback);
}

async function confirmOrCancel(message: string, destructive = false): Promise<boolean> {
  return hostConfirm({ title: message, destructive });
}

async function promptOrCancel(message: string, fallback: string): Promise<string | null> {
  const answer = await hostPrompt({ title: message, placeholder: fallback, submitLabel: "OK" });
  if (typeof answer === "string") return answer.trim() || null;
  if (answer && typeof answer === "object") {
    const row = answer as Record<string, unknown>;
    const text = typeof row.value === "string" ? row.value : typeof row.text === "string" ? row.text : null;
    return text?.trim() || null;
  }
  return null;
}

async function promptConfirmOrCancel(message: string, expected: string): Promise<boolean> {
  const value = await promptOrCancel(message, expected);
  return value === expected;
}

async function getLatestBranchStash(laneId: string): Promise<GitStashSummary | null> {
  const stashes = await actions.getStashList(laneId);
  return stashes[0] ?? null;
}

export async function runHistoryLaneAction(args: {
  actionId: HistoryLaneActionId;
  laneId: string;
  laneName?: string | null;
  onNotice?: (message: string) => void;
  onError?: (message: string) => void;
  onComplete?: () => void;
  navigate?: (path: string) => void;
}): Promise<void> {
  const { actionId, laneId, laneName, onNotice, onError, onComplete, navigate } =
    args;
  const target = laneName ? ` for ${laneName}` : "";
  const laneLabel = laneName?.trim() || laneId;

  try {
    switch (actionId) {
      case "fetch":
        await requireOk(await actions.gitFetch(laneId), "Could not fetch that lane.");
        onNotice?.("Fetched remote refs");
        onComplete?.();
        return;
      case "pull":
        if (!await confirmOrCancel(`Fast-forward pull from upstream${target}? This updates the lane worktree.`)) {
          return;
        }
        await requireOk(await actions.gitPull(laneId, "ff-only"), "Could not pull that lane.");
        onNotice?.("Pulled from upstream with fast-forward");
        onComplete?.();
        return;
      case "pull_rebase":
        if (!await confirmOrCancel(`Pull with rebase${target}? Local commits will replay on top of upstream.`)) {
          return;
        }
        await requireOk(await actions.gitPull(laneId, "rebase"), "Could not pull that lane.");
        onNotice?.("Pulled with rebase");
        onComplete?.();
        return;
      case "pull_merge":
        if (!await confirmOrCancel(`Pull with merge${target}? This may create a merge commit.`)) {
          return;
        }
        await requireOk(await actions.gitPull(laneId, "merge"), "Could not pull that lane.");
        onNotice?.("Pulled with merge");
        onComplete?.();
        return;
      case "undo_last_head_change":
        if (!await promptConfirmOrCancel(
          `Undo the latest head-changing git operation${target}? Type undo to confirm. This runs git reset --hard.`,
          "undo",
        )) {
          return;
        }
        await requireOk(await actions.undoLastHeadChange(laneId), "Could not undo that head change.");
        onNotice?.("Undid last head change");
        onComplete?.();
        return;
      case "redo_last_head_change":
        if (!await promptConfirmOrCancel(
          `Redo the last undone git head change${target}? Type redo to confirm. This runs git reset --hard.`,
          "redo",
        )) {
          return;
        }
        await requireOk(await actions.redoLastHeadChange(laneId), "Could not redo that head change.");
        onNotice?.("Redid last head change");
        onComplete?.();
        return;
      case "push":
        if (!await confirmOrCancel(`Push this lane${target} to its upstream remote?`)) {
          return;
        }
        await requireOk(await actions.gitPush(laneId), "Could not push that lane.");
        onNotice?.("Pushed to upstream");
        await toast({ level: "success", message: `Pushed ${laneLabel}` });
        onComplete?.();
        return;
      case "force_push_lease":
        if (!await confirmOrCancel("Force push with lease? This can rewrite the remote branch.", true)) {
          return;
        }
        await requireOk(await actions.gitPush(laneId, true), "Could not force-push that lane.");
        onNotice?.("Force-pushed with lease");
        await toast({ level: "success", message: `Force-pushed ${laneLabel}` });
        onComplete?.();
        return;
      case "copy_branch_name": {
        const remote = await actions.getOriginRemote(laneId);
        if (!remote?.branch) {
          onNotice?.("No branch name found for this lane");
          return;
        }
        await writeClipboard(remote.branch);
        onNotice?.("Branch name copied");
        return;
      }
      case "open_branch":
      case "copy_branch_link": {
        const remote = await actions.getOriginRemote(laneId);
        const url = githubBranchUrl(remote?.remoteUrl ?? "", remote?.branch ?? "");
        if (!url) {
          onNotice?.("No GitHub branch link found for this lane");
          return;
        }
        if (actionId === "open_branch") {
          await openLink(url);
          onNotice?.("Opened branch on GitHub");
        } else {
          await writeClipboard(url);
          onNotice?.("Branch link copied");
        }
        return;
      }
      case "open_pr": {
        const pr = await actions.getOpenPrForBranch(laneId);
        if (!pr?.prUrl) {
          onNotice?.("No open PR found for this lane branch");
          return;
        }
        await openLink(pr.prUrl);
        onNotice?.(`Opened PR #${pr.prNumber ?? "?"}`);
        return;
      }
      case "copy_pr_link": {
        const pr = await actions.getOpenPrForBranch(laneId);
        if (!pr?.prUrl) {
          onNotice?.("No open PR found for this lane branch");
          return;
        }
        await writeClipboard(pr.prUrl);
        onNotice?.("PR link copied");
        return;
      }
      case "rename_lane": {
        const currentName = laneName?.trim() || "Lane";
        const nextName = await promptOrCancel("Rename lane", currentName);
        if (!nextName || nextName === currentName) return;
        await requireOk(await actions.renameLane(laneId, nextName), "Could not rename that lane.");
        onNotice?.(`Renamed lane to ${nextName}`);
        onComplete?.();
        return;
      }
      case "archive_lane": {
        const currentName = laneName?.trim() || "this lane";
        if (!await confirmOrCancel(`Archive ${currentName}? The worktree and branch stay on disk.`)) {
          return;
        }
        await requireOk(await actions.archiveLane(laneId), "Could not archive that lane.");
        onNotice?.("Archived lane");
        onComplete?.();
        return;
      }
      case "delete_lane_worktree": {
        const currentName = laneName?.trim() || "this lane";
        if (!await promptConfirmOrCancel(
          `Delete ${currentName}'s ADE lane and worktree? Type delete to confirm. The local branch stays.`,
          "delete",
        )) {
          return;
        }
        await requireOk(await actions.deleteLane(laneId, { deleteBranch: false }), "Could not delete that lane.");
        onNotice?.("Deleted lane worktree");
        onComplete?.();
        return;
      }
      case "delete_lane_branch": {
        const remote = await actions.getOriginRemote(laneId);
        const branch = remote?.branch?.trim() || "";
        const expected = branch || "delete";
        const message = branch
          ? `Delete this ADE lane, worktree, and local branch "${branch}"? Type ${branch} to confirm.`
          : "Delete this ADE lane, worktree, and local branch? Type delete to confirm.";
        if (!await promptConfirmOrCancel(message, expected)) {
          return;
        }
        await requireOk(await actions.deleteLane(laneId, { deleteBranch: true }), "Could not delete that lane.");
        onNotice?.("Deleted lane and local branch");
        onComplete?.();
        return;
      }
      case "merge_upstream":
        if (!await confirmOrCancel(`Merge the lane base into this lane${target}?`)) {
          return;
        }
        await requireOk(await actions.gitSync(laneId, "merge"), "Could not merge that lane.");
        onNotice?.("Merged lane base");
        await toast({ level: "success", message: `Merged base into ${laneLabel}` });
        onComplete?.();
        return;
      case "rebase_upstream":
        if (!await confirmOrCancel(`Rebase this lane${target} onto its base?`)) {
          return;
        }
        await requireOk(await actions.gitSync(laneId, "rebase"), "Could not rebase that lane.");
        onNotice?.("Rebased onto lane base");
        await toast({ level: "success", message: `Rebased ${laneLabel}` });
        onComplete?.();
        return;
      case "stash": {
        const message = await promptOrCancel("Stash message", "ADE history stash");
        if (!message) return;
        const includeUntracked = await confirmOrCancel("Include untracked files in the stash?");
        await requireOk(await actions.stashPush({ laneId, message, includeUntracked }), "Could not stash that lane.");
        onNotice?.("Saved stash");
        onComplete?.();
        return;
      }
      case "stash_apply_latest": {
        const stash = await getLatestBranchStash(laneId);
        if (!stash) {
          onNotice?.("No branch stashes saved");
          return;
        }
        if (!await confirmOrCancel(`Apply ${stash.ref}: ${stash.subject || "saved stash"}?`)) return;
        await requireOk(await actions.stashApply({ laneId, stashRef: stash.ref, stashOid: stash.oid }), "Could not apply that stash.");
        onNotice?.(`Applied ${stash.ref}`);
        onComplete?.();
        return;
      }
      case "stash_pop_latest": {
        const stash = await getLatestBranchStash(laneId);
        if (!stash) {
          onNotice?.("No branch stashes saved");
          return;
        }
        if (!await confirmOrCancel(`Pop ${stash.ref}: ${stash.subject || "saved stash"}? This removes it from stashes.`)) return;
        await requireOk(await actions.stashPop({ laneId, stashRef: stash.ref, stashOid: stash.oid }), "Could not pop that stash.");
        onNotice?.(`Popped ${stash.ref}`);
        onComplete?.();
        return;
      }
      case "stash_drop_latest": {
        const stash = await getLatestBranchStash(laneId);
        if (!stash) {
          onNotice?.("No branch stashes saved");
          return;
        }
        if (!await confirmOrCancel(`Delete ${stash.ref}: ${stash.subject || "saved stash"}?`, true)) return;
        await requireOk(await actions.stashDrop({ laneId, stashRef: stash.ref, stashOid: stash.oid }), "Could not drop that stash.");
        onNotice?.(`Dropped ${stash.ref}`);
        onComplete?.();
        return;
      }
      case "stash_clear": {
        const stashes = await actions.getStashList(laneId);
        if (stashes.length === 0) {
          onNotice?.("No branch stashes saved");
          return;
        }
        if (!await confirmOrCancel(`Delete ${stashes.length} branch stash${stashes.length === 1 ? "" : "es"}?`, true)) return;
        await requireOk(await actions.stashClear(laneId), "Could not clear stashes.");
        onNotice?.("Cleared branch stashes");
        onComplete?.();
        return;
      }
      case "rebase_continue":
        await requireOk(await actions.rebaseContinue(laneId), "Could not continue that rebase.");
        onNotice?.("Continued rebase");
        onComplete?.();
        return;
      case "rebase_abort":
        if (!await confirmOrCancel("Abort the in-progress rebase?")) return;
        await requireOk(await actions.rebaseAbort(laneId), "Could not abort that rebase.");
        onNotice?.("Aborted rebase");
        onComplete?.();
        return;
      case "merge_continue":
        await requireOk(await actions.mergeContinue(laneId), "Could not continue that merge.");
        onNotice?.("Continued merge");
        onComplete?.();
        return;
      case "merge_abort":
        if (!await confirmOrCancel("Abort the in-progress merge?")) return;
        await requireOk(await actions.mergeAbort(laneId), "Could not abort that merge.");
        onNotice?.("Aborted merge");
        onComplete?.();
        return;
      case "open_lane_git":
        navigate?.(`/lanes?laneId=${encodeURIComponent(laneId)}`);
        return;
      default: {
        const _exhaustive: never = actionId;
        void _exhaustive;
        return;
      }
    }
  } catch (err) {
    const message = stripIpcError(err);
    const pushSyncFailTitle: Partial<Record<HistoryLaneActionId, string>> = {
      push: "Push failed",
      force_push_lease: "Force push failed",
      merge_upstream: "Merge failed",
      rebase_upstream: "Rebase failed",
    };
    const failTitle = pushSyncFailTitle[actionId];
    if (failTitle) {
      void toast({ level: "error", message: `${failTitle}: ${laneLabel}: ${message}` });
    }
    onError?.(message);
  }
}
