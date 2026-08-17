import { describe, expect, it } from "vitest";
import type { GitHubAppInstallationStatus, GitHubStatus } from "../../shared/types";
import {
  deriveGithubRepoConnectionState,
  describeGithubAuthFailure,
  describeGithubCliBanner,
  describeGithubOutage,
  describeGithubPatVerification,
  githubCredentialPresentation,
  githubStatusHasUsablePat,
  isGithubRateLimitMessage,
  isGithubRepoAccessPending,
} from "./githubIntegrationStatus";
import { deriveGitHubServiceHealth } from "../../shared/githubServiceHealth";

function outageHealth(components = [{ id: "brv1bkgrwx7q", name: "API Requests", status: "major_outage" }]) {
  return deriveGitHubServiceHealth(
    {
      status: { indicator: "major", description: "Partial System Outage" },
      components,
      incidents: [{ name: "Incident with GitHub.com", shortlink: "https://stspg.io/x", resolved_at: null }],
    },
  )!;
}

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

  it("treats an omitted write source as no write credential for App-only status", () => {
    const banner = describeGithubCliBanner(makeCliStatus({
      authSource: "app",
      writeAuthSource: undefined,
      connected: true,
    }));

    expect(banner.subState).toBe("no-write-credential");
    expect(banner.title).toBe("GitHub write access isn't connected");
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

describe("githubStatusHasUsablePat", () => {
  it("requires the saved PAT itself to be ready for writes", () => {
    expect(githubStatusHasUsablePat({
      ...makeCliStatus({ authSource: "app", writeAuthSource: "gh", connected: true }),
      credentialVerification: {
        source: "pat",
        capabilities: ["read", "write"],
        userLogin: "octocat",
        failure: null,
        rateLimit: null,
      },
    })).toBe(true);

    expect(githubStatusHasUsablePat({
      ...makeCliStatus({ authSource: "app", writeAuthSource: "gh", connected: true }),
      credentialVerification: {
        source: "pat",
        capabilities: [],
        userLogin: null,
        failure: {
          kind: "invalid_token",
          message: "Bad credentials",
          retryAt: null,
        },
        rateLimit: null,
      },
    })).toBe(false);
  });

  it.each([
    ["invalid_token", "authentication failed"],
    ["rate_limited", "temporarily paused verification"],
    ["permission_denied", "cannot use it for write actions"],
    ["network", "could not reach GitHub"],
    ["unknown", "could not verify it for GitHub write actions"],
  ] as const)("uses clear shared copy for %s failures", (kind, message) => {
    const result = {
      ...makeCliStatus({ repo: { owner: "acme", name: "ade" } }),
      credentialVerification: {
        source: "pat" as const,
        capabilities: [],
        userLogin: null,
        failure: { kind, message: "backend detail", retryAt: null },
        rateLimit: null,
      },
    };

    expect(describeGithubPatVerification(result)).toMatchObject({
      verified: false,
      message: expect.stringContaining(message),
    });
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

describe("GitHub outage attribution", () => {
  // The bug this whole feature exists for: a GitHub 503 used to fall through to
  // the generic "unknown" branch and render as "GitHub authentication check
  // failed", blaming the user's credential for GitHub's incident.
  const githubOutage503 = {
    kind: "service_unavailable" as const,
    message: "No server is currently available to service your request.",
    retryAt: null,
  };

  it("never blames the credential for a GitHub 5xx, even with no status page corroboration", () => {
    const failure = describeGithubAuthFailure(makeCliStatus({ authFailure: githubOutage503 }));
    expect(failure?.title).toBe("GitHub isn't responding");
    expect(failure?.subState).toBe("service-unavailable");
    expect(failure?.settingsDetail).toContain("not a problem with your credential");
    expect(failure?.action).not.toMatch(/reconnect/i);
  });

  it("attributes a corroborated outage to GitHub and drops the reconnect CTA", () => {
    const status = makeCliStatus({
      authFailure: githubOutage503,
      serviceHealth: outageHealth(),
    });
    const failure = describeGithubAuthFailure(status);
    expect(failure?.statusLabel).toBe("GitHub outage");
    expect(failure?.title).toBe("GitHub is down");
    expect(failure?.detail).toContain("API Requests");
    expect(failure?.detail).toContain("isn't your setup");
    expect(failure?.action).toBe("GitHub status");
  });

  // Outage attribution has to beat every credential-shaped reading of the same
  // failure, including the ones that fire before the authFailure branch.
  it("overrides the missing-write-credential banner during an outage", () => {
    const banner = describeGithubCliBanner(makeCliStatus({
      connected: true,
      writeAuthSource: "none",
      serviceHealth: outageHealth(),
    }));
    expect(banner.title).toBe("GitHub is down");
    expect(banner.subState).toBe("outage:major");
  });

  // A stored token is a local fact; an outage cannot explain it away, so the
  // genuine "connect GitHub" instruction must survive.
  it("still asks an unconnected user to connect GitHub during an outage", () => {
    const banner = describeGithubCliBanner(makeCliStatus({
      tokenStored: false,
      serviceHealth: outageHealth(),
    }));
    expect(banner.subState).toBe("no-token");
  });

  it("says nothing about GitHub health when no incident is corroborated", () => {
    expect(describeGithubOutage(makeCliStatus())).toBeNull();
    expect(describeGithubOutage(makeCliStatus({ serviceHealth: null }))).toBeNull();
    expect(describeGithubOutage(null)).toBeNull();
  });

  it("points the action at the live incident, falling back to the status page", () => {
    expect(describeGithubOutage(makeCliStatus({ serviceHealth: outageHealth() }))?.actionUrl)
      .toBe("https://stspg.io/x");
    const noIncident = deriveGitHubServiceHealth(
      {
        status: { indicator: "major", description: "Partial System Outage" },
        components: [{ id: "brv1bkgrwx7q", name: "API Requests", status: "major_outage" }],
        incidents: [],
      },
    )!;
    expect(describeGithubOutage(makeCliStatus({ serviceHealth: noIncident }))?.actionUrl)
      .toBe("https://www.githubstatus.com");
  });

  it("softens the wording when GitHub reports degradation rather than an outage", () => {
    const failure = describeGithubAuthFailure(makeCliStatus({
      authFailure: githubOutage503,
      serviceHealth: outageHealth([
        { id: "8l4ygp009s5s", name: "Git Operations", status: "degraded_performance" },
      ]),
    }));
    expect(failure?.title).toBe("GitHub is having problems");
  });
});
