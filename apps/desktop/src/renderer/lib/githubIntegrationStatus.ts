import type {
  GitHubAppInstallationStatus,
  GitHubAppUserAuthStatus,
  GitHubStatus,
} from "../../shared/types";

/**
 * Honest, two-axis derivation of ADE's GitHub App integration health.
 *
 * The GitHub App has two INDEPENDENT prerequisites for real-time (webhook-backed)
 * PR updates, and the raw IPC status conflates them:
 *
 *  1. Account axis  — the GitHub App *user token* (one per account). Sourced from
 *     `getAppUserAuthStatus()` → {@link GitHubAppUserAuthStatus}. The token can be
 *     missing, expired, or valid. Expiry is NOT surfaced by the service today
 *     (`expiresAt` is stored but never compared to now, and an expired token is
 *     silently deleted on next relay use), so we compute `expired` here.
 *  2. Repo axis     — whether the App is *installed on this specific repo*. Sourced
 *     from `getAppInstallationStatus()` → {@link GitHubAppInstallationStatus}.
 *
 * Settings renders both axes; the banner surfaces the single top blocker. Keeping
 * the derivation here means Settings and the banner can never disagree.
 */

export type GithubAccountAuthState = "valid" | "expired" | "missing";

export type GithubRepoConnectionState =
  | "connected" // App installed on this repo (state === "configured") AND webhook delivery is wired
  | "webhook_off" // App installed but real-time delivery isn't wired — relay unconfigured or webhook deleted
  | "not_installed" // App not installed on this repo
  | "access_pending" // authorized, but GitHub is still propagating repo access
  | "no_repo" // no GitHub repo detected for this project
  | "unknown"; // status not loaded / indeterminate

// Mirror GITHUB_APP_USER_TOKEN_REFRESH_SKEW_MS (githubAppUserAuthService.ts): treat a
// token that is within the refresh window as already expired for display purposes.
const TOKEN_EXPIRY_SKEW_MS = 2 * 60_000;

export function deriveGithubAccountAuthState(
  appAuth: GitHubAppUserAuthStatus | null,
): GithubAccountAuthState {
  if (!appAuth || appAuth.tokenStored !== true) return "missing";
  const expiresAtMs = appAuth.expiresAt ? Date.parse(appAuth.expiresAt) : NaN;
  if (Number.isFinite(expiresAtMs) && expiresAtMs - TOKEN_EXPIRY_SKEW_MS <= Date.now()) {
    return "expired";
  }
  return "valid";
}

// The relay reports "repo access still propagating" only as an error string on the
// installation status (there is no typed field). Match the same heuristic the panel
// used, centralized here so it can be reused and later promoted to a typed state.
const REPO_ACCESS_PENDING_ERROR_MATCHES = [
  "not found",
  "repository not found",
  "could not resolve to a repository",
];

export function isGithubRepoAccessPending(
  status: GitHubAppInstallationStatus | null,
): boolean {
  if (!status) return false;
  if (status.installed || !status.relayConfigured) return false;
  if (status.state !== "error") return false;
  const err = (status.error ?? "").trim().toLowerCase();
  if (!err) return false;
  return REPO_ACCESS_PENDING_ERROR_MATCHES.some((match) => err === match || err.includes(match));
}

export function deriveGithubRepoConnectionState(
  status: GitHubAppInstallationStatus | null,
): GithubRepoConnectionState {
  if (!status) return "unknown";
  if (status.repo === null) return "no_repo";
  if (status.installed) {
    // "Installed" alone is not enough for real-time PR updates: the App must have a
    // configured relay AND a live webhook. Without either, webhooks won't deliver, so
    // report the honest "webhook_off" rather than a false-healthy "connected".
    return status.relayConfigured && status.webhookState !== "deleted" ? "connected" : "webhook_off";
  }
  if (status.state === "not_installed") return "not_installed";
  if (isGithubRepoAccessPending(status)) return "access_pending";
  return "unknown";
}

