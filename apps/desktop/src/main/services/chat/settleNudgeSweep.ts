import type { AgentChatSessionSummary, AgentChatTranscriptEntry } from "../../../shared/types/chat";
import type { JevService } from "../jev/jevService";
import type { TerminalSessionSummary } from "../../../shared/types/sessions";
import { totalBackgroundWork } from "../../../shared/sessionCanonicalState";
import { isChatToolType } from "../../../shared/sessionSpawnNesting";
import type { createSessionService } from "../sessions/sessionService";
import type { AgentChatService } from "./agentChatService";
import { clipHead, clipTail } from "../shared/utils";

export const SETTLE_NUDGE_IDLE_THRESHOLD_MS = 3 * 60 * 60 * 1000;
const SETTLE_NUDGE_SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const SETTLE_NUDGE_START_DELAY_MS = 15 * 1000;
/** How often the setting is re-read: switching it runs a sweep then, not at the next half hour. */
const SETTLE_NUDGE_SETTING_CHECK_MS = 60 * 1000;
const SETTLE_NUDGE_MAX_CALLS_PER_SWEEP = 10;
const SETTLE_NUDGE_TRANSCRIPT_LIMIT = 200;
const SETTLE_NUDGE_TEXT_LIMIT = 1_500;

export type SettleNudgeSweepDeps = {
  sessionService: Pick<ReturnType<typeof createSessionService>, "list" | "get" | "setSettleNudgeVerdict">;
  agentChatService: Pick<AgentChatService, "getSessionSummary" | "readTranscript">;
  jevService: Pick<JevService, "decide" | "status">;
  /** Settings › Smart decisions: the master switch and "Settle finished chats". Read per sweep. */
  isEnabled: () => boolean;
};

