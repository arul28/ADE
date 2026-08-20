import { describe, expect, it } from "vitest";
import { parseLedger } from "./githubAppUserAuthLedger";

/**
 * The credential file is written by peer ADE processes and by older versions of
 * ADE, so nothing in it is guaranteed to match the current shape. `kind` above
 * all: it travels on to the renderer as
 * `GitHubAppUserAuthStatus.lastRefreshError.kind`.
 */
describe("parseLedger failure kinds", () => {
  const failure = (kind: unknown): Record<string, unknown> => ({
    lastFailure: {
      kind,
      message: "GitHub refused the renewal.",
      at: "2026-08-20T12:00:00.000Z",
    },
  });

  it("keeps a kind this version knows", () => {
    expect(parseLedger(failure("rate_limited")).lastFailure?.kind).toBe("rate_limited");
  });

  it("reads a kind this version does not know as unknown", () => {
    expect(parseLedger(failure("teapot")).lastFailure?.kind).toBe("unknown");
  });

  it("keeps the failure itself when the kind is unrecognized", () => {
    // Narrowing the kind must not throw the failure away: the record still says
    // a refresh failed, and every surface that reports one reads this.
    expect(parseLedger(failure("teapot")).lastFailure?.message)
      .toBe("GitHub refused the renewal.");
  });

  it("reports no failure at all when the kind is absent", () => {
    expect(parseLedger(failure(null)).lastFailure).toBeNull();
    expect(parseLedger(failure("  ")).lastFailure).toBeNull();
  });
});
