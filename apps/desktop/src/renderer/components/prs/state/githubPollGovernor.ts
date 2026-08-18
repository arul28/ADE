import type { GitHubAuthFailureKind, GitHubRequestBudget } from "../../../../shared/types";

/**
 * The shared brake on every *automatic* GitHub read the PRs surface makes.
 *
 * Why this exists, concretely. On 2026-08-17 GitHub had a multi-hour outage.
 * ADE's PR detail pane polls readiness signals every 5 seconds while the Checks
 * tab is open and something is still running, and each tick costs roughly seven
 * to ten REST requests (a pull, an Actions runs page, up to twelve job reads, a
 * combined status, a check-runs page). That is 5,000+ requests an hour — the
 * whole quota — and two independent defects let it run the full hour:
 *
 * 1. The loop's stop condition is "at least one check exists and all of them
 *    settled". A failed checks fetch was swallowed into an empty array, which
 *    is byte-identical to "CI has not started yet", so the loop stayed in its
 *    fast cadence forever instead of the ~10 minutes a real CI run takes.
 * 2. The only brake was `msg.includes("rate limit") || msg.includes("API rate")`
 *    on the rejection message. Every response during the outage was a 5xx,
 *    which matches neither substring, so the backoff never armed — while every
 *    failed request still consumed quota.
 *
 * The governor replaces both with typed state:
 *
 * - **Any** rejected automatic read arms an exponential stand-down, so a
 *   failure ADE cannot classify still slows the loop down. There is no
 *   substring anywhere.
 * - The classified {@link GitHubAuthFailureKind} chooses the *first* rung: a
 *   corroborated GitHub outage starts further out than a one-off blip, because
 *   retrying an outage in 30 seconds is a request spent on nothing.
 * - {@link GitHubRequestBudget.pausedUntil} carries the 500-request reserve the
 *   background PR poller already honours. Foreground timers stand down at the
 *   same line and resume by themselves at the quota reset, which is what keeps
 *   the reserve available for the merge the user is actually trying to do.
 *
 * What it deliberately does NOT do is stop. Every rung is a longer cadence, not
 * a dead loop, and nothing here clears, hides, or blanks data — a paused poll
 * leaves the last-known checks, activity, and threads on screen. ADE showing
 * what it already knows is the whole point of degrading the request rate
 * instead of the feature.
 */

/** First stand-down after a single failure ADE could not attribute to GitHub. */
export const GITHUB_POLL_BACKOFF_BASE_MS = 30_000;
/**
 * First stand-down when GitHub has given a definite answer that a fast retry
 * cannot change: GitHub itself is failing (5xx), or it rejected the credential.
 * During an incident the fast retry is the thing burning the quota.
 */
export const GITHUB_POLL_BACKOFF_CONFIRMED_BROKEN_BASE_MS = 60_000;
/**
 * Ceiling for the ladder. Matches `prPollingService`'s `MAX_INTERVAL_MS`, so a
 * degraded foreground never asks GitHub harder than the degraded background.
 */
export const GITHUB_POLL_BACKOFF_MAX_MS = 5 * 60_000;

export type GithubPollGovernorState = {
  /** Consecutive failed automatic reads. Zero after any success. */
  consecutiveFailures: number;
  /**
   * Epoch ms the failure ladder is standing down until. Cleared by a success,
   * because GitHub answering is proof the ladder's premise no longer holds.
   */
  ladderPausedUntilMs: number;
  /**
   * Epoch ms the 500-request quota reserve is standing down until — tracked
   * SEPARATELY from the ladder, and deliberately NOT cleared by a success.
   *
   * They were one field first, and that quietly leaked the reserve: a user
   * action (opening a PR, hitting Refresh) is ungated on purpose, so its
   * success reset the whole governor and every automatic loop went back to its
   * 5-second cadence with the quota still below 500. The reserve is a fact
   * about how much quota is left, which a successful request does not change —
   * only the quota reset does, and the budget reports that instant.
   */
  reservePausedUntilMs: number;
  /** Why the governor last stood down, for the cadence decision and logging. */
  failureKind: GitHubAuthFailureKind | null;
};

