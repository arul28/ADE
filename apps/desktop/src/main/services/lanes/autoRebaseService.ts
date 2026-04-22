import { getHeadSha } from "../git/git";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createConflictService } from "../conflicts/conflictService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createLaneService } from "./laneService";
import type { AutoRebaseEventPayload, AutoRebaseLaneState, AutoRebaseLaneStatus, LaneSummary, RebaseNeed } from "../../../shared/types";
import { isRecord, nowIso } from "../shared/utils";
import { shouldLaneTrackParent } from "../../../shared/laneBaseResolution";
import { normalizePrCreationStrategy, resolvePrRebaseMode } from "../../../shared/prStrategy";

type StoredStatus = AutoRebaseLaneStatus & {
  source?: "auto" | "manual";
};
type StoredDismissal = {
  laneId: string;
  parentHeadSha: string | null;
  dismissedAt: string;
};
type ListStatusesOptions = {
  includeAll?: boolean;
};
type AttentionStatusInput = {
  laneId: string;
  parentLaneId: string | null;
  parentHeadSha: string | null;
  state: AutoRebaseLaneState;
  conflictCount: number;
  message?: string | null;
  source?: "auto" | "manual";
};

export type AutoRebaseService = {
  listStatuses: (options?: ListStatusesOptions) => Promise<AutoRebaseLaneStatus[]>;
  onHeadChanged: (args: {
    laneId: string;
    preHeadSha: string | null;
    postHeadSha: string | null;
    reason: string;
  }) => Promise<void>;
  emit: (options?: ListStatusesOptions) => Promise<void>;
  refreshActiveRebaseNeeds: (reason?: string) => Promise<void>;
  recordAttentionStatus: (status: AttentionStatusInput) => Promise<void>;
  dismissStatus: (args: { laneId: string }) => Promise<void>;
  dispose: () => void;
};

const KEY_PREFIX = "auto_rebase:status:";
const DISMISSAL_KEY_PREFIX = "auto_rebase:dismissed:";
const AUTO_REBASED_TTL_MS = 15 * 60_000;
const RUN_DEBOUNCE_MS = 1_200;
const SWEEP_DEBOUNCE_MS = 30_000;

function keyForLane(laneId: string): string {
  return `${KEY_PREFIX}${laneId}`;
}

function dismissalKeyForLane(laneId: string): string {
  return `${DISMISSAL_KEY_PREFIX}${laneId}`;
}

function sanitizeStoredStatus(value: unknown): StoredStatus | null {
  if (!isRecord(value)) return null;
  const laneId = typeof value.laneId === "string" ? value.laneId.trim() : "";
  const stateRaw = typeof value.state === "string" ? value.state.trim() : "";
  const state: AutoRebaseLaneState | null =
    stateRaw === "autoRebased" || stateRaw === "rebasePending" || stateRaw === "rebaseConflict" || stateRaw === "rebaseFailed"
      ? stateRaw
      : null;
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : "";
  if (!laneId || !state || !updatedAt) return null;

  const parentLaneIdRaw = typeof value.parentLaneId === "string" ? value.parentLaneId.trim() : "";
  const parentHeadShaRaw = typeof value.parentHeadSha === "string" ? value.parentHeadSha.trim() : "";
  const conflictCountRaw = typeof value.conflictCount === "number" ? value.conflictCount : Number(value.conflictCount ?? 0);
  const conflictCount = Number.isFinite(conflictCountRaw) ? Math.max(0, Math.floor(conflictCountRaw)) : 0;
  const messageRaw = typeof value.message === "string" ? value.message : null;

  return {
    laneId,
    parentLaneId: parentLaneIdRaw || null,
    parentHeadSha: parentHeadShaRaw || null,
    state,
    updatedAt,
    conflictCount,
    message: messageRaw,
    source: value.source === "manual" ? "manual" : "auto"
  };
}

function sanitizeDismissal(value: unknown): StoredDismissal | null {
  if (!isRecord(value)) return null;
  const laneId = typeof value.laneId === "string" ? value.laneId.trim() : "";
  const parentHeadShaRaw = typeof value.parentHeadSha === "string" ? value.parentHeadSha.trim() : "";
  const dismissedAt = typeof value.dismissedAt === "string" ? value.dismissedAt : "";
  if (!laneId || !dismissedAt) return null;
  return {
    laneId,
    parentHeadSha: parentHeadShaRaw || null,
    dismissedAt,
  };
}

