import type {
  GitHubAppInstallationStatus,
  GitHubAppUserAuthStatus,
  GitHubSetTokenResult,
  GitHubStatus,
} from "../../shared/types";
import {
  GITHUB_STATUS_PAGE_URL,
  githubServiceAffectedLabel,
  type GitHubServiceHealth,
} from "../../shared/githubServiceHealth";

export type GithubCredentialPresentation = {
  tokenTypeLabel: string;
  permissionMode: "auth-failure" | "app" | "fine-grained" | "scopes";
  permissionHeading: string;
  hasInspectableScopes: boolean;
  repoAccessLabel: string;
};

/** Copy for any GitHub failure Settings and the banner both render. */
export type GithubFailurePresentation = {
  subState: string;
  statusLabel: string;
  title: string;
  detail: string;
  settingsDetail: string;
  action: string;
};

/**
 * The outage case, which additionally has somewhere real to send the user.
 * Declared as an extension so the two shapes cannot silently drift apart.
 */
export type GithubOutagePresentation = GithubFailurePresentation & {
  /** Where the action button goes — the live incident when GitHub named one. */
  actionUrl: string;
  /** Banner dismissal fingerprint; a changed incident resurfaces the banner. */
  fingerprint: string;
};

/**
 * The single outage notice shown in place of every GitHub credential complaint,
 * or null when no incident is corroborated.
 *
 * One function rather than a family of predicates because every caller needs
 * the same three things together (is there an outage, what do we say, where
 * does the button go) — splitting them just duplicated the `?? statusPage`
 * fallback and the fingerprint at each call site.
 *
 * Every GitHub-blaming surface gates on this: banners collapse to one outage
 * notice, Settings drops its red "check failed" framing, and reconnect CTAs
 * disappear (reconnecting cannot fix an outage, and re-running `gh auth login`
 * during one risks replacing a working credential with a broken one).
 *
 * Deliberately one-directional. When this returns null ADE says nothing about
 * GitHub's health and keeps its existing error copy — the status page trails
 * real incidents by 10-20 minutes, so "no incident reported" is not evidence
 * that the user's setup is at fault.
 */
export function describeGithubOutage(
  status: GitHubStatus | null | undefined,
): GithubOutagePresentation | null {
  const health: GitHubServiceHealth | null = status?.serviceHealth ?? null;
  if (!health) return null;
  const affected = githubServiceAffectedLabel(health);
  const severe = health.affected.some((entry) => entry.status === "major_outage");
  return {
    subState: `outage:${health.indicator}`,
    statusLabel: "GitHub outage",
    title: severe ? "GitHub is down" : "GitHub is having problems",
    // Names the affected parts (so the user knows which of their work is
    // blocked) and then says the only thing they need to do, which is nothing.
    detail: `GitHub reports problems with ${affected}. This isn't your setup — ADE will reconnect on its own.`,
    settingsDetail: `GitHub reports problems with ${affected}. Nothing here needs changing — ADE keeps retrying and reconnects when GitHub is back.`,
    action: "GitHub status",
    actionUrl: health.incidentUrl ?? GITHUB_STATUS_PAGE_URL,
    // Incident identity + the affected surfaces, sorted. Severity is
    // deliberately excluded: GitHub flips component levels several times per
    // incident, and including them would resurface a dismissed banner on every
    // flip, including when the incident NARROWS. The incident link IS included
    // so a genuinely new incident on the same surfaces resurfaces the notice
    // instead of inheriting the previous one's dismissal.
    fingerprint: [
      health.incidentUrl ?? "no-incident",
      ...health.affected.map((entry) => entry.surface).sort(),
    ].join(","),
  };
}

export function githubCredentialPresentation(
  status: GitHubStatus | null,
): GithubCredentialPresentation {
  if (status?.authFailure) {
    return {
      tokenTypeLabel: githubTokenTypeLabel(status),
      permissionMode: "auth-failure",
      permissionHeading: "AUTHENTICATION CHECK",
      hasInspectableScopes: false,
      repoAccessLabel: githubRepoAccessLabel(status.repoAccessOk),
    };
  }
  if (status?.authSource === "app") {
    return {
      tokenTypeLabel: "GitHub App user token",
      permissionMode: "app",
      permissionHeading: "APP PERMISSIONS",
      hasInspectableScopes: false,
      repoAccessLabel: githubRepoAccessLabel(status.repoAccessOk),
    };
  }

  const fineGrained = status?.tokenType === "fine-grained";
  const hasInspectableScopes = !fineGrained || (status?.scopes.length ?? 0) > 0;
  return {
    tokenTypeLabel: githubTokenTypeLabel(status),
    permissionMode: fineGrained && !hasInspectableScopes ? "fine-grained" : "scopes",
    permissionHeading: fineGrained && !hasInspectableScopes ? "TOKEN PERMISSIONS" : "DETECTED SCOPES",
    hasInspectableScopes,
    repoAccessLabel: githubRepoAccessLabel(status?.repoAccessOk),
  };
}

