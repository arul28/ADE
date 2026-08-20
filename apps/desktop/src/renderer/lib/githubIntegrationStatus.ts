import type {
  GitHubAppInstallationStatus,
  GitHubAppUserAuthStatus,
  GitHubSetTokenResult,
  GitHubStatus,
} from "../../shared/types";
import {
  GITHUB_APP_USER_AUTH_RENEWING_COPY,
  GITHUB_CREDENTIAL_STORE_UNREADABLE_COPY,
} from "../../shared/types";
import {
  GITHUB_STATUS_PAGE_URL,
  githubServiceAffectedLabel,
  isGithubServiceUnavailable,
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
 *     `getAppUserAuthStatus()` → {@link GitHubAppUserAuthStatus}. The service
 *     decides the honest state and reports it as `credentialState`; this module
 *     only translates it into copy.
 *  2. Repo axis     — whether the App is *installed on this specific repo*. Sourced
 *     from `getAppInstallationStatus()` → {@link GitHubAppInstallationStatus}.
 *
 * Settings renders both axes; the banner surfaces the single top blocker. Keeping
 * the derivation here means Settings and the banner can never disagree.
 */

export type GithubAccountAuthState =
  | "valid" // authorized: a live refresh token keeps the access token current
  | "blocked" // GitHub is refusing renewals for now; ADE retries on its own
  | "needs_reauth" // the refresh token is gone, expired, or rejected — only this asks the user to act
  | "missing"; // no credential stored

export type GithubRepoConnectionState =
  | "connected" // App installed on this repo (state === "configured") AND webhook delivery is wired
  | "webhook_off" // App installed but real-time delivery isn't wired — relay unconfigured or webhook deleted
  | "not_installed" // App not installed on this repo
  | "access_pending" // authorized, but GitHub is still propagating repo access
  | "waiting_on_account" // the account axis isn't authorized, so the install check proves nothing
  | "no_repo" // no GitHub repo detected for this project
  | "unknown"; // status not loaded / indeterminate

/**
 * Whether the host behind this renderer really implements the GitHub App
 * account API.
 *
 * The standalone web-client adapter answers those calls with stubs, because a
 * hosted-web build has no machine to hold the credential. Reading a stub as a
 * real answer flashed a false "not authorized" banner on every hosted-web
 * project, and offered a Disconnect button that silently did nothing.
 *
 * The stub declares itself with `appUserAuthSupported: false`. Hosts older than
 * that field are still recognised the way they always were: by `configured`,
 * which the stub has never carried.
 *
 * A `null` status is NOT an answer this predicate can give: it means the read
 * failed or the host does not implement the call, and a caller's "loaded" flag
 * is set in both cases. It is not a report of "not authorized", and acting on
 * it paints a banner nobody can clear. So this returns true for null by design,
 * and every caller that acts on the result must pair it with its own
 * `appAuth != null` check.
 */
export function isGithubAppUserAuthSupported(
  appAuth: GitHubAppUserAuthStatus | null | undefined,
): boolean {
  // Nothing fetched yet says nothing about the host. Callers gate on their own
  // "loaded" signal before they act on this.
  if (!appAuth) return true;
  if (appAuth.appUserAuthSupported === false) return false;
  // `configured` is required of a real status and absent from every stub, so a
  // runtime check of its type is the older hosts' declaration.
  return typeof appAuth.configured === "boolean";
}

/**
 * The account axis, judged by the credential that actually keeps the account
 * connected: the refresh token.
 *
 * The GitHub App access token lives 8 hours and is renewed from the refresh
 * token on every use, so `expiresAt` in the past is ordinary operation. Reading
 * it as "authorization expired" sent working accounts into a re-authorize flow
 * that hits the same OAuth endpoint the renewals were already failing on — the
 * one thing guaranteed to keep the account locked out. Never judge by
 * `expiresAt`; the service reports the honest state in `credentialState`.
 */
export function deriveGithubAccountAuthState(
  appAuth: GitHubAppUserAuthStatus | null,
): GithubAccountAuthState {
  if (!appAuth || appAuth.tokenStored !== true) return "missing";
  switch (appAuth.credentialState) {
    case "authorized":
      return "valid";
    case "blocked":
      return "blocked";
    case "needs_reauth":
      return "needs_reauth";
    case "missing":
      return "missing";
    default:
      return legacyAccountAuthState(appAuth);
  }
}

/**
 * Older hosts and the web-client stub send the status without `credentialState`.
 * The refresh token still decides the truth there, so read that rather than the
 * 8-hour access token. Only a credential with no refresh-token expiry at all
 * falls back to the access token, because then nothing else is known.
 */
function legacyAccountAuthState(appAuth: GitHubAppUserAuthStatus): GithubAccountAuthState {
  const refreshExpiresAtMs = appAuth.refreshTokenExpiresAt
    ? Date.parse(appAuth.refreshTokenExpiresAt)
    : NaN;
  if (Number.isFinite(refreshExpiresAtMs)) {
    return refreshExpiresAtMs <= Date.now() ? "needs_reauth" : "valid";
  }
  const expiresAtMs = appAuth.expiresAt ? Date.parse(appAuth.expiresAt) : NaN;
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) return "needs_reauth";
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

/**
 * COMPATIBILITY SHIM. Every phrasing ADE or its relay emits for "there is no
 * usable GitHub App token", enumerated rather than guessed.
 *
 * The typed `appUserAuthFailure` on the installation status is the real signal,
 * and it is read first. This list still catches the two cases it cannot: a host
 * older than that field, and a raw 401 body from the relay itself. Do not add
 * new ADE phrasings here — a new phrase from a current host arrives with the
 * typed field beside it.
 *
 * A loose substring here is worse than a missing one: "not authorized" also
 * appears in messages about the REPOSITORY, and matching those reported a real
 * install problem as an account problem the user could not act on.
 */
const GITHUB_ACCOUNT_AUTH_ERROR_MATCHES = [
  // The webhook relay's own 401 body (apps/webhook-relay/src/relay.ts).
  "auth token is required",
  // githubRelayConfig refusing before any request goes out.
  "github auth is required to check",
  "authorize the ade github app",
  // appUserAuthUnavailableCopy, one phrase per credential state.
  "ade's github authorization expired",
  "waiting on github authorization",
];

/**
 * The relay answers the installation check with a 401 when ADE sends no usable
 * GitHub App token. That answer says nothing about the installation, so the repo
 * axis must not repeat it: rendering ADE's own "GitHub auth token is required"
 * turned an account-token problem into an accusation against the repo setup.
 */
function isGithubAuthTokenRequiredError(error: string | null | undefined): boolean {
  const normalized = error?.trim().toLowerCase() ?? "";
  if (!normalized) return false;
  return GITHUB_ACCOUNT_AUTH_ERROR_MATCHES.some((match) => normalized.includes(match));
}

export function deriveGithubRepoConnectionState(
  status: GitHubAppInstallationStatus | null,
  account: GithubAccountAuthState,
): GithubRepoConnectionState {
  if (!status) return "unknown";
  if (status.repo === null) return "no_repo";
  if (status.installed) {
    // "Installed" alone is not enough for real-time PR updates: the App must have a
    // configured relay AND a live webhook. Without either, webhooks won't deliver, so
    // report the honest "webhook_off" rather than a false-healthy "connected".
    return status.relayConfigured && status.webhookState !== "deleted" ? "connected" : "webhook_off";
  }
  // The host said outright that this check ran without an account credential.
  if (status.appUserAuthFailure) return "waiting_on_account";
  if (isGithubAuthTokenRequiredError(status.error)) return "waiting_on_account";
  // An unauthorized account cannot check an installation, so every "not
  // installed" reading below it is unproven. Say what ADE is actually waiting
  // for instead of reporting an uninstall that never happened.
  //
  // A rate limit or a GitHub 5xx is exempt: those are specific, corroborated
  // reasons that hold whichever credential the check ran with (it can fall back
  // to the ADE account token), and the panel has honest copy for each.
  const failureIsExplained = isGithubRateLimitMessage(status.error)
    || isGithubServiceUnavailable({ message: status.error });
  if (account !== "valid" && !failureIsExplained) return "waiting_on_account";
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
  | { kind: "account"; account: Extract<GithubAccountAuthState, "needs_reauth" | "missing"> }
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
  // A paused renewal is not a blocker the user can clear. ADE retries on its
  // own, and every repo reading taken while it is paused is unproven, so this
  // state raises no banner at all rather than a banner nobody can act on.
  if (account === "blocked") return null;
  if (account === "missing" || account === "needs_reauth") return { kind: "account", account };
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
  account: Extract<GithubAccountAuthState, "needs_reauth" | "missing">,
): { title: string; detail: string; action: string } {
  if (account === "needs_reauth") {
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

/**
 * The account axis exactly as the Settings panel renders it: one pill, one line
 * of subtext, and at most one button. Every state that ADE recovers from on its
 * own returns `cta: null` — offering a button there is what walked users into
 * re-authorizing against an endpoint that was already refusing them.
 */
export type GithubAccountAxisTone = "ok" | "warn" | "pending" | "neutral";

export type GithubAccountAxisPresentation = {
  tone: GithubAccountAxisTone;
  label: string;
  subtext: string;
  cta: "authorize" | "reauthorize" | null;
  /** Extra sentence shown under the row; only the paused state needs one. */
  note: string | null;
};

export function describeGithubAccountAxis(
  account: GithubAccountAuthState | "checking",
  appAuth: GitHubAppUserAuthStatus | null,
): GithubAccountAxisPresentation {
  if (account === "checking") {
    return {
      tone: "pending",
      label: "Checking…",
      subtext: "Checking your GitHub authorization…",
      cta: null,
      note: null,
    };
  }
  if (account === "valid") {
    const who = appAuth?.userLogin ?? "GitHub account";
    return {
      tone: "ok",
      label: "Authorized",
      // Deliberately silent about the 8-hour access token. Showing its expiry
      // taught users to read a normal renewal cycle as a countdown to breakage.
      subtext: `${who} · renews automatically`,
      cta: null,
      note: null,
    };
  }
  if (account === "blocked") {
    // Blocked with nothing recorded against the credential is ADE's own
    // renewal, not a GitHub refusal: one process on this machine holds the
    // refresh and the rest wait a moment. Calling that "paused" told the user
    // GitHub had stopped something, which is both wrong and unactionable.
    //
    // Defensive today: the stored ledger always carries `lastFailure` when it
    // sets a backoff, so a status read reports `lastRefreshError` beside every
    // `blocked` it reports. This branch guards the peer-lease shape — blocked
    // with no failure — for the day it does reach a status read, because that
    // shape already travels on the error path.
    if (!appAuth?.lastRefreshError) {
      return {
        tone: "pending",
        label: "Renewing…",
        subtext: GITHUB_APP_USER_AUTH_RENEWING_COPY,
        cta: null,
        note: null,
      };
    }
    return {
      tone: "neutral",
      label: githubPausedLabel(appAuth.refreshBlockedUntil),
      subtext: githubRefreshPauseCopy(appAuth.lastRefreshError.kind),
      cta: null,
      note: "Re-authorizing is unavailable while GitHub has these requests paused.",
    };
  }
  if (account === "needs_reauth") {
    return {
      tone: "warn",
      label: "Authorization expired",
      subtext: githubAccountIssueCopy("needs_reauth").detail,
      cta: "reauthorize",
      note: null,
    };
  }
  return {
    tone: "neutral",
    label: "Not authorized",
    subtext: githubAccountIssueCopy("missing").detail,
    cta: "authorize",
    note: null,
  };
}

/** Why the renewal is paused, in the user's words rather than GitHub's. */
export function githubRefreshPauseCopy(
  kind: NonNullable<GitHubAppUserAuthStatus["lastRefreshError"]>["kind"] | null,
): string {
  if (kind === "rate_limited") {
    return "GitHub is limiting authorization requests for this account. ADE retries automatically — reconnecting won't speed this up.";
  }
  if (kind === "outage") {
    return "GitHub isn't answering authorization requests right now. ADE retries automatically — nothing here needs changing.";
  }
  if (kind === "network") {
    return "ADE couldn't reach GitHub to renew this authorization. It retries automatically once the connection is back.";
  }
  return "ADE couldn't renew this authorization just now. It retries automatically — reconnecting won't speed this up.";
}

/**
 * The App row in the Settings connection ladder. Same honesty rule as the panel:
 * a paused renewal reads as a wait, and only a dead refresh token asks for one.
 */
export function describeGithubAppCredentialBadge(
  account: GithubAccountAuthState,
  blockedUntil: string | null,
): { label: string; tone: GithubAccountAxisTone } | null {
  if (account === "blocked") return { label: githubPausedLabel(blockedUntil), tone: "neutral" };
  if (account === "needs_reauth") return { label: "Re-authorize", tone: "warn" };
  return null;
}

/**
 * The one label for a paused renewal, with the deadline when there is one.
 *
 * Two surfaces render it — the axis pill and the ladder badge — and they have
 * to read identically: a user who sees "Paused" in one card and "Paused until
 * 3:40 PM" in the other reads them as two different problems.
 */
export function githubPausedLabel(blockedUntil: string | null): string {
  const until = formatGithubShortTime(blockedUntil);
  return until ? `Paused until ${until}` : "Paused";
}

/** Short wall-clock time for a deadline ADE is waiting on ("3:40 PM"). */
export function formatGithubShortTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * True when GitHub itself paused the OAuth request, rather than rejecting it.
 * The raw transport error reads "GitHub OAuth request failed (429)", which tells
 * the user nothing and looks like ADE broke.
 */
export function isGithubAuthorizationPausedMessage(message: string | null | undefined): boolean {
  const normalized = message?.trim().toLowerCase() ?? "";
  if (!normalized) return false;
  if (isGithubRateLimitMessage(normalized)) return true;
  return normalized.includes("too many requests") || /\b429\b/.test(normalized);
}

/** What replaces GitHub's transport error when the sign-in host is throttling. */
export const GITHUB_AUTHORIZATION_PAUSED_COPY =
  "GitHub is limiting authorization requests for this account right now. ADE keeps trying on its own — try again in a few minutes.";

/** Replaces GitHub's transport error ("...failed (429)") with what it means. */
export function deviceAuthMessageCopy(message: string | null): string | null {
  if (!message) return message;
  return isGithubAuthorizationPausedMessage(message) ? GITHUB_AUTHORIZATION_PAUSED_COPY : message;
}

export function deviceAuthErrorCopy(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return deviceAuthMessageCopy(message) ?? message;
}

export function githubRepoIssueCopy(
  repo: Extract<
    GithubRepoConnectionState,
    "not_installed" | "access_pending" | "webhook_off" | "waiting_on_account"
  >,
  repoLabel: string | null,
  account?: GithubAccountAuthState,
): { title: string; detail: string; action: string } {
  const label = repoLabel ?? "this repository";
  if (repo === "waiting_on_account") {
    return {
      title: `Waiting on GitHub authorization for ${label}`,
      detail: account === "missing"
        ? "Authorize ADE with GitHub above, then this repo's app status appears here."
        : "ADE can't check this repo until the GitHub authorization above is working again.",
      action: "Recheck",
    };
  }
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

/**
 * Where the banner's single CTA has to land. Everything about GitHub itself is
 * fixed in the GitHub settings card; an unreadable credential store is not a
 * GitHub problem at all, and its only repair control lives in Connections.
 */
export type GithubBannerTarget = "github-settings" | "connections";

export function describeGithubCliBanner(status: GitHubStatus): {
  subState: string;
  title: string;
  detail: string;
  action: string;
  /** Always stated: an omitted target left every caller to re-derive the default. */
  target: GithubBannerTarget;
} {
  // First, and ahead of `!tokenStored`: an unreadable store returns an EMPTY
  // view, so every other conclusion below is drawn from credentials ADE could
  // not read. Saying "not connected" here is what invited users to reconnect
  // over working credentials.
  if (status.credentialStoreUnreadable === true) {
    const { subState, title, detail, action } = GITHUB_CREDENTIAL_STORE_UNREADABLE_COPY;
    return { subState, title, detail, action, target: "connections" };
  }
  if (!status.tokenStored) {
    return {
      subState: "no-token",
      title: "GitHub CLI or token not connected",
      detail: "Connect the GitHub CLI (gh auth login) or add a personal access token so ADE can run git and PR operations.",
      action: "Connect GitHub",
      target: "github-settings",
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
  // Targeted at the GitHub card like every other GitHub-blaming state: an
  // outage is not a credential-store problem, so Connections has nothing for
  // it. (The Repair control there is only for a store ADE cannot read.) The
  // action label is rewritten because this shape drops `actionUrl` — a button
  // that navigates in-app must not read as a link to githubstatus.com; the
  // settings card itself carries the real external incident link.
  if (outage) return { ...outage, action: "Open GitHub settings", target: "github-settings" };
  if (status.connected && !githubStatusHasWriteCredential(status)) {
    return {
      subState: "no-write-credential",
      title: "GitHub write access isn't connected",
      detail: "The ADE GitHub App can keep pull request data fresh, but GitHub CLI or a personal access token is needed for create, update, and merge actions.",
      action: "Connect GitHub",
      target: "github-settings",
    };
  }
  const authFailure = describeGithubAuthFailure(status);
  // Every auth failure is fixed on the GitHub card: the credential ADE holds is
  // readable, it is the account behind it that GitHub has an objection to.
  if (authFailure) {
    return { ...authFailure, target: "github-settings" };
  }
  if (status.tokenType === "fine-grained" && status.repoAccessOk === false) {
    const repoLabel = status.repo ? `${status.repo.owner}/${status.repo.name}` : "this repository";
    return {
      subState: "repo-access",
      title: `GitHub token can't access ${repoLabel}`,
      detail: "Your fine-grained token is valid but hasn't been granted this repository. Update its repository access.",
      action: "Fix GitHub auth",
      target: "github-settings",
    };
  }
  return {
    subState: "missing-perms",
    title: "GitHub token is missing permissions",
    detail: "Your GitHub token lacks the scopes ADE needs. Reconnect it with repo and workflow access.",
    action: "Fix GitHub auth",
    target: "github-settings",
  };
}

export function describeGithubAuthFailure(
  status: GitHubStatus,
): GithubFailurePresentation | null {
  // Corroborated outage outranks every credential-shaped reading of the same
  // failure: whatever GitHub returned, the cause is GitHub.
  const outage = describeGithubOutage(status);
  if (outage) return outage;
  // ADE renewing its own credential, forwarded by `classifyAppUserAuthFailure`.
  // Nothing is wrong, so this offers no reconnect CTA.
  //
  // The message check is the FALLBACK, kept for an older host that still sends
  // the renewal as `kind: "unknown"` with this exact copy. It matches the shared
  // constant rather than the prose: a substring test over failure messages is
  // how a repository problem once got reported as an account problem.
  if (
    status.authFailure?.kind === "renewing"
    || status.authFailure?.message === GITHUB_APP_USER_AUTH_RENEWING_COPY
  ) {
    return {
      subState: "renewing",
      statusLabel: "Renewing",
      title: "Renewing GitHub authorization",
      detail: "ADE is renewing this authorization — this takes a moment.",
      settingsDetail: "ADE is renewing this authorization — this takes a moment. Nothing here needs changing.",
      action: "Open GitHub settings",
    };
  }
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
