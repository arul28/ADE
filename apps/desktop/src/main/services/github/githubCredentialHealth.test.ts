import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubAuthFailure } from "../../../shared/types";
import {
  clearGithubCredentialHealth,
  githubBackgroundRequestPauseUntilMs,
  githubCredentialCooldown,
  recordGithubCredentialFailure,
  recordGithubCredentialSuccess,
  registerGithubCredentialIdentity,
  type GithubCredentialCandidate,
} from "./githubCredentialHealth";

const appCandidate: GithubCredentialCandidate = {
  source: "app",
  token: "ghu_app_token",
  capabilities: ["read"],
  userLogin: "alice",
};

const ghCandidate: GithubCredentialCandidate = {
  source: "gh",
  token: "gho_cli_token",
  capabilities: ["read", "write"],
  userLogin: "alice",
};

describe("githubCredentialHealth", () => {
  beforeEach(() => clearGithubCredentialHealth());

  afterEach(() => {
    vi.useRealTimers();
    clearGithubCredentialHealth();
  });

  it("coordinates shared cooldowns, background reserve, and manual recovery", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));
    registerGithubCredentialIdentity(appCandidate, "alice");
    registerGithubCredentialIdentity(ghCandidate, "alice");
    const retryAt = "2026-08-01T13:00:00.000Z";
    const failure: GitHubAuthFailure = {
      kind: "rate_limited",
      message: "API rate limit exceeded",
      retryAt,
    };

    recordGithubCredentialFailure(appCandidate, failure, {
      limit: 5000,
      remaining: 0,
      used: 5000,
      resetAt: retryAt,
      resource: "core",
    });

    expect(githubCredentialCooldown(appCandidate)?.failure.kind).toBe("rate_limited");
    expect(githubCredentialCooldown(ghCandidate)?.failure.kind).toBe("rate_limited");

    vi.setSystemTime(new Date("2026-08-01T13:00:01.000Z"));
    expect(githubCredentialCooldown(appCandidate)).toBeNull();
    expect(githubCredentialCooldown(ghCandidate)).toBeNull();

    clearGithubCredentialHealth();
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));
    const reserveResetAt = "2026-08-01T13:00:00.000Z";

    recordGithubCredentialSuccess(ghCandidate, new Headers({
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "500",
      "x-ratelimit-used": "4500",
      "x-ratelimit-reset": String(Date.parse(reserveResetAt) / 1_000),
      "x-ratelimit-resource": "core",
    }));

    expect(githubBackgroundRequestPauseUntilMs()).toBe(Date.parse(reserveResetAt));

    recordGithubCredentialSuccess(ghCandidate, new Headers({
      "x-ratelimit-limit": "30",
      "x-ratelimit-remaining": "30",
      "x-ratelimit-reset": String(Date.parse(reserveResetAt) / 1_000),
      "x-ratelimit-resource": "search",
    }));
    expect(githubBackgroundRequestPauseUntilMs()).toBe(Date.parse(reserveResetAt));

    recordGithubCredentialFailure(ghCandidate, failure, {
      limit: 30,
      remaining: 0,
      used: 30,
      resetAt: retryAt,
      resource: "search",
    });
    expect(githubCredentialCooldown(ghCandidate, Date.now(), { resource: "search" }))
      .not.toBeNull();
    expect(githubCredentialCooldown(ghCandidate, Date.now(), { resource: "core" }))
      .toBeNull();

    const otherCandidate: GithubCredentialCandidate = {
      source: "pat",
      token: "ghp_other_account",
      capabilities: ["read", "write"],
      userLogin: "bob",
    };
    recordGithubCredentialSuccess(otherCandidate, new Headers({
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "100",
      "x-ratelimit-reset": String(Date.parse(reserveResetAt) / 1_000),
      "x-ratelimit-resource": "core",
    }));

    expect(githubBackgroundRequestPauseUntilMs(Date.now(), [ghCandidate]))
      .toBe(Date.parse(reserveResetAt));
    expect(githubBackgroundRequestPauseUntilMs(Date.now(), [otherCandidate]))
      .toBe(Math.floor(Date.parse(reserveResetAt) / 1_000) * 1_000);

    clearGithubCredentialHealth();
    recordGithubCredentialSuccess(otherCandidate, new Headers({
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "100",
      "x-ratelimit-reset": String(Date.parse(reserveResetAt) / 1_000),
      "x-ratelimit-resource": "core",
    }));
    expect(githubBackgroundRequestPauseUntilMs(Date.now(), [ghCandidate])).toBeNull();

    clearGithubCredentialHealth();
    recordGithubCredentialFailure(appCandidate, {
      kind: "permission_denied",
      message: "Resource not accessible",
      retryAt: null,
    }, null);
    expect(githubCredentialCooldown(appCandidate)).not.toBeNull();
    expect(githubCredentialCooldown(appCandidate, Date.now(), { ignoreNonRateLimit: true }))
      .toBeNull();

    recordGithubCredentialFailure(appCandidate, {
      kind: "rate_limited",
      message: "API rate limit exceeded",
      retryAt: new Date(Date.now() + 60_000).toISOString(),
    }, {
      limit: 5000,
      remaining: 0,
      used: 5000,
      resetAt: new Date(Date.now() + 60_000).toISOString(),
      resource: "core",
    });
    expect(githubCredentialCooldown(appCandidate, Date.now(), { ignoreNonRateLimit: true })
      ?.failure.kind).toBe("rate_limited");
  });
});
