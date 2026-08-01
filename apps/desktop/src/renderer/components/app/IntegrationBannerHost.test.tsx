/* @vitest-environment jsdom */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GitHubAppInstallationStatus,
  GitHubAppUserAuthStatus,
  GitHubStatus,
  SyncRouteHealth,
} from "../../../shared/types";
import { IntegrationBannerHost, type IntegrationBannerHostProps } from "./IntegrationBannerHost";

function makeInstall(overrides: Partial<GitHubAppInstallationStatus> = {}): GitHubAppInstallationStatus {
  return {
    repo: { owner: "o", name: "r" },
    appName: "ADE",
    appSlug: "ade-for-github",
    installUrl: "https://github.com/apps/ade-for-github/installations/new",
    manageUrl: "https://github.com/settings/installations",
    relayConfigured: false,
    installed: false,
    state: "not_installed",
    installationId: null,
    repositorySelection: null,
    lastSeenAt: null,
    webhookEvents: [],
    missingWebhookEvents: [],
    webhookState: "unknown",
    webhookLastSeenAt: null,
    checkedAt: "2026-07-01T00:00:00.000Z",
    error: null,
    ...overrides,
  };
}

function makeAuth(overrides: Partial<GitHubAppUserAuthStatus> = {}): GitHubAppUserAuthStatus {
  return {
    configured: true,
    tokenStored: true,
    userLogin: "octocat",
    expiresAt: null,
    refreshTokenExpiresAt: null,
    checkedAt: "2026-07-01T00:00:00.000Z",
    error: null,
    ...overrides,
  };
}

function makeGithubStatus(overrides: Partial<GitHubStatus> = {}): GitHubStatus {
  return {
    tokenStored: false,
    patTokenStored: false,
    tokenDecryptionFailed: false,
    storageScope: "app",
    authSource: "none",
    repo: { owner: "o", name: "r" },
    hasOrigin: true,
    userLogin: null,
    scopes: [],
    ghCliPath: null,
    ghAuthError: null,
    checkedAt: null,
    repoAccessOk: null,
    repoAccessError: null,
    connected: false,
    ...overrides,
  };
}

function setAdeMock(github: Record<string, unknown> | undefined): void {
  Object.defineProperty(window, "ade", {
    configurable: true,
    value: {
      github,
      prs: { onEvent: vi.fn(() => () => {}) },
      app: { openExternal: vi.fn(async () => {}) },
    },
  });
}

function baseProps(overrides: Partial<IntegrationBannerHostProps> = {}): IntegrationBannerHostProps {
  return {
    currentProjectRoot: "/project/a",
    githubStatus: null,
    hasAnyAiProvider: true,
    aiStatusLoaded: true,
    providerMode: "guest",
    aiMockProvider: false,
    relayHealth: null,
    navigate: vi.fn() as unknown as IntegrationBannerHostProps["navigate"],
    ...overrides,
  };
}

function makeRelayHealth(
  overrides: Partial<SyncRouteHealth["relay"]> = {},
): SyncRouteHealth["relay"] {
  return {
    enabled: true,
    relayControlConnected: false,
    relayBridgeValidated: false,
    lastFailureAt: null,
    skipReason: null,
    lastControlError: null,
    lastControlOpenAt: null,
    lastBridgeValidationAt: null,
    relayControlSuppressed: false,
    relayControlSuppressedReason: null,
    relayControlFailingSinceMs: null,
    ...overrides,
  };
}

describe("IntegrationBannerHost", () => {
  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it("caps at two banners and collapses the rest behind an expandable row", async () => {
    setAdeMock({
      getAppInstallationStatus: vi.fn(async () => makeInstall()),
      getAppUserAuthStatus: vi.fn(async () => makeAuth()),
      onStatusChanged: vi.fn(() => () => {}),
    });

    await act(async () => {
      render(
        <IntegrationBannerHost
          {...baseProps({
            githubStatus: makeGithubStatus(),
            hasAnyAiProvider: false,
            aiStatusLoaded: true,
            providerMode: "subscription",
            aiMockProvider: true,
          })}
        />,
      );
    });
    // Flush the async GitHub App status read so the App repo block appears.
    await act(async () => {});

    // Four banners are active; only the first two render, the rest collapse.
    expect(screen.getAllByRole("status")).toHaveLength(2);
    expect(screen.getByText("o/r isn't connected to the ADE GitHub App")).toBeTruthy();
    expect(screen.getByText("GitHub CLI or token not connected")).toBeTruthy();
    expect(screen.queryByText("No AI provider configured")).toBeNull();

    const toggle = screen.getByRole("button", { name: /2 more integration issues/i });

    await act(async () => {
      toggle.click();
    });

    expect(screen.getAllByRole("status")).toHaveLength(4);
    expect(screen.getByText("No AI provider configured")).toBeTruthy();
    expect(screen.getByText("Using a mock LLM provider")).toBeTruthy();
  });

  it("dismisses a banner and persists the dismissal to storage", async () => {
    // No GitHub App API → no App block; only the missing-AI banner is active.
    setAdeMock(undefined);

    await act(async () => {
      render(
        <IntegrationBannerHost
          {...baseProps({ hasAnyAiProvider: false, aiStatusLoaded: true })}
        />,
      );
    });

    expect(screen.getByText("No AI provider configured")).toBeTruthy();

    await act(async () => {
      screen.getByRole("button", { name: "Dismiss: No AI provider configured" }).click();
    });

    expect(screen.queryByText("No AI provider configured")).toBeNull();
    const stored = window.localStorage.getItem("ade.bannerDismiss.v1");
    expect(stored).toContain("ai-provider:/project/a");
  });

  it("shows the write-access banner for a connected read-only GitHub App", async () => {
    setAdeMock(undefined);

    await act(async () => {
      render(<IntegrationBannerHost {...baseProps({
        githubStatus: makeGithubStatus({
          tokenStored: true,
          authSource: "app",
          writeAuthSource: "none",
          userLogin: "octocat",
          connected: true,
        }),
      })} />);
    });

    expect(screen.getByText("GitHub write access isn't connected")).toBeTruthy();
  });
});

