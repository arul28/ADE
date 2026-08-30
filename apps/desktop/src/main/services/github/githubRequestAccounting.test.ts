import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureGithubRequestAccounting,
  emitGithubRequestUsageSummary,
  githubRequestComponentForPath,
  githubRequestOutcomeForStatus,
  recordGithubRequestResponse,
  recordGithubRequestTransportFailure,
  resetGithubRequestAccounting,
  GITHUB_REQUEST_USAGE_SUMMARY_INTERVAL_MS,
} from "./githubRequestAccounting";

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    flushSync: vi.fn(),
  };
}

function record(args: {
  url: string;
  status: number;
  tokenSource?: "app" | "gh" | "pat" | "environment";
  headers?: Record<string, string>;
}): void {
  recordGithubRequestResponse({
    url: args.url,
    context: args.tokenSource ? { tokenSource: args.tokenSource } : null,
    status: args.status,
    headers: new Headers(args.headers ?? {}),
  });
}

function summaryMeta(logger: ReturnType<typeof makeLogger>): Record<string, unknown> {
  const call = logger.info.mock.calls.at(-1);
  expect(call?.[0]).toBe("github.request_usage_summary");
  return call?.[1] as Record<string, unknown>;
}

describe("githubRequestAccounting", () => {
  afterEach(() => {
    resetGithubRequestAccounting();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("classifies outcomes by status, keeping 304 apart from 2xx", () => {
    expect(githubRequestOutcomeForStatus(200)).toBe("2xx");
    expect(githubRequestOutcomeForStatus(304)).toBe("304");
    expect(githubRequestOutcomeForStatus(302)).toBe("3xx");
    expect(githubRequestOutcomeForStatus(404)).toBe("4xx_other");
    expect(githubRequestOutcomeForStatus(429)).toBe("4xx_rate_limit");
    expect(githubRequestOutcomeForStatus(502)).toBe("5xx");
  });

  it("reads a spent quota out of a 403's rate-limit headers", () => {
    expect(githubRequestOutcomeForStatus(403, new Headers({ "x-ratelimit-remaining": "0" })))
      .toBe("4xx_rate_limit");
    expect(githubRequestOutcomeForStatus(403, new Headers({ "retry-after": "60" })))
      .toBe("4xx_rate_limit");
    // A plain permission denial is not a quota problem.
    expect(githubRequestOutcomeForStatus(403, new Headers({ "x-ratelimit-remaining": "4900" })))
      .toBe("4xx_other");
  });

  it("derives a bounded component tag from the request path", () => {
    expect(githubRequestComponentForPath("/graphql")).toBe("graphql");
    expect(githubRequestComponentForPath("/rate_limit")).toBe("rate_limit");
    expect(githubRequestComponentForPath("/user")).toBe("user");
    expect(githubRequestComponentForPath("/search/issues")).toBe("search");
    expect(githubRequestComponentForPath("/repos/arul28/ADE")).toBe("repo");
    expect(githubRequestComponentForPath("/repos/arul28/ADE/pulls/17")).toBe("repo_pulls");
    expect(githubRequestComponentForPath("/repos/arul28/ADE/commits/abc/check-runs"))
      .toBe("repo_commits");
    // An unknown sub-resource must not widen the key space.
    expect(githubRequestComponentForPath("/repos/arul28/ADE/deployments")).toBe("repo_other");
  });

  it("counts every outcome class and reports them in one summary line", () => {
    const logger = makeLogger();
    configureGithubRequestAccounting(() => logger as never);

    record({ url: "https://api.github.com/repos/arul28/ADE/pulls", status: 200, tokenSource: "app" });
    record({ url: "https://api.github.com/repos/arul28/ADE/pulls", status: 200, tokenSource: "app" });
    record({ url: "https://api.github.com/repos/arul28/ADE/pulls", status: 304, tokenSource: "app" });
    record({ url: "https://api.github.com/graphql", status: 502, tokenSource: "gh" });
    record({
      url: "https://api.github.com/repos/arul28/ADE/issues",
      status: 403,
      tokenSource: "pat",
      headers: { "x-ratelimit-remaining": "0" },
    });
    record({ url: "https://api.github.com/user", status: 401, tokenSource: "pat" });
    recordGithubRequestTransportFailure({
      url: "https://api.github.com/repos/arul28/ADE",
      context: { tokenSource: "gh" },
    });

    emitGithubRequestUsageSummary("manual");

    const meta = summaryMeta(logger);
    expect(meta.windowTotal).toBe(7);
    expect(meta.cumulativeTotal).toBe(7);
    expect(meta.windowByOutcome).toEqual({
      "2xx": 2,
      "304": 1,
      "4xx_rate_limit": 1,
      "4xx_other": 1,
      "5xx": 1,
      transport_error: 1,
    });
    expect(meta.buckets).toContainEqual({
      component: "repo_pulls",
      tokenSource: "app",
      outcome: "2xx",
      count: 2,
    });
    expect(meta.buckets).toContainEqual({
      component: "repo_pulls",
      tokenSource: "app",
      outcome: "304",
      count: 1,
    });
    expect(meta.buckets).toContainEqual({
      component: "graphql",
      tokenSource: "gh",
      outcome: "5xx",
      count: 1,
    });
  });

  it("keeps cumulative totals while resetting the window after each summary", () => {
    const logger = makeLogger();
    configureGithubRequestAccounting(() => logger as never);

    record({ url: "https://api.github.com/repos/arul28/ADE/pulls", status: 200, tokenSource: "app" });
    emitGithubRequestUsageSummary("manual");
    expect(summaryMeta(logger).windowTotal).toBe(1);

    // An empty window says nothing and must not be written at all.
    emitGithubRequestUsageSummary("manual");
    expect(logger.info).toHaveBeenCalledTimes(1);

    record({ url: "https://api.github.com/repos/arul28/ADE/pulls", status: 304, tokenSource: "app" });
    emitGithubRequestUsageSummary("manual");
    const meta = summaryMeta(logger);
    expect(meta.windowTotal).toBe(1);
    expect(meta.cumulativeTotal).toBe(2);
    expect(meta.cumulativeByOutcome).toEqual({ "2xx": 1, "304": 1 });
  });

  it("reports the latest rate-limit reserve per token source without re-requesting it", () => {
    const logger = makeLogger();
    configureGithubRequestAccounting(() => logger as never);

    record({
      url: "https://api.github.com/repos/arul28/ADE/pulls",
      status: 200,
      tokenSource: "app",
      headers: {
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "4200",
        "x-ratelimit-reset": String(Math.floor(Date.parse("2026-08-29T13:00:00.000Z") / 1000)),
        "x-ratelimit-resource": "core",
      },
    });
    record({
      url: "https://api.github.com/repos/arul28/ADE/pulls",
      status: 200,
      tokenSource: "app",
      headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4199" },
    });

    emitGithubRequestUsageSummary("manual");

    const rateLimits = summaryMeta(logger).rateLimits as Record<string, { remaining: number }>;
    expect(rateLimits.app?.remaining).toBe(4199);
  });

  it("emits a summary every ten minutes once configured", async () => {
    vi.useFakeTimers();
    const logger = makeLogger();
    configureGithubRequestAccounting(() => logger as never);

    record({ url: "https://api.github.com/repos/arul28/ADE/pulls", status: 200, tokenSource: "app" });
    await vi.advanceTimersByTimeAsync(GITHUB_REQUEST_USAGE_SUMMARY_INTERVAL_MS - 1);
    expect(logger.info).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(summaryMeta(logger)).toEqual(expect.objectContaining({
      reason: "interval",
      windowTotal: 1,
    }));

    // An idle window stays silent instead of writing a line of zeroes forever.
    await vi.advanceTimersByTimeAsync(GITHUB_REQUEST_USAGE_SUMMARY_INTERVAL_MS);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("records nothing before a sink is bound and never throws", () => {
    expect(() => record({ url: "not a url", status: 200 })).not.toThrow();
    expect(() => emitGithubRequestUsageSummary("manual")).not.toThrow();
  });

  it("opens the machine sink only when there is something to write", () => {
    const logger = makeLogger();
    const resolve = vi.fn(() => logger as never);
    configureGithubRequestAccounting(resolve);

    emitGithubRequestUsageSummary("manual");
    expect(resolve).not.toHaveBeenCalled();

    record({ url: "https://api.github.com/repos/arul28/ADE/pulls", status: 200, tokenSource: "app" });
    emitGithubRequestUsageSummary("manual");
    expect(resolve).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledOnce();
  });

  it("clamps a caller-supplied component tag so the key space stays bounded", () => {
    const logger = makeLogger();
    configureGithubRequestAccounting(() => logger as never);

    recordGithubRequestResponse({
      url: "https://api.github.com/repos/arul28/ADE/pulls",
      context: { component: "pr_poller", tokenSource: "app" },
      status: 200,
      headers: new Headers(),
    });
    for (const rejected of [
      "/Users/arul/ADE/apps/desktop",
      "PR Poller",
      "poller-v2",
      "x".repeat(41),
    ]) {
      recordGithubRequestResponse({
        url: "https://api.github.com/repos/arul28/ADE/pulls",
        context: { component: rejected, tokenSource: "app" },
        status: 200,
        headers: new Headers(),
      });
    }

    emitGithubRequestUsageSummary("manual");

    const buckets = summaryMeta(logger).buckets as Array<{ component: string; count: number }>;
    expect(buckets).toContainEqual(expect.objectContaining({ component: "pr_poller", count: 1 }));
    // All four rejected tags collapse into one bucket instead of four.
    expect(buckets).toContainEqual(expect.objectContaining({ component: "unknown", count: 4 }));
    expect(buckets).toHaveLength(2);
  });
});
