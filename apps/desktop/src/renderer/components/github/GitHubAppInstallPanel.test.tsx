/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { GitHubAppInstallationStatus, GitHubAppUserAuthStatus } from "../../../shared/types";
import { GitHubAppInstallPanel } from "./GitHubAppInstallPanel";

function makeAppAuth(overrides: Partial<GitHubAppUserAuthStatus> = {}): GitHubAppUserAuthStatus {
  return {
    configured: true,
    tokenStored: true,
    userLogin: "arul28",
    expiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    refreshTokenExpiresAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString(),
    credentialState: "authorized",
    refreshBlockedUntil: null,
    lastRefreshError: null,
    checkedAt: new Date().toISOString(),
    error: null,
    ...overrides,
  };
}

function installedStatus(): GitHubAppInstallationStatus {
  return {
    repo: { owner: "arul28", name: "ADE" },
    appName: "ADE",
    appSlug: "ade-for-github",
    installUrl: "https://github.com/apps/ade-for-github/installations/new",
    manageUrl: "https://github.com/settings/installations",
    relayConfigured: true,
    installed: true,
    state: "configured",
    installationId: 1,
    repositorySelection: "all",
    lastSeenAt: null,
    webhookEvents: ["pull_request"],
    missingWebhookEvents: [],
    webhookState: "active",
    webhookLastSeenAt: null,
    checkedAt: new Date().toISOString(),
    error: null,
  };
}

describe("GitHubAppInstallPanel", () => {
  const originalAde = window.ade;

  afterEach(() => {
    cleanup();
    window.ade = originalAde;
  });

  it("does not claim account authorization while a repo check is rate limited", async () => {
    const rateLimitedStatus: GitHubAppInstallationStatus = {
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
      checkedAt: new Date().toISOString(),
      error: "GitHub API rate limit reached",
    };
    window.ade = {
      github: {
        getAppInstallationStatus: vi.fn(async () => rateLimitedStatus),
        getAppUserAuthStatus: vi.fn(async () => null),
      },
    } as unknown as typeof window.ade;

    render(<GitHubAppInstallPanel />);

    expect(await screen.findByText("Rate limited")).toBeTruthy();
    expect(screen.getByText("Not authorized")).toBeTruthy();
    expect(screen.getByText("GitHub temporarily paused automatic App checks. Wait for the cooldown, then recheck.")).toBeTruthy();
    expect(screen.queryByText(/still authorized/i)).toBeNull();
    expect(screen.queryByText(/re-authorizing is not needed/i)).toBeNull();
  });

  // The device flow polls the same OAuth host that is refusing the renewals, so
  // offering the button here is what kept the account locked out.
  it("offers no re-authorize button while GitHub has renewals paused", async () => {
    const startAppUserDeviceAuth = vi.fn();
    window.ade = {
      github: {
        getAppInstallationStatus: vi.fn(async () => installedStatus()),
        getAppUserAuthStatus: vi.fn(async () => makeAppAuth({
          credentialState: "blocked",
          refreshBlockedUntil: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          lastRefreshError: { kind: "rate_limited", message: "429", status: 429, at: new Date().toISOString() },
        })),
        startAppUserDeviceAuth,
      },
    } as unknown as typeof window.ade;

    render(<GitHubAppInstallPanel />);

    expect(await screen.findByText(/^Paused until /)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /re-authorize/i })).toBeNull();
    expect(screen.queryByText(/authorization expired/i)).toBeNull();
    expect(startAppUserDeviceAuth).not.toHaveBeenCalled();
  });

  it("clears the stored authorization only after the disconnect is confirmed", async () => {
    const clearAppUserAuth = vi.fn(async () => makeAppAuth({ tokenStored: false, credentialState: "missing" }));
    window.ade = {
      github: {
        getAppInstallationStatus: vi.fn(async () => installedStatus()),
        getAppUserAuthStatus: vi.fn(async () => makeAppAuth()),
        clearAppUserAuth,
      },
    } as unknown as typeof window.ade;

    render(<GitHubAppInstallPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(clearAppUserAuth).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm disconnect" }));
    expect(clearAppUserAuth).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Not authorized")).toBeTruthy();
  });
});
