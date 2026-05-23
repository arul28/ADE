import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitCommitSummary } from "../../../shared/types";
import {
  buildCommitContextActions,
  groupCommitContextActions,
  runHistoryGitAction,
} from "./historyGitActions";

const commit: GitCommitSummary = {
  sha: "abc123456789",
  shortSha: "abc1234",
  parents: ["parent1"],
  authorName: "Ari",
  authoredAt: "2026-05-22T00:00:00Z",
  subject: "Update history actions",
  pushed: false,
};

function stubWindow(promptValues: string[] = ["v1.2.3", "release tag"]) {
  const git = {
    checkoutBranch: vi.fn(async () => ({ operationId: "branch", preHeadSha: "a", postHeadSha: "a" })),
    createTag: vi.fn(async () => ({ operationId: "tag", preHeadSha: "a", postHeadSha: "a" })),
    cherryPickCommit: vi.fn(async () => ({ operationId: "pick", preHeadSha: "a", postHeadSha: "b" })),
    revertCommit: vi.fn(async () => ({ operationId: "revert", preHeadSha: "a", postHeadSha: "b" })),
    resetToCommit: vi.fn(async () => ({ operationId: "reset", preHeadSha: "a", postHeadSha: "b" })),
    listCommitFiles: vi.fn(async () => ["src/history.ts", "src/empty.ts"]),
    getOriginRemote: vi.fn(async (): Promise<{ remoteUrl: string | null; branch: string | null }> => ({
      remoteUrl: "git@github.com:arul28/ADE.git",
      branch: "cursor/history-tab",
    })),
  };
  const lanes = {
    create: vi.fn(async () => ({
      id: "lane-new",
      name: "History lane",
    })),
  };
  const diff = {
    getFilePatch: vi.fn(async ({ path }: { path: string }) => ({
      path,
      mode: "commit",
      patch: path === "src/history.ts"
        ? `diff --git a/${path} b/${path}\n@@ -1 +1 @@\n-old\n+new\n`
        : "",
    })),
  };
  const prompt = vi.fn((_: string, fallback?: string) => promptValues.shift() ?? fallback ?? null);
  const confirm = vi.fn(() => true);

  vi.stubGlobal("window", {
    ade: {
      git,
      lanes,
      app: {
        openExternal: vi.fn(async () => undefined),
        writeClipboardText: vi.fn(async () => undefined),
      },
      diff,
    },
    prompt,
    confirm,
    setTimeout: vi.fn(),
  });

  return { git, lanes, prompt, confirm, diff };
}

