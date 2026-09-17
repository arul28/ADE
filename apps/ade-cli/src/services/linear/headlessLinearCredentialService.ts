import path from "node:path";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import type { AccountVaultBridge } from "../../../../desktop/src/main/services/account/accountVaultBridge";
import { describeVaultFailure, fireAndForgetVaultWrite } from "../../../../desktop/src/main/services/account/vaultWrite";
import { ADE_LINEAR_APP_CLIENT_ID, type LinearOAuthClientSource } from "../../../../desktop/src/main/services/cto/linearAppClient";
import type { createLinearCredentialService } from "../../../../desktop/src/main/services/cto/linearCredentialService";
import { createCredentialProvenanceStore } from "../../../../desktop/src/shared/credentialProvenanceStore";
import { deviceCredentialProvenance, type CredentialProvenance } from "../../../../desktop/src/shared/types/credentialProvenance";
import {
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

export function createHeadlessLinearCredentialService(args: {
  adeDir: string;
  logger?: Logger;
  getAccountVault?: () => AccountVaultBridge | null | undefined;
  getAccountUserId?: () => string | null;
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

  const logVaultFailure = (operation: string, detail: unknown): void => {
    args.logger?.warn("linear_sync.account_vault_sync_failed", {
      operation,
      error: describeVaultFailure(detail),
    });
  };

  const syncRefreshTokenToVault = (refreshToken: string): void => {
    fireAndForgetVaultWrite(
      {
        getAccountVault: args.getAccountVault,
        logger: args.logger,
        logEvent: "linear_sync.account_vault_sync_failed",
      },
      "set",
      (vault) => vault.set("all", "linear_refresh_token", "default", refreshToken),
    );
  };

  const removeRefreshTokenFromVault = (): void => {
    fireAndForgetVaultWrite(
      {
        getAccountVault: args.getAccountVault,
        logger: args.logger,
        logEvent: "linear_sync.account_vault_sync_failed",
      },
      "remove",
      (vault) => vault.remove("all", "linear_refresh_token", "default"),
    );
  };

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
    if (refreshInFlight) {
      await refreshInFlight;
      return;
    }
    const client = readOAuthClientCredentials();
    if (!client) return;
    refreshInFlight = (async () => {
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
          syncRefreshTokenToVault(nextRefreshToken);
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
          removeRefreshTokenFromVault();
        }
      };

      try {
        await withLinearOAuthRefreshLock(secretsDir, async () => {
          const latestRefresh = readCredential(refreshTokenKey);
          if (!latestRefresh) return;
          if (!opts?.force && !linearTokenNeedsRefresh(readCredential(tokenExpiresAtKey), Date.now())) return;
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
    const accountUserId = args.getAccountUserId?.()?.trim() || null;
    if (!accountUserId) return;

    try {
      if (readCredential(refreshTokenKey)) return;
      const { source } = readToken();
      const authMode = readCredential(authModeKey);
      // Manual and environment-provided credentials remain authoritative on
      // this machine; only an OAuth connection can accept a refresh grant.
      if (authMode && authMode !== "oauth") return;
      if (source === "env" || (source !== null && authMode !== "oauth")) return;
    } catch (error) {
      logVaultFailure("hydrate", error);
      return;
    }

    let vault: AccountVaultBridge | null | undefined;
    try {
      vault = args.getAccountVault?.() ?? null;
    } catch (error) {
      logVaultFailure("get", error);
      return;
    }
    if (!vault) return;

    let result: Awaited<ReturnType<AccountVaultBridge["get"]>>;
    try {
      result = await vault.get("all", "linear_refresh_token", "default");
    } catch (error) {
      logVaultFailure("get", error);
      return;
    }
    if (!result.ok) {
      logVaultFailure("get", result);
      return;
    }
    const refreshToken = result.value?.trim() ?? "";
    if (!refreshToken.length) return;
    if ((args.getAccountUserId?.()?.trim() || null) !== accountUserId) return;

    try {
      if (readCredential(refreshTokenKey)) return;
      const { source } = readToken();
      const authMode = readCredential(authModeKey);
      if (source === "env" || (source !== null && authMode !== "oauth")) return;
      setCredentialProvenance(refreshTokenKey, accountProvenance(accountUserId));
      writeCredential(authModeKey, "oauth");
      writeCredential(refreshTokenKey, refreshToken);
    } catch (error) {
      logVaultFailure("hydrate", error);
    }
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
      const authMode = source === "env"
        ? "manual"
        : storedAuthMode === "oauth"
          && (source === "stored" || source === "override" || refreshTokenStored)
          ? "oauth"
          : token.trim().length > 0
            ? "manual"
            : null;
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
      };
    },
    getTokenOrThrow() {
      const { token } = readToken();
      if (!token.trim()) {
        throw new Error(
          "Linear token missing. Set ADE_LINEAR_API, LINEAR_API_KEY, ADE_LINEAR_TOKEN, or LINEAR_TOKEN for headless mode.",
        );
      }
      return token.trim();
    },
    setToken(nextToken: string) {
      tokenOverride = nextToken.trim();
      writeCredential(tokenKey, tokenOverride);
      writeCredential(authModeKey, "manual");
      writeCredential(refreshTokenKey, null);
      writeCredential(tokenExpiresAtKey, null);
      setCredentialProvenance(tokenKey, deviceCredentialProvenance());
      deleteCredentialProvenance(refreshTokenKey);
      removeRefreshTokenFromVault();
    },
    setOAuthToken(args: {
      accessToken: string;
      refreshToken?: string | null;
      expiresAt?: string | null;
    }) {
      tokenOverride = args.accessToken.trim();
      writeCredential(tokenKey, tokenOverride);
      writeCredential(authModeKey, "oauth");
      writeCredential(refreshTokenKey, args.refreshToken);
      writeCredential(tokenExpiresAtKey, args.expiresAt);
      setCredentialProvenance(tokenKey, deviceCredentialProvenance());
      if (args.refreshToken?.trim()) {
        setCredentialProvenance(refreshTokenKey, deviceCredentialProvenance());
        syncRefreshTokenToVault(args.refreshToken.trim());
      } else {
        deleteCredentialProvenance(refreshTokenKey);
        removeRefreshTokenFromVault();
      }
    },
    clearToken() {
      tokenOverride = "";
      writeCredential(tokenKey, null);
      writeCredential(authModeKey, null);
      writeCredential(refreshTokenKey, null);
      writeCredential(tokenExpiresAtKey, null);
      deleteCredentialProvenance(tokenKey);
      deleteCredentialProvenance(refreshTokenKey);
      removeRefreshTokenFromVault();
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
