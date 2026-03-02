import { runGit } from "../git/git";
import type { AdeDb } from "../state/kvDb";
import type { Logger } from "../logging/logger";
import type { createLaneService } from "./laneService";
import type { RestackSuggestion, RestackSuggestionsEventPayload } from "../../../shared/types";
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

const KEY_PREFIX = "restack:suggestion:";

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

async function readHeadSha(worktreePath: string): Promise<string | null> {
  const res = await runGit(["rev-parse", "HEAD"], { cwd: worktreePath, timeoutMs: 10_000 });
  if (res.exitCode !== 0) return null;
  const sha = res.stdout.trim();
  return sha.length ? sha : null;
}

export function createRestackSuggestionService(args: {
  db: AdeDb;
  logger: Logger;
  projectId: string;
  laneService: ReturnType<typeof createLaneService>;
  onEvent?: (event: RestackSuggestionsEventPayload) => void;
}) {
  const { db, logger, projectId, laneService, onEvent } = args;

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

  const listSuggestions = async (): Promise<RestackSuggestion[]> => {
    const lanes = await laneService.list({ includeArchived: false });
    const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));
    const prLaneIds = getPrLaneIds();
    const parentHeadShaById = new Map<string, string | null>();

    const out: RestackSuggestion[] = [];
    const nowMs = Date.now();

    for (const lane of lanes) {
      const parentLaneId = lane.parentLaneId;
      if (!parentLaneId) continue;
      if (lane.status.behind <= 0) continue;

      const parent = laneById.get(parentLaneId);
      if (!parent) continue;

      let parentHeadSha = parentHeadShaById.get(parentLaneId);
      if (parentHeadSha === undefined) {
        parentHeadSha = await readHeadSha(parent.worktreePath);
        parentHeadShaById.set(parentLaneId, parentHeadSha);
      }
      if (!parentHeadSha) continue;

      const existing = loadState(lane.id);
      const behindCount = Math.max(0, Math.floor(lane.status.behind));

      const nextState: StoredSuggestionState = existing && existing.parentLaneId === parentLaneId
        ? (() => {
            if (existing.parentHeadSha !== parentHeadSha) {
              return {
                laneId: lane.id,
                parentLaneId,
                parentHeadSha,
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
            parentLaneId,
            parentHeadSha,
            behindCount,
            lastSuggestedAt: nowIso(),
            deferredUntil: existing?.deferredUntil ?? null,
            dismissedAt: null
          };

      if (!existing || JSON.stringify(existing) !== JSON.stringify(nextState)) {
        saveState(nextState);
      }

      if (isSuppressed({ nowMs, state: nextState, currentParentHeadSha: parentHeadSha })) continue;

      out.push({
        laneId: lane.id,
        parentLaneId,
        parentHeadSha,
        behindCount,
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
        type: "restack-suggestions-updated",
        computedAt: nowIso(),
        suggestions
      });
    } catch (err) {
      logger.warn("restackSuggestions.emit_failed", { err: String(err) });
    }
  };

  const dismiss = async (args: { laneId: string }): Promise<void> => {
    const laneId = args.laneId.trim();
    if (!laneId) throw new Error("laneId is required");

    const lanes = await laneService.list({ includeArchived: false });
    const lane = lanes.find((l) => l.id === laneId);
    if (!lane) throw new Error(`Lane not found: ${laneId}`);
    if (!lane.parentLaneId) throw new Error("Lane has no parent; nothing to dismiss.");

    const parent = lanes.find((l) => l.id === lane.parentLaneId);
    if (!parent) throw new Error("Parent lane not found.");
    const parentHeadSha = await readHeadSha(parent.worktreePath);
    if (!parentHeadSha) throw new Error("Unable to resolve parent HEAD.");

    const existing = loadState(laneId);
    const next: StoredSuggestionState = {
      laneId,
      parentLaneId: lane.parentLaneId,
      parentHeadSha,
      behindCount: Math.max(0, Math.floor(lane.status.behind)),
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
    if (!lane.parentLaneId) throw new Error("Lane has no parent; nothing to defer.");

    const parent = lanes.find((l) => l.id === lane.parentLaneId);
    if (!parent) throw new Error("Parent lane not found.");
    const parentHeadSha = await readHeadSha(parent.worktreePath);
    if (!parentHeadSha) throw new Error("Unable to resolve parent HEAD.");

    const existing = loadState(laneId);
    const next: StoredSuggestionState = {
      laneId,
      parentLaneId: lane.parentLaneId,
      parentHeadSha,
      behindCount: Math.max(0, Math.floor(lane.status.behind)),
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

    // Lightweight: only consider direct children; restack is recursive.
    const lanes = await laneService.list({ includeArchived: false });
    const children = lanes.filter((lane) => lane.parentLaneId === parentId && lane.status.behind > 0);

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

    logger.info("restackSuggestions.parent_head_changed", { parentId, reason: args.reason, children: children.length });
    await emit();
  };

  return {
    listSuggestions,
    dismiss,
    defer,
    onParentHeadChanged
  };
}
