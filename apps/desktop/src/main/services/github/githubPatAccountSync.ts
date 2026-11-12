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
import { readAccountVaultItem, safeVault } from "../account/accountVaultRead";
import { describeVaultFailure, fireAndForgetVaultWrite } from "../account/vaultWrite";
import { ACCOUNT_GITHUB_VAULT_KIND, GITHUB_PAT_VAULT_KEY, decodeAccountGithubToken } from "./accountGithubTokenItem";
import {
  describeIntegrationCredentialStorage,
  type IntegrationCredentialStorage,
} from "../account/integrationCredentialStorage";

const GITHUB_PAT_MACHINE_KEY = "github.token.v1";
/** "account" when the machine's token was copied from the vault. */
const GITHUB_PAT_SOURCE_KEY = "github.token.source.v1";
/** The account user id an account copy came from. A copy from before this key has none. */
const GITHUB_PAT_OWNER_KEY = "github.token.owner.v1";

type Logger = {
  info?(event: string, meta?: Record<string, unknown>): void;
  warn?(event: string, meta?: Record<string, unknown>): void;
} | null | undefined;

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
  const logFailure = (operation: string, detail: unknown): void => {
    args.logger?.warn?.("github.account_vault_sync_failed", { operation, error: describeVaultFailure(detail) });
  };
  const resolveVault = (): AccountVaultBridge | null =>
    safeVault(args.getAccountVault, (error) => logFailure("resolve_vault", error));
  const store = args.credentialStore ?? null;
  const readLocal = (): string | null => store?.getSync(GITHUB_PAT_MACHINE_KEY)?.trim() || null;
  const localIsFromAccount = (): boolean => store?.getSync(GITHUB_PAT_SOURCE_KEY) === "account";
  const writeLocal = (token: string | null, fromAccount: boolean): void => {
    if (!store) return;
    if (token) {
      // Mark before the value, so a failed write never leaves an account copy unmarked.
      const owner = fromAccount ? accountUserId() : null;
      if (fromAccount) store.setSync(GITHUB_PAT_SOURCE_KEY, "account");
      if (owner) store.setSync(GITHUB_PAT_OWNER_KEY, owner);
      else store.deleteSync(GITHUB_PAT_OWNER_KEY);
      store.setSync(GITHUB_PAT_MACHINE_KEY, token);
      if (!fromAccount) store.deleteSync(GITHUB_PAT_SOURCE_KEY);
    } else {
      store.deleteSync(GITHUB_PAT_MACHINE_KEY);
      store.deleteSync(GITHUB_PAT_SOURCE_KEY);
      store.deleteSync(GITHUB_PAT_OWNER_KEY);
    }
    try {
      args.onTokenChanged?.();
    } catch {
      // A cache reset is best effort.
    }
  };

  const vaultOptions = { getAccountVault: args.getAccountVault, logger: args.logger, logEvent: "github.account_vault_sync_failed" };

  const vaultRef = { scope: ACCOUNT_SCOPE_ALL, kind: ACCOUNT_GITHUB_VAULT_KIND, key: GITHUB_PAT_VAULT_KEY };

  /**
   * Share a token pasted here with the account's other machines. Resolves
   * once the account's copy settled (written, or every attempt failed), for a
   * caller that tells others to read it again; never rejects.
   */
  const publish = async (token: string): Promise<void> => {
    if (!accountUserId()) return;
    const clean = token.trim();
    if (!clean) return;
    await fireAndForgetVaultWrite(vaultOptions, "set", (vault) => vault.set(
      ACCOUNT_SCOPE_ALL,
      ACCOUNT_GITHUB_VAULT_KIND,
      GITHUB_PAT_VAULT_KEY,
      JSON.stringify({ v: 1, token: clean }),
    ));
  };

  /**
   * Before this machine's token is cleared: remove the account's copy too,
   * but only when it is this token. After a collision the account holds
   * another machine's token, which stays.
   */
  const unpublish = (): void => {
    const previous = readLocal();
    const vault = resolveVault();
    if (!accountUserId() || !previous || !vault) return;
    void (async () => {
      const read = await readAccountVaultItem(vault, vaultRef, decodeAccountGithubToken, logFailure);
      if (read?.value !== previous) return;
      fireAndForgetVaultWrite(vaultOptions, "remove", (target) => target.remove(vaultRef.scope, vaultRef.kind, vaultRef.key));
    })();
  };

  return {
    /** Mark a token pasted here as this machine's own; the caller stored it. */
    markLocal(): void {
      try {
        store?.deleteSync(GITHUB_PAT_SOURCE_KEY);
        store?.deleteSync(GITHUB_PAT_OWNER_KEY);
      } catch {
        // A stale marker only makes a later sign-out drop this copy.
      }
    },

    publish,
    unpublish,

    /**
     * Reconcile at account sign-in and on vault sync ticks. The vault's token
     * replaces an account-origin copy; a token pasted on this machine is never
     * overwritten (a differing one is logged as a collision, without values),
     * and is published when the account has none yet.
     */
    async hydrate(): Promise<void> {
      const userId = accountUserId();
      if (!userId || !store) return;
      // A copy from another account (signed in while no ADE ran, so no switch
      // was seen) is not this account's, whatever the vault says. A copy with
      // no recorded owner predates the owner key and stays: dropping it when
      // the vault cannot be read would lose a token nothing can restore.
      try {
        const owner = store.getSync(GITHUB_PAT_OWNER_KEY);
        if (owner && owner !== userId && readLocal() && localIsFromAccount()) {
          writeLocal(null, false);
          args.logger?.info?.("github.account_vault_foreign_copy_dropped", {});
        }
      } catch (error) {
        logFailure("owner_check", error);
      }
      const vault = resolveVault();
      if (!vault) return;
      const read = await readAccountVaultItem(vault, vaultRef, decodeAccountGithubToken, logFailure);
      if (!read) return;
      if (accountUserId() !== userId) return;
      const deleted = read.item?.deleted === true;
      const present = Boolean(read.item) && !deleted;
      const remoteRaw = read.raw;
      const remote = read.value;
      try {
        const local = readLocal();
        const fromAccount = local ? localIsFromAccount() : false;
        if (deleted) {
          if (local && fromAccount) writeLocal(null, false);
          return;
        }
        if (!remote) {
          if (present && remoteRaw !== null) return;
          if (local && !fromAccount) void publish(local);
          return;
        }
        if (!local) {
          writeLocal(remote, true);
          args.logger?.info?.("github.account_vault_adopted", {});
          return;
        }
        if (local === remote) {
          // An older copy that matches this account's token gets its owner now.
          if (fromAccount && !store.getSync(GITHUB_PAT_OWNER_KEY)) store.setSync(GITHUB_PAT_OWNER_KEY, userId);
          return;
        }
        if (fromAccount) {
          writeLocal(remote, true);
          args.logger?.info?.("github.account_vault_adopted", {});
          return;
        }
        args.logger?.warn?.("github.account_vault_collision", {});
      } catch (error) {
        logFailure("hydrate", error);
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
