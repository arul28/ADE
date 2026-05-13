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
      options?: { includeIdentity?: boolean },
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

export type LaneListSnapshotOptions = {
  includeConflictStatus?: boolean;
  includeRebaseSuggestions?: boolean;
  includeAutoRebaseStatus?: boolean;
};

function isChatToolType(toolType: string | null | undefined): boolean {
  if (!toolType) return false;
  const t = toolType.trim().toLowerCase();
  return t === "cursor" || t.endsWith("-chat");
}

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
}): "running" | "awaiting-input" | "ended" {
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
  }>,
): LaneRuntimeSummary {
  let runningCount = 0;
  let awaitingInputCount = 0;
  let endedCount = 0;
  let sessionCount = 0;

  for (const session of sessions) {
    if (session.laneId !== laneId) continue;
    sessionCount += 1;
    const bucket = sessionStatusBucket(session);
    if (bucket === "running") runningCount += 1;
    else if (bucket === "awaiting-input") awaitingInputCount += 1;
    else endedCount += 1;
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
    allChats = await (args.agentChatService?.listSessions(undefined, { includeIdentity: true }) ?? []);
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
  if (chats.length === 0) return sessions;
  const chatSummaryBySessionId = new Map(chats.map((chat) => [chat.sessionId, chat] as const));
  return sessions.map((session) => {
    if (!isChatToolType(session.toolType)) return session;
    if (session.status !== "running") return session;
    const chat = chatSummaryBySessionId.get(session.id);
    if (!chat) return session;
    if (chat.awaitingInput) return { ...session, runtimeState: "waiting-input" as const, chatIdleSinceAt: null };
    if (chat.status === "active") return { ...session, runtimeState: "running" as const, chatIdleSinceAt: null };
    if (chat.status === "idle") return { ...session, runtimeState: "idle" as const, chatIdleSinceAt: chat.idleSinceAt ?? null };
    return session;
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

  const [sessions, rebaseSuggestions, autoRebaseStatuses, stateSnapshots, batchAssessment] = await Promise.all([
    timePhase("sessions", () => enrichSessionsForLaneList(args)),
    options.includeRebaseSuggestions === false
      ? Promise.resolve([])
      : timePhase("rebase_suggestions", () =>
          Promise.resolve()
            .then(() => args.rebaseSuggestionService?.listSuggestions({ lanes }) ?? [])
            .catch(() => [])),
    options.includeAutoRebaseStatus === false
      ? Promise.resolve([])
      : timePhase("auto_rebase_statuses", () =>
          Promise.resolve()
            .then(() => args.autoRebaseService?.listStatuses({ lanes }) ?? [])
            .catch(() => [])),
    timePhase("state_snapshots", () =>
      Promise.resolve()
        .then(() => args.laneService.listStateSnapshots())
        .catch(() => [])),
    options.includeConflictStatus === false
      ? Promise.resolve(null)
      : timePhase("conflict_assessment", () =>
          Promise.resolve()
            .then(() => args.conflictService?.getBatchAssessment({ lanes }) ?? null)
            .catch(() => null)),
  ]);
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
