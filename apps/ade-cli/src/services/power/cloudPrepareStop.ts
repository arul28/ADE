/**
 * The step before a computer stops at 0 hours, sleeps on the person's Sleep,
 * or is deleted by the server (`ade cloud prepare-stop`): interrupt running
 * chat turns and agent CLIs, then write the saved chat copy and each lane's
 * backup, so the stop that follows loses nothing a save could keep. Nothing
 * is committed or pushed.
 *
 * Each chat whose turn it stops is marked (`noteCloudChatStoppedForRest`), so
 * its saved row reads Stopped, not Done, while the computer rests. Before a
 * delete (`forDelete`), the computer also freezes new work from the start
 * (`cloudDeleteFreeze.ts`), and lifts the freeze again when the prepare is
 * not confirmed, because then the server keeps the computer. Before the
 * person's Sleep (`forSleep`) it freezes new work the same way, for a short
 * time: the server counts the lanes' backups for a move with no wake only
 * when no work could start after them (`frozen`).
 */

import type { CloudBackupSaveSummary } from "../../../../account-directory/src/cloud/contract";
import type { AdeRuntime } from "../../bootstrap";
import { noteCloudChatStoppedForRest, uploadPendingCloudChats } from "../cloudChats/cloudChatUploader";
import { CLOUD_SLEEP_FREEZE_AFTER_PREPARE_MS, cloudFreezeHolds, freezeCloudComputerForDelete, freezeCloudComputerForSleep, liftCloudDeleteFreeze, liftCloudSleepFreeze } from "./cloudDeleteFreeze";

const POLL_MS = 400;
/** Held back from the timeout for writing the chat copy. */
const FLUSH_RESERVE_MS = 12_000;

export type CloudPrepareStopResult = {
  interruptedChats: number;
  interruptedClis: number;
  /** Chats still running a turn when the time ran out. */
  stillRunning: number;
  chatsUploaded: number;
  chatsNotUploaded: number;
  /** Shell and CLI copies and Git summaries saved after the chats (`cloudRestSave.ts`); 0 when no time was left. */
  sessionsSaved: number;
  gitSaved: number;
  /** The lane backups of the save (`cloudLaneBackup.ts`): the server's 0-hours stop rests the computer with them when `current`. */
  backups: CloudBackupSaveSummary | null;
  timedOut: boolean;
  /** A prepare for a delete or the person's Sleep: new work stays refused after it (`cloudDeleteFreeze.ts`). False when not asked, or not confirmed. */
  frozen: boolean;
};

/** The same rule as the server's `prepareConfirmed`: the turns ended and every chat is saved, in time. */
function prepareConfirmed(result: Pick<CloudPrepareStopResult, "stillRunning" | "chatsNotUploaded" | "timedOut">): boolean {
  return result.stillRunning === 0 && result.chatsNotUploaded === 0 && !result.timedOut;
}

function stillBusy(runtimes: readonly AdeRuntime[]): number {
  return runtimes.reduce((total, runtime) => total + (runtime.agentChatService?.listBusyFacts?.().length ?? 0), 0);
}

export async function prepareCloudComputerToStop(args: {
  runtimes: readonly AdeRuntime[];
  timeoutMs: number;
  logger?: { info(event: string, data?: unknown): void; warn(event: string, data?: unknown): void };
  /** A disk grow's restart: the turns keep running (they continue after it), only the chat copy is written. */
  keepTurns?: boolean;
  /** The rest save (capsules too), in the time left after the chats (`cloudRestSave.ts`). */
  saveForRest?: (budgetMs: number) => Promise<{ sessions: number; git: number; backups?: CloudBackupSaveSummary | null }>;
  /** The server deletes the computer next: freeze new work until then (`cloudDeleteFreeze.ts`). */
  forDelete?: boolean;
  /** The person's Sleep comes next: freeze new work until it (a short freeze, `cloudDeleteFreeze.ts`). */
  forSleep?: boolean;
}): Promise<CloudPrepareStopResult> {
  const forSleep = args.forSleep === true && !args.forDelete;
  // First, so no new turn or terminal starts between the interrupts and the save.
  if (args.forDelete) freezeCloudComputerForDelete();
  // The prepare's own time, then the time the server takes to sleep it once the prepare answers.
  if (forSleep) freezeCloudComputerForSleep(Date.now(), Math.max(1_000, args.timeoutMs) + CLOUD_SLEEP_FREEZE_AFTER_PREPARE_MS);
  const lift = () => {
    if (args.forDelete) liftCloudDeleteFreeze();
    if (forSleep) liftCloudSleepFreeze();
  };
  try {
    const prepared = await prepare({ ...args, forSleep });
    // Frozen means no work could start after the save: not when the freeze ran out (or was lifted) before the save ended.
    const result = prepared.frozen && !cloudFreezeHolds(args.forDelete ? "delete" : "sleep") ? { ...prepared, frozen: false } : prepared;
    if ((args.forDelete || forSleep) && !result.frozen) lift();
    // Counted from the answer, so a prepare that ran long still covers the sleep that follows.
    else if (forSleep) freezeCloudComputerForSleep();
    args.logger?.info("cloud.prepare_stop", result);
    return result;
  } catch (error) {
    // The server reads a failed prepare as "keep the computer": nothing stays frozen.
    lift();
    throw error;
  }
}

