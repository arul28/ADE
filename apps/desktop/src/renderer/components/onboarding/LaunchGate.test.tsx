/* @vitest-environment jsdom */

import React, { useEffect } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const accountState = vi.hoisted(() => ({
  signedIn: false,
  loading: false,
}));

vi.mock("../../lib/account", () => ({
  useAccountStatus: () => ({
    status: {
      signedIn: accountState.signedIn,
      configured: true,
      userId: null,
      email: null,
      name: null,
      expiresAt: null,
      provider: null,
      imageUrl: null,
    },
    loading: accountState.loading,
  }),
}));

vi.mock("../account/AccountPage", () => ({
  SignInCard: ({ onSignedIn }: { onSignedIn: () => void }) => (
    <button type="button" onClick={onSignedIn}>Sign in test</button>
  ),
}));

vi.mock("./WelcomeVideoGate", () => ({
  WelcomeVideoGate: ({
    onVisibilityChange,
  }: {
    onVisibilityChange: (visible: boolean, checking: boolean) => void;
  }) => {
    useEffect(() => onVisibilityChange(false, false), [onVisibilityChange]);
    return null;
  },
}));

import { LaunchGate } from "./LaunchGate";

describe("LaunchGate", () => {
  const originalAde = window.ade;
  const getLaunchGateState = vi.fn();
  const resolveLaunchGate = vi.fn();
  const captureAnalytics = vi.fn();

  beforeEach(() => {
    accountState.signedIn = false;
    accountState.loading = false;
    getLaunchGateState.mockReset().mockResolvedValue({ resolved: false });
    resolveLaunchGate.mockReset().mockResolvedValue({ resolved: true });
    captureAnalytics.mockReset().mockResolvedValue({ accepted: true, reason: "accepted" });
    window.__adeWebClient = false;
    window.ade = {
      app: { getLaunchGateState, resolveLaunchGate },
      analytics: { capture: captureAnalytics },
    } as unknown as typeof window.ade;
  });

  afterEach(() => {
    cleanup();
    window.ade = originalAde;
    delete window.__adeWebClient;
  });

  it("holds back the app until a signed-out user chooses to continue", async () => {
    render(<LaunchGate><div>Application</div></LaunchGate>);

    expect(await screen.findByRole("button", { name: /continue without an account/i })).toBeTruthy();
    expect(screen.queryByText(/Use ADE on this Mac without an account/i)).toBeNull();
    expect(screen.getByTestId("launch-gate-drag-region").getAttribute("data-app-region")).toBe("drag");
    expect(screen.queryByText("Application")).toBeNull();
    expect(captureAnalytics).toHaveBeenCalledWith({
      event: "ade_screen_viewed",
      properties: {
        screen: "onboarding",
        route_kind: "desktop",
        source: "renderer_startup",
      },
      dedupeKey: "desktop_launch_account_choice",
      minimumIntervalMs: 60 * 60_000,
    });

    fireEvent.click(screen.getByRole("button", { name: /continue without an account/i }));

    expect(await screen.findByText("Application")).toBeTruthy();
    expect(resolveLaunchGate).toHaveBeenCalledTimes(1);
  });

  it("does not repeat after this desktop process has resolved the gate", async () => {
    getLaunchGateState.mockResolvedValue({ resolved: true });

    render(<LaunchGate><div>Application</div></LaunchGate>);

    expect(await screen.findByText("Application")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /continue without an account/i })).toBeNull();
  });

  it("enters automatically after welcome when the ADE account is signed in", async () => {
    accountState.signedIn = true;

    render(<LaunchGate><div>Application</div></LaunchGate>);

    await waitFor(() => expect(resolveLaunchGate).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Application")).toBeTruthy();
  });
});
