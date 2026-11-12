import type {
  GitHubAccountAppAccountStatus,
  GitHubAccountAppSignInReadResult,
  GitHubAccountAppSignInStartResult,
  GitHubAccountAppSignOutResult,
  GitHubAppUserAuthStatus,
  GitHubStatus,
} from "../../../shared/types";

/**
 * What the standalone web client answers for GitHub.
 *
 * The reads that a paired machine can serve are routed to it; everything that
 * needs a machine of its own — the App account credential above all — answers
 * with a stub that says so out loud.
 */

/**
 * What the web client answers for the GitHub App account, and how a renderer
 * knows it is a stub.
 *
 * Deliberately NOT a whole `GitHubAppUserAuthStatus`: this build has no machine
 * to hold the credential. `appUserAuthSupported: false` says so out loud, so a
 * renderer can skip the App surfaces instead of flashing a false "not
 * authorized" banner on every hosted-web project. `credentialState` is carried
 * anyway, so anything that reads it gets the honest answer.
 */
export const GITHUB_APP_USER_AUTH_UNSUPPORTED: Partial<GitHubAppUserAuthStatus> & {
  appUserAuthSupported: false;
} = {
  appUserAuthSupported: false,
  credentialState: "missing",
  refreshBlockedUntil: null,
  lastRefreshError: null,
};

export function githubDisconnectedStatus(): GitHubStatus {
  return {
    tokenStored: false,
    patTokenStored: false,
    tokenDecryptionFailed: false,
    storageScope: "app",
    authSource: "none",
    repo: null,
    hasOrigin: false,
    userLogin: null,
    scopes: [],
    ghCliPath: null,
    ghAuthError: null,
    checkedAt: new Date().toISOString(),
    repoAccessOk: null,
    repoAccessError: null,
    connected: false,
  };
}

/** The `window.ade.github` namespace as the web client implements it. */
export function createGithubNamespace(deps: {
  call: <T>(action: string, args: unknown, fallback: T, idempotent?: boolean) => Promise<T>;
  onStatusChanged: (listener: (status: unknown) => void) => () => void;
}): Record<string, unknown> {
  const { call } = deps;
  return {
    getStatus: (opts?: unknown) => call("github.getStatus", opts, githubDisconnectedStatus()),
    getRemoteStatus: (opts?: unknown) => call("github.getRemoteStatus", opts, { repo: null, hasOrigin: false }),
    setToken: async () => githubDisconnectedStatus(),
    clearToken: async () => githubDisconnectedStatus(),
    // No `setGhAccountSharing`: it is user-only, which the brain grants the
    // desktop app alone, and the field is optional, so Settings shows no
    // sharing buttons here.
    getAppUserAuthStatus: async () => ({ ...GITHUB_APP_USER_AUTH_UNSUPPORTED }),
    startAppUserDeviceAuth: async () => ({ ok: false, error: "unsupported" }),
    pollAppUserDeviceAuth: async () => ({ status: "expired" }),
    clearAppUserAuth: async () => ({ ...GITHUB_APP_USER_AUTH_UNSUPPORTED }),
    // Routed to the host: the paired machine spends the quota, so its reserve
    // is the one these pollers must respect.
    getRequestBudget: (opts?: unknown) => call("github.getRequestBudget", opts, {
      pausedUntil: null,
      failureKind: null,
      retryAt: null,
    }),
    // The star pill is desktop-only; the web client never asks.
    isRepoStarred: async () => "unknown",
    detectRepo: () => call("github.detectRepo", {}, null),
    listRepoIssues: (args?: unknown) => call("github.listRepoIssues", args ?? {}, []),
    getIssue: (args?: unknown) => call("github.getIssue", args ?? {}, null),
    getRepoIssueSummary: (args?: unknown) => call("github.getRepoIssueSummary", args ?? {}, null),
    listIssueComments: (args?: unknown) => call("github.listIssueComments", args ?? {}, []),
    listRepoIssueList: (args?: unknown) => call("github.listRepoIssueList", args ?? {}, []),
    getIssueWriteAccess: (args?: unknown) => call("github.getIssueWriteAccess", args ?? {}, null),
    createIssue: (args?: unknown) => call("github.createIssue", args ?? {}, null, false),
    listIssueTemplates: (args?: unknown) => call("github.listIssueTemplates", args ?? {}, { templates: [], blankIssuesEnabled: true }),
    listIssueTypes: (args?: unknown) => call("github.listIssueTypes", args ?? {}, []),
    updateIssue: (args?: unknown) => call("github.updateIssue", args ?? {}, null, false),
    commentOnIssue: (args?: unknown) => call("github.commentOnIssue", args ?? {}, null, false),
    listRepoMilestones: (args?: unknown) => call("github.listRepoMilestones", args ?? {}, []),
    listRepoAutolinks: async () => [],
    getAppInstallationStatus: async () => ({
      installed: false,
      state: "unknown",
      appUserAuthFailure: null,
    }),
    createRepoAutolink: async () => null,
    listRepoLabels: (args?: unknown) => call("github.listRepoLabels", args ?? {}, []),
    listRepoCollaborators: (args?: unknown) => call("github.listRepoCollaborators", args ?? {}, []),
    listMyRepos: async () => ({ repositories: [], nextCursor: null }),
    // Publishing creates a repo + pushes, so keep it explicitly marked as a
    // mutation and ineligible for adapter read caching.
    publishCurrentProject: (opts?: unknown) => call("github.publishCurrentProject", opts, { ok: false, error: "unsupported" }, false),
    onStatusChanged: deps.onStatusChanged,
  };
}

type GithubAppDirectorySend = (request: {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
}) => Promise<{ status: number; body: unknown }>;

