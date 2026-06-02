import { spawn } from "node:child_process";
import path from "node:path";
import { getHeadSha, runGit, runGitOrThrow } from "./git";
import { detectConflictKind, parseNameOnly } from "./gitConflictState";
import type {
  GitActionResult,
  GitBatchFileActionArgs,
  GitBranchSummary,
  GitCheckoutBranchArgs,
  GitUserIdentity,
  GitCherryPickArgs,
  GitCommitArgs,
  GitCreateTagArgs,
  GitGenerateCommitMessageArgs,
  GitGenerateCommitMessageResult,
  GitCommitSummary,
  GitConflictState,
  GitFileHistoryEntry,
  GitGetCommitMessageArgs,
  GitGetFileHistoryArgs,
  GitHeadChangeActionArgs,
  GitListCommitFilesArgs,
  GitFileActionArgs,
  GitPullArgs,
  GitPullMode,
  GitPushArgs,
  GitRecommendedAction,
  GitResetCommitArgs,
  GitRevertArgs,
  GitStashPushArgs,
  GitStashRefArgs,
  GitStashSummary,
  GitSyncArgs,
  GitSyncMode,
  GitUpstreamSyncStatus,
  LaneLinearIssue,
  LaneType,
  OperationRecord,
} from "../../../shared/types";
import { ensureLinearCommitReference } from "../../../shared/linearMagicWords";
import type { Logger } from "../logging/logger";
import type { createLaneService } from "../lanes/laneService";
import type { createOperationService } from "../history/operationService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import { isRecord, safeJsonParse } from "../shared/utils";

type LaneInfo = {
  baseRef: string;
  branchRef: string;
  worktreePath: string;
  laneType: LaneType;
  linearIssue?: LaneLinearIssue | null;
};

type BranchStashSummary = GitStashSummary & {
  oid: string;
};

type CommitMessagePromptContext = {
  hasStagedChanges: boolean;
  stagedFiles: string;
  headFiles: string;
  diffSnippet: string;
};

function normAbs(p: string): string {
  return path.resolve(p);
}

type CachedReadEntry<T> = {
  expiresAt: number;
  value?: T;
  promise?: Promise<T>;
};

type GitOriginRemoteSummary = {
  remoteUrl: string | null;
  branch: string | null;
};

type GitOpenPrSummary = {
  prUrl: string | null;
  prNumber: number | null;
  title: string | null;
  headRefName: string | null;
};

function localBranchNameFromRemoteRef(ref: string): string {
  const normalized = ref.trim();
  const slashIndex = normalized.indexOf("/");
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
}

