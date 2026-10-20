import type { AgentChatSessionSummary, AgentChatTranscriptEntry } from "../../../shared/types/chat";
import type { JevService } from "../jev/jevService";
import type { TerminalSessionSummary } from "../../../shared/types/sessions";
import { totalBackgroundWork } from "../../../shared/sessionCanonicalState";
import { isChatToolType } from "../../../shared/sessionSpawnNesting";

export const SETTLE_NUDGE_IDLE_THRESHOLD_MS = 3 * 60 * 60 * 1000;
const SETTLE_NUDGE_SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const SETTLE_NUDGE_START_DELAY_MS = 15 * 1000;
const SETTLE_NUDGE_MAX_CALLS_PER_SWEEP = 10;
const SETTLE_NUDGE_TRANSCRIPT_LIMIT = 200;
const SETTLE_NUDGE_TEXT_LIMIT = 1_500;

type SessionService = {
  list: (args?: { limit?: number | null }) => TerminalSessionSummary[];
  get: (sessionId: string) => TerminalSessionSummary | null;
  setSettleNudgeVerdict: (args: {
    sessionId: string;
    turnId: string;
    doneProbability: number;
    expectedTurnMarker: string | null;
    expectedLastActivityAt: string | null;
  }) => boolean;
};

type AgentChatService = {
  getSessionSummary: (sessionId: string) => Promise<AgentChatSessionSummary | null>;
  readTranscript: (sessionId: string, limit?: number) => Promise<AgentChatTranscriptEntry[]>;
};

export type SettleNudgeSweepDeps = {
  sessionService: SessionService;
  agentChatService: AgentChatService;
  jevService: Pick<JevService, "decide" | "status">;
};

type CompletedTurn = {
  key: string;
  userText: string;
  assistantText: string;
};

function completedTurn(entries: AgentChatTranscriptEntry[]): CompletedTurn | null {
  let userIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.role === "user" && entry.text.trim().length > 0) {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return null;
  const user = entries[userIndex];
  let assistant: AgentChatTranscriptEntry | undefined;
  for (let index = entries.length - 1; index > userIndex; index -= 1) {
    const entry = entries[index];
    if (entry.role === "assistant" && entry.text.trim().length > 0) {
      assistant = entry;
      break;
    }
  }
  if (!assistant) return null;
  if (user.turnId && assistant.turnId && user.turnId !== assistant.turnId) return null;
  const key = assistant.turnId?.trim()
    || assistant.messageId?.trim()
    || `${user.timestamp}/${assistant.timestamp}`;
  if (!key) return null;
  return { key, userText: user.text, assistantText: assistant.text };
}

function clipped(text: string, limit: number, fromEnd = false): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return fromEnd ? `…${normalized.slice(-(limit - 1))}` : `${normalized.slice(0, limit - 1)}…`;
}

function rowCanBeJudged(session: TerminalSessionSummary, nowMs: number): boolean {
  const lastActivityAt = session.lastActivityAt;
  const lastActivityMs = lastActivityAt ? Date.parse(lastActivityAt) : Number.NaN;
  // A chat's row stays `running` between turns, so the row status says nothing
  // about whether it is busy; `chatCanBeJudged` reads that from the chat itself.
  return isChatToolType(session.toolType)
    && !session.archivedAt
    && !session.settledAt
    && session.settleOverride == null
    && !session.attentionRequestedAt
    && !session.pendingInputItemId
    && !session.lastTurnFailedAt
    && !(session.snoozedUntil && Date.parse(session.snoozedUntil) > nowMs)
    && Number.isFinite(lastActivityMs)
    && nowMs - lastActivityMs >= SETTLE_NUDGE_IDLE_THRESHOLD_MS;
}

function chatCanBeJudged(chat: AgentChatSessionSummary, nowMs: number): boolean {
  const lastActivityMs = Date.parse(chat.lastActivityAt);
  return (chat.status === "idle" || chat.status === "ended")
    && !chat.archivedAt
    && !chat.identityKey
    && (chat.surface ?? "work") !== "automation"
    && !(chat.spawnKind === "subagent" && chat.orchestrationParentSessionId)
    && !chat.currentTurnStartedAt
    && !chat.turnAcceptedAt
    && chat.awaitingInput !== true
    && !chat.pendingInputItemId
    && !chat.attentionRequestedAt
    && (chat.turnOpenWorkCount ?? 0) <= 0
    && (chat.activeBackgroundTaskCount ?? 0) <= 0
    && totalBackgroundWork(chat.backgroundWork) === 0
    && chat.runtimeOwnedElsewhere == null
    && Number.isFinite(lastActivityMs)
    && nowMs - lastActivityMs >= SETTLE_NUDGE_IDLE_THRESHOLD_MS;
}

