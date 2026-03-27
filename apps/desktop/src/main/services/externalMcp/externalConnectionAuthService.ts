import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { safeStorage } from "electron";
import type {
  ExternalConnectionAuthMode,
  ExternalConnectionAuthPlacement,
  ExternalConnectionAuthRecord,
  ExternalConnectionAuthRecordInput,
  ExternalConnectionAuthStatus,
  ExternalConnectionOAuthSessionResult,
  ExternalConnectionOAuthSessionStartResult,
  ExternalMcpManagedAuthConfig,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import { createPkcePair, getErrorMessage, isEnoentError, isRecord, nowIso } from "../shared/utils";

const STORE_FILE = "external-connection-auth.v1.bin";
const OAUTH_CALLBACK_PATH = "/oauth/external-mcp/callback";
const OAUTH_SESSION_TTL_MS = 10 * 60 * 1000;
const OAUTH_EXPIRY_SKEW_MS = 60_000;

type StoredAuthState = {
  records: ExternalConnectionAuthRecord[];
  secrets: Record<string, string>;
};

type OAuthSessionState = {
  id: string;
  authId: string;
  state: string;
  redirectUri: string;
  authUrl: string;
  codeVerifier: string | null;
  createdAt: number;
  status: ExternalConnectionOAuthSessionResult["status"];
  error: string | null;
  server: http.Server;
};


function createEmptyState(): StoredAuthState {
  return { records: [], secrets: {} };
}

function normalizeStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value)
    .map(([key, raw]) => {
      const nextKey = key.trim();
      const nextValue = typeof raw === "string" ? raw.trim() : "";
      return nextKey && nextValue ? [nextKey, nextValue] as const : null;
    })
    .filter((entry): entry is readonly [string, string] => entry != null);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeOAuthRecord(value: unknown): ExternalConnectionAuthRecord["oauth"] | undefined {
  if (!isRecord(value)) return undefined;
  const authorizeUrl = typeof value.authorizeUrl === "string" ? value.authorizeUrl.trim() : "";
  const tokenUrl = typeof value.tokenUrl === "string" ? value.tokenUrl.trim() : "";
  const clientId = typeof value.clientId === "string" ? value.clientId.trim() : "";
  if (!authorizeUrl.length || !tokenUrl.length || !clientId.length) return undefined;
  return {
    authorizeUrl,
    tokenUrl,
    clientId,
    scope: typeof value.scope === "string" && value.scope.trim().length ? value.scope.trim() : null,
    audience: typeof value.audience === "string" && value.audience.trim().length ? value.audience.trim() : null,
    extraAuthorizeParams: normalizeStringMap(value.extraAuthorizeParams),
    extraTokenParams: normalizeStringMap(value.extraTokenParams),
    clientSecretId: typeof value.clientSecretId === "string" && value.clientSecretId.trim().length ? value.clientSecretId.trim() : null,
    accessTokenId: typeof value.accessTokenId === "string" && value.accessTokenId.trim().length ? value.accessTokenId.trim() : null,
    refreshTokenId: typeof value.refreshTokenId === "string" && value.refreshTokenId.trim().length ? value.refreshTokenId.trim() : null,
    expiresAt: typeof value.expiresAt === "string" && value.expiresAt.trim().length ? value.expiresAt.trim() : null,
    lastAuthenticatedAt:
      typeof value.lastAuthenticatedAt === "string" && value.lastAuthenticatedAt.trim().length
        ? value.lastAuthenticatedAt.trim()
        : null,
  };
}

