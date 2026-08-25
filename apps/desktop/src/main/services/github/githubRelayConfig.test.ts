import { describe, expect, it, vi } from "vitest";
import type { GitHubAppUserAuthUnavailable } from "../../../shared/types";
import { GITHUB_APP_USER_AUTH_RENEWING_COPY } from "../../../shared/types";
import { fetchGitHubAppInstallationStatus } from "./githubRelayConfig";

const REPO = { owner: "acme", name: "ade" };

function unavailable(
  patch: Partial<GitHubAppUserAuthUnavailable> = {},
): GitHubAppUserAuthUnavailable {
  return {
    message: "GitHub paused ADE's authorization renewal. ADE retries on its own.",
    credentialState: "blocked",
    retryAt: null,
    failureKind: "rate_limited",
    ...patch,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as Response;
}

describe("fetchGitHubAppInstallationStatus account failures", () => {
  it("carries the account failure as a typed field, not only as wording", async () => {
    const failure = unavailable();

    const status = await fetchGitHubAppInstallationStatus({
      repo: REPO,
      appUserAuthFailure: failure,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    expect(status.appUserAuthFailure).toEqual(failure);
    expect(status.state).toBe("error");
  });

  // A peer process holding the refresh lease blocks the credential with nothing
  // recorded against it. Saying GitHub paused anything there is an accusation
  // ADE has no evidence for, and it sends the user to look at GitHub's status
  // page over a wait that ends in a second.
  it("says ADE is renewing when the block carries no GitHub failure", async () => {
    const status = await fetchGitHubAppInstallationStatus({
      repo: REPO,
      appUserAuthFailure: unavailable({ failureKind: null }),
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    expect(status.error).toBe(GITHUB_APP_USER_AUTH_RENEWING_COPY);
    expect(status.error).not.toMatch(/github paused/i);
  });

  it("still blames GitHub when GitHub is what refused the renewal", async () => {
    const status = await fetchGitHubAppInstallationStatus({
      repo: REPO,
      appUserAuthFailure: unavailable({ failureKind: "rate_limited" }),
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    expect(status.error).toContain("Waiting on GitHub authorization");
  });

  it("carries the account failure through the relay's own 401", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: "GitHub auth token is required" }));

    const status = await fetchGitHubAppInstallationStatus({
      repo: REPO,
      githubAppUserToken: "ghu_stale_but_present",
      appUserAuthFailure: unavailable(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(status.appUserAuthFailure).not.toBeNull();
    expect(status.error).toContain("Waiting on GitHub authorization");
  });

  // Any other status was answered with a credential the relay accepted, so it
  // says something about the repository — and reporting it as an account
  // problem would hide a real install failure behind a wait.
  it("leaves the account field null when the relay answered with a repo failure", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: "relay exploded" }));

    const status = await fetchGitHubAppInstallationStatus({
      repo: REPO,
      githubAppUserToken: "ghu_live",
      appUserAuthFailure: unavailable(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(status.appUserAuthFailure).toBeNull();
    expect(status.error).toBe("relay exploded");
  });
});
