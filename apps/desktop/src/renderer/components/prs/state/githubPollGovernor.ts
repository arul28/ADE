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
 * First stand-down when GitHub itself is failing (5xx) or the credential is
 * rejected. A confirmed-broken remote will not be fixed by a fast retry, and
 * during an incident the fast retry is the thing burning the quota.
 */
export const GITHUB_POLL_BACKOFF_OUTAGE_BASE_MS = 60_000;
/**
 * Ceiling for the ladder. Matches `prPollingService`'s `MAX_INTERVAL_MS`, so a
 * degraded foreground never asks GitHub harder than the degraded background.
 */
export const GITHUB_POLL_BACKOFF_MAX_MS = 5 * 60_000;
/**
 * Stand-down when GitHub reported a rate limit but gave ADE no reset instant to
 * wait for. GitHub's own guidance is to wait at least a minute and then back
 * off exponentially; the ladder supplies the exponential part.
 */
export const GITHUB_POLL_RATE_LIMIT_FALLBACK_MS = 5 * 60_000;

export type GithubPollGovernorState = {
  /** Consecutive failed automatic reads. Zero after any success. */
  consecutiveFailures: number;
  /** Epoch ms before which no automatic read may run. */
  pausedUntilMs: number;
  /** Why the governor last stood down, for the cadence decision and logging. */
  failureKind: GitHubAuthFailureKind | null;
};

export const initialGithubPollGovernorState: GithubPollGovernorState = {
  consecutiveFailures: 0,
  pausedUntilMs: 0,
  failureKind: null,
};

function ladderBaseMs(kind: GitHubAuthFailureKind | null): number {
  switch (kind) {
    case "service_unavailable":
    case "invalid_token":
    case "permission_denied":
      return GITHUB_POLL_BACKOFF_OUTAGE_BASE_MS;
    case "rate_limited":
      return GITHUB_POLL_RATE_LIMIT_FALLBACK_MS;
    default:
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
 * `retryAtMs` is honoured over the ladder whenever it is further out: when
 * GitHub names the instant its quota resets, waiting exactly that long is both
 * the documented behaviour ("if `x-ratelimit-remaining` is 0, do not make
 * another request until the time in `x-ratelimit-reset`") and strictly better
 * than guessing.
 */
export function noteGithubPollFailure(
  state: GithubPollGovernorState,
  args: {
    nowMs: number;
    kind?: GitHubAuthFailureKind | null;
    retryAtMs?: number | null;
  },
): GithubPollGovernorState {
  const kind = args.kind ?? state.failureKind ?? null;
  const consecutiveFailures = state.consecutiveFailures + 1;
  const ladderUntilMs = args.nowMs + githubPollBackoffMs(consecutiveFailures, kind);
  const retryAtMs = args.retryAtMs != null && Number.isFinite(args.retryAtMs)
    ? args.retryAtMs
    : 0;
  return {
    consecutiveFailures,
    // Never shorten an existing stand-down: a second failure arriving from a
    // parallel request must not reset a longer pause to a shorter one.
    pausedUntilMs: Math.max(state.pausedUntilMs, ladderUntilMs, retryAtMs),
    failureKind: kind,
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
  if (state.consecutiveFailures === 0 && state.pausedUntilMs === 0 && state.failureKind === null) {
    return state;
  }
  return initialGithubPollGovernorState;
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
  const reservePausedUntilMs = parseIsoMs(budget.pausedUntil) ?? 0;
  const failureKind = budget.failureKind ?? state.failureKind;
  // Only failures ADE actually observed put the loop on a ladder. A recorded
  // failure kind with no failures of our own is another surface's problem.
  const ladderUntilMs = state.consecutiveFailures > 0 && failureKind !== state.failureKind
    ? nowMs + githubPollBackoffMs(state.consecutiveFailures, failureKind)
    : 0;
  const retryAtMs = failureKind === "rate_limited" ? parseIsoMs(budget.retryAt) ?? 0 : 0;
  const pausedUntilMs = Math.max(
    state.pausedUntilMs,
    reservePausedUntilMs,
    ladderUntilMs,
    retryAtMs,
  );
  if (pausedUntilMs === state.pausedUntilMs && failureKind === state.failureKind) return state;
  return { ...state, failureKind, pausedUntilMs };
}

export function isGithubPollPaused(
  state: GithubPollGovernorState,
  nowMs: number,
): boolean {
  return state.pausedUntilMs > nowMs;
}

/**
 * The interval an automatic PR read loop should actually run at.
 *
 * Returning a longer *period* rather than skipping ticks matters: a 5-second
 * timer that returns early still wakes the renderer 720 times an hour, and — as
 * the outage showed — a single missing guard turns each of those wakeups back
 * into a request. Slowing the timer removes the opportunity entirely.
 */
export function githubPollPeriodMs(args: {
  basePeriodMs: number;
  state: GithubPollGovernorState;
  nowMs: number;
}): number {
  const remainingPauseMs = args.state.pausedUntilMs - args.nowMs;
  if (remainingPauseMs <= 0) return args.basePeriodMs;
  return Math.max(args.basePeriodMs, Math.min(remainingPauseMs, GITHUB_POLL_BACKOFF_MAX_MS));
}
