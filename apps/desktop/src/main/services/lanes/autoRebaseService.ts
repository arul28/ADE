import { getHeadSha } from "../git/git";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createConflictService } from "../conflicts/conflictService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createLaneService } from "./laneService";
import type { AutoRebaseEventPayload, AutoRebaseLaneState, AutoRebaseLaneStatus, LaneSummary, RebaseNeed } from "../../../shared/types";
import { isRecord, nowIso } from "../shared/utils";

type StoredStatus = AutoRebaseLaneStatus;
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
  dispose: () => void;
};

const KEY_PREFIX = "auto_rebase:status:";
const AUTO_REBASED_TTL_MS = 15 * 60_000;
const RUN_DEBOUNCE_MS = 1_200;
const SWEEP_DEBOUNCE_MS = 30_000;

function keyForLane(laneId: string): string {
  return `${KEY_PREFIX}${laneId}`;
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
    message: messageRaw
  };
}

function byCreatedAtAsc(a: LaneSummary, b: LaneSummary): number {
  const aTs = Date.parse(a.createdAt);
  const bTs = Date.parse(b.createdAt);
  if (Number.isFinite(aTs) && Number.isFinite(bTs) && aTs !== bTs) return aTs - bTs;
  return a.name.localeCompare(b.name);
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
    if (!lane?.parentLaneId || !affectedLaneIds.has(lane.parentLaneId)) {
      return current;
    }
    current = lane.parentLaneId;
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

  const saveStatus = (status: StoredStatus): void => {
    db.setJson(keyForLane(status.laneId), status);
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
      message: status.message ?? null
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

  const listStatuses = async (options?: ListStatusesOptions): Promise<AutoRebaseLaneStatus[]> => {
    void maybeSweepRoots("listStatuses");
    const lanes = await laneService.list({ includeArchived: false });
    const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));
    const nowMs = Date.now();

    const out: AutoRebaseLaneStatus[] = [];
    for (const lane of lanes) {
      const status = loadStatus(lane.id);
      if (!status) continue;
      if (!lane.parentLaneId) {
        clearStatus(lane.id);
        continue;
      }

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
      } else if (!options?.includeAll && lane.status.behind <= 0) {
        clearStatus(lane.id);
        continue;
      } else if (status.parentLaneId && !laneById.has(status.parentLaneId)) {
        clearStatus(lane.id);
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
    const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));
    const affectedLaneIds = new Set(needs.map((need) => need.laneId));
    const rootLaneIds = new Set<string>();

    for (const need of needs) {
      const lane = laneById.get(need.laneId);
      if (!lane?.parentLaneId) continue;
      rootLaneIds.add(resolveAffectedChainLaneId(lane.id, laneById, affectedLaneIds));
    }

    for (const rootLaneId of rootLaneIds) {
      queueRoot({ rootLaneId, reason: `sweep:${reason}` });
    }
  };

  const maybeSweepRoots = async (reason: string, options?: { force?: boolean }): Promise<void> => {
    if (disposed || !isEnabled()) return;
    if (options?.force && sweepPromise) {
      await sweepPromise.catch(() => {});
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
  };

  const refreshActiveRebaseNeeds = async (reason = "external_refresh"): Promise<void> => {
    await maybeSweepRoots(reason, { force: true });
    await emit();
  };

  const recordAttentionStatus = async (status: AttentionStatusInput): Promise<void> => {
    setStatus(status);
    await emit({ includeAll: true });
  };

  const collectDescendantsDepthFirst = (rootLaneId: string, lanes: LaneSummary[]): string[] => {
    const childrenByParent = new Map<string, LaneSummary[]>();
    for (const lane of lanes) {
      if (!lane.parentLaneId) continue;
      const children = childrenByParent.get(lane.parentLaneId) ?? [];
      children.push(lane);
      childrenByParent.set(lane.parentLaneId, children);
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
    const rootLane = lanes.find((lane) => lane.id === rootLaneId) ?? null;
    if (!rootLane) return;
    const cascadeOrder = rootLane.parentLaneId
      ? [rootLaneId, ...collectDescendantsDepthFirst(rootLaneId, lanes)]
      : collectDescendantsDepthFirst(rootLaneId, lanes);
    if (cascadeOrder.length === 0) return;

    let blocked = false;
    let blockedLaneId: string | null = null;
    for (const laneId of cascadeOrder) {
      lanes = await laneService.list({ includeArchived: false });
      const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));
      const lane = laneById.get(laneId);
      if (!lane) {
        logger.info("autoRebase.lane_not_found", { laneId });
        continue;
      }
      if (!lane.parentLaneId) {
        logger.debug("autoRebase.no_parent", { laneId });
        continue;
      }

      if (blocked) {
        setStatus({
          laneId: lane.id,
          parentLaneId: lane.parentLaneId,
          parentHeadSha: null,
          state: "rebasePending",
          conflictCount: 0,
          message: blockedLaneId
            ? `Pending: ancestor lane '${blockedLaneId}' has unresolved rebase conflicts. Open the Rebase tab to continue.`
            : "Pending: auto-rebase stopped at an earlier lane. Open the Rebase tab to continue."
        });
        continue;
      }

      const parent = laneById.get(lane.parentLaneId);
      if (!parent) {
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
        continue;
      }

      const parentHeadSha = await safeGetHeadSha(parent.worktreePath);

      let lookupFailed = false;
      const need = await conflictService.getRebaseNeed(lane.id).catch((error) => {
        lookupFailed = true;
        logger.warn("autoRebase.need_lookup_failed", { laneId: lane.id, error: String(error) });
        return null;
      });

      if (!need) {
        if (lookupFailed) {
          continue;
        }
        const existing = loadStatus(lane.id);
        if (existing?.state !== "autoRebased") {
          clearStatus(lane.id);
        }
        continue;
      }

      if (need.conflictPredicted) {
        blocked = true;
        blockedLaneId = lane.id;
        setStatus({
          laneId: lane.id,
          parentLaneId: lane.parentLaneId,
          parentHeadSha,
          state: "rebaseConflict",
          conflictCount: Math.max(1, need.conflictingFiles.length),
          message: `Auto-rebase blocked: ${Math.max(1, need.conflictingFiles.length)} conflict(s) expected. Open the Rebase tab to resolve and publish.`
        });
        continue;
      }

      const rebaseRun = await laneService.rebaseStart({
        laneId: lane.id,
        scope: "lane_only",
        pushMode: "none",
        actor: "system",
        reason: "auto_rebase"
      });
      if (rebaseRun.run.error) {
        blocked = true;
        blockedLaneId = lane.id;
        const conflictHint = /conflict|could not apply|resolve/i.test(rebaseRun.run.error);
        setStatus({
          laneId: lane.id,
          parentLaneId: lane.parentLaneId,
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
        const pushedLaneIds = pushedRun.pushedLaneIds ?? [];
        const pushedLane = pushedRun.lanes.find((entry) => entry.laneId === lane.id);
        if (!pushedLaneIds.includes(lane.id) || pushedLane?.pushed !== true) {
          throw new Error("Auto-push did not complete for the rebased lane.");
        }
        pushSucceeded = true;

        setStatus({
          laneId: lane.id,
          parentLaneId: lane.parentLaneId,
          parentHeadSha,
          state: "autoRebased",
          conflictCount: 0,
          message: `Rebased and pushed automatically after '${parent.name}' advanced.`
        });
      } catch (error) {
        let rollbackError: string | null = null;
        if (!pushSucceeded) {
          try {
            await laneService.rebaseRollback({ runId: rebaseRun.runId });
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
        const pushError = error instanceof Error ? error.message : String(error);
        setStatus({
          laneId: lane.id,
          parentLaneId: lane.parentLaneId,
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
        await emit();
      }
    } catch (error) {
      logger.warn("autoRebase.run_failed", { rootLaneId, error: String(error) });
      await emit();
    } finally {
      state.running = false;
      if (state.pending) {
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
    dispose
  };
}