async function prepare(args: Parameters<typeof prepareCloudComputerToStop>[0]): Promise<CloudPrepareStopResult> {
  const deadline = Date.now() + Math.max(1_000, args.timeoutMs);
  const counts: Array<{ chats: number; clis: number }> = args.keepTurns ? [] : await Promise.all(args.runtimes.map(async (runtime) => {
    // Each chat is marked before its stop, so the upload its end starts already reads Stopped.
    const chats = await runtime.agentChatService?.interruptRunningTurns?.({ onStopping: noteCloudChatStoppedForRest }).catch((error: unknown) => {
      args.logger?.warn("cloud.prepare_stop_chats_failed", { error: error instanceof Error ? error.message : String(error) });
      return 0;
    }) ?? 0;
    return { chats, clis: runtime.ptyService.interruptAgentClis?.() ?? 0 };
  }));
  const interruptedChats = counts.reduce((total, count) => total + count.chats, 0);
  const interruptedClis = counts.reduce((total, count) => total + count.clis, 0);

  // Turns take a moment to wind down and record that they were stopped.
  const waitUntil = deadline - FLUSH_RESERVE_MS;
  while (!args.keepTurns && stillBusy(args.runtimes) > 0 && Date.now() < waitUntil) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  // Kept turns run on through the restart by design: they aren't left over.
  const remaining = args.keepTurns ? 0 : stillBusy(args.runtimes);

  const flushMs = Math.max(2_000, deadline - Date.now());
  const flush = await uploadPendingCloudChats(flushMs).catch((error: unknown) => {
    args.logger?.warn("cloud.prepare_stop_flush_failed", { error: error instanceof Error ? error.message : String(error) });
    return { uploaded: 0, remaining: -1, timedOut: true };
  });
  // The stop is "prepared" when the turns ended and the chats are saved, in time.
  // The rest save below reports its own outcome (`backups`), so its time doesn't count.
  const chatsLate = Date.now() >= deadline;
  // Lane backups, copies and Git summaries only with real time left: the chats come first.
  const restMs = deadline - Date.now();
  const rest: { sessions: number; git: number; backups?: CloudBackupSaveSummary | null } = args.saveForRest && restMs > 3_000
    ? await args.saveForRest(restMs - 1_000).catch((error: unknown) => {
        args.logger?.warn("cloud.prepare_stop_rest_save_failed", { error: error instanceof Error ? error.message : String(error) });
        return { sessions: 0, git: 0, backups: null };
      })
    : { sessions: 0, git: 0, backups: null };
  const counted = {
    stillRunning: remaining,
    chatsNotUploaded: flush.remaining < 0 ? 0 : flush.remaining,
    timedOut: remaining > 0 || flush.timedOut || chatsLate,
  };
  return {
    interruptedChats,
    interruptedClis,
    ...counted,
    chatsUploaded: flush.uploaded,
    sessionsSaved: rest.sessions,
    gitSaved: rest.git,
    backups: rest.backups ?? null,
    frozen: (args.forDelete === true || args.forSleep === true) && prepareConfirmed(counted),
  };
}
