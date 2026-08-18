import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubAuthFailure } from "../../../shared/types";
import {
  clearGithubCredentialHealth,
  githubBackgroundRequestPauseUntilMs,
  githubCredentialCooldown,
  githubCredentialNonRateLimitCooldown,
  githubCredentialRateLimitCooldown,
  recordGithubCredentialFailure,
  recordGithubOperationFailure,
  recordGithubCredentialSuccess,
  registerGithubCredentialIdentity,
  githubRequestBudget,
  GITHUB_BACKGROUND_RATE_LIMIT_RESERVE,
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
    expect(githubCredentialRateLimitCooldown(appCandidate, Date.now()))
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
    expect(githubCredentialRateLimitCooldown(appCandidate, Date.now())
      ?.failure.kind).toBe("rate_limited");
  });

  it("keeps permission-denied cooldowns resource-scoped", () => {
    const permissionDenied = {
      kind: "permission_denied",
      message: "Resource protected by organization policy",
      retryAt: null,
    } as const;
    recordGithubCredentialFailure(appCandidate, permissionDenied, {
      limit: 5000,
      remaining: 4999,
      used: 1,
      resetAt: null,
      resource: "graphql",
    });

    expect(githubCredentialCooldown(appCandidate, Date.now(), { resource: "graphql" }))
      .not.toBeNull();
    expect(githubCredentialCooldown(appCandidate, Date.now(), { resource: "core" })).toBeNull();

    clearGithubCredentialHealth();
    recordGithubOperationFailure(appCandidate, permissionDenied, null);
    expect(githubCredentialCooldown(appCandidate)).toBeNull();
  });

  describe("githubRequestBudget", () => {
    // The budget is what lets a *foreground* poller honour the same reserve the
    // background PR poller already respects. Before it existed the reserve was
    // enforced in exactly one place, so the renderer's 5s checks loop drained
    // the quota to zero while a 500-request reserve nominally protected it.
    const RESET_AT = "2026-08-17T13:00:00.000Z";

    function recordCoreQuota(remaining: number): void {
      recordGithubCredentialSuccess(ghCandidate, new Headers({
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": String(remaining),
        "x-ratelimit-used": String(5000 - remaining),
        "x-ratelimit-reset": String(Date.parse(RESET_AT) / 1_000),
        "x-ratelimit-resource": "core",
      }));
    }

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-17T12:00:00.000Z"));
    });

    it("gates automatic requests once the core quota reaches the reserve", () => {
      recordCoreQuota(GITHUB_BACKGROUND_RATE_LIMIT_RESERVE);
      expect(githubRequestBudget(Date.now(), [ghCandidate]).pausedUntil)
        .toBe(new Date(Date.parse(RESET_AT)).toISOString());
    });

    it("answers from every known credential when given none, without a network or subprocess call", () => {
      // The unscoped form is what the IPC action calls. Resolving a credential
      // inventory to scope it is NOT free — it can shell out to `gh auth token`,
      // decrypt the credential store, or refresh an App user token over the
      // network — and this read runs on a timer and on every failed poll group.
      recordCoreQuota(GITHUB_BACKGROUND_RATE_LIMIT_RESERVE);
      expect(githubRequestBudget().pausedUntil)
        .toBe(new Date(Date.parse(RESET_AT)).toISOString());
    });

    it("leaves automatic requests running while quota is above the reserve", () => {
      recordCoreQuota(GITHUB_BACKGROUND_RATE_LIMIT_RESERVE + 1);
      expect(githubRequestBudget(Date.now(), [ghCandidate]).pausedUntil).toBeNull();
    });

    it("reports a GitHub outage as a typed kind without parking the credential", () => {
      // `service_unavailable` deliberately carries no cooldown — a 5xx is not
      // the credential's fault — but the kind still has to reach the caller, or
      // an outage looks identical to a healthy GitHub that returned nothing.
      recordGithubOperationFailure(ghCandidate, {
        kind: "service_unavailable",
        message: "No server is currently available to service your request.",
        retryAt: null,
      }, {
        limit: 5000,
        remaining: 4321,
        used: 679,
        resetAt: RESET_AT,
        resource: "core",
      });

      const budget = githubRequestBudget(Date.now(), [ghCandidate]);
      expect(budget.failureKind).toBe("service_unavailable");
      expect(budget.pausedUntil).toBeNull();
      expect(githubCredentialCooldown(ghCandidate)).toBeNull();
    });

    it("reports the failure asking for the longest stand-down", () => {
      recordGithubOperationFailure(appCandidate, {
        kind: "permission_denied",
        message: "Resource not accessible",
        retryAt: null,
      }, { limit: 5000, remaining: 4000, used: 1000, resetAt: null, resource: "core" });
      recordGithubOperationFailure(ghCandidate, {
        kind: "rate_limited",
        message: "API rate limit exceeded",
        retryAt: RESET_AT,
      }, { limit: 5000, remaining: 0, used: 5000, resetAt: RESET_AT, resource: "core" });

      const budget = githubRequestBudget(Date.now(), [appCandidate, ghCandidate]);
      expect(budget.failureKind).toBe("rate_limited");
      expect(budget.retryAt).toBe(RESET_AT);
    });

    it("ignores the search bucket, which PR reads do not spend", () => {
      recordGithubCredentialSuccess(ghCandidate, new Headers({
        "x-ratelimit-limit": "30",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Date.parse(RESET_AT) / 1_000),
        "x-ratelimit-resource": "search",
      }));
      expect(githubRequestBudget(Date.now(), [ghCandidate]).pausedUntil).toBeNull();
    });

    it("ranks a credential-scoped failure above a local network fault", () => {
      // The severity order is a contract with `ladderBaseMs` in
      // `renderer/components/prs/state/githubPollGovernor.ts`: it must report
      // the kind that asks for the LONGER stand-down. `network` outranking
      // `invalid_token` here would have handed the governor the 30s base when
      // the other credential warranted 60s.
      recordGithubOperationFailure(appCandidate, {
        kind: "invalid_token",
        message: "Bad credentials",
        retryAt: null,
      }, { limit: 5000, remaining: 4000, used: 1000, resetAt: null, resource: "core" });
      recordGithubOperationFailure(ghCandidate, {
        kind: "network",
        message: "fetch failed",
        retryAt: null,
      }, { limit: 5000, remaining: 3000, used: 2000, resetAt: null, resource: "core" });

      expect(githubRequestBudget(Date.now(), [appCandidate, ghCandidate]).failureKind)
        .toBe("invalid_token");
    });

    it("clears the reported failure once GitHub answers again", () => {
      recordGithubOperationFailure(ghCandidate, {
        kind: "service_unavailable",
        message: "Bad gateway",
        retryAt: null,
      }, { limit: 5000, remaining: 4321, used: 679, resetAt: RESET_AT, resource: "core" });
      expect(githubRequestBudget(Date.now(), [ghCandidate]).failureKind)
        .toBe("service_unavailable");

      recordCoreQuota(4320);
      expect(githubRequestBudget(Date.now(), [ghCandidate]).failureKind).toBeNull();
    });

    it("reports a failure that arrived without any rate-limit headers", () => {
      // The failures that matter most here — a hung request, a DNS failure, an
      // edge 5xx — carry no `x-ratelimit-*` at all, so they land under the
      // `unknown` resource with no limit. Filtering the kind scan by the quota
      // bucket dropped exactly those, which left the classified ladder inert
      // for the outage shape it was written for: the governor saw no kind and
      // held a flat short rung instead of climbing to its ceiling.
      recordGithubOperationFailure(ghCandidate, {
        kind: "network",
        message: "GitHub API request timed out. Check network access on this machine.",
        retryAt: null,
      }, null);

      expect(githubRequestBudget(Date.now(), [ghCandidate]).failureKind).toBe("network");
      // ...and it must still not park the credential a user action needs.
      expect(githubCredentialCooldown(ghCandidate)).toBeNull();
    });

    it("still ignores the search bucket for the reported kind", () => {
      recordGithubOperationFailure(ghCandidate, {
        kind: "rate_limited",
        message: "API rate limit exceeded",
        retryAt: RESET_AT,
      }, { limit: 30, remaining: 0, used: 30, resetAt: RESET_AT, resource: "search" });

      expect(githubRequestBudget(Date.now(), [ghCandidate]).failureKind).toBeNull();
    });

    it("does not let a transport blip un-park a credential already on cooldown", () => {
      // Kinds differ in how long they park a credential and share one resource
      // entry, so overwriting unconditionally let a `network` failure (which
      // deliberately gets no cooldown) clear the five minutes a rejected token
      // had just earned — sending the next request straight back at it.
      recordGithubOperationFailure(ghCandidate, {
        kind: "invalid_token",
        message: "Bad credentials",
        retryAt: null,
      }, null);
      expect(githubCredentialCooldown(ghCandidate)?.failure.kind).toBe("invalid_token");

      recordGithubOperationFailure(ghCandidate, {
        kind: "network",
        message: "fetch failed",
        retryAt: null,
      }, null);
      // The deadline AND the reason survive together. Keeping the park but
      // relabelling it "network" would report a rejected token as a GitHub
      // problem — exactly the misattribution that hides the reconnect the user
      // actually needs.
      expect(githubCredentialCooldown(ghCandidate)?.failure.kind).toBe("invalid_token");
    });

    it("stops reporting a failure kind once it is no longer recent", () => {
      // A failure is otherwise cleared only by a success on the SAME credential
      // and resource, so a permanently-bad one (revoked PAT, stale
      // GITHUB_TOKEN) would keep its kind for the life of the process while
      // ADE served every request from the next credential — and, read
      // unscoped, would push every project's poll ladder onto the longer base
      // on a perfectly healthy GitHub.
      recordGithubOperationFailure(ghCandidate, {
        kind: "invalid_token",
        message: "Bad credentials",
        retryAt: null,
      }, { limit: 5000, remaining: 4000, used: 1000, resetAt: null, resource: "core" });
      expect(githubRequestBudget(Date.now(), [ghCandidate]).failureKind).toBe("invalid_token");

      vi.setSystemTime(new Date(Date.now() + 10 * 60_000));
      expect(githubRequestBudget(Date.now(), [ghCandidate]).failureKind).toBeNull();
    });

    it("answers with an unknown budget when nothing has been recorded", () => {
      expect(githubRequestBudget(Date.now(), [ghCandidate])).toEqual({
        pausedUntil: null,
        failureKind: null,
        retryAt: null,
      });
    });
  });

  it.each(["graphql", "search"])(
    "applies an invalid-token cooldown recorded for %s to every API resource",
    (resource) => {
      recordGithubOperationFailure(ghCandidate, {
        kind: "invalid_token",
        message: "Bad credentials",
        retryAt: null,
      }, {
        limit: resource === "search" ? 30 : 5000,
        remaining: 1,
        used: resource === "search" ? 29 : 4999,
        resetAt: null,
        resource,
      });

      expect(githubCredentialCooldown(ghCandidate, Date.now(), { resource: "core" })
        ?.failure.kind).toBe("invalid_token");
      expect(githubCredentialNonRateLimitCooldown(ghCandidate, Date.now(), { resource: "core" })
        ?.failure.kind).toBe("invalid_token");
      expect(githubCredentialRateLimitCooldown(ghCandidate, Date.now(), { resource: "core" }))
        .toBeNull();
    },
  );
});
