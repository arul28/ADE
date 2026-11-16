/**
 * A lane delete on another machine, made safe for a slow or flaky link.
 *
 * The delete used to ride on one request that stayed open for the whole
 * delete (git status, chats and terminals stopped, the folder removed, maybe
 * a remote branch push). A link that dropped during it lost the answer, the UI
 * said "failed" while the machine went on, and the retry failed again as
 * "already running" or "Lane not found".
 *
 * Now the request asks the machine to answer once the delete's checks passed
 * (`background`), and the outcome comes from short progress reads, which ADE
 * may send again after a reconnect. A start whose answer was lost is sent
 * again: the machine answers a lane already gone or being deleted as success.
 */

import type { DeleteLaneResult, LaneDeleteProgress } from "./types/lanes";
import { isRemoteOutcomeUnknownError } from "./runtimeErrors";

/** How often the progress is read while the delete runs there. */
export const LANE_DELETE_FOLLOW_POLL_MS = 3_000;
/** How long the start keeps being sent while the machine cannot be reached. */
export const LANE_DELETE_START_RETRY_BUDGET_MS = 2 * 60_000;
/** How long progress reads may fail in a row before ADE stops waiting. */
export const LANE_DELETE_FOLLOW_UNREACHABLE_MS = 5 * 60_000;
/**
 * The longest ADE follows a delete the machine still reports as running. The
 * machine bounds each git step itself; this only ends a wait on a wedged one.
 */
export const LANE_DELETE_FOLLOW_MAX_MS = 30 * 60_000;
/** Starts sent again because the machine lost the delete (restarted, say). */
const MAX_RESTARTS = 2;

const OUTCOME_UNKNOWN_MESSAGE =
  "The connection to that machine dropped before ADE could confirm the action result. The delete may still finish there.";

export type LaneDeleteFollowDeps = {
  laneId: string;
  /** Sends `lane.delete` with `background: true` to the lane's machine. */
  start: () => Promise<DeleteLaneResult | null | undefined | void>;
  /** Reads `lane.listDeleteProgress` on the same machine. */
  readProgress: () => Promise<LaneDeleteProgress[]>;
  wait: (ms: number) => Promise<void>;
  now?: () => number;
};

/** A failure that says nothing about the delete: the call never reached the machine, or its answer was lost. */
function isTransientStartError(error: unknown): boolean {
  if (isRemoteOutcomeUnknownError(error)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /Remote ADE service connection failed recently|Remote target is not connected/i.test(message);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function terminalError(progress: LaneDeleteProgress): Error {
  const failedStep = progress.steps.find((step) => step.status === "failed");
  const message = progress.errorMessage
    ?? failedStep?.errorMessage
    ?? (progress.overallStatus === "cancelled" ? "The delete was stopped." : "The delete failed on that machine.");
  return new Error(message);
}

/**
 * Deletes the lane on its machine and resolves once that machine reports it
 * deleted. Rejects with the machine's reason when the delete failed or was
 * stopped, or with an outcome-unknown error when the machine stayed out of
 * reach (`isRemoteOutcomeUnknownError` matches it).
 */
export async function deleteLaneAndFollow(deps: LaneDeleteFollowDeps): Promise<DeleteLaneResult> {
  const now = deps.now ?? Date.now;
  const done = (result?: Pick<DeleteLaneResult, "savedWork"> & { leftoverWorktree?: DeleteLaneResult["leftoverWorktree"] } | null): DeleteLaneResult => ({
    leftoverWorktree: result?.leftoverWorktree ?? null,
    savedWork: result?.savedWork ?? null,
  });

  /** "follow" when the delete runs there; a result when it is over. */
  const sendStart = async (): Promise<DeleteLaneResult | "follow"> => {
    const startedAt = now();
    let resent = false;
    for (;;) {
      try {
        const answer = await deps.start();
        if (answer && typeof answer === "object" && answer.accepted === true) return "follow";
        // Done already, gone already, or an older ADE that answers when done.
        return done(answer || null);
      } catch (error) {
        const message = errorText(error);
        // An older ADE answers a re-sent start the old way.
        if (/Lane delete is already running/i.test(message)) return "follow";
        if (resent && /^Lane not found/i.test(message)) return done(null);
        if (!isTransientStartError(error) || now() - startedAt >= LANE_DELETE_START_RETRY_BUDGET_MS) throw error;
        resent = true;
        await deps.wait(LANE_DELETE_FOLLOW_POLL_MS);
      }
    }
  };

  let restarts = 0;
  let outcome = await sendStart();
  if (outcome !== "follow") return outcome;

  const followStartedAt = now();
  let lastReadAt = now();
  for (;;) {
    await deps.wait(LANE_DELETE_FOLLOW_POLL_MS);
    let progresses: LaneDeleteProgress[];
    try {
      progresses = await deps.readProgress();
    } catch (error) {
      if (now() - lastReadAt >= LANE_DELETE_FOLLOW_UNREACHABLE_MS) {
        throw new Error(`${OUTCOME_UNKNOWN_MESSAGE} (${errorText(error)})`);
      }
      continue;
    }
    lastReadAt = now();
    const progress = (Array.isArray(progresses) ? progresses : []).find((entry) => entry?.laneId === deps.laneId);
    if (progress?.overallStatus === "running") {
      if (now() - followStartedAt >= LANE_DELETE_FOLLOW_MAX_MS) throw new Error(OUTCOME_UNKNOWN_MESSAGE);
      continue;
    }
    if (progress?.overallStatus === "completed" || progress?.overallStatus === "completed_with_warnings") {
      return done(progress);
    }
    if (progress) throw terminalError(progress);
    // No record: the machine restarted and lost the delete, or dropped the
    // record of one that ended while ADE could not read. Asking again settles
    // it: a lane that is gone answers `alreadyDeleted`, one still there starts
    // over (a failed delete fails again with its reason).
    if (restarts >= MAX_RESTARTS) throw new Error(OUTCOME_UNKNOWN_MESSAGE);
    restarts += 1;
    outcome = await sendStart();
    if (outcome !== "follow") return outcome;
  }
}
