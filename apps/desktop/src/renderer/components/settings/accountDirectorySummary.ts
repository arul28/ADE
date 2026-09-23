import {
  describeUnpublishedAccountDirectory,
  isSyncAccountDirectoryState,
  type AdeAccountSessionState,
  type SyncAccountDirectoryState,
  type SyncRoleSnapshot,
} from "../../../shared/types";
import type { ThisMachineRefusal } from "../../../shared/accountMachineRefusal";
import { accountSessionConnectionsSubtitle } from "../../lib/account";
import { describeThisComputerRefusal } from "../../lib/thisComputerRefusal";

export type AccountDirectorySummary = {
  label: string;
  healthy: boolean;
};

/**
 * What to do about a machine that is signed in but not published.
 *
 * The per-state copy lives in `shared/types/sync.ts` beside the state union, so
 * this pane and `ade setup` cannot drift apart the way their hand-mirrored
 * copies already had. This function only decides how the shared advice reads on
 * one line of the Connections pane.
 */
function unpublishedMachineLabel(state: SyncAccountDirectoryState): string {
  // The state arrives from the brain over RPC. A brain newer than this window
  // can name a state this build's union does not carry, and the shared table's
  // switch is exhaustive over the union only — it returns undefined for
  // anything else, which the destructure below would turn into a TypeError that
  // blanks the whole Connections pane. So an unrecognised state gets a truthful
  // generic line instead of a crash.
  if (!isSyncAccountDirectoryState(state)) {
    return "Signed in — sync state isn't available on this computer yet";
  }
  // Only the summary. The shared table's `nextAction` is deliberately dropped
  // here: `token_unreadable` already renders a Repair button beside this line,
  // and the other actions are CLI commands, which mean nothing to someone
  // reading a settings panel.
  const { summary } = describeUnpublishedAccountDirectory(state);
  return `Signed in — ${summary}`;
}

export function accountDirectorySummary(
  status: SyncRoleSnapshot,
  sessionState: AdeAccountSessionState,
  /**
   * The directory's refusal of THIS computer, read once by the caller with the
   * same guard that shows its Reconnect button. Null when the snapshot is
   * another machine's (a remote-bound pane, or the hosted web client): the
   * refusal copy says "This computer", which would then name the wrong machine.
   */
  refusal: ThisMachineRefusal | null,
): AccountDirectorySummary {
  if (sessionState === "unreadable") {
    return {
      label: accountSessionConnectionsSubtitle("unreadable"),
      healthy: false,
    };
  }
  if (sessionState !== "active") {
    return {
      label: "Not signed in — you can still connect to other machines manually",
      healthy: false,
    };
  }
  const health = status.routeHealth?.accountDirectory;
  if (!health) {
    return {
      label: "Connected to your ADE account · checking machine publication",
      healthy: false,
    };
  }
  if (health.state === "published") {
    if (health.reachableEndpointCount === 0) {
      return {
        label: "Published to your ADE account, but no reachable routes are available",
        healthy: false,
      };
    }
    // Deliberately just the fact of the connection. The published-route count was
    // plumbing detail the reader could neither act on nor interpret.
    return { label: "Connected to your ADE account", healthy: true };
  }
  // A refusal is not "can't reach your account, retrying": the directory
  // answered, and nothing retries on its own. Say what happened; the card
  // puts the Reconnect button beside this line.
  if (refusal) {
    return { label: describeThisComputerRefusal(refusal).title, healthy: false };
  }
  return { label: unpublishedMachineLabel(health.state), healthy: false };
}
