import path from "node:path";
import { runGit, runGitOrThrow } from "./git";
import type {
  GitActionResult,
  GitCherryPickArgs,
  GitCommitArgs,
  GitCommitSummary,
  GitFileActionArgs,
  GitPushArgs,
  GitRevertArgs,
  GitStashPushArgs,
  GitStashRefArgs,
  GitStashSummary,
  GitSyncArgs,
  GitSyncMode
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { createLaneService } from "../lanes/laneService";
import type { createOperationService } from "../history/operationService";

type LaneInfo = {
  baseRef: string;
  branchRef: string;
  worktreePath: string;
};

function ensureRelativeRepoPath(relPath: string): string {
  const normalized = relPath.trim().replace(/\\/g, "/");
  if (!normalized.length) throw new Error("File path is required");
  if (normalized.includes("\0")) throw new Error("Invalid file path");
  if (path.isAbsolute(normalized)) throw new Error("Path must be repo-relative");
  if (normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    throw new Error("Path escapes lane root");
  }
  return normalized;
}

async function getHeadSha(worktreePath: string): Promise<string | null> {
  const res = await runGit(["rev-parse", "HEAD"], { cwd: worktreePath, timeoutMs: 8_000 });
  if (res.exitCode !== 0) return null;
  const sha = res.stdout.trim();
  return sha.length ? sha : null;
}

function parseDelimited(line: string): string[] {
  return line.split("\u001f");
}

async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  const res = await runGit(["status", "--porcelain=v1"], { cwd: worktreePath, timeoutMs: 8_000 });
  if (res.exitCode !== 0) return false;
  return res.stdout.trim().length > 0;
}

async function isUntrackedFile(worktreePath: string, relPath: string): Promise<boolean> {
  const res = await runGit(["status", "--porcelain=v1", "--", relPath], { cwd: worktreePath, timeoutMs: 8_000 });
  if (res.exitCode !== 0) return false;
  const lines = res.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.some((line) => line.startsWith("??"));
}