function githubTokenTypeLabel(status: GitHubStatus | null): string {
  return status?.tokenType === "classic"
    ? "Classic PAT"
    : status?.tokenType === "fine-grained"
      ? "Fine-grained PAT"
      : status?.tokenType === "oauth"
        ? "OAuth token"
        : status?.tokenType === "unknown"
          ? "Unknown token"
          : "N/A";
}

function githubRepoAccessLabel(repoAccessOk: boolean | null | undefined): string {
  if (repoAccessOk === true) return "Repository metadata access verified";
  if (repoAccessOk === false) return "Repository access unavailable";
  return "Repository access not checked";
}

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
  // A connected repo proves a working relay credential — the installation/webhook
  // check succeeded, possibly via the ADE account-token fallback rather than the
  // device-flow user token. Real-time updates flow, so surface no blocker even if
  // the device-flow token is absent (which would otherwise read as "missing").
  if (repo === "connected") return null;
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
    action: "Set up ADE GitHub App",
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

export function isGithubRateLimitMessage(message: string | null | undefined): boolean {
  const normalized = message?.trim().toLowerCase() ?? "";
  return normalized.includes("rate limit")
    || normalized.includes("abuse detection")
    || normalized.includes("temporarily blocked from content creation");
}

/**
 * Copy for the gh CLI/token banner — three sub-states, each with a stable
 * fingerprint so a change between them resurfaces a previously-dismissed banner.
 * Deliberately worded around "GitHub CLI/token" to distinguish it from the "ADE
 * GitHub App" block. Lives here alongside the account/repo copy so Settings and
 * the banner draw from one source and can't disagree.
 */
export function githubStatusHasWriteCredential(status: GitHubStatus | null): boolean {
  if (!status) return false;
  if (status.writeAuthSource != null) return status.writeAuthSource !== "none";
  return status.connected
    && status.authSource !== "app"
    && status.authSource !== "none";
}

export function githubStatusHasUsablePat(result: GitHubSetTokenResult | null): boolean {
  const pat = result?.credentialVerification;
  return Boolean(
    pat?.source === "pat"
    && pat.failure == null
    && pat.capabilities.includes("write")
  );
}

