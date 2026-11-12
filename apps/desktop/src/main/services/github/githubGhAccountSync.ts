/**
 * A `gh` CLI login for github.com follows the owner's ADE account to every
 * machine, with no question to the user (owner decision, account-owned
 * projects plan, decision 1).
 *
 * The vault item is account-wide and separate from the pasted token's: scope
 * `all`, kind `integration`, key `github-cli`. A separate key means a pasted
 * token and a `gh` login never overwrite each other, and an older ADE (which
 * reads only key `github`) ignores this item. Its value is one of:
 *
 *   { v: 1, token }        the account's copy of a `gh` login
 *   { v: 1, removed: true } the person took the `gh` login off the account;
 *                           no machine shares one again until asked to
 *
 * A machine that adopts the account's copy keeps it in the machine credential
 * store under `github.ghAccountToken.v1`, which only ever holds an account
 * copy. It is never written to `gh`'s own `hosts.yml` or keychain, and never
 * to a clone's `.git/config`: ADE hands it to git per command only.
 *
 * Which machine owns the account's copy: the machine that most recently
 * published a NEW `gh` login. A machine publishes only when the account has
 * no copy, or when its own login changed since its last publish (it records a
 * digest of what it published). A machine whose login has not changed never
 * overwrites another machine's newer copy, so two machines with different
 * `gh` users write once each and then stop: no loop. A `gh` logout releases
 * the account's copy only on the machine that published it (the copy's digest
 * equals its own published digest); another machine with a `gh` login then
 * takes over on its next vault tick.
 *
 * No timer and no repeated request of its own: it runs on the vault ticks
 * that already exist and when a GitHub status read sees a different `gh`
 * token. The `gh` lookup is the service's own cached one, and it runs again
 * only when `gh`'s `hosts.yml` changed (a `gh auth login` or `logout`
 * rewrites it), so a steady machine starts no new `gh` process.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SyncCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import { ghConfigDir } from "../../../../../ade-cli/src/services/credentials/ghConfigDir";
import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import type { GitHubAccountCredentialState } from "../../../shared/types/git";
import type { AccountVaultBridge } from "../account/accountVaultBridge";
import { readAccountVaultItem, safeVault } from "../account/accountVaultRead";
import { describeVaultFailure } from "../account/vaultWrite";

/** The account's copy of a `gh` login, adopted on this machine. Holds nothing else. */
export const GITHUB_GH_ACCOUNT_TOKEN_KEY = "github.ghAccountToken.v1";
/** The account user id the adopted copy belongs to. */
const GITHUB_GH_ACCOUNT_OWNER_KEY = "github.ghAccountToken.owner.v1";
/** `<accountUserId>:<sha256>` of the `gh` token this machine last published. */
const GITHUB_GH_ACCOUNT_PUBLISHED_KEY = "github.ghAccountToken.published.v1";
export const GITHUB_GH_VAULT_KIND = "integration";
export const GITHUB_GH_VAULT_KEY = "github-cli";

const VAULT_UNAVAILABLE_MESSAGE =
  "ADE's background service isn't running on this computer, so the account can't be changed right now.";
const ACCOUNT_CHANGED_MESSAGE = "Your ADE account changed while ADE was saving. Try again.";
const VAULT_WRITE_FAILED_MESSAGE = "The account could not be changed. Try again.";

