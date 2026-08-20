import { describe, expect, it } from "vitest";
import type {
  GitHubAppInstallationStatus,
  GitHubAppUserAuthStatus,
  GitHubStatus,
} from "../../shared/types";
import { GITHUB_CREDENTIAL_STORE_UNREADABLE_COPY } from "../../shared/types";
import {
  deriveGithubAccountAuthState,
  deriveGithubRealtimeBlock,
  deriveGithubRepoConnectionState,
  describeGithubAccountAxis,
  describeGithubAppCredentialBadge,
  describeGithubAuthFailure,
  describeGithubCliBanner,
  describeGithubOutage,
  describeGithubPatVerification,
  githubAccountIssueCopy,
  githubCredentialPresentation,
  githubRepoIssueCopy,
  githubStatusHasUsablePat,
  isGithubAuthorizationPausedMessage,
  isGithubRateLimitMessage,
  isGithubRepoAccessPending,
} from "./githubIntegrationStatus";
import { deriveGitHubServiceHealth } from "../../shared/githubServiceHealth";
import { makeAppAuth } from "./githubIntegrationStatus.testFixtures";

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

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe("deriveGithubAccountAuthState", () => {
  // The bug this whole branch exists for. The GitHub App access token lives 8
  // hours and is renewed from the refresh token on every use, so a lapsed
  // access token is normal operation, not an expired authorization. Judging by
  // `expiresAt` told a working account to re-authorize, and the re-authorize
  // flow hits the very OAuth endpoint that was rate-limiting the renewals.
  it("keeps an account with a live refresh token authorized after the access token lapses", () => {
    expect(deriveGithubAccountAuthState(makeAppAuth({
      expiresAt: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
      credentialState: "authorized",
    }))).toBe("valid");
  });

  it("reads a paused renewal as blocked, not as an expired authorization", () => {
    expect(deriveGithubAccountAuthState(makeAppAuth({
      expiresAt: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
      credentialState: "blocked",
      refreshBlockedUntil: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
      lastRefreshError: {
        kind: "rate_limited",
        message: "GitHub OAuth request failed (429)",
        status: 429,
        at: new Date().toISOString(),
      },
    }))).toBe("blocked");
  });

  it("asks for re-authorization only when the refresh token itself is gone", () => {
    expect(deriveGithubAccountAuthState(makeAppAuth({
      credentialState: "needs_reauth",
      refreshTokenExpiresAt: new Date(Date.now() - DAY_MS).toISOString(),
    }))).toBe("needs_reauth");
  });

  it("reports a cleared credential as missing whatever the service says", () => {
    expect(deriveGithubAccountAuthState(null)).toBe("missing");
    expect(deriveGithubAccountAuthState(makeAppAuth({ tokenStored: false }))).toBe("missing");
    expect(deriveGithubAccountAuthState(makeAppAuth({ credentialState: "missing" }))).toBe("missing");
  });

  // Older hosts (and the web-client stub) send the DTO without credentialState.
  // The refresh token still decides the truth there, so the same lapsed access
  // token must not read as expired.
  it("falls back to the refresh token when the host sends the old shape", () => {
    const legacy = makeAppAuth({ expiresAt: new Date(Date.now() - 2 * HOUR_MS).toISOString() });
    delete (legacy as Partial<GitHubAppUserAuthStatus>).credentialState;
    delete (legacy as Partial<GitHubAppUserAuthStatus>).refreshBlockedUntil;
    delete (legacy as Partial<GitHubAppUserAuthStatus>).lastRefreshError;

    expect(deriveGithubAccountAuthState(legacy)).toBe("valid");

    const legacyDeadRefresh = { ...legacy, refreshTokenExpiresAt: new Date(Date.now() - DAY_MS).toISOString() };
    expect(deriveGithubAccountAuthState(legacyDeadRefresh)).toBe("needs_reauth");
  });
});