type CompletedTurn = {
  key: string;
  userText: string;
  assistantText: string;
  /** When the reply landed. Read from the transcript, so a brain restart does not move it. */
  endedAt: string;
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
  return { key, userText: user.text, assistantText: assistant.text, endedAt: assistant.timestamp };
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ");

/** The turn of a stored verdict the row could still show; a dismissed or pending one shows nothing. */
function showableVerdictTurnId(session: TerminalSessionSummary): string | null {
  const turnId = session.settleNudgeTurnId;
  if (!turnId || turnId.startsWith("pending:")) return null;
  if ((session.settleNudgeDoneProbability ?? 0) <= 0) return null;
  return session.settleNudgeDismissedTurnId === turnId ? null : turnId;
}

/** A turn that printed nothing leaves `last_output_at` empty; the row's own start or end stands in. */
function rowIdleSince(session: TerminalSessionSummary): string | null {
  return session.lastActivityAt ?? session.endedAt ?? session.startedAt ?? null;
}

function idleLongEnough(at: string | null | undefined, nowMs: number): boolean {
  const atMs = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(atMs) && nowMs - atMs >= SETTLE_NUDGE_IDLE_THRESHOLD_MS;
}

function rowCanBeJudged(session: TerminalSessionSummary, nowMs: number): boolean {
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
    && idleLongEnough(rowIdleSince(session), nowMs);
}

/**
 * Whether the chat is quiet. How long it has been quiet comes from the turn
 * itself (`CompletedTurn.endedAt`): the summary's `lastActivityAt` is rewritten
 * when a brain restarts, which would push every nudge back by the threshold.
 */
function chatCanBeJudged(chat: AgentChatSessionSummary): boolean {
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
    && chat.runtimeOwnedElsewhere == null;
}

export function createSettleNudgeSweep(deps: SettleNudgeSweepDeps) {
  let startupTimer: ReturnType<typeof setTimeout> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let settingWatch: ReturnType<typeof setInterval> | null = null;
  let lastEnabled: boolean | null = null;
  let running = false;
  let disposed = false;

  /**
   * Asks Jev about one row's last turn and stores its answer, only while that
   * turn is still the chat's latest and nothing moved meanwhile. `countCall`
   * runs just before the Jev call, which counts against the sweep's cap.
   */
  const judgeCandidate = async (candidate: TerminalSessionSummary, countCall: () => void): Promise<void> => {
    const [chat, transcript] = await Promise.all([
      deps.agentChatService.getSessionSummary(candidate.id),
      deps.agentChatService.readTranscript(candidate.id, SETTLE_NUDGE_TRANSCRIPT_LIMIT),
    ]);
    if (!chat || !chatCanBeJudged(chat)) return;
    const turn = completedTurn(transcript);
    if (!turn || !idleLongEnough(turn.endedAt, Date.now())) return;
    // Exactly 0 is a verdict hidden while the setting was off, never one of
    // Jev's answers: judge that turn again now that the setting is back on.
    if (candidate.settleNudgeTurnId === turn.key && candidate.settleNudgeDoneProbability !== 0) return;
    if (candidate.settleNudgeDismissedTurnId === turn.key) return;

    // One line each, at most `SETTLE_NUDGE_TEXT_LIMIT` characters with the ellipsis.
    const userText = clipHead(oneLine(turn.userText), SETTLE_NUDGE_TEXT_LIMIT, { ellipsisCounts: true });
    const assistantText = clipTail(oneLine(turn.assistantText), SETTLE_NUDGE_TEXT_LIMIT, { ellipsisCounts: true });
    if (!userText || !assistantText) return;

    countCall();
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
    if (probability == null || !Number.isFinite(probability)) return;

    const [latestSession, latestChat, latestTranscript] = await Promise.all([
      Promise.resolve(deps.sessionService.get(candidate.id)),
      deps.agentChatService.getSessionSummary(candidate.id),
      deps.agentChatService.readTranscript(candidate.id, SETTLE_NUDGE_TRANSCRIPT_LIMIT),
    ]);
    if (
      !latestSession
      || !rowCanBeJudged(latestSession, Date.now())
      || !latestChat
      || !chatCanBeJudged(latestChat)
      || latestChat.lastActivityAt !== chat.lastActivityAt
      || completedTurn(latestTranscript)?.key !== turn.key
    ) return;

    deps.sessionService.setSettleNudgeVerdict({
      sessionId: candidate.id,
      turnId: turn.key,
      doneProbability: probability,
      expectedTurnMarker: candidate.settleNudgeTurnId ?? null,
      // The row's own `last_output_at`, which the write compares against.
      expectedLastActivityAt: candidate.lastActivityAt ?? null,
    });
  };

  /**
   * With the feature switched off, no verdict may keep showing. sessionService
   * has no clear call, so this overwrites each shown one with a 0 "done"
   * answer for the same turn, under the same compare-and-set as a new verdict.
   */
  const hideStoredVerdicts = async (): Promise<void> => {
    for (const session of deps.sessionService.list({ limit: null })) {
      if (disposed) return;
      const turnId = showableVerdictTurnId(session);
      if (!turnId) continue;
      try {
        // The setting is this machine's: a chat another machine runs keeps
        // the verdict that machine wrote.
        const chat = await deps.agentChatService.getSessionSummary(session.id);
        if (!chat || chat.runtimeOwnedElsewhere != null) continue;
        deps.sessionService.setSettleNudgeVerdict({
          sessionId: session.id,
          turnId,
          doneProbability: 0,
          expectedTurnMarker: turnId,
          expectedLastActivityAt: session.lastActivityAt ?? null,
        });
      } catch {
        // Best effort, like the verdict itself; the next sweep tries again.
      }
    }
  };

  const sweep = async (): Promise<void> => {
    if (disposed || running) return;
    running = true;
    try {
      if (!deps.isEnabled()) {
        await hideStoredVerdicts();
        return;
      }
      // Nothing can answer (free allowance and ADE's key both spent): skip the
      // run rather than ask every idle chat again and count each as a fallback.
      const jev = deps.jevService.status();
      if (!jev.available || !jev.answerable) return;
      const nowMs = Date.now();
      const candidates = deps.sessionService.list({ limit: null })
        .filter((session) => rowCanBeJudged(session, nowMs))
        .sort((a, b) => Date.parse(rowIdleSince(a) ?? "") - Date.parse(rowIdleSince(b) ?? ""));
      let attempted = 0;

      for (const candidate of candidates) {
        if (disposed || attempted >= SETTLE_NUDGE_MAX_CALLS_PER_SWEEP) break;
        try {
          await judgeCandidate(candidate, () => { attempted += 1; });
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
      settingWatch = setInterval(() => {
        const enabled = deps.isEnabled();
        if (lastEnabled != null && enabled !== lastEnabled) {
          // A sweep already running would skip this one: try again next minute.
          if (running) return;
          void sweep();
        }
        lastEnabled = enabled;
      }, SETTLE_NUDGE_SETTING_CHECK_MS);
    },
    dispose(): void {
      disposed = true;
      if (startupTimer) clearTimeout(startupTimer);
      if (interval) clearInterval(interval);
      if (settingWatch) clearInterval(settingWatch);
      startupTimer = null;
      interval = null;
      settingWatch = null;
    },
  };
}
