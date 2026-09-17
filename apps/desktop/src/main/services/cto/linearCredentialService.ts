import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { safeStorage } from "electron";
import type { Logger } from "../logging/logger";
import type { AccountVaultBridge } from "../account/accountVaultBridge";
import {
  describeVaultFailure,
  fireAndForgetVaultWrite,
} from "../account/vaultWrite";
import {
  LINEAR_REFRESH_VAULT_KEY,
  LINEAR_REFRESH_VAULT_KIND,
  LINEAR_REFRESH_VAULT_SCOPE,
  linearRefreshVaultWriteOptions,
  thisDeviceOwnsLinearRefreshGrant,
} from "../account/linearVaultRefreshOwner";
import { ADE_LINEAR_APP_CLIENT_ID, type LinearOAuthClientSource } from "./linearAppClient";
import {
  deviceCredentialProvenance,
  type CredentialProvenance,
} from "../../../shared/types/credentialProvenance";
import { createCredentialProvenanceStore } from "../../../shared/credentialProvenanceStore";
import { isRecord, getErrorMessage, isEnoentError } from "../shared/utils";
import type { SyncCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import {
  linearInvalidGrantLikelyStaleRotation,
  linearTokenNeedsRefresh,
  refreshLinearOAuthAccessToken,
} from "./linearTokenRefresh";
import {
  LinearOAuthRefreshLockTimeoutError,
  withLinearOAuthRefreshLock,
} from "./linearOAuthRefreshLock";
import { writeFileAtomic } from "../state/durableFile";

// Bundled OAuth client ID — ships with ADE so users get "Sign in with Linear"
// out of the box without configuring their own OAuth app.
// This is a public value (visible in the auth URL); no secret is bundled (we use PKCE).
const BUNDLED_LINEAR_OAUTH_CLIENT_ID: string | null =
  process.env.ADE_LINEAR_CLIENT_ID || ADE_LINEAR_APP_CLIENT_ID;

const TOKEN_FILE = "linear-token.v1.bin";
const OAUTH_CLIENT_FILE = "linear-oauth-client.v1.bin";
const PROVENANCE_FILE = "linear-credential-provenance.v1.bin";
const IMPORT_SENTINEL = "linear-token.imported.v1";
const MACHINE_TOKEN_KEY = "linear.token.v1";
const MACHINE_AUTH_MODE_KEY = "linear.authMode.v1";
const MACHINE_TOKEN_EXPIRES_AT_KEY = "linear.tokenExpiresAt.v1";
const MACHINE_REFRESH_TOKEN_KEY = "linear.refreshToken.v1";
const MACHINE_OAUTH_CLIENT_KEY = "linear.oauthClient.v1";
const MACHINE_PROVENANCE_KEY = "linear.credentialProvenance.v1";
const MACHINE_LEGACY_PROJECTS_MIGRATED_KEY = "linear.legacy_projects_migrated.v1";
const OAUTH_CONFIG_FILES = [
  "linear-oauth.v1.json",
  "linear-oauth.json",
  "linear-oauth.v1.yaml",
  "linear-oauth.yaml",
  "linear-oauth.yml",
] as const;
const ENV_LINEAR_TOKEN_KEYS = ["ADE_LINEAR_API", "LINEAR_API_KEY", "ADE_LINEAR_TOKEN", "LINEAR_TOKEN"] as const;

type LinearCredentialServiceArgs = {
  adeDir: string;
  logger?: Logger | null;
  credentialStore?: SyncCredentialStore | null;
  getAccountVault?: () => AccountVaultBridge | null | undefined;
  getAccountUserId?: () => string | null;
  getDeviceId?: () => string | null;
  fetchImpl?: typeof fetch;
};

type StoredLinearToken = {
  token: string;
  authMode?: "manual" | "oauth" | null;
  refreshToken?: string | null;
  expiresAt?: string | null;
};

type LinearOAuthClientCredentials = {
  clientId: string;
  clientSecret?: string | null;
};

function extractLegacyToken(raw: string): string | null {
  try {
    const parsed = YAML.parse(raw);
    if (!isRecord(parsed)) return null;
    const linear = isRecord(parsed.linear) ? parsed.linear : null;
    if (!linear) return null;
    let token = "";
    if (typeof linear.token === "string") {
      token = linear.token.trim();
    } else if (typeof linear.apiKey === "string") {
      token = linear.apiKey.trim();
    }
    return token.length ? token : null;
  } catch {
    return null;
  }
}

export function createLinearCredentialService(args: LinearCredentialServiceArgs) {
  const secretsDir = path.join(args.adeDir, "secrets");
  const tokenPath = path.join(secretsDir, TOKEN_FILE);
  const oauthClientPath = path.join(secretsDir, OAUTH_CLIENT_FILE);
  const importSentinelPath = path.join(secretsDir, IMPORT_SENTINEL);
  const credentialStore = args.credentialStore ?? null;

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
      (vault) => {
        const options = linearRefreshVaultWriteOptions(args.getDeviceId);
        return options
          ? vault.set(
            LINEAR_REFRESH_VAULT_SCOPE,
            LINEAR_REFRESH_VAULT_KIND,
            LINEAR_REFRESH_VAULT_KEY,
            refreshToken,
            options,
          )
          : vault.set(
            LINEAR_REFRESH_VAULT_SCOPE,
            LINEAR_REFRESH_VAULT_KIND,
            LINEAR_REFRESH_VAULT_KEY,
            refreshToken,
          );
      },
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
      (vault) => vault.remove(
        LINEAR_REFRESH_VAULT_SCOPE,
        LINEAR_REFRESH_VAULT_KIND,
        LINEAR_REFRESH_VAULT_KEY,
      ),
    );
  };

  const unlinkIfExists = (filePath: string): void => {
    try {
      fs.unlinkSync(filePath);
    } catch (error: unknown) {
      if (isEnoentError(error)) return;
      args.logger?.warn("linear_sync.legacy_credential_cleanup_failed", {
        filePath,
        error: getErrorMessage(error),
      });
    }
  };

  const readEnvToken = (): string | null => {
    for (const key of ENV_LINEAR_TOKEN_KEYS) {
      const value = (process.env[key] ?? "").trim();
      if (value.length > 0) return value;
    }
    return null;
  };

  const normalizeStoredToken = (value: unknown): StoredLinearToken | null => {
    if (!isRecord(value)) return null;
    const token = typeof value.token === "string" ? value.token.trim() : "";
    if (!token.length) return null;
    return {
      token,
      authMode: value.authMode === "manual" || value.authMode === "oauth" ? value.authMode : null,
      refreshToken:
        typeof value.refreshToken === "string" && value.refreshToken.trim().length > 0
          ? value.refreshToken.trim()
          : null,
      expiresAt:
        typeof value.expiresAt === "string" && value.expiresAt.trim().length > 0
          ? value.expiresAt.trim()
          : null,
    };
  };

  const readEncryptedToken = (): StoredLinearToken | null => {
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        args.logger?.warn("linear_sync.token_store_unavailable", {
          message: "OS secure storage unavailable; cannot decrypt Linear token."
        });
        return null;
      }
      const encrypted = fs.readFileSync(tokenPath);
      const decrypted = safeStorage.decryptString(encrypted);
      const parsed = JSON.parse(decrypted) as StoredLinearToken;
      return normalizeStoredToken(parsed);
    } catch (error: unknown) {
      if (isEnoentError(error)) return null;
      args.logger?.warn("linear_sync.token_store_read_failed", {
        error: getErrorMessage(error)
      });
      return null;
    }
  };

  const normalizeOAuthClientCredentials = (value: unknown): LinearOAuthClientCredentials | null => {
    if (!isRecord(value)) return null;
    const rawClientId = typeof value.clientId === "string" ? value.clientId : typeof value.client_id === "string" ? value.client_id : "";
    const clientId = rawClientId.trim();
    if (!clientId.length) return null;
    const rawSecret = typeof value.clientSecret === "string" ? value.clientSecret : typeof value.client_secret === "string" ? value.client_secret : "";
    const clientSecret = rawSecret.trim();
    return {
      clientId,
      clientSecret: clientSecret.length ? clientSecret : null,
    };
  };

  const readStoredOAuthClientCredentials = (): LinearOAuthClientCredentials | null => {
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        args.logger?.warn("linear_sync.oauth_client_store_unavailable", {
          message: "OS secure storage unavailable; cannot decrypt Linear OAuth client config."
        });
        return null;
      }
      const encrypted = fs.readFileSync(oauthClientPath);
      const decrypted = safeStorage.decryptString(encrypted);
      return normalizeOAuthClientCredentials(JSON.parse(decrypted));
    } catch (error: unknown) {
      if (isEnoentError(error)) return null;
      args.logger?.warn("linear_sync.oauth_client_store_read_failed", {
        error: getErrorMessage(error)
      });
      return null;
    }
  };

  const readMachineCredential = (key: string): string | null => {
    if (!credentialStore) return null;
    try {
      return credentialStore.getSync(key)?.trim() || null;
    } catch (error: unknown) {
      args.logger?.warn("linear_sync.machine_credential_read_failed", {
        key,
        error: getErrorMessage(error),
      });
      return null;
    }
  };

  const writeMachineCredential = (key: string, value: string | null | undefined): void => {
    if (!credentialStore) return;
    try {
      if (value?.trim()) {
        credentialStore.setSync(key, value.trim());
      } else {
        credentialStore.deleteSync(key);
      }
    } catch (error: unknown) {
      args.logger?.warn("linear_sync.machine_credential_write_failed", {
        key,
        error: getErrorMessage(error),
      });
      throw error;
    }
  };

  const provenanceStore = createCredentialProvenanceStore({
    read: () => {
      if (credentialStore) return readMachineCredential(MACHINE_PROVENANCE_KEY);
      const provenancePath = path.join(secretsDir, PROVENANCE_FILE);
      if (!fs.existsSync(provenancePath) || !safeStorage.isEncryptionAvailable()) return null;
      return safeStorage.decryptString(fs.readFileSync(provenancePath));
    },
    write: (value) => {
      if (credentialStore) {
        writeMachineCredential(MACHINE_PROVENANCE_KEY, value);
        return;
      }
      if (!safeStorage.isEncryptionAvailable()) return;
      fs.mkdirSync(secretsDir, { recursive: true });
      writeFileAtomic(
        path.join(secretsDir, PROVENANCE_FILE),
        safeStorage.encryptString(value),
        { mode: 0o600 },
      );
    },
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

  const readMachineToken = (): StoredLinearToken | null => {
    const token = readMachineCredential(MACHINE_TOKEN_KEY);
    if (!token) return null;
    const authMode = readMachineCredential(MACHINE_AUTH_MODE_KEY);
    return {
      token,
      authMode: authMode === "oauth" ? "oauth" : "manual",
      refreshToken: readMachineCredential(MACHINE_REFRESH_TOKEN_KEY),
      expiresAt: readMachineCredential(MACHINE_TOKEN_EXPIRES_AT_KEY),
    };
  };

  const readMachineOAuthClientCredentials = (): LinearOAuthClientCredentials | null => {
    const raw = readMachineCredential(MACHINE_OAUTH_CLIENT_KEY);
    if (!raw) return null;
    try {
      return normalizeOAuthClientCredentials(JSON.parse(raw));
    } catch {
      return null;
    }
  };

  const readMigratedProjectRoots = (): Set<string> => {
    const raw = readMachineCredential(MACHINE_LEGACY_PROJECTS_MIGRATED_KEY);
    if (!raw) return new Set();
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return new Set();
      return new Set(
        parsed
          .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          .map((entry) => path.resolve(entry)),
      );
    } catch {
      return new Set();
    }
  };

  const markProjectMigrated = (): void => {
    if (!credentialStore) return;
    const roots = readMigratedProjectRoots();
    roots.add(path.resolve(path.dirname(args.adeDir)));
    writeMachineCredential(MACHINE_LEGACY_PROJECTS_MIGRATED_KEY, JSON.stringify(Array.from(roots).sort()));
  };

  const readOAuthConfigFileCredentials = (): LinearOAuthClientCredentials | null => {
    for (const filename of OAUTH_CONFIG_FILES) {
      const configPath = path.join(secretsDir, filename);
      try {
        const raw = fs.readFileSync(configPath, "utf8");
        const parsed = filename.endsWith(".json") ? JSON.parse(raw) : YAML.parse(raw);
        const credentials = normalizeOAuthClientCredentials(parsed);
        if (credentials) return credentials;
      } catch (error: unknown) {
        if (isEnoentError(error)) {
          continue;
        }
        args.logger?.warn("linear_sync.oauth_config_read_failed", {
          filename,
          error: getErrorMessage(error),
        });
      }
    }
    return null;
  };

  const persistMachineTokenLocally = (
    record: StoredLinearToken | null,
    source: CredentialProvenance = deviceCredentialProvenance(),
    refreshSource: CredentialProvenance = source,
  ): void => {
    const hasToken = Boolean(record?.token?.trim());
    const hasRefreshToken = Boolean(record?.refreshToken?.trim());
    // The ownership record must land before an account-origin value. If a
    // later credential write fails, the stale metadata is conservative (it
    // cannot be migrated as a device value), while the reverse ordering would
    // leave an account credential eligible for migration.
    if (hasToken && source.source === "account") setCredentialProvenance(MACHINE_TOKEN_KEY, source);
    if (hasRefreshToken && refreshSource.source === "account") {
      setCredentialProvenance(MACHINE_REFRESH_TOKEN_KEY, refreshSource);
    }
    writeMachineCredential(MACHINE_TOKEN_KEY, record?.token ?? null);
    writeMachineCredential(MACHINE_AUTH_MODE_KEY, record?.authMode ?? null);
    writeMachineCredential(MACHINE_REFRESH_TOKEN_KEY, record?.refreshToken ?? null);
    writeMachineCredential(MACHINE_TOKEN_EXPIRES_AT_KEY, record?.expiresAt ?? null);
    if (hasToken) {
      if (source.source !== "account") setCredentialProvenance(MACHINE_TOKEN_KEY, source);
    } else {
      deleteCredentialProvenance(MACHINE_TOKEN_KEY);
    }
    if (hasRefreshToken) {
      if (refreshSource.source !== "account") {
        setCredentialProvenance(MACHINE_REFRESH_TOKEN_KEY, refreshSource);
      }
    } else {
      deleteCredentialProvenance(MACHINE_REFRESH_TOKEN_KEY);
    }
  };

  const persistMachineOAuthClientCredentials = (
    record: LinearOAuthClientCredentials | null,
    source: CredentialProvenance = deviceCredentialProvenance(),
  ): void => {
    if (!record?.clientId?.trim()) {
      writeMachineCredential(MACHINE_OAUTH_CLIENT_KEY, null);
      deleteCredentialProvenance(MACHINE_OAUTH_CLIENT_KEY);
      return;
    }
    writeMachineCredential(MACHINE_OAUTH_CLIENT_KEY, JSON.stringify({
      clientId: record.clientId.trim(),
      clientSecret: record.clientSecret?.trim() || null,
    }));
    setCredentialProvenance(MACHINE_OAUTH_CLIENT_KEY, source);
  };

  const migrateLegacyProjectCredentialsIfNeeded = (): void => {
    if (!credentialStore) return;
    const projectRoot = path.resolve(path.dirname(args.adeDir));
    const migratedRoots = readMigratedProjectRoots();
    if (migratedRoots.has(projectRoot)) return;
    const hadEncryptedLegacyStore = fs.existsSync(tokenPath) || fs.existsSync(oauthClientPath);

    if (!readMachineToken()) {
      const legacyToken = readEncryptedToken();
      if (legacyToken) {
        persistToken(legacyToken);
        unlinkIfExists(tokenPath);
      } else {
        const legacyPath = path.join(args.adeDir, "local.secret.yaml");
        try {
          const raw = fs.readFileSync(legacyPath, "utf8");
          const token = extractLegacyToken(raw);
          if (token) {
            persistToken({ token, authMode: "manual" });
          }
        } catch (error: unknown) {
          if (!isEnoentError(error)) {
            args.logger?.warn("linear_sync.token_import_failed", {
              legacyPath,
              error: getErrorMessage(error),
            });
          }
        }
      }
    }

    if (!readMachineOAuthClientCredentials()) {
      const legacyOAuth = readStoredOAuthClientCredentials() ?? readOAuthConfigFileCredentials();
      if (legacyOAuth) {
        persistMachineOAuthClientCredentials(legacyOAuth);
        unlinkIfExists(oauthClientPath);
      }
    }

    if (!hadEncryptedLegacyStore || safeStorage.isEncryptionAvailable()) {
      markProjectMigrated();
    }
  };

  const persistTokenLocally = (
    record: StoredLinearToken | null,
    source: CredentialProvenance = deviceCredentialProvenance(),
    refreshSource: CredentialProvenance = source,
  ): void => {
    if (credentialStore) {
      persistMachineTokenLocally(record, source, refreshSource);
      unlinkIfExists(tokenPath);
      return;
    }

    const token = record?.token?.trim() ?? "";
    if (!token.length) {
      try {
        fs.unlinkSync(tokenPath);
      } catch {
        // best effort — file may not exist
      }
      deleteCredentialProvenance(MACHINE_TOKEN_KEY);
      deleteCredentialProvenance(MACHINE_REFRESH_TOKEN_KEY);
      return;
    }

    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS secure storage is unavailable. Cannot store Linear token.");
    }

    if (source.source === "account") setCredentialProvenance(MACHINE_TOKEN_KEY, source);
    if (refreshSource.source === "account" && record?.refreshToken?.trim()) {
      setCredentialProvenance(MACHINE_REFRESH_TOKEN_KEY, refreshSource);
    }
    fs.mkdirSync(secretsDir, { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify({
      token,
      authMode: record?.authMode ?? null,
      refreshToken: record?.refreshToken ?? null,
      expiresAt: record?.expiresAt ?? null,
    } satisfies StoredLinearToken));
    fs.writeFileSync(tokenPath, encrypted);
    try {
      fs.chmodSync(tokenPath, 0o600);
    } catch {
      // best effort
    }
    if (record?.token?.trim()) {
      if (source.source !== "account") setCredentialProvenance(MACHINE_TOKEN_KEY, source);
    } else {
      deleteCredentialProvenance(MACHINE_TOKEN_KEY);
    }
    if (record?.refreshToken?.trim()) {
      if (refreshSource.source !== "account") setCredentialProvenance(MACHINE_REFRESH_TOKEN_KEY, refreshSource);
    } else {
      deleteCredentialProvenance(MACHINE_REFRESH_TOKEN_KEY);
    }
  };

  function persistToken(
    record: StoredLinearToken | null,
    source: CredentialProvenance = record ? getCredentialProvenance(MACHINE_TOKEN_KEY) : deviceCredentialProvenance(),
    refreshSource: CredentialProvenance = record
      ? getCredentialProvenance(MACHINE_REFRESH_TOKEN_KEY)
      : deviceCredentialProvenance(),
  ): void {
    persistTokenLocally(record, source, refreshSource);
    const refreshToken = record?.refreshToken?.trim() ?? "";
    if (refreshToken.length) {
      syncRefreshTokenToVault(refreshToken);
    } else {
      removeRefreshTokenFromVault();
    }
  }

  const persistOAuthClientCredentials = (
    record: LinearOAuthClientCredentials | null,
    source: CredentialProvenance = deviceCredentialProvenance(),
  ): void => {
    if (credentialStore) {
      persistMachineOAuthClientCredentials(record, source);
      unlinkIfExists(oauthClientPath);
      return;
    }

    const clientId = record?.clientId?.trim() ?? "";
    if (!clientId.length) {
      try {
        fs.unlinkSync(oauthClientPath);
      } catch {
        // best effort — file may not exist
      }
      return;
    }

    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS secure storage is unavailable. Cannot store Linear OAuth client settings.");
    }

    fs.mkdirSync(secretsDir, { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify({
      clientId,
      clientSecret: record?.clientSecret?.trim() || null,
    }));
    fs.writeFileSync(oauthClientPath, encrypted);
    try {
      fs.chmodSync(oauthClientPath, 0o600);
    } catch {
      // best effort
    }
    if (record?.clientId?.trim()) setCredentialProvenance(MACHINE_OAUTH_CLIENT_KEY, source);
    else deleteCredentialProvenance(MACHINE_OAUTH_CLIENT_KEY);
  };

  let legacyImportDone = false;

  const importLegacyTokenIfNeeded = (): void => {
    if (legacyImportDone) return;
    legacyImportDone = true;
    const legacyPath = path.join(args.adeDir, "local.secret.yaml");
    try {
      // If token already exists or import sentinel is present, skip
      fs.accessSync(tokenPath);
      return;
    } catch {
      // token file doesn't exist — continue
    }
    try {
      fs.accessSync(importSentinelPath);
      return;
    } catch {
      // sentinel doesn't exist — continue
    }
    try {
      const raw = fs.readFileSync(legacyPath, "utf8");
      const token = extractLegacyToken(raw);
      if (!token) {
        fs.mkdirSync(secretsDir, { recursive: true });
        fs.writeFileSync(importSentinelPath, "no_token", "utf8");
        return;
      }
      persistToken({ token, authMode: "manual" });
      fs.mkdirSync(secretsDir, { recursive: true });
      fs.writeFileSync(importSentinelPath, "imported", "utf8");
      args.logger?.info("linear_sync.token_imported_legacy", { legacyPath });
    } catch (error: unknown) {
      if (isEnoentError(error)) return;
      args.logger?.warn("linear_sync.token_import_failed", {
        legacyPath,
        error: getErrorMessage(error)
      });
    }
  };

  let cachedToken: StoredLinearToken | null | undefined;
  let cachedOAuthCreds: LinearOAuthClientCredentials | null | undefined;

  const getStoredToken = (): StoredLinearToken | null => {
    if (cachedToken !== undefined) return cachedToken;
    if (credentialStore) {
      migrateLegacyProjectCredentialsIfNeeded();
      cachedToken = readMachineToken();
      if (!cachedToken) {
        const envToken = readEnvToken();
        if (envToken) {
          cachedToken = { token: envToken, authMode: "manual" };
        }
      }
      return cachedToken;
    }
    importLegacyTokenIfNeeded();
    cachedToken = readEncryptedToken();
    if (!cachedToken) {
      const envToken = readEnvToken();
      if (envToken) {
        cachedToken = { token: envToken, authMode: "manual" };
      }
    }
    return cachedToken;
  };

  const invalidateCache = (): void => {
    cachedToken = undefined;
    cachedOAuthCreds = undefined;
  };

  const readOAuthClientCredentials = (): LinearOAuthClientCredentials | null => {
    if (cachedOAuthCreds !== undefined) return cachedOAuthCreds;
    if (credentialStore) {
      migrateLegacyProjectCredentialsIfNeeded();
      const stored = readMachineOAuthClientCredentials();
      if (stored) {
        cachedOAuthCreds = stored;
        return cachedOAuthCreds;
      }
      const configFileCredentials = readOAuthConfigFileCredentials();
      if (configFileCredentials) {
        cachedOAuthCreds = configFileCredentials;
        return cachedOAuthCreds;
      }
      if (BUNDLED_LINEAR_OAUTH_CLIENT_ID) {
        cachedOAuthCreds = { clientId: BUNDLED_LINEAR_OAUTH_CLIENT_ID, clientSecret: null };
        return cachedOAuthCreds;
      }
      cachedOAuthCreds = null;
      return null;
    }
    // Priority 1: User-configured credentials (encrypted store)
    const stored = readStoredOAuthClientCredentials();
    if (stored) {
      cachedOAuthCreds = stored;
      return cachedOAuthCreds;
    }
    // Priority 2: Config files in secrets dir
    const configFileCredentials = readOAuthConfigFileCredentials();
    if (configFileCredentials) {
      cachedOAuthCreds = configFileCredentials;
      return cachedOAuthCreds;
    }
    // Priority 3: Bundled client ID (ships with ADE, no secret — uses PKCE)
    if (BUNDLED_LINEAR_OAUTH_CLIENT_ID) {
      cachedOAuthCreds = { clientId: BUNDLED_LINEAR_OAUTH_CLIENT_ID, clientSecret: null };
      return cachedOAuthCreds;
    }
    cachedOAuthCreds = null;
    return null;
  };

  // Refresh the OAuth access token via grant_type=refresh_token when it is at or
  // near expiry (Linear tokens expire ~24h after sign-in). Concurrent callers
  // share one in-flight refresh. No-op for manual tokens / API keys (they don't
  // expire) and when no refresh token is stored.
  let refreshInFlight: Promise<void> | null = null;

  const ensureFreshToken = async (opts?: { force?: boolean }): Promise<void> => {
    const stored = getStoredToken();
    if (!stored || stored.authMode !== "oauth" || !stored.refreshToken) return;
    if (!opts?.force && !linearTokenNeedsRefresh(stored.expiresAt, Date.now())) return;
    if (refreshInFlight) {
      await refreshInFlight;
      return;
    }
    const client = readOAuthClientCredentials();
    if (!client) return;
    const refreshToken = stored.refreshToken;
    refreshInFlight = (async () => {
      if (!(await thisDeviceOwnsLinearRefreshGrant({
        getAccountVault: args.getAccountVault,
        getDeviceId: args.getDeviceId,
      }))) {
        args.logger?.info("linear_sync.oauth_refresh_skipped_other_owner", {});
        return;
      }
      const performRefresh = async (tokenToRefresh: string): Promise<void> => {
        const result = await refreshLinearOAuthAccessToken({
          refreshToken: tokenToRefresh,
          clientId: client.clientId,
          clientSecret: client.clientSecret,
          fetchImpl: args.fetchImpl,
        });
        if (result.ok) {
          persistToken({
            token: result.accessToken,
            authMode: "oauth",
            refreshToken: result.refreshToken ?? tokenToRefresh,
            expiresAt: result.expiresAt,
          });
          invalidateCache();
          args.logger?.info("linear_sync.oauth_token_refreshed", {
            expiresAt: result.expiresAt,
          });
          return;
        }
        if (result.invalidGrant) {
          invalidateCache();
          const reread = getStoredToken();
          if (
            linearInvalidGrantLikelyStaleRotation({
              attemptedRefreshToken: tokenToRefresh,
              rereadRefreshToken: reread?.refreshToken,
              rereadExpiresAt: reread?.expiresAt,
              trustFreshExpiresAt: !opts?.force,
            })
          ) {
            args.logger?.info("linear_sync.oauth_refresh_rotated_elsewhere", {
              status: result.status,
              message: result.message,
            });
            return;
          }
          persistToken(null);
          invalidateCache();
          args.logger?.warn("linear_sync.oauth_refresh_invalid_grant", {
            status: result.status,
            message: result.message,
          });
          return;
        }
        args.logger?.warn("linear_sync.oauth_refresh_failed", {
          status: result.status,
          message: result.message,
        });
      };

      if (credentialStore) {
        try {
          await withLinearOAuthRefreshLock(secretsDir, async () => {
            invalidateCache();
            const latest = getStoredToken();
            if (
              !latest
              || latest.authMode !== "oauth"
              || !latest.refreshToken
              || (!opts?.force && !linearTokenNeedsRefresh(latest.expiresAt, Date.now()))
            ) {
              return;
            }
            await performRefresh(latest.refreshToken);
          });
        } catch (error: unknown) {
          if (!(error instanceof LinearOAuthRefreshLockTimeoutError)) throw error;
          args.logger?.warn("linear_sync.oauth_refresh_lock_timeout", {
            message: error.message,
          });
        }
        return;
      }
      await performRefresh(refreshToken);
    })().finally(() => {
      refreshInFlight = null;
    });
    await refreshInFlight;
  };

  const hydrateFromVault = async (): Promise<void> => {
    const accountUserId = args.getAccountUserId?.()?.trim() || null;
    if (!accountUserId) return;
    if (!(await thisDeviceOwnsLinearRefreshGrant({
      getAccountVault: args.getAccountVault,
      getDeviceId: args.getDeviceId,
    }))) {
      return;
    }
    let stored: StoredLinearToken | null;
    try {
      stored = getStoredToken();
      if (stored?.refreshToken) return;
      if (credentialStore && readMachineCredential(MACHINE_REFRESH_TOKEN_KEY)) return;
      // A refresh token only belongs on an OAuth connection. Manual tokens and
      // environment-provided tokens must remain authoritative on this machine.
      if (stored && stored.authMode !== "oauth") return;
    } catch (error) {
      args.logger?.warn("linear_sync.account_vault_hydrate_failed", {
        error: getErrorMessage(error),
      });
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
      result = await vault.get(
        LINEAR_REFRESH_VAULT_SCOPE,
        LINEAR_REFRESH_VAULT_KIND,
        LINEAR_REFRESH_VAULT_KEY,
      );
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
      const latest = getStoredToken();
      if (latest?.refreshToken) return;
      if (credentialStore && readMachineCredential(MACHINE_REFRESH_TOKEN_KEY)) return;
      if (latest && latest.authMode !== "oauth") return;

      const refreshProvenance = accountProvenance(accountUserId);
      if (credentialStore) {
        // Record ownership before exposing the hydrated refresh token. If the
        // metadata write fails, no account credential is left to be mistaken
        // for a device value during migration.
        setCredentialProvenance(MACHINE_REFRESH_TOKEN_KEY, refreshProvenance);
        writeMachineCredential(MACHINE_REFRESH_TOKEN_KEY, refreshToken);
        if (latest) cachedToken = { ...latest, refreshToken };
      } else if (latest) {
        persistTokenLocally(
          { ...latest, refreshToken },
          getCredentialProvenance(MACHINE_TOKEN_KEY),
          refreshProvenance,
        );
        cachedToken = { ...latest, refreshToken };
      }
    } catch (error) {
      logVaultFailure("hydrate", error);
    }
  };

  return {
    getToken(): string | null {
      return getStoredToken()?.token ?? null;
    },

    /** The local OAuth refresh credential, for the silent account migration. */
    getRefreshToken(): string | null {
      const stored = getStoredToken();
      return stored?.authMode === "oauth" ? stored.refreshToken ?? null : null;
    },

    getRefreshTokenProvenance(): CredentialProvenance {
      return getCredentialProvenance(MACHINE_REFRESH_TOKEN_KEY);
    },

    getTokenOrThrow(): string {
      const token = getStoredToken()?.token ?? null;
      if (!token) throw new Error("Linear token missing. Set it in Settings > Linear.");
      return token;
    },

    setToken(token: string): void {
      persistToken({ token, authMode: "manual" }, deviceCredentialProvenance());
      invalidateCache();
    },

    setOAuthToken(args: {
      accessToken: string;
      refreshToken?: string | null;
      expiresAt?: string | null;
    }): void {
      persistToken(
        {
          token: args.accessToken,
          authMode: "oauth",
          refreshToken: args.refreshToken ?? null,
          expiresAt: args.expiresAt ?? null,
        },
        deviceCredentialProvenance(),
        deviceCredentialProvenance(),
      );
      invalidateCache();
    },

    clearToken(): void {
      persistToken(null);
      invalidateCache();
    },

    setOAuthClientCredentials(args: {
      clientId: string;
      clientSecret?: string | null;
    }): void {
      const clientId = args.clientId.trim();
      if (!clientId.length) {
        throw new Error("A Linear OAuth client ID is required.");
      }
      persistOAuthClientCredentials({
        clientId,
        clientSecret: args.clientSecret?.trim() || null,
      });
      invalidateCache();
    },

    clearOAuthClientCredentials(): void {
      persistOAuthClientCredentials(null);
      invalidateCache();
    },

    /** Remove account-hydrated Linear values while retaining device values. */
    purgeAccountCredentials(): void {
      const tokenSource = getCredentialProvenance(MACHINE_TOKEN_KEY);
      const refreshSource = getCredentialProvenance(MACHINE_REFRESH_TOKEN_KEY);
      const oauthClientSource = getCredentialProvenance(MACHINE_OAUTH_CLIENT_KEY);
      const stored = getStoredToken();

      if (credentialStore) {
        if (tokenSource.source === "account") writeMachineCredential(MACHINE_TOKEN_KEY, null);
        if (refreshSource.source === "account") writeMachineCredential(MACHINE_REFRESH_TOKEN_KEY, null);
        if (oauthClientSource.source === "account") writeMachineCredential(MACHINE_OAUTH_CLIENT_KEY, null);
        if (tokenSource.source === "account") deleteCredentialProvenance(MACHINE_TOKEN_KEY);
        if (refreshSource.source === "account") deleteCredentialProvenance(MACHINE_REFRESH_TOKEN_KEY);
        if (oauthClientSource.source === "account") deleteCredentialProvenance(MACHINE_OAUTH_CLIENT_KEY);
      } else {
        if (stored && tokenSource.source === "account") {
          // The legacy safeStorage token file stores access and refresh tokens
          // in one envelope. An account-owned access token takes the whole
          // envelope with it; retaining it after sign-out would be misleading.
          persistTokenLocally(null);
        } else if (stored && refreshSource.source === "account") {
          // The access token can still be device-origin while its refresh
          // token was hydrated from the account. Preserve the former and
          // remove only the account-owned half.
          persistTokenLocally(
            { ...stored, refreshToken: null },
            tokenSource,
            deviceCredentialProvenance(),
          );
        }
        if (oauthClientSource.source === "account") persistOAuthClientCredentials(null);
      }
      invalidateCache();
    },

    getStatus(): {
      tokenStored: boolean;
      authMode: "manual" | "oauth" | null;
      tokenExpiresAt: string | null;
      refreshTokenStored: boolean;
      oauthConfigured: boolean;
    } {
      const stored = getStoredToken();
      return {
        tokenStored: stored != null,
        authMode: stored?.authMode ?? null,
        tokenExpiresAt: stored?.expiresAt ?? null,
        refreshTokenStored: Boolean(stored?.refreshToken),
        // The bundled ADE app client makes OAuth always available; a custom
        // client (if configured) takes precedence over it.
        oauthConfigured: true,
      };
    },

    getOAuthClientCredentials(): LinearOAuthClientCredentials | null {
      // Resolution order lives in readOAuthClientCredentials: user-configured
      // client, then config file, then the bundled ADE Linear app (PKCE — no
      // client secret ships with ADE).
      return readOAuthClientCredentials();
    },

    getOAuthClientSource(): LinearOAuthClientSource {
      // Compare by client id, not by which branch resolved: the bundled id is
      // the ADE app even when a user pasted it in as a "custom" client.
      const credentials = readOAuthClientCredentials();
      return credentials?.clientId === BUNDLED_LINEAR_OAUTH_CLIENT_ID ? "ade-app" : "custom";
    },

    ensureFreshToken,
    hydrateFromVault,
  };
}

export type LinearCredentialService = ReturnType<typeof createLinearCredentialService>;
