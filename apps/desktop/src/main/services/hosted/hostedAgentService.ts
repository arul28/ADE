import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { safeStorage } from "electron";
import type {
  HostedArtifactResult,
  HostedAuthStatus,
  HostedBootstrapConfig,
  HostedGitHubAppStatus,
  HostedGitHubConnectStartResult,
  HostedGitHubDisconnectResult,
  HostedGitHubEventsResult,
  HostedGitHubProxyRequestArgs,
  HostedJobStatusResult,
  HostedJobSubmissionArgs,
  HostedJobSubmissionResult,
  HostedMirrorSyncArgs,
  HostedMirrorSyncResult,
  HostedSignInResult,
  HostedSignInArgs,
  HostedStatus,
  HostedJobType,
  ProviderMode
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { createLaneService } from "../lanes/laneService";
import type { createProjectConfigService } from "../config/projectConfigService";
import { runGit } from "../git/git";

type HostedAuthTokens = {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  tokenType?: string;
  expiresAt?: string;
  userId?: string;
  email?: string;
  displayName?: string;
};

type HostedConfig = {
  mode: ProviderMode;
  consentGiven: boolean;
  apiBaseUrl: string;
  region: string;
  clerkPublishableKey: string;
  clerkOauthClientId: string;
  clerkIssuer: string;
  clerkFrontendApiUrl: string;
  clerkOauthMetadataUrl: string;
  clerkOauthAuthorizeUrl: string;
  clerkOauthTokenUrl: string;
  clerkOauthRevocationUrl: string;
  clerkOauthUserInfoUrl: string;
  clerkOauthScopes: string;
  mirrorExcludePatterns: string[];
  uploadTranscripts: boolean;
  remoteProjectId: string | null;
  auth: HostedAuthTokens;
};

type BlobUpload = {
  path: string;
  sha256: string;
  contentBase64: string;
  contentType: string;
};

type ManifestEntry = {
  path: string;
  sha256: string;
  size: number;
};

const CALLBACK_PORT = 42420;
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
const MAX_FILE_BYTES = 400 * 1024;
const MAX_FILES_PER_LANE = 400;
const MAX_BATCH_BLOBS = 40;
const AUTH_STORE_FILE_NAME = "hosted-auth.v1.bin";
const BOOTSTRAP_FILE_NAME = "bootstrap.json";

const DEFAULT_EXCLUDE_PATTERNS = [
  "node_modules/",
  "vendor/",
  ".venv/",
  "__pycache__/",
  "dist/",
  "build/",
  ".next/",
  ".nuxt/",
  "target/",
  ".env",
  ".env.*",
  ".env.local",
  ".env.production",
  ".env.development",
  "*.pem",
  "*.key",
  "*.cert",
  "credentials.json",
  "secrets.*",
  ".aws/credentials",
  "id_rsa",
  "id_ed25519",
  ".git/"
];

const HOSTED_FETCH_TIMEOUT_MS = 20_000;
const POLL_INITIAL_DELAY_MS = 700;
const POLL_MAX_DELAY_MS = 4_000;
const POLL_TIMEOUT_FLOOR_MS = 60_000;
const POLL_STALL_TIMEOUT_MS = 90_000;

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".css",
  ".html",
  ".cjs",
  ".mjs",
  ".sh",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".swift",
  ".rb",
  ".php",
  ".sql"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asBoolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
}

function base64Url(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function sha256Hex(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

function isProbablyText(filePath: string, bytes: Buffer): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return false;
  }
  return true;
}

