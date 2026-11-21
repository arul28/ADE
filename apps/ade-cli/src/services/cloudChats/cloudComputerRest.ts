/**
 * What an ADE Cloud computer does around its rest, in one place for
 * `runServe`:
 *
 * - the save before it sleeps, stops or is deleted (`cloudRestSave.ts`), at
 *   the idle step, in `prepare-stop`, and for the server's idle cleanup
 *   (`ade cloud save-for-rest`);
 * - the queue of messages sent to its chats while it slept
 *   (`cloudChatMessageQueue.ts`), drained at start, at a wake and on the
 *   server's `ade cloud messages drain`;
 * - the person's use during the server's idle cleanup (`/use`): once the
 *   server has started the delete, remote work is refused, so nothing new
 *   is lost with the computer.
 *
 * The save and the queue are made later than this object (they need the
 * registries and the sign-in runners), and `attach` hands them in.
 */

import type { CloudBackupSaveSummary, CloudSaveForRestReport } from "../../../../account-directory/src/cloud/contract";
import { CloudApiError, type CloudApiClient } from "../../../../desktop/src/shared/cloudApiClient";
import type { CloudChatMessageQueue, CloudChatQueueDrainResult } from "./cloudChatMessageQueue";
import type { CloudRestSave } from "./cloudRestSave";

type Logger = {
  info: (event: string, meta?: Record<string, unknown>) => void;
  warn: (event: string, meta?: Record<string, unknown>) => void;
};

type HoldFor = <T>(reason: string, ttlMs: number, run: () => Promise<T>) => Promise<T>;

/** The server's idle cleanup runs on the computer for at most this long after its push or save. */
const CLEANUP_WINDOW_MS = 10 * 60_000;
/** A person's use is reported at most this often during the cleanup. */
const USE_REPORT_EVERY_MS = 30_000;
/** The person's work waits at most this long for the `/use` answer. */
const USE_REPORT_WAIT_MS = 5_000;
/** The server's drain exec gets its answer by then; the drain goes on after it. */
const DRAIN_ANSWER_MS = 25_000;
/**
 * The idle step's save, lane backups first. Three idle minutes plus this stay
 * under the provider's own 5-minute sleep; a save it cuts short is not current.
 */
const IDLE_SAVE_BUDGET_MS = 90_000;
/** The cleanup's save: inside the server's 4-minute exec, with room for the brain's start. */
const CLEANUP_SAVE_BUDGET_MS = 200_000;
const CLEANUP_SAVE_HOLD_MS = 5 * 60_000;

/** Said to a person whose work reaches the computer after the server started its delete; a later send continues the lane. */
const CLOUD_COMPUTER_DELETING_SENTENCE = "ADE Cloud is saving this lane. Send it again in a moment; it continues where it left off.";

export type CloudComputerRestDeps = {
  instanceId: string;
  /** The account server's client, as this brain's signed-in account; null signed out. */
  api: () => Promise<CloudApiClient | null>;
  logger: Logger;
  /** Holds the computer awake for one named step (`holdCloudWork`); null on a brain with no keep-awake. Read when used. */
  holdFor: () => HoldFor | null;
  now?: () => number;
};

