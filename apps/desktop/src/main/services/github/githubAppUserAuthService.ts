import { randomUUID } from "node:crypto";
import type {
  GitHubAppDeviceAuthPollResult,
  GitHubAppDeviceAuthStartResult,
  GitHubAppUserAuthStatus,
} from "../../../shared/types";
import {
  ADE_GITHUB_APP_CLIENT_ID,
  type GitHubAppDeviceCode,
  type GitHubAppUserTokenRecord,
  pollGitHubAppDeviceFlow,
  refreshGitHubAppUserToken,
  startGitHubAppDeviceFlow,
} from "./githubAppUserAuth";
import {
  createGitHubRelayAuthAuditLog,
  type GitHubRelayAuthAuditLog,
} from "./githubRelayConfig";
import { GITHUB_REST_API_VERSION } from "./githubApiVersion";
import { asString } from "../shared/utils";

const GITHUB_APP_USER_TOKEN_KEY = "github.appUserToken.v1";
const GITHUB_APP_USER_TOKEN_REFRESH_SKEW_MS = 2 * 60_000;
const MAX_PENDING_DEVICE_AUTH_SESSIONS = 5;

export type GitHubAppUserAuthCredentialStore = {
  getSync(key: string): string | null | undefined;
  setSync(key: string, value: string): void;
  deleteSync(key: string): void;
};

type GitHubAppDeviceAuthSession = GitHubAppDeviceCode & {
  sessionId: string;
  intervalSec: number;
};

type GitHubAppUserAuthLogger = {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
};

