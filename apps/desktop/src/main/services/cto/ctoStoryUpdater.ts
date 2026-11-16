/**
 * Keeps the CTO's story so far (`ctoStory.ts`) up to date, in the background.
 *
 * One run per chat at a time; a request during a run runs once after it. A
 * run reads the transcript once, then folds up to four batches of the oldest
 * messages outside the tail, each with one call to the helper model, and only
 * ever moves the story's cursor forward. A failed or unusable answer keeps the
 * story as it was and waits before trying again (a fresh thread, `force`,
 * still tries now). The story file is re-read before each write: a move that
 * replaced it meanwhile wins.
 *
 * `agentChatService` owns the chat: it hands each run a `CtoStorySession`
 * that reads the transcript, picks the helper model and runs the prompt on
 * the chat's own account.
 */

import {
  acceptCtoStoryAnswer,
  buildCtoStoryPrompt,
  cleanCtoStoryAnswer,
  CTO_STORY_MAX_BATCHES_PER_RUN,
  CTO_STORY_RETRY_AFTER_FAILURE_MS,
  CTO_STORY_SYSTEM_PROMPT,
  CTO_STORY_TIMEOUT_MS,
  CTO_STORY_TURNS_BETWEEN_CHECKS,
  planCtoStoryFold,
  type CtoStoryEntry,
  type CtoStoryRecord,
} from "./ctoStory";

type Logger = {
  info: (event: string, meta?: Record<string, unknown>) => void;
  warn: (event: string, meta?: Record<string, unknown>) => void;
};

/** One CTO chat, as a story run sees it. */
export type CtoStorySession = {
  id: string;
  /** Closed or deleted: stop between batches. */
  isGone: () => boolean;
  /** The transcript's recent window, oldest first, with times. */
  readEntries: () => CtoStoryEntry[];
  /** The helper model for this chat, or null when there is none. */
  pickModel: () => Promise<string | null>;
  runPrompt: (args: { modelId: string; systemPrompt: string; prompt: string; timeoutMs: number }) => Promise<{ text: string | null | undefined; model?: string | null }>;
};

export type CtoStoryUpdaterArgs = {
  /** Throws when the file is there but unreadable (`CtoStoryUnreadableError`). */
  readStory: () => CtoStoryRecord | null;
  writeStory: (record: CtoStoryRecord) => void;
  /** The person's zone, for the times in the helper's prompt. */
  timeZone: () => string | null;
  logger: Logger;
  now?: () => number;
};

