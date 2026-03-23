import { getHeadSha, runGit } from "../git/git";
import type { AdeDb } from "../state/kvDb";
import type { Logger } from "../logging/logger";
import type { createLaneService } from "./laneService";
import type { LaneSummary, RebaseSuggestion, RebaseSuggestionsEventPayload } from "../../../shared/types";
import { fetchQueueTargetTrackingBranches, resolveQueueRebaseOverride } from "../shared/queueRebase";
import { isRecord, nowIso } from "../shared/utils";

type StoredSuggestionState = {
  laneId: string;
  parentLaneId: string;
  parentHeadSha: string;
  behindCount: number;
  lastSuggestedAt: string;
  deferredUntil: string | null;
  dismissedAt: string | null;
};

const KEY_PREFIX = "rebase:suggestion:";

function keyForLane(laneId: string): string {
  return `${KEY_PREFIX}${laneId}`;
}

function sanitizeState(value: unknown): StoredSuggestionState | null {
  if (!isRecord(value)) return null;
  const laneId = typeof value.laneId === "string" ? value.laneId.trim() : "";
  const parentLaneId = typeof value.parentLaneId === "string" ? value.parentLaneId.trim() : "";
  const parentHeadSha = typeof value.parentHeadSha === "string" ? value.parentHeadSha.trim() : "";
  const behindCountRaw = typeof value.behindCount === "number" ? value.behindCount : Number(value.behindCount ?? 0);
  const behindCount = Number.isFinite(behindCountRaw) ? Math.max(0, Math.floor(behindCountRaw)) : 0;
  const lastSuggestedAt = typeof value.lastSuggestedAt === "string" ? value.lastSuggestedAt : "";
  const deferredUntil = typeof value.deferredUntil === "string" ? value.deferredUntil : null;
  const dismissedAt = typeof value.dismissedAt === "string" ? value.dismissedAt : null;

  if (!laneId || !parentLaneId || !parentHeadSha || !lastSuggestedAt) return null;
  return {
    laneId,
    parentLaneId,
    parentHeadSha,
    behindCount,
    lastSuggestedAt,
    deferredUntil,
    dismissedAt
  };
}

function isSuppressed(args: { nowMs: number; state: StoredSuggestionState; currentParentHeadSha: string }): boolean {
  if (args.state.parentHeadSha === args.currentParentHeadSha && args.state.dismissedAt) return true;
  if (args.state.deferredUntil) {
    const untilMs = Date.parse(args.state.deferredUntil);
    if (Number.isFinite(untilMs) && args.nowMs < untilMs) return true;
  }
  return false;
}