export function createSettleNudgeSweep(deps: SettleNudgeSweepDeps) {
  let startupTimer: ReturnType<typeof setTimeout> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let disposed = false;

  const sweep = async (): Promise<void> => {
    if (disposed || running || !deps.jevService.status().available) return;
    running = true;
    try {
      const nowMs = Date.now();
      const candidates = deps.sessionService.list({ limit: null })
        .filter((session) => rowCanBeJudged(session, nowMs))
        .sort((a, b) => Date.parse(a.lastActivityAt ?? "") - Date.parse(b.lastActivityAt ?? ""));
      let attempted = 0;

      for (const candidate of candidates) {
        if (disposed || attempted >= SETTLE_NUDGE_MAX_CALLS_PER_SWEEP) break;

        try {
          const [chat, transcript] = await Promise.all([
            deps.agentChatService.getSessionSummary(candidate.id),
            deps.agentChatService.readTranscript(candidate.id, SETTLE_NUDGE_TRANSCRIPT_LIMIT),
          ]);
          if (!chat || !chatCanBeJudged(chat, Date.now())) continue;
          const turn = completedTurn(transcript);
          if (!turn || candidate.settleNudgeTurnId === turn.key) continue;
          if (candidate.settleNudgeDismissedTurnId === turn.key) continue;

          const userText = clipped(turn.userText, SETTLE_NUDGE_TEXT_LIMIT);
          const assistantText = clipped(turn.assistantText, SETTLE_NUDGE_TEXT_LIMIT, true);
          if (!userText || !assistantText) continue;

          attempted += 1;
          const answers = await deps.jevService.decide({
            feature: "settle_nudge",
            priority: "background",
            state: `User request:\n${userText}\n\nAssistant reply:\n${assistantText}`,
            questions: {
              done: {
                type: "noul",
                instructions: "Did the assistant finish what the user asked, with nothing left for the user to answer or decide?",
              },
            },
          });
          const probability = answers?.done?.type === "noul" ? answers.done.noul : null;
          if (probability == null || !Number.isFinite(probability)) continue;

          const [latestSession, latestChat, latestTranscript] = await Promise.all([
            Promise.resolve(deps.sessionService.get(candidate.id)),
            deps.agentChatService.getSessionSummary(candidate.id),
            deps.agentChatService.readTranscript(candidate.id, SETTLE_NUDGE_TRANSCRIPT_LIMIT),
          ]);
          if (
            !latestSession
            || !rowCanBeJudged(latestSession, Date.now())
            || !latestChat
            || !chatCanBeJudged(latestChat, Date.now())
            || latestChat.lastActivityAt !== chat.lastActivityAt
            || completedTurn(latestTranscript)?.key !== turn.key
          ) continue;

          deps.sessionService.setSettleNudgeVerdict({
            sessionId: candidate.id,
            turnId: turn.key,
            doneProbability: probability,
            expectedTurnMarker: candidate.settleNudgeTurnId ?? null,
            expectedLastActivityAt: chat.lastActivityAt,
          });
        } catch {
          // This is a best-effort hint. A failed read or Jev call leaves the
          // normal session row and its existing settle controls alone.
        }
      }
    } catch {
      // Keep background sweep failures out of the user-facing Work surface.
    } finally {
      running = false;
    }
  };

  return {
    start(): void {
      if (disposed || startupTimer || interval) return;
      startupTimer = setTimeout(() => {
        startupTimer = null;
        void sweep();
      }, SETTLE_NUDGE_START_DELAY_MS);
      interval = setInterval(() => void sweep(), SETTLE_NUDGE_SWEEP_INTERVAL_MS);
    },
    dispose(): void {
      disposed = true;
      if (startupTimer) clearTimeout(startupTimer);
      if (interval) clearInterval(interval);
      startupTimer = null;
      interval = null;
    },
  };
}
