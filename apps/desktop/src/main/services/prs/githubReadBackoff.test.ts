import { describe, expect, it } from "vitest";

import {
  createGithubReadBackoff,
  githubReadFailureBackoffMs,
  GITHUB_READ_FAILURE_BACKOFF_BASE_MS,
  GITHUB_READ_FAILURE_BACKOFF_MAX_MS,
} from "./githubReadBackoff";

// Deliberate mirrors of prService.ts's exported GITHUB_SNAPSHOT_TTL_MS /
// GITHUB_CLOSED_SNAPSHOT_TTL_MS — that module is canonical. Copied rather than
// imported to keep this pure-function suite free of the 12k-line Electron-
// coupled service; drift here mislabels the "pins the rungs" test, nothing more.
const OPEN_SNAPSHOT_TTL_MS = 120_000;
const CLOSED_SNAPSHOT_TTL_MS = 600_000;

describe("githubReadFailureBackoffMs", () => {
  // The invariant the whole module exists for. If a failure ever bought less
  // quiet than a success, a throttled GitHub would make ADE ask FASTER than
  // when healthy: every caller a warm cache would have served locally becomes
  // a live request the moment the cache goes stale and cannot be refreshed.
  it("never lets a failure buy less quiet than a success", () => {
    const ttls = [0, 1_000, OPEN_SNAPSHOT_TTL_MS, CLOSED_SNAPSHOT_TTL_MS, GITHUB_READ_FAILURE_BACKOFF_MAX_MS * 2];
    for (const successTtlMs of ttls) {
      for (let attempts = 1; attempts <= 12; attempts += 1) {
        expect(githubReadFailureBackoffMs(attempts, successTtlMs))
          .toBeGreaterThanOrEqual(successTtlMs);
      }
    }
  });

  it("climbs a doubling ladder and caps it", () => {
    expect(githubReadFailureBackoffMs(1, 0)).toBe(GITHUB_READ_FAILURE_BACKOFF_BASE_MS);
    expect(githubReadFailureBackoffMs(2, 0)).toBe(GITHUB_READ_FAILURE_BACKOFF_BASE_MS * 2);
    expect(githubReadFailureBackoffMs(3, 0)).toBe(GITHUB_READ_FAILURE_BACKOFF_BASE_MS * 4);
    expect(githubReadFailureBackoffMs(50, 0)).toBe(GITHUB_READ_FAILURE_BACKOFF_MAX_MS);
  });

  it("pins the rungs the PR service actually gets", () => {
    // The success-TTL floor swallows the early rungs, so the doubling only
    // becomes visible once the ladder climbs past the TTL. Pinned because the
    // module doc describes the raw 20s/40s/80s ladder, not these values.
    expect([1, 2, 3, 4, 5].map((n) => githubReadFailureBackoffMs(n, OPEN_SNAPSHOT_TTL_MS)))
      .toEqual([120_000, 120_000, 120_000, 160_000, 320_000]);
    expect([1, 2, 3, 4, 5, 6].map((n) => githubReadFailureBackoffMs(n, CLOSED_SNAPSHOT_TTL_MS)))
      .toEqual([600_000, 600_000, 600_000, 600_000, 600_000, 640_000]);
  });

  it("treats a zeroth attempt as the first rung", () => {
    expect(githubReadFailureBackoffMs(0, 0)).toBe(GITHUB_READ_FAILURE_BACKOFF_BASE_MS);
    expect(githubReadFailureBackoffMs(-5, 0)).toBe(GITHUB_READ_FAILURE_BACKOFF_BASE_MS);
  });
});

describe("createGithubReadBackoff", () => {
  it("arms, expires, and climbs per key", () => {
    const backoff = createGithubReadBackoff();
    const at = 1_000_000;

    expect(backoff.isBackedOff("a", at)).toBe(false);
    expect(backoff.lastError("a", at)).toBeNull();

    const first = backoff.record("a", new Error("boom"), 0, at);
    expect(first).toEqual({ attempts: 1, cooldownMs: GITHUB_READ_FAILURE_BACKOFF_BASE_MS });
    expect(backoff.isBackedOff("a", at)).toBe(true);
    expect(backoff.isBackedOff("b", at)).toBe(false);

    const second = backoff.record("a", new Error("boom"), 0, at);
    expect(second.attempts).toBe(2);
    expect(second.cooldownMs).toBe(GITHUB_READ_FAILURE_BACKOFF_BASE_MS * 2);
  });

  it("ends the cooldown exactly at untilMs", () => {
    const backoff = createGithubReadBackoff();
    backoff.record("a", new Error("boom"), 0, 0);
    expect(backoff.isBackedOff("a", GITHUB_READ_FAILURE_BACKOFF_BASE_MS - 1)).toBe(true);
    expect(backoff.isBackedOff("a", GITHUB_READ_FAILURE_BACKOFF_BASE_MS)).toBe(false);
  });

  it("restarts the ladder for a key that expired before failing again", () => {
    const backoff = createGithubReadBackoff();
    backoff.record("a", new Error("boom"), 0, 0);
    // Reading past the cooldown drops the entry, so the next failure is a
    // first attempt rather than an inherited rung.
    expect(backoff.isBackedOff("a", GITHUB_READ_FAILURE_BACKOFF_BASE_MS + 1)).toBe(false);
    expect(backoff.record("a", new Error("boom"), 0, GITHUB_READ_FAILURE_BACKOFF_BASE_MS + 1).attempts)
      .toBe(1);
  });

  it("replays the recorded failure and normalizes a non-Error rejection", () => {
    const backoff = createGithubReadBackoff();
    const cause = new Error("rate limited");
    backoff.record("a", cause, 0, 0);
    expect(backoff.lastError("a", 0)).toBe(cause);

    backoff.record("b", "string rejection", 0, 0);
    const normalized = backoff.lastError("b", 0);
    expect(normalized).toBeInstanceOf(Error);
    expect(normalized?.message).toBe("string rejection");

    // A nullish rejection must still produce something to replay, or the
    // caller falls through and issues the request the ladder exists to stop.
    backoff.record("c", undefined, 0, 0);
    expect(backoff.lastError("c", 0)).toBeInstanceOf(Error);
  });

  it("clears one key or every key", () => {
    const backoff = createGithubReadBackoff();
    backoff.record("a", new Error("boom"), 60_000, 0);
    backoff.record("b", new Error("boom"), 60_000, 0);

    backoff.clear("a");
    expect(backoff.isBackedOff("a", 0)).toBe(false);
    expect(backoff.isBackedOff("b", 0)).toBe(true);

    backoff.clear();
    expect(backoff.isBackedOff("b", 0)).toBe(false);
  });

  it("sweeps entries nothing ever asks about again", () => {
    const backoff = createGithubReadBackoff();
    // A branch that failed and then had its lane archived is never re-checked,
    // so lazy expiry alone would keep its entry for the process lifetime.
    backoff.record("archived-lane", new Error("boom"), 0, 0);
    backoff.record("live", new Error("boom"), 0, GITHUB_READ_FAILURE_BACKOFF_BASE_MS + 1);
    // The sweep dropped the stale entry, so the next failure on that key starts
    // the ladder over rather than resuming at attempt 2.
    expect(backoff.record("archived-lane", new Error("boom"), 0, GITHUB_READ_FAILURE_BACKOFF_BASE_MS + 1).attempts)
      .toBe(1);
  });
});