function byCreatedAtAsc(a: LaneSummary, b: LaneSummary): number {
  const aTs = Date.parse(a.createdAt);
  const bTs = Date.parse(b.createdAt);
  if (Number.isFinite(aTs) && Number.isFinite(bTs) && aTs !== bTs) return aTs - bTs;
  return a.name.localeCompare(b.name);
}

function blockedMessage(
  laneId: string | null,
  reason: "conflict" | "manual" | "lookup" | "failed" | "unavailable" | null,
): string {
  if (!laneId) return "Pending: auto-rebase stopped at an earlier lane. Open the Rebase tab to continue.";
  if (reason === "manual") {
    return `Pending: ancestor lane '${laneId}' has a fixed PR base. Rebase that lane manually from the Rebase tab before descendants can continue.`;
  }
  if (reason === "lookup" || reason === "unavailable") {
    return `Pending: ancestor lane '${laneId}' needs review before descendants can continue. Open the Rebase tab to inspect it.`;
  }
  if (reason === "failed") {
    return `Pending: ancestor lane '${laneId}' failed automatic rebase. Open the Rebase tab to retry.`;
  }
  return `Pending: ancestor lane '${laneId}' has unresolved rebase conflicts. Open the Rebase tab to continue.`;
}

function resolveAffectedChainLaneId(
  laneId: string,
  laneById: Map<string, LaneSummary>,
  affectedLaneIds: Set<string>,
): string {
  let current = laneId;
  const visited = new Set<string>();
  while (!visited.has(current)) {
    visited.add(current);
    const lane = laneById.get(current);
    const parent = lane?.parentLaneId ? laneById.get(lane.parentLaneId) ?? null : null;
    if (!lane || !parent || !shouldLaneTrackParent({ lane, parent }) || !affectedLaneIds.has(parent.id)) {
      return current;
    }
    current = parent.id;
  }
  return laneId;
}

