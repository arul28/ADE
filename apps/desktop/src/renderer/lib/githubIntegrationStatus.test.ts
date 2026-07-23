import { describe, expect, it } from "vitest";
import type { GitHubAppInstallationStatus } from "../../shared/types";
import { deriveGithubRepoConnectionState, isGithubRepoAccessPending } from "./githubIntegrationStatus";

function makeStatus(overrides: Partial<GitHubAppInstallationStatus> = {}): GitHubAppInstallationStatus {
  return {
    repo: { owner: "arul28", name: "ADE" },
    appName: "ADE",
    appSlug: "ade-for-github",
    installUrl: "https://github.com/apps/ade-for-github/installations/new",
    manageUrl: "https://github.com/settings/installations",
    relayConfigured: true,
    installed: false,
    state: "error",
    installationId: null,
    repositorySelection: null,
    lastSeenAt: null,
    webhookEvents: [],
    missingWebhookEvents: [],
    webhookState: "unknown",
    webhookLastSeenAt: null,
    checkedAt: "2026-07-02T18:39:42.000Z",
    error: "Not Found",
    ...overrides,
  };
}

describe("isGithubRepoAccessPending", () => {
  it("treats post-authorization GitHub repo 404s as pending repo access", () => {
    expect(isGithubRepoAccessPending(makeStatus())).toBe(true);
  });

  it("keeps non-propagation relay failures out of pending repo access", () => {
    expect(isGithubRepoAccessPending(makeStatus({ error: "GitHub App relay status check failed (500)" }))).toBe(false);
  });

  it("detects repository-not-found error variants as pending repo access", () => {
    expect(isGithubRepoAccessPending(makeStatus({ error: "Repository not found." }))).toBe(true);
    expect(isGithubRepoAccessPending(makeStatus({ error: "Could not resolve to a Repository." }))).toBe(true);
  });

  it("ignores repo access errors when status guards do not match", () => {
    expect(isGithubRepoAccessPending(makeStatus({ relayConfigured: false }))).toBe(false);
    expect(isGithubRepoAccessPending(makeStatus({ installed: true }))).toBe(false);
    expect(isGithubRepoAccessPending(makeStatus({ state: "not_installed" }))).toBe(false);
  });
});

describe("deriveGithubRepoConnectionState", () => {
  const installed = (overrides: Partial<GitHubAppInstallationStatus> = {}) =>
    makeStatus({
      installed: true,
      state: "configured",
      relayConfigured: true,
      webhookState: "active",
      error: null,
      ...overrides,
    });

  it("is connected only when installed, relay is configured, and the webhook isn't deleted", () => {
    expect(deriveGithubRepoConnectionState(installed())).toBe("connected");
    // webhookState "unknown" is not "deleted", so it still counts as connected.
    expect(deriveGithubRepoConnectionState(installed({ webhookState: "unknown" }))).toBe("connected");
  });

  it("reports webhook_off when installed but the webhook was deleted", () => {
    expect(deriveGithubRepoConnectionState(installed({ webhookState: "deleted" }))).toBe("webhook_off");
  });

  it("reports webhook_off when installed but the relay isn't configured", () => {
    expect(deriveGithubRepoConnectionState(installed({ relayConfigured: false }))).toBe("webhook_off");
  });

  it("still surfaces the pre-install states", () => {
    expect(deriveGithubRepoConnectionState(null)).toBe("unknown");
    expect(deriveGithubRepoConnectionState(makeStatus({ repo: null }))).toBe("no_repo");
    expect(
      deriveGithubRepoConnectionState(makeStatus({ installed: false, state: "not_installed", error: null })),
    ).toBe("not_installed");
  });
});
