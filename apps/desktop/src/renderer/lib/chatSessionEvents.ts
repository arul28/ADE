import type { AgentChatEventEnvelope, AgentChatSession, AgentChatSessionSummary } from "../../shared/types";
import { invalidateAgentChatSessionListCache } from "./agentChatSessionListCache";
import { invalidateSessionListCache } from "./sessionListCache";

const WORK_CHAT_SESSION_CREATED_EVENT = "ade:work:chat-session-created";

export type WorkChatSessionCreatedDetail = {
  projectRoot: string;
  session: AgentChatSession;
};

export function announceWorkChatSessionCreated(
  projectRoot: string,
  session: AgentChatSession,
): void {
  invalidateSessionListCache({ projectRoot });
  invalidateAgentChatSessionListCache({ projectRoot, laneId: session.laneId });
  window.dispatchEvent(new CustomEvent<WorkChatSessionCreatedDetail>(WORK_CHAT_SESSION_CREATED_EVENT, {
    detail: { projectRoot, session },
  }));
}

export function subscribeWorkChatSessionCreated(
  listener: (detail: WorkChatSessionCreatedDetail) => void,
): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<WorkChatSessionCreatedDetail>).detail;
    if (detail?.projectRoot && detail.session?.id && detail.session.laneId) listener(detail);
  };
  window.addEventListener(WORK_CHAT_SESSION_CREATED_EVENT, handler);
  return () => window.removeEventListener(WORK_CHAT_SESSION_CREATED_EVENT, handler);
}

function parseTimestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isLocalTouchMap(
  value: ReadonlyMap<string, string> | Record<string, string | null | undefined>,
): value is ReadonlyMap<string, string> {
  return value instanceof Map;
}

function readLocalTouchAt(
  localTouchBySession:
    | ReadonlyMap<string, string>
    | Record<string, string | null | undefined>
    | undefined,
  sessionId: string,
): string | null {
  if (!localTouchBySession) return null;
  if (isLocalTouchMap(localTouchBySession)) {
    return localTouchBySession.get(sessionId) ?? null;
  }
  return localTouchBySession[sessionId] ?? null;
}

export function getEffectiveChatSessionRecencyMs(
  session: Pick<AgentChatSessionSummary, "sessionId" | "lastActivityAt" | "startedAt">,
  localTouchAt?: string | null,
): number {
  return Math.max(
    parseTimestampMs(localTouchAt),
    parseTimestampMs(session.lastActivityAt),
    parseTimestampMs(session.startedAt),
  );
}

export function compareChatSessionsByEffectiveRecency(
  left: Pick<AgentChatSessionSummary, "sessionId" | "lastActivityAt" | "startedAt">,
  right: Pick<AgentChatSessionSummary, "sessionId" | "lastActivityAt" | "startedAt">,
  localTouchBySession?:
    | ReadonlyMap<string, string>
    | Record<string, string | null | undefined>,
): number {
  const recencyDelta = getEffectiveChatSessionRecencyMs(right, readLocalTouchAt(localTouchBySession, right.sessionId))
    - getEffectiveChatSessionRecencyMs(left, readLocalTouchAt(localTouchBySession, left.sessionId));
  if (recencyDelta !== 0) return recencyDelta;

  const activityDelta = parseTimestampMs(right.lastActivityAt) - parseTimestampMs(left.lastActivityAt);
  if (activityDelta !== 0) return activityDelta;

  const startedDelta = parseTimestampMs(right.startedAt) - parseTimestampMs(left.startedAt);
  if (startedDelta !== 0) return startedDelta;

  return left.sessionId.localeCompare(right.sessionId);
}

export function getChatSessionLocalTouchTimestampForEvent(
  envelope: AgentChatEventEnvelope,
): string | null {
  switch (envelope.event.type) {
    case "approval_request":
    case "pending_input_resolved":
    case "session_meta_updated":
    case "done":
    case "error":
    case "user_message":
      return envelope.timestamp;
    case "scheduled_work_update":
      return envelope.event.kind === "background_task" ? null : envelope.timestamp;
    case "status":
      return (
        envelope.event.turnStatus === "started"
        || envelope.event.turnStatus === "failed"
        || envelope.event.turnStatus === "interrupted"
      )
        ? envelope.timestamp
        : null;
    default:
      return null;
  }
}

export function shouldRefreshSessionListForChatEvent(envelope: AgentChatEventEnvelope): boolean {
  return getChatSessionLocalTouchTimestampForEvent(envelope) != null;
}
