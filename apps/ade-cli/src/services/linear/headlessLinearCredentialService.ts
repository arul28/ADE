import path from "node:path";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import type { AccountVaultBridge } from "../../../../desktop/src/main/services/account/accountVaultBridge";
import {
  createLinearAccountSync,
  type LinearAccountCredential,
} from "../../../../desktop/src/main/services/cto/linearAccountSync";
import { ADE_LINEAR_APP_CLIENT_ID, type LinearOAuthClientSource } from "../../../../desktop/src/main/services/cto/linearAppClient";
import type { createLinearCredentialService } from "../../../../desktop/src/main/services/cto/linearCredentialService";
import { createCredentialProvenanceStore } from "../../../../desktop/src/shared/credentialProvenanceStore";
import { deviceCredentialProvenance, type CredentialProvenance } from "../../../../desktop/src/shared/types/credentialProvenance";
import {
  LINEAR_REFRESH_OWNER_RECHECK_MS,
  linearInvalidGrantLikelyStaleRotation,
  linearTokenNeedsRefresh,
  refreshLinearOAuthAccessToken,
} from "../../../../desktop/src/main/services/cto/linearTokenRefresh";
import {
  LinearOAuthRefreshLockTimeoutError,
  withLinearOAuthRefreshLock,
} from "../../../../desktop/src/main/services/cto/linearOAuthRefreshLock";
import { EncryptedFileCredentialStore } from "../credentials/credentialStore";

// Keep headless runtimes aligned with the desktop credential service so packaged
// alpha builds can offer the same PKCE-based Linear sign-in flow.
const BUNDLED_LINEAR_OAUTH_CLIENT_ID =
  process.env.ADE_LINEAR_CLIENT_ID?.trim() || ADE_LINEAR_APP_CLIENT_ID;
const LINEAR_PROVENANCE_KEY = "linear.credentialProvenance.v1";

function envToken(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name]?.trim() ?? "";
    if (value.length) return value;
  }
  return null;
}

export type HeadlessLinearCredentialService = ReturnType<typeof createLinearCredentialService>;

/**
 * Which auth mode a headless project is effectively in, in precedence order:
 * an environment token is always manual; a stored OAuth mode counts only when
 * a stored/override token or a refresh token backs it; any other token is
 * manual; no token is no mode.
 */
function resolveAuthMode(args: {
  source: "stored" | "env" | "override" | null;
  storedAuthMode: string | null | undefined;
  refreshTokenStored: boolean;
  hasToken: boolean;
}): "oauth" | "manual" | null {
  if (args.source === "env") return "manual";
  if (
    args.storedAuthMode === "oauth"
    && (args.source === "stored" || args.source === "override" || args.refreshTokenStored)
  ) {
    return "oauth";
  }
  if (args.hasToken) return "manual";
  return null;
}

