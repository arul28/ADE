import type { DraftEntry } from "../../../shared/types/chat";
import type { Logger } from "../logging/logger";
import type { DraftDeliveryOutcome } from "./draftDelivery";

export type DraftSchedulerTimerApi = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type DraftSchedulerOptions = {
  /** Armed sends that are due on this machine, oldest fire time first. */
  dueNow: (nowMs: number) => DraftEntry[];
  /** The soonest pending fire time this machine still has to wake for. */
  nextFireAt: (nowMs: number) => number | null;
  deliver: (draft: DraftEntry) => Promise<DraftDeliveryOutcome>;
  /** Persist the outcome. Must be durable before the next tick arms. */
  onOutcome: (draft: DraftEntry, outcome: DraftDeliveryOutcome) => void | Promise<void>;
  logger: Pick<Logger, "warn" | "info">;
  now?: () => number;
  timers?: DraftSchedulerTimerApi;
  /** How long to wait before retrying a send that could not go out. */
  retryDelayMs?: number;
  /** How often to re-check for a send another machine synced in. */
  sweepMs?: number;
};

export type DraftScheduler = {
  start(): void;
  stop(): void;
  /** Re-arm after the drafts table changed through this machine. */
  refresh(): void;
  /** Run the due sends now; resolves once they have all been attempted. */
  runDueNow(): Promise<void>;
};

const DEFAULT_RETRY_DELAY_MS = 60_000;
const DEFAULT_SWEEP_MS = 5 * 60_000;

/**
 * Fires scheduled sends on the machine that owns their target chat.
 *
 * The database is the only state: there is no schedule file to drift from it.
 * Every tick re-reads what is due, so a restart, a sync from another machine,
 * or an edit made in the composer all take effect on the next arm without any
 * bookkeeping to keep in step.
 */
export function createDraftScheduler(options: DraftSchedulerOptions): DraftScheduler {
  const now = options.now ?? (() => Date.now());
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const sweepMs = Math.max(1_000, options.sweepMs ?? DEFAULT_SWEEP_MS);
  const timers: DraftSchedulerTimerApi = options.timers ?? {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };

  let handle: unknown = null;
  let stopped = false;
  let ticking = false;

  const clearTimer = () => {
    if (handle == null) return;
    timers.clearTimeout(handle);
    handle = null;
  };

  const arm = () => {
    clearTimer();
    if (stopped) return;
    const nowMs = now();
    const nextFireAt = options.nextFireAt(nowMs);
    let delayMs: number;
    if (nextFireAt == null) {
      // Nothing is armed anywhere near this machine; wake up periodically so a
      // send synced in from another computer still gets picked up.
      delayMs = sweepMs;
    } else {
      const untilNext = nextFireAt - nowMs;
      // A fire time already in the past means the row is still due — it could
      // not be delivered and is waiting to retry. Without this floor the timer
      // would re-arm at zero forever.
      delayMs = untilNext <= 0 ? retryDelayMs : Math.min(untilNext, sweepMs);
    }
    handle = timers.setTimeout(() => { void tick(); }, delayMs);
  };

  const tick = async () => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const nowMs = now();
      for (const draft of options.dueNow(nowMs)) {
        if (stopped) break;
        let outcome: DraftDeliveryOutcome;
        try {
          outcome = await options.deliver(draft);
        } catch (error) {
          // deliver() is not supposed to throw, but a scheduler that dies on
          // one bad row stops firing every other send.
          const message = error instanceof Error ? error.message : String(error);
          options.logger.warn("draft.scheduler_deliver_threw", { draftId: draft.id, message });
          outcome = { status: "retry", error: message };
        }
        try {
          await options.onOutcome(draft, outcome);
        } catch (error) {
          options.logger.warn("draft.scheduler_persist_failed", {
            draftId: draft.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      ticking = false;
      arm();
    }
  };

  return {
    start: () => {
      stopped = false;
      // Deliver anything that came due while the app was closed before arming.
      void tick();
    },
    stop: () => {
      stopped = true;
      clearTimer();
    },
    refresh: () => {
      if (stopped) return;
      arm();
    },
    runDueNow: async () => {
      await tick();
    },
  };
}
