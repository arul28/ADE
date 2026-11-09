/**
 * The step before a computer stops at 0 hours (`ade cloud prepare-stop`):
 * interrupt running chat turns and agent CLIs, then write the saved chat copy,
 * so the stop that follows loses nothing a save could keep.
 */

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
  timedOut: boolean;
};

function stillBusy(runtimes: readonly AdeRuntime[]): number {
  return runtimes.reduce((total, runtime) => total + (runtime.agentChatService?.listBusyFacts?.().length ?? 0), 0);
}

export async function prepareCloudComputerToStop(args: {
  runtimes: readonly AdeRuntime[];
  timeoutMs: number;
  logger?: { info(event: string, data?: unknown): void; warn(event: string, data?: unknown): void };
}): Promise<CloudPrepareStopResult> {
  const deadline = Date.now() + Math.max(1_000, args.timeoutMs);
  const counts = await Promise.all(args.runtimes.map(async (runtime) => {
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
  while (stillBusy(args.runtimes) > 0 && Date.now() < waitUntil) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  const remaining = stillBusy(args.runtimes);

  const flushMs = Math.max(2_000, deadline - Date.now());
  const flush = await uploadPendingCloudChats(flushMs).catch((error: unknown) => {
    args.logger?.warn("cloud.prepare_stop_flush_failed", { error: error instanceof Error ? error.message : String(error) });
    return { uploaded: 0, remaining: -1, timedOut: true };
  });
  const result: CloudPrepareStopResult = {
    interruptedChats,
    interruptedClis,
    stillRunning: remaining,
    chatsUploaded: flush.uploaded,
    chatsNotUploaded: flush.remaining < 0 ? 0 : flush.remaining,
    timedOut: remaining > 0 || flush.timedOut || Date.now() >= deadline,
  };
  args.logger?.info("cloud.prepare_stop", result);
  return result;
}
