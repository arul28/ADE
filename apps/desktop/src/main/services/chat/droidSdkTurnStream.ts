import {
  isDroidCompactingState,
  type DroidSdkContextStats,
  type DroidSdkTokenUsage,
} from "./droidSdkProtocol";
import { asRecord, settleWithin } from "../shared/utils";

/** How long a finished mission worker's usage read may hold the stream. */
const WORKER_USAGE_READ_DEADLINE_MS = 500;

export type DroidSdkTurnStreamOutcome = {
  tokenUsage: unknown;
  firstError: unknown;
  resultSuccess: boolean;
  /**
   * Settles once every context sample this turn started has been posted. The
   * worker never waits on it; tests do.
   */
  contextSamples: Promise<void>;
};

/**
 * Forwards one Droid turn's stream to the host and collects its run result.
 *
 * Context telemetry never holds the stream or the result. Each
 * `droid.get_context_stats` read starts in the background and posts its sample
 * as a trailing `context_stats` event, so `done` never waits on the read and a
 * Stop after the stream ends cannot land inside it. The reads are chained, so
 * samples post in the order they were taken. The sample taken when compaction
 * starts is tagged `phase: "compaction_start"`: the mapper keeps it as the
 * compaction's pre-size instead of moving the meter off "compacting". Every
 * sample carries the send's `turnId`, because a trailing one can land after the
 * next turn started and must stay labelled with the turn it measured.
 *
 * A finished mission worker's usage read holds the stream for at most
 * `workerUsageDeadlineMs`; a slow read posts the event without usage.
 */
export async function consumeDroidSdkTurnStream(args: {
  stream: AsyncIterable<unknown>;
  postSdkEvent: (event: unknown) => void;
  readContextStats: () => Promise<DroidSdkContextStats | null>;
  readWorkerTokenUsage: (workerSessionId: string) => Promise<DroidSdkTokenUsage | null>;
  /** The host's turn id for this send, stamped on every `context_stats` sample. */
  turnId?: string | null;
  workerUsageDeadlineMs?: number;
}): Promise<DroidSdkTurnStreamOutcome> {
  let tokenUsage: unknown = null;
  let firstError: unknown = null;
  let resultSuccess = true;
  let compactionActive = false;
  let contextSamples: Promise<void> = Promise.resolve();
  const turnId = args.turnId?.trim() || null;
  const sampleContext = (phase?: "compaction_start"): void => {
    contextSamples = contextSamples.then(async () => {
      const contextStats = await args.readContextStats().catch(() => null);
      if (!contextStats) return;
      args.postSdkEvent({
        type: "context_stats",
        contextStats,
        ...(phase ? { phase } : {}),
        ...(turnId ? { turnId } : {}),
      });
    });
  };

  for await (const event of args.stream) {
    const eventRecord = asRecord(event) ?? {};
    const eventType = typeof eventRecord.type === "string" ? eventRecord.type : "";
    if (eventType === "token_usage_update") tokenUsage = event;
    if (eventType === "result") {
      tokenUsage = eventRecord.tokenUsage ?? tokenUsage;
      if (eventRecord.success === false) {
        resultSuccess = false;
        // The stream's terminal `result` carries the failure cause but the
        // event mapper drops `result`, so surface the cause as an `error`
        // event (the turn still ends failed) or users lose the provider text.
        if (eventRecord.error && firstError == null) {
          firstError = eventRecord.error;
          args.postSdkEvent(eventRecord.error);
        }
      }
    }
    if (eventType === "error" && firstError == null) firstError = event;

    let eventForPost: unknown = event;
    if (eventType === "working_state_changed") {
      const compacting = isDroidCompactingState(typeof eventRecord.state === "string" ? eventRecord.state : null);
      if (compacting && !compactionActive) {
        compactionActive = true;
        sampleContext("compaction_start");
      } else if (!compacting && compactionActive) {
        compactionActive = false;
        sampleContext();
      }
    } else if (eventType === "mission_worker_completed") {
      const workerSessionId = typeof eventRecord.workerSessionId === "string"
        ? eventRecord.workerSessionId
        : "";
      const workerUsage = workerSessionId
        ? await settleWithin(
          Promise.resolve().then(() => args.readWorkerTokenUsage(workerSessionId)),
          args.workerUsageDeadlineMs ?? WORKER_USAGE_READ_DEADLINE_MS,
          null,
        )
        : null;
      if (workerUsage) eventForPost = { ...eventRecord, tokenUsage: workerUsage };
    }
    args.postSdkEvent(eventForPost);
  }
  // A terminal result can arrive without the idle notification; close the
  // compaction lifecycle so the mapper does not leave it open.
  if (compactionActive) args.postSdkEvent({ type: "working_state_changed", state: "idle" });
  sampleContext();
  return { tokenUsage, firstError, resultSuccess, contextSamples };
}