export function createGitHubAppUserAuthService(args: {
  credentialStore?: GitHubAppUserAuthCredentialStore | null;
  logger: GitHubAppUserAuthLogger;
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  userAgent: string;
}): {
  getAuthStatus(patch?: Partial<GitHubAppUserAuthStatus>): GitHubAppUserAuthStatus;
  startDeviceAuth(): Promise<GitHubAppDeviceAuthStartResult>;
  pollDeviceAuth(args: { sessionId: string }): Promise<GitHubAppDeviceAuthPollResult>;
  clearAuth(): GitHubAppUserAuthStatus;
  getValidTokenForRelay(): Promise<string>;
  auditLog: GitHubRelayAuthAuditLog;
} {
  const appDeviceAuthSessions = new Map<string, GitHubAppDeviceAuthSession>();
  let appUserTokenMemory: GitHubAppUserTokenRecord | null = null;
  let refreshInFlight: Promise<GitHubAppUserTokenRecord> | null = null;
  // Bumped whenever stored auth is replaced or cleared outside the refresh
  // path, so an in-flight refresh cannot overwrite the newer auth state.
  let authEpoch = 0;

  const auditLog = createGitHubRelayAuthAuditLog(args.logger.info.bind(args.logger));

  const pruneExpiredDeviceAuthSessions = (requestedSessionId?: string): boolean => {
    const now = Date.now();
    let requestedExpired = false;
    for (const [sessionId, session] of appDeviceAuthSessions.entries()) {
      if (Date.parse(session.expiresAt) <= now) {
        appDeviceAuthSessions.delete(sessionId);
        if (sessionId === requestedSessionId) requestedExpired = true;
      }
    }
    return requestedExpired;
  };

  const readAppUserTokenRecord = (): GitHubAppUserTokenRecord | null => {
    try {
      const raw = args.credentialStore?.getSync(GITHUB_APP_USER_TOKEN_KEY)?.trim() || "";
      if (!raw) return appUserTokenMemory;
      const parsed = JSON.parse(raw) as Partial<GitHubAppUserTokenRecord>;
      if (typeof parsed.accessToken !== "string" || !parsed.accessToken.trim()) return null;
      return {
        accessToken: parsed.accessToken.trim(),
        tokenType: typeof parsed.tokenType === "string" && parsed.tokenType.trim() ? parsed.tokenType.trim() : "bearer",
        scope: typeof parsed.scope === "string" && parsed.scope.trim() ? parsed.scope.trim() : null,
        expiresAt: typeof parsed.expiresAt === "string" && parsed.expiresAt.trim() ? parsed.expiresAt.trim() : null,
        refreshToken: typeof parsed.refreshToken === "string" && parsed.refreshToken.trim() ? parsed.refreshToken.trim() : null,
        refreshTokenExpiresAt:
          typeof parsed.refreshTokenExpiresAt === "string" && parsed.refreshTokenExpiresAt.trim()
            ? parsed.refreshTokenExpiresAt.trim()
            : null,
        userLogin: typeof parsed.userLogin === "string" && parsed.userLogin.trim() ? parsed.userLogin.trim() : null,
        updatedAt: typeof parsed.updatedAt === "string" && parsed.updatedAt.trim() ? parsed.updatedAt.trim() : new Date().toISOString(),
      };
    } catch {
      args.logger.warn("github.app_user_token_read_failed", {
        error: "failed to parse stored app user token",
      });
      return null;
    }
  };

  const persistAppUserTokenRecord = (record: GitHubAppUserTokenRecord | null): void => {
    appUserTokenMemory = record;
    try {
      if (record) {
        args.credentialStore?.setSync(GITHUB_APP_USER_TOKEN_KEY, JSON.stringify(record));
      } else {
        args.credentialStore?.deleteSync(GITHUB_APP_USER_TOKEN_KEY);
      }
    } catch (error) {
      args.logger.warn("github.app_user_token_write_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  const appUserAuthStatus = (patch: Partial<GitHubAppUserAuthStatus> = {}): GitHubAppUserAuthStatus => {
    const record = readAppUserTokenRecord();
    return {
      configured: true,
      tokenStored: Boolean(record?.accessToken),
      userLogin: record?.userLogin ?? null,
      expiresAt: record?.expiresAt ?? null,
      refreshTokenExpiresAt: record?.refreshTokenExpiresAt ?? null,
      checkedAt: new Date().toISOString(),
      error: null,
      ...patch,
    };
  };

  const isIsoAfter = (iso: string | null, cutoffMs: number): boolean => {
    if (!iso) return false;
    const time = Date.parse(iso);
    return Number.isFinite(time) && time > cutoffMs;
  };

  const fetchAppUserLogin = async (accessToken: string): Promise<string | null> => {
    const response = await args.fetchImpl("https://api.github.com/user", {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": args.userAgent,
        "x-github-api-version": GITHUB_REST_API_VERSION,
      },
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) return null;
    return asString(payload.login).trim() || null;
  };

  const getValidAppUserTokenForRelay = async (): Promise<string> => {
    const record = readAppUserTokenRecord();
    if (!record?.accessToken) {
      throw new Error("Authorize the ADE GitHub App with GitHub before using the hosted relay.");
    }
    const refreshCutoff = Date.now() + GITHUB_APP_USER_TOKEN_REFRESH_SKEW_MS;
    if (!record.expiresAt || isIsoAfter(record.expiresAt, refreshCutoff)) {
      return record.accessToken;
    }
    // A missing refreshTokenExpiresAt is unknown, not expired — attempt the
    // refresh instead of deleting a possibly-valid credential.
    const refreshTokenDead = record.refreshTokenExpiresAt != null
      && !isIsoAfter(record.refreshTokenExpiresAt, Date.now());
    if (!record.refreshToken || refreshTokenDead) {
      persistAppUserTokenRecord(null);
      throw new Error("ADE GitHub App authorization expired. Re-authorize ADE with GitHub.");
    }
    const epochAtJoin = authEpoch;
    if (!refreshInFlight) {
      refreshInFlight = refreshGitHubAppUserToken({
        clientId: ADE_GITHUB_APP_CLIENT_ID,
        refreshToken: record.refreshToken,
        fetchImpl: (input, init) => args.fetchImpl(String(input), init),
        userAgent: args.userAgent,
        fetchUserLogin: fetchAppUserLogin,
      }).then((refreshed) => {
        if (authEpoch === epochAtJoin) persistAppUserTokenRecord(refreshed);
        return refreshed;
      }).finally(() => {
        refreshInFlight = null;
      });
    }
    const refreshed = await refreshInFlight;
    if (authEpoch !== epochAtJoin) {
      // Auth state changed while refreshing (cleared or re-authorized).
      // Resolve against the current state instead of the stale refresh.
      return getValidAppUserTokenForRelay();
    }
    return refreshed.accessToken;
  };

  const startDeviceAuth = async (): Promise<GitHubAppDeviceAuthStartResult> => {
    pruneExpiredDeviceAuthSessions();
    // Cap pending sessions so a runaway caller cannot grow the map or spam
    // GitHub's device endpoint via ADE; evict oldest first.
    while (appDeviceAuthSessions.size >= MAX_PENDING_DEVICE_AUTH_SESSIONS) {
      const oldest = appDeviceAuthSessions.keys().next().value;
      if (!oldest) break;
      appDeviceAuthSessions.delete(oldest);
    }
    const device = await startGitHubAppDeviceFlow({
      clientId: ADE_GITHUB_APP_CLIENT_ID,
      fetchImpl: (input, init) => args.fetchImpl(String(input), init),
      userAgent: args.userAgent,
    });
    const sessionId = randomUUID();
    appDeviceAuthSessions.set(sessionId, { ...device, sessionId });
    return {
      sessionId,
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      verificationUriComplete: device.verificationUriComplete,
      expiresAt: device.expiresAt,
      intervalSec: device.intervalSec,
    };
  };

  const pollDeviceAuth = async (pollArgs: { sessionId: string }): Promise<GitHubAppDeviceAuthPollResult> => {
    const requestedSessionExpired = pruneExpiredDeviceAuthSessions(pollArgs.sessionId);
    const session = appDeviceAuthSessions.get(pollArgs.sessionId);
    if (!session) {
      if (requestedSessionExpired) {
        return {
          status: "expired",
          intervalSec: null,
          message: "GitHub device authorization expired.",
          authStatus: appUserAuthStatus(),
        };
      }
      return {
        status: "error",
        intervalSec: null,
        message: "GitHub device authorization session was not found.",
        authStatus: appUserAuthStatus(),
      };
    }
    const result = await pollGitHubAppDeviceFlow({
      clientId: ADE_GITHUB_APP_CLIENT_ID,
      deviceCode: session.deviceCode,
      intervalSec: session.intervalSec,
      fetchImpl: (input, init) => args.fetchImpl(String(input), init),
      userAgent: args.userAgent,
      fetchUserLogin: fetchAppUserLogin,
    });
    if (result.status === "pending" || result.status === "slow_down") {
      session.intervalSec = result.intervalSec;
      appDeviceAuthSessions.set(session.sessionId, session);
      return {
        status: result.status,
        intervalSec: result.intervalSec,
        message: result.message,
        authStatus: appUserAuthStatus(),
      };
    }
    appDeviceAuthSessions.delete(pollArgs.sessionId);
    if (result.status === "authorized") {
      authEpoch += 1;
      persistAppUserTokenRecord(result.token);
      return {
        status: "authorized",
        intervalSec: null,
        message: null,
        authStatus: appUserAuthStatus(),
      };
    }
    return {
      status: result.status,
      intervalSec: null,
      message: result.message,
      authStatus: appUserAuthStatus({ error: result.message }),
    };
  };

  const clearAuth = (): GitHubAppUserAuthStatus => {
    authEpoch += 1;
    persistAppUserTokenRecord(null);
    appDeviceAuthSessions.clear();
    return appUserAuthStatus();
  };

  return {
    getAuthStatus: appUserAuthStatus,
    startDeviceAuth,
    pollDeviceAuth,
    clearAuth,
    getValidTokenForRelay: getValidAppUserTokenForRelay,
    auditLog,
  };
}