describe("IntegrationBannerHost relay-offline banner", () => {
  const NOW = new Date("2026-07-20T12:00:00.000Z").getTime();

  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
    // No GitHub App API → the relay banner is the only candidate in these cases.
    setAdeMock(undefined);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  async function renderWithRelay(relay: SyncRouteHealth["relay"] | null): Promise<void> {
    await act(async () => {
      render(<IntegrationBannerHost {...baseProps({ relayHealth: relay })} />);
    });
  }

  it("surfaces the process-conflict case immediately, with no grace period", async () => {
    await renderWithRelay(
      makeRelayHealth({
        relayControlSuppressed: true,
        relayControlSuppressedReason: "Another ADE process owns the relay connection for this machine.",
        relayControlFailingSinceMs: NOW - 1_000,
      }),
    );

    expect(screen.getByText("Another ADE process owns this machine's relay connection")).toBeTruthy();
    expect(
      screen.getByText(/Quit the other ADE app or brain on this machine/),
    ).toBeTruthy();
  });

  it("stays quiet while relay has only been down for 30 seconds", async () => {
    await renderWithRelay(makeRelayHealth({ relayControlFailingSinceMs: NOW - 30_000 }));

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the outage banner once relay has been down for five minutes", async () => {
    await renderWithRelay(
      makeRelayHealth({
        relayControlFailingSinceMs: NOW - 5 * 60_000,
        lastControlError: "relay handshake timed out",
      }),
    );

    expect(screen.getByText("ADE Relay is not connected")).toBeTruthy();
    expect(screen.getByText("relay handshake timed out")).toBeTruthy();
  });

  it("says nothing while the relay control is connected", async () => {
    await renderWithRelay(
      makeRelayHealth({
        relayControlConnected: true,
        relayBridgeValidated: true,
        relayControlFailingSinceMs: null,
      }),
    );

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says nothing when the relay is disabled, however long it has been down", async () => {
    await renderWithRelay(
      makeRelayHealth({ enabled: false, relayControlFailingSinceMs: NOW - 60 * 60_000 }),
    );

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says nothing before the first sync snapshot lands", async () => {
    await renderWithRelay(null);

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("raises the banner on its own once the grace window elapses", async () => {
    await renderWithRelay(makeRelayHealth({ relayControlFailingSinceMs: NOW - 30_000 }));
    expect(screen.queryByRole("status")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(95_000);
    });

    expect(screen.getByText("ADE Relay is not connected")).toBeTruthy();
  });

  it("keeps a dismissed outage from hiding a later process conflict", async () => {
    const { rerender } = render(
      <IntegrationBannerHost
        {...baseProps({ relayHealth: makeRelayHealth({ relayControlFailingSinceMs: NOW - 5 * 60_000 }) })}
      />,
    );
    await act(async () => {});

    await act(async () => {
      screen.getByRole("button", { name: "Dismiss: ADE Relay is not connected" }).click();
    });
    expect(screen.queryByRole("status")).toBeNull();

    await act(async () => {
      rerender(
        <IntegrationBannerHost
          {...baseProps({
            relayHealth: makeRelayHealth({
              relayControlSuppressed: true,
              relayControlSuppressedReason: "Another ADE process owns the relay connection for this machine.",
              relayControlFailingSinceMs: NOW - 5 * 60_000,
            }),
          })}
        />,
      );
    });

    expect(screen.getByText("Another ADE process owns this machine's relay connection")).toBeTruthy();
  });
});