export function createAutoRebaseService(args: {
  db: AdeDb;
  logger: Logger;
  laneService: ReturnType<typeof createLaneService>;
  conflictService: ReturnType<typeof createConflictService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  onEvent?: (event: AutoRebaseEventPayload) => void;
}): AutoRebaseService {
  const {
    db,
    logger,
    laneService,
    conflictService,
    projectConfigService,
    onEvent
  } = args;

  type RootQueue = {
    running: boolean;
    pending: boolean;
    timer: NodeJS.Timeout | null;
    reason: string;
  };
  const queueByRoot = new Map<string, RootQueue>();
  let disposed = false;
  let sweepPromise: Promise<void> | null = null;
  let lastSweepAtMs = 0;

  const isEnabled = (): boolean => {
    try {
      return projectConfigService.getEffective().git.autoRebaseOnHeadChange;
    } catch {
      return false;
    }
  };

  const loadStatus = (laneId: string): StoredStatus | null => sanitizeStoredStatus(db.getJson(keyForLane(laneId)));
  const loadDismissal = (laneId: string): StoredDismissal | null => sanitizeDismissal(db.getJson(dismissalKeyForLane(laneId)));

  const saveStatus = (status: StoredStatus): void => {
    db.setJson(keyForLane(status.laneId), status);
  };

  const saveDismissal = (dismissal: StoredDismissal): void => {
    db.setJson(dismissalKeyForLane(dismissal.laneId), dismissal);
  };

  const clearStatus = (laneId: string): void => {
    db.setJson(keyForLane(laneId), null);
  };

  const setStatus = (status: AttentionStatusInput): void => {
    saveStatus({
      laneId: status.laneId,
      parentLaneId: status.parentLaneId,
      parentHeadSha: status.parentHeadSha,
      state: status.state,
      updatedAt: nowIso(),
      conflictCount: Math.max(0, Math.floor(status.conflictCount)),
      message: status.message ?? null,
      source: status.source ?? "auto"
    });
  };

  const safeGetHeadSha = async (worktreePath: string): Promise<string | null> => {
    try {
      return await getHeadSha(worktreePath);
    } catch (error) {
      logger.warn("autoRebase.parent_head_sha_failed", {
        worktreePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  const resolveTrackedParent = (
    lane: LaneSummary,
    laneById: Map<string, LaneSummary>,
  ): LaneSummary | null => {
    const parent = lane.parentLaneId ? laneById.get(lane.parentLaneId) ?? null : null;
    return shouldLaneTrackParent({ lane, parent }) ? parent : null;
  };

  /**
   * Look up the open PR linked to a lane and classify its rebase mode based
   * on the stored `creation_strategy`. "manual" means "do not auto-rebase,
   * surface drift as attention only" — see `resolvePrRebaseMode`.
   *
   * Returns `"auto"` when no open PR is linked (the auto-rebase behavior for
   * lanes without PRs is unchanged).
   */
  const resolveLaneRebaseMode = (laneId: string): "auto" | "manual" => {
    try {
      const row = db.get<{ creation_strategy: string | null }>(
        `
          select creation_strategy
          from pull_requests
          where lane_id = ?
            and state in ('open', 'draft')
          order by updated_at desc, created_at desc
          limit 1
        `,
        [laneId],
      );
      return resolvePrRebaseMode(normalizePrCreationStrategy(row?.creation_strategy));
    } catch (error) {
      logger.warn("autoRebase.lane_rebase_mode_lookup_failed", {
        laneId,
        error: error instanceof Error ? error.message : String(error),
      });
      return "auto";
    }
  };

  const listStatuses = async (options?: ListStatusesOptions): Promise<AutoRebaseLaneStatus[]> => {
    void maybeSweepRoots("listStatuses");
    const lanes = await laneService.list({ includeArchived: false });
    if (disposed) return [];
    const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));
    const nowMs = Date.now();

    const out: AutoRebaseLaneStatus[] = [];
    for (const lane of lanes) {
      const status = loadStatus(lane.id);
      if (!status) continue;
      if (status.state === "autoRebased") {
        const updatedAtMs = Date.parse(status.updatedAt);
        if (!Number.isFinite(updatedAtMs)) {
          clearStatus(lane.id);
          continue;
        }
        if (nowMs - updatedAtMs > AUTO_REBASED_TTL_MS) {
          clearStatus(lane.id);
          continue;
        }
      } else if (!options?.includeAll && lane.status.behind <= 0 && status.source !== "manual") {
        clearStatus(lane.id);
        continue;
      } else if (status.parentLaneId && !laneById.has(status.parentLaneId)) {
        clearStatus(lane.id);
        continue;
      }

      const dismissal = loadDismissal(lane.id);
      if (dismissal?.parentHeadSha === status.parentHeadSha) {
        continue;
      }

      out.push(status);
    }

    out.sort((a, b) => {
      const aTs = Date.parse(a.updatedAt);
      const bTs = Date.parse(b.updatedAt);
      if (Number.isFinite(aTs) && Number.isFinite(bTs) && aTs !== bTs) return bTs - aTs;
      return a.laneId.localeCompare(b.laneId);
    });
    return out;
  };

  const emit = async (options?: ListStatusesOptions): Promise<void> => {
    if (disposed || !onEvent) return;
    try {
      const statuses = await listStatuses(options);
      onEvent({
        type: "auto-rebase-updated",
        computedAt: nowIso(),
        statuses
      });
    } catch (error) {
      logger.warn("autoRebase.emit_failed", { error: String(error) });
    }
  };

  const queueRootsFromNeeds = async (needs: RebaseNeed[], reason: string): Promise<void> => {
    if (needs.length === 0) return;
    const lanes = await laneService.list({ includeArchived: false });
    if (disposed) return;
    const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));
    const affectedLaneIds = new Set(needs.map((need) => need.laneId));
    const rootLaneIds = new Set<string>();

    for (const need of needs) {
      const lane = laneById.get(need.laneId);
      if (!lane) continue;
      rootLaneIds.add(lane.parentLaneId
        ? resolveAffectedChainLaneId(lane.id, laneById, affectedLaneIds)
        : lane.id);
    }

    for (const rootLaneId of rootLaneIds) {
      queueRoot({ rootLaneId, reason: `sweep:${reason}` });
    }
  };

  const maybeSweepRoots = async (reason: string, options?: { force?: boolean }): Promise<void> => {
    if (disposed || !isEnabled()) return;
    if (options?.force && sweepPromise) {
      await sweepPromise.catch(() => {});
      if (disposed) return;
    }
    if (sweepPromise) return;
    const now = Date.now();
    if (!options?.force && now - lastSweepAtMs < SWEEP_DEBOUNCE_MS) return;

    let currentSweep: Promise<void>;
    currentSweep = (async () => {
      lastSweepAtMs = now;
      try {
        const needs = await conflictService.scanRebaseNeeds();
        if (disposed) return;
        await queueRootsFromNeeds(needs, reason);
        if (disposed) return;
      } catch (error) {
        logger.warn("autoRebase.sweep_failed", { reason, error: String(error) });
      }
    })().finally(() => {
      if (sweepPromise === currentSweep) {
        sweepPromise = null;
      }
    });
    sweepPromise = currentSweep;
    await currentSweep;
    if (disposed) return;
  };

  const refreshActiveRebaseNeeds = async (reason = "external_refresh"): Promise<void> => {
    await maybeSweepRoots(reason, { force: true });
    if (disposed) return;
    await emit();
  };

  const recordAttentionStatus = async (status: AttentionStatusInput): Promise<void> => {
    setStatus(status);
    if (disposed) return;
    await emit({ includeAll: true });
  };

  const dismissStatus = async (args: { laneId: string }): Promise<void> => {
    const laneId = args.laneId.trim();
    if (!laneId) throw new Error("laneId is required");
    const status = loadStatus(laneId);
    if (!status) return;
    saveDismissal({
      laneId,
      parentHeadSha: status.parentHeadSha,
      dismissedAt: nowIso(),
    });
    if (disposed) return;
    void emit({ includeAll: true });
  };

  const collectDescendantsDepthFirst = (rootLaneId: string, lanes: LaneSummary[]): string[] => {
    const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));
    const childrenByParent = new Map<string, LaneSummary[]>();
    for (const lane of lanes) {
      const parent = resolveTrackedParent(lane, laneById);
      if (!parent) continue;
      const children = childrenByParent.get(parent.id) ?? [];
      children.push(lane);
      childrenByParent.set(parent.id, children);
    }
    for (const [parent, children] of childrenByParent.entries()) {
      childrenByParent.set(parent, [...children].sort(byCreatedAtAsc));
    }

    const out: string[] = [];
    const visit = (parentId: string) => {
      for (const child of childrenByParent.get(parentId) ?? []) {
        out.push(child.id);
        visit(child.id);
      }
    };
    visit(rootLaneId);
    return out;
  };

  const processRoot = async (rootLaneId: string, reason: string): Promise<void> => {
    if (disposed || !isEnabled()) return;

    let lanes = await laneService.list({ includeArchived: false });
    if (disposed) return;
    const rootLane = lanes.find((lane) => lane.id === rootLaneId) ?? null;
    if (!rootLane) return;
    const cascadeOrder = [rootLaneId, ...collectDescendantsDepthFirst(rootLaneId, lanes)];
    if (cascadeOrder.length === 0) return;

    let blocked = false;
    let blockedLaneId: string | null = null;
    let blockedReason: "conflict" | "manual" | "lookup" | "failed" | "unavailable" | null = null;
    let blockedByLookupFailure = false;
    for (const laneId of cascadeOrder) {
      lanes = await laneService.list({ includeArchived: false });
      if (disposed) return;
      const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));
      const lane = laneById.get(laneId);
      if (!lane) {
        logger.info("autoRebase.lane_not_found", { laneId });
        continue;
      }

      let parentHeadSha: string | null = null;
      let targetLabel = lane.name;
      let baseBranchOverride: string | undefined;
      let parent: LaneSummary | null = null;
      if (lane.parentLaneId) {
        const rawParent = laneById.get(lane.parentLaneId) ?? null;
        if (!rawParent) {
          setStatus({
            laneId: lane.id,
            parentLaneId: lane.parentLaneId,
            parentHeadSha: null,
            state: "rebasePending",
            conflictCount: 0,
            message: "Pending: parent lane is unavailable. Open the Rebase tab to review the lane."
          });
          blocked = true;
          blockedLaneId = lane.id;
          blockedReason = "unavailable";
          continue;
        }
        if (shouldLaneTrackParent({ lane, parent: rawParent })) {
          parent = rawParent;
          parentHeadSha = await safeGetHeadSha(parent.worktreePath);
          if (disposed) return;
          targetLabel = parent.name;
        }
      }

      if (blocked) {
        if (blockedByLookupFailure) {
          continue;
        }
        setStatus({
          laneId: lane.id,
          parentLaneId: parent?.id ?? null,
          parentHeadSha: null,
          state: "rebasePending",
          conflictCount: 0,
          message: blockedMessage(blockedLaneId, blockedReason)
        });
        continue;
      }

      let lookupFailed = false;
      const need = await conflictService.getRebaseNeed(lane.id).catch((error) => {
        lookupFailed = true;
        logger.warn("autoRebase.need_lookup_failed", { laneId: lane.id, error: String(error) });
        return null;
      });
      if (disposed) return;

      if (!need) {
        if (lookupFailed) {
          blocked = true;
          blockedByLookupFailure = true;
          blockedLaneId = lane.id;
          blockedReason = "lookup";
          continue;
        }
        const existing = loadStatus(lane.id);
        if (existing?.source !== "manual" && existing?.state !== "autoRebased") {
          clearStatus(lane.id);
        }
        continue;
      }

      if (need.conflictPredicted) {
        blocked = true;
        blockedLaneId = lane.id;
        blockedReason = "conflict";
        setStatus({
          laneId: lane.id,
          parentLaneId: parent?.id ?? null,
          parentHeadSha,
          state: "rebaseConflict",
          conflictCount: Math.max(1, need.conflictingFiles.length),
          message: `Auto-rebase blocked: ${Math.max(1, need.conflictingFiles.length)} conflict(s) expected. Open the Rebase tab to resolve and publish.`
        });
        continue;
      }

      // Gate on creation_strategy: PRs with `lane_base` strategy carry an
      // immutable base — drift surfaces as attention only, auto-rebase is
      // never allowed to fire. The user must rebase manually.
      const rebaseMode = resolveLaneRebaseMode(lane.id);
      if (rebaseMode === "manual") {
        blocked = true;
        blockedLaneId = lane.id;
        blockedReason = "manual";
        setStatus({
          laneId: lane.id,
          parentLaneId: parent?.id ?? null,
          parentHeadSha,
          state: "rebasePending",
          conflictCount: 0,
          message: "PR carries an immutable base — drift detected. Rebase manually from the Rebase tab when ready."
        });
        continue;
      }

      if (!parent) {
        baseBranchOverride = need.baseBranch;
        targetLabel = need.baseBranch || lane.baseRef || lane.branchRef || lane.name;
      }

      const rebaseRun = await laneService.rebaseStart({
        laneId: lane.id,
        scope: "lane_only",
        pushMode: "none",
        actor: "system",
        reason: "auto_rebase",
        ...(baseBranchOverride ? { baseBranchOverride } : {})
      });
      if (disposed) return;
      if (rebaseRun.run.error) {
        blocked = true;
        blockedLaneId = lane.id;
        const conflictHint = /conflict|could not apply|resolve/i.test(rebaseRun.run.error);
        blockedReason = conflictHint ? "conflict" : "failed";
        setStatus({
          laneId: lane.id,
          parentLaneId: parent?.id ?? null,
          parentHeadSha,
          state: conflictHint ? "rebaseConflict" : "rebaseFailed",
          conflictCount: conflictHint ? 1 : 0,
          message: conflictHint
            ? "Auto-rebase stopped due to conflicts. Open the Rebase tab to resolve, then publish."
            : `Auto-rebase failed: ${rebaseRun.run.error}. Open the Rebase tab to retry.`
        });
        continue;
      }

      let pushSucceeded = false;
      try {
        const pushedRun = await laneService.rebasePush({ runId: rebaseRun.runId, laneIds: [lane.id] });
        if (disposed) return;
        const pushedLaneIds = pushedRun.pushedLaneIds ?? [];
        const pushedLane = pushedRun.lanes.find((entry) => entry.laneId === lane.id);
        if (!pushedLaneIds.includes(lane.id) || pushedLane?.pushed !== true) {
          throw new Error("Auto-push did not complete for the rebased lane.");
        }
        pushSucceeded = true;

        setStatus({
          laneId: lane.id,
          parentLaneId: parent?.id ?? null,
          parentHeadSha,
          state: "autoRebased",
          conflictCount: 0,
          message: parent
            ? `Rebased and pushed automatically after '${targetLabel}' advanced.`
            : `Rebased and pushed automatically onto '${targetLabel}'.`
        });
      } catch (error) {
        let rollbackError: string | null = null;
        if (!pushSucceeded) {
          try {
            await laneService.rebaseRollback({ runId: rebaseRun.runId });
            if (disposed) return;
          } catch (rollbackFailure) {
            rollbackError = rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure);
            logger.warn("autoRebase.rollback_failed", {
              laneId: lane.id,
              error: rollbackError
            });
          }
        }

        blocked = true;
        blockedLaneId = lane.id;
        blockedReason = "failed";
        const pushError = error instanceof Error ? error.message : String(error);
        setStatus({
          laneId: lane.id,
          parentLaneId: parent?.id ?? null,
          parentHeadSha,
          state: "rebaseFailed",
          conflictCount: 0,
          message: rollbackError
            ? `Auto-push failed: ${pushError}. Automatic rollback also failed: ${rollbackError}. Open the Rebase tab to retry.`
            : `Auto-push failed: ${pushError}. The lane was restored to its pre-rebase state. Open the Rebase tab to retry.`
        });
      }
    }

    logger.info("autoRebase.run_complete", { rootLaneId, reason, cascaded: cascadeOrder.length, blocked, blockedLaneId });
  };

  const runRootQueue = async (rootLaneId: string): Promise<void> => {
    if (disposed) return;
    const state = queueByRoot.get(rootLaneId);
    if (!state || state.running) return;
    state.running = true;
    try {
      while (state.pending) {
        state.pending = false;
        await processRoot(rootLaneId, state.reason);
        if (disposed) return;
        await emit({ includeAll: true });
        if (disposed) return;
      }
    } catch (error) {
      logger.warn("autoRebase.run_failed", { rootLaneId, error: String(error) });
      if (disposed) return;
      await emit({ includeAll: true });
    } finally {
      state.running = false;
      if (state.pending && !disposed) {
        void runRootQueue(rootLaneId);
      }
    }
  };

  const queueRoot = (args: { rootLaneId: string; reason: string }): void => {
    if (disposed) return;
    const rootLaneId = args.rootLaneId.trim();
    if (!rootLaneId) return;

    const existing = queueByRoot.get(rootLaneId) ?? { running: false, pending: false, timer: null, reason: args.reason };
    existing.reason = args.reason;
    existing.pending = true;
    if (existing.timer) {
      clearTimeout(existing.timer);
    }
    existing.timer = setTimeout(() => {
      existing.timer = null;
      if (disposed) return;
      void runRootQueue(rootLaneId);
    }, RUN_DEBOUNCE_MS);
    queueByRoot.set(rootLaneId, existing);
  };

  const onHeadChanged = async (args: {
    laneId: string;
    preHeadSha: string | null;
    postHeadSha: string | null;
    reason: string;
  }): Promise<void> => {
    if (disposed) return;
    const laneId = args.laneId.trim();
    if (!laneId) return;
    if (args.reason.startsWith("auto_rebase") || args.reason === "rebase_abort" || args.reason === "rebase_rollback") return;
    if (!isEnabled()) return;
    queueRoot({ rootLaneId: laneId, reason: args.reason });
  };

  const dispose = (): void => {
    disposed = true;
    for (const state of queueByRoot.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
      }
      state.timer = null;
      state.pending = false;
    }
    queueByRoot.clear();
  };

  return {
    listStatuses,
    onHeadChanged,
    emit,
    refreshActiveRebaseNeeds,
    recordAttentionStatus,
    dismissStatus,
    dispose
  };
}
