import type {
  AgentChatSessionSummary,
  CtoSnapshot,
  OperationRecord,
} from "../../../shared/types";

type OperationStatus = OperationRecord["status"];

export type HistoryActivitySourceData = {
  chats?: AgentChatSessionSummary[];
  ctoSnapshot?: CtoSnapshot | null;
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

export function buildSupplementalTimelineRecords(
  data: HistoryActivitySourceData,
): OperationRecord[] {
  const records: OperationRecord[] = [];

  for (const chat of data.chats ?? []) {
    const record = chatRecord(chat);
    if (record) records.push(record);
  }

  if (data.ctoSnapshot) {
    records.push(...ctoSessionRecords(data.ctoSnapshot));
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
  const [chats, ctoSnapshot] = await Promise.all([
    typeof window.ade?.agentChat?.list === "function"
      ? settle(window.ade.agentChat.list({ includeAutomation: true }))
      : Promise.resolve(null),
    typeof window.ade?.cto?.getState === "function"
      ? settle(window.ade.cto.getState({ recentLimit: Math.min(100, safeLimit) }))
      : Promise.resolve(null),
  ]);

  return buildSupplementalTimelineRecords({
    chats: chats ?? [],
    ctoSnapshot,
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
