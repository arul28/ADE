import type {
  AgentChatIdentityKey,
  AgentChatSession,
  AgentChatSessionTurnHealth,
  CtoThreadHealth,
} from "../../../shared/types/chat";
import { shouldAdviseSessionRotation } from "./sessionTurnHealth";

/**
 * The way out of an identity thread that is finished.
 *
 * A single project-level CTO thread is the right default and it has one failure
 * mode: it fills up, and then every turn fails with "prompt is too long" while
 * the fallback compaction answers that the conversation cannot be reduced. This
 * module is the read-only health verdict, the hand-off distillation, and the
 * rotation that retires the thread and opens a clean one.
 *
 * It takes its world through an injected deps bag — the same shape
 * `claudeReplayOverflowRecovery.ts` uses — so the policy is readable and
 * testable without standing up the provider graph. `agentChatService` keeps
 * thin closures over it, because these four are part of its public surface.
 */

export type IdentityHandoff = {
  written: boolean;
  thin: boolean;
  source: "model" | "deterministic" | "none";
};

export type IdentityHandoffDistillation = {
  text: string;
  source: "model" | "deterministic";
  /** True when the distillation found nothing readable to summarize. */
  thin: boolean;
};

export type IdentityThreadRotationDeps<TManaged> = {
  logger: {
    info: (event: string, meta?: Record<string, unknown>) => void;
    warn: (event: string, meta?: Record<string, unknown>) => void;
  };
  nowIso: () => string;
  /** Resolve (and adopt) the managed handle for a session id. */
  ensureManagedSession: (sessionId: string) => TManaged;
  /** Identity sessions, newest activity first. */
  listIdentitySessions: (
    identityKey: AgentChatIdentityKey,
  ) => Promise<ReadonlyArray<{ sessionId: string }>>;
  describeSession: (managed: TManaged) => {
    id: string;
    status: AgentChatSession["status"];
    /** The session summary, or the live preview when no summary exists yet. */
    summaryOrPreview: string;
  };
  readTurnHealthRecord: (managed: TManaged) => {
    failure: AgentChatSessionTurnHealth["lastTurnFailure"];
    context: AgentChatSessionTurnHealth["context"];
  };
  /** The user's own messages on this thread, oldest first. */
  listUserMessages: (managed: TManaged) => string[];
  /** One line per still-armed scheduled job on this thread. */
  listScheduledWorkLines: (managed: TManaged) => string[];
  runSessionTurn: (args: {
    sessionId: string;
    text: string;
    displayText: string;
    timeoutMs: number;
  }) => Promise<{ status: string; outputText: string }>;
  /** The deterministic continuity flush a compaction also runs. */
  flushContinuity: (managed: TManaged, reason: "session_rotation") => void;
  /** Store the distilled note as the thread's rolling summary. */
  writeContinuitySummary: (managed: TManaged, summary: string) => void;
  /** Mirror the note into the CTO's durable thread state. */
  writeThreadState: (managed: TManaged, summary: string, reason: string) => void;
  /** Durable memory writes, absent when no memory service is wired. */
  memory: {
    appendDailyEntry: (line: string) => void;
    appendMemoryFact: (line: string) => void;
  } | null;
  /**
   * Is a turn running on this thread right now — foreground or background?
   *
   * Injected rather than derived from `describeSession().status`, because the
   * session row only knows about a foreground turn: a Claude background task or
   * a Codex turn still awaiting its start edge is just as live, and disposing
   * under one loses the same work.
   */
  isTurnActive: (managed: TManaged) => boolean;
  dispose: (args: { sessionId: string }) => Promise<unknown>;
  ensureIdentitySession: (args: {
    identityKey: AgentChatIdentityKey;
    laneId: string;
    reuseExisting: boolean;
  }) => Promise<AgentChatSession>;
};

/**
 * One hand-off line, clipped so a distillation cannot grow without bound.
 *
 * Pure, three lines, and used by nothing outside this module — it was an
 * injected dep, which made the deps bag describe a formatting detail instead
 * of the world this module cannot see for itself.
 */
function clipHandoffLine(value: string, maxChars = 200): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

/**
 * The sentence the user reads when a rotation arrives mid-answer.
 *
 * Lives next to the refusal rather than in the settings page because every
 * entry point — the settings card, the IPC bridge, `cto_state.startFreshSession`
 * — surfaces the thrown message verbatim, so one string keeps them in step.
 */
export const IDENTITY_ROTATION_TURN_ACTIVE_MESSAGE =
  "Wait for the current answer to finish, then try again.";

/**
 * Refusal to retire a thread that is still working.
 *
 * Coded so a caller can tell "you asked at a bad moment" from "the rotation
 * broke", and carrying its own user-facing message because the callers that
 * already propagate a thrown error need no new mapping to show it.
 */
