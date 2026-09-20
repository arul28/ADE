/* @vitest-environment jsdom */

import React, { useEffect } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const accountState = vi.hoisted(() => ({
  signedIn: false,
  loading: false,
  // Drives `accountGateMode`. "signed_out" is a first run on this computer and
  // has no pass-through; "expired" / "unreadable" always do.
  sessionState: "signed_out" as "active" | "signed_out" | "expired" | "unreadable",
}));

vi.mock("../../lib/account", async () => {
  const actual = await vi.importActual<typeof import("../../lib/account")>("../../lib/account");
  return {
    ...actual,
    useAccountStatus: () => ({
      status: {
        signedIn: accountState.signedIn,
        sessionState: accountState.sessionState,
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
  };
});

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
    accountState.sessionState = "signed_out";
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

  // ADE requires an account. A machine that has never held a session gets no
  // way past the gate — that is the whole point of the requirement.
  it("gives a first run no way past the sign-in screen", async () => {
    render(<LaunchGate><div>Application</div></LaunchGate>);

    expect(await screen.findByRole("button", { name: /sign in test/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /continue to your work/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /without an account/i })).toBeNull();
    expect(screen.getByTestId("launch-gate-drag-region").getAttribute("data-app-region")).toBe("drag");
    expect(screen.queryByText("Application")).toBeNull();
    await waitFor(() => {
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
    });

    fireEvent.click(screen.getByRole("button", { name: /sign in test/i }));

    expect(await screen.findByText("Application")).toBeTruthy();
    expect(resolveLaunchGate).toHaveBeenCalledTimes(1);
  });

  // The opposite case. The user already signed in and something took the
  // session away; their work is on this disk, so blocking it would be a brick.
  it.each(["expired", "unreadable"] as const)(
    "lets a %s session pass through to local work",
    async (sessionState) => {
      accountState.sessionState = sessionState;

      render(<LaunchGate><div>Application</div></LaunchGate>);

      const passThrough = await screen.findByRole("button", { name: /continue to your work/i });
      expect(screen.queryByText("Application")).toBeNull();

      fireEvent.click(passThrough);

      expect(await screen.findByText("Application")).toBeTruthy();
      expect(resolveLaunchGate).toHaveBeenCalledTimes(1);
    },
  );

  it("does not repeat after this desktop process has resolved the gate", async () => {
    getLaunchGateState.mockResolvedValue({ resolved: true });

    render(<LaunchGate><div>Application</div></LaunchGate>);

    expect(await screen.findByText("Application")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /continue to your work/i })).toBeNull();
  });

  it("enters automatically after welcome when the ADE account is signed in", async () => {
    accountState.signedIn = true;

    render(<LaunchGate><div>Application</div></LaunchGate>);

    await waitFor(() => expect(resolveLaunchGate).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Application")).toBeTruthy();
  });
});
