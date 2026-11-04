/**
 * A project's Linear connection, following the project to every machine on the
 * owner's ADE account.
 *
 * One vault item per project: scope `repo:<host>/<owner>/<repo>`, kind
 * `integration`, key `linear`, value the whole connection (auth mode, access
 * token, refresh token, expiry). An API key (manual) is copied as-is. An OAuth
 * connection rotates its refresh token on every exchange, so it follows "one
 * owner renews, everyone else reads" (account/rotatingCredentialOwner.ts): the
 * item's `refreshOwner` machine renews and publishes; the others adopt what it
 * publishes and never exchange, until the owner goes quiet and one takes over.
 *
 * A project without a remote has no scope that means the same thing on another
 * machine, so its connection stays on this one, and the status says so.
 *
 * Both Linear credential services (desktop main and the headless brain) use
 * this through a small adapter over their own local store.
 */

import type { AccountVaultBridge } from "../account/accountVaultBridge";
import type { AccountVaultItem } from "../../../shared/types/accountVault";
import { describeVaultFailure, fireAndForgetVaultWrite } from "../account/vaultWrite";
import { decideRotatingRenewal } from "../account/rotatingCredentialOwner";
import {
  describeIntegrationCredentialStorage,
  projectCredentialAccountScope,
  type IntegrationCredentialStorage,
} from "../account/integrationCredentialStorage";

export const LINEAR_ACCOUNT_VAULT_KIND = "integration";
export const LINEAR_ACCOUNT_VAULT_KEY = "linear";
/** The account-wide row ADE wrote before connections were per project. */
const LEGACY_SCOPE = "all";
const LEGACY_KIND = "linear_refresh_token";
const LEGACY_KEY = "default";

export type LinearAccountCredential = {
  token: string;
  authMode: "manual" | "oauth";
  refreshToken: string | null;
  expiresAt: string | null;
};

type Logger = {
  info?(event: string, meta?: Record<string, unknown>): void;
  warn?(event: string, meta?: Record<string, unknown>): void;
} | null | undefined;

export type LinearAccountSyncArgs = {
  projectRoot: string;
  getAccountVault?: () => AccountVaultBridge | null | undefined;
  getAccountUserId?: () => string | null;
  getDeviceId?: () => string | null;
  logger?: Logger;
  /** The project's stored connection, never an environment token. */
  readLocal: () => LinearAccountCredential | null;
  /** True when the stored connection was copied from the account vault. */
  localIsFromAccount: () => boolean;
  /** An environment token stays authoritative on this machine. */
  hasEnvToken: () => boolean;
  /** Store a connection that came from the vault, marked account-origin. Never publishes. */
  writeFromAccount: (record: LinearAccountCredential, accountUserId: string) => void;
  /** Drop an account-origin connection another machine removed. Never publishes. */
  clearFromAccount: () => void;
};

export function encodeLinearAccountCredential(record: LinearAccountCredential): string {
  return JSON.stringify({
    v: 1,
    authMode: record.authMode,
    token: record.token,
    refreshToken: record.authMode === "oauth" ? record.refreshToken : null,
    expiresAt: record.authMode === "oauth" ? record.expiresAt : null,
  });
}

export function decodeLinearAccountCredential(raw: string | null | undefined): LinearAccountCredential | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || parsed.v !== 1) return null;
    const token = typeof parsed.token === "string" ? parsed.token.trim() : "";
    const authMode = parsed.authMode === "oauth" ? "oauth" : parsed.authMode === "manual" ? "manual" : null;
    if (!token || !authMode) return null;
    const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
    return {
      token,
      authMode,
      refreshToken: authMode === "oauth" ? text(parsed.refreshToken) : null,
      expiresAt: authMode === "oauth" ? text(parsed.expiresAt) : null,
    };
  } catch {
    return null;
  }
}

function sameCredential(left: LinearAccountCredential, right: LinearAccountCredential): boolean {
  return left.token === right.token
    && left.authMode === right.authMode
    && (left.refreshToken ?? null) === (right.refreshToken ?? null)
    && (left.expiresAt ?? null) === (right.expiresAt ?? null);
}

