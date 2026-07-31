/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { GitHubAppInstallationStatus } from "../../../shared/types";
import { GitHubAppInstallPanel } from "./GitHubAppInstallPanel";

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
});
