import { randomUUID } from "node:crypto";
import type {
  ConflictExternalResolverRunSummary,
  MergeMethod,
  PrEventPayload,
  PrSummary,
  QueueRehearsalConfig,
  QueueRehearsalEntry,
  QueueRehearsalState,
  QueueRehearsalStateStatus,
  QueueRehearsalWaitReason,
  StartQueueRehearsalArgs,
} from "../../../shared/types";
import type { AdeDb } from "../state/kvDb";
import type { Logger } from "../logging/logger";
import type { createConflictService } from "../conflicts/conflictService";
import type { createLaneService } from "../lanes/laneService";
import { runGit, runGitOrThrow } from "../git/git";
import { getErrorMessage, normalizeBranchName, nowIso } from "../shared/utils";

type QueueRehearsalRow = {
  id: string;
  group_id: string;
  project_id: string;
  state: string;
  entries_json: string;
  config_json: string | null;
  current_position: number;
  scratch_lane_id: string | null;
  active_pr_id: string | null;
  active_resolver_run_id: string | null;
  last_error: string | null;
  wait_reason: string | null;
  started_at: string;
  completed_at: string | null;
  updated_at: string | null;
  group_name: string | null;
  target_branch: string | null;
};

type QueueGroupRow = {
  id: string;
  name: string | null;
  target_branch: string | null;
};

const DEFAULT_REHEARSAL_CONFIG: QueueRehearsalConfig = {
  method: "squash",
  autoResolve: false,
  resolverProvider: null,
  resolverModel: null,
  reasoningEffort: null,
  permissionMode: "guarded_edit",
  preserveScratchLane: true,
  originSurface: "manual",
  originMissionId: null,
  originRunId: null,
  originLabel: null,
};

