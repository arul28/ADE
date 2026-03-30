import { randomUUID } from "node:crypto";
import type {
  ConflictExternalResolverRunSummary,
  MergeMethod,
  PrEventPayload,
  PrStatus,
  PrSummary,
  QueueAutomationConfig,
  QueueEntryState,
  QueueLandingEntry,
  QueueLandingState,
  QueueState,
  QueueWaitReason,
  ResumeQueueAutomationArgs,
  StartQueueAutomationArgs,
} from "../../../shared/types";
import type { AdeDb } from "../state/kvDb";
import type { Logger } from "../logging/logger";
import type { createConflictService } from "../conflicts/conflictService";
import type { createLaneService } from "../lanes/laneService";
import { runGit, runGitOrThrow } from "../git/git";
import { getErrorMessage, normalizeBranchName, nowIso } from "../shared/utils";

type QueueLandingRow = {
  id: string;
  group_id: string;
  project_id: string;
  state: string;
  entries_json: string;
  config_json: string | null;
  current_position: number;
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
  auto_rebase: number;
  ci_gating: number;
  target_branch: string | null;
};

const DEFAULT_QUEUE_CONFIG: QueueAutomationConfig = {
  method: "squash",
  archiveLane: false,
  autoResolve: false,
  ciGating: true,
  resolverProvider: null,
  resolverModel: null,
  reasoningEffort: null,
  permissionMode: "guarded_edit",
  confidenceThreshold: null,
  originSurface: "manual",
  originMissionId: null,
  originRunId: null,
  originLabel: null,
};

