import path from "node:path";
import { getHeadSha, runGit, runGitOrThrow } from "./git";
import { detectConflictKind, parseNameOnly } from "./gitConflictState";
import type {
  GitActionResult,
  GitBatchFileActionArgs,
  GitBranchSummary,
  GitCherryPickArgs,
  GitCommitArgs,
  GitGenerateCommitMessageArgs,
  GitGenerateCommitMessageResult,
  GitCommitSummary,
  GitConflictState,
  GitFileHistoryEntry,
  GitGetCommitMessageArgs,
  GitGetFileHistoryArgs,
  GitListCommitFilesArgs,
  GitFileActionArgs,
  GitPushArgs,
  GitRecommendedAction,
  GitRevertArgs,
  GitStashPushArgs,
  GitStashRefArgs,
  GitStashSummary,
  GitSyncArgs,
  GitSyncMode,
  GitUpstreamSyncStatus,
  LaneType
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { createLaneService } from "../lanes/laneService";
import type { createOperationService } from "../history/operationService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import { isRecord } from "../shared/utils";

type LaneInfo = {
  baseRef: string;
  branchRef: string;
  worktreePath: string;
  laneType: LaneType;
};

type CommitMessagePromptContext = {
  hasStagedChanges: boolean;
  stagedFiles: string;
  headFiles: string;
  diffSnippet: string;
};

type CachedReadEntry<T> = {
  expiresAt: number;
  value?: T;
  promise?: Promise<T>;
};

function localBranchNameFromRemoteRef(ref: string): string {
  const normalized = ref.trim();
  const slashIndex = normalized.indexOf("/");
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
}

function ensureRelativeRepoPath(relPath: string): string {
  const normalized = relPath.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized.length) throw new Error("File path is required");
  if (normalized.includes("\0")) throw new Error("Invalid file path");
  if (path.isAbsolute(normalized)) throw new Error("Path must be repo-relative");
  if (normalized.startsWith(":")) throw new Error("Pathspec magic is not allowed");
  if (normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    throw new Error("Path escapes lane root");
  }
  if (normalized === ".") throw new Error("Path must point to a file");
  return normalized;
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

async function getAbsoluteGitDir(worktreePath: string): Promise<string | null> {
  const res = await runGit(["rev-parse", "--absolute-git-dir"], { cwd: worktreePath, timeoutMs: 8_000 });
  if (res.exitCode !== 0) return null;
  const dir = res.stdout.trim();
  return dir.length ? dir : null;
}

export function createGitOperationsService({
  laneService,
  operationService,
  projectConfigService,
  aiIntegrationService,
  logger,
  onHeadChanged,
  onWorktreeChanged
}: {
  laneService: ReturnType<typeof createLaneService>;
  operationService: ReturnType<typeof createOperationService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  aiIntegrationService: ReturnType<typeof createAiIntegrationService>;
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
  const laneReadCache = new Map<string, CachedReadEntry<unknown>>();

  function invalidateLaneReadCache(laneId: string): void {
    const needle = `:${laneId}:`;
    for (const key of laneReadCache.keys()) {
      if (key.includes(needle)) laneReadCache.delete(key);
    }
  }

  async function readLaneCached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const cached = laneReadCache.get(key) as CachedReadEntry<T> | undefined;
    if (cached?.promise) return cached.promise;
    if (cached && cached.value !== undefined && cached.expiresAt > now) {
      return cached.value;
    }

    const promise = load()
      .then((value) => {
        laneReadCache.set(key, {
          value,
          expiresAt: Date.now() + ttlMs,
        });
        return value;
      })
      .catch((error) => {
        laneReadCache.delete(key);
        throw error;
      });

    laneReadCache.set(key, {
      expiresAt: now + ttlMs,
      promise,
    });
    return promise;
  }

  function extractEffectiveAiConfig(): Record<string, unknown> {
    const snapshot = projectConfigService.get();
    return isRecord(snapshot.effective.ai) ? snapshot.effective.ai : {};
  }

  function getConfiguredCommitMessageModel(): string | null {
    const aiConfig = extractEffectiveAiConfig();
    const overrides = isRecord(aiConfig.featureModelOverrides) ? aiConfig.featureModelOverrides : {};
    const modelId = typeof overrides.commit_messages === "string" ? overrides.commit_messages.trim() : "";
    return modelId.length ? modelId : null;
  }

  function normalizeCommitMessage(rawText: string): string {
    const firstLine = rawText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "";
    const cleaned = firstLine
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/^commit message\s*[:\-]\s*/i, "")
      .replace(/^subject\s*[:\-]\s*/i, "")
      .replace(/^[-*]\s+/, "")
      .trim()
      .replace(/\.$/, "");
    if (!cleaned.length) {
      throw new Error("AI returned an empty commit message.");
    }
    return cleaned.slice(0, 72).trimEnd();
  }

  async function assertCommitMessageGenerationEnabled(): Promise<string> {
    if (!aiIntegrationService.getFeatureFlag("commit_messages")) {
      throw new Error("AI commit messages are off. Enable Commit Messages in Settings or type a commit message manually.");
    }

    const model = getConfiguredCommitMessageModel();
    if (!model) {
      throw new Error("Choose a Commit Messages model in Settings or type a commit message manually.");
    }

    const aiStatus = await aiIntegrationService.getStatus().catch(() => null);
    if (aiStatus?.availableModelIds?.length && !aiStatus.availableModelIds.includes(model)) {
      throw new Error(`The configured Commit Messages model '${model}' is not currently available. Update Settings or type a commit message manually.`);
    }

    return model;
  }

  async function loadCommitMessagePromptContext(lane: LaneInfo): Promise<CommitMessagePromptContext> {
    const [stagedFilesRes, headFilesRes] = await Promise.all([
      runGit(["diff", "--cached", "--name-status", "--find-renames"], { cwd: lane.worktreePath, timeoutMs: 10_000 }),
      runGit(["show", "--name-status", "--format=", "--find-renames", "HEAD"], { cwd: lane.worktreePath, timeoutMs: 10_000 }),
    ]);

    const stagedFiles = stagedFilesRes.exitCode === 0 ? stagedFilesRes.stdout.trim() : "";
    const headFiles = headFilesRes.exitCode === 0 ? headFilesRes.stdout.trim() : "";
    const hasStagedChanges = stagedFiles.length > 0;

    // Fetch a truncated diff so the model can see actual code changes, not just filenames.
    const DIFF_CHAR_LIMIT = 8_000;
    const diffCmd = hasStagedChanges
      ? ["diff", "--cached", "--no-color", "-U2", "--find-renames"]
      : ["show", "--no-color", "-U2", "--find-renames", "--format=", "HEAD"];
    const diffRes = await runGit(diffCmd, { cwd: lane.worktreePath, timeoutMs: 10_000 });
    let diffSnippet = diffRes.exitCode === 0 ? diffRes.stdout.trim() : "";
    if (diffSnippet.length > DIFF_CHAR_LIMIT) {
      diffSnippet = diffSnippet.slice(0, DIFF_CHAR_LIMIT) + "\n... (diff truncated)";
    }

    return {
      hasStagedChanges,
      stagedFiles,
      headFiles,
      diffSnippet,
    };
  }

  function buildCommitMessagePrompt(_lane: LaneInfo, args: GitGenerateCommitMessageArgs, context: CommitMessagePromptContext): string {
    const changedFiles = context.hasStagedChanges ? context.stagedFiles : context.headFiles;
    const parts = [
      "Write a single git commit subject based on the diff below.",
      "Return plain text only.",
      "Rules:",
      "- one line only",
      "- imperative mood",
      "- concise and specific",
      "- fewer than 10 words",
      "- 72 characters or fewer",
      "- no quotes",
      "- no trailing period",
      "- base the message on the actual code changes, not just filenames",
      "",
      `Amend mode: ${args.amend ? "yes" : "no"}`,
      "",
      "Changed files:",
      changedFiles || "(none)",
    ];
    if (context.diffSnippet) {
      parts.push("", "Diff:", context.diffSnippet);
    }
    return parts.join("\n");
  }

  function toCommitMessageGenerationError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (/No AI provider is available/i.test(message)) {
      return new Error("No AI provider is available for Commit Messages. Configure the model/provider in Settings or type a commit message manually.");
    }
    return error instanceof Error ? error : new Error(message);
  }

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
    invalidateLaneReadCache(laneId);
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
    } finally {
      invalidateLaneReadCache(laneId);
    }
  };

  const maybeFetchAndSync = async (lane: LaneInfo, mode: GitSyncMode, baseRef: string): Promise<void> => {
    const dirty = await isWorktreeDirty(lane.worktreePath);
    if (dirty) {
      throw new Error("Lane has uncommitted changes. Commit or stash before sync.");
    }

    await runGitOrThrow(["fetch", "--prune"], { cwd: lane.worktreePath, timeoutMs: 60_000 });

    const treatConflictAsSuccess = async (expected: Exclude<GitConflictState["kind"], null>): Promise<boolean> => {
      const gitDir = await getAbsoluteGitDir(lane.worktreePath);
      if (!gitDir) return false;
      const kind = detectConflictKind(gitDir);
      if (kind !== expected) return false;
      const unmergedRes = await runGit(["diff", "--name-only", "--diff-filter=U"], {
        cwd: lane.worktreePath,
        timeoutMs: 10_000
      });
      if (unmergedRes.exitCode !== 0) return false;
      return parseNameOnly(unmergedRes.stdout).length > 0;
    };

    if (mode === "rebase") {
      const res = await runGit(["rebase", baseRef], { cwd: lane.worktreePath, timeoutMs: 60_000 });
      if (res.exitCode === 0) return;
      if (await treatConflictAsSuccess("rebase")) {
        logger.info("git.sync_rebase_conflict", { laneRef: lane.branchRef, baseRef });
        return;
      }
      throw new Error((res.stderr || res.stdout).trim() || "Failed to rebase");
    }

    const res = await runGit(["merge", "--no-edit", baseRef], { cwd: lane.worktreePath, timeoutMs: 60_000 });
    if (res.exitCode === 0) return;
    if (await treatConflictAsSuccess("merge")) {
      logger.info("git.sync_merge_conflict", { laneRef: lane.branchRef, baseRef });
      return;
    }
    throw new Error((res.stderr || res.stdout).trim() || "Failed to merge");
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

    async stageAll(args: GitBatchFileActionArgs): Promise<GitActionResult> {
      const fileCount = Array.isArray(args.paths) ? args.paths.length : 0;
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_stage_all",
        reason: "stage_all",
        metadata: { count: fileCount },
        fn: async (lane) => {
          // Stage against current worktree state to avoid stale or partial path lists.
          await runGitOrThrow(["add", "-A", "--", "."], { cwd: lane.worktreePath, timeoutMs: 30_000 });
        }
      });
      return action;
    },

    async unstageAll(args: GitBatchFileActionArgs): Promise<GitActionResult> {
      const filePaths = args.paths.map(ensureRelativeRepoPath);
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_unstage_all",
        reason: "unstage_all",
        metadata: { count: filePaths.length },
        fn: async (lane) => {
          if (filePaths.length === 0) return;
          await runGitOrThrow(["restore", "--staged", "--", ...filePaths], { cwd: lane.worktreePath, timeoutMs: 30_000 });
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

    async generateCommitMessage(args: GitGenerateCommitMessageArgs): Promise<GitGenerateCommitMessageResult> {
      const model = await assertCommitMessageGenerationEnabled();
      const lane = laneService.getLaneBaseAndBranch(args.laneId);
      const promptContext = await loadCommitMessagePromptContext(lane);
      if (!promptContext.hasStagedChanges && !args.amend) {
        throw new Error("Stage changes before generating a commit message.");
      }
      const prompt = buildCommitMessagePrompt(lane, args, promptContext);

      try {
        const result = await aiIntegrationService.generateCommitMessage({
          cwd: lane.worktreePath,
          prompt,
          model
        });
        return {
          message: normalizeCommitMessage(result.text),
          model: result.model ?? model
        };
      } catch (error) {
        throw toCommitMessageGenerationError(error);
      }
    },

    async listRecentCommits(args: { laneId: string; limit?: number }): Promise<GitCommitSummary[]> {
      const laneId = args.laneId.trim();
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(200, Math.floor(args.limit))) : 30;
      return readLaneCached(`recent-commits:${laneId}:${limit}`, 2_000, async () => {
        const lane = laneService.getLaneBaseAndBranch(laneId);
        const out = await runGitOrThrow(
          ["log", `-n${limit}`, "--date=iso-strict", "--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%s"],
          { cwd: lane.worktreePath, timeoutMs: 15_000 }
        );

        // Determine which commits are unpushed by comparing with upstream.
        let unpushedShas: Set<string> | null = null;
        const upstreamRes = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
          cwd: lane.worktreePath,
          timeoutMs: 10_000
        });
        if (upstreamRes.exitCode === 0) {
          const upstream = upstreamRes.stdout.trim();
          if (upstream.length) {
            const unpushedRes = await runGit(["log", "--format=%H", `${upstream}..HEAD`], {
              cwd: lane.worktreePath,
              timeoutMs: 15_000
            });
            if (unpushedRes.exitCode === 0) {
              unpushedShas = new Set(
                unpushedRes.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
              );
            }
          }
        }

        const rows = out
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line): GitCommitSummary | null => {
            const [sha, shortSha, parentsRaw, authorName, authoredAt, subject] = parseDelimited(line);
            if (!sha || !shortSha) return null;
            const parents = (parentsRaw ?? "")
              .split(" ")
              .map((entry) => entry.trim())
              .filter(Boolean);
            return {
              sha,
              shortSha,
              parents,
              authorName: authorName ?? "",
              authoredAt: authoredAt ?? "",
              subject: subject ?? "",
              pushed: unpushedShas ? !unpushedShas.has(sha) : false
            };
          })
          .filter((entry): entry is GitCommitSummary => entry != null);

        return rows;
      });
    },

    async getFileHistory(args: GitGetFileHistoryArgs): Promise<GitFileHistoryEntry[]> {
      const laneId = args.laneId.trim();
      const relPath = ensureRelativeRepoPath(args.path);
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(100, Math.floor(args.limit))) : 20;
      return readLaneCached(`file-history:${laneId}:${relPath}:${limit}`, 2_000, async () => {
        const lane = laneService.getLaneBaseAndBranch(laneId);
        const out = await runGitOrThrow(
          [
            "log",
            "--follow",
            `-n${limit}`,
            "--date=iso-strict",
            "--name-status",
            "--format=%x1e%H%x1f%h%x1f%an%x1f%aI%x1f%s",
            "--",
            relPath,
          ],
          { cwd: lane.worktreePath, timeoutMs: 15_000 }
        );

        return out
          .split("\u001e")
          .map((block) => block.trim())
          .filter(Boolean)
          .map((block): GitFileHistoryEntry | null => {
            const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
            const metadataLine = lines.shift();
            if (!metadataLine) return null;
            const [commitSha, shortSha, authorName, authoredAt, subject] = parseDelimited(metadataLine);
            if (!commitSha || !shortSha) return null;

            let path = relPath;
            let previousPath: string | null = null;
            let changeType: GitFileHistoryEntry["changeType"] = "unknown";

            const statusLine = lines[0] ?? "";
            if (statusLine.length) {
              const parts = statusLine.split("\t");
              const status = parts[0]?.trim() ?? "";
              const code = status[0] ?? "";
              switch (code) {
                case "A":
                  changeType = "added";
                  path = parts[1] ?? relPath;
                  break;
                case "M":
                  changeType = "modified";
                  path = parts[1] ?? relPath;
                  break;
                case "D":
                  changeType = "deleted";
                  path = parts[1] ?? relPath;
                  break;
                case "R":
                  changeType = "renamed";
                  previousPath = parts[1] ?? null;
                  path = parts[2] ?? relPath;
                  break;
                case "C":
                  changeType = "copied";
                  previousPath = parts[1] ?? null;
                  path = parts[2] ?? relPath;
                  break;
                default:
                  path = parts.at(-1) ?? relPath;
                  break;
              }
            }

            return {
              commitSha,
              shortSha,
              authorName: authorName ?? "",
              authoredAt: authoredAt ?? "",
              subject: subject ?? "",
              path,
              previousPath,
              changeType,
            };
          })
          .filter((entry): entry is GitFileHistoryEntry => entry != null);
      });
    },

    async getSyncStatus(args: { laneId: string }): Promise<GitUpstreamSyncStatus> {
      const laneId = args.laneId.trim();
      return readLaneCached(`sync-status:${laneId}:default`, 2_000, async () => {
        const lane = laneService.getLaneBaseAndBranch(laneId);
        const upstreamRes = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
          cwd: lane.worktreePath,
          timeoutMs: 10_000
        });

        if (upstreamRes.exitCode !== 0) {
          return {
            hasUpstream: false,
            upstreamRef: null,
            ahead: 0,
            behind: 0,
            diverged: false,
            recommendedAction: "push"
          };
        }

        const upstreamRef = upstreamRes.stdout.trim();
        if (!upstreamRef.length) {
          return {
            hasUpstream: false,
            upstreamRef: null,
            ahead: 0,
            behind: 0,
            diverged: false,
            recommendedAction: "push"
          };
        }

        const countRes = await runGit(["rev-list", "--left-right", "--count", `${upstreamRef}...HEAD`], {
          cwd: lane.worktreePath,
          timeoutMs: 10_000
        });
        if (countRes.exitCode !== 0) {
          return {
            hasUpstream: true,
            upstreamRef,
            ahead: 0,
            behind: 0,
            diverged: false,
            recommendedAction: "none"
          };
        }

        const parts = countRes.stdout.trim().split(/\s+/).filter(Boolean);
        const behind = Number.parseInt(parts[0] ?? "0", 10);
        const ahead = Number.parseInt(parts[1] ?? "0", 10);
        const normalizedBehind = Number.isFinite(behind) && behind > 0 ? behind : 0;
        const normalizedAhead = Number.isFinite(ahead) && ahead > 0 ? ahead : 0;
        const diverged = normalizedAhead > 0 && normalizedBehind > 0;

        let recommendedAction: GitRecommendedAction = "none";
        if (normalizedAhead > 0 && normalizedBehind === 0) {
          recommendedAction = "push";
        } else if (normalizedBehind > 0 && normalizedAhead === 0) {
          recommendedAction = "pull";
        } else if (diverged) {
          const mergeBaseRes = await runGit(["merge-base", "--is-ancestor", upstreamRef, "HEAD"], {
            cwd: lane.worktreePath,
            timeoutMs: 5_000
          });
          if (mergeBaseRes.exitCode === 0) {
            recommendedAction = "force_push_lease";
          } else {
            const reflogRes = await runGit(["reflog", "show", "HEAD", "--format=%gs", "-n", "30"], {
              cwd: lane.worktreePath,
              timeoutMs: 5_000
            });
            const hasRecentRebase = reflogRes.exitCode === 0 &&
              reflogRes.stdout.split("\n").some((line) => /rebase/.test(line));
            recommendedAction = hasRecentRebase ? "force_push_lease" : "pull";
          }
        }

        return {
          hasUpstream: true,
          upstreamRef,
          ahead: normalizedAhead,
          behind: normalizedBehind,
          diverged,
          recommendedAction
        };
      });
    },

    async listCommitFiles(args: GitListCommitFilesArgs): Promise<string[]> {
      const lane = laneService.getLaneBaseAndBranch(args.laneId);
      const sha = args.commitSha.trim();
      if (!sha.length) throw new Error("commitSha is required");
      const res = await runGitOrThrow(["show", "--pretty=format:", "--name-only", sha], {
        cwd: lane.worktreePath,
        timeoutMs: 12_000
      });
      return res
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    },

    async getCommitMessage(args: GitGetCommitMessageArgs): Promise<string> {
      const lane = laneService.getLaneBaseAndBranch(args.laneId);
      const sha = args.commitSha.trim();
      if (!sha.length) throw new Error("commitSha is required");
      const res = await runGitOrThrow(["show", "-s", "--format=%B", sha], {
        cwd: lane.worktreePath,
        timeoutMs: 12_000
      });
      const message = res.trimEnd();
      const MAX = 8000;
      if (message.length > MAX) {
        return `${message.slice(0, MAX)}\n\n...(truncated)...\n`;
      }
      return message;
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
      const laneId = args.laneId.trim();
      return readLaneCached(`stashes:${laneId}:default`, 1_500, async () => {
        const lane = laneService.getLaneBaseAndBranch(laneId);
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
      });
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

    async stashClear(args: { laneId: string }): Promise<GitActionResult> {
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_stash_clear",
        reason: "stash_clear",
        metadata: {},
        fn: async (lane) => {
          await runGitOrThrow(["stash", "clear"], { cwd: lane.worktreePath, timeoutMs: 15_000 });
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

    async pull(args: { laneId: string }): Promise<GitActionResult> {
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_pull",
        reason: "pull_from_remote",
        metadata: {},
        fn: async (lane) => {
          await runGitOrThrow(["pull", "--ff-only"], { cwd: lane.worktreePath, timeoutMs: 60_000 });
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
    },

    async getConflictState(args: { laneId: string }): Promise<GitConflictState> {
      const laneId = args.laneId.trim();
      if (!laneId) throw new Error("laneId is required");
      return readLaneCached(`conflict-state:${laneId}:default`, 1_500, async () => {
        const lane = laneService.getLaneBaseAndBranch(laneId);
        const gitDir = await getAbsoluteGitDir(lane.worktreePath);
        const kind = gitDir ? detectConflictKind(gitDir) : null;

        const unmergedRes = await runGit(["diff", "--name-only", "--diff-filter=U"], {
          cwd: lane.worktreePath,
          timeoutMs: 10_000
        });
        const conflictedFiles = unmergedRes.exitCode === 0 ? parseNameOnly(unmergedRes.stdout) : [];
        const inProgress = kind != null;

        return {
          laneId,
          kind,
          inProgress,
          conflictedFiles,
          canContinue: inProgress && conflictedFiles.length === 0,
          canAbort: inProgress
        };
      });
    },

    async rebaseContinue(args: { laneId: string }): Promise<GitActionResult> {
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_rebase_continue",
        reason: "rebase_continue",
        fn: async (lane) => {
          await runGitOrThrow(["-c", "core.editor=true", "rebase", "--continue"], {
            cwd: lane.worktreePath,
            timeoutMs: 300_000
          });
        }
      });
      return action;
    },

    async rebaseAbort(args: { laneId: string }): Promise<GitActionResult> {
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_rebase_abort",
        reason: "rebase_abort",
        fn: async (lane) => {
          await runGitOrThrow(["rebase", "--abort"], { cwd: lane.worktreePath, timeoutMs: 300_000 });
        }
      });
      return action;
    },

    async mergeContinue(args: { laneId: string }): Promise<GitActionResult> {
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_merge_continue",
        reason: "merge_continue",
        fn: async (lane) => {
          await runGitOrThrow(["-c", "core.editor=true", "merge", "--continue"], {
            cwd: lane.worktreePath,
            timeoutMs: 300_000
          });
        }
      });
      return action;
    },

    async mergeAbort(args: { laneId: string }): Promise<GitActionResult> {
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_merge_abort",
        reason: "merge_abort",
        fn: async (lane) => {
          await runGitOrThrow(["merge", "--abort"], { cwd: lane.worktreePath, timeoutMs: 300_000 });
        }
      });
      return action;
    },

    async listBranches(args: { laneId: string }): Promise<GitBranchSummary[]> {
      const lane = laneService.getLaneBaseAndBranch(args.laneId);
      const out = await runGitOrThrow(
        ["for-each-ref", "--sort=refname", "--format=%(refname)\t%(refname:short)\t%(HEAD)\t%(upstream:short)", "refs/heads", "refs/remotes"],
        { cwd: lane.worktreePath, timeoutMs: 15_000 }
      );

      const localBranches = new Map<string, GitBranchSummary>();
      const remoteBranches: GitBranchSummary[] = [];

      out
        .split("\n")
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .forEach((line) => {
          const parts = line.split("\t");
          const fullRef = parts[0]?.trim() ?? "";
          const shortRef = parts[1]?.trim() ?? "";
          if (!fullRef || !shortRef) return;

          if (fullRef.startsWith("refs/heads/")) {
            const isCurrent = (parts[2]?.trim() ?? "") === "*";
            const upstream = parts[3]?.trim() || null;
            localBranches.set(shortRef, { name: shortRef, isCurrent, isRemote: false, upstream });
            return;
          }

          if (fullRef.startsWith("refs/remotes/")) {
            if (shortRef.endsWith("/HEAD")) return;
            remoteBranches.push({
              name: shortRef,
              isCurrent: false,
              isRemote: true,
              upstream: null
            });
          }
        });

      const localNames = new Set(localBranches.keys());
      const dedupedRemotes = remoteBranches.filter((branch) => {
        const localCandidate = localBranchNameFromRemoteRef(branch.name);
        return !localNames.has(localCandidate);
      });

      const sortedLocals = Array.from(localBranches.values()).sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      const sortedRemotes = dedupedRemotes.sort((a, b) => a.name.localeCompare(b.name));

      return [...sortedLocals, ...sortedRemotes];
    },

    async checkoutBranch(args: { laneId: string; branchName: string }): Promise<GitActionResult> {
      const branchName = args.branchName.trim();
      if (!branchName.length) throw new Error("Branch name is required");

      const lane = laneService.getLaneBaseAndBranch(args.laneId);
      if (lane.laneType !== "primary") {
        throw new Error("Branch checkout is only supported on the primary lane");
      }

      const localExists = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
        cwd: lane.worktreePath,
        timeoutMs: 8_000
      }).then((res) => res.exitCode === 0);
      const remoteExists = !localExists
        ? await runGit(["show-ref", "--verify", "--quiet", `refs/remotes/${branchName}`], {
          cwd: lane.worktreePath,
          timeoutMs: 8_000
        }).then((res) => res.exitCode === 0)
        : false;

      const trackRemoteBranch = !localExists && remoteExists;
      const resolvedBranchRef = trackRemoteBranch ? localBranchNameFromRemoteRef(branchName) : branchName;

      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_checkout_branch",
        reason: "checkout_branch",
        metadata: { branchName, trackRemoteBranch },
        fn: async (l) => {
          const checkoutCmd = trackRemoteBranch
            ? ["checkout", "--track", "--ignore-other-worktrees", branchName]
            : ["checkout", "--ignore-other-worktrees", branchName];
          await runGitOrThrow(checkoutCmd, { cwd: l.worktreePath, timeoutMs: 60_000 });
          laneService.updateBranchRef(args.laneId, resolvedBranchRef);
        }
      });
      return action;
    }
  };
}
