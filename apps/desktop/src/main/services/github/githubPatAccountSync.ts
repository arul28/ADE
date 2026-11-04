/**
 * A pasted GitHub token (PAT) follows the owner's ADE account to every machine.
 *
 * GitHub tokens are not per project, so the vault item is account-wide: scope
 * `all`, kind `integration`, key `github`. On a machine it lives where it
 * always has, the machine credential store's `github.token.v1`, which both the
 * desktop app and the brain read. A token copied from the vault is marked as
 * account-origin so sign-out (or a removal on another machine) drops that copy
 * and never one pasted here.
 *
 * The GitHub App sign-in and `gh` / environment tokens are not touched: they
 * belong to the machine they were made on.
 */

import type { SyncCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import type { AccountVaultBridge } from "../account/accountVaultBridge";
import { describeVaultFailure, fireAndForgetVaultWrite } from "../account/vaultWrite";
import {
  describeIntegrationCredentialStorage,
  type IntegrationCredentialStorage,
} from "../account/integrationCredentialStorage";

export const GITHUB_PAT_MACHINE_KEY = "github.token.v1";
/** "account" when the machine's token was copied from the vault. */
const GITHUB_PAT_SOURCE_KEY = "github.token.source.v1";
export const GITHUB_PAT_VAULT_KIND = "integration";
export const GITHUB_PAT_VAULT_KEY = "github";

type Logger = {
  info?(event: string, meta?: Record<string, unknown>): void;
  warn?(event: string, meta?: Record<string, unknown>): void;
} | null | undefined;

function decodeToken(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || parsed.v !== 1) return null;
    return typeof parsed.token === "string" && parsed.token.trim() ? parsed.token.trim() : null;
  } catch {
    return null;
  }
}

export type GithubPatAccountSyncArgs = {
  credentialStore: SyncCredentialStore | null | undefined;
  getAccountVault?: () => AccountVaultBridge | null | undefined;
  getAccountUserId?: () => string | null;
  logger?: Logger;
  /** Told when the machine's token changed underneath the service (adopted or dropped). */
  onTokenChanged?: () => void;
};

export function createGithubPatAccountSync(args: GithubPatAccountSyncArgs) {
  const accountUserId = (): string | null => args.getAccountUserId?.()?.trim() || null;
  const resolveVault = (): AccountVaultBridge | null => {
    try {
      return args.getAccountVault?.() ?? null;
    } catch {
      return null;
    }
  };
  const store = args.credentialStore ?? null;
  const readLocal = (): string | null => store?.getSync(GITHUB_PAT_MACHINE_KEY)?.trim() || null;
  const localIsFromAccount = (): boolean => store?.getSync(GITHUB_PAT_SOURCE_KEY) === "account";
  const writeLocal = (token: string | null, fromAccount: boolean): void => {
    if (!store) return;
    if (token) {
      // Mark before the value, so a failed write never leaves an account copy unmarked.
      if (fromAccount) store.setSync(GITHUB_PAT_SOURCE_KEY, "account");
      store.setSync(GITHUB_PAT_MACHINE_KEY, token);
      if (!fromAccount) store.deleteSync(GITHUB_PAT_SOURCE_KEY);
    } else {
      store.deleteSync(GITHUB_PAT_MACHINE_KEY);
      store.deleteSync(GITHUB_PAT_SOURCE_KEY);
    }
    try {
      args.onTokenChanged?.();
    } catch {
      // A cache reset is best effort.
    }
  };

  const vaultOptions = { getAccountVault: args.getAccountVault, logger: args.logger, logEvent: "github.account_vault_sync_failed" };

  /** Share a token pasted here with the account's other machines, or remove it everywhere. */
  const publish = (token: string | null): void => {
    if (!accountUserId()) return;
    const clean = token?.trim() || "";
    if (!clean) {
      fireAndForgetVaultWrite(vaultOptions, "remove", (vault) => vault.remove(ACCOUNT_SCOPE_ALL, GITHUB_PAT_VAULT_KIND, GITHUB_PAT_VAULT_KEY));
      return;
    }
    fireAndForgetVaultWrite(vaultOptions, "set", (vault) => vault.set(
      ACCOUNT_SCOPE_ALL,
      GITHUB_PAT_VAULT_KIND,
      GITHUB_PAT_VAULT_KEY,
      JSON.stringify({ v: 1, token: clean }),
    ));
  };

  return {
    /** Mark a token pasted here as this machine's own; the caller stored it. */
    markLocal(): void {
      try {
        store?.deleteSync(GITHUB_PAT_SOURCE_KEY);
      } catch {
        // A stale marker only makes a later sign-out drop this copy.
      }
    },

    publish,

    /**
     * Reconcile at account sign-in and on vault sync ticks. The vault's token
     * replaces an account-origin copy; a token pasted on this machine is never
     * overwritten (a differing one is logged as a collision, without values),
     * and is published when the account has none yet.
     */
    async hydrate(): Promise<void> {
      const userId = accountUserId();
      const vault = resolveVault();
      if (!userId || !vault || !store) return;
      let deleted = false;
      let present = false;
      let remoteRaw: string | null = null;
      try {
        const listed = await vault.list(ACCOUNT_SCOPE_ALL);
        if (!listed.ok) return;
        const item = listed.value.find((entry) =>
          entry.scope === ACCOUNT_SCOPE_ALL && entry.kind === GITHUB_PAT_VAULT_KIND && entry.key === GITHUB_PAT_VAULT_KEY);
        deleted = item?.deleted === true;
        present = Boolean(item) && !deleted;
        if (present) {
          const got = await vault.get(ACCOUNT_SCOPE_ALL, GITHUB_PAT_VAULT_KIND, GITHUB_PAT_VAULT_KEY);
          if (!got.ok) return;
          remoteRaw = got.value;
        }
      } catch (error) {
        args.logger?.warn?.("github.account_vault_sync_failed", { operation: "read", error: describeVaultFailure(error) });
        return;
      }
      if (accountUserId() !== userId) return;
      const remote = decodeToken(remoteRaw);
      try {
        const local = readLocal();
        const fromAccount = local ? localIsFromAccount() : false;
        if (deleted) {
          if (local && fromAccount) writeLocal(null, false);
          return;
        }
        if (!remote) {
          if (present && remoteRaw !== null) return;
          if (local && !fromAccount) publish(local);
          return;
        }
        if (!local) {
          writeLocal(remote, true);
          args.logger?.info?.("github.account_vault_adopted", {});
          return;
        }
        if (local === remote) return;
        if (fromAccount) {
          writeLocal(remote, true);
          args.logger?.info?.("github.account_vault_adopted", {});
          return;
        }
        args.logger?.warn?.("github.account_vault_collision", {});
      } catch (error) {
        args.logger?.warn?.("github.account_vault_sync_failed", { operation: "hydrate", error: describeVaultFailure(error) });
      }
    },

    /** At sign-out: drop a token copied from the account, keep one pasted here. */
    purgeAccountCredentials(): void {
      if (readLocal() && localIsFromAccount()) writeLocal(null, false);
    },

    storage(): IntegrationCredentialStorage {
      return describeIntegrationCredentialStorage({
        scope: ACCOUNT_SCOPE_ALL,
        perProject: false,
        signedIn: Boolean(accountUserId()),
        hasVault: Boolean(resolveVault()),
      });
    },
  };
}

export type GithubPatAccountSync = ReturnType<typeof createGithubPatAccountSync>;