export const initialGithubPollGovernorState: GithubPollGovernorState = {
  consecutiveFailures: 0,
  ladderPausedUntilMs: 0,
  reservePausedUntilMs: 0,
  failureKind: null,
};

/** The later of the two independent stand-downs. */
function pausedUntilMs(state: GithubPollGovernorState): number {
  return Math.max(state.ladderPausedUntilMs, state.reservePausedUntilMs);
}

/**
 * How long the FIRST stand-down lasts, by how definite GitHub's answer was.
 *
 * This ordering is a contract with `REQUEST_BUDGET_FAILURE_SEVERITY` in
 * `main/services/github/githubCredentialHealth.ts`: when several credentials
 * have each recorded a different failure, the budget reports the one whose kind
 * asks for the longest stand-down, and it can only do that if its severity
 * ranking agrees with this function. Change one, change both.
 */
function ladderBaseMs(kind: GitHubAuthFailureKind | null): number {
  switch (kind) {
    case "rate_limited":
      // No ladder: a rate limit with no named reset goes straight to the
      // ceiling. GitHub's guidance is to stop until the quota resets, and when
      // it named a reset instant `noteGithubPollFailure` waits for that instead.
      return GITHUB_POLL_BACKOFF_MAX_MS;
    case "service_unavailable":
    case "invalid_token":
    case "permission_denied":
      return GITHUB_POLL_BACKOFF_CONFIRMED_BROKEN_BASE_MS;
    default:
      // `network` and `unknown`: ADE does not know that a fast retry is
      // pointless, so it stays on the short base.
      return GITHUB_POLL_BACKOFF_BASE_MS;
  }
}

/**
 * `base * 2^(n-1)`, capped. The cap is what makes this safe to leave running
 * for hours: at the ceiling a stuck PR detail pane costs at most twelve poll
 * groups an hour instead of seven hundred and twenty.
 */
