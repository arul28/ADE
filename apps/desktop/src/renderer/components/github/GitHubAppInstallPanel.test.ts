import { describe, expect, it } from "vitest";
import type { GitHubAppInstallationStatus } from "../../../shared/types";
import { isGitHubAppRepoAccessPending, statusView } from "./GitHubAppInstallPanel";

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

describe("GitHubAppInstallPanel status helpers", () => {
  it("treats post-authorization GitHub repo 404s as pending repo access", () => {
    const status = makeStatus();
    const view = statusView(status, false, true);

    expect(isGitHubAppRepoAccessPending(status)).toBe(true);
    expect(view.label).toBe("Checking access");
    expect(view.description("arul28/ADE")).toContain("GitHub accepted authorization");
    expect(view.description("arul28/ADE")).toContain("select this repo in GitHub");
  });

  it("keeps non-propagation relay failures as check failures after authorization", () => {
    const status = makeStatus({ error: "GitHub App relay status check failed (500)" });
    const view = statusView(status, false, true);

    expect(isGitHubAppRepoAccessPending(status)).toBe(false);
    expect(view.label).toBe("Check failed");
    expect(view.description("arul28/ADE")).toBe("GitHub App relay status check failed (500)");
  });

  it("detects repository-not-found error variants as pending repo access", () => {
    expect(isGitHubAppRepoAccessPending(makeStatus({ error: "Repository not found." }))).toBe(true);
    expect(isGitHubAppRepoAccessPending(makeStatus({ error: "Could not resolve to a Repository." }))).toBe(true);
  });

  it("ignores repo access errors when status guards do not match", () => {
    expect(isGitHubAppRepoAccessPending(makeStatus({ relayConfigured: false }))).toBe(false);
    expect(isGitHubAppRepoAccessPending(makeStatus({ installed: true }))).toBe(false);
    expect(isGitHubAppRepoAccessPending(makeStatus({ state: "not_installed" }))).toBe(false);
  });
});
