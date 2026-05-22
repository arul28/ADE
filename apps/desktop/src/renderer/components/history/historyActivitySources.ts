import type {
  AgentChatSessionSummary,
  CtoSnapshot,
  MissionSummary,
  OperationRecord,
  WorkerAgentRun,
} from "../../../shared/types";

type OperationStatus = OperationRecord["status"];

export type HistoryActivitySourceData = {
  chats?: AgentChatSessionSummary[];
  missions?: MissionSummary[];
  ctoSnapshot?: CtoSnapshot | null;
  workerRuns?: WorkerAgentRun[];
};

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function validIso(value: unknown): string | null {
  const text = cleanString(value);
  if (!text) return null;
  return Number.isFinite(Date.parse(text)) ? text : null;
}

function metadataJson(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function terminalEndedAt(status: OperationStatus, timestamp: string): string | null {
  return status === "running" ? null : timestamp;
}

function chatStatus(status: AgentChatSessionSummary["status"]): OperationStatus {
  return status === "active" ? "running" : "succeeded";
}

function missionStatus(status: MissionSummary["status"]): OperationStatus {
  switch (status) {
    case "completed":
      return "succeeded";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    default:
      return "running";
  }
}

function workerStatus(status: WorkerAgentRun["status"]): OperationStatus {
  switch (status) {
    case "completed":
    case "skipped":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "canceled";
    default:
      return "running";
  }
}

function missionKind(status: MissionSummary["status"]): string {
  switch (status) {
    case "completed":
      return "mission.completed";
    case "failed":
      return "mission.failed";
    case "intervention_required":
      return "mission.intervention";
    default:
      return "mission.update";
  }
}

function laneFromContext(context: Record<string, unknown>): {
  laneId: string | null;
  laneName: string | null;
} {
  const laneId = cleanString(context.laneId) ?? cleanString(context.sourceLaneId);
  const laneName = cleanString(context.laneName) ?? cleanString(context.sourceLaneName);
  return { laneId, laneName };
}

function chatRecord(chat: AgentChatSessionSummary): OperationRecord | null {
  const timestamp =
    validIso(chat.endedAt) ??
    validIso(chat.lastActivityAt) ??
    validIso(chat.startedAt);
  if (!timestamp) return null;
  const status = chatStatus(chat.status);
  const title =
    cleanString(chat.title) ??
    cleanString(chat.goal) ??
    cleanString(chat.summary) ??
    chat.sessionId;

  return {
    id: `chat:${chat.sessionId}`,
    laneId: chat.laneId,
    laneName: null,
    kind: "chat.session",
    startedAt: timestamp,
    endedAt: terminalEndedAt(status, timestamp),
    status,
    preHeadSha: null,
    postHeadSha: null,
    metadataJson: metadataJson({
      source: "agentChat",
      eventLabel: `Chat: ${title}`,
      sessionId: chat.sessionId,
      provider: chat.provider,
      model: chat.model,
      profile: chat.sessionProfile ?? null,
      title,
      summary: chat.summary,
      lastOutputPreview: chat.lastOutputPreview,
      actor: chat.provider,
      chatStatus: chat.status,
      awaitingInput: chat.awaitingInput === true,
      automationId: chat.automationId ?? null,
      automationRunId: chat.automationRunId ?? null,
    }),
  };
}

function missionRecord(mission: MissionSummary): OperationRecord | null {
  const timestamp =
    validIso(mission.completedAt) ??
    validIso(mission.updatedAt) ??
    validIso(mission.startedAt) ??
    validIso(mission.createdAt);
  if (!timestamp) return null;
  const status = missionStatus(mission.status);

  return {
    id: `mission:${mission.id}`,
    laneId: mission.laneId,
    laneName: mission.laneName,
    kind: missionKind(mission.status),
    startedAt: timestamp,
    endedAt: terminalEndedAt(status, timestamp),
    status,
    preHeadSha: null,
    postHeadSha: null,
    metadataJson: metadataJson({
      source: "mission",
      eventLabel: `Mission: ${mission.title}`,
      missionId: mission.id,
      title: mission.title,
      summary: mission.outcomeSummary ?? mission.prompt,
      actor: "mission",
      priority: mission.priority,
      missionStatus: mission.status,
      completedSteps: mission.completedSteps,
      totalSteps: mission.totalSteps,
      openInterventions: mission.openInterventions,
      artifactCount: mission.artifactCount,
      lastError: mission.lastError,
    }),
  };
}

function workerRunRecord(run: WorkerAgentRun): OperationRecord | null {
  const timestamp =
    validIso(run.finishedAt) ??
    validIso(run.startedAt) ??
    validIso(run.updatedAt) ??
    validIso(run.createdAt);
  if (!timestamp) return null;
  const status = workerStatus(run.status);
  const lane = laneFromContext(run.context);
  const taskLabel = cleanString(run.taskKey) ?? cleanString(run.issueKey) ?? run.id;

  return {
    id: `worker-run:${run.id}`,
    laneId: lane.laneId,
    laneName: lane.laneName,
    kind: "worker.run",
    startedAt: timestamp,
    endedAt: terminalEndedAt(status, timestamp),
    status,
    preHeadSha: null,
    postHeadSha: null,
    metadataJson: metadataJson({
      source: "workerRun",
      eventLabel: `Worker task: ${taskLabel}`,
      runId: run.id,
      agentId: run.agentId,
      taskKey: run.taskKey ?? null,
      issueKey: run.issueKey ?? null,
      workerStatus: run.status,
      wakeupReason: run.wakeupReason,
      actor: run.agentId,
      error: run.errorMessage ?? null,
    }),
  };
}

function ctoSessionRecords(snapshot: CtoSnapshot): OperationRecord[] {
  return snapshot.recentSessions
    .map((entry): OperationRecord | null => {
      const timestamp =
        validIso(entry.endedAt) ??
        validIso(entry.createdAt) ??
        validIso(entry.startedAt);
      if (!timestamp) return null;
      const status: OperationStatus = entry.endedAt ? "succeeded" : "running";
      return {
        id: `cto-session:${entry.id}`,
        laneId: null,
        laneName: null,
        kind: "cto.session",
        startedAt: timestamp,
        endedAt: terminalEndedAt(status, timestamp),
        status,
        preHeadSha: null,
        postHeadSha: null,
        metadataJson: metadataJson({
          source: "cto",
          eventLabel: `CTO: ${entry.summary}`,
          sessionId: entry.sessionId,
          summary: entry.summary,
          provider: entry.provider,
          model: entry.modelId,
          actor: "cto",
          capabilityMode: entry.capabilityMode,
        }),
      };
    })
    .filter((record): record is OperationRecord => record != null);
}

function ctoActivityRecords(snapshot: CtoSnapshot): OperationRecord[] {
  return snapshot.recentSubordinateActivity
    .map((entry): OperationRecord | null => {
      const timestamp = validIso(entry.createdAt);
      if (!timestamp) return null;
      return {
        id: `cto-activity:${entry.id}`,
        laneId: null,
        laneName: null,
        kind: "worker.activity",
        startedAt: timestamp,
        endedAt: timestamp,
        status: "succeeded",
        preHeadSha: null,
        postHeadSha: null,
        metadataJson: metadataJson({
          source: "ctoActivity",
          eventLabel: `${entry.agentName}: ${entry.summary}`,
          agentId: entry.agentId,
          agent: entry.agentName,
          sessionId: entry.sessionId ?? null,
          taskKey: entry.taskKey ?? null,
          issueKey: entry.issueKey ?? null,
          activityType: entry.activityType,
          summary: entry.summary,
          actor: entry.agentName,
        }),
      };
    })
    .filter((record): record is OperationRecord => record != null);
}

export function buildSupplementalTimelineRecords(
  data: HistoryActivitySourceData,
): OperationRecord[] {
  const records: OperationRecord[] = [];

  for (const chat of data.chats ?? []) {
    const record = chatRecord(chat);
    if (record) records.push(record);
  }

  for (const mission of data.missions ?? []) {
    const record = missionRecord(mission);
    if (record) records.push(record);
  }

  for (const run of data.workerRuns ?? []) {
    const record = workerRunRecord(run);
    if (record) records.push(record);
  }

  if (data.ctoSnapshot) {
    records.push(...ctoSessionRecords(data.ctoSnapshot));
    records.push(...ctoActivityRecords(data.ctoSnapshot));
  }

  return records;
}

async function settle<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

export async function fetchSupplementalTimelineRecords(
  limit: number,
): Promise<OperationRecord[]> {
  const roundedLimit = Math.floor(limit);
  const safeLimit = Number.isFinite(roundedLimit)
    ? Math.max(1, Math.min(500, roundedLimit))
    : 500;
  const [chats, missions, ctoSnapshot, workerRuns] = await Promise.all([
    typeof window.ade?.agentChat?.list === "function"
      ? settle(window.ade.agentChat.list({ includeAutomation: true }))
      : Promise.resolve(null),
    typeof window.ade?.missions?.list === "function"
      ? settle(window.ade.missions.list({ limit: safeLimit, includeArchived: true }))
      : Promise.resolve(null),
    typeof window.ade?.cto?.getState === "function"
      ? settle(window.ade.cto.getState({ recentLimit: Math.min(100, safeLimit) }))
      : Promise.resolve(null),
    typeof window.ade?.cto?.listAgentRuns === "function"
      ? settle(window.ade.cto.listAgentRuns({ limit: Math.min(100, safeLimit) }))
      : Promise.resolve(null),
  ]);

  return buildSupplementalTimelineRecords({
    chats: chats ?? [],
    missions: missions ?? [],
    ctoSnapshot,
    workerRuns: workerRuns ?? [],
  });
}

export function sortTimelineRecords(records: OperationRecord[]): OperationRecord[] {
  const seen = new Set<string>();
  return [...records]
    .filter((record) => {
      if (seen.has(record.id)) return false;
      seen.add(record.id);
      return true;
    })
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}
