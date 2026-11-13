import { randomUUID } from "node:crypto";
import { updateCredentialKeySync, type UpdatableCredentialStore } from "../../../../../ade-cli/src/services/credentials/updateCredentialKey";
import {
  createAccountAppTokenClient,
  GITHUB_ACCOUNT_APP_TOKEN_KEY,
  type AccountAppTokenClient,
  type AccountAppTokenStore,
} from "../../../shared/github/accountAppTokenClient";
import { resolveTrustedAccountDirectoryBaseUrl } from "../../../shared/accountDirectory";
import type { GitHubAccountAppStatus, GitHubRepoRef } from "../../../shared/types";
import {
  appGrantAllowsCapability,
  appGrantMissingPermissions,
  type AppGrantReader,
} from "../../../shared/github/githubAppGrant";
import { createGithubAppAccountAdoption } from "./githubAppAccountAdoption";
import type { AppUserAuthHandOverOutcome } from "./githubAppUserAuthService";
import type { GitHubAppUserTokenRecord } from "./githubAppUserAuth";
import type { GitHubRelayAuthAuditLog } from "./githubRelayConfig";

/**
 * The `account_app` credential for one GitHub service: the ADE account's
 * GitHub App sign-in, served by the account directory.
 *
 * The desktop GitHub service and its headless twin (the brain, also on a cloud
 * computer) each build one of these and call it from a few small blocks, so
 * the two stay the same:
 *
 * - the credential inventory asks `readToken()` (a cache read; a request only
 *   when the cached token reached its stop time);
 * - a GitHub 401 to the token calls `onRejected()`, which asks the server
 *   once and answers the replacement, if any;
 * - a read that finds a new token (the account connected again on another
 *   computer) calls `onChanged`, so the owner restarts a relay poll that
 *   stopped on the old one;
 * - the vault tick calls `adoptLocalSignIn()`;
 * - the status adds `statusFor(repo)`;
 * - the relay installation check and the relay poll use `relayAppUserAuth`,
 *   which falls back to the account App when this machine has no sign-in of
 *   its own (the legacy record is gone after adoption).
 *
 * It is off (every call answers "nothing") unless the service was given the
 * account token, the account user id and the account directory address. Tests
 * and the clone path without an account build the service without them.
 */

type Logger = {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
};

type LegacyAppUserAuth = {
  getAuthStatus(): { tokenStored: boolean; userLogin: string | null };
  getStoredTokenForHealth(): string | null;
  getValidTokenForRelay(): Promise<string>;
  handOverToAccount(handOver: (record: GitHubAppUserTokenRecord & { refreshToken: string }) => Promise<"delete" | "keep">): Promise<AppUserAuthHandOverOutcome>;
  auditLog: GitHubRelayAuthAuditLog;
};

type CredentialStoreLike = UpdatableCredentialStore & { credentialStoreIdentity?(): string };

/** One holder id per process: the desktop and the brain are two processes. */
const PROCESS_HOLDER_ID = `pid-${typeof process !== "undefined" ? process.pid : 0}-${randomUUID()}`;

function storeAdapter(store: CredentialStoreLike): AccountAppTokenStore {
  return {
    read: () => store.getSync(GITHUB_ACCOUNT_APP_TOKEN_KEY) ?? null,
    update: (mutator) => {
      updateCredentialKeySync(store, GITHUB_ACCOUNT_APP_TOKEN_KEY, mutator);
    },
    identity: () => `account-app:${store.credentialStoreIdentity?.() ?? "unnamed"}`,
  };
}

const sameLogin = (a: string | null | undefined, b: string | null | undefined): boolean =>
  Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