export function describeGithubPatVerification(result: GitHubSetTokenResult): {
  verified: boolean;
  message: string;
} {
  if (githubStatusHasUsablePat(result)) {
    return { verified: true, message: "Personal access token saved and verified." };
  }
  const failure = result.credentialVerification.failure;
  if (failure?.kind === "invalid_token") {
    return {
      verified: false,
      message: "Token saved, but authentication failed. Re-check the token value.",
    };
  }
  if (failure?.kind === "rate_limited") {
    return {
      verified: false,
      message: "Token saved, but GitHub temporarily paused verification. ADE will try it again when needed.",
    };
  }
  if (failure?.kind === "permission_denied") {
    const repoLabel = result.repo ? `${result.repo.owner}/${result.repo.name}` : "this repository";
    return {
      verified: false,
      message: `Token saved, but ADE cannot use it for write actions on ${repoLabel}. Check the token's repository access and write permissions.`,
    };
  }
  // GitHub itself failed, so the token is unverified rather than bad. This is
  // the highest-risk place to get the blame wrong: the user is already in the
  // token field, so "check the token" reads as "replace it".
  if (failure?.kind === "service_unavailable") {
    return {
      verified: false,
      message: "Token saved, but GitHub returned an error instead of verifying it. Nothing to change here — ADE will verify it once GitHub recovers.",
    };
  }
  if (failure?.kind === "network") {
    return {
      verified: false,
      message: "Token saved, but ADE could not reach GitHub to verify it. Try again.",
    };
  }
  return {
    verified: false,
    message: "Token saved, but ADE could not verify it for GitHub write actions. Check the token and its repository permissions.",
  };
}

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
  // Below this point every state is inferred from GitHub's answers, so an
  // outage invalidates all of them. (The check sits AFTER `!tokenStored`: that
  // one is a purely local fact and stays true regardless of GitHub's health.)
  //
  // Belt-and-braces: IntegrationBannerHost suppresses this whole banner during
  // a corroborated outage, so in production this branch is already unreachable.
  // It stays so that any other caller — or a future refactor of that
  // suppression — cannot silently reintroduce the credential accusation.
  const outage = describeGithubOutage(status);
  if (outage) return outage;
  if (status.connected && !githubStatusHasWriteCredential(status)) {
    return {
      subState: "no-write-credential",
      title: "GitHub write access isn't connected",
      detail: "The ADE GitHub App can keep pull request data fresh, but GitHub CLI or a personal access token is needed for create, update, and merge actions.",
      action: "Connect GitHub",
    };
  }
  const authFailure = describeGithubAuthFailure(status);
  if (authFailure) {
    return authFailure;
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

export function describeGithubAuthFailure(
  status: GitHubStatus,
): GithubFailurePresentation | null {
  // Corroborated outage outranks every credential-shaped reading of the same
  // failure: whatever GitHub returned, the cause is GitHub.
  const outage = describeGithubOutage(status);
  if (outage) return outage;
  if (status.authFailure?.kind === "rate_limited") {
    const retryAt = formatGithubRetryAt(status.authFailure.retryAt);
    return {
      subState: `rate-limited:${status.authFailure.retryAt ?? "unknown"}`,
      statusLabel: "GitHub paused",
      title: "GitHub requests are temporarily paused",
      detail: retryAt
        ? `ADE stopped background checks and will resume automatically at ${retryAt}. GitHub App, CLI, and personal tokens for the same account may share this pause.`
        : "ADE stopped background checks and will resume automatically. GitHub App, CLI, and personal tokens for the same account may share this pause.",
      settingsDetail: retryAt
        ? `GitHub paused requests for this account until ${retryAt}. ADE has stopped background checks and will resume automatically; reconnecting will not make it recover sooner.`
        : "GitHub paused requests for this account. ADE has stopped background checks and will resume automatically; reconnecting is not needed.",
      action: "View GitHub status",
    };
  }
  if (status.authFailure?.kind === "invalid_token") {
    return {
      subState: "invalid-token",
      statusLabel: "Reconnect",
      title: "GitHub authentication was rejected",
      detail: "The saved GitHub credential is no longer valid. Reconnect GitHub to replace it.",
      settingsDetail: status.authFailure.message,
      action: "Reconnect GitHub",
    };
  }
  // GitHub answered with a 5xx. Even without status-page corroboration this is
  // provably not a credential problem, so it must never suggest reconnecting.
  if (status.authFailure?.kind === "service_unavailable") {
    return {
      subState: "service-unavailable",
      statusLabel: "GitHub error",
      title: "GitHub isn't responding",
      detail: "This isn't your setup — ADE will keep retrying.",
      settingsDetail: `GitHub returned an error instead of an answer, so ADE couldn't finish the check. This is not a problem with your credential, and reconnecting won't help. GitHub said: ${status.authFailure.message}`,
      // Matches the rate-limited/network siblings: the banner wires this to
      // ADE Settings, so it must not read as a link to githubstatus.com. Only
      // the corroborated-outage presentation carries a real external URL.
      action: "View GitHub status",
    };
  }
  if (status.authFailure?.kind === "network") {
    return {
      subState: "network",
      statusLabel: "Check failed",
      title: "GitHub status is unavailable",
      detail: "ADE found your credential but could not reach GitHub to verify it. Check the connection and retry.",
      settingsDetail: status.authFailure.message,
      action: "View GitHub status",
    };
  }
  if (status.authFailure?.kind === "permission_denied") {
    return {
      subState: "permission-denied",
      statusLabel: "Access needed",
      title: "GitHub access was not granted",
      detail: "ADE tried every available GitHub connection, but none can access this operation.",
      settingsDetail: status.authFailure.message,
      action: "Fix GitHub auth",
    };
  }
  if (status.authFailure) {
    return {
      subState: "validation-failed",
      statusLabel: "Check failed",
      title: "GitHub authentication check failed",
      detail: "ADE found your credential, but GitHub did not complete the validation request. Open Settings for the exact error.",
      settingsDetail: status.authFailure.message,
      action: "View GitHub status",
    };
  }
  return null;
}

function formatGithubRetryAt(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}