export function createGitOperationsService({
  laneService,
  operationService,
  logger,
  onHeadChanged,
  onWorktreeChanged
}: {
  laneService: ReturnType<typeof createLaneService>;
  operationService: ReturnType<typeof createOperationService>;
  logger: Logger;
  onHeadChanged?: (args: {
    laneId: string;
    reason: string;
    operationId: string;
    preHeadSha: string | null;
    postHeadSha: string | null;
  }) => void;
  onWorktreeChanged?: (args: {
    laneId: string;
    reason: string;
    operationId: string;
    preHeadSha: string | null;
    postHeadSha: string | null;
  }) => void;
}) {
  const runLaneOperation = async <T>({
    laneId,
    kind,
    reason,
    metadata,
    fn
  }: {
    laneId: string;
    kind: string;
    reason: string;
    metadata?: Record<string, unknown>;
    fn: (lane: LaneInfo) => Promise<T>;
  }): Promise<{ result: T; action: GitActionResult }> => {
    const lane = laneService.getLaneBaseAndBranch(laneId);
    const preHeadSha = await getHeadSha(lane.worktreePath);
    const operation = operationService.start({
      laneId,
      kind,
      preHeadSha,
      metadata: {
        reason,
        branchRef: lane.branchRef,
        baseRef: lane.baseRef,
        ...(metadata ?? {})
      }
    });

    try {
      const result = await fn(lane);
      const postHeadSha = await getHeadSha(lane.worktreePath);
      operationService.finish({
        operationId: operation.operationId,
        status: "succeeded",
        postHeadSha
      });

      if (onWorktreeChanged) {
        try {
          onWorktreeChanged({
            laneId,
            reason,
            operationId: operation.operationId,
            preHeadSha,
            postHeadSha
          });
        } catch {
          // Never fail git operation due to callback issues.
        }
      }

      if (preHeadSha !== postHeadSha && onHeadChanged) {
        try {
          onHeadChanged({
            laneId,
            reason,
            operationId: operation.operationId,
            preHeadSha,
            postHeadSha
          });
        } catch {
          // Never fail git operation due to callback issues.
        }
      }

      return {
        result,
        action: {
          operationId: operation.operationId,
          preHeadSha,
          postHeadSha
        }
      };
    } catch (error) {
      const postHeadSha = await getHeadSha(lane.worktreePath);
      const message = error instanceof Error ? error.message : String(error);
      operationService.finish({
        operationId: operation.operationId,
        status: "failed",
        postHeadSha,
        metadataPatch: { error: message }
      });
      logger.warn("git.operation_failed", { laneId, kind, reason, error: message });
      throw error;
    }
  };

  const maybeFetchAndSync = async (lane: LaneInfo, mode: GitSyncMode, baseRef: string): Promise<void> => {
    const dirty = await isWorktreeDirty(lane.worktreePath);
    if (dirty) {
      throw new Error("Lane has uncommitted changes. Commit or stash before sync.");
    }

    await runGitOrThrow(["fetch", "--prune"], { cwd: lane.worktreePath, timeoutMs: 60_000 });

    if (mode === "rebase") {
      await runGitOrThrow(["rebase", baseRef], { cwd: lane.worktreePath, timeoutMs: 60_000 });
      return;
    }

    await runGitOrThrow(["merge", "--no-edit", baseRef], { cwd: lane.worktreePath, timeoutMs: 60_000 });
  };

  return {
    async stageFile(args: GitFileActionArgs): Promise<GitActionResult> {
      const filePath = ensureRelativeRepoPath(args.path);
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_stage",
        reason: "stage_file",
        metadata: { path: filePath },
        fn: async (lane) => {
          await runGitOrThrow(["add", "--", filePath], { cwd: lane.worktreePath, timeoutMs: 15_000 });
        }
      });
      return action;
    },

    async unstageFile(args: GitFileActionArgs): Promise<GitActionResult> {
      const filePath = ensureRelativeRepoPath(args.path);
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_unstage",
        reason: "unstage_file",
        metadata: { path: filePath },
        fn: async (lane) => {
          await runGitOrThrow(["restore", "--staged", "--", filePath], { cwd: lane.worktreePath, timeoutMs: 15_000 });
        }
      });
      return action;
    },

    async discardFile(args: GitFileActionArgs): Promise<GitActionResult> {
      const filePath = ensureRelativeRepoPath(args.path);
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_discard",
        reason: "discard_file",
        metadata: { path: filePath },
        fn: async (lane) => {
          const untracked = await isUntrackedFile(lane.worktreePath, filePath);
          if (untracked) {
            await runGitOrThrow(["clean", "-f", "--", filePath], { cwd: lane.worktreePath, timeoutMs: 15_000 });
            return;
          }
          await runGitOrThrow(["restore", "--worktree", "--", filePath], { cwd: lane.worktreePath, timeoutMs: 15_000 });
        }
      });
      return action;
    },

    async restoreStagedFile(args: GitFileActionArgs): Promise<GitActionResult> {
      const filePath = ensureRelativeRepoPath(args.path);
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_restore_staged",
        reason: "restore_staged_file",
        metadata: { path: filePath },
        fn: async (lane) => {
          await runGitOrThrow(["restore", "--staged", "--worktree", "--source=HEAD", "--", filePath], {
            cwd: lane.worktreePath,
            timeoutMs: 15_000
          });
        }
      });
      return action;
    },

    async commit(args: GitCommitArgs): Promise<GitActionResult> {
      const message = args.message.trim();
      if (!message.length) {
        throw new Error("Commit message is required");
      }

      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: args.amend ? "git_commit_amend" : "git_commit",
        reason: args.amend ? "amend_commit" : "commit",
        metadata: { amend: Boolean(args.amend), message },
        fn: async (lane) => {
          const cmd = args.amend
            ? ["commit", "--amend", "-m", message]
            : ["commit", "-m", message];
          await runGitOrThrow(cmd, { cwd: lane.worktreePath, timeoutMs: 30_000 });
        }
      });
      return action;
    },

    async listRecentCommits(args: { laneId: string; limit?: number }): Promise<GitCommitSummary[]> {
      const lane = laneService.getLaneBaseAndBranch(args.laneId);
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(100, Math.floor(args.limit))) : 30;
      const out = await runGitOrThrow(
        ["log", `-n${limit}`, "--date=iso-strict", "--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s"],
        { cwd: lane.worktreePath, timeoutMs: 15_000 }
      );

      const rows = out
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line): GitCommitSummary | null => {
          const [sha, shortSha, authorName, authoredAt, subject] = parseDelimited(line);
          if (!sha || !shortSha) return null;
          return {
            sha,
            shortSha,
            authorName: authorName ?? "",
            authoredAt: authoredAt ?? "",
            subject: subject ?? ""
          };
        })
        .filter((entry): entry is GitCommitSummary => entry != null);

      return rows;
    },

    async revertCommit(args: GitRevertArgs): Promise<GitActionResult> {
      const commitSha = args.commitSha.trim();
      if (!commitSha.length) throw new Error("Commit SHA is required");
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_revert",
        reason: "revert_commit",
        metadata: { commitSha },
        fn: async (lane) => {
          await runGitOrThrow(["revert", "--no-edit", commitSha], { cwd: lane.worktreePath, timeoutMs: 60_000 });
        }
      });
      return action;
    },

    async cherryPickCommit(args: GitCherryPickArgs): Promise<GitActionResult> {
      const commitSha = args.commitSha.trim();
      if (!commitSha.length) throw new Error("Commit SHA is required");
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_cherry_pick",
        reason: "cherry_pick_commit",
        metadata: { commitSha },
        fn: async (lane) => {
          await runGitOrThrow(["cherry-pick", commitSha], { cwd: lane.worktreePath, timeoutMs: 60_000 });
        }
      });
      return action;
    },

    async stashPush(args: GitStashPushArgs): Promise<GitActionResult> {
      const message = args.message?.trim();
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_stash_push",
        reason: "stash_push",
        metadata: {
          includeUntracked: Boolean(args.includeUntracked),
          message: message ?? null
        },
        fn: async (lane) => {
          const cmd = ["stash", "push"];
          if (args.includeUntracked) cmd.push("-u");
          if (message) {
            cmd.push("-m", message);
          }
          await runGitOrThrow(cmd, { cwd: lane.worktreePath, timeoutMs: 30_000 });
        }
      });
      return action;
    },

    async listStashes(args: { laneId: string }): Promise<GitStashSummary[]> {
      const lane = laneService.getLaneBaseAndBranch(args.laneId);
      const out = await runGitOrThrow(["stash", "list", "--date=iso-strict", "--format=%gd%x1f%ci%x1f%gs"], {
        cwd: lane.worktreePath,
        timeoutMs: 15_000
      });
      return out
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line): GitStashSummary | null => {
          const [ref, createdAt, subject] = parseDelimited(line);
          if (!ref) return null;
          return {
            ref,
            createdAt: createdAt && createdAt.length ? createdAt : null,
            subject: subject ?? ""
          };
        })
        .filter((entry): entry is GitStashSummary => entry != null);
    },

    async stashApply(args: GitStashRefArgs): Promise<GitActionResult> {
      const stashRef = args.stashRef.trim();
      if (!stashRef.length) throw new Error("stashRef is required");
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_stash_apply",
        reason: "stash_apply",
        metadata: { stashRef },
        fn: async (lane) => {
          await runGitOrThrow(["stash", "apply", stashRef], { cwd: lane.worktreePath, timeoutMs: 30_000 });
        }
      });
      return action;
    },

    async stashPop(args: GitStashRefArgs): Promise<GitActionResult> {
      const stashRef = args.stashRef.trim();
      if (!stashRef.length) throw new Error("stashRef is required");
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_stash_pop",
        reason: "stash_pop",
        metadata: { stashRef },
        fn: async (lane) => {
          await runGitOrThrow(["stash", "pop", stashRef], { cwd: lane.worktreePath, timeoutMs: 30_000 });
        }
      });
      return action;
    },

    async stashDrop(args: GitStashRefArgs): Promise<GitActionResult> {
      const stashRef = args.stashRef.trim();
      if (!stashRef.length) throw new Error("stashRef is required");
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_stash_drop",
        reason: "stash_drop",
        metadata: { stashRef },
        fn: async (lane) => {
          await runGitOrThrow(["stash", "drop", stashRef], { cwd: lane.worktreePath, timeoutMs: 30_000 });
        }
      });
      return action;
    },

    async fetch(args: { laneId: string }): Promise<GitActionResult> {
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_fetch",
        reason: "fetch",
        fn: async (lane) => {
          await runGitOrThrow(["fetch", "--prune"], { cwd: lane.worktreePath, timeoutMs: 60_000 });
        }
      });
      return action;
    },

    async sync(args: GitSyncArgs): Promise<GitActionResult> {
      const mode = args.mode ?? "merge";
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: mode === "rebase" ? "git_sync_rebase" : "git_sync_merge",
        reason: mode === "rebase" ? "sync_rebase" : "sync_merge",
        metadata: { mode, baseRefOverride: args.baseRef ?? null },
        fn: async (lane) => {
          const targetBase = args.baseRef?.trim() || lane.baseRef;
          await maybeFetchAndSync(lane, mode, targetBase);
        }
      });
      return action;
    },

    async push(args: GitPushArgs): Promise<GitActionResult> {
      const forceWithLease = Boolean(args.forceWithLease);
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: forceWithLease ? "git_push_force_with_lease" : "git_push",
        reason: forceWithLease ? "push_force_with_lease" : "push",
        metadata: { forceWithLease },
        fn: async (lane) => {
          const upstreamRes = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
            cwd: lane.worktreePath,
            timeoutMs: 10_000
          });

          if (upstreamRes.exitCode === 0) {
            const cmd = ["push"];
            if (forceWithLease) cmd.push("--force-with-lease");
            await runGitOrThrow(cmd, { cwd: lane.worktreePath, timeoutMs: 60_000 });
            return;
          }

          const cmd = ["push", "-u", "origin", lane.branchRef];
          if (forceWithLease) {
            cmd.push("--force-with-lease");
          }
          await runGitOrThrow(cmd, { cwd: lane.worktreePath, timeoutMs: 60_000 });
        }
      });
      return action;
    }
  };
}