function parseEntries(raw: string): QueueRehearsalEntry[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseConfig(raw: string | null | undefined): Partial<QueueRehearsalConfig> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Partial<QueueRehearsalConfig>;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function rowToState(row: QueueRehearsalRow): QueueRehearsalState {
  return {
    rehearsalId: row.id,
    groupId: row.group_id,
    groupName: row.group_name ?? null,
    targetBranch: row.target_branch ?? null,
    state: row.state as QueueRehearsalStateStatus,
    entries: parseEntries(row.entries_json),
    currentPosition: Number(row.current_position),
    scratchLaneId: row.scratch_lane_id ?? null,
    activePrId: row.active_pr_id ?? null,
    activeResolverRunId: row.active_resolver_run_id ?? null,
    lastError: row.last_error ?? null,
    waitReason: (row.wait_reason as QueueRehearsalWaitReason | null) ?? null,
    config: {
      ...DEFAULT_REHEARSAL_CONFIG,
      ...parseConfig(row.config_json),
    },
    startedAt: row.started_at,
    completedAt: row.completed_at ?? null,
    updatedAt: row.updated_at ?? row.completed_at ?? row.started_at,
  };
}

export function createQueueRehearsalService({
  db,
  logger,
  projectId,
  prService,
  laneService,
  conflictService,
  emitEvent,
  onStateChanged,
}: {
  db: AdeDb;
  logger: Logger;
  projectId: string;
  prService: {
    listGroupPrs: (groupId: string) => Promise<PrSummary[]>;
  };
  laneService: Pick<ReturnType<typeof createLaneService>, "list" | "getLaneBaseAndBranch" | "createChild" | "archive">;
  conflictService?: Pick<ReturnType<typeof createConflictService>, "runExternalResolver"> | null;
  emitEvent: (event: PrEventPayload) => void;
  onStateChanged?: (state: QueueRehearsalState) => void | Promise<void>;
}) {
  const activeRehearsalLoops = new Map<string, Promise<void>>();

  const Q_COLS = [
    "qrs.id",
    "qrs.group_id",
    "qrs.project_id",
    "qrs.state",
    "qrs.entries_json",
    "qrs.config_json",
    "qrs.current_position",
    "qrs.scratch_lane_id",
    "qrs.active_pr_id",
    "qrs.active_resolver_run_id",
    "qrs.last_error",
    "qrs.wait_reason",
    "qrs.started_at",
    "qrs.completed_at",
    "qrs.updated_at",
    "pg.name as group_name",
    "pg.target_branch as target_branch",
  ].join(", ");

  const getRow = (rehearsalId: string): QueueRehearsalRow | null =>
    db.get<QueueRehearsalRow>(
      `select ${Q_COLS}
       from queue_rehearsal_state qrs
       left join pr_groups pg on pg.id = qrs.group_id
       where qrs.id = ? and qrs.project_id = ?
       limit 1`,
      [rehearsalId, projectId],
    );

  const getRowByGroup = (groupId: string, includeCompleted = false): QueueRehearsalRow | null =>
    db.get<QueueRehearsalRow>(
      `select ${Q_COLS}
       from queue_rehearsal_state qrs
       left join pr_groups pg on pg.id = qrs.group_id
       where qrs.group_id = ? and qrs.project_id = ?
         ${includeCompleted ? "" : "and qrs.state in ('running', 'paused')"}
       order by qrs.started_at desc
       limit 1`,
      [groupId, projectId],
    );

  const listRows = (includeCompleted = true, limit = 50): QueueRehearsalRow[] =>
    db.all<QueueRehearsalRow>(
      `select ${Q_COLS}
       from queue_rehearsal_state qrs
       left join pr_groups pg on pg.id = qrs.group_id
       where qrs.project_id = ?
         ${includeCompleted ? "" : "and qrs.state in ('running', 'paused')"}
       order by qrs.started_at desc
       limit ?`,
      [projectId, limit],
    );

  const getGroup = (groupId: string): QueueGroupRow | null =>
    db.get<QueueGroupRow>(
      `select id, name, target_branch
       from pr_groups
       where id = ? and project_id = ? and group_type = 'queue'
       limit 1`,
      [groupId, projectId],
    );

  const notifyStateChanged = (state: QueueRehearsalState): void => {
    if (!onStateChanged) return;
    void Promise.resolve(onStateChanged(state)).catch((error) => {
      logger.debug("queue_rehearsal.state_change_callback_failed", {
        rehearsalId: state.rehearsalId,
        groupId: state.groupId,
        error: getErrorMessage(error),
      });
    });
  };

  const saveState = (state: QueueRehearsalState): void => {
    state.updatedAt = nowIso();
    db.run(
      `insert into queue_rehearsal_state(
         id, group_id, project_id, state, entries_json, config_json, current_position,
         scratch_lane_id, active_pr_id, active_resolver_run_id, last_error, wait_reason,
         started_at, completed_at, updated_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do update set
         state = excluded.state,
         entries_json = excluded.entries_json,
         config_json = excluded.config_json,
         current_position = excluded.current_position,
         scratch_lane_id = excluded.scratch_lane_id,
         active_pr_id = excluded.active_pr_id,
         active_resolver_run_id = excluded.active_resolver_run_id,
         last_error = excluded.last_error,
         wait_reason = excluded.wait_reason,
         completed_at = excluded.completed_at,
         updated_at = excluded.updated_at`,
      [
        state.rehearsalId,
        state.groupId,
        projectId,
        state.state,
        JSON.stringify(state.entries),
        JSON.stringify(state.config),
        state.currentPosition,
        state.scratchLaneId,
        state.activePrId,
        state.activeResolverRunId,
        state.lastError,
        state.waitReason,
        state.startedAt,
        state.completedAt,
        state.updatedAt,
      ],
    );
    notifyStateChanged(state);
  };

  const emitStep = (groupId: string, rehearsalId: string, prId: string, entryState: QueueRehearsalEntry["state"], position: number): void => {
    emitEvent({
      type: "queue-rehearsal-step",
      groupId,
      rehearsalId,
      prId,
      entryState,
      position,
      timestamp: nowIso(),
    });
  };

  const emitState = (groupId: string, rehearsalId: string, state: QueueRehearsalStateStatus, currentPosition: number): void => {
    emitEvent({
      type: "queue-rehearsal-state",
      groupId,
      rehearsalId,
      state,
      currentPosition,
      timestamp: nowIso(),
    });
  };

  const persistAndEmitState = (state: QueueRehearsalState): void => {
    saveState(state);
    emitState(state.groupId, state.rehearsalId, state.state, state.currentPosition);
  };

  const resolveConfig = (args: StartQueueRehearsalArgs): QueueRehearsalConfig => ({
    ...DEFAULT_REHEARSAL_CONFIG,
    method: args.method ?? "squash",
    autoResolve: args.autoResolve ?? false,
    resolverProvider: args.resolverProvider ?? null,
    resolverModel: args.resolverModel ?? null,
    reasoningEffort: args.reasoningEffort ?? null,
    permissionMode: args.permissionMode ?? "guarded_edit",
    preserveScratchLane: args.preserveScratchLane ?? true,
    originSurface: args.originSurface ?? "manual",
    originMissionId: args.originMissionId ?? null,
    originRunId: args.originRunId ?? null,
    originLabel: args.originLabel ?? null,
  });

  const resolveTargetLaneId = async (targetBranch: string | null): Promise<string | null> => {
    const normalizedTarget = normalizeBranchName(targetBranch ?? "");
    if (!normalizedTarget) return null;
    const lanes = await laneService.list({ includeArchived: false });
    const match = lanes.find((lane) => {
      const branch = normalizeBranchName(lane.branchRef);
      const base = normalizeBranchName(lane.baseRef);
      return lane.id === normalizedTarget || branch === normalizedTarget || base === normalizedTarget;
    });
    return match?.id ?? null;
  };

  const ensureScratchLane = async (state: QueueRehearsalState): Promise<string> => {
    if (state.scratchLaneId) return state.scratchLaneId;
    const targetLaneId = await resolveTargetLaneId(state.targetBranch);
    if (!targetLaneId) {
      throw new Error(`No lane is available for queue target branch "${state.targetBranch ?? "unknown"}".`);
    }
    const scratch = await laneService.createChild({
      parentLaneId: targetLaneId,
      name: `queue-rehearsal-${state.groupName ?? state.groupId}-${Date.now()}`,
      description: `Queue rehearsal scratch lane for ${state.groupName ?? state.groupId}`,
    });
    state.scratchLaneId = scratch.id;
    persistAndEmitState(state);
    return scratch.id;
  };

  const readChangedPaths = async (worktreePath: string, beforeRef: string, afterRef: string): Promise<string[]> => {
    const diff = await runGit(["diff", "--name-only", `${beforeRef}..${afterRef}`], {
      cwd: worktreePath,
      timeoutMs: 20_000,
    });
    if (diff.exitCode !== 0) return [];
    return diff.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  };

  const readPendingPaths = async (worktreePath: string): Promise<string[]> => {
    const status = await runGit(["status", "--porcelain"], { cwd: worktreePath, timeoutMs: 20_000 });
    if (status.exitCode !== 0) return [];
    return status.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  };

  const readConflictedPaths = async (worktreePath: string): Promise<string[]> => {
    const diff = await runGit(["diff", "--name-only", "--diff-filter=U"], {
      cwd: worktreePath,
      timeoutMs: 20_000,
    });
    if (diff.exitCode !== 0) return [];
    return diff.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  };

  const stageAndCommit = async (worktreePath: string, message: string): Promise<string | null> => {
    const pending = await readPendingPaths(worktreePath);
    if (!pending.length) {
      const sha = await runGit(["rev-parse", "HEAD"], { cwd: worktreePath, timeoutMs: 10_000 });
      return sha.exitCode === 0 ? sha.stdout.trim() : null;
    }
    await runGitOrThrow(["add", "-A"], { cwd: worktreePath, timeoutMs: 60_000 });
    await runGitOrThrow(["commit", "-m", message], { cwd: worktreePath, timeoutMs: 90_000 });
    const sha = await runGit(["rev-parse", "HEAD"], { cwd: worktreePath, timeoutMs: 10_000 });
    return sha.exitCode === 0 ? sha.stdout.trim() : null;
  };

  const abortOperation = async (worktreePath: string, method: MergeMethod): Promise<void> => {
    if (method === "rebase") {
      await runGit(["cherry-pick", "--abort"], { cwd: worktreePath, timeoutMs: 20_000 });
      return;
    }
    await runGit(["merge", "--abort"], { cwd: worktreePath, timeoutMs: 20_000 });
  };

  const runResolver = async (
    state: QueueRehearsalState,
    entry: QueueRehearsalEntry,
    scratchLaneId: string,
  ): Promise<{ ok: true; run: ConflictExternalResolverRunSummary } | { ok: false; error: string }> => {
    if (!state.config.autoResolve || !conflictService) {
      return { ok: false, error: "Queue rehearsal found conflicts that require manual resolution." };
    }
    const provider = state.config.resolverProvider
      ?? (state.config.resolverModel?.includes("anthropic/") ? "claude" : "codex");
    entry.state = "resolving";
    entry.updatedAt = nowIso();
    state.activeResolverRunId = null;
    persistAndEmitState(state);
    emitStep(state.groupId, state.rehearsalId, entry.prId, "resolving", entry.position);

    const run = await conflictService.runExternalResolver({
      provider,
      targetLaneId: scratchLaneId,
      sourceLaneIds: [entry.laneId],
      cwdLaneId: scratchLaneId,
      model: state.config.resolverModel,
      reasoningEffort: state.config.reasoningEffort,
      permissionMode: state.config.permissionMode,
      originSurface: state.config.originSurface,
      originMissionId: state.config.originMissionId,
      originRunId: state.config.originRunId,
      originLabel: state.config.originLabel ?? `queue-rehearsal:${state.groupId}`,
    });
    state.activeResolverRunId = run.runId;
    entry.resolverRunId = run.runId;
    persistAndEmitState(state);
    if (run.status !== "completed") {
      return { ok: false, error: run.error ?? "Shared resolver job did not complete successfully." };
    }
    return { ok: true, run };
  };

  const continueCherryPick = async (worktreePath: string): Promise<void> => {
    const result = await runGit(["cherry-pick", "--continue"], { cwd: worktreePath, timeoutMs: 90_000 });
    if (result.exitCode === 0) return;
    const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
    if (combined.includes("previous cherry-pick is now empty") || combined.includes("nothing to commit")) {
      await runGitOrThrow(["cherry-pick", "--skip"], { cwd: worktreePath, timeoutMs: 30_000 });
      return;
    }
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Unable to continue queue rehearsal cherry-pick.");
  };

  const rehearseMergeLike = async (
    state: QueueRehearsalState,
    entry: QueueRehearsalEntry,
    worktreePath: string,
    sourceBranch: string,
  ): Promise<{ commitSha: string | null; changedFiles: string[]; resolvedByAi: boolean; conflictPaths: string[] }> => {
    const beforeHead = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: worktreePath, timeoutMs: 10_000 })).trim();
    const args = state.config.method === "merge"
      ? ["merge", "--no-ff", "--no-commit", sourceBranch]
      : ["merge", "--squash", sourceBranch];
    const merge = await runGit(args, { cwd: worktreePath, timeoutMs: 120_000 });
    let resolvedByAi = false;
    let conflictPaths: string[] = [];
    if (merge.exitCode !== 0) {
      conflictPaths = await readConflictedPaths(worktreePath);
      if (!conflictPaths.length) {
        throw new Error(merge.stderr.trim() || merge.stdout.trim() || "Queue rehearsal merge failed.");
      }
      const resolved = await runResolver(state, entry, state.scratchLaneId!);
      if (!resolved.ok) {
        await abortOperation(worktreePath, state.config.method);
        throw new Error(resolved.error);
      }
      resolvedByAi = true;
      conflictPaths = conflictPaths.length > 0 ? conflictPaths : resolved.run.changedFiles;
    }
    const commitMessage = state.config.method === "merge"
      ? `Rehearse queue merge for PR #${entry.prNumber ?? entry.prId}`
      : `Rehearse queue squash for PR #${entry.prNumber ?? entry.prId}`;
    const commitSha = await stageAndCommit(worktreePath, commitMessage);
    const afterHead = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: worktreePath, timeoutMs: 10_000 })).trim();
    const changedFiles = beforeHead === afterHead ? [] : await readChangedPaths(worktreePath, beforeHead, afterHead);
    return { commitSha, changedFiles, resolvedByAi, conflictPaths };
  };

  const rehearseRebase = async (
    state: QueueRehearsalState,
    entry: QueueRehearsalEntry,
    worktreePath: string,
    sourceBranch: string,
  ): Promise<{ commitSha: string | null; changedFiles: string[]; resolvedByAi: boolean; conflictPaths: string[] }> => {
    const beforeHead = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: worktreePath, timeoutMs: 10_000 })).trim();
    const mergeBase = (await runGitOrThrow(["merge-base", "HEAD", sourceBranch], { cwd: worktreePath, timeoutMs: 10_000 })).trim();
    const commitsRaw = await runGit(["rev-list", "--reverse", `${mergeBase}..${sourceBranch}`], {
      cwd: worktreePath,
      timeoutMs: 30_000,
    });
    if (commitsRaw.exitCode !== 0) {
      throw new Error(commitsRaw.stderr.trim() || "Unable to enumerate commits for queue rehearsal rebase.");
    }
    const commits = commitsRaw.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    let resolvedByAi = false;
    let conflictPaths: string[] = [];
    for (const commit of commits) {
      const pick = await runGit(["cherry-pick", commit], { cwd: worktreePath, timeoutMs: 90_000 });
      if (pick.exitCode === 0) continue;
      conflictPaths = await readConflictedPaths(worktreePath);
      if (!conflictPaths.length) {
        const combined = `${pick.stdout}\n${pick.stderr}`.toLowerCase();
        if (combined.includes("previous cherry-pick is now empty") || combined.includes("nothing to commit")) {
          await runGitOrThrow(["cherry-pick", "--skip"], { cwd: worktreePath, timeoutMs: 30_000 });
          continue;
        }
        throw new Error(pick.stderr.trim() || pick.stdout.trim() || "Queue rehearsal cherry-pick failed.");
      }
      const resolved = await runResolver(state, entry, state.scratchLaneId!);
      if (!resolved.ok) {
        await abortOperation(worktreePath, "rebase");
        throw new Error(resolved.error);
      }
      resolvedByAi = true;
      await runGitOrThrow(["add", "-A"], { cwd: worktreePath, timeoutMs: 60_000 });
      await continueCherryPick(worktreePath);
    }
    const afterHead = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: worktreePath, timeoutMs: 10_000 })).trim();
    const changedFiles = beforeHead === afterHead ? [] : await readChangedPaths(worktreePath, beforeHead, afterHead);
    return {
      commitSha: afterHead,
      changedFiles,
      resolvedByAi,
      conflictPaths,
    };
  };

  const maybeArchiveScratchLane = (state: QueueRehearsalState): void => {
    if (state.config.preserveScratchLane || !state.scratchLaneId) return;
    try {
      laneService.archive({ laneId: state.scratchLaneId });
    } catch (error) {
      logger.warn("queue_rehearsal.archive_scratch_failed", {
        rehearsalId: state.rehearsalId,
        scratchLaneId: state.scratchLaneId,
        error: getErrorMessage(error),
      });
    }
  };

  const markFailure = (
    state: QueueRehearsalState,
    entry: QueueRehearsalEntry,
    waitReason: QueueRehearsalWaitReason,
    message: string,
    entryState: QueueRehearsalEntry["state"] = "failed",
  ): void => {
    entry.state = entryState;
    entry.updatedAt = nowIso();
    entry.error = message;
    state.state = entryState === "blocked" ? "paused" : "failed";
    state.lastError = message;
    state.waitReason = waitReason;
    state.activePrId = entry.prId;
    state.completedAt = state.state === "failed" ? nowIso() : null;
    persistAndEmitState(state);
    emitStep(state.groupId, state.rehearsalId, entry.prId, entry.state, entry.position);
    if (state.state === "failed") maybeArchiveScratchLane(state);
  };

  const launchLoop = (rehearsalId: string): void => {
    const prior = activeRehearsalLoops.get(rehearsalId) ?? Promise.resolve();
    const loopPromise = prior.then(async () => {
      const row = getRow(rehearsalId);
      if (!row) return;
      const state = rowToState(row);
      if (state.state !== "running") return;

      const scratchLaneId = await ensureScratchLane(state);
      const scratch = laneService.getLaneBaseAndBranch(scratchLaneId);
      for (let index = state.currentPosition; index < state.entries.length; index += 1) {
        const entry = state.entries[index]!;
        if (entry.state === "ready" || entry.state === "resolved" || entry.state === "cancelled") {
          state.currentPosition = index + 1;
          continue;
        }
        state.currentPosition = index;
        state.activePrId = entry.prId;
        state.activeResolverRunId = null;
        state.lastError = null;
        state.waitReason = null;
        entry.state = "rehearsing";
        entry.updatedAt = nowIso();
        persistAndEmitState(state);
        emitStep(state.groupId, state.rehearsalId, entry.prId, "rehearsing", entry.position);

        const lane = laneService.getLaneBaseAndBranch(entry.laneId);
        const sourceBranch = normalizeBranchName(lane.branchRef);

        try {
          const result = state.config.method === "rebase"
            ? await rehearseRebase(state, entry, scratch.worktreePath, sourceBranch)
            : await rehearseMergeLike(state, entry, scratch.worktreePath, sourceBranch);
          entry.state = result.resolvedByAi ? "resolved" : "ready";
          entry.updatedAt = nowIso();
          entry.resolvedByAi = result.resolvedByAi;
          entry.simulatedCommitSha = result.commitSha;
          entry.changedFiles = result.changedFiles;
          entry.conflictPaths = result.conflictPaths;
          entry.error = undefined;
          state.activePrId = null;
          state.activeResolverRunId = null;
          persistAndEmitState(state);
          emitStep(state.groupId, state.rehearsalId, entry.prId, entry.state, entry.position);
        } catch (error) {
          const message = getErrorMessage(error);
          const waitReason: QueueRehearsalWaitReason = message.includes("manual") ? "manual" : "resolver_failed";
          markFailure(
            state,
            entry,
            waitReason,
            message,
            waitReason === "manual" ? "blocked" : "failed",
          );
          return;
        }
      }

      state.state = "completed";
      state.activePrId = null;
      state.activeResolverRunId = null;
      state.lastError = null;
      state.waitReason = null;
      state.currentPosition = state.entries.length;
      state.completedAt = nowIso();
      persistAndEmitState(state);
      maybeArchiveScratchLane(state);
    }).catch((error) => {
      const row = getRow(rehearsalId);
      if (row) {
        const state = rowToState(row);
        state.state = "failed";
        state.lastError = getErrorMessage(error);
        state.waitReason = "manual";
        state.completedAt = nowIso();
        persistAndEmitState(state);
        maybeArchiveScratchLane(state);
      }
      logger.error("queue_rehearsal.loop_fatal", {
        rehearsalId,
        error: getErrorMessage(error),
      });
    });
    activeRehearsalLoops.set(rehearsalId, loopPromise);
    void loopPromise.finally(() => {
      if (activeRehearsalLoops.get(rehearsalId) === loopPromise) {
        activeRehearsalLoops.delete(rehearsalId);
      }
    });
  };

  const startQueueRehearsal = async (args: StartQueueRehearsalArgs): Promise<QueueRehearsalState> => {
    const existing = getRowByGroup(args.groupId);
    if (existing && existing.state === "running") {
      return rowToState(existing);
    }

    const group = getGroup(args.groupId);
    const prs = await prService.listGroupPrs(args.groupId);
    const entries: QueueRehearsalEntry[] = prs.map((pr, index) => ({
      prId: pr.id,
      laneId: pr.laneId,
      laneName: pr.title || pr.headBranch,
      position: index,
      prNumber: pr.githubPrNumber,
      githubUrl: pr.githubUrl,
      state: pr.state === "open" || pr.state === "draft" ? "pending" : "cancelled",
      updatedAt: null,
    }));
    const rehearsalId = randomUUID();
    const now = nowIso();
    const state: QueueRehearsalState = {
      rehearsalId,
      groupId: args.groupId,
      groupName: group?.name ?? null,
      targetBranch: group?.target_branch ?? prs[0]?.baseBranch ?? null,
      state: "running",
      entries,
      currentPosition: 0,
      scratchLaneId: null,
      activePrId: entries.find((entry) => entry.state === "pending")?.prId ?? null,
      activeResolverRunId: null,
      lastError: null,
      waitReason: null,
      config: resolveConfig(args),
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    };
    persistAndEmitState(state);
    launchLoop(rehearsalId);
    return state;
  };

  const cancelQueueRehearsal = (rehearsalId: string): QueueRehearsalState | null => {
    const row = getRow(rehearsalId);
    if (!row) return null;
    const state = rowToState(row);
    if (state.state === "completed" || state.state === "cancelled" || state.state === "failed") return state;
    for (const entry of state.entries) {
      if (entry.state === "pending" || entry.state === "rehearsing" || entry.state === "resolving") {
        entry.state = "cancelled";
        entry.updatedAt = nowIso();
      }
    }
    state.state = "cancelled";
    state.lastError = "Queue rehearsal cancelled by operator.";
    state.waitReason = "canceled";
    state.activePrId = null;
    state.activeResolverRunId = null;
    state.completedAt = nowIso();
    persistAndEmitState(state);
    maybeArchiveScratchLane(state);
    return state;
  };

  const getQueueRehearsalState = (rehearsalId: string): QueueRehearsalState | null => {
    const row = getRow(rehearsalId);
    return row ? rowToState(row) : null;
  };

  const getQueueRehearsalStateByGroup = (groupId: string): QueueRehearsalState | null => {
    const row = getRowByGroup(groupId, true);
    return row ? rowToState(row) : null;
  };

  const listQueueRehearsals = (args: { includeCompleted?: boolean; limit?: number } = {}): QueueRehearsalState[] =>
    listRows(args.includeCompleted ?? true, args.limit ?? 50).map(rowToState);

  const init = (): void => {
    const interrupted = db.all<QueueRehearsalRow>(
      `select ${Q_COLS}
       from queue_rehearsal_state qrs
       left join pr_groups pg on pg.id = qrs.group_id
       where qrs.project_id = ? and qrs.state = 'running'`,
      [projectId],
    );
    for (const row of interrupted) {
      const state = rowToState(row);
      state.state = "paused";
      state.lastError = "Queue rehearsal was interrupted by app shutdown and should be rerun.";
      state.waitReason = "manual";
      const currentEntry = state.entries[state.currentPosition];
      if (currentEntry && (currentEntry.state === "rehearsing" || currentEntry.state === "resolving")) {
        currentEntry.state = "blocked";
        currentEntry.updatedAt = nowIso();
      }
      persistAndEmitState(state);
    }
  };

  return {
    startQueueRehearsal,
    cancelQueueRehearsal,
    getQueueRehearsalState,
    getQueueRehearsalStateByGroup,
    listQueueRehearsals,
    init,
  };
}
