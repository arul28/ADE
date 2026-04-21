import { getHeadSha, runGit } from "../git/git";
import type { AdeDb } from "../state/kvDb";
import type { Logger } from "../logging/logger";
import type { createLaneService } from "./laneService";
import type { LaneSummary, RebaseSuggestion, RebaseSuggestionsEventPayload, RebaseTargetCommit } from "../../../shared/types";
import { branchNameFromLaneRef, shouldLaneTrackParent } from "../../../shared/laneBaseResolution";
import { fetchQueueTargetTrackingBranches, fetchRemoteTrackingBranch, resolveQueueRebaseOverride } from "../shared/queueRebase";
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

  /**
   * Read the commits on `base` that aren't on `lane` — i.e. the set of commits
   * a rebase would pull in. Cap at 20 for payload safety; older commits are
   * trimmed. Returns an empty array on any git failure.
   */
  const readBehindCommits = async (args: {
    laneWorktreePath: string;
    baseHeadSha: string;
  }): Promise<RebaseTargetCommit[]> => {
    const laneHeadSha = await getHeadSha(args.laneWorktreePath);
    if (!laneHeadSha) return [];
    const result = await runGit(
      [
        "log",
        "-n",
        "20",
        "--pretty=format:%H%x1F%h%x1F%s%x1F%an%x1F%aI",
        `${laneHeadSha}..${args.baseHeadSha}`,
      ],
      { cwd: projectRoot, timeoutMs: 10_000 }
    );
    if (result.exitCode !== 0) return [];
    const out: RebaseTargetCommit[] = [];
    for (const line of result.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split("\x1F");
      if (parts.length < 5) continue;
      const [sha, shortSha, subject, author, committedAt] = parts;
      if (!sha) continue;
      out.push({
        sha,
        shortSha: shortSha || sha.slice(0, 7),
        subject: subject ?? "",
        author: author ?? "",
        committedAt: committedAt ?? "",
      });
    }
    return out;
  };

  const resolvePrimaryParentHeadSha = async (parent: LaneSummary): Promise<string | null> => {
    const parentBranch = parent.branchRef.trim();
    if (!parentBranch) return null;
    await fetchRemoteTrackingBranch({
      projectRoot,
      targetBranch: parentBranch,
    }).catch(() => {});
    const remoteHeadSha = await readRefHeadSha(`origin/${parentBranch}`);
    if (remoteHeadSha) return remoteHeadSha;
    return getHeadSha(parent.worktreePath);
  };

  const resolveSuggestionBase = async (
    lane: LaneSummary,
    laneById: Map<string, LaneSummary>,
    primaryParentHeadByBranch: Map<string, string | null>,
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

    if (lane.parentLaneId) {
      const parent = laneById.get(lane.parentLaneId);
      if (parent && shouldLaneTrackParent({ lane, parent })) {
        let parentHeadSha: string | null;
        if (parent.laneType === "primary") {
          const parentBranch = branchNameFromLaneRef(parent.branchRef);
          if (!parentBranch) return null;
          if (primaryParentHeadByBranch.has(parentBranch)) {
            parentHeadSha = primaryParentHeadByBranch.get(parentBranch) ?? null;
          } else {
            await fetchRemoteTrackingBranch({
              projectRoot,
              targetBranch: parentBranch,
            }).catch(() => {});
            parentHeadSha = await readRefHeadSha(`origin/${parentBranch}`);
            if (!parentHeadSha) {
              parentHeadSha = await getHeadSha(parent.worktreePath);
            }
            primaryParentHeadByBranch.set(parentBranch, parentHeadSha);
          }
        } else {
          parentHeadSha = await getHeadSha(parent.worktreePath);
        }
        if (!parentHeadSha) return null;
        return {
          parentLaneId: lane.parentLaneId,
          parentHeadSha,
          baseLabel: parent.name ?? null,
          groupContext: null,
        };
      }
    }

    // No parent lane — fall back to baseRef (e.g. "main" or "origin/main") for parentless imported lanes.
    const baseRef = lane.baseRef?.trim();
    if (!baseRef) return null;
    if (lane.laneType === "primary") return null;
    const fetchTargetName = baseRef.replace(/^origin\//, "");
    await fetchRemoteTrackingBranch({ projectRoot, targetBranch: fetchTargetName }).catch(() => {});
    const comparisonRef = baseRef.startsWith("origin/") ? baseRef : `origin/${fetchTargetName}`;
    const baseHeadSha =
      (await readRefHeadSha(comparisonRef))
      ?? (await readRefHeadSha(fetchTargetName));
    if (!baseHeadSha) return null;
    return {
      parentLaneId: `base:${baseRef}`,
      parentHeadSha: baseHeadSha,
      baseLabel: baseRef,
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
    const primaryParentHeadByBranch = new Map<string, string | null>();
    const prLaneIds = getPrLaneIds();

    const out: RebaseSuggestion[] = [];
    const nowMs = Date.now();

    for (const lane of lanes) {
      const base = await resolveSuggestionBase(lane, laneById, primaryParentHeadByBranch);
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

      if (
        !existing ||
        existing.laneId !== nextState.laneId ||
        existing.parentLaneId !== nextState.parentLaneId ||
        existing.parentHeadSha !== nextState.parentHeadSha ||
        existing.behindCount !== nextState.behindCount ||
        existing.lastSuggestedAt !== nextState.lastSuggestedAt ||
        existing.deferredUntil !== nextState.deferredUntil ||
        existing.dismissedAt !== nextState.dismissedAt
      ) {
        saveState(nextState);
      }

      if (isSuppressed({ nowMs, state: nextState, currentParentHeadSha: base.parentHeadSha })) continue;

      let targetCommits: RebaseTargetCommit[] = [];
      try {
        targetCommits = await readBehindCommits({
          laneWorktreePath: lane.worktreePath,
          baseHeadSha: base.parentHeadSha,
        });
      } catch (err) {
        logger.warn("rebaseSuggestions.read_target_commits_failed", {
          laneId: lane.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

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
        hasPr: prLaneIds.has(lane.id),
        targetCommits
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
    const primaryParentHeadByBranch = new Map<string, string | null>();
    const base = await resolveSuggestionBase(lane, laneById, primaryParentHeadByBranch);
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
    const primaryParentHeadByBranch = new Map<string, string | null>();
    const base = await resolveSuggestionBase(lane, laneById, primaryParentHeadByBranch);
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
    if (!parentId) return;

    // Lightweight: only consider direct children; rebase runs can recurse.
    // Skip lanes that have a queue override — their base is the queue target,
    // not the direct parent, so writing direct-parent ids here would cause
    // listSuggestions() to see a base identity change and reset dismissals.
    const lanes = await laneService.list({ includeArchived: false });
    const parent = lanes.find((lane) => lane.id === parentId) ?? null;
    const resolvedParentHeadSha = parent?.laneType === "primary"
      ? await resolvePrimaryParentHeadSha(parent)
      : (args.postHeadSha ?? "").trim();
    if (!resolvedParentHeadSha) return;
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
        parentHeadSha: resolvedParentHeadSha,
        behindCount: Math.max(0, Math.floor(child.status.behind)),
        lastSuggestedAt: existing?.parentHeadSha === resolvedParentHeadSha ? existing.lastSuggestedAt : ts,
        deferredUntil: existing?.deferredUntil ?? null,
        dismissedAt: existing?.parentHeadSha === resolvedParentHeadSha ? existing.dismissedAt ?? null : null
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