/** Variables `gh auth token` prints in place of the stored login. */
const ENVIRONMENT_TOKEN_VARIABLES = [
  "ADE_GITHUB_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;

type Logger = {
  info?(event: string, meta?: Record<string, unknown>): void;
  warn?(event: string, meta?: Record<string, unknown>): void;
} | null | undefined;

type AccountGhValue = { kind: "token"; token: string } | { kind: "removed" };

function decodeAccountGhValue(raw: string | null | undefined): AccountGhValue | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || parsed.v !== 1) return null;
    if (parsed.removed === true) return { kind: "removed" };
    const token = typeof parsed.token === "string" ? parsed.token.trim() : "";
    return token ? { kind: "token", token } : null;
  } catch {
    return null;
  }
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Size and mtime of `gh`'s hosts.yml, which `gh auth login`, `refresh` and `logout` rewrite. */
async function defaultGhHostsSignature(): Promise<string> {
  try {
    const stat = await fs.promises.stat(path.join(ghConfigDir(), "hosts.yml"));
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

/**
 * Whether this machine has a github.com `gh` login, from hosts.yml. `gh auth
 * token` with no host answers for gh's default host, which is a GitHub
 * Enterprise host when that is the only login or when GH_HOST names one. ADE
 * talks to api.github.com only, so a login for any other host is never carried.
 * hosts.yml lists each host a login exists for, also when the token itself sits
 * in the keychain, and `gh auth logout` takes the host out of it.
 *
 * `unknown` when ADE cannot tell: GH_HOST names another host, or hosts.yml is
 * there but cannot be read (Windows can refuse a read while gh rewrites it).
 * Only a missing file means no login.
 */
async function defaultGhLoginHost(): Promise<"github.com" | "other" | "unknown"> {
  const ghHost = process.env.GH_HOST?.trim().toLowerCase();
  if (ghHost && ghHost !== "github.com") return "unknown";
  try {
    const raw = await fs.promises.readFile(path.join(ghConfigDir(), "hosts.yml"), "utf8");
    return raw.split(/\r?\n/).some((line) => /^github\.com\s*:/.test(line)) ? "github.com" : "other";
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "ENOENT" ? "other" : "unknown";
  }
}

function defaultEnvironmentTokens(): string[] {
  return ENVIRONMENT_TOKEN_VARIABLES
    .map((name) => process.env[name]?.trim() ?? "")
    .filter((value) => value.length > 0);
}

export type GithubGhAccountSyncArgs = {
  credentialStore: SyncCredentialStore | null | undefined;
  getAccountVault?: () => AccountVaultBridge | null | undefined;
  getAccountUserId?: () => string | null;
  logger?: Logger;
  /**
   * This machine's `gh` token, from the service's own cached lookup. `fresh`
   * asks it to skip its success cache, because hosts.yml just changed.
   */
  readLocalGhToken: (options: { fresh: boolean }) => Promise<string | null>;
  readGhHostsSignature?: () => Promise<string>;
  readGhLoginHost?: () => Promise<"github.com" | "other" | "unknown">;
  readEnvironmentTokens?: () => string[];
  /**
   * Told when the adopted account copy changed (adopted, replaced or dropped)
   * or the sharing state in `state()` changed, so a cached status is stale.
   */
  onChanged?: () => void;
};

export type GithubGhAccountState = {
  /** The account's copy of a `gh` login is adopted on this machine. */
  ghFromAccount: boolean;
  /** This machine's own `gh` login is the account's copy. */
  ghSharedFromHere: boolean;
  /** The person took the `gh` login off the account. */
  ghRemovedFromAccount: boolean;
};

export function createGithubGhAccountSync(args: GithubGhAccountSyncArgs) {
  const store = args.credentialStore ?? null;
  const accountUserId = (): string | null => args.getAccountUserId?.()?.trim() || null;
  const logFailure = (operation: string, detail: unknown): void => {
    args.logger?.warn?.("github.gh_account_vault_sync_failed", { operation, error: describeVaultFailure(detail) });
  };
  const resolveVault = (): AccountVaultBridge | null =>
    safeVault(args.getAccountVault, (error) => logFailure("resolve_vault", error));
  const readSignature = args.readGhHostsSignature ?? defaultGhHostsSignature;
  const readLoginHost = args.readGhLoginHost ?? defaultGhLoginHost;
  const readEnvironmentTokens = args.readEnvironmentTokens ?? defaultEnvironmentTokens;
  const vaultRef = { scope: ACCOUNT_SCOPE_ALL, kind: GITHUB_GH_VAULT_KIND, key: GITHUB_GH_VAULT_KEY };

  // What this process last saw. `undefined` = never looked.
  let observedSignature: string | null = null;
  let observedToken: string | null | undefined;
  let lastAccountState: "unknown" | "absent" | "active" | "removed" = "unknown";
  let lastAccountDigest: string | null = null;
  let collisionLogged = false;
  let hydrateInFlight: Promise<void> | null = null;
  let hydrateQueued = false;
  // Background syncs and the person's own changes run one at a time, so a
  // sync that read the vault before a removal cannot publish over it.
  let queue: Promise<unknown> = Promise.resolve();

  const safeGet = (key: string): string | null => {
    try {
      return store?.getSync(key)?.trim() || null;
    } catch {
      return null;
    }
  };

  const readCopy = (): string | null => safeGet(GITHUB_GH_ACCOUNT_TOKEN_KEY);

  /** Stores `token` as the account's copy, adopted for account `owner`. */
  const storeCopy = (token: string, owner: string): void => {
    if (!store || readCopy() === token) return;
    // Owner before value, so a failed write never leaves a copy with no owner.
    store.setSync(GITHUB_GH_ACCOUNT_OWNER_KEY, owner);
    store.setSync(GITHUB_GH_ACCOUNT_TOKEN_KEY, token);
  };
  const dropCopy = (): void => {
    if (!store || !readCopy()) return;
    store.deleteSync(GITHUB_GH_ACCOUNT_TOKEN_KEY);
    store.deleteSync(GITHUB_GH_ACCOUNT_OWNER_KEY);
  };

  /** The digest this machine last published for `userId`, or null. */
  const readPublishedDigest = (userId: string): string | null => {
    const raw = safeGet(GITHUB_GH_ACCOUNT_PUBLISHED_KEY);
    if (!raw) return null;
    const separator = raw.lastIndexOf(":");
    if (separator <= 0) return null;
    return raw.slice(0, separator) === userId ? raw.slice(separator + 1) : null;
  };
  const writePublishedDigest = (userId: string, digest: string | null): void => {
    if (!store) return;
    if (digest) store.setSync(GITHUB_GH_ACCOUNT_PUBLISHED_KEY, `${userId}:${digest}`);
    else store.deleteSync(GITHUB_GH_ACCOUNT_PUBLISHED_KEY);
  };

  /**
   * This machine's own github.com `gh` login, as far as ADE can tell.
   * `known: false` means ADE cannot see the stored login (an environment token
   * stands in front of it, GH_HOST names another host, or the lookup failed
   * while hosts.yml still lists github.com): then nothing is published or
   * released on its account. A failed lookup (a locked keychain, a `gh` that
   * timed out) is not a sign-out, and releasing on it would take the account's
   * copy from every other machine until the next lookup works.
   */
  const readShareableLocal = async (options: { fresh?: boolean } = {}): Promise<{ known: boolean; token: string | null }> => {
    const signature = await readSignature();
    const host = await readLoginHost();
    const hostsChanged = options.fresh === true || (observedToken !== undefined && signature !== observedSignature);
    // A failed lookup (hosts.yml lists github.com, no token came back) is asked
    // again on each sync. It is not `fresh`, so the service's own failure
    // backoff decides whether that starts `gh`.
    const lookupFailed = observedToken === null && host === "github.com";
    let token: string | null;
    if (observedToken !== undefined && !hostsChanged && !lookupFailed) {
      token = observedToken;
    } else {
      token = (await args.readLocalGhToken({ fresh: hostsChanged })) ?? null;
      observedSignature = signature;
      observedToken = token;
    }
    if (token && readEnvironmentTokens().includes(token)) return { known: false, token: null };
    if (host === "unknown") return { known: false, token: null };
    if (host === "other") return { known: true, token: null };
    // hosts.yml lists a github.com login: with no token, the lookup failed.
    return token ? { known: true, token } : { known: false, token: null };
  };

  // Each write names the account it was decided for; the vault refuses it
  // once a different account is signed in.
  const setVaultValue = async (vault: AccountVaultBridge, value: object, userId: string): Promise<boolean> => {
    try {
      const result = await vault.set(vaultRef.scope, vaultRef.kind, vaultRef.key, JSON.stringify(value), {
        expectedAccountUserId: userId,
      });
      if (result.ok) return true;
      logFailure("set", result);
      return false;
    } catch (error) {
      logFailure("set", error);
      return false;
    }
  };

  const removeVaultValue = async (vault: AccountVaultBridge, userId: string): Promise<boolean> => {
    try {
      const result = await vault.remove(vaultRef.scope, vaultRef.kind, vaultRef.key, { expectedAccountUserId: userId });
      if (result.ok) return true;
      logFailure("remove", result);
      return false;
    } catch (error) {
      logFailure("remove", error);
      return false;
    }
  };

  const reconcile = async (): Promise<void> => {
    const userId = accountUserId();
    if (!userId || !store) return;
    // A copy from another account (signed in while no ADE ran, so no switch
    // was seen) is not this account's, whatever the vault says.
    const owner = safeGet(GITHUB_GH_ACCOUNT_OWNER_KEY);
    if (readCopy() && owner !== userId) {
      dropCopy();
      args.logger?.info?.("github.gh_account_foreign_copy_dropped", {});
    }
    const vault = resolveVault();
    if (!vault) return;
    const read = await readAccountVaultItem(vault, vaultRef, decodeAccountGhValue, logFailure);
    if (!read || accountUserId() !== userId) return;
    const deleted = read.item?.deleted === true;
    // A value this version cannot read is a newer format: leave it and the copy alone.
    if (read.item && !deleted && read.raw !== null && !read.value) return;
    const remote = deleted ? null : read.value;
    const local = await readShareableLocal();
    if (accountUserId() !== userId) return;

    let accountToken = remote?.kind === "token" ? remote.token : null;
    const published = readPublishedDigest(userId);
    if (remote?.kind === "removed") {
      // Removed stays until a person shares again. Nothing is published, but
      // the digest follows this machine's login: a share made later on another
      // machine is then newer than it and is not overwritten from here.
      if (local.known && local.token) {
        const localDigest = tokenDigest(local.token);
        if (published !== localDigest) writePublishedDigest(userId, localDigest);
      }
    } else if (local.known && local.token) {
      const localDigest = tokenDigest(local.token);
      const accountDigest = accountToken ? tokenDigest(accountToken) : null;
      if (accountDigest === localDigest) {
        // The account already holds this login: this machine owns that copy,
        // so a later logout here releases it.
        if (published !== localDigest) writePublishedDigest(userId, localDigest);
      } else if (!accountToken || published !== localDigest) {
        // No copy yet, or a new login here since this machine last published:
        // the newest login becomes the account's copy.
        if (await setVaultValue(vault, { v: 1, token: local.token }, userId)) {
          writePublishedDigest(userId, localDigest);
          accountToken = local.token;
          collisionLogged = false;
          args.logger?.info?.("github.gh_account_published", {});
        }
      } else if (!collisionLogged) {
        // Another machine published a newer login. It stays; no values logged.
        collisionLogged = true;
        args.logger?.info?.("github.gh_account_collision", {});
      }
    } else if (local.known && published) {
      // gh signed out here. Release the account's copy only if it is the one
      // this machine published; a newer login from another machine stays.
      if (!accountToken || tokenDigest(accountToken) !== published) {
        writePublishedDigest(userId, null);
      } else if (await removeVaultValue(vault, userId)) {
        accountToken = null;
        writePublishedDigest(userId, null);
        args.logger?.info?.("github.gh_account_released", {});
      }
      // A failed release keeps the digest: the next sync tries again, and the
      // copy still counts as this machine's own login, so it is not adopted.
    }
    if (accountUserId() !== userId) return;

    lastAccountState = remote?.kind === "removed" ? "removed" : accountToken ? "active" : "absent";
    lastAccountDigest = accountToken ? tokenDigest(accountToken) : null;
    // Keep the account's copy only when it is not this machine's own login,
    // also while that login cannot be read here (it is still the published one).
    const ownLogin = accountToken !== null
      && (accountToken === local.token || tokenDigest(accountToken) === readPublishedDigest(userId));
    const copy = accountToken && !ownLogin ? accountToken : null;
    if (copy !== readCopy()) {
      if (copy) {
        storeCopy(copy, userId);
        args.logger?.info?.("github.gh_account_adopted", {});
      } else {
        dropCopy();
      }
    }
  };

  const readState = (): GithubGhAccountState => {
    const userId = accountUserId();
    const published = userId ? readPublishedDigest(userId) : null;
    return {
      ghFromAccount: Boolean(userId && readCopy()),
      ghSharedFromHere: Boolean(published && lastAccountState === "active" && lastAccountDigest === published),
      ghRemovedFromAccount: Boolean(userId && lastAccountState === "removed"),
    };
  };

  /** What a status shows from this module: the sharing state and which copy is adopted. */
  const changeKey = (): string => {
    const state = readState();
    const copy = readCopy();
    return [state.ghFromAccount, state.ghSharedFromHere, state.ghRemovedFromAccount, copy ? tokenDigest(copy) : ""].join("|");
  };
  const notifyIfChanged = (before: string): void => {
    if (changeKey() === before) return;
    try {
      args.onChanged?.();
    } catch (error) {
      args.logger?.warn?.("github.gh_account_change_notify_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /** Runs `work` after every earlier sync or change, and tells the owner when it changed the state. */
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(async () => {
      const before = changeKey();
      try {
        return await work();
      } finally {
        notifyIfChanged(before);
      }
    });
    queue = run.catch(() => undefined);
    return run;
  };

  /** Runs one reconcile at a time; a request during one runs once more after it. */
  const hydrate = async (): Promise<void> => {
    if (hydrateInFlight) {
      hydrateQueued = true;
      return await hydrateInFlight;
    }
    const run = (async () => {
      do {
        hydrateQueued = false;
        try {
          await exclusive(reconcile);
        } catch (error) {
          logFailure("hydrate", error);
        }
      } while (hydrateQueued);
    })();
    hydrateInFlight = run;
    try {
      await run;
    } finally {
      if (hydrateInFlight === run) hydrateInFlight = null;
    }
  };

  return {
    hydrate,

    /**
     * A GitHub status read just looked up this machine's `gh` token. A token
     * different from the last one seen (a sign-in, a sign-out, a switch) is
     * reconciled with the account now; the same token costs nothing.
     */
    noteLocalGhToken(token: string | null): void {
      const next = token?.trim() || null;
      if (observedToken !== undefined && observedToken === next) return;
      const first = observedToken === undefined;
      observedToken = next;
      if (!accountUserId()) {
        // Nothing to reconcile; look again once signed in.
        if (first) observedToken = undefined;
        return;
      }
      if (!first) {
        void hydrate();
        return;
      }
      // The first token seen pairs with hosts.yml as it is now, so the
      // reconcile below reuses it instead of asking `gh` again.
      void readSignature()
        .then((signature) => {
          observedSignature = signature;
        })
        .catch(() => {})
        .then(() => hydrate());
    },

    /** The adopted account copy, or null. Read on every credential inventory. */
    readAccountToken(): string | null {
      return readCopy();
    },

    /** Take the `gh` login off the account; every machine drops its copy and none shares one until asked. */
    async removeFromAccount(): Promise<void> {
      const userId = accountUserId();
      if (!userId) throw new Error("Sign in to your ADE account to change what it holds.");
      const vault = resolveVault();
      if (!vault) throw new Error(VAULT_UNAVAILABLE_MESSAGE);
      await exclusive(async () => {
        const result = await vault.set(vaultRef.scope, vaultRef.kind, vaultRef.key, JSON.stringify({ v: 1, removed: true }), {
          expectedAccountUserId: userId,
        });
        if (!result.ok) throw new Error(result.message || VAULT_WRITE_FAILED_MESSAGE);
        // The removal reached the account the person chose; a newer account
        // signed in since then keeps its own state.
        if (accountUserId() !== userId) return;
        // The published digest stays (see reconcile): a later share from another
        // machine must not read this machine's unchanged login as a new one.
        lastAccountState = "removed";
        lastAccountDigest = null;
        dropCopy();
      });
    },

    /** Share this machine's `gh` login with the account again (after a removal). */
    async shareWithAccount(): Promise<void> {
      const userId = accountUserId();
      if (!userId) throw new Error("Sign in to your ADE account to share your GitHub CLI sign-in.");
      const vault = resolveVault();
      if (!vault) throw new Error(VAULT_UNAVAILABLE_MESSAGE);
      await exclusive(async () => {
        const local = await readShareableLocal({ fresh: true });
        if (accountUserId() !== userId) throw new Error(ACCOUNT_CHANGED_MESSAGE);
        if (!local.token) {
          throw new Error(local.known
            ? "This computer has no GitHub CLI sign-in for github.com. Run `gh auth login`, then try again."
            : "ADE can't read this computer's GitHub CLI sign-in. Run `gh auth status` to check it, and unset GH_TOKEN, GITHUB_TOKEN or GH_HOST if one is set.");
        }
        const result = await vault.set(vaultRef.scope, vaultRef.kind, vaultRef.key, JSON.stringify({ v: 1, token: local.token }), {
          expectedAccountUserId: userId,
        });
        if (!result.ok) throw new Error(result.message || VAULT_WRITE_FAILED_MESSAGE);
        // The digest is keyed on the account, so it is right for that account
        // even if a newer one signed in since; the in-memory state is not.
        const digest = tokenDigest(local.token);
        writePublishedDigest(userId, digest);
        if (accountUserId() !== userId) return;
        lastAccountState = "active";
        lastAccountDigest = digest;
        dropCopy();
      });
    },

    /** At sign-out: drop the adopted copy. The account keeps its copy; this machine's own gh login is untouched. */
    purgeAccountCredentials(): void {
      const before = changeKey();
      dropCopy();
      lastAccountState = "unknown";
      lastAccountDigest = null;
      notifyIfChanged(before);
    },

    state: readState,
  };
}

export type GithubGhAccountSync = ReturnType<typeof createGithubGhAccountSync>;

/**
 * Which stored GitHub credentials came from the ADE account, for the status.
 * Shared by the desktop service and its headless twin so the two report the
 * same thing. Neither read throws: each swallows a store failure as "no".
 */
export function readGithubAccountCredentialState(
  pat: { isFromAccount(): boolean },
  gh: Pick<GithubGhAccountSync, "state">,
): GitHubAccountCredentialState {
  return { patFromAccount: pat.isFromAccount(), ...gh.state() };
}