export class IdentityRotationTurnActiveError extends Error {
  readonly code = "turn-active" as const;

  constructor() {
    super(IDENTITY_ROTATION_TURN_ACTIVE_MESSAGE);
    this.name = "IdentityRotationTurnActiveError";
  }
}

export function isIdentityRotationTurnActiveError(error: unknown): boolean {
  return error instanceof IdentityRotationTurnActiveError;
}

export function createIdentityThreadRotation<TManaged>(
  deps: IdentityThreadRotationDeps<TManaged>,
) {
  /**
   * Can this chat take another turn, and is it close to the edge?
   *
   * Read-only and cheap on purpose — it reads the session's own persisted
   * bookkeeping rather than asking a provider anything, so the CTO voice
   * pre-flight can call it on every Talk without opening a query, and the
   * answer survives a restart the way the problem it describes does.
   */
  const getSessionTurnHealth = ({ sessionId }: { sessionId: string }): AgentChatSessionTurnHealth => {
    const managed = deps.ensureManagedSession(sessionId);
    const { failure, context } = deps.readTurnHealthRecord(managed);
    return {
      sessionId: deps.describeSession(managed).id,
      // Only the overflow verdict blocks: one failed turn is bad luck, a
      // conversation that no longer fits is a property of the thread.
      canTakeTurn: failure?.kind !== "context_overflow",
      blockedReason: failure?.kind === "context_overflow" ? "context_overflow" : null,
      lastTurnFailure: failure,
      context,
      rotationAdvised: shouldAdviseSessionRotation(failure, context),
    };
  };

  /**
   * The CTO thread's health, without creating one.
   *
   * Strictly read-only for the same reason `getCtoAttention` is: the CTO page
   * polls this to decide whether to OFFER a fresh thread, and materializing a
   * lane and a chat session as a side effect of drawing a banner would be a
   * side effect nobody asked for.
   */
  const getCtoThreadHealth = async (): Promise<CtoThreadHealth> => {
    const empty: CtoThreadHealth = {
      sessionId: null,
      canTakeTurn: true,
      blockedReason: null,
      lastTurnFailure: null,
      context: null,
      rotationAdvised: false,
    };
    try {
      const cto = (await deps.listIdentitySessions("cto"))[0];
      if (!cto) return empty;
      return getSessionTurnHealth({ sessionId: cto.sessionId });
    } catch (error) {
      deps.logger.warn("agent_chat.cto_thread_health_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return empty;
    }
  };

  /**
   * What the outgoing thread knew, written down before it is retired.
   *
   * A fresh thread with no hand-off is an amnesiac one, and the case this
   * exists for is exactly the case where the CTO cannot be ASKED to summarize
   * itself: a conversation over its context limit cannot take the turn that
   * would write the summary. So there are two paths and the deterministic one
   * is not a fallback in the apologetic sense — it is the one that has to work.
   */
  const distilIdentityHandoff = async (managed: TManaged): Promise<IdentityHandoffDistillation> => {
    // Deterministic first, always. Every line of it comes from something
    // already on disk, so it works on a thread that cannot think — and a thread
    // with nothing in it at all needs no model round-trip to tell us so.
    const described = deps.describeSession(managed);
    const summary = described.summaryOrPreview.trim();
    const recent = deps.listUserMessages(managed)
      .slice(-8)
      .map((text) => `- ${clipHandoffLine(text)}`);
    const scheduled = deps.listScheduledWorkLines(managed)
      .slice(0, 8)
      .map((line) => `- ${clipHandoffLine(line)}`);
    const sections: string[] = [];
    if (summary.length) sections.push(`Where it left off: ${clipHandoffLine(summary, 400)}`);
    if (recent.length) sections.push(["What was asked, most recent last:", ...recent].join("\n"));
    if (scheduled.length) sections.push(["Work still scheduled on this thread:", ...scheduled].join("\n"));

    // Ask the CTO itself only when there is something to summarize AND the
    // thread can still take a turn. The case this whole routine exists for —
    // a conversation over its context limit — can do neither.
    const health = getSessionTurnHealth({ sessionId: described.id });
    if (sections.length && health.canTakeTurn && described.status !== "active") {
      try {
        const asked = await deps.runSessionTurn({
          sessionId: described.id,
          text: [
            "[ade] This conversation is about to be retired and replaced by a fresh one.",
            "Write the hand-off note your next self will read. Plain prose, no markdown headings, at most 12 lines:",
            "what we were working on, the decisions already made, what is still open, and anything you were told to remember.",
            "Write only the note.",
          ].join("\n"),
          displayText: "Write your hand-off note before this thread is retired.",
          timeoutMs: 120_000,
        });
        const text = asked.status === "completed" ? asked.outputText.trim() : "";
        if (text.length) return { text, source: "model", thin: false };
      } catch (error) {
        deps.logger.warn("agent_chat.identity_handoff_turn_failed", {
          sessionId: described.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const thin = sections.length === 0;
    if (thin) {
      // Never silently skipped: an empty hand-off says so, and says where the
      // conversation still is.
      sections.push(
        "This thread could not be summarized: nothing readable was left in its recent history — it may have been over its context limit. Its full transcript is still on disk under the retired session.",
      );
    }
    return { text: sections.join("\n\n"), source: "deterministic", thin };
  };

  /**
   * Retire the current identity thread and start a clean one.
   *
   * Deliberately not automatic and deliberately not destructive: the outgoing
   * conversation is distilled into durable memory, appended to the daily log,
   * flushed through the same continuity routine a compaction uses, and then
   * ENDED — which is what puts it in History with its turn count, transcript
   * and all. Identity, memory, daily log and project state are untouched. Only
   * the conversation starts over.
   *
   * Refuses while a turn is running. Every entry point here — the settings
   * card, the IPC bridge, `cto_state.startFreshSession` — can be reached
   * mid-stream, and disposing then throws away an answer the user is watching
   * arrive, with nothing to show for it. `force` exists for the one caller that
   * knows better; the over-limit path does not even need it, because a thread
   * that cannot take a turn has no live turn to lose.
   */
  const startFreshIdentitySession = async (args: {
    identityKey: AgentChatIdentityKey;
    laneId: string;
    force?: boolean;
  }): Promise<{
    session: AgentChatSession;
    previousSessionId: string | null;
    handoff: IdentityHandoff;
  }> => {
    const existing = (await deps.listIdentitySessions(args.identityKey))[0] ?? null;
    let handoff: IdentityHandoff = { written: false, thin: false, source: "none" };

    if (existing) {
      const managed = deps.ensureManagedSession(existing.sessionId);
      if (!args.force && deps.isTurnActive(managed)) {
        // A thread blocked on context overflow reports an active turn it can
        // never finish — that is the case rotation exists for, so it goes
        // through. Anything else is work in flight, and the user can wait.
        const canFinish = getSessionTurnHealth({ sessionId: existing.sessionId }).canTakeTurn;
        if (canFinish) {
          deps.logger.info("agent_chat.identity_rotation_refused_turn_active", {
            identityKey: args.identityKey,
            sessionId: existing.sessionId,
          });
          throw new IdentityRotationTurnActiveError();
        }
      }
      try {
        const distilled = await distilIdentityHandoff(managed);
        // The same routine a compaction runs, for the same reason: the rolling
        // summary and `thread-state.md` are what the NEXT thread reads first.
        deps.flushContinuity(managed, "session_rotation");
        deps.writeContinuitySummary(managed, distilled.text);
        deps.writeThreadState(managed, distilled.text, "session_rotation");
        if (args.identityKey === "cto" && deps.memory) {
          const stamp = deps.nowIso().slice(0, 10);
          deps.memory.appendDailyEntry(
            `Thread retired (${existing.sessionId}) and a fresh CTO session started${distilled.thin ? " — hand-off was thin; see the retired transcript" : ""}.`,
          );
          deps.memory.appendMemoryFact(
            `${stamp} hand-off from retired CTO thread ${existing.sessionId}: ${distilled.text}`,
          );
        }
        handoff = { written: true, thin: distilled.thin, source: distilled.source };
      } catch (error) {
        // A hand-off that could not be written must not strand the user on a
        // thread that cannot answer — the rotation still happens, and the
        // transcript is still on disk.
        deps.logger.warn("agent_chat.identity_handoff_write_failed", {
          sessionId: existing.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        await deps.dispose({ sessionId: existing.sessionId });
      } catch (error) {
        deps.logger.warn("agent_chat.identity_rotation_dispose_failed", {
          sessionId: existing.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const session = await deps.ensureIdentitySession({
      identityKey: args.identityKey,
      laneId: args.laneId,
      reuseExisting: false,
    });
    deps.logger.info("agent_chat.identity_session_rotated", {
      identityKey: args.identityKey,
      previousSessionId: existing?.sessionId ?? null,
      sessionId: session.id,
      handoffSource: handoff.source,
      handoffThin: handoff.thin,
    });
    return { session, previousSessionId: existing?.sessionId ?? null, handoff };
  };

  return {
    getSessionTurnHealth,
    getCtoThreadHealth,
    distilIdentityHandoff,
    startFreshIdentitySession,
  };
}
