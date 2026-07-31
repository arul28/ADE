import { getHeadSha, runGit } from "../git/git";
import type { AdeDb } from "../state/kvDb";
import type { Logger } from "../logging/logger";
import type { createLaneService } from "./laneService";
import type { LaneSummary, RebaseSuggestion, RebaseSuggestionsEventPayload, RebaseTargetCommit } from "../../../shared/types";
import { branchNameFromLaneRef, shouldLaneTrackParent } from "../../../shared/laneBaseResolution";
import { fetchRemoteTrackingBranch } from "../shared/remoteTrackingBranch";
import { isRecord, nowIso } from "../shared/utils";
import { serializeLaneCacheKeyFields } from "./laneCacheKey";

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
const SUGGESTION_CACHE_TTL_MS = 10_000;
const SUGGESTION_SCAN_CONCURRENCY = 4;
const SUGGESTION_CACHE_MAX_ENTRIES = 8;

type ListSuggestionsOptions = {
  force?: boolean;
  lanes?: LaneSummary[];
  refreshRemoteTracking?: boolean;
};

function suggestionCacheKey(options: ListSuggestionsOptions): string {
  if (!options.lanes) return "default";
  return JSON.stringify(options.lanes
    .map(serializeLaneCacheKeyFields)
    .sort((left, right) => left.id.localeCompare(right.id)));
}

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

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await work(items[index] as T, index);
    }
  }));
  return results;
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
          -- Detached rows keep a dangling lane_id, so they would otherwise mark a
          -- lane as PR-backed long after its PR stopped belonging to it.
          and detached_at is null
      `,
      [projectId]
    );
    return new Set(rows.map((row) => String(row.lane_id ?? "").trim()).filter(Boolean));
  };

  const loadState = (laneId: string): StoredSuggestionState | null => sanitizeState(db.getJson(keyForLane(laneId)));

  const saveState = (state: StoredSuggestionState) => {
    db.setJson(keyForLane(state.laneId), state);
  };

  const cachedSuggestions = new Map<string, { atMs: number; suggestions: RebaseSuggestion[] }>();
  const suggestionsInFlight = new Map<string, Promise<RebaseSuggestion[]>>();
  let suggestionsCacheGeneration = 0;

  const invalidateSuggestionsCache = () => {
    cachedSuggestions.clear();
    suggestionsInFlight.clear();
    suggestionsCacheGeneration += 1;
  };

  const readRefHeadSha = async (ref: string): Promise<string | null> => {
    const result = await runGit(["rev-parse", "--verify", ref], { cwd: projectRoot, timeoutMs: 10_000 });
    return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : null;
  };

  const readBehindCount = async (args: { laneHeadSha: string; baseHeadSha: string }): Promise<number> => {
    const result = await runGit(
      ["rev-list", "--count", `${args.laneHeadSha}..${args.baseHeadSha}`],
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
    laneHeadSha: string;
    baseHeadSha: string;
  }): Promise<RebaseTargetCommit[]> => {
    const result = await runGit(
      [
        "log",
        "-n",
        "20",
        "--pretty=format:%H%x1F%h%x1F%s%x1F%an%x1F%aI",
        `${args.laneHeadSha}..${args.baseHeadSha}`,
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

  const resolvePrimaryParentHeadSha = async (
    parent: LaneSummary,
    options: { refreshRemoteTracking?: boolean } = {},
  ): Promise<string | null> => {
    const parentBranch = branchNameFromLaneRef(parent.branchRef).trim();
    if (!parentBranch) return null;
    if (options.refreshRemoteTracking) {
      await fetchRemoteTrackingBranch({
        projectRoot,
        targetBranch: parentBranch,
      }).catch(() => {});
    }
    const remoteHeadSha = await readRefHeadSha(`origin/${parentBranch}`);
    if (remoteHeadSha) return remoteHeadSha;
    return getHeadSha(parent.worktreePath);
  };

  const resolveSuggestionBase = async (
    lane: LaneSummary,
    laneById: Map<string, LaneSummary>,
    primaryParentHeadByBranch: Map<string, string | null>,
    options: {
      refreshRemoteTracking?: boolean;
      readRefHeadSha?: (ref: string) => Promise<string | null>;
      getWorktreeHeadSha?: (worktreePath: string) => Promise<string | null>;
    } = {},
  ): Promise<{ parentLaneId: string; parentHeadSha: string; baseLabel: string | null; groupContext: string | null } | null> => {
    const readRef = options.readRefHeadSha ?? readRefHeadSha;
    const readWorktreeHead = options.getWorktreeHeadSha ?? getHeadSha;
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
            if (options.refreshRemoteTracking) {
              await fetchRemoteTrackingBranch({
                projectRoot,
                targetBranch: parentBranch,
              }).catch(() => {});
            }
            parentHeadSha = await readRef(`origin/${parentBranch}`);
            if (!parentHeadSha) {
              parentHeadSha = await readWorktreeHead(parent.worktreePath);
            }
            primaryParentHeadByBranch.set(parentBranch, parentHeadSha);
          }
        } else {
          parentHeadSha = await readWorktreeHead(parent.worktreePath);
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
    if (options.refreshRemoteTracking) {
      await fetchRemoteTrackingBranch({ projectRoot, targetBranch: fetchTargetName }).catch(() => {});
    }
    const comparisonRef = baseRef.startsWith("origin/") ? baseRef : `origin/${fetchTargetName}`;
    const baseHeadSha =
      (await readRef(comparisonRef))
      ?? (await readRef(fetchTargetName));
    if (!baseHeadSha) return null;
    return {
      parentLaneId: `base:${baseRef}`,
      parentHeadSha: baseHeadSha,
      baseLabel: baseRef,
      groupContext: null,
    };
  };

  const computeSuggestions = async (options: ListSuggestionsOptions = {}): Promise<RebaseSuggestion[]> => {
    const startedAt = Date.now();
    const lanes = options.lanes ?? await laneService.list({ includeArchived: false });
    const laneById = new Map(lanes.map((lane) => [lane.id, lane] as const));
    const primaryParentHeadByBranch = new Map<string, string | null>();
    const refHeadShaByRef = new Map<string, Promise<string | null>>();
    const worktreeHeadShaByPath = new Map<string, Promise<string | null>>();
    const prLaneIds = getPrLaneIds();

    const nowMs = Date.now();
    const readRefHeadShaCached = (ref: string): Promise<string | null> => {
      const existing = refHeadShaByRef.get(ref);
      if (existing) return existing;
      const next = readRefHeadSha(ref);
      refHeadShaByRef.set(ref, next);
      return next;
    };
    const getWorktreeHeadShaCached = (worktreePath: string): Promise<string | null> => {
      const existing = worktreeHeadShaByPath.get(worktreePath);
      if (existing) return existing;
      const next = getHeadSha(worktreePath);
      worktreeHeadShaByPath.set(worktreePath, next);
      return next;
    };
    const computeLaneSuggestion = async (lane: LaneSummary): Promise<RebaseSuggestion | null> => {
      const laneStartedAt = Date.now();
      const phases: Array<{ phase: string; durationMs: number }> = [];
      const timePhase = async <T>(phase: string, work: () => Promise<T> | T): Promise<T> => {
        const phaseStartedAt = Date.now();
        try {
          return await work();
        } finally {
          phases.push({ phase, durationMs: Date.now() - phaseStartedAt });
        }
      };

      const base = await timePhase("resolve_base", () =>
        resolveSuggestionBase(lane, laneById, primaryParentHeadByBranch, {
          refreshRemoteTracking: options.refreshRemoteTracking === true,
          readRefHeadSha: readRefHeadShaCached,
          getWorktreeHeadSha: getWorktreeHeadShaCached,
        }));
      if (!base) return null;
      const laneHeadSha = await timePhase("read_lane_head", () => getWorktreeHeadShaCached(lane.worktreePath));
      if (!laneHeadSha) return null;
      const behindCount = await timePhase("read_behind_count", () => readBehindCount({
        laneHeadSha,
        baseHeadSha: base.parentHeadSha,
      }));
      if (behindCount <= 0) return null;

      const existing = await timePhase("load_state", () => loadState(lane.id));

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
        await timePhase("save_state", () => saveState(nextState));
      }

      if (isSuppressed({ nowMs, state: nextState, currentParentHeadSha: base.parentHeadSha })) return null;

      let targetCommits: RebaseTargetCommit[] = [];
      try {
        targetCommits = await timePhase("read_target_commits", () => readBehindCommits({
          laneHeadSha,
          baseHeadSha: base.parentHeadSha,
        }));
      } catch (err) {
        logger.warn("rebaseSuggestions.read_target_commits_failed", {
          laneId: lane.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const durationMs = Date.now() - laneStartedAt;
      if (durationMs >= 250) {
        logger.info("rebaseSuggestions.lane_slow", {
          laneId: lane.id,
          durationMs,
          phases: phases
            .filter((phase) => phase.durationMs >= 10)
            .sort((left, right) => right.durationMs - left.durationMs),
        });
      }

      return {
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
      };
    };

    const out = (await mapWithConcurrency(lanes, SUGGESTION_SCAN_CONCURRENCY, computeLaneSuggestion))
      .filter((entry): entry is RebaseSuggestion => entry !== null);
    const durationMs = Date.now() - startedAt;
    if (durationMs >= 120) {
      logger.info("rebaseSuggestions.list_summary", {
        durationMs,
        laneCount: lanes.length,
        suggestionCount: out.length,
        providedLanes: Boolean(options.lanes),
        refreshRemoteTracking: options.refreshRemoteTracking === true,
      });
    }
    return out.sort((a, b) => {
      const behindDelta = b.behindCount - a.behindCount;
      if (behindDelta !== 0) return behindDelta;
      return a.laneId.localeCompare(b.laneId);
    });
  };

  const listSuggestions = async (options: ListSuggestionsOptions = {}): Promise<RebaseSuggestion[]> => {
    // Snapshot callers provide the lanes they already loaded. Cache those
    // bounded scans too; otherwise every invalidation starts the same slow git
    // probes again while an earlier timed-out/deferred scan is still running.
    const useSharedCache = !options.force && options.refreshRemoteTracking !== true;
    const cacheKey = suggestionCacheKey(options);
    const nowMs = Date.now();
    const cached = cachedSuggestions.get(cacheKey);
    if (useSharedCache && cached && nowMs - cached.atMs < SUGGESTION_CACHE_TTL_MS) {
      return cached.suggestions;
    }
    const inFlight = suggestionsInFlight.get(cacheKey);
    if (useSharedCache && inFlight) {
      return inFlight;
    }

    const generation = suggestionsCacheGeneration;
    const work = computeSuggestions(options);
    if (useSharedCache) {
      suggestionsInFlight.set(cacheKey, work);
    }
    try {
      const suggestions = await work;
      if (useSharedCache && generation === suggestionsCacheGeneration) {
        cachedSuggestions.delete(cacheKey);
        cachedSuggestions.set(cacheKey, { atMs: Date.now(), suggestions });
        while (cachedSuggestions.size > SUGGESTION_CACHE_MAX_ENTRIES) {
          const oldestKey = cachedSuggestions.keys().next().value as string | undefined;
          if (!oldestKey) break;
          cachedSuggestions.delete(oldestKey);
        }
      }
      return suggestions;
    } finally {
      if (suggestionsInFlight.get(cacheKey) === work) {
        suggestionsInFlight.delete(cacheKey);
      }
    }
  };

  const emit = async (options: ListSuggestionsOptions = {}) => {
    if (!onEvent) return;
    try {
      const suggestions = await listSuggestions({ ...options, force: true });
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

    const existing = loadState(laneId);
    if (existing) {
      invalidateSuggestionsCache();
      saveState({
        ...existing,
        dismissedAt: nowIso()
      });
      void emit();
      return;
    }

    const lanes = await laneService.list({ includeArchived: false });
    const lane = lanes.find((l) => l.id === laneId);
    if (!lane) throw new Error(`Lane not found: ${laneId}`);
    const laneById = new Map(lanes.map((entry) => [entry.id, entry] as const));
    const primaryParentHeadByBranch = new Map<string, string | null>();
    const base = await resolveSuggestionBase(lane, laneById, primaryParentHeadByBranch);
    if (!base) throw new Error("Lane has no rebase suggestion to dismiss.");

    const laneHeadSha = await getHeadSha(lane.worktreePath);
    if (!laneHeadSha) throw new Error("Lane has no readable head.");
    const behindCount = await readBehindCount({
      laneHeadSha,
      baseHeadSha: base.parentHeadSha,
    });
    const next: StoredSuggestionState = {
      laneId,
      parentLaneId: base.parentLaneId,
      parentHeadSha: base.parentHeadSha,
      behindCount,
      lastSuggestedAt: nowIso(),
      deferredUntil: null,
      dismissedAt: nowIso()
    };
    invalidateSuggestionsCache();
    saveState(next);
    void emit();
  };

  const defer = async (args: { laneId: string; minutes: number }): Promise<void> => {
    const laneId = args.laneId.trim();
    if (!laneId) throw new Error("laneId is required");

    const minutes = Math.max(5, Math.min(7 * 24 * 60, Math.floor(args.minutes)));
    const until = new Date(Date.now() + minutes * 60_000).toISOString();

    const existing = loadState(laneId);
    if (existing) {
      invalidateSuggestionsCache();
      saveState({
        ...existing,
        deferredUntil: until,
        dismissedAt: null
      });
      void emit();
      return;
    }

    const lanes = await laneService.list({ includeArchived: false });
    const lane = lanes.find((l) => l.id === laneId);
    if (!lane) throw new Error(`Lane not found: ${laneId}`);
    const laneById = new Map(lanes.map((entry) => [entry.id, entry] as const));
    const primaryParentHeadByBranch = new Map<string, string | null>();
    const base = await resolveSuggestionBase(lane, laneById, primaryParentHeadByBranch);
    if (!base) throw new Error("Lane has no rebase suggestion to defer.");

    const laneHeadSha = await getHeadSha(lane.worktreePath);
    if (!laneHeadSha) throw new Error("Lane has no readable head.");
    const behindCount = await readBehindCount({
      laneHeadSha,
      baseHeadSha: base.parentHeadSha,
    });
    const next: StoredSuggestionState = {
      laneId,
      parentLaneId: base.parentLaneId,
      parentHeadSha: base.parentHeadSha,
      behindCount,
      lastSuggestedAt: nowIso(),
      deferredUntil: until,
      dismissedAt: null
    };
    invalidateSuggestionsCache();
    saveState(next);
    void emit();
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
    const lanes = await laneService.list({ includeArchived: false });
    const parent = lanes.find((lane) => lane.id === parentId) ?? null;
    const resolvedParentHeadSha = parent?.laneType === "primary"
      ? await resolvePrimaryParentHeadSha(parent, { refreshRemoteTracking: true })
      : (args.postHeadSha ?? "").trim();
    if (!resolvedParentHeadSha) return;
    const directChildren = lanes.filter((lane) => lane.parentLaneId === parentId && lane.status.behind > 0);

    if (directChildren.length === 0) return;

    const children = directChildren;

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
      invalidateSuggestionsCache();
      saveState(next);
    }

    logger.info("rebaseSuggestions.parent_head_changed", { parentId, reason: args.reason, children: children.length });
    await emit({ refreshRemoteTracking: true });
  };

  return {
    listSuggestions,
    refresh: () => emit({ refreshRemoteTracking: true }),
    dismiss,
    defer,
    onParentHeadChanged
  };
}
