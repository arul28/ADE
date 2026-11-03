import { getOrCreateLocalAccountMachineIdentity } from "../../../../desktop/src/main/services/account/localMachineIdentity";
import type { DeeplinkOwnership } from "../../../../desktop/src/shared/deeplinks";
import { deriveProjectId } from "./projectRegistry";

/**
 * What an ADE link to something in this project names, so it opens on this
 * computer and project from anywhere: the account machine key and the
 * project's canonical id (a hash of its root, never the database uuid, which
 * resolves only here). Null when this computer has no machine identity yet;
 * the link then goes out without it, as links did before.
 */
export function localLinkOwnership(projectRoot: string): DeeplinkOwnership | null {
  const root = projectRoot.trim();
  if (!root) return null;
  try {
    const accountMachineKey = getOrCreateLocalAccountMachineIdentity().machineKey.trim();
    return accountMachineKey ? { accountMachineKey, projectId: deriveProjectId(root) } : null;
  } catch {
    return null;
  }
}