export function createHeadlessLinearCredentialService(args: {
  adeDir: string;
  logger?: Logger;
  getAccountVault?: () => AccountVaultBridge | null | undefined;
  getAccountUserId?: () => string | null;
  getDeviceId?: () => string | null;
}): HeadlessLinearCredentialService {
  const secretsDir = path.join(args.adeDir, "secrets");
  const credentialStore = new EncryptedFileCredentialStore({
    secretsDir,
  });
  const tokenKey = "linear.token.v1";
  const authModeKey = "linear.authMode.v1";
  const tokenExpiresAtKey = "linear.tokenExpiresAt.v1";
  const refreshTokenKey = "linear.refreshToken.v1";
  const oauthClientKey = "linear.oauthClient.v1";
  let tokenOverride: string | null = null;
  let tokenDecryptionFailed = false;
  /** Until when another machine is known to own the refresh grant (see LINEAR_REFRESH_OWNER_RECHECK_MS). */
  let refreshOwnedElsewhereUntilMs = 0;

  const readCredential = (key: string): string | null => {
    try {
      const stored = credentialStore.getSync(key);
      tokenDecryptionFailed = false;
      return stored?.trim() || null;
    } catch {
      tokenDecryptionFailed = true;
      return null;
    }
  };

  const writeCredential = (
    key: string,
    value: string | null | undefined,
  ): void => {
    if (value?.trim()) {
      credentialStore.setSync(key, value.trim());
    } else {
      credentialStore.deleteSync(key);
    }
    tokenDecryptionFailed = false;
  };

  const provenanceStore = createCredentialProvenanceStore({
    read: () => readCredential(LINEAR_PROVENANCE_KEY),
    write: (value) => writeCredential(LINEAR_PROVENANCE_KEY, value),
  });
  const setCredentialProvenance = provenanceStore.set;
  const deleteCredentialProvenance = provenanceStore.remove;
  const getCredentialProvenance = provenanceStore.get;

  const accountProvenance = (accountUserId?: string | null): CredentialProvenance => {
    const normalized = accountUserId?.trim() || args.getAccountUserId?.()?.trim() || "";
    return normalized
      ? { source: "account", accountUserId: normalized }
      : deviceCredentialProvenance();
  };

  const readStoredCredential = (): LinearAccountCredential | null => {
    const token = readCredential(tokenKey);
    if (!token) return null;
    const authMode = readCredential(authModeKey) === "oauth" ? "oauth" : "manual";
    return {
      token,
      authMode,
      refreshToken: authMode === "oauth" ? readCredential(refreshTokenKey) : null,
      expiresAt: authMode === "oauth" ? readCredential(tokenExpiresAtKey) : null,
    };
  };

  const writeStoredCredential = (record: LinearAccountCredential | null): void => {
    tokenOverride = record ? record.token : "";
    writeCredential(tokenKey, record?.token ?? null);
    writeCredential(authModeKey, record?.authMode ?? null);
    writeCredential(refreshTokenKey, record?.authMode === "oauth" ? record.refreshToken : null);
    writeCredential(tokenExpiresAtKey, record?.authMode === "oauth" ? record.expiresAt : null);
  };

  const accountSync = createLinearAccountSync({
    projectRoot: path.dirname(args.adeDir),
    getAccountVault: args.getAccountVault,
    getAccountUserId: args.getAccountUserId,
    getDeviceId: args.getDeviceId,
    logger: args.logger,
    readLocal: readStoredCredential,
    localIsFromAccount: () => getCredentialProvenance(tokenKey).source === "account",
    hasEnvToken: () => envToken("ADE_LINEAR_API", "LINEAR_API_KEY", "ADE_LINEAR_TOKEN", "LINEAR_TOKEN") !== null,
    writeFromAccount: (record, accountUserId) => {
      // Ownership first, so a failed value write cannot leave an account
      // credential that looks like this device's own.
      const provenance = accountProvenance(accountUserId);
      setCredentialProvenance(tokenKey, provenance);
      if (record.authMode === "oauth" && record.refreshToken) setCredentialProvenance(refreshTokenKey, provenance);
      else deleteCredentialProvenance(refreshTokenKey);
      writeStoredCredential(record);
      refreshOwnedElsewhereUntilMs = 0;
    },
    clearFromAccount: () => {
      writeStoredCredential(null);
      deleteCredentialProvenance(tokenKey);
      deleteCredentialProvenance(refreshTokenKey);
    },
  });

  const readToken = (): {
    token: string;
    source: "stored" | "env" | "override" | null;
  } => {
    if (tokenOverride != null) {
      return {
        token: tokenOverride,
        source: tokenOverride.trim().length > 0 ? "override" : null,
      };
    }
    const stored = readCredential(tokenKey);
    if (stored) return { token: stored, source: "stored" };
    const envValue =
      envToken(
        "ADE_LINEAR_API",
        "LINEAR_API_KEY",
        "ADE_LINEAR_TOKEN",
        "LINEAR_TOKEN",
      ) ?? "";
    return {
      token: envValue,
      source: envValue.trim().length > 0 ? "env" : null,
    };
  };

  const readOAuthClientCredentials = (): {
    clientId: string;
    clientSecret: string | null;
  } | null => {
    const raw = readCredential(oauthClientKey);
    if (!raw) {
      return BUNDLED_LINEAR_OAUTH_CLIENT_ID
        ? { clientId: BUNDLED_LINEAR_OAUTH_CLIENT_ID, clientSecret: null }
        : null;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const record = parsed as Record<string, unknown>;
      const clientId = typeof record.clientId === "string" ? record.clientId.trim() : "";
      if (!clientId) return null;
      return {
        clientId,
        clientSecret:
          typeof record.clientSecret === "string" && record.clientSecret.trim().length > 0
            ? record.clientSecret.trim()
            : null,
      };
    } catch {
      return null;
    }
  };

  // Refresh an OAuth access token near expiry (parity with the desktop service)
  // so headless `ade serve` Linear connections survive past Linear's ~24h token
  // lifetime. No-op for manual tokens / env tokens / when no refresh token.
  let refreshInFlight: Promise<void> | null = null;
  const ensureFreshToken = async (opts?: { force?: boolean }): Promise<void> => {
    if (readToken().source === "env") return;
    if (readCredential(authModeKey) !== "oauth") return;
    const refreshToken = readCredential(refreshTokenKey);
    if (!refreshToken) return;
    if (!opts?.force && !linearTokenNeedsRefresh(readCredential(tokenExpiresAtKey), Date.now())) return;
    // A forced refresh follows a 401, which is worth asking the vault about again.
    if (!opts?.force && Date.now() < refreshOwnedElsewhereUntilMs) return;
    if (refreshInFlight) {
      await refreshInFlight;
      return;
    }
    const client = readOAuthClientCredentials();
    if (!client) return;
    refreshInFlight = (async () => {
      const stored = readStoredCredential();
      const plan = stored ? await accountSync.planRefresh(stored) : { renew: true, publish: false };
      if (!plan.renew) {
        refreshOwnedElsewhereUntilMs = Date.now() + LINEAR_REFRESH_OWNER_RECHECK_MS;
        args.logger?.info("linear_sync.oauth_refresh_skipped_other_owner", {});
        return;
      }
      const performRefresh = async (tokenToRefresh: string): Promise<void> => {
        const result = await refreshLinearOAuthAccessToken({
          refreshToken: tokenToRefresh,
          clientId: client.clientId,
          clientSecret: client.clientSecret,
        });
        if (result.ok) {
          tokenOverride = result.accessToken;
          writeCredential(tokenKey, result.accessToken);
          writeCredential(authModeKey, "oauth");
          const nextRefreshToken = result.refreshToken ?? tokenToRefresh;
          writeCredential(refreshTokenKey, nextRefreshToken);
          writeCredential(tokenExpiresAtKey, result.expiresAt);
          // The owner publishes each turn before the lock opens, so a sibling
          // process here (or another machine) reads it instead of exchanging.
          if (plan.publish) {
            await accountSync.publishNow({ token: result.accessToken, authMode: "oauth", refreshToken: nextRefreshToken, expiresAt: result.expiresAt });
          }
          return;
        }
        if (result.invalidGrant) {
          const rereadRefresh = readCredential(refreshTokenKey);
          const rereadExpires = readCredential(tokenExpiresAtKey);
          if (
            linearInvalidGrantLikelyStaleRotation({
              attemptedRefreshToken: tokenToRefresh,
              rereadRefreshToken: rereadRefresh,
              rereadExpiresAt: rereadExpires,
              trustFreshExpiresAt: !opts?.force,
            })
          ) {
            tokenOverride = readCredential(tokenKey);
            return;
          }
          tokenOverride = "";
          writeCredential(tokenKey, null);
          writeCredential(authModeKey, null);
          writeCredential(refreshTokenKey, null);
          writeCredential(tokenExpiresAtKey, null);
          deleteCredentialProvenance(tokenKey);
          deleteCredentialProvenance(refreshTokenKey);
          // Only the owner of a shared grant may say it is dead everywhere.
          if (plan.publish) accountSync.publish(null);
        }
      };

      try {
        await withLinearOAuthRefreshLock(secretsDir, async () => {
          const latestRefresh = readCredential(refreshTokenKey);
          if (!latestRefresh) return;
          if (!opts?.force && !linearTokenNeedsRefresh(readCredential(tokenExpiresAtKey), Date.now())) return;
          const latest = readStoredCredential();
          if (latest && await accountSync.adoptNewerTurn(latest)) return;
          await performRefresh(latestRefresh);
        });
      } catch (error: unknown) {
        if (!(error instanceof LinearOAuthRefreshLockTimeoutError)) throw error;
        args.logger?.warn("linear_sync.oauth_refresh_lock_timeout", {
          message: error.message,
        });
      }
    })().finally(() => {
      refreshInFlight = null;
    });
    await refreshInFlight;
  };

  const hydrateFromVault = async (): Promise<void> => {
    await accountSync.hydrate();
    // An adopted or republished connection can change who renews; ask again.
    refreshOwnedElsewhereUntilMs = 0;
  };

  return {
    getToken() {
      const { token } = readToken();
      return token.trim() || null;
    },
    getRefreshToken() {
      if (readToken().source === "env") return null;
      return readCredential(authModeKey) === "oauth" ? readCredential(refreshTokenKey) : null;
    },
    getRefreshTokenProvenance() {
      return getCredentialProvenance(refreshTokenKey);
    },
    getStatus() {
      const { token, source } = readToken();
      const storedAuthMode = readCredential(authModeKey);
      const refreshTokenStored = Boolean(readCredential(refreshTokenKey));
      const authMode = resolveAuthMode({ source, storedAuthMode, refreshTokenStored, hasToken: token.trim().length > 0 });
      return {
        tokenStored: token.trim().length > 0,
        tokenDecryptionFailed,
        storageScope: "app",
        repo: null,
        userLogin: null,
        scopes: [],
        checkedAt: token.trim().length > 0 ? new Date().toISOString() : null,
        authMode,
        tokenExpiresAt: readCredential(tokenExpiresAtKey),
        refreshTokenStored,
        // The bundled ADE app client makes OAuth always available; a custom
        // client (if configured) takes precedence over it.
        oauthConfigured: true,
        credentialStorage: accountSync.storage(),
      };
    },
    getTokenOrThrow() {
      const { token } = readToken();
      if (!token.trim()) {
        throw new Error(
          "Linear token missing. Connect Linear in Settings > Linear, or set ADE_LINEAR_API, LINEAR_API_KEY, ADE_LINEAR_TOKEN, or LINEAR_TOKEN for headless mode.",
        );
      }
      return token.trim();
    },
    setToken(nextToken: string) {
      refreshOwnedElsewhereUntilMs = 0;
      tokenOverride = nextToken.trim();
      writeCredential(tokenKey, tokenOverride);
      writeCredential(authModeKey, "manual");
      writeCredential(refreshTokenKey, null);
      writeCredential(tokenExpiresAtKey, null);
      setCredentialProvenance(tokenKey, deviceCredentialProvenance());
      deleteCredentialProvenance(refreshTokenKey);
      accountSync.publish(tokenOverride ? { token: tokenOverride, authMode: "manual", refreshToken: null, expiresAt: null } : null);
    },
    setOAuthToken(args: {
      accessToken: string;
      refreshToken?: string | null;
      expiresAt?: string | null;
    }) {
      refreshOwnedElsewhereUntilMs = 0;
      tokenOverride = args.accessToken.trim();
      writeCredential(tokenKey, tokenOverride);
      writeCredential(authModeKey, "oauth");
      writeCredential(refreshTokenKey, args.refreshToken);
      writeCredential(tokenExpiresAtKey, args.expiresAt);
      setCredentialProvenance(tokenKey, deviceCredentialProvenance());
      if (args.refreshToken?.trim()) {
        setCredentialProvenance(refreshTokenKey, deviceCredentialProvenance());
      } else {
        deleteCredentialProvenance(refreshTokenKey);
      }
      // A sign-in here makes this machine the one that renews the grant.
      accountSync.publish(tokenOverride ? {
        token: tokenOverride,
        authMode: "oauth",
        refreshToken: args.refreshToken?.trim() || null,
        expiresAt: args.expiresAt?.trim() || null,
      } : null);
    },
    clearToken() {
      refreshOwnedElsewhereUntilMs = 0;
      tokenOverride = "";
      writeCredential(tokenKey, null);
      writeCredential(authModeKey, null);
      writeCredential(refreshTokenKey, null);
      writeCredential(tokenExpiresAtKey, null);
      deleteCredentialProvenance(tokenKey);
      deleteCredentialProvenance(refreshTokenKey);
      accountSync.publish(null);
    },
    hydrateFromVault,
    setOAuthClientCredentials(args: {
      clientId: string;
      clientSecret?: string | null;
    }) {
      const clientId = args.clientId.trim();
      if (!clientId.length) {
        throw new Error("A Linear OAuth client ID is required.");
      }
      writeCredential(
        oauthClientKey,
        JSON.stringify({
          clientId,
          clientSecret: args.clientSecret?.trim() || null,
        }),
      );
    },
    clearOAuthClientCredentials() {
      writeCredential(oauthClientKey, null);
    },
    purgeAccountCredentials() {
      const tokenSource = getCredentialProvenance(tokenKey);
      const refreshSource = getCredentialProvenance(refreshTokenKey);
      if (tokenSource.source === "account") {
        tokenOverride = "";
        writeCredential(tokenKey, null);
        writeCredential(authModeKey, null);
        writeCredential(tokenExpiresAtKey, null);
        deleteCredentialProvenance(tokenKey);
      }
      if (refreshSource.source === "account") {
        writeCredential(refreshTokenKey, null);
        deleteCredentialProvenance(refreshTokenKey);
      }
    },
    getOAuthClientCredentials() {
      // Resolution order lives in readOAuthClientCredentials: user-configured
      // client, then the bundled ADE Linear app (PKCE — no secret ships).
      return readOAuthClientCredentials();
    },
    getOAuthClientSource(): LinearOAuthClientSource {
      // Compare by client id, not by which branch resolved: the bundled id is
      // the ADE app even when a user pasted it in as a "custom" client.
      return readOAuthClientCredentials()?.clientId === BUNDLED_LINEAR_OAUTH_CLIENT_ID ? "ade-app" : "custom";
    },
    ensureFreshToken,
  };
}
