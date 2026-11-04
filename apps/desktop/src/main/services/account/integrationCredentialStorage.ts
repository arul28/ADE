/**
 * Where an integration credential (Linear, Jira, a GitHub token) is kept, as a
 * status can honestly say it.
 *
 * "account" is a promise that the credential reaches this person's other
 * computers. It is only made when it can be kept: the person is signed in to
 * their ADE account, this runtime has a vault, and (for a per-project
 * credential) the project has a remote that names it on every machine.
 */

import { accountRepoScopeKey } from "../../../shared/accountSettingsScope";
import type { IntegrationCredentialStorage } from "../../../shared/types/integrationCredentialStorage";
import { readGitOriginUrl } from "../projects/recentProjectSummary";

export type { IntegrationCredentialStorage };

/** The account scope a project's credentials sync under, or null without a usable remote. */
export function projectCredentialAccountScope(projectRoot: string): string | null {
  try {
    return accountRepoScopeKey(readGitOriginUrl(projectRoot));
  } catch {
    return null;
  }
}

export function describeIntegrationCredentialStorage(args: {
  /** Null for a per-project credential whose project has no usable remote. */
  scope: string | null;
  perProject: boolean;
  signedIn: boolean;
  hasVault: boolean;
}): IntegrationCredentialStorage {
  if (args.perProject && !args.scope) {
    return {
      storage: "device",
      reason: "no_remote",
      message: "This project has no Git remote, so this connection stays on this computer.",
    };
  }
  if (!args.signedIn) {
    return {
      storage: "device",
      reason: "signed_out",
      message: "Sign in to your ADE account to use this connection on your other computers.",
    };
  }
  if (!args.hasVault) {
    return {
      storage: "device",
      reason: "vault_unavailable",
      message: "ADE's account vault isn't reachable here, so this connection stays on this computer for now.",
    };
  }
  return { storage: "account", reason: null, message: null };
}
