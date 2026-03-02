import { runGit } from "../git/git";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createConflictService } from "../conflicts/conflictService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { createLaneService } from "./laneService";
import type { AutoRebaseEventPayload, AutoRebaseLaneState, AutoRebaseLaneStatus, LaneSummary } from "../../../shared/types";
import { isRecord, nowIso } from "../shared/utils";

type StoredStatus = AutoRebaseLaneStatus;

const KEY_PREFIX = "auto_rebase:status:";
const AUTO_REBASED_TTL_MS = 15 * 60_000;
const RUN_DEBOUNCE_MS = 1_200;

function keyForLane(laneId: string): string {
  return `${KEY_PREFIX}${laneId}`;
}

function sanitizeStoredStatus(value: unknown): StoredStatus | null {
  if (!isRecord(value)) return null;
  const laneId = typeof value.laneId === "string" ? value.laneId.trim() : "";
  const stateRaw = typeof value.state === "string" ? value.state.trim() : "";
  const state: AutoRebaseLaneState | null =
    stateRaw === "autoRebased" || stateRaw === "rebasePending" || stateRaw === "rebaseConflict" ? stateRaw : null;
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

async function readHeadSha(worktreePath: string): Promise<string | null> {
  const res = await runGit(["rev-parse", "HEAD"], { cwd: worktreePath, timeoutMs: 8_000 });
  if (res.exitCode !== 0) return null;
  const sha = res.stdout.trim();
  return sha.length ? sha : null;
}

export function createAutoRebaseService(args: {
  db: AdeDb;
  logger: Logger;
  laneService: ReturnType<typeof createLaneService>;
  conflictService: ReturnType<typeof createConflictService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  onEvent?: (event: AutoRebaseEventPayload) => void;
}) {
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

  const setStatus = (status: {
    laneId: string;
    parentLaneId: string | null;
    parentHeadSha: string | null;
    state: AutoRebaseLaneState;
    conflictCount: number;
    message?: string | null;
  }): void => {
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

  const listStatuses = async (): Promise<AutoRebaseLaneStatus[]> => {
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
        if (!Number.isFinite(updatedAtMs) || nowMs - updatedAtMs > AUTO_REBASED_TTL_MS) {
          clearStatus(lane.id);
          continue;
        }
      } else if (lane.status.behind <= 0) {
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

  const emit = async (): Promise<void> => {
    if (!onEvent) return;
    try {
      const statuses = await listStatuses();
      onEvent({
        type: "auto-rebase-updated",
        computedAt: nowIso(),
        statuses
      });
    } catch (error) {
      logger.warn("autoRebase.emit_failed", { error: String(error) });
    }
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
    if (!isEnabled()) return;

    let lanes = await laneService.list({ includeArchived: false });
    const rootLane = lanes.find((lane) => lane.id === rootLaneId) ?? null;
    if (!rootLane) return;
    const cascadeOrder = collectDescendantsDepthFirst(rootLaneId, lanes);
    if (cascadeOrder.length === 0) return;

    let blocked = false;
    let blockedLaneId: string | null = null;
    for (const laneId of cascadeOrder) {
      lanes = await laneService.list({ includeArchived: false });
      const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));
      const lane = laneById.get(laneId);
      if (!lane || !lane.parentLaneId) continue;

      if (blocked) {
        setStatus({
          laneId: lane.id,
          parentLaneId: lane.parentLaneId,
          parentHeadSha: null,
          state: "rebasePending",
          conflictCount: 0,
          message: blockedLaneId
            ? `Pending: ancestor lane '${blockedLaneId}' has unresolved rebase conflicts.`
            : "Pending: auto-rebase stopped at an earlier lane."
        });
        continue;
      }

      if (lane.status.behind <= 0) {
        const existing = loadStatus(lane.id);
        if (existing?.state !== "autoRebased") {
          clearStatus(lane.id);
        }
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
          message: "Pending: parent lane is unavailable."
        });
        blocked = true;
        blockedLaneId = lane.id;
        continue;
      }

      const simulation = await conflictService.simulateMerge({ laneAId: lane.id, laneBId: parent.id });
      if (simulation.outcome !== "clean") {
        blocked = true;
        blockedLaneId = lane.id;
        if (simulation.outcome === "conflict") {
          setStatus({
            laneId: lane.id,
            parentLaneId: lane.parentLaneId,
            parentHeadSha: await readHeadSha(parent.worktreePath),
            state: "rebaseConflict",
            conflictCount: Math.max(1, simulation.conflictingFiles.length),
            message: `Auto-rebase blocked: ${Math.max(1, simulation.conflictingFiles.length)} conflict(s) expected.`
          });
        } else {
          setStatus({
            laneId: lane.id,
            parentLaneId: lane.parentLaneId,
            parentHeadSha: await readHeadSha(parent.worktreePath),
            state: "rebasePending",
            conflictCount: 0,
            message: simulation.error?.trim() || "Auto-rebase could not run merge simulation."
          });
        }
        continue;
      }

      const restack = await laneService.restack({
        laneId: lane.id,
        recursive: false,
        reason: "auto_rebase"
      });
      if (restack.error) {
        blocked = true;
        blockedLaneId = lane.id;
        const conflictHint = /conflict|could not apply|resolve/i.test(restack.error);
        setStatus({
          laneId: lane.id,
          parentLaneId: lane.parentLaneId,
          parentHeadSha: await readHeadSha(parent.worktreePath),
          state: conflictHint ? "rebaseConflict" : "rebasePending",
          conflictCount: conflictHint ? 1 : 0,
          message: conflictHint
            ? "Auto-rebase stopped due to conflicts. Resolve manually, then publish."
            : `Auto-rebase failed: ${restack.error}`
        });
        continue;
      }

      setStatus({
        laneId: lane.id,
        parentLaneId: lane.parentLaneId,
        parentHeadSha: await readHeadSha(parent.worktreePath),
        state: "autoRebased",
        conflictCount: 0,
        message: `Rebased automatically after '${parent.name}' advanced.`
      });
    }

    logger.info("autoRebase.run_complete", { rootLaneId, reason, cascaded: cascadeOrder.length, blocked, blockedLaneId });
  };

  const runRootQueue = async (rootLaneId: string): Promise<void> => {
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
    const laneId = args.laneId.trim();
    if (!laneId) return;
    if (args.reason.startsWith("auto_rebase")) return;
    if (!isEnabled()) return;
    queueRoot({ rootLaneId: laneId, reason: args.reason });
  };

  return {
    listStatuses,
    onHeadChanged,
    emit
  };
}
