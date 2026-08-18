import { describe, expect, it } from "vitest";
import type { GitHubRequestBudget } from "../../../../shared/types";
import {
  GITHUB_POLL_BACKOFF_BASE_MS,
  GITHUB_POLL_BACKOFF_MAX_MS,
  GITHUB_POLL_BACKOFF_OUTAGE_BASE_MS,
  applyGithubRequestBudget,
  githubPollBackoffMs,
  githubPollPeriodMs,
  initialGithubPollGovernorState,
  isGithubPollPaused,
  noteGithubPollFailure,
  noteGithubPollSuccess,
} from "./githubPollGovernor";

const NOW = Date.parse("2026-08-17T12:00:00.000Z");

function budget(overrides: Partial<GitHubRequestBudget> = {}): GitHubRequestBudget {
  return {
    pausedUntil: null,
    failureKind: null,
    retryAt: null,
    remaining: null,
    limit: null,
    resource: null,
    ...overrides,
  };
}

describe("githubPollGovernor", () => {
  it("arms a stand-down for a failure it cannot classify", () => {
    // The 2026-08-17 regression in one assertion: the old brake only fired on
    // a message containing "rate limit", so a 5xx (or anything else) polled at
    // full speed. Any rejection now costs the loop its fast cadence.
    const state = noteGithubPollFailure(initialGithubPollGovernorState, { nowMs: NOW });
    expect(isGithubPollPaused(state, NOW)).toBe(true);
    expect(state.pausedUntilMs).toBe(NOW + GITHUB_POLL_BACKOFF_BASE_MS);
  });

  it("does not hold the 5s checks poll open after an errored checks fetch", () => {
    // `getChecks` rejecting used to be indistinguishable from "CI has not
    // started yet", which kept the pane at its 5s cadence for as long as GitHub
    // stayed down — 720 poll groups an hour at ~7-10 requests each.
    let state = initialGithubPollGovernorState;
    expect(githubPollPeriodMs({ basePeriodMs: 5_000, state, nowMs: NOW })).toBe(5_000);

    state = noteGithubPollFailure(state, { nowMs: NOW });
    expect(githubPollPeriodMs({ basePeriodMs: 5_000, state, nowMs: NOW }))
      .toBe(GITHUB_POLL_BACKOFF_BASE_MS);

    // Repeated failures climb, and the ceiling bounds the worst case.
    for (let i = 0; i < 20; i += 1) state = noteGithubPollFailure(state, { nowMs: NOW });
    expect(githubPollPeriodMs({ basePeriodMs: 5_000, state, nowMs: NOW }))
      .toBe(GITHUB_POLL_BACKOFF_MAX_MS);
  });

  it("starts further out when the failure is GitHub's own", () => {
    const generic = noteGithubPollFailure(initialGithubPollGovernorState, { nowMs: NOW });
    const outage = noteGithubPollFailure(initialGithubPollGovernorState, {
      nowMs: NOW,
      kind: "service_unavailable",
    });
    expect(outage.pausedUntilMs - NOW).toBe(GITHUB_POLL_BACKOFF_OUTAGE_BASE_MS);
    expect(outage.pausedUntilMs).toBeGreaterThan(generic.pausedUntilMs);
  });

  it("doubles per consecutive failure and caps", () => {
    expect(githubPollBackoffMs(0, null)).toBe(0);
    expect(githubPollBackoffMs(1, null)).toBe(GITHUB_POLL_BACKOFF_BASE_MS);
    expect(githubPollBackoffMs(2, null)).toBe(GITHUB_POLL_BACKOFF_BASE_MS * 2);
    expect(githubPollBackoffMs(3, null)).toBe(GITHUB_POLL_BACKOFF_BASE_MS * 4);
    expect(githubPollBackoffMs(50, null)).toBe(GITHUB_POLL_BACKOFF_MAX_MS);
  });

  it("never shortens an armed stand-down when a parallel request also fails", () => {
    const first = noteGithubPollFailure(initialGithubPollGovernorState, {
      nowMs: NOW,
      kind: "rate_limited",
      retryAtMs: NOW + 45 * 60_000,
    });
    const second = noteGithubPollFailure(first, { nowMs: NOW });
    expect(second.pausedUntilMs).toBe(NOW + 45 * 60_000);
  });

  it("waits for the reset instant GitHub named rather than guessing", () => {
    const resetAtMs = NOW + 42 * 60_000;
    const state = noteGithubPollFailure(initialGithubPollGovernorState, {
      nowMs: NOW,
      kind: "rate_limited",
      retryAtMs: resetAtMs,
    });
    expect(state.pausedUntilMs).toBe(resetAtMs);
  });

  it("clears the ladder on the first success", () => {
    let state = noteGithubPollFailure(initialGithubPollGovernorState, { nowMs: NOW });
    state = noteGithubPollFailure(state, { nowMs: NOW });
    state = noteGithubPollSuccess(state);
    expect(state).toEqual(initialGithubPollGovernorState);
    expect(isGithubPollPaused(state, NOW)).toBe(false);
  });

  it("returns the same object when a success finds nothing to clear", () => {
    // Referential stability matters: the provider bumps a render generation
    // when the stand-down changes, and a healthy poll must not churn it.
    const state = noteGithubPollSuccess(initialGithubPollGovernorState);
    expect(state).toBe(initialGithubPollGovernorState);
  });

  describe("request budget", () => {
    it("stands the loop down when the quota reserve is armed", () => {
      // The 500-request reserve was enforced in exactly one place — the
      // background poller — while the foreground loops that actually drained
      // the quota ignored it entirely.
      const pausedUntil = new Date(NOW + 30 * 60_000).toISOString();
      const state = applyGithubRequestBudget(
        initialGithubPollGovernorState,
        budget({ pausedUntil, remaining: 500, limit: 5_000, resource: "core" }),
        NOW,
      );
      expect(isGithubPollPaused(state, NOW)).toBe(true);
      expect(state.pausedUntilMs).toBe(Date.parse(pausedUntil));
      expect(githubPollPeriodMs({ basePeriodMs: 5_000, state, nowMs: NOW }))
        .toBe(GITHUB_POLL_BACKOFF_MAX_MS);
    });

    it("lets automatic reads proceed while quota is healthy", () => {
      const state = applyGithubRequestBudget(
        initialGithubPollGovernorState,
        budget({ remaining: 4_800, limit: 5_000, resource: "core" }),
        NOW,
      );
      expect(isGithubPollPaused(state, NOW)).toBe(false);
      expect(githubPollPeriodMs({ basePeriodMs: 5_000, state, nowMs: NOW })).toBe(5_000);
    });

    it("re-derives the ladder at the outage base once the kind is known", () => {
      // The typed kind cannot ride on the rejection — IPC flattens an error to
      // its message — so it arrives here, from the credential health recorded
      // in the process that made the request.
      const failed = noteGithubPollFailure(initialGithubPollGovernorState, { nowMs: NOW });
      expect(failed.pausedUntilMs).toBe(NOW + GITHUB_POLL_BACKOFF_BASE_MS);

      const classified = applyGithubRequestBudget(
        failed,
        budget({ failureKind: "service_unavailable" }),
        NOW,
      );
      expect(classified.failureKind).toBe("service_unavailable");
      expect(classified.pausedUntilMs).toBe(NOW + GITHUB_POLL_BACKOFF_OUTAGE_BASE_MS);
    });

    it("never clears an armed ladder just because quota looks fine", () => {
      const failed = noteGithubPollFailure(initialGithubPollGovernorState, { nowMs: NOW });
      const applied = applyGithubRequestBudget(failed, budget({ remaining: 4_900 }), NOW);
      expect(applied.pausedUntilMs).toBe(failed.pausedUntilMs);
      expect(isGithubPollPaused(applied, NOW)).toBe(true);
    });

    it("does not put a healthy loop on a ladder for another surface's failure", () => {
      const applied = applyGithubRequestBudget(
        initialGithubPollGovernorState,
        budget({ failureKind: "service_unavailable" }),
        NOW,
      );
      expect(isGithubPollPaused(applied, NOW)).toBe(false);
    });

    it("is inert when the runtime cannot answer", () => {
      // An older remote runtime has no budget action. Callers must keep their
      // own local ladder rather than losing the brake entirely.
      const failed = noteGithubPollFailure(initialGithubPollGovernorState, { nowMs: NOW });
      expect(applyGithubRequestBudget(failed, null, NOW)).toBe(failed);
      expect(applyGithubRequestBudget(failed, undefined, NOW)).toBe(failed);
    });
  });

  it("returns to the base cadence once the stand-down elapses", () => {
    const state = noteGithubPollFailure(initialGithubPollGovernorState, { nowMs: NOW });
    const afterMs = state.pausedUntilMs + 1;
    expect(isGithubPollPaused(state, afterMs)).toBe(false);
    expect(githubPollPeriodMs({ basePeriodMs: 5_000, state, nowMs: afterMs })).toBe(5_000);
  });

  it("never polls faster than the caller's own base cadence", () => {
    const state = noteGithubPollFailure(initialGithubPollGovernorState, { nowMs: NOW });
    // A 5-minute base loop must not be sped up to 30s by a short stand-down.
    expect(githubPollPeriodMs({ basePeriodMs: 5 * 60_000, state, nowMs: NOW })).toBe(5 * 60_000);
  });
});