/**
 * The single top blocker preventing real-time PR updates, or null when healthy.
 * Account problems outrank repo problems (you must authorize before an install can
 * be verified), so the banner shows one clear next action at a time.
 */
export type GithubRealtimeBlock =
  | { kind: "account"; account: Extract<GithubAccountAuthState, "expired" | "missing"> }
  | {
      kind: "repo";
      repo: Extract<GithubRepoConnectionState, "not_installed" | "access_pending" | "webhook_off">;
    }
  | null;

export function deriveGithubRealtimeBlock(
  account: GithubAccountAuthState,
  repo: GithubRepoConnectionState,
): GithubRealtimeBlock {
  if (account === "missing" || account === "expired") return { kind: "account", account };
  if (repo === "not_installed" || repo === "access_pending" || repo === "webhook_off") {
    return { kind: "repo", repo };
  }
  return null;
}

/** True when the App integration is fully wired for real-time PR updates. */
export function isGithubRealtimeHealthy(
  account: GithubAccountAuthState,
  repo: GithubRepoConnectionState,
): boolean {
  return account === "valid" && repo === "connected";
}

// --- Shared copy (kept here so Settings and the banner stay in lockstep) ---

export function githubAccountIssueCopy(
  account: Extract<GithubAccountAuthState, "expired" | "missing">,
): { title: string; detail: string; action: string } {
  if (account === "expired") {
    return {
      title: "GitHub App authorization expired",
      detail: "Re-authorize ADE so it can keep pull request status up to date.",
      action: "Re-authorize",
    };
  }
  return {
    title: "GitHub App not authorized",
    detail: "Authorize ADE with GitHub to turn on real-time pull request updates.",
    action: "Authorize",
  };
}

export function githubRepoIssueCopy(
  repo: Extract<GithubRepoConnectionState, "not_installed" | "access_pending" | "webhook_off">,
  repoLabel: string | null,
): { title: string; detail: string; action: string } {
  const label = repoLabel ?? "this repository";
  if (repo === "access_pending") {
    return {
      title: `Finishing GitHub setup for ${label}`,
      detail: "GitHub is still granting the ADE app access to this repo — this usually clears in a moment.",
      action: "Recheck",
    };
  }
  if (repo === "webhook_off") {
    return {
      title: `Real-time PR updates are off for ${label}`,
      detail: "The ADE GitHub App is installed but its webhook isn't active — reconnect it to restore live PR status.",
      action: "Manage",
    };
  }
  return {
    title: `${label} isn't connected to the ADE GitHub App`,
    detail: "Install the app on this repo so PR status updates in real time, even when the project isn't focused.",
    action: "Install",
  };
}

/**
 * Copy for the gh CLI/token banner — three sub-states, each with a stable
 * fingerprint so a change between them resurfaces a previously-dismissed banner.
 * Deliberately worded around "GitHub CLI/token" to distinguish it from the "ADE
 * GitHub App" block. Lives here alongside the account/repo copy so Settings and
 * the banner draw from one source and can't disagree.
 */
export function describeGithubCliBanner(status: GitHubStatus): {
  subState: string;
  title: string;
  detail: string;
  action: string;
} {
  if (!status.tokenStored) {
    return {
      subState: "no-token",
      title: "GitHub CLI or token not connected",
      detail: "Connect the GitHub CLI (gh auth login) or add a personal access token so ADE can run git and PR operations.",
      action: "Connect GitHub",
    };
  }
  if (status.tokenType === "fine-grained" && status.repoAccessOk === false) {
    const repoLabel = status.repo ? `${status.repo.owner}/${status.repo.name}` : "this repository";
    return {
      subState: "repo-access",
      title: `GitHub token can't access ${repoLabel}`,
      detail: "Your fine-grained token is valid but hasn't been granted this repository. Update its repository access.",
      action: "Fix GitHub auth",
    };
  }
  return {
    subState: "missing-perms",
    title: "GitHub token is missing permissions",
    detail: "Your GitHub token lacks the scopes ADE needs. Reconnect it with repo and workflow access.",
    action: "Fix GitHub auth",
  };
}