describe("history git actions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("includes branch, tag, reset, and commit inspection actions for a worktree", () => {
    const actions = buildCommitContextActions({
      commit,
      isHead: false,
      hasWorktree: true,
    });
    const actionIds = actions.map((action) => action.id);

    expect(actionIds).toEqual(expect.arrayContaining([
      "create_branch",
      "create_lane",
      "create_tag",
      "cherry_pick",
      "revert",
      "reset_soft",
      "reset_mixed",
      "reset_hard",
      "open_commit",
      "copy_commit_link",
      "copy_patch",
      "compare_parent",
      "view_files",
    ]));
    expect(groupCommitContextActions(actions).map((group) => group.id)).toEqual([
      "inspect",
      "create",
      "apply",
      "share",
    ]);
  });

  it("disables destructive commit actions when the lane worktree is unavailable", () => {
    const actions = buildCommitContextActions({
      commit,
      isHead: false,
      hasWorktree: false,
    });

    for (const id of ["cherry_pick", "revert", "reset_hard"] as const) {
      expect(actions.find((action) => action.id === id)).toMatchObject({
        disabled: true,
        disabledReason: "Lane worktree is missing",
      });
    }
  });

  it("disables cherry-pick when the selected commit is HEAD", () => {
    const actions = buildCommitContextActions({
      commit,
      isHead: true,
      hasWorktree: true,
    });

    expect(actions.find((action) => action.id === "cherry_pick")).toMatchObject({
      disabled: true,
      disabledReason: "Cannot cherry-pick HEAD",
    });
  });

  it("creates tags at the selected commit", async () => {
    const { git, prompt } = stubWindow();

    await runHistoryGitAction({
      actionId: "create_tag",
      laneId: "lane-1",
      commit,
    });

    expect(prompt).toHaveBeenNthCalledWith(1, "Create tag at abc1234");
    expect(prompt).toHaveBeenNthCalledWith(2, "Tag message (optional)");
    expect(git.createTag).toHaveBeenCalledWith({
      laneId: "lane-1",
      tagName: "v1.2.3",
      commitSha: commit.sha,
      message: "release tag",
    });
  });

  it("creates a new ADE lane at the selected commit", async () => {
    const { git, lanes, prompt } = stubWindow(["history/new-lane", "History lane"]);
    const navigate = vi.fn();

    await runHistoryGitAction({
      actionId: "create_lane",
      laneId: "lane-1",
      commit,
      navigate,
    });

    expect(prompt).toHaveBeenNthCalledWith(
      1,
      "Create lane branch at abc1234",
      "history/abc1234-update-history-actions",
    );
    expect(prompt).toHaveBeenNthCalledWith(2, "Lane name", "history/new-lane");
    expect(git.getOriginRemote).toHaveBeenCalledWith({ laneId: "lane-1" });
    expect(lanes.create).toHaveBeenCalledWith({
      name: "History lane",
      parentLaneId: "lane-1",
      branchName: "history/new-lane",
      startPoint: commit.sha,
      baseBranch: "cursor/history-tab",
    });
    expect(navigate).toHaveBeenCalledWith("/lanes?laneId=lane-new");
  });

  it("resets to the selected commit with explicit confirmation and mode", async () => {
    const { git, confirm } = stubWindow();

    await runHistoryGitAction({
      actionId: "reset_hard",
      laneId: "lane-1",
      commit,
    });

    expect(confirm).toHaveBeenCalledWith(
      "Reset this lane to abc1234? This discards uncommitted worktree changes.",
    );
    expect(git.resetToCommit).toHaveBeenCalledWith({
      laneId: "lane-1",
      commitSha: commit.sha,
      mode: "hard",
    });
  });

  it("opens and copies GitHub commit links from the selected commit", async () => {
    const { git } = stubWindow();
    const app = window.ade.app;

    await runHistoryGitAction({
      actionId: "open_commit",
      laneId: "lane-1",
      commit,
    });
    await runHistoryGitAction({
      actionId: "copy_commit_link",
      laneId: "lane-1",
      commit,
    });

    const expectedUrl = `https://github.com/arul28/ADE/commit/${commit.sha}`;
    expect(git.getOriginRemote).toHaveBeenCalledWith({ laneId: "lane-1" });
    expect(app.openExternal).toHaveBeenCalledWith(expectedUrl);
    expect(app.writeClipboardText).toHaveBeenCalledWith(expectedUrl);
  });

  it("copies commit fields through the ADE clipboard bridge", async () => {
    stubWindow();
    const app = window.ade.app;

    await runHistoryGitAction({
      actionId: "copy_sha",
      laneId: "lane-1",
      commit,
    });
    await runHistoryGitAction({
      actionId: "copy_subject",
      laneId: "lane-1",
      commit,
    });

    expect(app.writeClipboardText).toHaveBeenNthCalledWith(1, commit.sha);
    expect(app.writeClipboardText).toHaveBeenNthCalledWith(2, commit.subject);
  });

  it("copies a commit patch through existing diff APIs", async () => {
    const { git, diff } = stubWindow();
    const app = window.ade.app;
    const onNotice = vi.fn();

    await runHistoryGitAction({
      actionId: "copy_patch",
      laneId: "lane-1",
      commit,
      onNotice,
    });

    expect(git.listCommitFiles).toHaveBeenCalledWith({
      laneId: "lane-1",
      commitSha: commit.sha,
    });
    expect(diff.getFilePatch).toHaveBeenCalledWith({
      laneId: "lane-1",
      path: "src/history.ts",
      mode: "commit",
      compareRef: commit.sha,
      compareTo: "parent",
    });
    expect(app.writeClipboardText).toHaveBeenCalledWith(
      expect.stringContaining("diff --git a/src/history.ts b/src/history.ts"),
    );
    expect(onNotice).toHaveBeenCalledWith("Patch copied (1 file)");
  });

  it("caps copied patch fanout for large commits", async () => {
    const { git, diff } = stubWindow();
    const files = Array.from({ length: 55 }, (_, index) => `src/file-${index}.ts`);
    const onNotice = vi.fn();
    git.listCommitFiles.mockResolvedValueOnce(files);
    diff.getFilePatch.mockImplementation(async ({ path }: { path: string }) => ({
      path,
      mode: "commit",
      patch: `diff --git a/${path} b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
    }));

    await runHistoryGitAction({
      actionId: "copy_patch",
      laneId: "lane-1",
      commit,
      onNotice,
    });

    expect(diff.getFilePatch).toHaveBeenCalledTimes(50);
    expect(diff.getFilePatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: "src/file-54.ts" }),
    );
    expect(onNotice).toHaveBeenCalledWith("Patch copied (50 files, 5 skipped)");
  });

  it("deep-links Lanes git actions to the selected commit", async () => {
    stubWindow();
    const navigate = vi.fn();

    await runHistoryGitAction({
      actionId: "checkout",
      laneId: "lane-1",
      commit,
      navigate,
    });
    await runHistoryGitAction({
      actionId: "open_lane_git",
      laneId: "lane-1",
      commit,
      navigate,
    });
    await runHistoryGitAction({
      actionId: "compare_parent",
      laneId: "lane-1",
      commit,
      navigate,
    });
    await runHistoryGitAction({
      actionId: "view_files",
      laneId: "lane-1",
      commit,
      navigate,
    });

    expect(navigate).toHaveBeenCalledTimes(4);
    expect(navigate).toHaveBeenCalledWith(
      "/lanes?laneId=lane-1&focus=single&commitSha=abc123456789",
    );
  });

  it("reports when commit links are unavailable for non-GitHub remotes", async () => {
    const { git } = stubWindow();
    git.getOriginRemote.mockResolvedValueOnce({
      remoteUrl: "ssh://git@example.test/ade.git",
      branch: "history",
    });
    const onNotice = vi.fn();

    await runHistoryGitAction({
      actionId: "open_commit",
      laneId: "lane-1",
      commit,
      onNotice,
    });

    expect(onNotice).toHaveBeenCalledWith("No GitHub remote found for this commit");
  });
});
