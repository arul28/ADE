import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { safeStorage } from "electron";
import type { Logger } from "../logging/logger";
import { isRecord, getErrorMessage, isEnoentError } from "../shared/utils";

// Bundled OAuth client ID — ships with ADE so users get "Sign in with Linear"
// out of the box without configuring their own OAuth app.
// This is a public value (visible in the auth URL); no secret is bundled (we use PKCE).
const BUNDLED_LINEAR_OAUTH_CLIENT_ID: string | null =
  process.env.ADE_LINEAR_CLIENT_ID || "432fb2ddb16f939ae5d5270e2c86571f";

const TOKEN_FILE = "linear-token.v1.bin";
const OAUTH_CLIENT_FILE = "linear-oauth-client.v1.bin";
const IMPORT_SENTINEL = "linear-token.imported.v1";
const OAUTH_CONFIG_FILES = [
  "linear-oauth.v1.json",
  "linear-oauth.json",
  "linear-oauth.v1.yaml",
  "linear-oauth.yaml",
  "linear-oauth.yml",
] as const;

type LinearCredentialServiceArgs = {
  adeDir: string;
  logger?: Logger | null;
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
    const clientId = typeof value.clientId === "string"
      ? value.clientId.trim()
      : typeof value.client_id === "string"
        ? value.client_id.trim()
        : "";
    if (!clientId.length) return null;
    const clientSecret = typeof value.clientSecret === "string"
      ? value.clientSecret.trim()
      : typeof value.client_secret === "string"
        ? value.client_secret.trim()
        : "";
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

  const persistToken = (record: StoredLinearToken | null): void => {
    const token = record?.token?.trim() ?? "";
    if (!token.length) {
      try {
        fs.unlinkSync(tokenPath);
      } catch {
        // best effort — file may not exist
      }
      return;
    }

    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS secure storage is unavailable. Cannot store Linear token.");
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
  };

  const persistOAuthClientCredentials = (record: LinearOAuthClientCredentials | null): void => {
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
    importLegacyTokenIfNeeded();
    cachedToken = readEncryptedToken();
    return cachedToken;
  };

  const invalidateCache = (): void => {
    cachedToken = undefined;
    cachedOAuthCreds = undefined;
  };

  const readOAuthClientCredentials = (): LinearOAuthClientCredentials | null => {
    if (cachedOAuthCreds !== undefined) return cachedOAuthCreds;
    // Priority 1: User-configured credentials (encrypted store)
    const stored = readStoredOAuthClientCredentials();
    if (stored) {
      cachedOAuthCreds = stored;
      return cachedOAuthCreds;
    }
    // Priority 2: Config files in secrets dir
    for (const filename of OAUTH_CONFIG_FILES) {
      const configPath = path.join(secretsDir, filename);
      try {
        const raw = fs.readFileSync(configPath, "utf8");
        const parsed = filename.endsWith(".json") ? JSON.parse(raw) : YAML.parse(raw);
        const credentials = normalizeOAuthClientCredentials(parsed);
        if (credentials) {
          cachedOAuthCreds = credentials;
          return cachedOAuthCreds;
        }
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
    // Priority 3: Bundled client ID (ships with ADE, no secret — uses PKCE)
    if (BUNDLED_LINEAR_OAUTH_CLIENT_ID) {
      cachedOAuthCreds = { clientId: BUNDLED_LINEAR_OAUTH_CLIENT_ID, clientSecret: null };
      return cachedOAuthCreds;
    }
    cachedOAuthCreds = null;
    return null;
  };

  return {
    getToken(): string | null {
      return getStoredToken()?.token ?? null;
    },

    getTokenOrThrow(): string {
      const token = getStoredToken()?.token ?? null;
      if (!token) throw new Error("Linear token missing. Set it in Settings > Linear.");
      return token;
    },

    setToken(token: string): void {
      persistToken({ token, authMode: "manual" });
      invalidateCache();
    },

    setOAuthToken(args: {
      accessToken: string;
      refreshToken?: string | null;
      expiresAt?: string | null;
    }): void {
      persistToken({
        token: args.accessToken,
        authMode: "oauth",
        refreshToken: args.refreshToken ?? null,
        expiresAt: args.expiresAt ?? null,
      });
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
        oauthConfigured: readOAuthClientCredentials() != null,
      };
    },

    getOAuthClientCredentials(): LinearOAuthClientCredentials | null {
      return readOAuthClientCredentials();
    },
  };
}

export type LinearCredentialService = ReturnType<typeof createLinearCredentialService>;