function expiryMs(record: LinearAccountCredential | null): number | null {
  const parsed = record?.expiresAt ? Date.parse(record.expiresAt) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** True when the vault copy is a later turn of the same OAuth grant than the local one. */
function vaultIsNewerOAuth(local: LinearAccountCredential, remote: LinearAccountCredential): boolean {
  if (local.authMode !== "oauth" || remote.authMode !== "oauth") return false;
  const localExpiry = expiryMs(local);
  const remoteExpiry = expiryMs(remote);
  if (remoteExpiry === null) return false;
  return localExpiry === null || remoteExpiry > localExpiry;
}

export type LinearRefreshPlan = {
  /** May this machine exchange the refresh token now? */
  renew: boolean;
  /** Should a renewed (or cleared) connection be published for other machines? */
  publish: boolean;
};

export function createLinearAccountSync(args: LinearAccountSyncArgs) {
  const deviceId = (): string | null => args.getDeviceId?.()?.trim() || null;
  const accountUserId = (): string | null => args.getAccountUserId?.()?.trim() || null;
  const scope = (): string | null => projectCredentialAccountScope(args.projectRoot);
  const resolveVault = (): AccountVaultBridge | null => {
    try {
      return args.getAccountVault?.() ?? null;
    } catch {
      return null;
    }
  };

  const logFailure = (operation: string, detail: unknown): void => {
    args.logger?.warn?.("linear_sync.account_vault_sync_failed", { operation, error: describeVaultFailure(detail) });
  };

  /** The vault item and its decoded value for this project, or null when the vault cannot say. */
  const readRemote = async (
    vault: AccountVaultBridge,
    accountScope: string,
  ): Promise<{ item: AccountVaultItem | null; raw: string | null; record: LinearAccountCredential | null } | null> => {
    try {
      const listed = await vault.list(accountScope);
      if (!listed.ok) {
        logFailure("list", listed);
        return null;
      }
      const item = listed.value.find((entry) =>
        entry.scope === accountScope && entry.kind === LINEAR_ACCOUNT_VAULT_KIND && entry.key === LINEAR_ACCOUNT_VAULT_KEY) ?? null;
      if (!item || item.deleted === true) return { item, raw: null, record: null };
      const got = await vault.get(accountScope, LINEAR_ACCOUNT_VAULT_KIND, LINEAR_ACCOUNT_VAULT_KEY);
      if (!got.ok) {
        logFailure("get", got);
        return null;
      }
      return { item, raw: got.value, record: decodeLinearAccountCredential(got.value) };
    } catch (error) {
      logFailure("read", error);
      return null;
    }
  };

  /**
   * Put this machine's connection in the vault (or remove it). An OAuth
   * connection names this machine as the one that renews it: it is published
   * only on a sign-in here or by the owner after it renews.
   */
  const publish = (record: LinearAccountCredential | null): void => {
    const accountScope = scope();
    if (!accountScope || !accountUserId()) return;
    const options = { getAccountVault: args.getAccountVault, logger: args.logger, logEvent: "linear_sync.account_vault_sync_failed" };
    if (!record) {
      fireAndForgetVaultWrite(options, "remove", (vault) => vault.remove(accountScope, LINEAR_ACCOUNT_VAULT_KIND, LINEAR_ACCOUNT_VAULT_KEY));
      return;
    }
    const owner = record.authMode === "oauth" ? deviceId() : null;
    fireAndForgetVaultWrite(options, "set", (vault) => vault.set(
      accountScope,
      LINEAR_ACCOUNT_VAULT_KIND,
      LINEAR_ACCOUNT_VAULT_KEY,
      encodeLinearAccountCredential(record),
      owner ? { refreshOwner: owner } : { refreshOwner: null },
    ));
  };

  /**
   * The account-wide `all/linear_refresh_token/default` row is from before
   * connections were per project. The machine that owns it moves it to the
   * project whose OAuth refresh token it is, then drops it. A row this machine
   * does not own, or no project here matches, is left for its owner.
   */
  const retireLegacyRowIfMine = async (vault: AccountVaultBridge, local: LinearAccountCredential): Promise<void> => {
    const me = deviceId();
    if (!me || local.authMode !== "oauth" || !local.refreshToken) return;
    try {
      const listed = await vault.list(LEGACY_SCOPE);
      if (!listed.ok) return;
      const legacy = listed.value.find((entry) => entry.scope === LEGACY_SCOPE && entry.kind === LEGACY_KIND && entry.key === LEGACY_KEY);
      if (!legacy || legacy.deleted === true) return;
      const owner = legacy.refreshOwner?.trim() || "";
      if (owner && owner !== me) return;
      const got = await vault.get(LEGACY_SCOPE, LEGACY_KIND, LEGACY_KEY);
      if (!got.ok || got.value?.trim() !== local.refreshToken) return;
      const removed = await vault.remove(LEGACY_SCOPE, LEGACY_KIND, LEGACY_KEY);
      if (removed.ok) args.logger?.info?.("linear_sync.account_vault_legacy_row_retired", {});
    } catch (error) {
      logFailure("legacy_retire", error);
    }
  };

  /**
   * Reconcile this project's connection with the vault. Runs at account
   * sign-in and on vault sync ticks, never on a request path.
   *
   * - Vault has it, this machine does not: adopt it (the second machine is now connected).
   * - This machine has it, the vault does not: publish it (existing users start syncing).
   * - Both, different: an account-origin copy takes the vault's newer turn; this
   *   machine's own connection is kept and the collision logged, unless this
   *   machine is the item's owner, in which case it republishes its own.
   * - A tombstone drops an account-origin copy, never this machine's own.
   */
  const hydrate = async (): Promise<void> => {
    const userId = accountUserId();
    const accountScope = scope();
    if (!userId || !accountScope) return;
    const vault = resolveVault();
    if (!vault) return;
    const remote = await readRemote(vault, accountScope);
    if (!remote) return;
    if (accountUserId() !== userId) return;

    let local: LinearAccountCredential | null;
    let fromAccount: boolean;
    try {
      local = args.readLocal();
      fromAccount = args.localIsFromAccount();
    } catch (error) {
      logFailure("hydrate_read_local", error);
      return;
    }

    try {
      if (remote.item?.deleted === true) {
        if (local && fromAccount) {
          args.clearFromAccount();
          args.logger?.info?.("linear_sync.account_vault_removed_elsewhere", {});
        }
        return;
      }
      if (!remote.record) {
        if (remote.item && remote.raw !== null) {
          // An item ADE cannot read is never overwritten: it may be a newer format.
          args.logger?.warn?.("linear_sync.account_vault_unreadable", {});
          return;
        }
        if (local && !fromAccount) {
          publish(local);
          await retireLegacyRowIfMine(vault, local);
        }
        return;
      }
      if (!local) {
        if (args.hasEnvToken()) return;
        args.writeFromAccount(remote.record, userId);
        args.logger?.info?.("linear_sync.account_vault_adopted", { authMode: remote.record.authMode });
        return;
      }
      if (sameCredential(local, remote.record)) return;
      const me = deviceId();
      const owner = remote.item?.refreshOwner?.trim() || "";
      if (fromAccount) {
        if (remote.record.authMode === "manual" || local.authMode === "manual" || vaultIsNewerOAuth(local, remote.record)) {
          args.writeFromAccount(remote.record, userId);
          args.logger?.info?.("linear_sync.account_vault_adopted", { authMode: remote.record.authMode });
        }
        return;
      }
      if (me && owner === me && local.authMode === "oauth") {
        // This machine renews this connection; its copy is the newest turn.
        if (!vaultIsNewerOAuth(local, remote.record)) publish(local);
        return;
      }
      args.logger?.warn?.("linear_sync.account_vault_collision", {
        localAuthMode: local.authMode,
        accountAuthMode: remote.record.authMode,
      });
    } catch (error) {
      logFailure("hydrate", error);
    }
  };

  /**
   * Before an OAuth refresh: may this machine exchange its refresh token, and
   * should the result be shared?
   *
   * The shared grant is the vault's when this machine's copy came from it or
   * carries the same refresh token. On it, only the owner renews; a non-owner
   * adopts the owner's newer turn instead. A grant made on this machine alone
   * (a collision) renews freely and stays here.
   */
  const isShared = (local: LinearAccountCredential, remote: LinearAccountCredential): boolean =>
    args.localIsFromAccount() || (remote.refreshToken !== null && remote.refreshToken === local.refreshToken);

  const planRefresh = async (local: LinearAccountCredential): Promise<LinearRefreshPlan> => {
    const accountScope = scope();
    const userId = accountUserId();
    const vault = resolveVault();
    if (!accountScope || !userId || !vault) return { renew: true, publish: false };
    const remote = await readRemote(vault, accountScope);
    if (!remote || remote.item?.deleted === true || !remote.record || !remote.raw) {
      // Nothing shared: renew here; publishing would also start sharing a
      // connection this machine has, which hydrate does on its own schedule.
      return { renew: true, publish: false };
    }
    if (!isShared(local, remote.record)) return { renew: true, publish: false };

    if (vaultIsNewerOAuth(local, remote.record)) {
      // The owner already renewed; take its turn rather than exchanging an old token.
      args.writeFromAccount(remote.record, userId);
      return { renew: false, publish: false };
    }
    const verdict = await decideRotatingRenewal({
      vault,
      deviceId: deviceId(),
      ref: { scope: accountScope, kind: LINEAR_ACCOUNT_VAULT_KIND, key: LINEAR_ACCOUNT_VAULT_KEY },
      expiresAtMs: expiryMs(remote.record),
      currentValue: remote.raw,
      logger: args.logger,
      logContext: { source: "linear_oauth" },
    });
    if (verdict.renew) return { renew: true, publish: true };
    // The vault may have moved while deciding; pick up the owner's turn.
    const after = await readRemote(vault, accountScope);
    if (after?.record && vaultIsNewerOAuth(local, after.record)) args.writeFromAccount(after.record, userId);
    return { renew: false, publish: false };
  };

  /**
   * Inside the machine-local refresh lock, just before exchanging: has a
   * sibling process here (or the owner elsewhere) already published a newer
   * turn of this grant? Then take it and do not exchange. Reads the local vault
   * cache only, so the lock is held for one round trip to the brain.
   */
  const adoptNewerTurn = async (local: LinearAccountCredential): Promise<boolean> => {
    const accountScope = scope();
    const userId = accountUserId();
    const vault = resolveVault();
    if (!accountScope || !userId || !vault) return false;
    const remote = await readRemote(vault, accountScope);
    if (!remote?.record || !isShared(local, remote.record) || !vaultIsNewerOAuth(local, remote.record)) return false;
    args.writeFromAccount(remote.record, userId);
    return true;
  };

  /**
   * Publish a renewed turn and wait for the first attempt, so a sibling
   * process waiting on the refresh lock finds it. Falls back to the retried
   * fire-and-forget write.
   */
  const publishNow = async (record: LinearAccountCredential): Promise<void> => {
    const accountScope = scope();
    const vault = resolveVault();
    const owner = deviceId();
    if (accountScope && accountUserId() && vault) {
      try {
        const written = await vault.set(
          accountScope,
          LINEAR_ACCOUNT_VAULT_KIND,
          LINEAR_ACCOUNT_VAULT_KEY,
          encodeLinearAccountCredential(record),
          { refreshOwner: owner },
        );
        if (written.ok) return;
      } catch {
        // Retried below.
      }
    }
    publish(record);
  };

  const storage = (): IntegrationCredentialStorage => describeIntegrationCredentialStorage({
    scope: scope(),
    perProject: true,
    signedIn: Boolean(accountUserId()),
    hasVault: Boolean(resolveVault()),
  });

  return { publish, publishNow, hydrate, planRefresh, adoptNewerTurn, storage };
}

export type LinearAccountSync = ReturnType<typeof createLinearAccountSync>;