function parseEntries(raw: string): QueueLandingEntry[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseConfig(raw: string | null | undefined): Partial<QueueAutomationConfig> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Partial<QueueAutomationConfig>;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function rowToState(row: QueueLandingRow): QueueLandingState {
  return {
    queueId: row.id,
    groupId: row.group_id,
    groupName: row.group_name ?? null,
    targetBranch: row.target_branch ?? null,
    state: row.state as QueueState,
    entries: parseEntries(row.entries_json),
    currentPosition: Number(row.current_position),
    activePrId: row.active_pr_id ?? null,
    activeResolverRunId: row.active_resolver_run_id ?? null,
    lastError: row.last_error ?? null,
    waitReason: (row.wait_reason as QueueWaitReason | null) ?? null,
    config: {
      ...DEFAULT_QUEUE_CONFIG,
      ...parseConfig(row.config_json),
    },
    startedAt: row.started_at,
    completedAt: row.completed_at ?? null,
    updatedAt: row.updated_at ?? row.completed_at ?? row.started_at,
  };
}

export function createQueueLandingService({
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
    land: (args: { prId: string; method: MergeMethod; archiveLane?: boolean }) => Promise<{
      prId: string;
      prNumber: number;
      success: boolean;
      mergeCommitSha: string | null;
      branchDeleted: boolean;
      laneArchived: boolean;
      error: string | null;
    }>;
    listGroupPrs: (groupId: string) => Promise<PrSummary[]>;
    getStatus: (prId: string) => Promise<PrStatus>;
  };
  laneService: Pick<ReturnType<typeof createLaneService>, "list" | "getLaneBaseAndBranch">;
  conflictService?: Pick<ReturnType<typeof createConflictService>, "runExternalResolver"> | null;
  emitEvent: (event: PrEventPayload) => void;
  onStateChanged?: (state: QueueLandingState) => void | Promise<void>;
}) {
  const activeLandingLoops = new Map<string, Promise<void>>();

  const Q_COLS = [
    "qls.id",
    "qls.group_id",
    "qls.project_id",
    "qls.state",
    "qls.entries_json",
    "qls.config_json",
    "qls.current_position",
    "qls.active_pr_id",
    "qls.active_resolver_run_id",
    "qls.last_error",
    "qls.wait_reason",
    "qls.started_at",
    "qls.completed_at",
    "qls.updated_at",
    "pg.name as group_name",
    "pg.target_branch as target_branch",
  ].join(", ");

  const getRow = (queueId: string): QueueLandingRow | null =>
    db.get<QueueLandingRow>(
      `select ${Q_COLS}
       from queue_landing_state qls
       left join pr_groups pg on pg.id = qls.group_id
       where qls.id = ? and qls.project_id = ?
       limit 1`,
      [queueId, projectId],
    );

  const getRowByGroup = (groupId: string, includeCompleted = false): QueueLandingRow | null =>
    db.get<QueueLandingRow>(
      `select ${Q_COLS}
       from queue_landing_state qls
       left join pr_groups pg on pg.id = qls.group_id
       where qls.group_id = ? and qls.project_id = ?
         ${includeCompleted ? "" : "and qls.state in ('landing', 'paused')"}
       order by qls.started_at desc
       limit 1`,
      [groupId, projectId],
    );

  const listRows = (includeCompleted = true, limit = 50): QueueLandingRow[] =>
    db.all<QueueLandingRow>(
      `select ${Q_COLS}
       from queue_landing_state qls
       left join pr_groups pg on pg.id = qls.group_id
       where qls.project_id = ?
         ${includeCompleted ? "" : "and qls.state in ('landing', 'paused')"}
       order by qls.started_at desc
       limit ?`,
      [projectId, limit],
    );

  const getGroup = (groupId: string): QueueGroupRow | null =>
    db.get<QueueGroupRow>(
      `select id, name, auto_rebase, ci_gating, target_branch
       from pr_groups
       where id = ? and project_id = ? and group_type = 'queue'
       limit 1`,
      [groupId, projectId],
    );

  const notifyStateChanged = (state: QueueLandingState): void => {
    if (!onStateChanged) return;
    void Promise.resolve(onStateChanged(state)).catch((error) => {
      logger.debug("queue_landing.state_change_callback_failed", {
        queueId: state.queueId,
        groupId: state.groupId,
        error: getErrorMessage(error),
      });
    });
  };

  const saveState = (state: QueueLandingState): void => {
    const updatedAt = nowIso();
    state.updatedAt = updatedAt;
    db.run(
      `insert into queue_landing_state(
         id, group_id, project_id, state, entries_json, config_json, current_position,
         active_pr_id, active_resolver_run_id, last_error, wait_reason, started_at, completed_at, updated_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do update set
         state = excluded.state,
         entries_json = excluded.entries_json,
         config_json = excluded.config_json,
         current_position = excluded.current_position,
         active_pr_id = excluded.active_pr_id,
         active_resolver_run_id = excluded.active_resolver_run_id,
         last_error = excluded.last_error,
         wait_reason = excluded.wait_reason,
         completed_at = excluded.completed_at,
         updated_at = excluded.updated_at`,
      [
        state.queueId,
        state.groupId,
        projectId,
        state.state,
        JSON.stringify(state.entries),
        JSON.stringify(state.config),
        state.currentPosition,
        state.activePrId,
        state.activeResolverRunId,
        state.lastError,
        state.waitReason,
        state.startedAt,
        state.completedAt,
        updatedAt,
      ],
    );
    notifyStateChanged(state);
  };

  const emitQueueStep = (groupId: string, prId: string, entryState: QueueEntryState, position: number): void => {
    emitEvent({
      type: "queue-step",
      groupId,
      prId,
      entryState,
      position,
      timestamp: nowIso(),
    });
  };

  const emitQueueState = (groupId: string, state: QueueState, currentPosition: number): void => {
    emitEvent({
      type: "queue-state",
      groupId,
      state,
      currentPosition,
      timestamp: nowIso(),
    });
  };

  const persistAndEmitState = (state: QueueLandingState): void => {
    saveState(state);
    emitQueueState(state.groupId, state.state, state.currentPosition);
  };

  const resolveQueueConfig = (
    args: StartQueueAutomationArgs | ResumeQueueAutomationArgs,
    existing?: QueueLandingState | null,
    group?: QueueGroupRow | null,
  ): QueueAutomationConfig => {
    const prior = existing?.config ?? DEFAULT_QUEUE_CONFIG;
    return {
      ...DEFAULT_QUEUE_CONFIG,
      ...prior,
      method: args.method ?? prior.method ?? "squash",
      archiveLane: args.archiveLane ?? prior.archiveLane ?? false,
      autoResolve: args.autoResolve ?? prior.autoResolve ?? false,
      ciGating: args.ciGating ?? prior.ciGating ?? Boolean(group?.ci_gating),
      resolverProvider: args.resolverProvider ?? prior.resolverProvider ?? null,
      resolverModel: args.resolverModel ?? prior.resolverModel ?? null,
      reasoningEffort: args.reasoningEffort ?? prior.reasoningEffort ?? null,
      permissionMode: args.permissionMode ?? prior.permissionMode ?? "guarded_edit",
      confidenceThreshold: args.confidenceThreshold ?? prior.confidenceThreshold ?? null,
      originSurface: args.originSurface ?? prior.originSurface ?? "manual",
      originMissionId: args.originMissionId ?? prior.originMissionId ?? null,
      originRunId: args.originRunId ?? prior.originRunId ?? null,
      originLabel: args.originLabel ?? prior.originLabel ?? null,
    };
  };

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

  const readModifiedPaths = async (worktreePath: string): Promise<string[]> => {
    const status = await runGit(["status", "--porcelain"], { cwd: worktreePath, timeoutMs: 20_000 });
    if (status.exitCode !== 0) return [];
    return status.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  };

  const pushLaneBranch = async (laneId: string): Promise<void> => {
    const lane = laneService.getLaneBaseAndBranch(laneId);
    const upstreamCheck = await runGit(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      { cwd: lane.worktreePath, timeoutMs: 10_000 },
    );
    if (upstreamCheck.exitCode === 0) {
      const pushResult = await runGit(["push"], { cwd: lane.worktreePath, timeoutMs: 60_000 });
      if (pushResult.exitCode !== 0) {
        const stderr = pushResult.stderr ?? "";
        if (stderr.includes("non-fast-forward") || stderr.includes("rejected")) {
          await runGitOrThrow(["push", "--force-with-lease"], { cwd: lane.worktreePath, timeoutMs: 60_000 });
        } else {
          throw new Error(stderr.trim() || "Failed to push lane after AI conflict resolution.");
        }
      }
      return;
    }
    const branchName = normalizeBranchName(lane.branchRef);
    await runGitOrThrow(["push", "-u", "origin", branchName], { cwd: lane.worktreePath, timeoutMs: 60_000 });
  };

  const isMergeConflictMessage = (message: string | null | undefined): boolean => {
    const value = (message ?? "").toLowerCase();
    return value.includes("merge conflict") || value.includes("resolve conflicts");
  };

  const ALLOWED_TRANSITIONS: Record<QueueEntryState, readonly QueueEntryState[]> = {
    pending: ["landing", "rebasing", "skipped", "paused"],
    landing: ["landing", "landed", "failed", "paused"],
    rebasing: ["resolving", "pending", "failed", "paused"],
    resolving: ["landing", "pending", "failed", "paused"],
    landed: [],
    failed: [],
    skipped: [],
    paused: ["pending", "landing", "skipped"],
  };

  const isValidTransition = (from: QueueEntryState, to: QueueEntryState): boolean => {
    return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
  };

  /** Log and reject an invalid transition. Returns true when the transition is allowed. */
  const guardTransition = (
    entry: QueueLandingEntry,
    to: QueueEntryState,
    context?: Record<string, unknown>,
  ): boolean => {
    if (isValidTransition(entry.state, to)) return true;
    logger.warn("queue_landing.invalid_transition", {
      prId: entry.prId,
      from: entry.state,
      to,
      ...context,
    });
    return false;
  };

  /** Mark an entry as successfully landed and advance the queue position. */
  const markEntryLanded = (
    state: QueueLandingState,
    entry: QueueLandingEntry,
    index: number,
    mergeCommitSha: string | null | undefined,
  ): void => {
    entry.state = "landed";
    entry.error = undefined;
    entry.waitingOn = null;
    entry.mergeCommitSha = mergeCommitSha;
    entry.updatedAt = nowIso();
    state.currentPosition = index + 1;
    state.activePrId = null;
    state.activeResolverRunId = null;
    state.lastError = null;
    state.waitReason = null;
    persistAndEmitState(state);
    emitQueueStep(state.groupId, entry.prId, "landed", index);
  };

  const pauseWithReason = (
    state: QueueLandingState,
    entry: QueueLandingEntry,
    waitReason: QueueWaitReason,
    message: string,
  ): QueueLandingState => {
    if (!guardTransition(entry, "paused", { reason: message })) return state;
    entry.state = "paused";
    entry.waitingOn = waitReason;
    entry.error = message;
    entry.updatedAt = nowIso();
    state.state = "paused";
    state.lastError = message;
    state.waitReason = waitReason;
    state.activePrId = entry.prId;
    persistAndEmitState(state);
    emitQueueStep(state.groupId, entry.prId, "paused", entry.position);
    return state;
  };

  const failEntry = (
    state: QueueLandingState,
    entry: QueueLandingEntry,
    waitReason: QueueWaitReason,
    message: string,
  ): QueueLandingState => {
    if (!guardTransition(entry, "failed", { reason: message })) return state;
    entry.state = "failed";
    entry.waitingOn = waitReason;
    entry.error = message;
    entry.updatedAt = nowIso();
    state.state = "paused";
    state.lastError = message;
    state.waitReason = waitReason;
    state.activePrId = entry.prId;
    persistAndEmitState(state);
    emitQueueStep(state.groupId, entry.prId, "failed", entry.position);
    return state;
  };

  const maybeResolveConflict = async (
    state: QueueLandingState,
    entry: QueueLandingEntry,
  ): Promise<{ ok: true; run: ConflictExternalResolverRunSummary } | { ok: false; error: string }> => {
    if (!state.config.autoResolve || !conflictService) {
      return { ok: false, error: "Queue merge conflict requires manual resolution." };
    }
    const targetLaneId = await resolveTargetLaneId(state.targetBranch);
    if (!targetLaneId) {
      return { ok: false, error: `No lane is available for queue target branch "${state.targetBranch ?? "unknown"}".` };
    }
    const provider = state.config.resolverProvider
      ?? (state.config.resolverModel?.includes("anthropic/") ? "claude" : "codex");
    entry.state = "resolving";
    entry.waitingOn = null;
    entry.error = undefined;
    entry.updatedAt = nowIso();
    state.activePrId = entry.prId;
    state.waitReason = null;
    state.lastError = null;
    persistAndEmitState(state);
    emitQueueStep(state.groupId, entry.prId, "resolving", entry.position);

    const run = await conflictService.runExternalResolver({
      provider,
      targetLaneId,
      sourceLaneIds: [entry.laneId],
      model: state.config.resolverModel,
      reasoningEffort: state.config.reasoningEffort,
      permissionMode: state.config.permissionMode,
      originSurface: state.config.originSurface,
      originMissionId: state.config.originMissionId,
      originRunId: state.config.originRunId,
      originLabel: state.config.originLabel ?? `queue:${state.groupId}`,
    });
    state.activeResolverRunId = run.runId;
    entry.resolverRunId = run.runId;
    persistAndEmitState(state);

    if (run.status !== "completed") {
      return {
        ok: false,
        error: run.error ?? "Shared resolver job did not complete successfully.",
      };
    }

    const lane = laneService.getLaneBaseAndBranch(entry.laneId);
    const touchedPaths = run.changedFiles.length > 0 ? run.changedFiles : await readModifiedPaths(lane.worktreePath);
    if (touchedPaths.length === 0) {
      return {
        ok: false,
        error: "Shared resolver completed without any staged or modified files to commit.",
      };
    }

    const commitMessage = `Resolve queue conflicts for PR #${entry.prNumber ?? entry.prId} via ADE`;
    await runGitOrThrow(["add", "--", ...touchedPaths], { cwd: lane.worktreePath, timeoutMs: 60_000 });
    await runGitOrThrow(["commit", "-m", commitMessage, "--", ...touchedPaths], {
      cwd: lane.worktreePath,
      timeoutMs: 90_000,
    });
    const shaResult = await runGit(["rev-parse", "HEAD"], { cwd: lane.worktreePath, timeoutMs: 10_000 });
    const commitSha = shaResult.exitCode === 0 ? shaResult.stdout.trim() : null;
    await pushLaneBranch(entry.laneId);

    entry.resolvedByAi = true;
    // Return the entry to the landing state before the retry attempt so the
    // existing queue transition rules still apply on the second land call.
    entry.state = "landing";
    entry.mergeCommitSha = commitSha;
    entry.updatedAt = nowIso();
    entry.error = undefined;
    state.activeResolverRunId = null;
    state.lastError = null;
    state.waitReason = null;
    persistAndEmitState(state);
    return { ok: true, run };
  };

  /** Re-read the persisted row and return true if the queue has been cancelled or completed externally. */
  const isQueueCancelledOrDone = (queueId: string): boolean => {
    const freshRow = getRow(queueId);
    if (!freshRow) return true;
    const freshState = freshRow.state as QueueState;
    return freshState === "cancelled" || freshState === "completed";
  };

  const launchLandingLoop = (queueId: string): void => {
    const prior = activeLandingLoops.get(queueId) ?? Promise.resolve();
    const loopPromise = prior.then(async () => {
      for (;;) {
        const row = getRow(queueId);
        if (!row) return;
        const state = rowToState(row);
        if (state.state !== "landing") return;

        let index = state.currentPosition;
        while (index < state.entries.length && (state.entries[index]!.state === "landed" || state.entries[index]!.state === "skipped")) {
          index += 1;
        }

        if (index >= state.entries.length) {
          state.state = "completed";
          state.activePrId = null;
          state.activeResolverRunId = null;
          state.lastError = null;
          state.waitReason = null;
          state.currentPosition = state.entries.length;
          state.completedAt = nowIso();
          persistAndEmitState(state);
          logger.info("queue_landing.completed", { queueId, groupId: state.groupId });
          return;
        }

        const entry = state.entries[index]!;
        if (!guardTransition(entry, "landing", { queueId })) return;
        state.currentPosition = index;
        state.activePrId = entry.prId;
        state.activeResolverRunId = null;
        state.lastError = null;
        state.waitReason = null;
        entry.state = "landing";
        entry.waitingOn = null;
        entry.updatedAt = nowIso();
        persistAndEmitState(state);
        emitQueueStep(state.groupId, entry.prId, "landing", index);

        try {
          if (state.config.ciGating) {
            const status = await prService.getStatus(entry.prId);
            if (isQueueCancelledOrDone(queueId)) {
              logger.debug("queue_landing.cancelled_after_ci_check", { queueId, prId: entry.prId });
              return;
            }
            if (status.checksStatus === "pending" || status.checksStatus === "failing") {
              pauseWithReason(
                state,
                entry,
                "ci",
                status.checksStatus === "pending"
                  ? "Waiting for CI to finish before landing the next queue PR."
                  : "Queue auto-land paused because CI is failing for the active PR.",
              );
              logger.info("queue_landing.waiting_for_ci", { queueId, prId: entry.prId, checksStatus: status.checksStatus });
              return;
            }
            if (status.reviewStatus === "requested" || status.reviewStatus === "changes_requested") {
              pauseWithReason(
                state,
                entry,
                "review",
                status.reviewStatus === "changes_requested"
                  ? "Queue auto-land paused because the active PR has requested changes."
                  : "Queue auto-land paused pending operator review approval.",
              );
              logger.info("queue_landing.waiting_for_review", { queueId, prId: entry.prId, reviewStatus: status.reviewStatus });
              return;
            }
          }

          const landResult = await prService.land({
            prId: entry.prId,
            method: state.config.method,
            archiveLane: state.config.archiveLane,
          });
          if (isQueueCancelledOrDone(queueId)) {
            logger.debug("queue_landing.cancelled_after_land", { queueId, prId: entry.prId });
            return;
          }
          if (!landResult.success && isMergeConflictMessage(landResult.error)) {
            const resolved = await maybeResolveConflict(state, entry);
            if (isQueueCancelledOrDone(queueId)) {
              logger.debug("queue_landing.cancelled_after_resolve", { queueId, prId: entry.prId });
              return;
            }
            if (!resolved.ok) {
              failEntry(state, entry, resolved.error.includes("manual") ? "manual" : "resolver_failed", resolved.error);
              logger.warn("queue_landing.resolve_failed", {
                queueId,
                prId: entry.prId,
                error: resolved.error,
              });
              return;
            }
            // The shared resolver hands control back to the normal landing path.
            // Mark the entry as landing again so the retry can complete valid queue-state transitions.
            entry.state = "landing";
            entry.updatedAt = nowIso();
            const retried = await prService.land({
              prId: entry.prId,
              method: state.config.method,
              archiveLane: state.config.archiveLane,
            });
            if (isQueueCancelledOrDone(queueId)) {
              logger.debug("queue_landing.cancelled_after_retry_land", { queueId, prId: entry.prId });
              return;
            }
            if (!retried.success) {
              if (state.config.ciGating && isMergeConflictMessage(retried.error)) {
                failEntry(state, entry, "merge_conflict", retried.error ?? "Queue PR still has merge conflicts after AI resolution.");
              } else if (state.config.ciGating) {
                pauseWithReason(state, entry, "ci", retried.error ?? "Queue landing remains gated after AI resolution.");
              } else {
                failEntry(state, entry, "merge_blocked", retried.error ?? "Queue landing failed after AI resolution.");
              }
              return;
            }
            if (!guardTransition(entry, "landed", { queueId })) return;
            markEntryLanded(state, entry, index, retried.mergeCommitSha);
            continue;
          }

          if (!landResult.success) {
            const errorMessage = landResult.error ?? "Queue landing failed.";
            const reason: QueueWaitReason = state.config.ciGating ? "merge_blocked" : "manual";
            failEntry(state, entry, reason, errorMessage);
            logger.warn("queue_landing.entry_failed", {
              queueId,
              prId: entry.prId,
              error: errorMessage,
            });
            return;
          }

          if (!guardTransition(entry, "landed", { queueId })) return;
          markEntryLanded(state, entry, index, landResult.mergeCommitSha);
        } catch (error) {
          const message = getErrorMessage(error);
          failEntry(state, entry, "manual", message);
          logger.error("queue_landing.entry_error", {
            queueId,
            prId: entry.prId,
            error: message,
          });
          return;
        }
      }
    }).catch((error) => {
      const row = getRow(queueId);
      if (row) {
        const state = rowToState(row);
        state.state = "paused";
        state.lastError = getErrorMessage(error);
        state.waitReason = "manual";
        persistAndEmitState(state);
      }
      logger.error("queue_landing.loop_fatal", {
        queueId,
        error: getErrorMessage(error),
      });
    });
    activeLandingLoops.set(queueId, loopPromise);
    void loopPromise.finally(() => {
      if (activeLandingLoops.get(queueId) === loopPromise) {
        activeLandingLoops.delete(queueId);
      }
    });
  };

  const startQueue = async (args: StartQueueAutomationArgs): Promise<QueueLandingState> => {
    const existing = getRowByGroup(args.groupId);
    if (existing && existing.state === "landing") {
      return rowToState(existing);
    }

    const group = getGroup(args.groupId);
    const prs = await prService.listGroupPrs(args.groupId);
    const entries: QueueLandingEntry[] = prs.map((pr, index) => ({
      prId: pr.id,
      laneId: pr.laneId,
      laneName: pr.title || pr.headBranch,
      position: index,
      prNumber: pr.githubPrNumber,
      githubUrl: pr.githubUrl,
      state: "pending",
      updatedAt: null,
    }));

    const queueId = randomUUID();
    const now = nowIso();
    const queueState: QueueLandingState = {
      queueId,
      groupId: args.groupId,
      groupName: group?.name ?? null,
      targetBranch: group?.target_branch ?? prs[0]?.baseBranch ?? null,
      state: "landing",
      entries,
      currentPosition: 0,
      activePrId: entries[0]?.prId ?? null,
      activeResolverRunId: null,
      lastError: null,
      waitReason: null,
      config: resolveQueueConfig(args, null, group),
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    };

    persistAndEmitState(queueState);
    logger.info("queue_landing.started", {
      queueId,
      groupId: args.groupId,
      entryCount: entries.length,
      method: queueState.config.method,
      autoResolve: queueState.config.autoResolve,
    });
    launchLandingLoop(queueId);
    return queueState;
  };

  const pauseQueue = (queueId: string): QueueLandingState | null => {
    const row = getRow(queueId);
    if (!row) return null;
    const state = rowToState(row);
    if (state.state !== "landing") return state;
    state.state = "paused";
    state.lastError = state.lastError ?? "Queue automation paused by operator.";
    state.waitReason = state.waitReason ?? "manual";
    persistAndEmitState(state);
    logger.info("queue_landing.paused", { queueId, groupId: state.groupId });
    return state;
  };

  const resumeQueue = (args: ResumeQueueAutomationArgs): QueueLandingState | null => {
    const row = getRow(args.queueId);
    if (!row) return null;
    const state = rowToState(row);
    if (state.state !== "paused") return state;
    state.config = resolveQueueConfig(args, state, getGroup(state.groupId));
    const currentEntry = state.entries[state.currentPosition];
    if (currentEntry && (currentEntry.state === "failed" || currentEntry.state === "paused" || currentEntry.state === "resolving" || currentEntry.state === "landing")) {
      currentEntry.state = "pending";
      currentEntry.error = undefined;
      currentEntry.waitingOn = null;
      currentEntry.updatedAt = nowIso();
    }
    state.state = "landing";
    state.lastError = null;
    state.waitReason = null;
    state.activeResolverRunId = null;
    persistAndEmitState(state);
    logger.info("queue_landing.resumed", {
      queueId: state.queueId,
      groupId: state.groupId,
      autoResolve: state.config.autoResolve,
      method: state.config.method,
    });
    launchLandingLoop(state.queueId);
    return state;
  };

  const cancelQueue = (queueId: string): QueueLandingState | null => {
    const row = getRow(queueId);
    if (!row) return null;
    const state = rowToState(row);
    if (state.state === "completed" || state.state === "cancelled") return state;
    for (const entry of state.entries) {
      if (isValidTransition(entry.state, "skipped")) {
        entry.state = "skipped";
        entry.waitingOn = "canceled";
        entry.updatedAt = nowIso();
      } else if (entry.state !== "landed" && entry.state !== "skipped") {
        // Force-cancel entries in states that don't normally allow skip (e.g. landing, resolving)
        logger.warn("queue_landing.force_cancel_entry", { queueId, prId: entry.prId, fromState: entry.state });
        entry.state = "failed";
        entry.error = "Queue cancelled while entry was in progress.";
        entry.waitingOn = "canceled";
        entry.updatedAt = nowIso();
      }
    }
    state.state = "cancelled";
    state.lastError = "Queue automation cancelled by operator.";
    state.waitReason = "canceled";
    state.activePrId = null;
    state.activeResolverRunId = null;
    state.completedAt = nowIso();
    persistAndEmitState(state);
    logger.info("queue_landing.cancelled", { queueId, groupId: state.groupId });
    return state;
  };

  const skipEntry = (queueId: string, prId: string): QueueLandingState | null => {
    const row = getRow(queueId);
    if (!row) return null;
    const state = rowToState(row);
    const entry = state.entries.find((candidate) => candidate.prId === prId);
    if (!entry || entry.state === "landed") return state;
    if (!guardTransition(entry, "skipped", { queueId })) return state;
    entry.state = "skipped";
    entry.waitingOn = null;
    entry.error = undefined;
    entry.updatedAt = nowIso();
    while (
      state.currentPosition < state.entries.length
      && (state.entries[state.currentPosition]!.state === "skipped" || state.entries[state.currentPosition]!.state === "landed")
    ) {
      state.currentPosition += 1;
    }
    if (state.entries.every((candidate) => candidate.state === "landed" || candidate.state === "skipped")) {
      state.state = "completed";
      state.completedAt = nowIso();
      state.activePrId = null;
      state.activeResolverRunId = null;
    }
    persistAndEmitState(state);
    emitQueueStep(state.groupId, prId, "skipped", entry.position);
    logger.info("queue_landing.entry_skipped", { queueId, prId, groupId: state.groupId });
    return state;
  };

  const getQueueState = (queueId: string): QueueLandingState | null => {
    const row = getRow(queueId);
    return row ? rowToState(row) : null;
  };

  const getQueueStateByGroup = (groupId: string): QueueLandingState | null => {
    const row = getRowByGroup(groupId, true);
    return row ? rowToState(row) : null;
  };

  const listQueueStates = (args: { includeCompleted?: boolean; limit?: number } = {}): QueueLandingState[] =>
    listRows(args.includeCompleted ?? true, args.limit ?? 50).map(rowToState);

  const init = (): void => {
    const interrupted = db.all<QueueLandingRow>(
      `select ${Q_COLS}
       from queue_landing_state qls
       left join pr_groups pg on pg.id = qls.group_id
       where qls.project_id = ? and qls.state = 'landing'`,
      [projectId],
    );
    for (const row of interrupted) {
      const state = rowToState(row);
      state.state = "paused";
      state.lastError = "Queue automation was interrupted by app shutdown and is ready to resume.";
      state.waitReason = "manual";
      const currentEntry = state.entries[state.currentPosition];
      if (currentEntry && (currentEntry.state === "landing" || currentEntry.state === "resolving")) {
        currentEntry.state = "paused";
        currentEntry.updatedAt = nowIso();
      }
      persistAndEmitState(state);
      logger.warn("queue_landing.interrupted_recovery", {
        queueId: state.queueId,
        groupId: state.groupId,
        position: state.currentPosition,
      });
    }
    if (interrupted.length > 0) {
      logger.info("queue_landing.init_recovered", { count: interrupted.length });
    }
  };

  return {
    startQueue,
    pauseQueue,
    resumeQueue,
    cancelQueue,
    skipEntry,
    getQueueState,
    getQueueStateByGroup,
    listQueueStates,
    init,
  };
}
