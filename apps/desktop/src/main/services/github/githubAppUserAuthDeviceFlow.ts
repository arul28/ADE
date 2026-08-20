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
  startGitHubAppDeviceFlow,
} from "./githubAppUserAuth";
import { describeGitHubAppUserAuthFailure } from "./githubAppUserAuthFailure";

/**
 * The GitHub device flow: how a person first authorizes ADE.
 *
 * Split out of githubAppUserAuthService.ts because it shares nothing with the
 * refresh ledger that file exists for. It holds pending browser sessions, it
 * talks to GitHub's device endpoints, and it hands the finished credential to
 * the service through {@link GitHubAppUserDeviceFlowDeps.persistAppUserTokenRecord}.
 */

const MAX_PENDING_DEVICE_AUTH_SESSIONS = 5;

/**
 * What a person is told when GitHub throttles the sign-in endpoint itself.
 *
 * Re-authorizing is what a user reaches for when the credential broke, and it
 * goes to the same host that is throttling ADE. Say that, rather than handing
 * back a status code.
 */
export const GITHUB_SIGN_IN_RATE_LIMITED_COPY =
  "GitHub is rate-limiting ADE's sign-in requests right now. Try again in a few minutes.";

type GitHubAppDeviceAuthSession = GitHubAppDeviceCode & {
  sessionId: string;
  intervalSec: number;
};

export type GitHubAppUserDeviceFlowDeps = {
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  userAgent: string;
  logger: { warn(message: string, meta?: Record<string, unknown>): void };
  /** Resolves the login behind a fresh access token, for the stored record. */
  fetchAppUserLogin: (accessToken: string) => Promise<string | null>;
  /** Writes the authorized credential, or clears it when given null. */
  persistAppUserTokenRecord: (record: GitHubAppUserTokenRecord | null) => void;
  /** Tells the service that stored auth was replaced outside the refresh path. */
  bumpAuthEpoch: () => void;
  appUserAuthStatus: (patch?: Partial<GitHubAppUserAuthStatus>) => GitHubAppUserAuthStatus;
  now?: () => number;
};

export function createGitHubAppUserDeviceFlow(deps: GitHubAppUserDeviceFlowDeps): {
  startDeviceAuth(): Promise<GitHubAppDeviceAuthStartResult>;
  pollDeviceAuth(args: { sessionId: string }): Promise<GitHubAppDeviceAuthPollResult>;
  /** Drops every pending browser session, for sign-out. */
  clearSessions(): void;
} {
  const sessions = new Map<string, GitHubAppDeviceAuthSession>();
  const now = deps.now ?? (() => Date.now());

  const pruneExpiredSessions = (requestedSessionId?: string): boolean => {
    const nowMs = now();
    let requestedExpired = false;
    for (const [sessionId, session] of sessions.entries()) {
      if (Date.parse(session.expiresAt) <= nowMs) {
        sessions.delete(sessionId);
        if (sessionId === requestedSessionId) requestedExpired = true;
      }
    }
    return requestedExpired;
  };

  const startDeviceAuth = async (): Promise<GitHubAppDeviceAuthStartResult> => {
    pruneExpiredSessions();
    // Cap pending sessions so a runaway caller cannot grow the map or spam
    // GitHub's device endpoint via ADE; evict oldest first.
    while (sessions.size >= MAX_PENDING_DEVICE_AUTH_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (!oldest) break;
      sessions.delete(oldest);
    }
    let device: GitHubAppDeviceCode;
    try {
      device = await startGitHubAppDeviceFlow({
        clientId: ADE_GITHUB_APP_CLIENT_ID,
        fetchImpl: (input, init) => deps.fetchImpl(String(input), init),
        userAgent: deps.userAgent,
      });
    } catch (error) {
      const described = describeGitHubAppUserAuthFailure(error);
      deps.logger.warn("github.app_user_device_start_failed", {
        error: described.message,
        status: described.status,
        oauthError: described.oauthError,
      });
      if (described.status === 429) throw new Error(GITHUB_SIGN_IN_RATE_LIMITED_COPY);
      throw error;
    }
    const sessionId = randomUUID();
    sessions.set(sessionId, { ...device, sessionId });
    return {
      sessionId,
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      verificationUriComplete: device.verificationUriComplete,
      expiresAt: device.expiresAt,
      intervalSec: device.intervalSec,
    };
  };

  const pollDeviceAuth = async (
    pollArgs: { sessionId: string },
  ): Promise<GitHubAppDeviceAuthPollResult> => {
    const requestedSessionExpired = pruneExpiredSessions(pollArgs.sessionId);
    const session = sessions.get(pollArgs.sessionId);
    if (!session) {
      if (requestedSessionExpired) {
        return {
          status: "expired",
          intervalSec: null,
          message: "GitHub device authorization expired.",
          authStatus: deps.appUserAuthStatus(),
        };
      }
      return {
        status: "error",
        intervalSec: null,
        message: "GitHub device authorization session was not found.",
        authStatus: deps.appUserAuthStatus(),
      };
    }
    let result: Awaited<ReturnType<typeof pollGitHubAppDeviceFlow>>;
    try {
      result = await pollGitHubAppDeviceFlow({
        clientId: ADE_GITHUB_APP_CLIENT_ID,
        deviceCode: session.deviceCode,
        intervalSec: session.intervalSec,
        fetchImpl: (input, init) => deps.fetchImpl(String(input), init),
        userAgent: deps.userAgent,
        fetchUserLogin: deps.fetchAppUserLogin,
      });
    } catch (error) {
      // A transport failure is a poll RESULT, not a thrown IPC error: the caller
      // is a polling UI, and it can only pace itself if it is told what
      // happened. A 429 here is GitHub throttling ADE, not a denied user.
      const described = describeGitHubAppUserAuthFailure(error);
      const message = described.status === 429
        ? GITHUB_SIGN_IN_RATE_LIMITED_COPY
        : described.message;
      deps.logger.warn("github.app_user_device_poll_failed", {
        error: described.message,
        status: described.status,
        oauthError: described.oauthError,
      });
      return {
        status: "error",
        intervalSec: null,
        message,
        authStatus: deps.appUserAuthStatus({ error: message }),
      };
    }
    if (result.status === "pending" || result.status === "slow_down") {
      session.intervalSec = result.intervalSec;
      sessions.set(session.sessionId, session);
      return {
        status: result.status,
        intervalSec: result.intervalSec,
        message: result.message,
        authStatus: deps.appUserAuthStatus(),
      };
    }
    sessions.delete(pollArgs.sessionId);
    if (result.status === "authorized") {
      deps.bumpAuthEpoch();
      deps.persistAppUserTokenRecord(result.token);
      return {
        status: "authorized",
        intervalSec: null,
        message: null,
        authStatus: deps.appUserAuthStatus(),
      };
    }
    return {
      status: result.status,
      intervalSec: null,
      message: result.message,
      authStatus: deps.appUserAuthStatus({ error: result.message }),
    };
  };

  return {
    startDeviceAuth,
    pollDeviceAuth,
    clearSessions: () => sessions.clear(),
  };
}