export function githubPollBackoffMs(
  consecutiveFailures: number,
  kind: GitHubAuthFailureKind | null,
): number {
  if (consecutiveFailures <= 0) return 0;
  const base = ladderBaseMs(kind);
  // An unclassified failure does not climb. ADE does not know GitHub was even
  // reached — a runtime reconnect, an IPC blip, or a local "PR not found" all
  // land here — and punishing those up to the five-minute ceiling would cost
  // liveness on the one surface whose whole value is liveness. A failure the
  // budget later attributes to GitHub climbs normally, because by then ADE
  // knows what it is looking at.
  if (kind == null) return base;
  const grown = base * Math.pow(2, Math.min(consecutiveFailures - 1, 8));
  return Math.min(grown, GITHUB_POLL_BACKOFF_MAX_MS);
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Record a failed automatic read.
 *
 * It takes no failure kind on purpose. The caller only ever has a bare
 * rejection — both transports between it and GitHub flatten an error to its
 * message — so a `kind` parameter here could only ever be filled by the
 * substring guessing this module exists to delete. The kind arrives afterwards,
 * as data, through {@link applyGithubRequestBudget}, and the ladder is
 * re-derived then. Until it does, the short base applies, which is the
 * conservative direction: a real outage gets longer, never shorter.
 */
export function noteGithubPollFailure(
  state: GithubPollGovernorState,
  nowMs: number,
): GithubPollGovernorState {
  const consecutiveFailures = state.consecutiveFailures + 1;
  return {
    ...state,
    consecutiveFailures,
    // Never shorten an existing stand-down: a second failure arriving from a
    // parallel request must not reset a longer pause to a shorter one.
    ladderPausedUntilMs: Math.max(
      state.ladderPausedUntilMs,
      nowMs + githubPollBackoffMs(consecutiveFailures, state.failureKind),
    ),
  };
}

/**
 * Record a successful automatic read. GitHub answering is the fact that
 * matters, so one success clears the whole ladder — the same rule the service's
 * `githubReadBackoff` uses.
 */
export function noteGithubPollSuccess(
  state: GithubPollGovernorState,
): GithubPollGovernorState {
  if (state.consecutiveFailures === 0 && state.ladderPausedUntilMs === 0 && state.failureKind === null) {
    return state;
  }
  // The reserve survives on purpose — see `reservePausedUntilMs`.
  return {
    ...initialGithubPollGovernorState,
    reservePausedUntilMs: state.reservePausedUntilMs,
  };
}

/**
 * Fold the runtime's request budget into the governor.
 *
 * This is where the *typed* half of the fix lands. A rejected read reaches the
 * renderer as a bare rejection — Electron IPC and the runtime's JSON-RPC both
 * flatten an error to its message — so the kind cannot come from the error. It
 * comes from here instead: the budget reports the kind `classifyGitHubAuthFailure`
 * already recorded on the credential in the process that made the request. When
 * that kind says GitHub is down rather than merely unhappy, the ladder is
 * re-derived at the outage base, which is how a 5xx now arms a real stand-down
 * where the old `msg.includes("rate limit")` check armed nothing at all.
 *
 * The reserve is authoritative and one-directional: it can only *extend* a
 * stand-down. A budget reporting no pause never clears a ladder armed by
 * observed failures, because "quota is fine" says nothing about whether GitHub
 * is answering.
 */
export function applyGithubRequestBudget(
  state: GithubPollGovernorState,
  budget: GitHubRequestBudget | null | undefined,
  nowMs: number,
): GithubPollGovernorState {
  if (!budget) return state;
  // Only failures ADE actually observed put it on a ladder, so a kind reported
  // while this surface has none of its own is another surface's problem — and,
  // importantly, a budget response still in flight when a success cleared the
  // ladder must not resurrect the kind it carried.
  const observedFailure = state.consecutiveFailures > 0;
  const failureKind = observedFailure ? budget.failureKind ?? state.failureKind : null;
  const ladderUntilMs = observedFailure && failureKind !== state.failureKind
    ? nowMs + githubPollBackoffMs(state.consecutiveFailures, failureKind)
    : 0;
  // The one place a GitHub-named reset instant is honoured. GitHub's guidance
  // is explicit: when `x-ratelimit-remaining` is 0, do not make another request
  // until `x-ratelimit-reset`. Waiting exactly that long beats guessing.
  const retryAtMs = failureKind === "rate_limited" ? parseIsoMs(budget.retryAt) ?? 0 : 0;
  const next: GithubPollGovernorState = {
    ...state,
    failureKind,
    reservePausedUntilMs: Math.max(
      state.reservePausedUntilMs,
      parseIsoMs(budget.pausedUntil) ?? 0,
    ),
    ladderPausedUntilMs: Math.max(state.ladderPausedUntilMs, ladderUntilMs, retryAtMs),
  };
  if (
    next.failureKind === state.failureKind
    && next.reservePausedUntilMs === state.reservePausedUntilMs
    && next.ladderPausedUntilMs === state.ladderPausedUntilMs
  ) return state;
  return next;
}

export function isGithubPollPaused(
  state: GithubPollGovernorState,
  nowMs: number,
): boolean {
  return pausedUntilMs(state) > nowMs;
}

/**
 * The interval an automatic PR read loop should actually run at.
 *
 * Returning a longer *period* rather than skipping ticks matters: a 5-second
 * timer that returns early still wakes the renderer 720 times an hour, and — as
 * the outage showed — a single missing guard turns each of those wakeups back
 * into a request. Slowing the timer removes the opportunity entirely.
 */
export function githubPollPeriodMs(
  state: GithubPollGovernorState,
  basePeriodMs: number,
  nowMs: number,
): number {
  const remainingPauseMs = pausedUntilMs(state) - nowMs;
  if (remainingPauseMs <= 0) return basePeriodMs;
  return Math.max(basePeriodMs, Math.min(remainingPauseMs, GITHUB_POLL_BACKOFF_MAX_MS));
}