function normalizeRecord(value: unknown): ExternalConnectionAuthRecord | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const displayName = typeof value.displayName === "string" ? value.displayName.trim() : "";
  const mode = value.mode;
  if (!id.length || !displayName.length) return null;
  if (mode !== "none" && mode !== "api_key" && mode !== "bearer" && mode !== "oauth") return null;
  return {
    id,
    displayName,
    mode,
    secretId: typeof value.secretId === "string" && value.secretId.trim().length ? value.secretId.trim() : null,
    oauth: normalizeOAuthRecord(value.oauth),
    createdAt: typeof value.createdAt === "string" && value.createdAt.trim().length ? value.createdAt.trim() : nowIso(),
    updatedAt: typeof value.updatedAt === "string" && value.updatedAt.trim().length ? value.updatedAt.trim() : nowIso(),
    lastError: typeof value.lastError === "string" && value.lastError.trim().length ? value.lastError.trim() : null,
  };
}

function isExpired(expiresAt?: string | null): boolean {
  if (!expiresAt) return false;
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return false;
  return Date.now() + OAUTH_EXPIRY_SKEW_MS >= expiresAtMs;
}

function buildPreview(placement: ExternalConnectionAuthPlacement | undefined, mode: ExternalConnectionAuthMode): string[] {
  if (!placement) return [];
  const key = placement.key.trim();
  if (!key.length) return [];
  const prefix = placement.prefix ?? (mode === "bearer" || mode === "oauth" ? "Bearer " : "");
  if (placement.target === "header") {
    return [`${key}: ${prefix}[stored credential]`];
  }
  return [`${key}=${prefix}[stored credential]`];
}