describe("describeGithubAccountAxis", () => {
  it("says an authorized account renews itself, with nothing to click", () => {
    const axis = describeGithubAccountAxis("valid", makeAppAuth());
    expect(axis.label).toBe("Authorized");
    expect(axis.subtext).toBe("arul28 · renews automatically");
    expect(axis.cta).toBeNull();
    // The 8-hour access token expiry taught users to read normal renewal as an
    // impending failure, so it must not appear here at all.
    expect(axis.subtext).not.toMatch(/valid to|expires/i);
  });

  // The whole failure mode in one assertion: while GitHub is refusing renewals,
  // the panel must not offer the button that walks the user back into the same
  // refusal.
  it("offers no re-authorize button while GitHub has renewals paused", () => {
    const blockedUntil = new Date(Date.now() + 40 * 60 * 1000).toISOString();
    const axis = describeGithubAccountAxis("blocked", makeAppAuth({
      credentialState: "blocked",
      refreshBlockedUntil: blockedUntil,
      lastRefreshError: { kind: "rate_limited", message: "429", status: 429, at: new Date().toISOString() },
    }));

    expect(axis.cta).toBeNull();
    expect(axis.label).toMatch(/^Paused until /);
    expect(axis.subtext).toContain("retries automatically");
    expect(axis.subtext).toContain("won't speed this up");
    expect(axis.note).toContain("unavailable while GitHub");
    expect(axis.label).not.toMatch(/expired/i);
  });

  it("falls back to a plain Paused label when GitHub named no deadline", () => {
    const axis = describeGithubAccountAxis("blocked", makeAppAuth({
      credentialState: "blocked",
      refreshBlockedUntil: null,
    }));
    expect(axis.label).toBe("Paused");
  });

  it("asks for re-authorization only in the state that needs one", () => {
    const reauth = describeGithubAccountAxis("needs_reauth", makeAppAuth({ credentialState: "needs_reauth" }));
    expect(reauth.cta).toBe("reauthorize");
    expect(reauth.label).toBe("Authorization expired");
    expect(reauth.subtext).toBe(githubAccountIssueCopy("needs_reauth").detail);

    const missing = describeGithubAccountAxis("missing", null);
    expect(missing.cta).toBe("authorize");
    expect(missing.label).toBe("Not authorized");

    const checking = describeGithubAccountAxis("checking", null);
    expect(checking.cta).toBeNull();
    expect(checking.tone).toBe("pending");
  });
});

describe("describeGithubAppCredentialBadge", () => {
  it("separates a paused renewal from a dead authorization in the Settings ladder", () => {
    expect(describeGithubAppCredentialBadge("blocked", "2026-08-20T15:40:00.000Z")).toMatchObject({
      tone: "neutral",
      label: expect.stringMatching(/^Paused until /),
    });
    expect(describeGithubAppCredentialBadge("needs_reauth", null)).toEqual({
      label: "Re-authorize",
      tone: "warn",
    });
    expect(describeGithubAppCredentialBadge("valid", null)).toBeNull();
    expect(describeGithubAppCredentialBadge("missing", null)).toBeNull();
  });
});

