import type { OpenProjectBinding } from "../../../shared/types";
import type { LaneShareGivenEntry } from "../../../shared/types/laneShare";
import { showToast } from "../app/toast/toastStore";
import { confirmDialog } from "../ui/dialog";
import { laneShareProblem } from "./laneShareModel";
import { markLaneShareRevokePending, reloadLaneShares } from "./laneShareStore";
import { requirePin } from "../../lib/requirePin";

/**
 * Stops shares on the lane's machine (`pin`), one revoke each. The host
 * closes the guest at once, then tells the directory; a failed directory
 * call leaves the share "removed here", with Retry (revoke again).
 * Returns how many the directory recorded.
 */
export async function revokeLaneShares(
  entries: readonly Pick<LaneShareGivenEntry, "grantId" | "receiverEmail">[],
  pin: OpenProjectBinding | null,
  listKey: string | null,
): Promise<{ revoked: number; pendingDirectory: number; failed: string[] }> {
  let revoked = 0;
  let pendingDirectory = 0;
  let runningTurns = 0;
  const failed: string[] = [];
  for (const entry of entries) {
    try {
      const result = await window.ade.laneShare.revoke({ grantId: entry.grantId }, requirePin(pin, "No computer with this lane is online."));
      runningTurns += result.runningTurnSessionIds?.length ?? 0;
      if (result.directoryRevoked) {
        revoked += 1;
        markLaneShareRevokePending(entry.grantId, false);
      } else {
        pendingDirectory += 1;
        markLaneShareRevokePending(entry.grantId, true);
      }
    } catch (error) {
      failed.push(`${entry.receiverEmail ?? "A guest"}: ${laneShareProblem(error, { pin }).message}`);
    }
  }
  await reloadLaneShares(listKey, pin);
  if (failed.length > 0) {
    showToast({
      tone: "error",
      title: failed.length === entries.length ? "Couldn't stop sharing" : "Some shares did not stop",
      message: failed.join("\n"),
      report: false,
    });
  } else if (pendingDirectory > 0) {
    showToast({
      tone: "warning",
      title: "Removed on this computer",
      message: "The guest is disconnected here. The account directory did not answer; use Retry on the share to finish.",
    });
  } else if (revoked > 0) {
    showToast({ tone: "success", title: revoked === 1 ? "Share stopped" : `${revoked} shares stopped` });
  }
  if (runningTurns > 0) {
    showToast({
      tone: "info",
      title: "A guest turn is still running",
      message: "It keeps running until it ends. Stop it from its chat if you need to.",
    });
  }
  return { revoked, pendingDirectory, failed };
}

/**
 * Stops shares at the account directory, with no computer needed: the share
 * window and lists of a computer that is off, or a share of another
 * computer. The lane's computer drops a connected guest on its next grant
 * read (about 30 seconds) and refuses every new connection at once.
 */
export async function revokeGivenShares(
  entries: readonly Pick<LaneShareGivenEntry, "grantId" | "receiverEmail">[],
): Promise<{ revoked: number; failed: string[] }> {
  let revoked = 0;
  const failed: string[] = [];
  for (const entry of entries) {
    try {
      await window.ade.laneShareGuest.revokeGiven({ grantId: entry.grantId });
      markLaneShareRevokePending(entry.grantId, false);
      revoked += 1;
    } catch (error) {
      failed.push(`${entry.receiverEmail ?? "A guest"}: ${laneShareProblem(error).message}`);
    }
  }
  if (failed.length > 0) {
    showToast({
      tone: "error",
      title: failed.length === entries.length ? "Couldn't stop sharing" : "Some shares did not stop",
      message: failed.join("\n"),
      report: false,
    });
  } else if (revoked > 0) {
    showToast({ tone: "success", title: revoked === 1 ? "Share stopped" : `${revoked} shares stopped` });
  }
  return { revoked, failed };
}

/** "Stop sharing with all": a confirm, then every live share of the lane. */
export async function stopSharingLaneWithAll(args: {
  laneName: string;
  shares: readonly LaneShareGivenEntry[];
  pin: OpenProjectBinding | null;
  listKey: string | null;
}): Promise<void> {
  if (args.shares.length === 0) return;
  const people = args.shares.length === 1 ? "1 person" : `${args.shares.length} people`;
  const ok = await confirmDialog({
    title: "Stop sharing this lane?",
    message: `${people} lose access to ${args.laneName} now. A guest turn that already started keeps running.`,
    confirmLabel: "Stop sharing",
    destructive: true,
  });
  if (!ok) return;
  await revokeLaneShares(args.shares, args.pin, args.listKey);
}