export function createGithubAccountAppCredential(deps: {
  credentialStore: CredentialStoreLike | null | undefined;
  logger: Logger;
  appUserAuth: LegacyAppUserAuth;
  clientKind: "desktop" | "cli";
  getAccountAccessToken?: ((options?: { forceRefresh?: boolean }) => Promise<string | null>) | null;
  getAccountUserId?: (() => string | null) | null;
  getAccountDirectoryBaseUrl?: (() => string | null | undefined) | null;
  fetchImpl?: typeof fetch;
  /** The account App token changed or went away: drop cached inventories and statuses. */
  onChanged: () => void;
}) {
  const getAccountAccessToken = deps.getAccountAccessToken ?? null;
  const getAccountUserId = deps.getAccountUserId ?? null;
  const getDirectoryBaseUrl = deps.getAccountDirectoryBaseUrl ?? null;
  const client: AccountAppTokenClient | null = getAccountAccessToken && getAccountUserId && getDirectoryBaseUrl
    ? createAccountAppTokenClient({
      fetchImpl: deps.fetchImpl,
      getAccountAccessToken: (options) => getAccountAccessToken(options),
      getAccountUserId: () => getAccountUserId(),
      getDirectoryBaseUrl: () => {
        try {
          return resolveTrustedAccountDirectoryBaseUrl(getDirectoryBaseUrl() ?? null);
        } catch {
          return null;
        }
      },
      store: deps.credentialStore ? storeAdapter(deps.credentialStore) : null,
      holderId: PROCESS_HOLDER_ID,
      clientKind: deps.clientKind,
      logger: { info: (event, data) => deps.logger.info(event, data), warn: (event, data) => deps.logger.warn(event, data) },
    })
    : null;

  const adoption = client && getAccountUserId
    ? createGithubAppAccountAdoption({
      storeIdentity: `adoption:${deps.credentialStore?.credentialStoreIdentity?.() ?? "memory"}`,
      appUserAuth: deps.appUserAuth,
      client,
      getAccountUserId: () => getAccountUserId(),
      onChanged: deps.onChanged,
      logger: deps.logger,
    })
    : null;

  let lastToken: string | null = null;
  /** Whether a read happened in this process, and the last token one found. */
  let readBefore = false;
  let lastNonNullToken: string | null = null;

  /**
   * Records a read. True when it brought a token this process did not have:
   * a new one after another, or one after a read found none. The first read
   * after start is not a change, and a token that comes back after a short
   * gap (a network error) is not one either.
   */
  const noteToken = (token: string | null): boolean => {
    const changed = token != null && readBefore && token !== lastNonNullToken;
    readBefore = true;
    if (token != null) lastNonNullToken = token;
    lastToken = token;
    return changed;
  };

  /**
   * The current account App token, or null. Never throws.
   * `force`: ask even when a negative answer still stands (a person pressed
   * Refresh).
   */
  const readToken = async (opts: { force?: boolean } = {}): Promise<string | null> => {
    if (!client) return null;
    try {
      const result = await client.getToken(opts.force ? { force: true } : {});
      const token = result.ok ? result.token : null;
      if (noteToken(token)) deps.onChanged();
      return token;
    } catch (error) {
      deps.logger.warn("github.account_app_token_read_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  /** The cached token, with no request (for the synchronous credential pick). */
  const peekToken = (): string | null => client?.peek().usableToken ?? null;

  /**
   * GitHub answered 401 to `token`. Asks the server once for the current token
   * (the server and this process each ask GitHub about one token at most once
   * a minute). Answers a different token to retry with, or null.
   * `userRequested`: a person pressed Refresh; the one-minute window per
   * token does not apply.
   */
  const onRejected = async (token: string, opts: { userRequested?: boolean } = {}): Promise<string | null> => {
    if (!client) return null;
    try {
      const result = await client.getToken({ afterRejected: token, userRequested: opts.userRequested === true });
      if (result.ok && result.token !== token) {
        noteToken(result.token);
        deps.onChanged();
        return result.token;
      }
      if (!result.ok && result.reason !== "rejected_recently") deps.onChanged();
      return null;
    } catch {
      return null;
    }
  };

  /** Drops a negative answer (a person asked to check again). */
  const clearNegative = (): void => {
    client?.clearNegative();
    adoption?.forget();
  };

  /** Sign-out of the ADE account: the cached token goes. */
  const purge = (): void => {
    client?.clearCache();
    adoption?.forget();
    lastToken = null;
  };

  /** One adoption pass (vault tick). */
  const adoptLocalSignIn = async (): Promise<void> => {
    if (!adoption) return;
    // A cache entry of another account (an account switch) is dropped first.
    client?.dropForeignEntry();
    await adoption.run();
  };

  /**
   * Retires this machine's own App token at GitHub after a person removed it
   * ("Use @y here", or Disconnect on the legacy sign-in). Best effort: the
   * local record is already gone.
   */
  const retireLegacyToken = (token: string | null): void => {
    adoption?.forget();
    if (!client || !token) return;
    void client.retire(token).then((retired) => {
      deps.logger.info("github.app_local_token_retired", { retired });
    }).catch(() => undefined);
  };

  /** What the status says about the account App, and about the repository owner's installation. */
  const statusFor = async (
    repo: GitHubRepoRef | null,
    readGrant: AppGrantReader | null,
  ): Promise<GitHubAccountAppStatus | null> => {
    if (!client) return null;
    try {
      const view = client.peek();
      let legacy: { tokenStored: boolean; userLogin: string | null } | null = null;
      try {
        legacy = deps.appUserAuth.getAuthStatus();
      } catch {
        legacy = null;
      }
      const recorded = adoption?.loginMismatch() ?? null;
      const localLogin = legacy?.tokenStored ? legacy.userLogin : null;
      const accountLogin = view.githubLogin ?? recorded?.accountLogin ?? null;
      const loginMismatch = Boolean(
        legacy?.tokenStored
        && (recorded
          ? sameLogin(recorded.localLogin, localLogin)
          : view.state === "active" && accountLogin && localLogin && !sameLogin(accountLogin, localLogin)),
      );
      let repoGrant: GitHubAccountAppStatus["repoGrant"] = null;
      if (repo && view.usableToken && readGrant) {
        const grant = await readGrant(repo.owner, view.usableToken, { identity: "account_app" }).catch(() => null);
        if (grant) {
          repoGrant = {
            owner: repo.owner,
            installed: grant.installed,
            accountType: grant.accountType,
            missingPermissions: appGrantMissingPermissions(grant),
            manageUrl: grant.manageUrl,
            canWrite: appGrantAllowsCapability(grant, "write"),
            canEditIssues: appGrantAllowsCapability(grant, "issue-write"),
            canPush: appGrantAllowsCapability(grant, "git"),
          };
        }
      }
      return {
        connected: view.state === "active",
        githubLogin: accountLogin,
        state: view.state === "active" ? "connected" : view.state,
        stateReason: view.stateReason,
        localLogin,
        loginMismatch,
        repoGrant,
      };
    } catch {
      return null;
    }
  };

  /**
   * The relay's view of "the App user token": this machine's own sign-in
   * first, as before; when it has none (adopted, or never made), the
   * account's. The legacy error stays the answer when neither works, so the
   * relay copy keeps naming the real problem.
   */
  /**
   * This machine's own token that the relay refused, while the account had
   * another. Its record still looks valid until it expires, so without this
   * the next relay call would send it again and leave the account's unused.
   */
  let refusedOwnToken: string | null = null;
  const relayAppUserAuth = {
    auditLog: deps.appUserAuth.auditLog,
    /** `userRequested`: a person pressed Refresh, so a standing negative answer is asked again. */
    getValidTokenForRelay: async (opts: { userRequested?: boolean } = {}): Promise<string> => {
      let own: string;
      try {
        own = await deps.appUserAuth.getValidTokenForRelay();
      } catch (legacyError) {
        const token = await readToken({ force: opts.userRequested === true });
        if (token) return token;
        throw legacyError;
      }
      if (own !== refusedOwnToken) return own;
      // A refreshed own token is a new one, and is tried again.
      return (await readToken({ force: opts.userRequested === true })) ?? own;
    },
    /**
     * GitHub answered 401 to a relay token: this computer's own sign-in, or
     * the account's cached token after the account connected again elsewhere
     * (a Disconnect deleted the old one at GitHub). Asks the account
     * directory once for the current token (`onRejected`); null when there is
     * no other.
     */
    onTokenRejected: async (token: string, opts: { userRequested?: boolean } = {}): Promise<string | null> => {
      const replacement = await onRejected(token, opts);
      if (replacement && token === deps.appUserAuth.getStoredTokenForHealth()) refusedOwnToken = token;
      return replacement;
    },
  };

  return {
    enabled: client != null,
    client,
    readToken,
    peekToken,
    onRejected,
    clearNegative,
    purge,
    adoptLocalSignIn,
    retireLegacyToken,
    statusFor,
    relayAppUserAuth,
    /** The token the last inventory read got (for health bookkeeping). */
    lastToken: () => lastToken,
  };
}

export type GithubAccountAppCredential = ReturnType<typeof createGithubAccountAppCredential>;