export type CtoStoryUpdateRequest = { force?: boolean; reason: string };

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createCtoStoryUpdater(args: CtoStoryUpdaterArgs) {
  const { logger } = args;
  const now = () => args.now?.() ?? Date.now();
  const jobs = new Map<string, Promise<void>>();
  const again = new Map<string, { force: boolean; reason: string }>();
  const turnsSinceCheck = new Map<string, number>();
  const retryAfter = new Map<string, number>();

  const sameStory = (left: CtoStoryRecord | null, right: CtoStoryRecord | null): boolean =>
    (left?.coveredThrough ?? null) === (right?.coveredThrough ?? null)
    && (left?.summary ?? null) === (right?.summary ?? null)
    && (left?.carried?.text ?? null) === (right?.carried?.text ?? null);

  const backOff = (sessionId: string): void => {
    retryAfter.set(sessionId, now() + CTO_STORY_RETRY_AFTER_FAILURE_MS);
  };

  const run = async (session: CtoStorySession, request: { force: boolean; reason: string }): Promise<void> => {
    // Off the caller's stack: the transcript read below is synchronous and
    // may be large, and a refresh calls this on the way to a send.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const sessionId = session.id;
    if (!request.force && now() < (retryAfter.get(sessionId) ?? 0)) return;
    // One transcript read per run: each batch only moves the cursor through it.
    const entries = session.readEntries();
    let modelId: string | null = null;
    for (let batch = 0; batch < CTO_STORY_MAX_BATCHES_PER_RUN; batch += 1) {
      if (session.isGone()) return;
      // An unreadable file throws: never write a fresh story over it.
      const story = args.readStory();
      const carried = story?.carried?.text.trim() ? story.carried : null;
      const plan = planCtoStoryFold({ entries, story, force: request.force });
      if (!plan && !carried) return;
      modelId ??= await session.pickModel();
      if (!modelId) {
        logger.warn("cto.story_skipped", { sessionId, reason: "no_helper_model" });
        return;
      }
      const startedAt = now();
      let answer: { text: string | null | undefined; model?: string | null };
      try {
        answer = await session.runPrompt({
          modelId,
          systemPrompt: CTO_STORY_SYSTEM_PROMPT,
          prompt: buildCtoStoryPrompt({
            previousSummary: story?.summary ?? null,
            carried,
            batch: plan?.batch ?? [],
            // After a move: the old home's turns between its story's end and
            // the ones it carried were not in the copy.
            gap: plan?.gap ?? (carried && story?.movedFrom
              ? { from: story.movedFrom.coveredThrough, to: story.movedAt ?? story.coveredThrough }
              : null),
            timeZone: args.timeZone(),
          }),
          timeoutMs: CTO_STORY_TIMEOUT_MS,
        });
      } catch (error) {
        backOff(sessionId);
        logger.warn("cto.story_update_failed", { sessionId, modelId, reason: request.reason, error: errorText(error) });
        return;
      }
      const summary = acceptCtoStoryAnswer(cleanCtoStoryAnswer(answer.text), story?.summary ?? null);
      if (!summary) {
        // A refusal or a fragment would replace the only record of what the
        // story covers, and the cursor never goes back: keep the old one.
        backOff(sessionId);
        logger.warn("cto.story_answer_rejected", { sessionId, modelId, chars: answer.text?.length ?? 0 });
        return;
      }
      if (!sameStory(args.readStory(), story)) {
        logger.info("cto.story_superseded", { sessionId });
        return;
      }
      const coveredThrough = plan?.nextCursor ?? story?.coveredThrough ?? new Date(now()).toISOString();
      args.writeStory({
        v: 1,
        summary,
        coveredThrough,
        startsAt: story?.startsAt ?? plan?.startsAt ?? coveredThrough,
        updatedAt: new Date(now()).toISOString(),
        model: answer.model ?? modelId,
        carried: null,
        ...(story?.movedAt ? { movedAt: story.movedAt } : {}),
      });
      retryAfter.delete(sessionId);
      logger.info("cto.story_updated", {
        sessionId,
        reason: request.reason,
        modelId,
        folded: plan?.batch.length ?? 0,
        carried: Boolean(carried),
        gap: Boolean(plan?.gap),
        chars: summary.length,
        durationMs: now() - startedAt,
      });
      if (!plan?.more) return;
    }
  };

  /**
   * Brings the story up to date. `force` folds whatever is outside the tail,
   * however little (a fresh thread is coming), and skips the failure wait.
   */
  const update = (session: CtoStorySession, request: CtoStoryUpdateRequest): Promise<void> => {
    const sessionId = session.id;
    const wanted = { force: request.force === true, reason: request.reason };
    const running = jobs.get(sessionId);
    if (running) {
      const queued = again.get(sessionId);
      again.set(sessionId, { force: wanted.force || queued?.force === true, reason: wanted.reason });
      return running;
    }
    const job = (async () => {
      try {
        await run(session, wanted);
      } catch (error) {
        logger.warn("cto.story_update_failed", { sessionId, reason: wanted.reason, error: errorText(error) });
      } finally {
        jobs.delete(sessionId);
        const next = again.get(sessionId);
        again.delete(sessionId);
        if (next && !session.isGone()) void update(session, next);
      }
    })();
    jobs.set(sessionId, job);
    return job;
  };

  /** After a completed turn: look at the backlog every few turns, not after every one. */
  const noteTurn = (session: CtoStorySession): void => {
    const turns = (turnsSinceCheck.get(session.id) ?? 0) + 1;
    if (turns < CTO_STORY_TURNS_BETWEEN_CHECKS) {
      turnsSinceCheck.set(session.id, turns);
      return;
    }
    turnsSinceCheck.set(session.id, 0);
    void update(session, { reason: "turns" });
  };

  return { update, noteTurn };
}

export type CtoStoryUpdater = ReturnType<typeof createCtoStoryUpdater>;