function redactSecrets(text: string): string {
  let output = text;
  output = output.replace(
    /((?:api[_-]?key|token|secret|password)\s*[:=]\s*)(["']?)[^\s"']{6,}\2/gi,
    "$1<redacted>"
  );
  output = output.replace(
    /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g,
    "<redacted-private-key>"
  );
  output = output.replace(
    /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g,
    "<redacted-token>"
  );
  return output;
}

function globLikeMatch(inputPath: string, pattern: string): boolean {
  const normalizedPath = inputPath.replace(/\\/g, "/").toLowerCase();
  const normalizedPattern = pattern.trim().replace(/\\/g, "/").toLowerCase();
  if (!normalizedPattern.length) return false;

  const escaped = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");

  const regex = new RegExp(`^${escaped}$`);
  if (regex.test(normalizedPath)) return true;

  return normalizedPath.includes(normalizedPattern);
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",");
  return `{${body}}`;
};

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = HOSTED_FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = Math.max(5_000, Math.floor(timeoutMs));
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if ((error as DOMException | null)?.name === "AbortError") {
      throw new Error(`Request to hosted endpoint timed out after ${timeout}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function toJsonBody(value: unknown): string {
  return JSON.stringify(value);
}

const makeRequestKey = (label: string, payload: unknown): string =>
  `${label}:${createHash("sha256").update(stableStringify(payload)).digest("hex")}`;

function normalizeHttpUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    const normalizedPath = parsed.pathname.replace(/\/+$/g, "");
    const pathSuffix = normalizedPath.length ? normalizedPath : "";
    return `${parsed.origin}${pathSuffix}`;
  } catch {
    return "";
  }
}

function parseErrorMessage(payload: unknown): string {
  if (!isRecord(payload)) return "Request failed";
  const directError = asString(payload.error);
  const directDescription = asString(payload.error_description);
  if (directError && directDescription) return `${directError}: ${directDescription}`;
  if (directDescription) return directDescription;
  if (directError) return directError;
  const error = isRecord(payload.error) ? payload.error : payload;
  const code = asString(error.code);
  const message = asString(error.message);
  if (code && message) return `${code}: ${message}`;
  if (message) return message;
  return "Request failed";
}

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payload = parts[1] ?? "";
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  try {
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractProfileFromClaims(claims: Record<string, unknown> | null): {
  userId?: string;
  email?: string;
  displayName?: string;
} {
  if (!claims) return {};

  const userId = asString(claims.sub).trim();
  const email =
    asString(claims.email).trim() ||
    asString(claims.primary_email_address).trim() ||
    asString(claims.preferred_username).trim();
  const displayName =
    asString(claims.name).trim() ||
    asString(claims.username).trim() ||
    asString(claims.given_name).trim() ||
    asString(claims.email).trim();

  return {
    ...(userId ? { userId } : {}),
    ...(email ? { email } : {}),
    ...(displayName ? { displayName } : {})
  };
}

function hasIdentityClaim(claims: Record<string, unknown> | null): boolean {
  if (!claims) return false;
  for (const key of ["sub", "user_id", "userId", "uid"]) {
    const value = claims[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return true;
    }
  }
  return false;
}

function tokenHasIdentityClaim(token: string | undefined): boolean {
  const clean = asString(token).trim();
  if (!clean) return false;
  return hasIdentityClaim(decodeJwtClaims(clean));
}

function sanitizeAuthTokens(tokens: HostedAuthTokens): HostedAuthTokens {
  const clean: HostedAuthTokens = {};
  const accessToken = asString(tokens.accessToken).trim();
  const refreshToken = asString(tokens.refreshToken).trim();
  const idToken = asString(tokens.idToken).trim();
  const tokenType = asString(tokens.tokenType).trim();
  const expiresAt = asString(tokens.expiresAt).trim();
  const userId = asString(tokens.userId).trim();
  const email = asString(tokens.email).trim();
  const displayName = asString(tokens.displayName).trim();

  if (accessToken) clean.accessToken = accessToken;
  if (refreshToken) clean.refreshToken = refreshToken;
  if (idToken) clean.idToken = idToken;
  if (tokenType) clean.tokenType = tokenType;
  if (expiresAt) clean.expiresAt = expiresAt;
  if (userId) clean.userId = userId;
  if (email) clean.email = email;
  if (displayName) clean.displayName = displayName;
  return clean;
}

function hasAuthData(tokens: HostedAuthTokens): boolean {
  return Boolean(tokens.accessToken || tokens.refreshToken || tokens.idToken || tokens.expiresAt || tokens.tokenType);
}

export function createHostedAgentService({
  logger,
  projectId,
  projectRoot,
  projectDisplayName,
  adeDir,
  laneService,
  projectConfigService,
  openExternal
}: {
  logger: Logger;
  projectId: string;
  projectRoot: string;
  projectDisplayName: string;
  adeDir: string;
  laneService: ReturnType<typeof createLaneService>;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  openExternal: (url: string) => Promise<void>;
}) {
  const packsDir = path.join(adeDir, "packs");
  const transcriptsDir = path.join(adeDir, "transcripts");
  const hostedStateDir = path.join(adeDir, "hosted");
  const hostedAuthPath = path.join(hostedStateDir, AUTH_STORE_FILE_NAME);
  const hostedBootstrapPath = path.join(hostedStateDir, BOOTSTRAP_FILE_NAME);

  const readStoredAuthTokens = (): HostedAuthTokens => {
    if (!fs.existsSync(hostedAuthPath)) return {};

    try {
      const bytes = fs.readFileSync(hostedAuthPath);
      if (!safeStorage.isEncryptionAvailable()) {
        logger.warn("hosted.auth_store_unavailable", {
          projectId,
          message: "OS secure storage is unavailable; hosted auth tokens cannot be decrypted."
        });
        return {};
      }
      const decrypted = safeStorage.decryptString(bytes);
      const parsed = JSON.parse(decrypted);
      if (!isRecord(parsed)) return {};
      return sanitizeAuthTokens(parsed as HostedAuthTokens);
    } catch (error) {
      logger.warn("hosted.auth_store_read_failed", {
        projectId,
        error: error instanceof Error ? error.message : String(error)
      });
      return {};
    }
  };

  const persistAuthTokens = (tokens: HostedAuthTokens): void => {
    const clean = sanitizeAuthTokens(tokens);

    if (!hasAuthData(clean)) {
      try {
        if (fs.existsSync(hostedAuthPath)) fs.unlinkSync(hostedAuthPath);
      } catch {
        // ignore
      }
      return;
    }

    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS secure storage is unavailable. Cannot persist hosted auth tokens.");
    }

    fs.mkdirSync(hostedStateDir, { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify(clean));
    fs.writeFileSync(hostedAuthPath, encrypted);
    try {
      fs.chmodSync(hostedAuthPath, 0o600);
    } catch {
      // ignore best-effort chmod
    }
  };

  const clearStoredAuthTokens = (): void => {
    persistAuthTokens({});
  };

  const readBootstrapConfig = (): HostedBootstrapConfig | null => {
    if (!fs.existsSync(hostedBootstrapPath)) return null;

    try {
      const raw = fs.readFileSync(hostedBootstrapPath, "utf8");
      const parsed = JSON.parse(raw);
      if (!isRecord(parsed)) return null;

      const config: HostedBootstrapConfig = {
        stage: asString(parsed.stage) || "unknown",
        apiBaseUrl: asString(parsed.apiBaseUrl),
        region: asString(parsed.region),
        clerkPublishableKey: asString(parsed.clerkPublishableKey),
        clerkOauthClientId: asString(parsed.clerkOauthClientId),
        clerkIssuer: normalizeHttpUrl(asString(parsed.clerkIssuer)),
        clerkFrontendApiUrl: normalizeHttpUrl(asString(parsed.clerkFrontendApiUrl)),
        clerkOauthMetadataUrl: normalizeHttpUrl(asString(parsed.clerkOauthMetadataUrl)),
        clerkOauthAuthorizeUrl: normalizeHttpUrl(asString(parsed.clerkOauthAuthorizeUrl)),
        clerkOauthTokenUrl: normalizeHttpUrl(asString(parsed.clerkOauthTokenUrl)),
        clerkOauthRevocationUrl: normalizeHttpUrl(asString(parsed.clerkOauthRevocationUrl)),
        clerkOauthUserInfoUrl: normalizeHttpUrl(asString(parsed.clerkOauthUserInfoUrl)),
        clerkOauthScopes: asString(parsed.clerkOauthScopes) || "openid profile email offline_access",
        ...(asString(parsed.generatedAt) ? { generatedAt: asString(parsed.generatedAt) } : {})
      };

      if (
        !config.apiBaseUrl ||
        !config.region ||
        !config.clerkPublishableKey ||
        !config.clerkOauthClientId ||
        !config.clerkIssuer ||
        !config.clerkFrontendApiUrl ||
        !config.clerkOauthMetadataUrl ||
        !config.clerkOauthAuthorizeUrl ||
        !config.clerkOauthTokenUrl
      ) {
        return null;
      }

      return config;
    } catch (error) {
      logger.warn("hosted.bootstrap_read_failed", {
        projectId,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  };

  const readHostedConfig = (): HostedConfig => {
    const snapshot = projectConfigService.get();
    const localProviders = isRecord(snapshot.local.providers) ? snapshot.local.providers : {};
    const effectiveProviders = isRecord(snapshot.effective.providers) ? snapshot.effective.providers : {};

    const modeRaw = asString(localProviders.mode) || asString(effectiveProviders.mode);
    const mode: ProviderMode =
      modeRaw === "hosted" || modeRaw === "byok" || modeRaw === "cli" || modeRaw === "guest"
        ? modeRaw
        : snapshot.effective.providerMode ?? "guest";

    const localHosted = isRecord(localProviders.hosted) ? localProviders.hosted : {};
    const effectiveHosted = isRecord(effectiveProviders.hosted) ? effectiveProviders.hosted : {};
    const hosted = {
      ...effectiveHosted,
      ...localHosted
    };
    const region = asString(hosted.region);

    return {
      mode,
      consentGiven: asBoolean(hosted.consentGiven),
      apiBaseUrl: asString(hosted.apiBaseUrl),
      region,
      clerkPublishableKey: asString(hosted.clerkPublishableKey),
      clerkOauthClientId: asString(hosted.clerkOauthClientId),
      clerkIssuer: normalizeHttpUrl(asString(hosted.clerkIssuer)),
      clerkFrontendApiUrl: normalizeHttpUrl(asString(hosted.clerkFrontendApiUrl)),
      clerkOauthMetadataUrl: normalizeHttpUrl(asString(hosted.clerkOauthMetadataUrl)),
      clerkOauthAuthorizeUrl: normalizeHttpUrl(asString(hosted.clerkOauthAuthorizeUrl)),
      clerkOauthTokenUrl: normalizeHttpUrl(asString(hosted.clerkOauthTokenUrl)),
      clerkOauthRevocationUrl: normalizeHttpUrl(asString(hosted.clerkOauthRevocationUrl)),
      clerkOauthUserInfoUrl: normalizeHttpUrl(asString(hosted.clerkOauthUserInfoUrl)),
      clerkOauthScopes: asString(hosted.clerkOauthScopes) || "openid profile email offline_access",
      mirrorExcludePatterns: asStringArray(hosted.mirrorExcludePatterns),
      uploadTranscripts: asBoolean(hosted.uploadTranscripts),
      remoteProjectId: asString(hosted.remoteProjectId) || null,
      auth: readStoredAuthTokens()
    };
  };

  const updateHostedConfig = (patch: Partial<Omit<HostedConfig, "auth">>): void => {
    const snapshot = projectConfigService.get();
    const localProviders = isRecord(snapshot.local.providers) ? snapshot.local.providers : {};
    const localHosted = isRecord(localProviders.hosted) ? localProviders.hosted : {};
    const { auth: _legacyAuth, ...localHostedWithoutAuth } = localHosted;

    const mergedHosted: Record<string, unknown> = {
      ...localHostedWithoutAuth,
      ...(patch.consentGiven != null ? { consentGiven: patch.consentGiven } : {}),
      ...(patch.apiBaseUrl != null ? { apiBaseUrl: patch.apiBaseUrl } : {}),
      ...(patch.region != null ? { region: patch.region } : {}),
      ...(patch.clerkPublishableKey != null ? { clerkPublishableKey: patch.clerkPublishableKey } : {}),
      ...(patch.clerkOauthClientId != null ? { clerkOauthClientId: patch.clerkOauthClientId } : {}),
      ...(patch.clerkIssuer != null ? { clerkIssuer: patch.clerkIssuer } : {}),
      ...(patch.clerkFrontendApiUrl != null ? { clerkFrontendApiUrl: patch.clerkFrontendApiUrl } : {}),
      ...(patch.clerkOauthMetadataUrl != null ? { clerkOauthMetadataUrl: patch.clerkOauthMetadataUrl } : {}),
      ...(patch.clerkOauthAuthorizeUrl != null ? { clerkOauthAuthorizeUrl: patch.clerkOauthAuthorizeUrl } : {}),
      ...(patch.clerkOauthTokenUrl != null ? { clerkOauthTokenUrl: patch.clerkOauthTokenUrl } : {}),
      ...(patch.clerkOauthRevocationUrl != null ? { clerkOauthRevocationUrl: patch.clerkOauthRevocationUrl } : {}),
      ...(patch.clerkOauthUserInfoUrl != null ? { clerkOauthUserInfoUrl: patch.clerkOauthUserInfoUrl } : {}),
      ...(patch.clerkOauthScopes != null ? { clerkOauthScopes: patch.clerkOauthScopes } : {}),
      ...(patch.mirrorExcludePatterns != null ? { mirrorExcludePatterns: patch.mirrorExcludePatterns } : {}),
      ...(patch.uploadTranscripts != null ? { uploadTranscripts: patch.uploadTranscripts } : {}),
      ...(patch.remoteProjectId !== undefined ? { remoteProjectId: patch.remoteProjectId } : {})
    };

    const nextLocalProviders: Record<string, unknown> = {
      ...localProviders,
      mode: patch.mode ?? localProviders.mode ?? snapshot.effective.providerMode ?? "guest",
      hosted: mergedHosted,
      updatedAt: nowIso()
    };

    projectConfigService.save({
      shared: snapshot.shared,
      local: {
        ...snapshot.local,
        providers: nextLocalProviders
      }
    });
  };

  const removeLegacyAuthFromConfig = (): void => {
    const snapshot = projectConfigService.get();
    const localProviders = isRecord(snapshot.local.providers) ? snapshot.local.providers : {};
    const localHosted = isRecord(localProviders.hosted) ? localProviders.hosted : {};
    if (!Object.prototype.hasOwnProperty.call(localHosted, "auth")) return;

    const { auth: _auth, ...localHostedWithoutAuth } = localHosted;
    const nextLocalProviders: Record<string, unknown> = {
      ...localProviders,
      hosted: localHostedWithoutAuth,
      updatedAt: nowIso()
    };

    projectConfigService.save({
      shared: snapshot.shared,
      local: {
        ...snapshot.local,
        providers: nextLocalProviders
      }
    });
  };

  const migrateLegacyAuthToSecureStore = (): void => {
    const snapshot = projectConfigService.get();
    const localProviders = isRecord(snapshot.local.providers) ? snapshot.local.providers : {};
    const localHosted = isRecord(localProviders.hosted) ? localProviders.hosted : {};
    const legacyAuthRaw = isRecord(localHosted.auth) ? localHosted.auth : null;
    if (!legacyAuthRaw) return;

    const legacyAuth = sanitizeAuthTokens({
      accessToken: asString(legacyAuthRaw.accessToken),
      refreshToken: asString(legacyAuthRaw.refreshToken),
      idToken: asString(legacyAuthRaw.idToken),
      tokenType: asString(legacyAuthRaw.tokenType),
      expiresAt: asString(legacyAuthRaw.expiresAt),
      userId: asString(legacyAuthRaw.userId),
      email: asString(legacyAuthRaw.email),
      displayName: asString(legacyAuthRaw.displayName)
    });

    if (hasAuthData(legacyAuth) && !hasAuthData(readStoredAuthTokens())) {
      persistAuthTokens(legacyAuth);
      logger.info("hosted.auth_migrated_to_secure_store", { projectId });
    }

    removeLegacyAuthFromConfig();
  };

  const applyBootstrapHostedConfig = (): HostedBootstrapConfig => {
    const bootstrap = readBootstrapConfig();
    if (!bootstrap) {
      throw new Error("No hosted bootstrap config found at .ade/hosted/bootstrap.json");
    }

    updateHostedConfig({
      mode: "hosted",
      apiBaseUrl: bootstrap.apiBaseUrl,
      region: bootstrap.region,
      clerkPublishableKey: bootstrap.clerkPublishableKey,
      clerkOauthClientId: bootstrap.clerkOauthClientId,
      clerkIssuer: bootstrap.clerkIssuer,
      clerkFrontendApiUrl: bootstrap.clerkFrontendApiUrl,
      clerkOauthMetadataUrl: bootstrap.clerkOauthMetadataUrl,
      clerkOauthAuthorizeUrl: bootstrap.clerkOauthAuthorizeUrl,
      clerkOauthTokenUrl: bootstrap.clerkOauthTokenUrl,
      clerkOauthRevocationUrl: bootstrap.clerkOauthRevocationUrl,
      clerkOauthUserInfoUrl: bootstrap.clerkOauthUserInfoUrl,
      clerkOauthScopes: bootstrap.clerkOauthScopes
    });

    return bootstrap;
  };

  try {
    migrateLegacyAuthToSecureStore();
  } catch (error) {
    logger.warn("hosted.auth_migration_failed", {
      projectId,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  const ensureHostedConfigured = (): HostedConfig => {
    let config = readHostedConfig();

    if (config.mode !== "hosted") {
      throw new Error("Provider mode is not set to Hosted.");
    }

    if (!config.consentGiven) {
      throw new Error("Hosted consent is required before using cloud features.");
    }

    const missingCoreConfig =
      !config.apiBaseUrl.trim() ||
      !config.clerkOauthClientId.trim() ||
      !config.clerkOauthAuthorizeUrl.trim() ||
      !config.clerkOauthTokenUrl.trim() ||
      !config.clerkIssuer.trim();

    if (missingCoreConfig) {
      const bootstrap = readBootstrapConfig();
      if (bootstrap) {
        applyBootstrapHostedConfig();
        config = readHostedConfig();
      }
    }

    if (!config.apiBaseUrl.trim()) {
      throw new Error("Hosted API base URL is not configured. Apply .ade/hosted/bootstrap.json or set values in Settings.");
    }
    if (!config.clerkOauthClientId.trim()) {
      throw new Error("Hosted Clerk OAuth client ID is missing. Apply .ade/hosted/bootstrap.json or set values in Settings.");
    }
    if (!config.clerkOauthAuthorizeUrl.trim() || !config.clerkOauthTokenUrl.trim()) {
      throw new Error("Hosted Clerk OAuth endpoints are missing. Apply .ade/hosted/bootstrap.json or set values in Settings.");
    }
    if (!config.clerkIssuer.trim()) {
      throw new Error("Hosted Clerk JWT issuer is missing. Apply .ade/hosted/bootstrap.json or set values in Settings.");
    }

    return config;
  };

  const refreshAccessTokenIfNeeded = async (force = false): Promise<string> => {
    const config = ensureHostedConfigured();
    const accessToken = config.auth.accessToken;
    const expiresAt = config.auth.expiresAt ? Date.parse(config.auth.expiresAt) : Number.NaN;
    const hasValidToken = !!accessToken && Number.isFinite(expiresAt) && Date.now() < expiresAt - 60_000;

    if (!force && hasValidToken && accessToken) {
      return accessToken;
    }

    if (!config.auth.refreshToken) {
      throw new Error("Hosted auth token missing. Sign in from Settings.");
    }

    const tokenUrl = config.clerkOauthTokenUrl.trim();
    if (!tokenUrl) {
      throw new Error("Hosted OAuth token endpoint is missing. Apply bootstrap config and try again.");
    }

    const response = await fetchWithTimeout(tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: config.clerkOauthClientId,
        refresh_token: config.auth.refreshToken
      }).toString()
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Hosted token refresh failed: ${parseErrorMessage(payload)}`);
    }

    const nextAccessToken = asString((payload as Record<string, unknown>).access_token);
    const nextIdToken = asString((payload as Record<string, unknown>).id_token) || config.auth.idToken;
    const nextRefreshToken = asString((payload as Record<string, unknown>).refresh_token) || config.auth.refreshToken;
    const expiresInSec = Number((payload as Record<string, unknown>).expires_in ?? 3600);
    const nextExpiresAt = new Date(Date.now() + Math.max(60, expiresInSec) * 1000).toISOString();
    const profile = extractProfileFromClaims(decodeJwtClaims(nextIdToken || nextAccessToken));

    if (!nextAccessToken) {
      throw new Error("Hosted token refresh returned an empty access token.");
    }

    persistAuthTokens({
      ...config.auth,
      accessToken: nextAccessToken,
      refreshToken: nextRefreshToken,
      idToken: nextIdToken,
      expiresAt: nextExpiresAt,
      tokenType: asString((payload as Record<string, unknown>).token_type) || "Bearer",
      ...profile
    });

    return nextAccessToken;
  };

  const apiRequest = async <T>(args: {
    method: "GET" | "POST" | "DELETE";
    path: string;
    body?: unknown;
    retryOnUnauthorized?: boolean;
  }): Promise<T> => {
    let config = ensureHostedConfigured();
    await refreshAccessTokenIfNeeded();
    config = ensureHostedConfigured();
    // Prefer idToken for API calls — its aud matches the API Gateway's
    // configured OAuth client_id audience, while the access_token may have
    // a different audience that the JWT authorizer rejects.
    const token = tokenHasIdentityClaim(config.auth.idToken)
      ? asString(config.auth.idToken)
      : tokenHasIdentityClaim(config.auth.accessToken)
        ? asString(config.auth.accessToken)
        : asString(config.auth.idToken || config.auth.accessToken);

    const doRequest = async (authToken: string) => {
      const response = await fetchWithTimeout(`${config.apiBaseUrl.replace(/\/$/, "")}${args.path}`, {
        method: args.method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authToken}`
        },
        body: args.body == null ? undefined : toJsonBody(args.body)
      });

      const payload = await response.json().catch(() => ({}));
      return { response, payload };
    };

    const first = await doRequest(token);
    if (first.response.status === 401 && args.retryOnUnauthorized !== false) {
      await refreshAccessTokenIfNeeded(true);
      config = ensureHostedConfigured();
      const nextToken = tokenHasIdentityClaim(config.auth.idToken)
        ? asString(config.auth.idToken)
        : tokenHasIdentityClaim(config.auth.accessToken)
          ? asString(config.auth.accessToken)
          : asString(config.auth.idToken || config.auth.accessToken);
      const second = await doRequest(nextToken);
      if (!second.response.ok) {
        throw new Error(parseErrorMessage(second.payload));
      }
      return second.payload as T;
    }

    if (!first.response.ok) {
      throw new Error(parseErrorMessage(first.payload));
    }

    return first.payload as T;
  };

  const ensureRemoteProject = async (): Promise<string> => {
    const config = ensureHostedConfigured();
    if (config.remoteProjectId) {
      return config.remoteProjectId;
    }

    const created = await apiRequest<{ projectId: string }>({
      method: "POST",
      path: "/projects",
      body: {
        name: projectDisplayName,
        rootPath: projectRoot
      }
    });

    updateHostedConfig({
      remoteProjectId: created.projectId
    });

    return created.projectId;
  };

  const listRepoFiles = async (worktreePath: string): Promise<string[]> => {
    const tracked = await runGit(["ls-files"], { cwd: worktreePath, timeoutMs: 20_000 });
    const untracked = await runGit(["ls-files", "--others", "--exclude-standard"], {
      cwd: worktreePath,
      timeoutMs: 20_000
    });

    const out = new Set<string>();
    for (const source of [tracked.stdout, untracked.stdout]) {
      for (const line of source.split(/\r?\n/)) {
        const rel = line.trim();
        if (!rel) continue;
        out.add(rel);
      }
    }
    return Array.from(out).sort((a, b) => a.localeCompare(b));
  };

  const buildBlobUploads = (args: {
    rootPath: string;
    relPaths: string[];
    excludePatterns: string[];
  }): {
    uploads: BlobUpload[];
    manifest: ManifestEntry[];
    excludedCount: number;
  } => {
    const uploads: BlobUpload[] = [];
    const manifest: ManifestEntry[] = [];
    let excludedCount = 0;

    const fullExcludePatterns = [...DEFAULT_EXCLUDE_PATTERNS, ...args.excludePatterns];

    for (const relPath of args.relPaths.slice(0, MAX_FILES_PER_LANE)) {
      if (fullExcludePatterns.some((pattern) => globLikeMatch(relPath, pattern))) {
        excludedCount += 1;
        continue;
      }

      const absPath = path.join(args.rootPath, relPath);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(absPath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_BYTES) {
        excludedCount += 1;
        continue;
      }

      let bytes: Buffer;
      try {
        bytes = fs.readFileSync(absPath);
      } catch {
        continue;
      }

      if (isProbablyText(relPath, bytes)) {
        bytes = Buffer.from(redactSecrets(bytes.toString("utf8")), "utf8");
      }

      const sha256 = sha256Hex(bytes);
      manifest.push({
        path: relPath,
        sha256,
        size: bytes.length
      });

      uploads.push({
        path: relPath,
        sha256,
        contentBase64: bytes.toString("base64"),
        contentType: isProbablyText(relPath, bytes) ? "text/plain" : "application/octet-stream"
      });
    }

    return {
      uploads,
      manifest,
      excludedCount
    };
  };

  const uploadBlobsInBatches = async (args: {
    remoteProjectId: string;
    uploads: BlobUpload[];
    excludePatterns: string[];
  }): Promise<{ uploaded: number; deduplicated: number; excluded: number }> => {
    let uploaded = 0;
    let deduplicated = 0;
    let excluded = 0;

    for (let i = 0; i < args.uploads.length; i += MAX_BATCH_BLOBS) {
      const batch = args.uploads.slice(i, i + MAX_BATCH_BLOBS);
      const response = await apiRequest<{ uploaded: number; deduplicated: number; excluded: number }>({
        method: "POST",
        path: `/projects/${args.remoteProjectId}/upload`,
        body: {
          blobs: batch,
          excludePatterns: args.excludePatterns
        }
      });

      uploaded += Number(response.uploaded ?? 0);
      deduplicated += Number(response.deduplicated ?? 0);
      excluded += Number(response.excluded ?? 0);
    }

    return { uploaded, deduplicated, excluded };
  };

  const syncLaneMirror = async (args: {
    laneId: string;
    remoteProjectId: string;
    excludePatterns: string[];
  }): Promise<{ uploaded: number; deduplicated: number; excluded: number; manifestCount: number }> => {
    const lane = laneService.getLaneBaseAndBranch(args.laneId);
    const filePaths = await listRepoFiles(lane.worktreePath);

    const { uploads, manifest, excludedCount } = buildBlobUploads({
      rootPath: lane.worktreePath,
      relPaths: filePaths,
      excludePatterns: args.excludePatterns
    });

    const uploadSummary = await uploadBlobsInBatches({
      remoteProjectId: args.remoteProjectId,
      uploads,
      excludePatterns: args.excludePatterns
    });

    const headSha = (await runGit(["rev-parse", "HEAD"], { cwd: lane.worktreePath, timeoutMs: 8_000 })).stdout.trim();

    await apiRequest<{ manifestId: string; timestamp: string }>({
      method: "POST",
      path: `/projects/${args.remoteProjectId}/lanes/${args.laneId}/manifest`,
      body: {
        laneId: args.laneId,
        branchRef: lane.branchRef,
        headSha,
        fileCount: manifest.length,
        files: manifest,
        generatedAt: nowIso()
      }
    });

    return {
      uploaded: uploadSummary.uploaded,
      deduplicated: uploadSummary.deduplicated,
      excluded: uploadSummary.excluded + excludedCount,
      manifestCount: 1
    };
  };

  const syncPacks = async (remoteProjectId: string, excludePatterns: string[]): Promise<{ uploaded: number; deduplicated: number; excluded: number; packCount: number }> => {
    if (!fs.existsSync(packsDir)) {
      return { uploaded: 0, deduplicated: 0, excluded: 0, packCount: 0 };
    }

    const packPaths: string[] = [];
    const walk = (currentPath: string) => {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        const child = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
          walk(child);
          continue;
        }
        if (entry.isFile() && child.endsWith(".md")) {
          packPaths.push(child);
        }
      }
    };

    walk(packsDir);

    const uploads: BlobUpload[] = [];
    for (const absPath of packPaths) {
      const relPath = path.relative(projectRoot, absPath).replace(/\\/g, "/");
      if (!relPath || excludePatterns.some((pattern) => globLikeMatch(relPath, pattern))) continue;
      const text = redactSecrets(fs.readFileSync(absPath, "utf8"));
      const bytes = Buffer.from(text, "utf8");
      uploads.push({
        path: relPath,
        sha256: sha256Hex(bytes),
        contentBase64: bytes.toString("base64"),
        contentType: "text/markdown"
      });
    }

    if (!uploads.length) {
      return { uploaded: 0, deduplicated: 0, excluded: 0, packCount: 0 };
    }

    const summary = await uploadBlobsInBatches({
      remoteProjectId,
      uploads,
      excludePatterns
    });

    return {
      ...summary,
      packCount: uploads.length
    };
  };

  const syncTranscripts = async (remoteProjectId: string, excludePatterns: string[]): Promise<{ uploaded: number; deduplicated: number; excluded: number; transcriptCount: number }> => {
    if (!fs.existsSync(transcriptsDir)) {
      return { uploaded: 0, deduplicated: 0, excluded: 0, transcriptCount: 0 };
    }

    const files = fs
      .readdirSync(transcriptsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
      .map((entry) => path.join(transcriptsDir, entry.name))
      .slice(-20);

    const uploads: BlobUpload[] = [];
    for (const absPath of files) {
      const relPath = path.relative(projectRoot, absPath).replace(/\\/g, "/");
      if (!relPath || excludePatterns.some((pattern) => globLikeMatch(relPath, pattern))) continue;
      const text = redactSecrets(fs.readFileSync(absPath, "utf8"));
      const bytes = Buffer.from(text, "utf8");
      uploads.push({
        path: relPath,
        sha256: sha256Hex(bytes),
        contentBase64: bytes.toString("base64"),
        contentType: "text/plain"
      });
    }

    if (!uploads.length) {
      return { uploaded: 0, deduplicated: 0, excluded: 0, transcriptCount: 0 };
    }

    const summary = await uploadBlobsInBatches({
      remoteProjectId,
      uploads,
      excludePatterns
    });

    return {
      ...summary,
      transcriptCount: uploads.length
    };
  };

  const parseDiffFromContent = (content: string): { explanation: string; diffPatch: string; confidence: number | null } => {
    const diffMatch = content.match(/```diff\n([\s\S]*?)```/i);
    const diffPatch = diffMatch ? diffMatch[1].trim() : "";
    const explanation = content.replace(/```diff[\s\S]*?```/i, "").trim();

    let confidence: number | null = null;
    const confidenceMatch = content.match(/confidence\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)(%?)/i);
    if (confidenceMatch) {
      const raw = Number(confidenceMatch[1]);
      if (Number.isFinite(raw)) {
        confidence = confidenceMatch[2] === "%" ? raw / 100 : raw;
      }
    }

    return {
      explanation,
      diffPatch,
      confidence
    };
  };

  const laneNarrativeRequests = new Map<
    string,
    Promise<{
      jobId: string;
      artifactId: string;
      narrative: string;
    }>
  >();

  const conflictProposalRequests = new Map<
    string,
    Promise<{
      jobId: string;
      artifactId: string;
      explanation: string;
      diffPatch: string;
      confidence: number | null;
      rawContent: string;
    }>
  >();

  const prDescriptionRequests = new Map<
    string,
    Promise<{
      jobId: string;
      artifactId: string;
      title: string;
      body: string;
    }>
  >();

  const runSingleRequest = async <T>(args: {
    key: string;
    inFlight: Map<string, Promise<T>>;
    run: () => Promise<T>;
  }): Promise<T> => {
    const existing = args.inFlight.get(args.key);
    if (existing) return existing;
    const inFlight = args.run().finally(() => {
      args.inFlight.delete(args.key);
    });
    args.inFlight.set(args.key, inFlight);
    return inFlight;
  };

  const pollJob = async (jobId: string, timeoutMs = 120_000): Promise<HostedJobStatusResult> => {
    const started = Date.now();
    const effectiveTimeout = Math.max(POLL_TIMEOUT_FLOOR_MS, timeoutMs);
    let delayMs = POLL_INITIAL_DELAY_MS;
    let statusStreakStart = started;
    let lastStatus: HostedJobStatusResult["status"] | null = null;
    let consecutiveFailures = 0;

    while (true) {
      let status: HostedJobStatusResult;
      try {
        status = await getJob(jobId);
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures += 1;
        if (consecutiveFailures > 4) {
          throw new Error(
            `Unable to poll hosted job ${jobId} after ${consecutiveFailures} attempts: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        await sleep(Math.min(POLL_MAX_DELAY_MS, POLL_INITIAL_DELAY_MS * 2 ** consecutiveFailures));
        continue;
      }

      const normalizedStatus = status.status === "in_progress" ? "processing" : status.status;

      if (normalizedStatus !== lastStatus) {
        lastStatus = normalizedStatus;
        statusStreakStart = Date.now();
      }

      if (!["queued", "processing", "completed", "failed"].includes(normalizedStatus)) {
        throw new Error(`Hosted job ${jobId} returned unsupported status: ${status.status}`);
      }

      if (normalizedStatus === "completed" || normalizedStatus === "failed") {
        return status;
      }
      if (Date.now() - statusStreakStart > POLL_STALL_TIMEOUT_MS) {
        throw new Error(`Hosted job ${jobId} is stuck on status '${normalizedStatus}' for too long.`);
      }
      if (Date.now() - started > effectiveTimeout) {
        throw new Error(`Timed out waiting for hosted job ${jobId}`);
      }
      await sleep(delayMs);
      delayMs = Math.min(POLL_MAX_DELAY_MS, Math.max(POLL_INITIAL_DELAY_MS, Math.floor(delayMs * 1.8)));
    }
  };

  const performSignIn = async (args: HostedSignInArgs = {}): Promise<HostedSignInResult> => {
    const config = ensureHostedConfigured();
    const authorizeEndpoint = config.clerkOauthAuthorizeUrl.trim();
    const tokenEndpoint = config.clerkOauthTokenUrl.trim();
    if (!authorizeEndpoint || !tokenEndpoint || !config.clerkOauthClientId.trim()) {
      throw new Error("Hosted Clerk OAuth configuration is incomplete. Apply bootstrap config and try again.");
    }

    const state = base64Url(randomBytes(16));
    const codeVerifier = base64Url(randomBytes(48));
    const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());
    const redirectUri = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;

    const providerHint = args.provider === "github" || args.provider === "google" ? args.provider : undefined;

    const code = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        server.close();
        reject(new Error("Hosted sign-in timed out waiting for callback."));
      }, 180_000);

      const server = http.createServer((req, res) => {
        try {
          const url = new URL(req.url ?? "", `http://${CALLBACK_HOST}:${CALLBACK_PORT}`);
          if (url.pathname !== CALLBACK_PATH) {
            res.writeHead(404, { "content-type": "text/plain" });
            res.end("Not found");
            return;
          }

          const callbackError = url.searchParams.get("error") ?? "";
          const callbackErrorDescription = url.searchParams.get("error_description") ?? "";
          if (callbackError) {
            res.writeHead(400, { "content-type": "text/html" });
            res.end(
              `<html><body><h2>ADE sign-in failed</h2><p>${callbackErrorDescription || callbackError}</p><p>You can close this tab and retry in ADE.</p></body></html>`
            );
            clearTimeout(timeout);
            server.close();
            reject(new Error(`Hosted sign-in failed: ${callbackErrorDescription || callbackError}`));
            return;
          }

          const returnedState = url.searchParams.get("state") ?? "";
          const returnedCode = url.searchParams.get("code") ?? "";
          if (returnedState !== state || !returnedCode) {
            res.writeHead(400, { "content-type": "text/html" });
            res.end("<html><body><h2>ADE sign-in failed</h2><p>Invalid callback payload.</p></body></html>");
            clearTimeout(timeout);
            server.close();
            reject(new Error("Hosted sign-in callback payload was invalid."));
            return;
          }

          res.writeHead(200, { "content-type": "text/html" });
          res.end("<html><body><h2>ADE sign-in successful.</h2><p>You can close this tab.</p></body></html>");

          clearTimeout(timeout);
          server.close();
          resolve(returnedCode);
        } catch (error) {
          clearTimeout(timeout);
          server.close();
          reject(error);
        }
      });

      server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
        const authorizeUrl = new URL(authorizeEndpoint);
        authorizeUrl.searchParams.set("response_type", "code");
        authorizeUrl.searchParams.set("client_id", config.clerkOauthClientId);
        authorizeUrl.searchParams.set("redirect_uri", redirectUri);
        authorizeUrl.searchParams.set("scope", config.clerkOauthScopes || "openid profile email offline_access");
        authorizeUrl.searchParams.set("state", state);
        authorizeUrl.searchParams.set("code_challenge_method", "S256");
        authorizeUrl.searchParams.set("code_challenge", codeChallenge);
        authorizeUrl.searchParams.set("prompt", "login");

        void openExternal(authorizeUrl.toString()).catch((err) => {
          clearTimeout(timeout);
          server.close();
          reject(err);
        });
      });

      server.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    const tokenResponse = await fetchWithTimeout(tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clerkOauthClientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier
      }).toString()
    });

    const tokenPayload = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok) {
      throw new Error(`Hosted sign-in token exchange failed: ${parseErrorMessage(tokenPayload)}`);
    }

    const accessToken = asString((tokenPayload as Record<string, unknown>).access_token);
    const refreshToken = asString((tokenPayload as Record<string, unknown>).refresh_token);
    const idToken = asString((tokenPayload as Record<string, unknown>).id_token);
    const tokenType = asString((tokenPayload as Record<string, unknown>).token_type) || "Bearer";
    const expiresInSec = Number((tokenPayload as Record<string, unknown>).expires_in ?? 3600);
    const expiresAt = new Date(Date.now() + Math.max(60, expiresInSec) * 1000).toISOString();
    let profile = extractProfileFromClaims(decodeJwtClaims(idToken || accessToken));

    if ((!profile.email || !profile.displayName) && config.clerkOauthUserInfoUrl.trim() && accessToken) {
      const userInfoResponse = await fetchWithTimeout(config.clerkOauthUserInfoUrl, {
        headers: {
          authorization: `Bearer ${accessToken}`
        }
      }).catch(() => null);
      if (userInfoResponse?.ok) {
        const userInfoPayload = await userInfoResponse.json().catch(() => null);
        if (isRecord(userInfoPayload)) {
          profile = {
            ...extractProfileFromClaims(userInfoPayload),
            ...profile
          };
        }
      }
    }

    if (!accessToken) {
      throw new Error("Hosted sign-in did not return an access token.");
    }

    persistAuthTokens({
      accessToken,
      refreshToken,
      idToken,
      tokenType,
      expiresAt,
      ...profile
    });

    logger.info("hosted.sign_in_success", {
      projectId,
      expiresAt,
      providerHint: providerHint ?? "clerk"
    });

    return {
      signedIn: true,
      expiresAt
    };
  };

  const getAuthStatus = (): HostedAuthStatus => {
    const config = readHostedConfig();
    const expiresAt = config.auth.expiresAt ?? null;
    const hasRefreshToken = Boolean(config.auth.refreshToken);
    const hasValidAccessToken = !!config.auth.accessToken && !!expiresAt && Date.now() < Date.parse(expiresAt);
    return {
      signedIn: hasValidAccessToken || hasRefreshToken,
      expiresAt,
      hasRefreshToken,
      userId: config.auth.userId ?? null,
      email: config.auth.email ?? null,
      displayName: config.auth.displayName ?? null
    };
  };

  const getStatus = (): HostedStatus => {
    const config = readHostedConfig();
    return {
      enabled: config.mode === "hosted",
      mode: config.mode,
      consentGiven: config.consentGiven,
      apiConfigured: Boolean(config.apiBaseUrl.trim()),
      remoteProjectId: config.remoteProjectId,
      auth: getAuthStatus(),
      mirrorExcludePatterns: config.mirrorExcludePatterns,
      transcriptUploadEnabled: config.uploadTranscripts
    };
  };

  const signOut = (): void => {
    clearStoredAuthTokens();
  };

  const submitJob = async (args: HostedJobSubmissionArgs): Promise<HostedJobSubmissionResult> => {
    const remoteProjectId = await ensureRemoteProject();
    const response = await apiRequest<{ jobId: string; status: "queued" | "processing" | "completed" | "failed" }>({
      method: "POST",
      path: `/projects/${remoteProjectId}/jobs`,
      body: {
        type: args.type,
        laneId: args.laneId,
        params: args.params ?? {}
      }
    });

    return {
      remoteProjectId,
      jobId: response.jobId,
      status: response.status
    };
  };

  const getJob = async (jobId: string): Promise<HostedJobStatusResult> => {
    const remoteProjectId = await ensureRemoteProject();
    return await apiRequest<HostedJobStatusResult>({
      method: "GET",
      path: `/projects/${remoteProjectId}/jobs/${jobId}`
    });
  };

  const getArtifact = async (artifactId: string): Promise<HostedArtifactResult> => {
    const remoteProjectId = await ensureRemoteProject();
    const response = await apiRequest<{
      artifactId: string;
      type: string;
      content: unknown;
      createdAt: string;
      contentHash: string;
    }>({
      method: "GET",
      path: `/projects/${remoteProjectId}/artifacts/${artifactId}`
    });

    return {
      artifactId: response.artifactId,
      type: response.type,
      content: response.content,
      createdAt: response.createdAt,
      contentHash: response.contentHash
    };
  };

  const githubGetStatus = async (): Promise<HostedGitHubAppStatus> => {
    const remoteProjectId = await ensureRemoteProject();
    return await apiRequest<HostedGitHubAppStatus>({
      method: "GET",
      path: `/projects/${remoteProjectId}/github/status`
    });
  };

  const githubConnectStart = async (): Promise<HostedGitHubConnectStartResult> => {
    const remoteProjectId = await ensureRemoteProject();
    const response = await apiRequest<HostedGitHubConnectStartResult>({
      method: "POST",
      path: `/projects/${remoteProjectId}/github/connect/start`
    });
    await openExternal(response.installUrl);
    return response;
  };

  const githubDisconnect = async (): Promise<HostedGitHubDisconnectResult> => {
    const remoteProjectId = await ensureRemoteProject();
    return await apiRequest<HostedGitHubDisconnectResult>({
      method: "POST",
      path: `/projects/${remoteProjectId}/github/disconnect`
    });
  };

  const githubListEvents = async (): Promise<HostedGitHubEventsResult> => {
    const remoteProjectId = await ensureRemoteProject();
    return await apiRequest<HostedGitHubEventsResult>({
      method: "GET",
      path: `/projects/${remoteProjectId}/github/events`
    });
  };

  const githubProxyRequest = async <T>(args: HostedGitHubProxyRequestArgs): Promise<T> => {
    const remoteProjectId = await ensureRemoteProject();
    const response = await apiRequest<{ data: T }>({
      method: "POST",
      path: `/projects/${remoteProjectId}/github/api`,
      body: {
        method: args.method,
        path: args.path,
        query: args.query ?? {},
        body: args.body
      }
    });
    return response.data;
  };

  const syncMirror = async (args: HostedMirrorSyncArgs = {}): Promise<HostedMirrorSyncResult> => {
    const config = ensureHostedConfigured();
    const remoteProjectId = await ensureRemoteProject();

    const lanes = await laneService.list({ includeArchived: false });
    const targetLaneIds = args.laneId ? [args.laneId] : lanes.map((lane) => lane.id);

    const excludePatterns = [...DEFAULT_EXCLUDE_PATTERNS, ...config.mirrorExcludePatterns];

    let uploaded = 0;
    let deduplicated = 0;
    let excluded = 0;
    let manifestCount = 0;
    let packCount = 0;
    let transcriptCount = 0;

    for (const laneId of targetLaneIds) {
      const laneResult = await syncLaneMirror({
        laneId,
        remoteProjectId,
        excludePatterns
      });
      uploaded += laneResult.uploaded;
      deduplicated += laneResult.deduplicated;
      excluded += laneResult.excluded;
      manifestCount += laneResult.manifestCount;
    }

    const packResult = await syncPacks(remoteProjectId, excludePatterns);
    uploaded += packResult.uploaded;
    deduplicated += packResult.deduplicated;
    excluded += packResult.excluded;
    packCount += packResult.packCount;

    if (config.uploadTranscripts && args.includeTranscripts) {
      const transcriptResult = await syncTranscripts(remoteProjectId, excludePatterns);
      uploaded += transcriptResult.uploaded;
      deduplicated += transcriptResult.deduplicated;
      excluded += transcriptResult.excluded;
      transcriptCount += transcriptResult.transcriptCount;
    }

    return {
      remoteProjectId,
      lanesSynced: targetLaneIds,
      uploaded,
      deduplicated,
      excluded,
      manifestCount,
      transcriptCount,
      packCount,
      syncedAt: nowIso()
    };
  };

  return {
    getStatus,

    getBootstrapConfig(): HostedBootstrapConfig | null {
      return readBootstrapConfig();
    },

    applyBootstrapConfig(): HostedBootstrapConfig {
      return applyBootstrapHostedConfig();
    },

    async signIn(args: HostedSignInArgs = {}): Promise<HostedSignInResult> {
      return await performSignIn(args);
    },

    signOut,

    async syncMirror(args: HostedMirrorSyncArgs = {}): Promise<HostedMirrorSyncResult> {
      return await syncMirror(args);
    },

    async submitJob(args: HostedJobSubmissionArgs): Promise<HostedJobSubmissionResult> {
      return await submitJob(args);
    },

    async getJob(jobId: string): Promise<HostedJobStatusResult> {
      return await getJob(jobId);
    },

    async getArtifact(artifactId: string): Promise<HostedArtifactResult> {
      return await getArtifact(artifactId);
    },

    async githubGetStatus(): Promise<HostedGitHubAppStatus> {
      return await githubGetStatus();
    },

    async githubConnectStart(): Promise<HostedGitHubConnectStartResult> {
      return await githubConnectStart();
    },

    async githubDisconnect(): Promise<HostedGitHubDisconnectResult> {
      return await githubDisconnect();
    },

    async githubListEvents(): Promise<HostedGitHubEventsResult> {
      return await githubListEvents();
    },

    async githubProxyRequest<T>(args: HostedGitHubProxyRequestArgs): Promise<T> {
      return await githubProxyRequest<T>(args);
    },

    async waitForJob(jobId: string, timeoutMs?: number): Promise<HostedJobStatusResult> {
      return await pollJob(jobId, timeoutMs);
    },

    async requestConflictProposal(args: {
      laneId: string;
      peerLaneId?: string | null;
      conflictContext: Record<string, unknown>;
    }): Promise<{
      jobId: string;
      artifactId: string;
      explanation: string;
      diffPatch: string;
      confidence: number | null;
      rawContent: string;
    }> {
      const requestKey = makeRequestKey("conflict-proposal", {
        laneId: args.laneId,
        peerLaneId: args.peerLaneId ?? null,
        context: args.conflictContext
      });

      return runSingleRequest({
        key: requestKey,
        inFlight: conflictProposalRequests,
        run: async () => {
          const submission = await submitJob({
            type: "ProposeConflictResolution" as HostedJobType,
            laneId: args.laneId,
            params: {
              peerLaneId: args.peerLaneId ?? null,
              ...args.conflictContext
            }
          });

          const status = await pollJob(submission.jobId, 180_000);
          if (status.status !== "completed" || !status.artifactId) {
            const message = status.error?.message ?? `Proposal job ${status.jobId} did not complete successfully.`;
            throw new Error(message);
          }

          const artifact = await getArtifact(status.artifactId);
          const contentRaw = isRecord(artifact.content) && typeof artifact.content.content === "string"
            ? (artifact.content.content as string)
            : typeof artifact.content === "string"
              ? artifact.content
              : JSON.stringify(artifact.content, null, 2);

          const parsed = parseDiffFromContent(contentRaw);

          return {
            jobId: submission.jobId,
            artifactId: artifact.artifactId,
            explanation: parsed.explanation,
            diffPatch: parsed.diffPatch,
            confidence: parsed.confidence,
            rawContent: contentRaw
          };
        }
      });
    },

    async requestLaneNarrative(args: { laneId: string; packBody: string }): Promise<{
      jobId: string;
      artifactId: string;
      narrative: string;
    }> {
      const requestKey = makeRequestKey("lane-narrative", {
        laneId: args.laneId,
        packBody: args.packBody
      });

      return runSingleRequest({
        key: requestKey,
        inFlight: laneNarrativeRequests,
        run: async () => {
          const submission = await submitJob({
            type: "NarrativeGeneration" as HostedJobType,
            laneId: args.laneId,
            params: {
              packBody: args.packBody
            }
          });

          const status = await pollJob(submission.jobId, 120_000);
          if (status.status !== "completed" || !status.artifactId) {
            const message = status.error?.message ?? `Narrative job ${status.jobId} did not complete successfully.`;
            throw new Error(message);
          }

          const artifact = await getArtifact(status.artifactId);
          const narrative = isRecord(artifact.content) && typeof artifact.content.content === "string"
            ? (artifact.content.content as string)
            : typeof artifact.content === "string"
              ? artifact.content
              : JSON.stringify(artifact.content, null, 2);

          return {
            jobId: submission.jobId,
            artifactId: artifact.artifactId,
            narrative
          };
        }
      });
    },

    async requestPrDescription(args: {
      laneId: string;
      prContext: Record<string, unknown>;
    }): Promise<{
      jobId: string;
      artifactId: string;
      title: string;
      body: string;
    }> {
      const requestKey = makeRequestKey("pr-description", {
        laneId: args.laneId,
        prContext: args.prContext
      });

      return runSingleRequest({
        key: requestKey,
        inFlight: prDescriptionRequests,
        run: async () => {
          const submission = await submitJob({
            type: "DraftPrDescription" as HostedJobType,
            laneId: args.laneId,
            params: args.prContext
          });

          const status = await pollJob(submission.jobId, 120_000);
          if (status.status !== "completed" || !status.artifactId) {
            const message = status.error?.message ?? `PR drafting job ${status.jobId} did not complete successfully.`;
            throw new Error(message);
          }

          const artifact = await getArtifact(status.artifactId);
          const body = isRecord(artifact.content) && typeof artifact.content.content === "string"
            ? (artifact.content.content as string)
            : typeof artifact.content === "string"
              ? artifact.content
              : JSON.stringify(artifact.content, null, 2);

          return {
            jobId: submission.jobId,
            artifactId: artifact.artifactId,
            title: "",
            body
          };
        }
      });
    }
  };
}
