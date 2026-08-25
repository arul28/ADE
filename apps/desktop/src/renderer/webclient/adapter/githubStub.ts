import type { GitHubAppUserAuthStatus, GitHubStatus } from "../../../shared/types";

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
    detectRepo: () => call("github.detectRepo", {}, null),
    listRepoIssues: (args?: unknown) => call("github.listRepoIssues", args ?? {}, []),
    getIssue: (args?: unknown) => call("github.getIssue", args ?? {}, null),
    listRepoAutolinks: async () => [],
    getAppInstallationStatus: async () => ({
      installed: false,
      state: "unknown",
      appUserAuthFailure: null,
    }),
    createRepoAutolink: async () => null,
    listRepoLabels: async () => [],
    listRepoCollaborators: async () => [],
    listMyRepos: async () => ({ repositories: [], nextCursor: null }),
    // Publishing creates a repo + pushes, so keep it explicitly marked as a
    // mutation and ineligible for adapter read caching.
    publishCurrentProject: (opts?: unknown) => call("github.publishCurrentProject", opts, { ok: false, error: "unsupported" }, false),
    onStatusChanged: deps.onStatusChanged,
  };
}
