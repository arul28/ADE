import { describe, expect, it } from "vitest";
import type { GitHubAppInstallationStatus, GitHubStatus } from "../../shared/types";
import {
  deriveGithubRepoConnectionState,
  describeGithubAuthFailure,
  describeGithubCliBanner,
  githubCredentialPresentation,
  isGithubRateLimitMessage,
  isGithubRepoAccessPending,
} from "./githubIntegrationStatus";

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

function makeCliStatus(overrides: Partial<GitHubStatus> = {}): GitHubStatus {
  return {
    tokenStored: true,
    patTokenStored: false,
    tokenDecryptionFailed: false,
    storageScope: "app",
    authSource: "gh",
    tokenType: "oauth",
    repo: { owner: "arul28", name: "ADE" },
    hasOrigin: true,
    userLogin: null,
    scopes: [],
    ghCliPath: "/opt/homebrew/bin/gh",
    ghAuthError: null,
    checkedAt: "2026-07-27T18:40:32.503Z",
    repoAccessOk: null,
    repoAccessError: null,
    connected: false,
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

describe("describeGithubCliBanner", () => {
  it("does not tell a signed-in rate-limited user to reconnect", () => {
    const banner = describeGithubCliBanner(makeCliStatus({
      authFailure: {
        kind: "rate_limited",
        message: "API rate limit exceeded.",
        retryAt: "2026-07-27T19:10:33.000Z",
      },
    }));

    expect(banner.title).toBe("GitHub requests are temporarily paused");
    expect(banner.detail).toContain("will resume automatically");
    expect(banner.action).toBe("View GitHub status");
    expect(banner.subState).toContain("rate-limited");
  });

  it("distinguishes an invalid token from missing scopes", () => {
    const banner = describeGithubCliBanner(makeCliStatus({
      authFailure: {
        kind: "invalid_token",
        message: "Bad credentials",
        retryAt: null,
      },
    }));

    expect(banner.title).toBe("GitHub authentication was rejected");
    expect(banner.action).toBe("Reconnect GitHub");
  });

  it("uses missing-permissions copy only after GitHub validated the user", () => {
    const banner = describeGithubCliBanner(makeCliStatus({
      userLogin: "arul28",
      scopes: ["repo"],
    }));

    expect(banner.title).toBe("GitHub token is missing permissions");
    expect(banner.action).toBe("Fix GitHub auth");
  });

  it("keeps raw validation errors in Settings without leaking them into the banner", () => {
    const copy = describeGithubAuthFailure(makeCliStatus({
      authFailure: {
        kind: "unknown",
        message: "GitHub returned an unexpected enterprise policy response.",
        retryAt: null,
      },
    }));

    expect(copy?.detail).toContain("Open Settings for the exact error");
    expect(copy?.settingsDetail).toBe("GitHub returned an unexpected enterprise policy response.");
  });
});

describe("githubCredentialPresentation", () => {
  it("treats GitHub App authorization as installation permissions, not OAuth scopes", () => {
    const presentation = githubCredentialPresentation(makeCliStatus({
      authSource: "app",
      tokenType: "oauth",
      userLogin: "arul28",
      repoAccessOk: true,
      scopes: [],
      connected: true,
    }));

    expect(presentation).toEqual({
      tokenTypeLabel: "GitHub App user token",
      permissionMode: "app",
      permissionHeading: "APP PERMISSIONS",
      hasInspectableScopes: false,
      repoAccessLabel: "Repository metadata access verified",
    });
  });

  it("keeps classic and fine-grained token permission displays distinct", () => {
    expect(githubCredentialPresentation(makeCliStatus({
      tokenType: "classic",
      scopes: ["repo", "workflow"],
    }))).toEqual({
      tokenTypeLabel: "Classic PAT",
      permissionMode: "scopes",
      permissionHeading: "DETECTED SCOPES",
      hasInspectableScopes: true,
      repoAccessLabel: "Repository access not checked",
    });
    expect(githubCredentialPresentation(makeCliStatus({
      tokenType: "fine-grained",
      scopes: [],
    }))).toEqual({
      tokenTypeLabel: "Fine-grained PAT",
      permissionMode: "fine-grained",
      permissionHeading: "TOKEN PERMISSIONS",
      hasInspectableScopes: false,
      repoAccessLabel: "Repository access not checked",
    });
  });

  it("makes authentication failure the single highest-priority permission mode", () => {
    expect(githubCredentialPresentation(makeCliStatus({
      authSource: "app",
      authFailure: {
        kind: "network",
        message: "offline",
        retryAt: null,
      },
    }))).toMatchObject({
      permissionMode: "auth-failure",
      permissionHeading: "AUTHENTICATION CHECK",
      hasInspectableScopes: false,
    });
  });
});

describe("isGithubRateLimitMessage", () => {
  it("recognizes primary and secondary GitHub throttling without treating ordinary errors as limits", () => {
    expect(isGithubRateLimitMessage("API rate limit exceeded for user ID 123.")).toBe(true);
    expect(isGithubRateLimitMessage("You have exceeded a secondary rate limit.")).toBe(true);
    expect(isGithubRateLimitMessage("Bad credentials")).toBe(false);
    expect(isGithubRateLimitMessage(null)).toBe(false);
  });
});
