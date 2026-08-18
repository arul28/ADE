import { describe, expect, it } from "vitest";
import type { GitHubRequestBudget } from "../../../../shared/types";
import {
  GITHUB_POLL_BACKOFF_BASE_MS,
  GITHUB_POLL_BACKOFF_CONFIRMED_BROKEN_BASE_MS,
  GITHUB_POLL_BACKOFF_MAX_MS,
  applyGithubRequestBudget,
  githubPollBackoffMs,
  githubPollPeriodMs,
  initialGithubPollGovernorState,
  isGithubPollPaused,
  noteGithubPollFailure,
  noteGithubPollSuccess,
} from "./githubPollGovernor";

const NOW = Date.parse("2026-08-17T12:00:00.000Z");
const BASE_PERIOD_MS = 5_000;

function budget(overrides: Partial<GitHubRequestBudget> = {}): GitHubRequestBudget {
  return { pausedUntil: null, failureKind: null, retryAt: null, ...overrides };
}

function periodFor(state: Parameters<typeof githubPollPeriodMs>[0], nowMs = NOW): number {
  return githubPollPeriodMs(state, BASE_PERIOD_MS, nowMs);
}

describe("githubPollGovernor", () => {
  it("arms a stand-down for a failure it cannot classify", () => {
    // The 2026-08-17 regression in one assertion: the old brake only fired on a
    // message containing "rate limit", so a 5xx polled at full speed. Any
    // rejection now costs the loop its fast cadence.
    const state = noteGithubPollFailure(initialGithubPollGovernorState, NOW);
    expect(isGithubPollPaused(state, NOW)).toBe(true);
    expect(periodFor(state)).toBe(GITHUB_POLL_BACKOFF_BASE_MS);
  });

  it("does not hold the 5s checks poll open after an errored checks fetch", () => {
    // `getChecks` rejecting used to be indistinguishable from "CI has not
    // started yet", which kept the pane at its 5s cadence for as long as GitHub
    // stayed down — 720 poll groups an hour at ~7-10 requests each.
    let state = initialGithubPollGovernorState;
    expect(periodFor(state)).toBe(BASE_PERIOD_MS);

    state = noteGithubPollFailure(state, NOW);
    expect(periodFor(state)).toBeGreaterThan(BASE_PERIOD_MS);
  });

  it("does not climb the ladder for failures GitHub was never proven to have seen", () => {
    // A runtime reconnect, an IPC blip, or a local "PR not found" all surface
    // as a bare rejection. They should cost one rung, not five minutes of
    // staleness on the surface whose whole value is liveness.
    let state = initialGithubPollGovernorState;
    for (let i = 0; i < 10; i += 1) state = noteGithubPollFailure(state, NOW);
    expect(periodFor(state)).toBe(GITHUB_POLL_BACKOFF_BASE_MS);
  });

  it("climbs and caps once the failure is attributed to GitHub", () => {
    let state = applyGithubRequestBudget(
      noteGithubPollFailure(initialGithubPollGovernorState, NOW),
      budget({ failureKind: "service_unavailable" }),
      NOW,
    );
    expect(periodFor(state)).toBe(GITHUB_POLL_BACKOFF_CONFIRMED_BROKEN_BASE_MS);

    for (let i = 0; i < 20; i += 1) state = noteGithubPollFailure(state, NOW);
    expect(periodFor(state)).toBe(GITHUB_POLL_BACKOFF_MAX_MS);
  });

  it("doubles per consecutive attributed failure and caps", () => {
    expect(githubPollBackoffMs(0, "service_unavailable")).toBe(0);
    expect(githubPollBackoffMs(1, "service_unavailable"))
      .toBe(GITHUB_POLL_BACKOFF_CONFIRMED_BROKEN_BASE_MS);
    expect(githubPollBackoffMs(2, "service_unavailable"))
      .toBe(GITHUB_POLL_BACKOFF_CONFIRMED_BROKEN_BASE_MS * 2);
    expect(githubPollBackoffMs(50, "service_unavailable")).toBe(GITHUB_POLL_BACKOFF_MAX_MS);
    // A named rate limit with no reset instant goes straight to the ceiling.
    expect(githubPollBackoffMs(1, "rate_limited")).toBe(GITHUB_POLL_BACKOFF_MAX_MS);
  });

  it("never shortens an armed stand-down when a parallel request also fails", () => {
    const resetAtMs = NOW + 45 * 60_000;
    const armed = applyGithubRequestBudget(
      noteGithubPollFailure(initialGithubPollGovernorState, NOW),
      budget({ failureKind: "rate_limited", retryAt: new Date(resetAtMs).toISOString() }),
      NOW,
    );
    expect(armed.ladderPausedUntilMs).toBe(resetAtMs);
    expect(noteGithubPollFailure(armed, NOW).ladderPausedUntilMs).toBe(resetAtMs);
  });

  it("clears the ladder on the first success", () => {
    let state = noteGithubPollFailure(initialGithubPollGovernorState, NOW);
    state = noteGithubPollFailure(state, NOW);
    state = noteGithubPollSuccess(state);
    expect(state).toEqual(initialGithubPollGovernorState);
    expect(isGithubPollPaused(state, NOW)).toBe(false);
  });

  it("returns the same object when a success finds nothing to clear", () => {
    // Referential stability matters: the hook bumps a render generation when
    // the stand-down changes, and a healthy poll must not churn it.
    expect(noteGithubPollSuccess(initialGithubPollGovernorState))
      .toBe(initialGithubPollGovernorState);
  });

  describe("quota reserve", () => {
    const pausedUntil = new Date(NOW + 30 * 60_000).toISOString();

    it("stands the loop down when the reserve is armed", () => {
      // The 500-request reserve was enforced in exactly one place — the
      // background poller — while the foreground loops that actually drained
      // the quota ignored it entirely.
      const state = applyGithubRequestBudget(
        initialGithubPollGovernorState,
        budget({ pausedUntil }),
        NOW,
      );
      expect(isGithubPollPaused(state, NOW)).toBe(true);
      expect(periodFor(state)).toBe(GITHUB_POLL_BACKOFF_MAX_MS);
    });

    it("survives a success, because a request does not refill the quota", () => {
      // User actions are ungated on purpose, so their successes reach the
      // governor. When the reserve shared one field with the failure ladder,
      // every PR open or Refresh click wiped it and handed the automatic loops
      // their 5-second cadence back with the quota still under 500 — leaking
      // the reserve roughly a minute at a time, repeatably.
      const reserved = applyGithubRequestBudget(
        initialGithubPollGovernorState,
        budget({ pausedUntil }),
        NOW,
      );
      const afterSuccess = noteGithubPollSuccess(reserved);
      expect(isGithubPollPaused(afterSuccess, NOW)).toBe(true);
      expect(afterSuccess.reservePausedUntilMs).toBe(Date.parse(pausedUntil));
    });

    it("lifts by itself at the quota reset", () => {
      const state = applyGithubRequestBudget(
        initialGithubPollGovernorState,
        budget({ pausedUntil }),
        NOW,
      );
      const afterResetMs = Date.parse(pausedUntil) + 1;
      expect(isGithubPollPaused(state, afterResetMs)).toBe(false);
      expect(periodFor(state, afterResetMs)).toBe(BASE_PERIOD_MS);
    });

    it("lets automatic reads proceed while quota is healthy", () => {
      const state = applyGithubRequestBudget(initialGithubPollGovernorState, budget(), NOW);
      expect(isGithubPollPaused(state, NOW)).toBe(false);
      expect(periodFor(state)).toBe(BASE_PERIOD_MS);
    });
  });

  describe("typed failure kind", () => {
    it("re-derives the ladder once the kind is known", () => {
      // The kind cannot ride on the rejection — IPC flattens an error to its
      // message — so it arrives here, from the credential health recorded in
      // the process that made the request.
      const failed = noteGithubPollFailure(initialGithubPollGovernorState, NOW);
      expect(failed.ladderPausedUntilMs).toBe(NOW + GITHUB_POLL_BACKOFF_BASE_MS);

      const classified = applyGithubRequestBudget(
        failed,
        budget({ failureKind: "service_unavailable" }),
        NOW,
      );
      expect(classified.failureKind).toBe("service_unavailable");
      expect(classified.ladderPausedUntilMs)
        .toBe(NOW + GITHUB_POLL_BACKOFF_CONFIRMED_BROKEN_BASE_MS);
    });

    it("waits for the reset instant GitHub named rather than guessing", () => {
      const resetAtMs = NOW + 42 * 60_000;
      const state = applyGithubRequestBudget(
        noteGithubPollFailure(initialGithubPollGovernorState, NOW),
        budget({ failureKind: "rate_limited", retryAt: new Date(resetAtMs).toISOString() }),
        NOW,
      );
      expect(state.ladderPausedUntilMs).toBe(resetAtMs);
    });

    it("never clears an armed ladder just because quota looks fine", () => {
      const failed = noteGithubPollFailure(initialGithubPollGovernorState, NOW);
      const applied = applyGithubRequestBudget(failed, budget(), NOW);
      expect(applied.ladderPausedUntilMs).toBe(failed.ladderPausedUntilMs);
    });

    it("does not put a healthy loop on a ladder for another surface's failure", () => {
      const applied = applyGithubRequestBudget(
        initialGithubPollGovernorState,
        budget({ failureKind: "service_unavailable" }),
        NOW,
      );
      expect(isGithubPollPaused(applied, NOW)).toBe(false);
      expect(applied.failureKind).toBeNull();
    });

    it("does not let a late budget response resurrect a kind a success cleared", () => {
      const cleared = noteGithubPollSuccess(
        noteGithubPollFailure(initialGithubPollGovernorState, NOW),
      );
      const applied = applyGithubRequestBudget(
        cleared,
        budget({ failureKind: "service_unavailable" }),
        NOW,
      );
      expect(applied.failureKind).toBeNull();
      expect(isGithubPollPaused(applied, NOW)).toBe(false);
    });

    it("is inert when the runtime cannot answer", () => {
      // An older remote runtime has no budget action. Callers must keep their
      // own local ladder rather than losing the brake entirely.
      const failed = noteGithubPollFailure(initialGithubPollGovernorState, NOW);
      expect(applyGithubRequestBudget(failed, null, NOW)).toBe(failed);
      expect(applyGithubRequestBudget(failed, undefined, NOW)).toBe(failed);
    });
  });

  it("returns to the base cadence once the stand-down elapses", () => {
    const state = noteGithubPollFailure(initialGithubPollGovernorState, NOW);
    const afterMs = state.ladderPausedUntilMs + 1;
    expect(isGithubPollPaused(state, afterMs)).toBe(false);
    expect(periodFor(state, afterMs)).toBe(BASE_PERIOD_MS);
  });

  it("never polls faster than the caller's own base cadence", () => {
    const state = noteGithubPollFailure(initialGithubPollGovernorState, NOW);
    // A 5-minute base loop must not be sped up to 30s by a short stand-down.
    expect(githubPollPeriodMs(state, 5 * 60_000, NOW)).toBe(5 * 60_000);
  });
});