function localBranchNameForConfig(ref: string): string {
  return ref.trim().replace(/^refs\/heads\//, "");
}

function configuredUpstreamRef(remote: string, mergeRef: string): string | null {
  const normalizedRemote = remote.trim();
  const branch = mergeRef.trim().replace(/^refs\/heads\//, "");
  if (!normalizedRemote || !branch) return null;
  return normalizedRemote === "." ? branch : `${normalizedRemote}/${branch}`;
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

function ensureGitTagName(tagName: string): string {
  const normalized = tagName.trim();
  if (!normalized.length) throw new Error("Tag name is required");
  if (normalized.includes("\0") || normalized.startsWith("-")) {
    throw new Error("Invalid tag name");
  }
  if (/\s/.test(normalized)) {
    throw new Error("Invalid tag name");
  }
  return normalized;
}

function parseDelimited(line: string): string[] {
  return line.split("\u001f");
}

function normalizeBranchForStashComparison(ref: string): string {
  return localBranchNameForConfig(ref).trim();
}

function branchNameFromStashSubject(subject: string): string | null {
  const trimmed = subject.trim();
  const onMatch = /^On ([^:]+):/.exec(trimmed);
  if (onMatch) return onMatch[1]?.trim() || null;
  const wipMatch = /^WIP on ([^:]+):/.exec(trimmed);
  if (wipMatch) return wipMatch[1]?.trim() || null;
  return null;
}

function stashMatchesBranch(subject: string, branchRef: string): boolean {
  const branch = normalizeBranchForStashComparison(branchRef);
  if (!branch) return false;
  return branchNameFromStashSubject(subject) === branch;
}

function stashOrdinal(ref: string): number | null {
  const match = /^stash@\{(\d+)\}$/.exec(ref.trim());
  if (!match) return null;
  const ordinal = Number(match[1]);
  return Number.isSafeInteger(ordinal) ? ordinal : null;
}

function sortStashesForDrop<T extends GitStashSummary>(stashes: T[]): T[] {
  return stashes.slice().sort((left, right) => {
    const leftOrdinal = stashOrdinal(left.ref);
    const rightOrdinal = stashOrdinal(right.ref);
    if (leftOrdinal != null && rightOrdinal != null) return rightOrdinal - leftOrdinal;
    if (leftOrdinal != null) return -1;
    if (rightOrdinal != null) return 1;
    return right.ref.localeCompare(left.ref);
  });
}

function toPublicStash(stash: BranchStashSummary): GitStashSummary {
  return {
    oid: stash.oid,
    ref: stash.ref,
    subject: stash.subject,
    createdAt: stash.createdAt,
  };
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

  function invalidateStashReadCaches(): void {
    for (const key of laneReadCache.keys()) {
      if (key.startsWith("stashes:")) laneReadCache.delete(key);
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

  async function listBranchStashes(lane: LaneInfo): Promise<BranchStashSummary[]> {
    const out = await runGitOrThrow(["stash", "list", "--format=%H%x1f%gd%x1f%cI%x1f%gs"], {
      cwd: lane.worktreePath,
      timeoutMs: 15_000
    });
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line): BranchStashSummary | null => {
        const [oid, ref, createdAt, subject] = parseDelimited(line);
        if (!oid || !ref) return null;
        return {
          oid,
          ref,
          createdAt: createdAt && createdAt.length ? createdAt : null,
          subject: subject ?? ""
        };
      })
      .filter((entry): entry is BranchStashSummary => entry != null)
      .filter((entry) => stashMatchesBranch(entry.subject, lane.branchRef));
  }

  async function requireBranchStash(lane: LaneInfo, stashRef: string, stashOid?: string): Promise<BranchStashSummary> {
    const normalizedOid = stashOid?.trim();
    const stash = (await listBranchStashes(lane)).find((entry) =>
      normalizedOid?.length ? entry.oid === normalizedOid : entry.ref === stashRef
    );
    if (!stash) {
      const branch = normalizeBranchForStashComparison(lane.branchRef);
      throw new Error(`Stash ${stashRef} is not saved for branch ${branch || lane.branchRef}.`);
    }
    return stash;
  }

  async function resolveCurrentBranchStashRef(lane: LaneInfo, stash: BranchStashSummary): Promise<string> {
    const current = (await listBranchStashes(lane)).find((entry) => entry.oid === stash.oid);
    if (!current) {
      throw new Error(`Stash ${stash.ref} changed before ADE could clear it. Refresh stashes and try again.`);
    }
    const resolved = await runGitOrThrow(["rev-parse", "--verify", current.ref], {
      cwd: lane.worktreePath,
      timeoutMs: 8_000,
    });
    if (resolved.trim() !== stash.oid) {
      throw new Error(`Stash ${current.ref} changed before ADE could clear it. Refresh stashes and try again.`);
    }
    return current.ref;
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

  function isMissingWorktreeError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /git working directory not found:|Lane worktree is missing\./i.test(message);
  }

  function laneWorktreeMissingError(lane: LaneInfo): Error {
    return new Error(
      `Lane worktree is missing. Restore or recreate the lane worktree at ${lane.worktreePath} before viewing history.`,
    );
  }

  async function assertLaneWorktreeRoot(lane: LaneInfo): Promise<void> {
    try {
      const topLevelRes = await runGit(
        ["rev-parse", "--path-format=absolute", "--show-toplevel"],
        { cwd: lane.worktreePath, timeoutMs: 8_000 },
      );
      if (!topLevelRes || typeof topLevelRes.exitCode !== "number") return;
      if (topLevelRes.exitCode !== 0) {
        throw laneWorktreeMissingError(lane);
      }
      const topLevel = topLevelRes.stdout.trim();
      if (topLevel && normAbs(topLevel) !== normAbs(lane.worktreePath)) {
        throw laneWorktreeMissingError(lane);
      }
    } catch (error) {
      if (isMissingWorktreeError(error)) throw error;
      throw laneWorktreeMissingError(lane);
    }
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
    await assertLaneWorktreeRoot(lane);
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
      try {
        laneService.invalidateListCache?.();
      } catch {
        // Never fail git operation cleanup due to cache invalidation issues.
      }
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

  const HEAD_CHANGE_UNDO_BOUNDARY_KINDS = new Set([
    // Branch checkout updates lane branch_ref via switchBranch; reset --hard alone
    // would move the wrong ref (see History "Create branch here" → undo).
    "git_checkout_branch",
  ]);

  function getOperationBranchRef(operation: OperationRecord): string | null {
    const parsed = safeJsonParse<unknown>(operation.metadataJson, null);
    if (!isRecord(parsed)) return null;
    const branchRef = parsed.branchRef;
    return typeof branchRef === "string" && branchRef.trim()
      ? localBranchNameForConfig(branchRef)
      : null;
  }

  function getLatestUndoableHeadChange(
    laneId: string,
    currentBranchRef: string,
  ): OperationRecord & {
    preHeadSha: string;
    postHeadSha: string;
  } {
    const normalizedCurrentBranch = localBranchNameForConfig(currentBranchRef);
    for (const operation of operationService.listHeadChanges({ laneId, limit: 100 })) {
      if (operation.kind === "git_undo_head_change") {
        throw new Error("Latest head change is already an undo. Use redo to restore it.");
      }
      if (HEAD_CHANGE_UNDO_BOUNDARY_KINDS.has(operation.kind)) {
        break;
      }
      const operationBranch = getOperationBranchRef(operation);
      if (operationBranch !== null && operationBranch !== normalizedCurrentBranch) {
        continue;
      }
      return operation;
    }
    throw new Error("No undoable head-changing git operation found for this branch.");
  }

  function getLatestRedoableUndo(laneId: string): {
    operation: OperationRecord & { preHeadSha: string; postHeadSha: string };
    redoHeadSha: string;
  } {
    const latest = operationService.listHeadChanges({ laneId, limit: 100 })[0];
    if (!latest || latest.kind !== "git_undo_head_change") {
      throw new Error("No redoable git undo operation found for this lane.");
    }
    const parsed = safeJsonParse<unknown>(latest.metadataJson, null);
    const metadata = isRecord(parsed) ? parsed : {};
    const redoHeadSha = metadata.redoHeadSha;
    if (typeof redoHeadSha !== "string" || redoHeadSha.length === 0) {
      throw new Error("No redoable git undo operation found for this lane.");
    }
    return { operation: latest, redoHeadSha };
  }

  function normalizeCommitShaArg(commitSha: string): string {
    const normalized = commitSha.trim();
    if (!normalized.length) throw new Error("Commit SHA is required");
    if (normalized.includes("\0") || normalized.startsWith("-") || /\s/.test(normalized)) {
      throw new Error("Invalid commit SHA");
    }
    return normalized;
  }

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
      const inputMessage = args.message.trim();
      const laneForMessage = laneService.getLaneBaseAndBranch(args.laneId);
      const message = laneForMessage.linearIssue
        ? ensureLinearCommitReference(inputMessage, laneForMessage.linearIssue)
        : inputMessage;
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
      await assertLaneWorktreeRoot(lane);
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
        const normalized = normalizeCommitMessage(result.text);
        return {
          message: lane.linearIssue ? ensureLinearCommitReference(normalized, lane.linearIssue) : normalized,
          model: result.model ?? model
        };
      } catch (error) {
        throw toCommitMessageGenerationError(error);
      }
    },

    async listRecentCommits(args: { laneId: string; limit?: number }): Promise<GitCommitSummary[]> {
      const laneId = args.laneId.trim();
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(500, Math.floor(args.limit))) : 30;
      return readLaneCached(`recent-commits:${laneId}:${limit}`, 2_000, async () => {
        const lane = laneService.getLaneBaseAndBranch(laneId);
        await assertLaneWorktreeRoot(lane);
        let out: string;
        try {
          out = await runGitOrThrow(
            ["log", `-n${limit}`, "--date=iso-strict", "--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%s"],
            { cwd: lane.worktreePath, timeoutMs: 15_000 }
          );
        } catch (error) {
          if (isMissingWorktreeError(error)) throw laneWorktreeMissingError(lane);
          throw error;
        }

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

    async getCommit(args: { laneId: string; commitSha: string }): Promise<GitCommitSummary | null> {
      const laneId = args.laneId.trim();
      const commitSha = normalizeCommitShaArg(args.commitSha);
      return readLaneCached(`commit:${laneId}:${commitSha}`, 2_000, async () => {
        const lane = laneService.getLaneBaseAndBranch(laneId);
        await assertLaneWorktreeRoot(lane);
        let out: string;
        try {
          out = await runGitOrThrow(
            [
              "log",
              "-1",
              "--date=iso-strict",
              "--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%s",
              commitSha,
            ],
            { cwd: lane.worktreePath, timeoutMs: 10_000 },
          );
        } catch (error) {
          if (isMissingWorktreeError(error)) throw laneWorktreeMissingError(lane);
          return null;
        }
        const line = out.split("\n").map((l) => l.trim()).find(Boolean);
        if (!line) return null;
        const [sha, shortSha, parentsRaw, authorName, authoredAt, subject] = parseDelimited(line);
        if (!sha || !shortSha) return null;
        const parents = (parentsRaw ?? "")
          .split(" ")
          .map((entry) => entry.trim())
          .filter(Boolean);

        let pushed = false;
        const upstreamRes = await runGit(
          ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
          { cwd: lane.worktreePath, timeoutMs: 10_000 },
        );
        if (upstreamRes.exitCode === 0) {
          const upstream = upstreamRes.stdout.trim();
          if (upstream.length) {
            const containsRes = await runGit(
              ["branch", "-r", "--contains", sha, upstream],
              { cwd: lane.worktreePath, timeoutMs: 10_000 },
            );
            if (containsRes.exitCode === 0 && containsRes.stdout.trim().length) {
              pushed = true;
            }
          }
        }

        return {
          sha,
          shortSha,
          parents,
          authorName: authorName ?? "",
          authoredAt: authoredAt ?? "",
          subject: subject ?? "",
          pushed,
        };
      });
    },

    async isCommitInLaneHistory(args: { laneId: string; commitSha: string }): Promise<boolean> {
      const laneId = args.laneId.trim();
      const commitSha = normalizeCommitShaArg(args.commitSha);
      return readLaneCached(`commit-in-lane-history:${laneId}:${commitSha}`, 2_000, async () => {
        const lane = laneService.getLaneBaseAndBranch(laneId);
        await assertLaneWorktreeRoot(lane);
        const result = await runGit(
          ["merge-base", "--is-ancestor", commitSha, "HEAD"],
          { cwd: lane.worktreePath, timeoutMs: 10_000 },
        );
        if (result.exitCode === 0) return true;
        if (result.exitCode === 1) return false;
        if (isMissingWorktreeError(new Error(result.stderr || result.stdout))) {
          throw laneWorktreeMissingError(lane);
        }
        return false;
      });
    },

    async getFileHistory(args: GitGetFileHistoryArgs): Promise<GitFileHistoryEntry[]> {
      const laneId = args.laneId.trim();
      const relPath = ensureRelativeRepoPath(args.path);
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(100, Math.floor(args.limit))) : 20;
      return readLaneCached(`file-history:${laneId}:${relPath}:${limit}`, 2_000, async () => {
        const lane = laneService.getLaneBaseAndBranch(laneId);
        await assertLaneWorktreeRoot(lane);
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
        await assertLaneWorktreeRoot(lane);
        const readConfiguredUpstream = async (): Promise<string | null> => {
          const branchName = localBranchNameForConfig(lane.branchRef);
          if (!branchName) return null;
          const [remoteRes, mergeRes] = await Promise.all([
            runGit(["config", "--get", `branch.${branchName}.remote`], {
              cwd: lane.worktreePath,
              timeoutMs: 5_000
            }),
            runGit(["config", "--get", `branch.${branchName}.merge`], {
              cwd: lane.worktreePath,
              timeoutMs: 5_000
            }),
          ]);
          if (remoteRes.exitCode !== 0 || mergeRes.exitCode !== 0) return null;
          return configuredUpstreamRef(remoteRes.stdout, mergeRes.stdout);
        };
        const upstreamRes = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
          cwd: lane.worktreePath,
          timeoutMs: 10_000
        });

        if (upstreamRes.exitCode !== 0) {
          const configuredRef = await readConfiguredUpstream();
          return {
            hasUpstream: false,
            upstreamState: configuredRef ? "missing" : "none",
            upstreamRef: configuredRef,
            ahead: 0,
            behind: 0,
            diverged: false,
            recommendedAction: "push"
          };
        }

        const upstreamRef = upstreamRes.stdout.trim();
        if (!upstreamRef.length) {
          const configuredRef = await readConfiguredUpstream();
          return {
            hasUpstream: false,
            upstreamState: configuredRef ? "missing" : "none",
            upstreamRef: configuredRef,
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
            upstreamState: "tracking",
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
          upstreamState: "tracking",
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
      await assertLaneWorktreeRoot(lane);
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
      await assertLaneWorktreeRoot(lane);
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

    async createTag(args: GitCreateTagArgs): Promise<GitActionResult> {
      const commitSha = args.commitSha.trim();
      if (!commitSha.length) throw new Error("Commit SHA is required");
      const tagName = ensureGitTagName(args.tagName);
      const message = args.message?.trim();
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_tag_create",
        reason: "create_tag",
        metadata: { commitSha, tagName, annotated: Boolean(message) },
        fn: async (lane) => {
          const cmd = message
            ? ["tag", "-a", tagName, commitSha, "-m", message]
            : ["tag", tagName, commitSha];
          await runGitOrThrow(cmd, { cwd: lane.worktreePath, timeoutMs: 30_000 });
        }
      });
      return action;
    },

    async resetToCommit(args: GitResetCommitArgs): Promise<GitActionResult> {
      const commitSha = args.commitSha.trim();
      if (!commitSha.length) throw new Error("Commit SHA is required");
      if (!["soft", "mixed", "hard"].includes(args.mode)) {
        throw new Error("Reset mode must be soft, mixed, or hard");
      }
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: `git_reset_${args.mode}`,
        reason: "reset_to_commit",
        metadata: { commitSha, mode: args.mode },
        fn: async (lane) => {
          await runGitOrThrow(["reset", `--${args.mode}`, commitSha], {
            cwd: lane.worktreePath,
            timeoutMs: 60_000
          });
        }
      });
      return action;
    },

    async stashPush(args: GitStashPushArgs): Promise<GitActionResult> {
      const message = args.message?.trim();
      invalidateStashReadCaches();
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
      invalidateStashReadCaches();
      return action;
    },

    async listStashes(args: { laneId: string }): Promise<GitStashSummary[]> {
      const laneId = args.laneId.trim();
      return readLaneCached(`stashes:${laneId}:default`, 1_500, async () => {
        const lane = laneService.getLaneBaseAndBranch(laneId);
        await assertLaneWorktreeRoot(lane);
        return (await listBranchStashes(lane)).map(toPublicStash);
      });
    },

    async stashApply(args: GitStashRefArgs): Promise<GitActionResult> {
      const stashRef = args.stashRef.trim();
      const stashOid = args.stashOid?.trim();
      if (!stashRef.length) throw new Error("stashRef is required");
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_stash_apply",
        reason: "stash_apply",
        metadata: { stashRef, stashOid: stashOid || null },
        fn: async (lane) => {
          const stash = await requireBranchStash(lane, stashRef, stashOid);
          const currentRef = await resolveCurrentBranchStashRef(lane, stash);
          await runGitOrThrow(["stash", "apply", currentRef], { cwd: lane.worktreePath, timeoutMs: 30_000 });
        }
      });
      return action;
    },

    async stashPop(args: GitStashRefArgs): Promise<GitActionResult> {
      const stashRef = args.stashRef.trim();
      const stashOid = args.stashOid?.trim();
      if (!stashRef.length) throw new Error("stashRef is required");
      if (!stashOid?.length) throw new Error("stashOid is required to pop a saved stash. Refresh stashes and try again.");
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_stash_pop",
        reason: "stash_pop",
        metadata: { stashRef, stashOid: stashOid || null },
        fn: async (lane) => {
          const stash = await requireBranchStash(lane, stashRef, stashOid);
          const currentApplyRef = await resolveCurrentBranchStashRef(lane, stash);
          await runGitOrThrow(["stash", "apply", currentApplyRef], { cwd: lane.worktreePath, timeoutMs: 30_000 });
          try {
            const currentDropRef = await resolveCurrentBranchStashRef(lane, stash);
            await runGitOrThrow(["stash", "drop", currentDropRef], { cwd: lane.worktreePath, timeoutMs: 30_000 });
            invalidateStashReadCaches();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn("git.stash_pop_drop_failed", {
              laneId: args.laneId,
              stashRef,
              stashOid: stashOid || null,
              error: message,
            });
            // Apply already succeeded; retrying pop would conflict with the applied changes.
          }
        }
      });
      return action;
    },

    async stashDrop(args: GitStashRefArgs): Promise<GitActionResult> {
      const stashRef = args.stashRef.trim();
      const stashOid = args.stashOid?.trim();
      if (!stashRef.length) throw new Error("stashRef is required");
      if (!stashOid?.length) throw new Error("stashOid is required to drop a saved stash. Refresh stashes and try again.");
      invalidateStashReadCaches();
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_stash_drop",
        reason: "stash_drop",
        metadata: { stashRef, stashOid: stashOid || null },
        fn: async (lane) => {
          const stash = await requireBranchStash(lane, stashRef, stashOid);
          const currentRef = await resolveCurrentBranchStashRef(lane, stash);
          await runGitOrThrow(["stash", "drop", currentRef], { cwd: lane.worktreePath, timeoutMs: 30_000 });
        }
      });
      invalidateStashReadCaches();
      return action;
    },

    async stashClear(args: { laneId: string }): Promise<GitActionResult> {
      invalidateStashReadCaches();
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_stash_clear",
        reason: "stash_clear",
        metadata: {},
        fn: async (lane) => {
          const stashes = sortStashesForDrop(await listBranchStashes(lane));
          for (const stash of stashes) {
            const currentRef = await resolveCurrentBranchStashRef(lane, stash);
            await runGitOrThrow(["stash", "drop", currentRef], { cwd: lane.worktreePath, timeoutMs: 30_000 });
          }
        }
      });
      invalidateStashReadCaches();
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

    async pull(args: GitPullArgs): Promise<GitActionResult> {
      const mode = args.mode ?? "ff-only";
      if (mode !== "ff-only" && mode !== "rebase" && mode !== "merge") {
        throw new Error("git.pull mode must be ff-only, rebase, or merge.");
      }
      const commandByMode: Record<GitPullMode, string[]> = {
        "ff-only": ["pull", "--ff-only"],
        rebase: ["pull", "--rebase"],
        merge: ["pull", "--no-rebase", "--no-edit"],
      };
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_pull",
        reason: `pull_${mode.replace("-", "_")}`,
        metadata: { mode },
        fn: async (lane) => {
          await runGitOrThrow(commandByMode[mode], { cwd: lane.worktreePath, timeoutMs: 60_000 });
        }
      });
      return action;
    },

    async undoLastHeadChange(args: GitHeadChangeActionArgs): Promise<GitActionResult> {
      const laneAtSelection = laneService.getLaneBaseAndBranch(args.laneId);
      const selectedBranchRef = localBranchNameForConfig(laneAtSelection.branchRef);
      const operation = getLatestUndoableHeadChange(args.laneId, selectedBranchRef);
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_undo_head_change",
        reason: "undo_head_change",
        metadata: {
          undoneOperationId: operation.id,
          undoneOperationKind: operation.kind,
          redoHeadSha: operation.postHeadSha,
          targetHeadSha: operation.preHeadSha,
        },
        fn: async (lane) => {
          if (localBranchNameForConfig(lane.branchRef) !== selectedBranchRef) {
            throw new Error("Cannot undo because the lane branch has changed since that operation was selected.");
          }
          const currentHead = await getHeadSha(lane.worktreePath);
          if (currentHead !== operation.postHeadSha) {
            throw new Error("Cannot undo because the lane head has changed since that operation.");
          }
          await runGitOrThrow(["reset", "--hard", operation.preHeadSha], {
            cwd: lane.worktreePath,
            timeoutMs: 60_000,
          });
        }
      });
      return action;
    },

    async redoLastHeadChange(args: GitHeadChangeActionArgs): Promise<GitActionResult> {
      const { operation, redoHeadSha } = getLatestRedoableUndo(args.laneId);
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_redo_head_change",
        reason: "redo_head_change",
        metadata: {
          redoneUndoOperationId: operation.id,
          targetHeadSha: redoHeadSha,
        },
        fn: async (lane) => {
          const currentHead = await getHeadSha(lane.worktreePath);
          if (currentHead !== operation.postHeadSha) {
            throw new Error("Cannot redo because the lane head has changed since the undo.");
          }
          await runGitOrThrow(["reset", "--hard", redoHeadSha], {
            cwd: lane.worktreePath,
            timeoutMs: 60_000,
          });
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
        await assertLaneWorktreeRoot(lane);
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
      await assertLaneWorktreeRoot(lane);
      // Subject goes last so a tab inside a commit subject doesn't desync the
      // parser — anything after index 7 is rejoined.
      const FORMAT = [
        "%(refname)",
        "%(refname:short)",
        "%(HEAD)",
        "%(upstream:short)",
        "%(objectname)",
        "%(committerdate:iso-strict)",
        "%(authorname)",
        "%(subject)",
      ].join("\t");
      const out = await runGitOrThrow(
        ["for-each-ref", "--sort=refname", `--format=${FORMAT}`, "refs/heads", "refs/remotes"],
        { cwd: lane.worktreePath, timeoutMs: 15_000 }
      );
      const branchProfiles = new Set<string>();
      try {
        for (const profile of laneService.listBranchProfiles(args.laneId)) {
          branchProfiles.add(profile.branchRef);
        }
      } catch {
        // Branch listing should still work even if profile bookkeeping fails.
      }
      const activeLaneOwners = new Map<string, { id: string; name: string }>();
      try {
        const owners = laneService.listBranchOwners({ excludeLaneId: args.laneId });
        for (const owner of owners) {
          activeLaneOwners.set(owner.branchRef, { id: owner.id, name: owner.name });
        }
      } catch {
        // Branch listing should still work if lane summaries are temporarily unavailable.
      }

      const localBranches = new Map<string, GitBranchSummary>();
      const remoteBranches: GitBranchSummary[] = [];
      const annotate = (summary: GitBranchSummary): GitBranchSummary => {
        const localName = summary.isRemote ? localBranchNameFromRemoteRef(summary.name) : summary.name;
        const owner = activeLaneOwners.get(localName) ?? null;
        return {
          ...summary,
          ownedByLaneId: owner?.id ?? null,
          ownedByLaneName: owner?.name ?? null,
          profiledInCurrentLane: branchProfiles.has(localName),
        };
      };

      out
        .split("\n")
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .forEach((line) => {
          const parts = line.split("\t");
          const fullRef = parts[0]?.trim() ?? "";
          const shortRef = parts[1]?.trim() ?? "";
          if (!fullRef || !shortRef) return;

          const commitMeta = {
            lastCommitSha: parts[4]?.trim() || undefined,
            lastCommitDate: parts[5]?.trim() || undefined,
            lastCommitAuthor: parts[6]?.trim() || undefined,
            lastCommitMessage: parts.slice(7).join("\t").trim() || undefined,
          };

          if (fullRef.startsWith("refs/heads/")) {
            const isCurrent = (parts[2]?.trim() ?? "") === "*";
            const upstream = parts[3]?.trim() || null;
            localBranches.set(
              shortRef,
              annotate({ name: shortRef, isCurrent, isRemote: false, upstream, ...commitMeta }),
            );
            return;
          }

          if (fullRef.startsWith("refs/remotes/")) {
            if (shortRef.endsWith("/HEAD")) return;
            remoteBranches.push(
              annotate({ name: shortRef, isCurrent: false, isRemote: true, upstream: null, ...commitMeta }),
            );
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

    async getUserIdentity(args: { laneId: string }): Promise<GitUserIdentity> {
      const lane = laneService.getLaneBaseAndBranch(args.laneId);
      await assertLaneWorktreeRoot(lane);
      const readConfig = async (key: string): Promise<string> => {
        const result = await runGit(["config", "--get", key], {
          cwd: lane.worktreePath,
          timeoutMs: 5_000,
        });
        return result.exitCode === 0 ? result.stdout.trim() : "";
      };
      const [name, email] = await Promise.all([readConfig("user.name"), readConfig("user.email")]);
      return { name, email };
    },

    async getOriginRemote(args: { laneId: string }): Promise<GitOriginRemoteSummary> {
      const fallback: GitOriginRemoteSummary = { remoteUrl: null, branch: null };
      const laneId = args.laneId.trim();
      if (!laneId) return fallback;
      const lane = laneService.getLaneBaseAndBranch(laneId);
      await assertLaneWorktreeRoot(lane);
      const [remoteRes, branchRes] = await Promise.all([
        runGit(["remote", "get-url", "origin"], { cwd: lane.worktreePath, timeoutMs: 8_000 }).catch(() => null),
        lane.branchRef?.trim()
          ? Promise.resolve(null)
          : runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: lane.worktreePath, timeoutMs: 8_000 }).catch(() => null),
      ]);
      const rawRemote = remoteRes?.exitCode === 0 ? remoteRes.stdout.trim() || null : null;
      const remoteUrl = ((): string | null => {
        if (!rawRemote) return rawRemote;
        try {
          const parsed = new URL(rawRemote);
          if (parsed.username || parsed.password) {
            parsed.username = "";
            parsed.password = "";
            return parsed.toString();
          }
          return rawRemote;
        } catch {
          return rawRemote;
        }
      })();
      let branch = lane.branchRef?.trim() || null;
      if (!branch && branchRes?.exitCode === 0) {
        const out = branchRes.stdout.trim();
        branch = out && out !== "HEAD" ? out : null;
      }
      return { remoteUrl, branch };
    },

    async getOpenPrForBranch(args: { laneId: string; branch?: string }): Promise<GitOpenPrSummary> {
      const fallback: GitOpenPrSummary = { prUrl: null, prNumber: null, title: null, headRefName: null };
      const laneId = args.laneId.trim();
      if (!laneId) return fallback;
      const lane = laneService.getLaneBaseAndBranch(laneId);
      await assertLaneWorktreeRoot(lane);
      const branch = args.branch?.trim() || lane.branchRef?.trim() || "";
      if (!branch) return fallback;

      try {
        const stdout = await new Promise<string>((resolve) => {
          let settled = false;
          let out = "";
          const child = spawn("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "url,number,title,headRefName", "--limit", "1"], {
            cwd: lane.worktreePath,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          const finish = (value: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { child.kill("SIGKILL"); } catch { /* noop */ }
            resolve(value);
          };
          const timer = setTimeout(() => finish(""), 8_000);
          child.stdout.on("data", (d: Buffer | string) => {
            out += Buffer.isBuffer(d) ? d.toString("utf8") : String(d);
          });
          child.stderr.on("data", () => { /* swallow auth state */ });
          child.on("error", () => finish(""));
          child.on("close", (code) => finish(code === 0 ? out : ""));
        });
        if (!stdout.trim()) return fallback;
        const parsed: unknown = JSON.parse(stdout);
        if (!Array.isArray(parsed) || parsed.length === 0) return fallback;
        const entry = parsed[0] as Record<string, unknown>;
        return {
          prUrl: typeof entry.url === "string" && entry.url ? entry.url : null,
          prNumber: typeof entry.number === "number" ? entry.number : null,
          title: typeof entry.title === "string" && entry.title ? entry.title : null,
          headRefName: typeof entry.headRefName === "string" && entry.headRefName ? entry.headRefName : null,
        };
      } catch {
        return fallback;
      }
    },

    async checkoutBranch(args: GitCheckoutBranchArgs): Promise<GitActionResult> {
      const branchName = args.branchName.trim();
      if (!branchName.length) throw new Error("Branch name is required");

      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_checkout_branch",
        reason: "checkout_branch",
        metadata: {
          branchName,
          mode: args.mode ?? "existing",
          startPoint: args.startPoint ?? null,
          baseRef: args.baseRef ?? null,
        },
        fn: async () => {
          await laneService.switchBranch(args);
        }
      });
      return action;
    }
  };
}
