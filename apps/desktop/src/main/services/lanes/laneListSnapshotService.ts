import type {
  AgentChatSessionSummary,
  DeviceMarker,
  LaneListSnapshot,
  LaneRuntimeSummary,
  LaneStateSnapshotSummary,
  LaneSummary,
  TerminalSessionSummary,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import {
  fallbackUnprojectedChatSession,
  isChatToolType,
  projectChatOntoSession,
} from "../sessions/chatSessionProjection";
import { serializeLaneCacheKeyFields } from "./laneCacheKey";

type LanePresenceHost = {
  getLanePresenceSnapshot?: () => Array<{ laneId: string; devicesOpen: DeviceMarker[] }>;
};

type LanePresenceSyncService = {
  getHostService?: () => LanePresenceHost | null | undefined;
};

type LaneListSnapshotServices = {
  laneService: {
    listStateSnapshots: () => Promise<LaneStateSnapshotSummary[]> | LaneStateSnapshotSummary[];
  };
  sessionService: {
    list: (args: Record<string, unknown>) => TerminalSessionSummary[];
  };
  ptyService: {
    enrichSessions: <T extends TerminalSessionSummary>(rows: T[]) => T[];
  };
  agentChatService?: {
    listSessions: (
      laneId?: string,
      options?: { includeIdentity?: boolean; includeAutomation?: boolean },
    ) => Promise<AgentChatSessionSummary[]> | AgentChatSessionSummary[];
  } | null;
  rebaseSuggestionService?: {
    listSuggestions: (args?: { lanes?: LaneSummary[] }) =>
      | Promise<Array<NonNullable<LaneListSnapshot["rebaseSuggestion"]>>>
      | Array<NonNullable<LaneListSnapshot["rebaseSuggestion"]>>;
  } | null;
  autoRebaseService?: {
    listStatuses: (args?: { lanes?: LaneSummary[] }) =>
      | Promise<Array<NonNullable<LaneListSnapshot["autoRebaseStatus"]>>>
      | Array<NonNullable<LaneListSnapshot["autoRebaseStatus"]>>;
  } | null;
  conflictService?: {
    getBatchAssessment: (args: { lanes: LaneSummary[] }) =>
      | Promise<{ lanes?: Array<NonNullable<LaneListSnapshot["conflictStatus"]>> } | null>
      | { lanes?: Array<NonNullable<LaneListSnapshot["conflictStatus"]>> } | null;
  } | null;
  syncService?: LanePresenceSyncService | null;
  logger: Pick<Logger, "info">;
};

type OptionalLaneListEnrichment = [
  Array<NonNullable<LaneListSnapshot["rebaseSuggestion"]>>,
  Array<NonNullable<LaneListSnapshot["autoRebaseStatus"]>>,
  { lanes?: Array<NonNullable<LaneListSnapshot["conflictStatus"]>> } | null,
];

type OptionalLaneListEnrichmentCacheEntry = {
  last: OptionalLaneListEnrichment;
  inFlight: Promise<OptionalLaneListEnrichment> | null;
  generation: number;
};

const OPTIONAL_LANE_ENRICHMENT_CACHE_MAX_ENTRIES = 8;
const OPTIONAL_LANE_ENRICHMENT_RETRY_AFTER_MS = 2 * 60_000;
const optionalEnrichmentByLaneService = new WeakMap<
  object,
  Map<string, OptionalLaneListEnrichmentCacheEntry>
>();

function optionalLaneEnrichmentKey(
  lanes: LaneSummary[],
  options: LaneListSnapshotOptions,
): string {
  return JSON.stringify({
    lanes: lanes
      .map(serializeLaneCacheKeyFields)
      .sort((left, right) => left.id.localeCompare(right.id)),
    conflict: options.includeConflictStatus !== false,
    rebase: options.includeRebaseSuggestions !== false,
    autoRebase: options.includeAutoRebaseStatus !== false,
  });
}

export type LaneListSnapshotOptions = {
  includeConflictStatus?: boolean;
  includeRebaseSuggestions?: boolean;
  includeAutoRebaseStatus?: boolean;
  /** Test/diagnostic override; optional decorations must never gate core rows. */
  optionalEnrichmentBudgetMs?: number;
};

export const OPTIONAL_LANE_ENRICHMENT_BUDGET_MS = 250;

const IDLE_ATTENTION_TOOL_TYPES = new Set([
  "claude",
  "codex",
  "cursor-cli",
  "droid",
  "opencode",
  "claude-orchestrated",
  "codex-orchestrated",
  "opencode-orchestrated",
  "aider",
  "continue",
]);

function idleRuntimeNeedsAttention(toolType: string | null | undefined): boolean {
  if (isChatToolType(toolType)) return true;
  if (!toolType) return false;
  return IDLE_ATTENTION_TOOL_TYPES.has(toolType.trim().toLowerCase());
}

function sessionStatusBucket(args: {
  status: string;
  lastOutputPreview: string | null | undefined;
  runtimeState?: string | null;
  toolType?: string | null;
  settledAt?: string | null;
  attentionRequestedAt?: string | null;
  lastTurnFailedAt?: string | null;
}): "running" | "awaiting-input" | "ended" {
  // `ade chat ask` escalation outranks everything; a declared settle maps to
  // the quiet bucket for lane rollups (badges/counters) but only AT REST so a
  // background wake still counts as running; a dead chat turn is not running.
  // Mirrors canonicalSessionState in shared/sessionCanonicalState.ts.
  if (args.attentionRequestedAt) return "awaiting-input";
  if (args.settledAt && (args.status !== "running" || args.runtimeState === "idle")) return "ended";
  if (args.lastTurnFailedAt) return "ended";
  if (args.status === "running") {
    if (args.runtimeState === "waiting-input") return "awaiting-input";
    if (args.runtimeState === "idle" && idleRuntimeNeedsAttention(args.toolType)) return "awaiting-input";
    const preview = args.lastOutputPreview ?? "";
    if (/\b(?:waiting|awaiting)\b.{0,28}\b(?:input|confirmation|response|prompt)\b/i.test(preview)) {
      return "awaiting-input";
    }
    if (/\((?:y\/n|yes\/no)\)/i.test(preview) || /\[(?:y\/n|yes\/no)\]/i.test(preview)) {
      return "awaiting-input";
    }
    return "running";
  }
  if (isChatToolType(args.toolType)) return "awaiting-input";
  return "ended";
}

function summarizeLaneRuntime(
  laneId: string,
  sessions: Array<{
    laneId: string;
    status: string;
    lastOutputPreview: string | null;
    runtimeState?: string | null;
    toolType?: string | null;
    pendingInputItemId?: string | null;
    pendingInputWaiting?: boolean;
  }>,
): LaneRuntimeSummary {
  let runningCount = 0;
  let awaitingInputCount = 0;
  let pendingInputCount = 0;
  let endedCount = 0;
  let sessionCount = 0;

  for (const session of sessions) {
    if (session.laneId !== laneId) continue;
    sessionCount += 1;
    const bucket = sessionStatusBucket(session);
    if (bucket === "running") runningCount += 1;
    else if (bucket === "awaiting-input") {
      awaitingInputCount += 1;
      if (session.pendingInputItemId) pendingInputCount += 1;
    } else {
      endedCount += 1;
    }
  }

  let bucket: LaneRuntimeSummary["bucket"];
  if (awaitingInputCount > 0) bucket = "awaiting-input";
  else if (runningCount > 0) bucket = "running";
  else if (endedCount > 0) bucket = "ended";
  else bucket = "none";

  return {
    bucket,
    runningCount,
    awaitingInputCount,
    pendingInputCount,
    endedCount,
    sessionCount,
  };
}

export function buildLanePresenceByLaneId(syncService: LanePresenceSyncService | null | undefined): Map<string, DeviceMarker[]> {
  const hostService = syncService?.getHostService?.() ?? null;
  const snapshot = hostService?.getLanePresenceSnapshot?.() ?? [];
  return new Map(snapshot.map((entry) => [entry.laneId, entry.devicesOpen] as const));
}

function decorateLaneSummaryWithPresence(
  lane: LaneSummary,
  devicesOpenByLaneId: Map<string, DeviceMarker[]>,
): LaneSummary {
  const devicesOpen = devicesOpenByLaneId.get(lane.id) ?? [];
  return { ...lane, devicesOpen: devicesOpen.length > 0 ? devicesOpen : undefined };
}

export function decorateLaneSummariesWithPresence(
  lanes: LaneSummary[],
  devicesOpenByLaneId: Map<string, DeviceMarker[]>,
): LaneSummary[] {
  return lanes.map((lane) => decorateLaneSummaryWithPresence(lane, devicesOpenByLaneId));
}

async function enrichSessionsForLaneList(
  args: Pick<LaneListSnapshotServices, "sessionService" | "ptyService" | "agentChatService">,
): Promise<TerminalSessionSummary[]> {
  let sessions = args.ptyService.enrichSessions(args.sessionService.list({}));
  let allChats: AgentChatSessionSummary[] = [];
  try {
    allChats = await (args.agentChatService?.listSessions(undefined, {
      includeIdentity: true,
      includeAutomation: true,
    }) ?? []);
  } catch {
    allChats = [];
  }
  const identitySessionIds = new Set(
    allChats
      .filter((chat) => Boolean(chat.identityKey))
      .map((chat) => chat.sessionId),
  );
  if (identitySessionIds.size > 0) {
    sessions = sessions.filter((session) => !identitySessionIds.has(session.id));
  }
  const chats = allChats.filter((chat) => !chat.identityKey);
  const chatSummaryBySessionId = new Map(chats.map((chat) => [chat.sessionId, chat] as const));
  return sessions.map((session) => {
    if (!isChatToolType(session.toolType)) return session;
    const chat = chatSummaryBySessionId.get(session.id);
    if (!chat) return fallbackUnprojectedChatSession(session);
    const projected = projectChatOntoSession(session, chat);
    return chat.awaitingInput
      ? { ...projected, pendingInputWaiting: true }
      : projected;
  });
}

export async function buildLaneListSnapshots(
  args: LaneListSnapshotServices,
  lanes: LaneSummary[],
  options: LaneListSnapshotOptions = {},
): Promise<LaneListSnapshot[]> {
  const startedAt = Date.now();
  const phases: Array<{ phase: string; durationMs: number }> = [];
  const timePhase = async <T>(phase: string, work: () => Promise<T> | T): Promise<T> => {
    const phaseStartedAt = Date.now();
    try {
      return await work();
    } finally {
      const durationMs = Date.now() - phaseStartedAt;
      phases.push({ phase, durationMs });
      if (durationMs >= 120) {
        args.logger.info("lanes.listSnapshots.phase", {
          phase,
          durationMs,
          laneCount: lanes.length,
          includeConflictStatus: options.includeConflictStatus !== false,
          includeRebaseSuggestions: options.includeRebaseSuggestions !== false,
          includeAutoRebaseStatus: options.includeAutoRebaseStatus !== false,
        });
      }
    }
  };

  let optionalCache = optionalEnrichmentByLaneService.get(args.laneService);
  if (!optionalCache) {
    optionalCache = new Map();
    optionalEnrichmentByLaneService.set(args.laneService, optionalCache);
  }
  const optionalCacheKey = optionalLaneEnrichmentKey(lanes, options);
  let optionalEntry = optionalCache.get(optionalCacheKey);
  if (!optionalEntry) {
    optionalEntry = { last: [[], [], null], inFlight: null, generation: 0 };
    optionalCache.set(optionalCacheKey, optionalEntry);
    while (optionalCache.size > OPTIONAL_LANE_ENRICHMENT_CACHE_MAX_ENTRIES) {
      const oldestKey = optionalCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      optionalCache.delete(oldestKey);
    }
  }
  const cacheEntry = optionalEntry;
  if (!cacheEntry.inFlight) {
    const generation = cacheEntry.generation + 1;
    cacheEntry.generation = generation;
    const rebaseWork = (options.includeRebaseSuggestions === false
        ? Promise.resolve([])
        : timePhase("rebase_suggestions", () =>
            Promise.resolve()
              .then(() => args.rebaseSuggestionService?.listSuggestions({ lanes }) ?? [])
              .catch(() => cacheEntry.last[0])))
      .then((value) => {
        if (cacheEntry.generation === generation) {
          cacheEntry.last = [value, cacheEntry.last[1], cacheEntry.last[2]];
        }
        return value;
      });
    const autoRebaseWork = (options.includeAutoRebaseStatus === false
        ? Promise.resolve([])
        : timePhase("auto_rebase_statuses", () =>
            Promise.resolve()
              .then(() => args.autoRebaseService?.listStatuses({ lanes }) ?? [])
              .catch(() => cacheEntry.last[1])))
      .then((value) => {
        if (cacheEntry.generation === generation) {
          cacheEntry.last = [cacheEntry.last[0], value, cacheEntry.last[2]];
        }
        return value;
      });
    const conflictWork = (options.includeConflictStatus === false
        ? Promise.resolve(null)
        : timePhase("conflict_assessment", () =>
            Promise.resolve()
              .then(() => args.conflictService?.getBatchAssessment({ lanes }) ?? null)
              .catch(() => cacheEntry.last[2])))
      .then((value) => {
        if (cacheEntry.generation === generation) {
          cacheEntry.last = [cacheEntry.last[0], cacheEntry.last[1], value];
        }
        return value;
      });
    const work: Promise<OptionalLaneListEnrichment> = Promise.all([
      rebaseWork,
      autoRebaseWork,
      conflictWork,
    ]);
    cacheEntry.inFlight = work;
    const retryTimer = setTimeout(() => {
      if (cacheEntry.inFlight === work) cacheEntry.inFlight = null;
    }, OPTIONAL_LANE_ENRICHMENT_RETRY_AFTER_MS);
    retryTimer.unref?.();
    void work.then((result) => {
      // A watchdog may release a genuinely hung probe so a newer scan can
      // start. Never let that older probe overwrite newer last-known data if
      // it eventually settles out of order.
      if (cacheEntry.inFlight === work) cacheEntry.last = result;
    }).finally(() => {
      clearTimeout(retryTimer);
      if (cacheEntry.inFlight === work) cacheEntry.inFlight = null;
    });
  }
  const optionalEnrichment = cacheEntry.inFlight ?? Promise.resolve(cacheEntry.last);
  const optionalBudgetMs = Math.max(
    0,
    Math.floor(options.optionalEnrichmentBudgetMs ?? OPTIONAL_LANE_ENRICHMENT_BUDGET_MS),
  );
  let optionalBudgetTimer: ReturnType<typeof setTimeout> | null = null;
  const optionalWithinBudget: Promise<OptionalLaneListEnrichment | null> = Promise.race([
    optionalEnrichment,
    new Promise<null>((resolve) => {
      optionalBudgetTimer = setTimeout(() => resolve(null), optionalBudgetMs);
      optionalBudgetTimer.unref?.();
    }),
  ]);

  const [sessions, stateSnapshots, optionalResult] = await Promise.all([
    timePhase("sessions", () => enrichSessionsForLaneList(args)),
    timePhase("state_snapshots", () =>
      Promise.resolve()
        .then(() => args.laneService.listStateSnapshots())
        .catch(() => [])),
    optionalWithinBudget,
  ]);
  if (optionalBudgetTimer) clearTimeout(optionalBudgetTimer);
  const [rebaseSuggestions, autoRebaseStatuses, batchAssessment] = optionalResult
    ?? cacheEntry.last;
  if (optionalResult === null) {
    args.logger.info("lanes.listSnapshots.optional_enrichment_deferred", {
      laneCount: lanes.length,
      budgetMs: optionalBudgetMs,
      includeConflictStatus: options.includeConflictStatus !== false,
      includeRebaseSuggestions: options.includeRebaseSuggestions !== false,
      includeAutoRebaseStatus: options.includeAutoRebaseStatus !== false,
    });
  }
  const durationMs = Date.now() - startedAt;
  if (durationMs >= 120) {
    args.logger.info("lanes.listSnapshots.summary", {
      durationMs,
      laneCount: lanes.length,
      includeConflictStatus: options.includeConflictStatus !== false,
      includeRebaseSuggestions: options.includeRebaseSuggestions !== false,
      includeAutoRebaseStatus: options.includeAutoRebaseStatus !== false,
      phases: phases
        .filter((phase) => phase.durationMs >= 10)
        .sort((left, right) => right.durationMs - left.durationMs),
    });
  }

  const rebaseByLaneId = new Map(rebaseSuggestions.map((entry) => [entry.laneId, entry] as const));
  const autoRebaseByLaneId = new Map(autoRebaseStatuses.map((entry) => [entry.laneId, entry] as const));
  const stateByLaneId = new Map(stateSnapshots.map((entry) => [entry.laneId, entry] as const));
  const conflictByLaneId = new Map((batchAssessment?.lanes ?? []).map((entry) => [entry.laneId, entry] as const));
  const devicesOpenByLaneId = buildLanePresenceByLaneId(args.syncService);

  return lanes.map((lane) => ({
    lane: decorateLaneSummaryWithPresence(lane, devicesOpenByLaneId),
    runtime: summarizeLaneRuntime(lane.id, sessions),
    rebaseSuggestion: rebaseByLaneId.get(lane.id) ?? null,
    autoRebaseStatus: autoRebaseByLaneId.get(lane.id) ?? null,
    conflictStatus: conflictByLaneId.get(lane.id) ?? null,
    stateSnapshot: stateByLaneId.get(lane.id) ?? null,
    adoptableAttached: lane.laneType === "attached" && lane.archivedAt == null,
  }));
}