export function createExternalConnectionAuthService(args: {
  adeDir: string;
  logger?: Logger | null;
  fetchImpl?: typeof fetch;
}) {
  const secretsDir = path.join(args.adeDir, "secrets");
  const statePath = path.join(secretsDir, STORE_FILE);
  const fetchImpl = args.fetchImpl ?? fetch;
  const sessions = new Map<string, OAuthSessionState>();
  let cachedState: StoredAuthState | null = null;

  const assertStorageAvailable = (): void => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS secure storage is unavailable. External MCP credentials cannot be stored.");
    }
  };

  const readState = (): StoredAuthState => {
    if (cachedState) return cachedState;
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        cachedState = createEmptyState();
        return cachedState;
      }
      const encrypted = fs.readFileSync(statePath);
      const decrypted = safeStorage.decryptString(encrypted);
      const parsed = JSON.parse(decrypted) as StoredAuthState;
      const records = Array.isArray(parsed.records)
        ? parsed.records.map((entry) => normalizeRecord(entry)).filter((entry): entry is ExternalConnectionAuthRecord => entry != null)
        : [];
      const secrets = isRecord(parsed.secrets)
        ? Object.fromEntries(
            Object.entries(parsed.secrets)
              .map(([key, value]) => [key.trim(), typeof value === "string" ? value : ""] as const)
              .filter(([key, value]) => key.length > 0 && value.length > 0),
          )
        : {};
      cachedState = { records, secrets };
      return cachedState;
    } catch (error: unknown) {
      if (isEnoentError(error)) {
        cachedState = createEmptyState();
        return cachedState;
      }
      args.logger?.warn("external_auth.read_failed", { error: getErrorMessage(error) });
      cachedState = createEmptyState();
      return cachedState;
    }
  };

  const writeState = (next: StoredAuthState): void => {
    assertStorageAvailable();
    fs.mkdirSync(secretsDir, { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify(next));
    fs.writeFileSync(statePath, encrypted);
    try {
      fs.chmodSync(statePath, 0o600);
    } catch {
      // best effort
    }
    cachedState = next;
  };

  const mutateState = <T,>(mutator: (state: StoredAuthState) => T): T => {
    const current = readState();
    const next: StoredAuthState = {
      records: current.records.map((entry) => ({ ...entry, ...(entry.oauth ? { oauth: { ...entry.oauth } } : {}) })),
      secrets: { ...current.secrets },
    };
    const result = mutator(next);
    writeState(next);
    return result;
  };

  const getRecordById = (authId: string): ExternalConnectionAuthRecord | null => {
    const normalized = authId.trim();
    if (!normalized.length) return null;
    return readState().records.find((entry) => entry.id === normalized) ?? null;
  };

  const getSecret = (secretId?: string | null): string | null => {
    const normalized = secretId?.trim() ?? "";
    if (!normalized.length) return null;
    return readState().secrets[normalized] ?? null;
  };

  const ensureOAuthRecord = (authId: string): ExternalConnectionAuthRecord => {
    const record = getRecordById(authId);
    if (!record) throw new Error(`External auth record '${authId}' was not found.`);
    if (record.mode !== "oauth" || !record.oauth) {
      throw new Error(`External auth record '${authId}' is not configured for OAuth.`);
    }
    return record;
  };

  const finalizeSession = (
    session: OAuthSessionState,
    patch: { status: OAuthSessionState["status"]; error?: string | null },
  ) => {
    session.status = patch.status;
    session.error = patch.error ?? null;
    try {
      session.server.close();
    } catch {
      // best effort
    }
  };

  const pruneExpiredSessions = () => {
    const now = Date.now();
    for (const session of sessions.values()) {
      if (session.status === "pending" && now - session.createdAt > OAUTH_SESSION_TTL_MS) {
        finalizeSession(session, {
          status: "expired",
          error: "OAuth session expired before the callback completed.",
        });
      }
      if (session.status !== "pending" && now - session.createdAt > OAUTH_SESSION_TTL_MS * 2) {
        sessions.delete(session.id);
      }
    }
  };

  const saveOAuthTokenPayload = (
    authId: string,
    payload: {
      accessToken: string;
      refreshToken?: string | null;
      expiresAt?: string | null;
      lastError?: string | null;
    },
  ): ExternalConnectionAuthRecord => mutateState((state) => {
    const index = state.records.findIndex((entry) => entry.id === authId);
    if (index < 0) {
      throw new Error(`External auth record '${authId}' was not found.`);
    }
    const current = state.records[index]!;
    if (current.mode !== "oauth" || !current.oauth) {
      throw new Error(`External auth record '${authId}' is not configured for OAuth.`);
    }
    const accessTokenId = current.oauth.accessTokenId ?? `${authId}:access-token`;
    state.secrets[accessTokenId] = payload.accessToken.trim();
    let refreshTokenId = current.oauth.refreshTokenId ?? null;
    const refreshToken = payload.refreshToken?.trim() ?? "";
    if (refreshToken.length) {
      refreshTokenId = refreshTokenId ?? `${authId}:refresh-token`;
      state.secrets[refreshTokenId] = refreshToken;
    }
    const nextRecord: ExternalConnectionAuthRecord = {
      ...current,
      updatedAt: nowIso(),
      lastError: payload.lastError ?? null,
      oauth: {
        ...current.oauth,
        accessTokenId,
        refreshTokenId,
        expiresAt: payload.expiresAt ?? null,
        lastAuthenticatedAt: nowIso(),
      },
    };
    state.records[index] = nextRecord;
    return nextRecord;
  });

  const exchangeOAuthCode = async (session: OAuthSessionState, code: string): Promise<void> => {
    const record = ensureOAuthRecord(session.authId);
    const oauth = record.oauth!;
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: session.redirectUri,
      client_id: oauth.clientId,
    });
    const clientSecret = getSecret(oauth.clientSecretId);
    if (clientSecret?.trim()) body.set("client_secret", clientSecret.trim());
    if (session.codeVerifier) body.set("code_verifier", session.codeVerifier);
    if (oauth.audience?.trim()) body.set("audience", oauth.audience.trim());
    for (const [key, value] of Object.entries(oauth.extraTokenParams ?? {})) {
      if (!body.has(key)) body.set(key, value);
    }

    const response = await fetchImpl(oauth.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const payload = await response.json().catch(() => ({})) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };

    if (!response.ok || typeof payload.access_token !== "string" || !payload.access_token.trim()) {
      throw new Error(payload.error_description ?? payload.error ?? `OAuth token exchange failed (HTTP ${response.status}).`);
    }

    const expiresAt =
      typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
        ? new Date(Date.now() + payload.expires_in * 1000).toISOString()
        : null;

    saveOAuthTokenPayload(session.authId, {
      accessToken: payload.access_token.trim(),
      refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token.trim() : null,
      expiresAt,
      lastError: null,
    });
  };

  const refreshOAuthToken = async (authId: string): Promise<ExternalConnectionAuthRecord> => {
    const record = ensureOAuthRecord(authId);
    const oauth = record.oauth!;
    const refreshToken = getSecret(oauth.refreshTokenId);
    if (!refreshToken?.trim()) {
      throw new Error("OAuth refresh token is missing. Reconnect the account.");
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken.trim(),
      client_id: oauth.clientId,
    });
    const clientSecret = getSecret(oauth.clientSecretId);
    if (clientSecret?.trim()) body.set("client_secret", clientSecret.trim());
    if (oauth.audience?.trim()) body.set("audience", oauth.audience.trim());
    for (const [key, value] of Object.entries(oauth.extraTokenParams ?? {})) {
      if (!body.has(key)) body.set(key, value);
    }
    const response = await fetchImpl(oauth.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const payload = await response.json().catch(() => ({})) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!response.ok || typeof payload.access_token !== "string" || !payload.access_token.trim()) {
      mutateState((state) => {
        const index = state.records.findIndex((entry) => entry.id === authId);
        if (index >= 0) {
          state.records[index] = {
            ...state.records[index]!,
            updatedAt: nowIso(),
            lastError: payload.error_description ?? payload.error ?? `OAuth refresh failed (HTTP ${response.status}).`,
          };
        }
      });
      throw new Error(payload.error_description ?? payload.error ?? `OAuth refresh failed (HTTP ${response.status}).`);
    }
    const expiresAt =
      typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
        ? new Date(Date.now() + payload.expires_in * 1000).toISOString()
        : null;
    return saveOAuthTokenPayload(authId, {
      accessToken: payload.access_token.trim(),
      refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token.trim() : null,
      expiresAt,
      lastError: null,
    });
  };

  const materializeAuthBinding = async (
    binding?: ExternalMcpManagedAuthConfig | null,
  ): Promise<{
    headers?: Record<string, string>;
    env?: Record<string, string>;
    status: ExternalConnectionAuthStatus;
  }> => {
    if (!binding) {
      return {
        status: {
          mode: "none",
          state: "ready",
          summary: "No managed auth configured.",
          materializationPreview: [],
        },
      };
    }

    const record = getRecordById(binding.authId);
    if (!record) {
      return {
        status: {
          authId: binding.authId,
          mode: binding.mode,
          state: "missing",
          summary: "Managed auth reference is missing.",
          materializationPreview: buildPreview(binding.placement, binding.mode),
        },
      };
    }

    const placement = binding.placement;
    const preview = buildPreview(placement, record.mode);

    if (record.mode === "none") {
      return {
        status: {
          authId: record.id,
          mode: record.mode,
          state: "ready",
          summary: "No auth required.",
          materializationPreview: preview,
          updatedAt: record.updatedAt,
        },
      };
    }

    if (record.mode === "api_key" || record.mode === "bearer") {
      const secret = getSecret(record.secretId);
      if (!secret?.trim()) {
        return {
          status: {
            authId: record.id,
            mode: record.mode,
            state: "needs_auth",
            summary: "Stored credential is missing.",
            materializationPreview: preview,
            updatedAt: record.updatedAt,
            lastError: record.lastError ?? null,
          },
        };
      }
      const prefix = placement.prefix ?? (record.mode === "bearer" ? "Bearer " : "");
      const value = `${prefix}${secret.trim()}`;
      return {
        ...(placement.target === "header"
          ? { headers: { [placement.key]: value } }
          : { env: { [placement.key]: value } }),
        status: {
          authId: record.id,
          mode: record.mode,
          state: "ready",
          summary: "Stored credential is ready.",
          materializationPreview: preview,
          updatedAt: record.updatedAt,
          lastError: record.lastError ?? null,
        },
      };
    }

    const oauth = record.oauth;
    if (!oauth) {
      return {
        status: {
          authId: record.id,
          mode: "oauth",
          state: "needs_auth",
          summary: "OAuth settings are incomplete.",
          materializationPreview: preview,
          updatedAt: record.updatedAt,
          lastError: record.lastError ?? null,
        },
      };
    }

    let effectiveRecord = record;
    let accessToken = getSecret(oauth.accessTokenId);
    if ((!accessToken?.trim() || isExpired(oauth.expiresAt)) && getSecret(oauth.refreshTokenId)) {
      effectiveRecord = await refreshOAuthToken(record.id);
      accessToken = getSecret(effectiveRecord.oauth?.accessTokenId);
    }
    if (!accessToken?.trim()) {
      return {
        status: {
          authId: effectiveRecord.id,
          mode: effectiveRecord.mode,
          state: isExpired(effectiveRecord.oauth?.expiresAt) ? "expired" : "needs_auth",
          summary: "OAuth account is not connected.",
          materializationPreview: preview,
          lastAuthenticatedAt: effectiveRecord.oauth?.lastAuthenticatedAt ?? null,
          expiresAt: effectiveRecord.oauth?.expiresAt ?? null,
          updatedAt: effectiveRecord.updatedAt,
          lastError: effectiveRecord.lastError ?? null,
        },
      };
    }

    const prefix = placement.prefix ?? "Bearer ";
    const value = `${prefix}${accessToken.trim()}`;
    return {
      ...(placement.target === "header"
        ? { headers: { [placement.key]: value } }
        : { env: { [placement.key]: value } }),
      status: {
        authId: effectiveRecord.id,
        mode: effectiveRecord.mode,
        state: "ready",
        summary: "Connected account is ready.",
        materializationPreview: preview,
        lastAuthenticatedAt: effectiveRecord.oauth?.lastAuthenticatedAt ?? null,
        expiresAt: effectiveRecord.oauth?.expiresAt ?? null,
        updatedAt: effectiveRecord.updatedAt,
        lastError: effectiveRecord.lastError ?? null,
      },
    };
  };

  const saveAuthRecord = (input: ExternalConnectionAuthRecordInput): ExternalConnectionAuthRecord => mutateState((state) => {
    const id = input.id?.trim() || `ext-auth-${randomUUID()}`;
    const displayName = input.displayName.trim();
    if (!displayName.length) throw new Error("Display name is required.");
    const existingIndex = state.records.findIndex((entry) => entry.id === id);
    const existing = existingIndex >= 0 ? state.records[existingIndex]! : null;
    const createdAt = existing?.createdAt ?? nowIso();
    const updatedAt = nowIso();
    const next: ExternalConnectionAuthRecord = {
      id,
      displayName,
      mode: input.mode,
      secretId: existing?.secretId ?? null,
      createdAt,
      updatedAt,
      lastError: existing?.lastError ?? null,
    };

    if (input.mode === "api_key" || input.mode === "bearer") {
      const secretId = existing?.secretId ?? `${id}:secret`;
      const secret = input.secret?.trim() ?? "";
      if (secret.length) {
        state.secrets[secretId] = secret;
      } else if (!(secretId in state.secrets)) {
        next.lastError = "Credential not set yet.";
      }
      next.secretId = secretId;
    } else if (input.mode === "oauth") {
      const oauthInput = input.oauth;
      if (!oauthInput) throw new Error("OAuth settings are required.");
      const existingOAuth = existing?.oauth;
      const clientSecret = oauthInput.clientSecret?.trim() ?? "";
      let clientSecretId = existingOAuth?.clientSecretId ?? null;
      if (clientSecret.length) {
        clientSecretId = clientSecretId ?? `${id}:client-secret`;
        state.secrets[clientSecretId] = clientSecret;
      }
      next.oauth = {
        authorizeUrl: oauthInput.authorizeUrl.trim(),
        tokenUrl: oauthInput.tokenUrl.trim(),
        clientId: oauthInput.clientId.trim(),
        scope: oauthInput.scope?.trim() ? oauthInput.scope.trim() : null,
        audience: oauthInput.audience?.trim() ? oauthInput.audience.trim() : null,
        extraAuthorizeParams: normalizeStringMap(oauthInput.extraAuthorizeParams),
        extraTokenParams: normalizeStringMap(oauthInput.extraTokenParams),
        clientSecretId,
        accessTokenId: existingOAuth?.accessTokenId ?? `${id}:access-token`,
        refreshTokenId: existingOAuth?.refreshTokenId ?? `${id}:refresh-token`,
        expiresAt: existingOAuth?.expiresAt ?? null,
        lastAuthenticatedAt: existingOAuth?.lastAuthenticatedAt ?? null,
      };
    }

    if (existingIndex >= 0) state.records[existingIndex] = next;
    else state.records.push(next);
    state.records.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return next;
  });

  return {
    listRecords(): ExternalConnectionAuthRecord[] {
      return [...readState().records].sort((a, b) => a.displayName.localeCompare(b.displayName));
    },

    getRecord(authId: string): ExternalConnectionAuthRecord | null {
      return getRecordById(authId);
    },

    saveRecord(input: ExternalConnectionAuthRecordInput): ExternalConnectionAuthRecord {
      return saveAuthRecord(input);
    },

    removeRecord(authId: string): ExternalConnectionAuthRecord[] {
      return mutateState((state) => {
        const record = state.records.find((entry) => entry.id === authId) ?? null;
        state.records = state.records.filter((entry) => entry.id !== authId);
        if (record?.secretId) delete state.secrets[record.secretId];
        if (record?.oauth?.clientSecretId) delete state.secrets[record.oauth.clientSecretId];
        if (record?.oauth?.accessTokenId) delete state.secrets[record.oauth.accessTokenId];
        if (record?.oauth?.refreshTokenId) delete state.secrets[record.oauth.refreshTokenId];
        return [...state.records].sort((a, b) => a.displayName.localeCompare(b.displayName));
      });
    },

    async getStatusForBinding(binding?: ExternalMcpManagedAuthConfig | null): Promise<ExternalConnectionAuthStatus> {
      try {
        const materialized = await materializeAuthBinding(binding);
        return materialized.status;
      } catch (error: unknown) {
        return {
          authId: binding?.authId ?? null,
          mode: binding?.mode ?? "none",
          state: "error",
          summary: getErrorMessage(error),
          materializationPreview: buildPreview(binding?.placement, binding?.mode ?? "none"),
        };
      }
    },

    async getBindingSignature(binding?: ExternalMcpManagedAuthConfig | null): Promise<string> {
      const record = binding?.authId ? getRecordById(binding.authId) : null;
      const updatedAt = record?.updatedAt ?? "none";
      const expiresAt = record?.oauth?.expiresAt ?? "";
      return JSON.stringify({
        authId: binding?.authId ?? null,
        mode: binding?.mode ?? "none",
        placement: binding?.placement ?? null,
        updatedAt,
        expiresAt,
      });
    },

    async materializeBinding(binding?: ExternalMcpManagedAuthConfig | null) {
      return materializeAuthBinding(binding);
    },

    async startOAuthSession(authId: string): Promise<ExternalConnectionOAuthSessionStartResult> {
      pruneExpiredSessions();
      for (const session of sessions.values()) {
        if (session.authId === authId && session.status === "pending") {
          finalizeSession(session, { status: "expired", error: "Superseded by a new OAuth attempt." });
        }
      }
      const record = ensureOAuthRecord(authId);
      const oauth = record.oauth!;
      if (!oauth.authorizeUrl.trim() || !oauth.tokenUrl.trim() || !oauth.clientId.trim()) {
        throw new Error("OAuth settings are incomplete.");
      }
      const sessionId = `ext-mcp-oauth-${randomUUID()}`;
      const state = randomUUID();
      const clientSecret = getSecret(oauth.clientSecretId);
      const pkce = clientSecret?.trim() ? null : createPkcePair();

      let session: OAuthSessionState | null = null;
      const server = http.createServer(async (req, res) => {
        if (!session) {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end("OAuth session not ready.");
          return;
        }
        try {
          const requestUrl = new URL(req.url ?? OAUTH_CALLBACK_PATH, session.redirectUri);
          const returnedState = requestUrl.searchParams.get("state");
          const code = requestUrl.searchParams.get("code");
          const error = requestUrl.searchParams.get("error");
          const errorDescription = requestUrl.searchParams.get("error_description");

          if (returnedState !== session.state) {
            finalizeSession(session, { status: "failed", error: "OAuth callback state mismatch." });
            res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
            res.end("OAuth state mismatch.");
            return;
          }
          if (error) {
            finalizeSession(session, { status: "failed", error: errorDescription ?? error });
            res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
            res.end("Authorization was declined.");
            return;
          }
          if (!code) {
            finalizeSession(session, { status: "failed", error: "Missing authorization code." });
            res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
            res.end("Missing authorization code.");
            return;
          }
          await exchangeOAuthCode(session, code);
          finalizeSession(session, { status: "completed" });
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end("<!doctype html><html><body style=\"font-family:Geist,-apple-system,BlinkMacSystemFont,sans-serif;padding:24px\">External MCP connected. You can close this window and return to ADE.</body></html>");
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          finalizeSession(session, { status: "failed", error: message });
          args.logger?.warn("external_auth.oauth_callback_failed", { authId, error: message });
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end(message);
        }
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        throw new Error("Failed to allocate a loopback port for OAuth.");
      }

      const redirectUri = `http://127.0.0.1:${address.port}${OAUTH_CALLBACK_PATH}`;
      const authUrl = new URL(oauth.authorizeUrl);
      authUrl.searchParams.set("client_id", oauth.clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("state", state);
      if (oauth.scope?.trim()) authUrl.searchParams.set("scope", oauth.scope.trim());
      if (oauth.audience?.trim()) authUrl.searchParams.set("audience", oauth.audience.trim());
      for (const [key, value] of Object.entries(oauth.extraAuthorizeParams ?? {})) {
        authUrl.searchParams.set(key, value);
      }
      if (pkce) {
        authUrl.searchParams.set("code_challenge_method", "S256");
        authUrl.searchParams.set("code_challenge", pkce.challenge);
      }

      session = {
        id: sessionId,
        authId,
        state,
        redirectUri,
        authUrl: authUrl.toString(),
        codeVerifier: pkce?.verifier ?? null,
        createdAt: Date.now(),
        status: "pending",
        error: null,
        server,
      };
      sessions.set(sessionId, session);

      mutateState((stateDoc) => {
        const index = stateDoc.records.findIndex((entry) => entry.id === authId);
        if (index >= 0) {
          stateDoc.records[index] = {
            ...stateDoc.records[index]!,
            updatedAt: nowIso(),
            lastError: null,
          };
        }
      });

      return {
        sessionId,
        authId,
        authUrl: session.authUrl,
        redirectUri,
      };
    },

    getOAuthSession(sessionId: string): ExternalConnectionOAuthSessionResult {
      pruneExpiredSessions();
      const session = sessions.get(sessionId);
      if (!session) {
        return {
          authId: "",
          status: "expired",
          error: "OAuth session not found or already expired.",
        };
      }
      return {
        authId: session.authId,
        status: session.status,
        error: session.error,
      };
    },

    dispose(): void {
      for (const session of sessions.values()) {
        try {
          session.server.close();
        } catch {
          // best effort
        }
      }
      sessions.clear();
    },
  };
}

export type ExternalConnectionAuthService = ReturnType<typeof createExternalConnectionAuthService>;