export function createRebaseSuggestionService(args: {
  db: AdeDb;
  logger: Logger;
  projectId: string;
  projectRoot: string;
  laneService: ReturnType<typeof createLaneService>;
  onEvent?: (event: RebaseSuggestionsEventPayload) => void;
}) {
  const { db, logger, projectId, projectRoot, laneService, onEvent } = args;

  const getPrLaneIds = (): Set<string> => {
    const rows = db.all<{ lane_id: string }>(
      `
        select lane_id
        from pull_requests
        where project_id = ?
      `,
      [projectId]
    );
    return new Set(rows.map((row) => String(row.lane_id ?? "").trim()).filter(Boolean));
  };

  const loadState = (laneId: string): StoredSuggestionState | null => sanitizeState(db.getJson(keyForLane(laneId)));

  const saveState = (state: StoredSuggestionState) => {
    db.setJson(keyForLane(state.laneId), state);
  };

  const readRefHeadSha = async (ref: string): Promise<string | null> => {
    const result = await runGit(["rev-parse", "--verify", ref], { cwd: projectRoot, timeoutMs: 10_000 });
    return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : null;
  };

  const readBehindCount = async (args: { laneWorktreePath: string; baseHeadSha: string }): Promise<number> => {
    const laneHeadSha = await getHeadSha(args.laneWorktreePath);
    if (!laneHeadSha) return 0;
    const result = await runGit(
      ["rev-list", "--count", `${laneHeadSha}..${args.baseHeadSha}`],
      { cwd: projectRoot, timeoutMs: 10_000 }
    );
    return result.exitCode === 0 ? Math.max(0, Number(result.stdout.trim()) || 0) : 0;
  };

  const resolveSuggestionBase = async (
    lane: LaneSummary,
    laneById: Map<string, LaneSummary>,
  ): Promise<{ parentLaneId: string; parentHeadSha: string; baseLabel: string | null; groupContext: string | null } | null> => {
    const queueOverride = await resolveQueueRebaseOverride({
      db,
      projectId,
      projectRoot,
      laneId: lane.id,
    });
    if (queueOverride) {
      const parentHeadSha = await readRefHeadSha(queueOverride.comparisonRef);
      if (!parentHeadSha) return null;
      return {
        parentLaneId: `queue:${queueOverride.queueGroupId}`,
        parentHeadSha,
        baseLabel: queueOverride.baseLabel,
        groupContext: queueOverride.groupContext,
      };
    }

    if (!lane.parentLaneId) return null;
    const parent = laneById.get(lane.parentLaneId);
    if (!parent) return null;
    const parentHeadSha = await getHeadSha(parent.worktreePath);
    if (!parentHeadSha) return null;
    return {
      parentLaneId: lane.parentLaneId,
      parentHeadSha,
      baseLabel: parent.name ?? null,
      groupContext: null,
    };
  };

  const listSuggestions = async (): Promise<RebaseSuggestion[]> => {
    await fetchQueueTargetTrackingBranches({
      db,
      projectId,
      projectRoot,
    });

    const lanes = await laneService.list({ includeArchived: false });
    const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));
    const prLaneIds = getPrLaneIds();

    const out: RebaseSuggestion[] = [];
    const nowMs = Date.now();

    for (const lane of lanes) {
      const base = await resolveSuggestionBase(lane, laneById);
      if (!base) continue;
      const behindCount = await readBehindCount({
        laneWorktreePath: lane.worktreePath,
        baseHeadSha: base.parentHeadSha,
      });
      if (behindCount <= 0) continue;

      const existing = loadState(lane.id);

      const nextState: StoredSuggestionState = existing && existing.parentLaneId === base.parentLaneId
        ? (() => {
            if (existing.parentHeadSha !== base.parentHeadSha) {
              return {
                laneId: lane.id,
                parentLaneId: base.parentLaneId,
                parentHeadSha: base.parentHeadSha,
                behindCount,
                lastSuggestedAt: nowIso(),
                deferredUntil: existing.deferredUntil ?? null,
                dismissedAt: null
              };
            }
            // Keep timestamps stable; update behindCount for display.
            return { ...existing, behindCount };
          })()
        : {
            laneId: lane.id,
            parentLaneId: base.parentLaneId,
            parentHeadSha: base.parentHeadSha,
            behindCount,
            lastSuggestedAt: nowIso(),
            deferredUntil: existing?.deferredUntil ?? null,
            dismissedAt: null
          };

      if (!existing || JSON.stringify(existing) !== JSON.stringify(nextState)) {
        saveState(nextState);
      }

      if (isSuppressed({ nowMs, state: nextState, currentParentHeadSha: base.parentHeadSha })) continue;

      out.push({
        laneId: lane.id,
        parentLaneId: base.parentLaneId,
        parentHeadSha: base.parentHeadSha,
        behindCount,
        baseLabel: base.baseLabel,
        groupContext: base.groupContext,
        lastSuggestedAt: nextState.lastSuggestedAt,
        deferredUntil: nextState.deferredUntil,
        dismissedAt: nextState.dismissedAt,
        hasPr: prLaneIds.has(lane.id)
      });
    }

    return out.sort((a, b) => {
      const behindDelta = b.behindCount - a.behindCount;
      if (behindDelta !== 0) return behindDelta;
      return a.laneId.localeCompare(b.laneId);
    });
  };

  const emit = async () => {
    if (!onEvent) return;
    try {
      const suggestions = await listSuggestions();
      onEvent({
        type: "rebase-suggestions-updated",
        computedAt: nowIso(),
        suggestions
      });
    } catch (err) {
      logger.warn("rebaseSuggestions.emit_failed", { err: String(err) });
    }
  };

  const dismiss = async (args: { laneId: string }): Promise<void> => {
    const laneId = args.laneId.trim();
    if (!laneId) throw new Error("laneId is required");

    const lanes = await laneService.list({ includeArchived: false });
    const lane = lanes.find((l) => l.id === laneId);
    if (!lane) throw new Error(`Lane not found: ${laneId}`);
    const laneById = new Map(lanes.map((entry) => [entry.id, entry] as const));
    const base = await resolveSuggestionBase(lane, laneById);
    if (!base) throw new Error("Lane has no rebase suggestion to dismiss.");

    const existing = loadState(laneId);
    const behindCount = await readBehindCount({
      laneWorktreePath: lane.worktreePath,
      baseHeadSha: base.parentHeadSha,
    });
    const next: StoredSuggestionState = {
      laneId,
      parentLaneId: base.parentLaneId,
      parentHeadSha: base.parentHeadSha,
      behindCount,
      lastSuggestedAt: existing?.lastSuggestedAt ?? nowIso(),
      deferredUntil: existing?.deferredUntil ?? null,
      dismissedAt: nowIso()
    };
    saveState(next);
    await emit();
  };

  const defer = async (args: { laneId: string; minutes: number }): Promise<void> => {
    const laneId = args.laneId.trim();
    if (!laneId) throw new Error("laneId is required");

    const minutes = Math.max(5, Math.min(7 * 24 * 60, Math.floor(args.minutes)));
    const until = new Date(Date.now() + minutes * 60_000).toISOString();

    const lanes = await laneService.list({ includeArchived: false });
    const lane = lanes.find((l) => l.id === laneId);
    if (!lane) throw new Error(`Lane not found: ${laneId}`);
    const laneById = new Map(lanes.map((entry) => [entry.id, entry] as const));
    const base = await resolveSuggestionBase(lane, laneById);
    if (!base) throw new Error("Lane has no rebase suggestion to defer.");

    const existing = loadState(laneId);
    const behindCount = await readBehindCount({
      laneWorktreePath: lane.worktreePath,
      baseHeadSha: base.parentHeadSha,
    });
    const next: StoredSuggestionState = {
      laneId,
      parentLaneId: base.parentLaneId,
      parentHeadSha: base.parentHeadSha,
      behindCount,
      lastSuggestedAt: existing?.lastSuggestedAt ?? nowIso(),
      deferredUntil: until,
      dismissedAt: null
    };
    saveState(next);
    await emit();
  };

  const onParentHeadChanged = async (args: {
    laneId: string;
    preHeadSha: string | null;
    postHeadSha: string | null;
    reason: string;
  }): Promise<void> => {
    const parentId = args.laneId.trim();
    const parentHeadSha = (args.postHeadSha ?? "").trim();
    if (!parentId || !parentHeadSha) return;

    // Lightweight: only consider direct children; rebase runs can recurse.
    // Skip lanes that have a queue override — their base is the queue target,
    // not the direct parent, so writing direct-parent ids here would cause
    // listSuggestions() to see a base identity change and reset dismissals.
    const lanes = await laneService.list({ includeArchived: false });
    const directChildren = lanes.filter((lane) => lane.parentLaneId === parentId && lane.status.behind > 0);

    if (directChildren.length === 0) return;

    const children: LaneSummary[] = [];
    for (const child of directChildren) {
      const queueOverride = await resolveQueueRebaseOverride({ db, projectId, projectRoot, laneId: child.id });
      if (!queueOverride) children.push(child);
    }

    if (children.length === 0) return;

    const ts = nowIso();
    for (const child of children) {
      const existing = loadState(child.id);
      const next: StoredSuggestionState = {
        laneId: child.id,
        parentLaneId: parentId,
        parentHeadSha,
        behindCount: Math.max(0, Math.floor(child.status.behind)),
        lastSuggestedAt: existing?.parentHeadSha === parentHeadSha ? existing.lastSuggestedAt : ts,
        deferredUntil: existing?.deferredUntil ?? null,
        dismissedAt: existing?.parentHeadSha === parentHeadSha ? existing.dismissedAt ?? null : null
      };
      saveState(next);
    }

    logger.info("rebaseSuggestions.parent_head_changed", { parentId, reason: args.reason, children: children.length });
    await emit();
  };

  return {
    listSuggestions,
    refresh: emit,
    dismiss,
    defer,
    onParentHeadChanged
  };
}