function errorCode(body: unknown, status: number): string {
  const error = body && typeof body === "object" ? (body as { error?: { code?: unknown } }).error : null;
  return typeof error?.code === "string" ? error.code : `http_${status}`;
}

function sendErrorCode(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  const match = /^([a-z_]+):/.exec(message);
  return match?.[1] ?? "unavailable";
}

/**
 * The ADE account's GitHub App sign-in on the web client. Account-scoped like
 * the desktop's: this browser's own account session asks the account
 * directory. These methods never see a GitHub token; the direct reads hold
 * one in memory (`webclient/github/accountCredential.ts`). A sign-in leaves
 * this page for GitHub and comes back to it (`returnTo`); the server checks
 * that the address is a page of the ADE web app.
 *
 * `onGrantChanged` lets the direct reads drop what is no longer true:
 * `"disconnected"` (a disconnect, a finished sign-in with a new grant, or a
 * status read that is not active) drops the token and every answer;
 * `"connected"` (an active status read) drops only a negative answer.
 */
export function createGithubAccountAppWebMethods(
  send: GithubAppDirectorySend,
  onGrantChanged?: (change: "connected" | "disconnected") => void,
) {
  const grantChanged = (change: "connected" | "disconnected"): void => {
    try {
      onGrantChanged?.(change);
    } catch {
      // The sign-in answer does not depend on the direct reads.
    }
  };
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
  const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  return {
    getAccountAppStatus: async (): Promise<GitHubAccountAppAccountStatus> => {
      const empty: GitHubAccountAppAccountStatus = {
        available: false,
        error: "unavailable",
        connected: false,
        state: null,
        stateReason: null,
        githubLogin: null,
        connectedAt: null,
        origin: null,
      };
      try {
        const answer = await send({ method: "GET", path: "/github/app/status" });
        if (answer.status !== 200) {
          const code = errorCode(answer.body, answer.status);
          return { ...empty, error: answer.status === 404 || code === "github_app_not_configured" ? "unsupported" : "unavailable" };
        }
        const body = record(answer.body);
        grantChanged(body.connected === true && body.state === "active" ? "connected" : "disconnected");
        return {
          available: true,
          error: null,
          connected: body.connected === true,
          state: body.state === "active" || body.state === "needs_reauth" ? body.state : null,
          stateReason: text(body.stateReason),
          githubLogin: text(body.githubLogin),
          connectedAt: num(body.connectedAt),
          origin: body.origin === "web_flow" || body.origin === "adopted_device_flow" ? body.origin : null,
        };
      } catch (cause) {
        const code = sendErrorCode(cause);
        return { ...empty, error: code === "signed_out" ? "signed_out" : code === "no_directory" ? "unsupported" : "unavailable" };
      }
    },
    startAccountAppSignIn: async (): Promise<GitHubAccountAppSignInStartResult> => {
      try {
        const returnTo = `${window.location.origin}${window.location.pathname}${window.location.search}`;
        const answer = await send({ method: "POST", path: "/github/app/sign-in", body: { client: "web", returnTo } });
        const body = record(answer.body);
        const signInId = text(body.signInId);
        const authorizeUrl = text(body.authorizeUrl);
        const expiresAt = num(body.expiresAt);
        if ((answer.status === 201 || answer.status === 200) && signInId && authorizeUrl && expiresAt != null) {
          let host = "";
          try {
            host = new URL(authorizeUrl).hostname.toLowerCase();
          } catch {
            host = "";
          }
          if (host !== "github.com") return { ok: false, error: "unavailable", message: null };
          window.location.assign(authorizeUrl);
          return { ok: true, signInId, expiresAt };
        }
        const code = errorCode(answer.body, answer.status);
        return {
          ok: false,
          error: answer.status === 404 || code === "github_app_not_configured" ? "unsupported" : code,
          message: text(record(record(answer.body).error).message),
        };
      } catch (cause) {
        return { ok: false, error: sendErrorCode(cause), message: null };
      }
    },
    readAccountAppSignIn: async (args: { signInId: string }): Promise<GitHubAccountAppSignInReadResult> => {
      const signInId = typeof args?.signInId === "string" ? args.signInId : "";
      if (!/^gs_[0-9a-f]{32}$/.test(signInId)) return { ok: false, error: "invalid_args" };
      try {
        const answer = await send({ method: "GET", path: `/github/app/sign-in/${signInId}` });
        const body = record(answer.body);
        const status = body.status === "pending" || body.status === "done" || body.status === "failed" || body.status === "expired" ? body.status : null;
        if (answer.status !== 200 || !status) return { ok: false, error: errorCode(answer.body, answer.status) };
        const resultCode = body.resultCode === "ok" || body.resultCode === "denied" || body.resultCode === "error" ? body.resultCode : null;
        if (status === "done") grantChanged("disconnected");
        return { ok: true, status, resultCode, githubLogin: text(body.githubLogin) };
      } catch (cause) {
        return { ok: false, error: sendErrorCode(cause) };
      }
    },
    signOutAccountApp: async (): Promise<GitHubAccountAppSignOutResult> => {
      try {
        const answer = await send({ method: "DELETE", path: "/github/app/grant" });
        const body = record(answer.body);
        if (answer.status !== 200) return { ok: false, error: errorCode(answer.body, answer.status) };
        grantChanged("disconnected");
        return {
          ok: true,
          deletedAtGitHub: body.deletedAtGitHub === true,
          revokeAtGitHubUrl: text(body.revokeAtGitHubUrl) ?? "https://github.com/settings/apps/authorizations",
        };
      } catch (cause) {
        return { ok: false, error: sendErrorCode(cause) };
      }
    },
  };
}
