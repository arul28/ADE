import { getOrCreateLocalAccountMachineIdentity } from "../../../../desktop/src/main/services/account/localMachineIdentity";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import type { DeeplinkOwnership } from "../../../../desktop/src/shared/deeplinks";
import { resolveMachineAdeLayout } from "./machineLayout";
import { readAccountProjectState } from "./accountProjectSync";
import { deriveProjectId } from "./projectRegistry";

/**
 * What an ADE link to something in this project names, so it opens on this
 * computer and project from anywhere: the account machine key and the
 * project's canonical id (a hash of its root, never the database uuid, which
 * resolves only here). Null when this computer has no machine identity yet;
 * the link then goes out without it, as links did before.
 */
export function localLinkOwnership(
  projectRoot: string,
  deps: {
    logger?: Pick<Logger, "warn"> | null;
    /** The desktop passes the identity it already holds. */
    identity?: () => { machineKey: string };
  } = {},
): DeeplinkOwnership | null {
  const root = projectRoot.trim();
  if (!root) return null;
  try {
    const accountMachineKey = (deps.identity ?? getOrCreateLocalAccountMachineIdentity)().machineKey.trim();
    if (!accountMachineKey) return null;
    const projectId = deriveProjectId(root);
    const accountProjectId = accountProjectIdForCopy(accountMachineKey, projectId);
    return { accountMachineKey, projectId, ...(accountProjectId ? { accountProjectId } : {}) };
  } catch (error) {
    deps.logger?.warn("deeplink.link_ownership_unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The account project that has the copy `projectId` on the machine
 * `accountMachineKey`, from the list this machine last read. A link adds it
 * next to the pair (L33). Null when the list has no such copy: the folder is
 * not on the account yet, or the list is not read. Removed and merged
 * projects never match.
 */
export function accountProjectIdForCopy(accountMachineKey: string, projectId: string, adeDir?: string): string | null {
  try {
    const state = readAccountProjectState(adeDir ?? resolveMachineAdeLayout().adeDir);
    if (state.userId === null) return null;
    for (const project of Object.values(state.projects)) {
      if (project.removedAt !== null || project.mergedInto !== null) continue;
      if (project.copies.some((copy) => copy.machineKey === accountMachineKey && copy.checkoutId === projectId)) return project.id;
    }
    return null;
  } catch {
    return null;
  }
}