export type CloudComputerRest = {
  attach: (parts: { save: CloudRestSave | null; queue: CloudChatMessageQueue | null }) => void;
  /**
   * The idle step's save, capsules too; stops early once someone uses the
   * computer. Answers the backup report id when every lane is saved: the
   * computer's sleep request names it, so it rests with those backups.
   */
  saveAtIdle: (stillIdle: () => boolean) => Promise<string | null>;
  /** The save in `prepare-stop`, in the time left after the chats. */
  saveBeforeStop: ((budgetMs: number) => Promise<{ sessions: number; git: number; backups: CloudBackupSaveSummary | null }>) | null;
  /** `ade cloud save-for-rest [--capsules]`: the server's idle cleanup. Every save makes capsules; the flag names the cleanup. */
  saveForCleanup: (capsules: boolean) => Promise<CloudSaveForRestReport>;
  /** One drain round, started and left to run (start, wake). */
  drain: (reason: string) => void;
  /** `ade cloud messages drain`: starts a round and answers within `DRAIN_ANSWER_MS`. */
  drainAnswer: () => Promise<Record<string, unknown>>;
  /** The server's idle cleanup claimed the computer. */
  noteCleanupStarted: () => void;
  /**
   * A person's remote work reached the computer. During the cleanup it is
   * reported (`/use`). Answers the refusal sentence once the delete started.
   */
  noteRemoteWork: () => Promise<string | null>;
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createCloudComputerRest(deps: CloudComputerRestDeps): CloudComputerRest {
  const { logger, instanceId } = deps;
  const now = deps.now ?? Date.now;
  let save: CloudRestSave | null = null;
  let queue: CloudChatMessageQueue | null = null;
  let cleanupUntil = 0;
  let lastUseReportAt = 0;
  /** The server answered `/use` with `computer_deleting`. */
  let deleting = false;

  const startDrain = (reason: string): Promise<CloudChatQueueDrainResult> | null => {
    const round = queue?.drain(reason) ?? null;
    // A round that throws (a journal write, the hold) is logged here, never left unhandled.
    void round?.catch((error: unknown) => logger.warn("cloud.chat_queue_drain_failed", { reason, error: errorText(error) }));
    return round;
  };

  /** The `/use` report. Its answer is read whenever it comes, so a slow `computer_deleting` still counts. */
  const reportUse = async (): Promise<void> => {
    const api = await deps.api().catch(() => null);
    if (!api) return;
    const call = api.recordComputerUse(instanceId).then(() => undefined, (error: unknown) => {
      if (error instanceof CloudApiError && error.code === "computer_deleting") {
        deleting = true;
        return;
      }
      logger.warn("cloud.use_report_failed", { error: errorText(error) });
    });
    await Promise.race([
      call,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, USE_REPORT_WAIT_MS);
        timer.unref?.();
      }),
    ]);
  };

  return {
    attach(parts) {
      save = parts.save;
      queue = parts.queue;
    },
    async saveAtIdle(stillIdle) {
      const saved = await save?.save({ budgetMs: IDLE_SAVE_BUDGET_MS, reason: "idle", stillIdle });
      return saved?.backups?.state === "current" ? saved.backups.reportId : null;
    },
    get saveBeforeStop() {
      const current = save;
      if (!current) return null;
      return async (budgetMs: number) => {
        const saved = await current.save({ budgetMs, reason: "prepare_stop" });
        return { sessions: saved.sessions, git: saved.git, backups: saved.backups ?? null };
      };
    },
    async saveForCleanup(capsules) {
      const current = save;
      const holdFor = deps.holdFor();
      if (!current || !holdFor) return { ok: false, capsules: 0, sessions: 0, git: 0, skipped: 0, error: "This computer can't save for rest." };
      cleanupUntil = now() + CLEANUP_WINDOW_MS;
      return await holdFor("save_for_rest", CLEANUP_SAVE_HOLD_MS, () => current.save({
        budgetMs: CLEANUP_SAVE_BUDGET_MS,
        reason: capsules ? "cleanup" : "command",
      }));
    },
    drain(reason) {
      startDrain(reason);
    },
    async drainAnswer() {
      const round = startDrain("command");
      if (!round) return { ok: false, started: false };
      return await Promise.race([
        round.then((result) => ({ ok: true, started: true, ...result }), (error: unknown) => ({ ok: false, started: true, error: errorText(error).slice(0, 200) })),
        new Promise<Record<string, unknown>>((resolve) => {
          const timer = setTimeout(() => resolve({ ok: true, started: true, running: true }), DRAIN_ANSWER_MS);
          timer.unref?.();
        }),
      ]);
    },
    noteCleanupStarted() {
      cleanupUntil = now() + CLEANUP_WINDOW_MS;
    },
    async noteRemoteWork() {
      const at = now();
      if (at >= cleanupUntil) return null;
      if (!deleting && at - lastUseReportAt > USE_REPORT_EVERY_MS) {
        lastUseReportAt = at;
        await reportUse();
      }
      return deleting ? CLOUD_COMPUTER_DELETING_SENTENCE : null;
    },
  };
}
