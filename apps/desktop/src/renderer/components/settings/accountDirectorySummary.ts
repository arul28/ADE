import {
  QUIT_COMPETING_SYNC_HOST_ADVICE,
  describeUnpublishedAccountDirectory,
  isSyncAccountDirectoryState,
  type AdeAccountSessionState,
  type SyncAccountDirectoryHealth,
  type SyncAccountDirectoryState,
  type SyncRoleSnapshot,
} from "../../../shared/types";
import { accountSessionConnectionsSubtitle } from "../../lib/account";

export type AccountDirectorySummary = {
  label: string;
  healthy: boolean;
  /**
   * A second line the reader can act on right here, when the shared advice names
   * one. Today that is only the competing-sync-host state: "another ADE app owns
   * sync" is not actionable without knowing to quit it.
   */
  detail?: string;
};

/**
 * What to do about a machine that is signed in but not published.
 *
 * The per-state copy lives in `shared/types/sync.ts` beside the state union, so
 * this pane and `ade setup` cannot drift apart the way their hand-mirrored
 * copies already had. This function only decides how the shared advice reads on
 * one line of the Connections pane.
 */
function unpublishedMachineSummary(
  state: SyncAccountDirectoryState,
  health?: SyncAccountDirectoryHealth | null,
): { label: string; detail?: string } {
  // The state arrives from the brain over RPC. A brain newer than this window
  // can name a state this build's union does not carry, and the shared table's
  // switch is exhaustive over the union only — it returns undefined for
  // anything else, which the destructure below would turn into a TypeError that
  // blanks the whole Connections pane. So an unrecognised state gets a truthful
  // generic line instead of a crash.
  if (!isSyncAccountDirectoryState(state)) {
    return { label: "Signed in — sync state isn't available on this computer yet" };
  }
  // The shared table's `nextAction` is deliberately dropped here: `token_unreadable`
  // already renders a Repair button beside this line, and most actions are CLI
  // commands, which mean nothing to someone reading a settings panel. The one
  // exception is the competing-sync-host instruction — "Quit that ADE" is a thing
  // this reader can do, and the line above it cannot be acted on without it.
  //
  // `health` is passed through because an answered refusal decodes from it: a
  // 403 `machine_revoked` is the directory replying, not being unreachable.
  const { summary, nextAction } = describeUnpublishedAccountDirectory(state, health);
  const label = `Signed in — ${summary}`;
  if (nextAction === QUIT_COMPETING_SYNC_HOST_ADVICE) {
    return { label, detail: nextAction };
  }
  return { label };
}

export function accountDirectorySummary(
  status: SyncRoleSnapshot,
  sessionState: AdeAccountSessionState,
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
  return { ...unpublishedMachineSummary(health.state, health), healthy: false };
}
