/**
 * The step before a computer stops at 0 hours (`ade cloud prepare-stop`):
 * interrupt running chat turns and agent CLIs, then write the saved chat copy
 * and each lane's backup, so the stop that follows loses nothing a save could
 * keep. Nothing is committed or pushed.
 */

import type { CloudBackupSaveSummary } from "../../../../account-directory/src/cloud/contract";
import type { AdeRuntime } from "../../bootstrap";
import { uploadPendingCloudChats } from "../cloudChats/cloudChatUploader";

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
};

function stillBusy(runtimes: readonly AdeRuntime[]): number {
  return runtimes.reduce((total, runtime) => total + (runtime.agentChatService?.listBusyFacts?.().length ?? 0), 0);
}

export async function prepareCloudComputerToStop(args: {
  runtimes: readonly AdeRuntime[];
  timeoutMs: number;
  logger?: { info(event: string, data?: unknown): void; warn(event: string, data?: unknown): void };
  /** A disk grow's restart: the turns keep running (they continue after it), only the chat copy is written. */
  keepTurns?: boolean;
  /** The rest save without capsules, in the time left after the chats (`cloudRestSave.ts`). */
  saveForRest?: (budgetMs: number) => Promise<{ sessions: number; git: number; backups?: CloudBackupSaveSummary | null }>;
}): Promise<CloudPrepareStopResult> {
  const deadline = Date.now() + Math.max(1_000, args.timeoutMs);
  const counts: Array<{ chats: number; clis: number }> = args.keepTurns ? [] : await Promise.all(args.runtimes.map(async (runtime) => {
    const chats = await runtime.agentChatService?.interruptRunningTurns?.().catch((error: unknown) => {
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
  const result: CloudPrepareStopResult = {
    interruptedChats,
    interruptedClis,
    stillRunning: remaining,
    chatsUploaded: flush.uploaded,
    chatsNotUploaded: flush.remaining < 0 ? 0 : flush.remaining,
    sessionsSaved: rest.sessions,
    gitSaved: rest.git,
    backups: rest.backups ?? null,
    timedOut: remaining > 0 || flush.timedOut || chatsLate,
  };
  args.logger?.info("cloud.prepare_stop", result);
  return result;
}