describe("isGithubAuthorizationPausedMessage", () => {
  it("recognizes the OAuth throttle behind ADE's raw transport error", () => {
    expect(isGithubAuthorizationPausedMessage("GitHub OAuth request failed (429)")).toBe(true);
    expect(isGithubAuthorizationPausedMessage("Too Many Requests")).toBe(true);
    expect(isGithubAuthorizationPausedMessage("You have exceeded a secondary rate limit.")).toBe(true);
    expect(isGithubAuthorizationPausedMessage("GitHub OAuth request failed (400): bad_verification_code")).toBe(false);
    expect(isGithubAuthorizationPausedMessage(null)).toBe(false);
  });
});

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

  // The second half of the same bug: with the account token unusable, the relay
  // answered the install check with its own 401 and the repo row reported "not
  // installed · GitHub auth token is required" — an uninstall that never
  // happened, phrased in ADE's internal words.
  it("reports an unproven install as waiting on the account, not as uninstalled", () => {
    const notInstalled = makeStatus({ installed: false, state: "not_installed", error: null });
    expect(deriveGithubRepoConnectionState(notInstalled, "blocked")).toBe("waiting_on_account");
    expect(deriveGithubRepoConnectionState(notInstalled, "needs_reauth")).toBe("waiting_on_account");
    expect(deriveGithubRepoConnectionState(notInstalled, "missing")).toBe("waiting_on_account");
    expect(deriveGithubRepoConnectionState(notInstalled, "valid")).toBe("not_installed");
  });

  it("treats the relay's auth-required answer as waiting even without an account state", () => {
    expect(deriveGithubRepoConnectionState(
      makeStatus({ installed: false, state: "error", error: "GitHub auth token is required" }),
    )).toBe("waiting_on_account");
  });

  // A rate limit or a GitHub 5xx explains itself, and the check can run on the
  // ADE account token, so those keep their own honest copy rather than being
  // folded into the account wait.
  it("keeps a corroborated GitHub failure out of the account wait", () => {
    expect(deriveGithubRepoConnectionState(
      makeStatus({ installed: false, state: "error", error: "GitHub API rate limit reached" }),
      "missing",
    )).toBe("unknown");
    expect(deriveGithubRepoConnectionState(
      makeStatus({ installed: false, state: "error", error: "No server is currently available to service your request." }),
      "blocked",
    )).toBe("unknown");
  });

  it("keeps a verified installation connected regardless of the account axis", () => {
    expect(deriveGithubRepoConnectionState(installed(), "blocked")).toBe("connected");
  });

  it("never repeats the relay's auth-required string to the user", () => {
    const copy = githubRepoIssueCopy("waiting_on_account", "arul28/ADE", "blocked");
    expect(copy.title).toContain("Waiting on GitHub authorization");
    expect(copy.detail).not.toMatch(/auth token/i);
    expect(githubRepoIssueCopy("waiting_on_account", null, "missing").detail).toContain("Authorize ADE");
  });
});

describe("deriveGithubRealtimeBlock", () => {
  it("raises no banner for a pause the user cannot clear", () => {
    expect(deriveGithubRealtimeBlock("blocked", "waiting_on_account")).toBeNull();
    expect(deriveGithubRealtimeBlock("blocked", "not_installed")).toBeNull();
  });

  it("still names the two account problems the user can fix", () => {
    expect(deriveGithubRealtimeBlock("needs_reauth", "unknown")).toEqual({
      kind: "account",
      account: "needs_reauth",
    });
    expect(deriveGithubRealtimeBlock("missing", "unknown")).toEqual({ kind: "account", account: "missing" });
    expect(deriveGithubRealtimeBlock("valid", "not_installed")).toEqual({ kind: "repo", repo: "not_installed" });
    expect(deriveGithubRealtimeBlock("valid", "connected")).toBeNull();
  });
});

describe("describeGithubCliBanner", () => {
  // Regression: an unreadable credential store arrives with tokenStored:false —
  // identical to a fresh install — and the banner used to say "GitHub CLI or
  // token not connected", pointing the user at a Connect flow that would write
  // over credentials that are still on disk.
  it("says the sign-in is unreadable rather than never connected", () => {
    const banner = describeGithubCliBanner(makeCliStatus({
      tokenStored: false,
      credentialStoreUnreadable: true,
    }));

    expect(banner.subState).toBe("credential-store-unreadable");
    expect(banner.title).toBe(GITHUB_CREDENTIAL_STORE_UNREADABLE_COPY.title);
    expect(banner.title).not.toContain("not connected");
    expect(banner.detail).toContain("Settings → Connections");
    // The Repair control lives in Connections, not on the GitHub settings card.
    expect(banner.target).toBe("connections");
  });

  it("outranks a stale auth failure with the unreadable store", () => {
    const banner = describeGithubCliBanner(makeCliStatus({
      tokenStored: false,
      credentialStoreUnreadable: true,
      authFailure: { kind: "invalid_token", message: "Bad credentials", retryAt: null },
    }));

    expect(banner.subState).toBe("credential-store-unreadable");
  });

  it("still reports a genuinely absent credential as not connected", () => {
    const banner = describeGithubCliBanner(makeCliStatus({
      tokenStored: false,
      credentialStoreUnreadable: false,
    }));

    expect(banner.subState).toBe("no-token");
    expect(banner.title).toBe("GitHub CLI or token not connected");
    // Every banner states its destination; only the unreadable store leaves the
    // GitHub card, so a caller never has to re-derive the default.
    expect(banner.target).toBe("github-settings");
  });

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
