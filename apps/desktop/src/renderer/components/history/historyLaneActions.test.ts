import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildHistoryLaneActions,
  groupHistoryLaneActions,
  runHistoryLaneAction,
} from "./historyLaneActions";

function stubGitWindow(promptValues: string[] = ["checkpoint"]) {
  const git = {
    fetch: vi.fn(async () => ({ operationId: "fetch", preHeadSha: "a", postHeadSha: "a" })),
    pull: vi.fn(async () => ({ operationId: "pull", preHeadSha: "a", postHeadSha: "b" })),
    undoLastHeadChange: vi.fn(async () => ({ operationId: "undo", preHeadSha: "b", postHeadSha: "a" })),
    redoLastHeadChange: vi.fn(async () => ({ operationId: "redo", preHeadSha: "a", postHeadSha: "b" })),
    push: vi.fn(async () => ({ operationId: "push", preHeadSha: "a", postHeadSha: "a" })),
    getOriginRemote: vi.fn(async (): Promise<{ remoteUrl: string | null; branch: string | null }> => ({
      remoteUrl: "git@github.com:arul28/ADE.git",
      branch: "cursor/history-tab",
    })),
    getOpenPrForBranch: vi.fn(async (): Promise<{
      prUrl: string | null;
      prNumber: number | null;
      title: string | null;
      headRefName: string | null;
    }> => ({
      prUrl: "https://github.com/arul28/ADE/pull/332",
      prNumber: 332,
      title: "History overhaul",
      headRefName: "cursor/history-tab",
    })),
    sync: vi.fn(async () => ({ operationId: "sync", preHeadSha: "a", postHeadSha: "b" })),
    stashPush: vi.fn(async () => ({ operationId: "stash", preHeadSha: "a", postHeadSha: "a" })),
    stashList: vi.fn(async () => [
      {
        oid: "oid-0",
        ref: "stash@{0}",
        subject: "checkpoint",
        createdAt: "2026-05-22T12:00:00.000Z",
      },
    ]),
    stashApply: vi.fn(async () => ({ operationId: "stash-apply", preHeadSha: "a", postHeadSha: "a" })),
    stashPop: vi.fn(async () => ({ operationId: "stash-pop", preHeadSha: "a", postHeadSha: "a" })),
    stashDrop: vi.fn(async () => ({ operationId: "stash-drop", preHeadSha: "a", postHeadSha: "a" })),
    stashClear: vi.fn(async () => ({ operationId: "stash-clear", preHeadSha: "a", postHeadSha: "a" })),
    rebaseContinue: vi.fn(async () => ({ operationId: "rebase-continue", preHeadSha: "a", postHeadSha: "b" })),
    rebaseAbort: vi.fn(async () => ({ operationId: "rebase-abort", preHeadSha: "a", postHeadSha: "a" })),
    mergeContinue: vi.fn(async () => ({ operationId: "merge-continue", preHeadSha: "a", postHeadSha: "b" })),
    mergeAbort: vi.fn(async () => ({ operationId: "merge-abort", preHeadSha: "a", postHeadSha: "a" })),
  };
  const lanes = {
    rename: vi.fn(async () => undefined),
    archive: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  const confirm = vi.fn(() => true);
  const prompt = vi.fn((_: string, fallback?: string) => promptValues.shift() ?? fallback ?? null);

  vi.stubGlobal("window", {
    ade: {
      git,
      lanes,
      app: {
        openExternal: vi.fn(async () => undefined),
        writeClipboardText: vi.fn(async () => undefined),
      },
    },
    confirm,
    prompt,
  });

  return { git, lanes, confirm, prompt };
}

describe("history lane actions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("disables lane git actions until a lane is selected", () => {
    expect(buildHistoryLaneActions({ hasLane: false }).every((action) => action.disabled)).toBe(true);
    expect(buildHistoryLaneActions({ hasLane: true }).every((action) => !action.disabled)).toBe(true);
  });

  it("adds conflict actions when a merge or rebase is in progress", () => {
    const actions = buildHistoryLaneActions({
      hasLane: true,
      conflictState: {
        laneId: "lane-1",
        kind: "rebase",
        inProgress: true,
        conflictedFiles: ["src/file.ts"],
        canContinue: false,
        canAbort: true,
      },
    });

    expect(actions.find((action) => action.id === "rebase_continue")).toMatchObject({
      disabled: true,
      disabledReason: "Resolve conflicted files first",
    });
    expect(actions.find((action) => action.id === "rebase_abort")).toMatchObject({
      disabled: false,
      destructive: true,
    });
    expect(groupHistoryLaneActions(actions).map((group) => group.id)).toContain("conflict");
  });

  it("groups the full lane action set by workflow", () => {
    const groups = groupHistoryLaneActions(buildHistoryLaneActions({ hasLane: true }));

    expect(groups.map((group) => group.id)).toEqual([
      "remote",
      "recover",
      "branch",
      "lane",
      "integrate",
      "stash",
      "open",
    ]);
  });

  it("runs remote actions through existing ADE git APIs with confirmation", async () => {
    const { git, confirm } = stubGitWindow();
    const onComplete = vi.fn();

    await runHistoryLaneAction({
      actionId: "force_push_lease",
      laneId: "lane-1",
      onComplete,
    });

    expect(confirm).toHaveBeenCalledWith(
      "Force push with lease? This can rewrite the remote branch.",
    );
    expect(git.push).toHaveBeenCalledWith({ laneId: "lane-1", forceWithLease: true });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("runs explicit pull modes through the shared pull API", async () => {
    const { git, confirm } = stubGitWindow();
    const onComplete = vi.fn();

    await runHistoryLaneAction({ actionId: "pull", laneId: "lane-1", onComplete });
    await runHistoryLaneAction({ actionId: "pull_rebase", laneId: "lane-1", onComplete });
    await runHistoryLaneAction({ actionId: "pull_merge", laneId: "lane-1", onComplete });

    expect(confirm).toHaveBeenCalledWith(
      "Fast-forward pull from upstream? This updates the lane worktree.",
    );
    expect(confirm).toHaveBeenCalledWith(
      "Pull with rebase? Local commits will replay on top of upstream.",
    );
    expect(confirm).toHaveBeenCalledWith(
      "Pull with merge? This may create a merge commit.",
    );
    expect(git.pull).toHaveBeenNthCalledWith(1, { laneId: "lane-1", mode: "ff-only" });
    expect(git.pull).toHaveBeenNthCalledWith(2, { laneId: "lane-1", mode: "rebase" });
    expect(git.pull).toHaveBeenNthCalledWith(3, { laneId: "lane-1", mode: "merge" });
    expect(onComplete).toHaveBeenCalledTimes(3);
  });

  it("runs undo and redo head-change actions through destructive typed confirmation", async () => {
    const { git, prompt } = stubGitWindow(["undo", "redo"]);
    const onComplete = vi.fn();

    await runHistoryLaneAction({
      actionId: "undo_last_head_change",
      laneId: "lane-1",
      onComplete,
    });
    await runHistoryLaneAction({
      actionId: "redo_last_head_change",
      laneId: "lane-1",
      onComplete,
    });

    expect(prompt).toHaveBeenNthCalledWith(
      1,
      "Undo the latest head-changing git operation? Type undo to confirm. This runs git reset --hard.",
    );
    expect(prompt).toHaveBeenNthCalledWith(
      2,
      "Redo the last undone git head change? Type redo to confirm. This runs git reset --hard.",
    );
    expect(git.undoLastHeadChange).toHaveBeenCalledWith({ laneId: "lane-1" });
    expect(git.redoLastHeadChange).toHaveBeenCalledWith({ laneId: "lane-1" });
    expect(onComplete).toHaveBeenCalledTimes(2);
  });

  it("opens and copies the lane PR through existing ADE APIs", async () => {
    const { git } = stubGitWindow();
    const app = window.ade.app;

    await runHistoryLaneAction({ actionId: "open_pr", laneId: "lane-1" });
    await runHistoryLaneAction({ actionId: "copy_pr_link", laneId: "lane-1" });

    expect(git.getOpenPrForBranch).toHaveBeenCalledWith({ laneId: "lane-1" });
    expect(app.openExternal).toHaveBeenCalledWith("https://github.com/arul28/ADE/pull/332");
    expect(app.writeClipboardText).toHaveBeenCalledWith("https://github.com/arul28/ADE/pull/332");
  });

  it("opens and copies GitHub branch links for the selected lane", async () => {
    const { git } = stubGitWindow();
    const app = window.ade.app;

    await runHistoryLaneAction({ actionId: "copy_branch_name", laneId: "lane-1" });
    await runHistoryLaneAction({ actionId: "open_branch", laneId: "lane-1" });
    await runHistoryLaneAction({ actionId: "copy_branch_link", laneId: "lane-1" });

    expect(git.getOriginRemote).toHaveBeenCalledWith({ laneId: "lane-1" });
    expect(app.writeClipboardText).toHaveBeenCalledWith("cursor/history-tab");
    expect(app.openExternal).toHaveBeenCalledWith("https://github.com/arul28/ADE/tree/cursor/history-tab");
    expect(app.writeClipboardText).toHaveBeenCalledWith("https://github.com/arul28/ADE/tree/cursor/history-tab");
  });

  it("reports when the lane branch has no GitHub link", async () => {
    const { git } = stubGitWindow();
    git.getOriginRemote.mockResolvedValueOnce({
      remoteUrl: "ssh://git@example.test/ade.git",
      branch: "history",
    });
    const onNotice = vi.fn();

    await runHistoryLaneAction({ actionId: "open_branch", laneId: "lane-1", onNotice });

    expect(onNotice).toHaveBeenCalledWith("No GitHub branch link found for this lane");
  });

  it("renames, archives, and deletes lanes through existing ADE lane APIs", async () => {
    const { git, lanes, confirm, prompt } = stubGitWindow();
    prompt
      .mockReturnValueOnce("Review lane")
      .mockReturnValueOnce("delete")
      .mockReturnValueOnce("cursor/history-tab");
    const onComplete = vi.fn();

    await runHistoryLaneAction({
      actionId: "rename_lane",
      laneId: "lane-1",
      laneName: "Old lane",
      onComplete,
    });
    await runHistoryLaneAction({
      actionId: "archive_lane",
      laneId: "lane-1",
      laneName: "Review lane",
      onComplete,
    });
    await runHistoryLaneAction({
      actionId: "delete_lane_worktree",
      laneId: "lane-1",
      laneName: "Review lane",
      onComplete,
    });
    await runHistoryLaneAction({
      actionId: "delete_lane_branch",
      laneId: "lane-1",
      laneName: "Review lane",
      onComplete,
    });

    expect(lanes.rename).toHaveBeenCalledWith({ laneId: "lane-1", name: "Review lane" });
    expect(confirm).toHaveBeenCalledWith(
      "Archive Review lane? The worktree and branch stay on disk.",
    );
    expect(lanes.archive).toHaveBeenCalledWith({ laneId: "lane-1" });
    expect(lanes.delete).toHaveBeenNthCalledWith(1, {
      laneId: "lane-1",
      deleteBranch: false,
      force: false,
    });
    expect(git.getOriginRemote).toHaveBeenCalledWith({ laneId: "lane-1" });
    expect(lanes.delete).toHaveBeenNthCalledWith(2, {
      laneId: "lane-1",
      deleteBranch: true,
      force: false,
    });
    expect(onComplete).toHaveBeenCalledTimes(4);
  });

  it("reports when the lane branch has no open PR", async () => {
    const { git } = stubGitWindow();
    git.getOpenPrForBranch.mockResolvedValueOnce({
      prUrl: null,
      prNumber: null,
      title: null,
      headRefName: null,
    });
    const onNotice = vi.fn();

    await runHistoryLaneAction({ actionId: "open_pr", laneId: "lane-1", onNotice });

    expect(onNotice).toHaveBeenCalledWith("No open PR found for this lane branch");
  });

  it("stashes with a user message and optional untracked files", async () => {
    const { git, confirm, prompt } = stubGitWindow();

    await runHistoryLaneAction({
      actionId: "stash",
      laneId: "lane-1",
    });

    expect(prompt).toHaveBeenCalledWith("Stash message", "ADE history stash");
    expect(confirm).toHaveBeenCalledWith("Include untracked files in the stash?");
    expect(git.stashPush).toHaveBeenCalledWith({
      laneId: "lane-1",
      message: "checkpoint",
      includeUntracked: true,
    });
  });

  it("applies, pops, drops, and clears branch stashes through latest-stash actions", async () => {
    const { git } = stubGitWindow();

    await runHistoryLaneAction({ actionId: "stash_apply_latest", laneId: "lane-1" });
    await runHistoryLaneAction({ actionId: "stash_pop_latest", laneId: "lane-1" });
    await runHistoryLaneAction({ actionId: "stash_drop_latest", laneId: "lane-1" });
    await runHistoryLaneAction({ actionId: "stash_clear", laneId: "lane-1" });

    expect(git.stashApply).toHaveBeenCalledWith({
      laneId: "lane-1",
      stashRef: "stash@{0}",
      stashOid: "oid-0",
    });
    expect(git.stashPop).toHaveBeenCalledWith({
      laneId: "lane-1",
      stashRef: "stash@{0}",
      stashOid: "oid-0",
    });
    expect(git.stashDrop).toHaveBeenCalledWith({
      laneId: "lane-1",
      stashRef: "stash@{0}",
      stashOid: "oid-0",
    });
    expect(git.stashClear).toHaveBeenCalledWith({ laneId: "lane-1" });
  });

  it("runs merge and rebase continuation actions through the existing git APIs", async () => {
    const { git, confirm } = stubGitWindow();

    await runHistoryLaneAction({ actionId: "rebase_continue", laneId: "lane-1" });
    await runHistoryLaneAction({ actionId: "rebase_abort", laneId: "lane-1" });
    await runHistoryLaneAction({ actionId: "merge_continue", laneId: "lane-1" });
    await runHistoryLaneAction({ actionId: "merge_abort", laneId: "lane-1" });

    expect(git.rebaseContinue).toHaveBeenCalledWith("lane-1");
    expect(git.rebaseAbort).toHaveBeenCalledWith("lane-1");
    expect(git.mergeContinue).toHaveBeenCalledWith("lane-1");
    expect(git.mergeAbort).toHaveBeenCalledWith("lane-1");
    expect(confirm).toHaveBeenCalledWith("Abort the in-progress rebase?");
    expect(confirm).toHaveBeenCalledWith("Abort the in-progress merge?");
  });

  it("syncs merge and rebase actions through the shared sync command", async () => {
    const { git } = stubGitWindow();

    await runHistoryLaneAction({ actionId: "merge_upstream", laneId: "lane-1" });
    await runHistoryLaneAction({ actionId: "rebase_upstream", laneId: "lane-1" });

    expect(git.sync).toHaveBeenNthCalledWith(1, { laneId: "lane-1", mode: "merge" });
    expect(git.sync).toHaveBeenNthCalledWith(2, { laneId: "lane-1", mode: "rebase" });
  });
});
