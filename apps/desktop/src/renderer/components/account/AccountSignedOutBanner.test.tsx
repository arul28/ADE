/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { AdeAccountSessionState } from "../../../shared/types";

/**
 * ADE requires an account, so a machine with no usable session has to say so
 * everywhere until the user fixes it. Three properties make that true rather
 * than decorative, and each one is a bug the moment it stops holding:
 *
 *  - it cannot be dismissed, so the nag ends only when resolved;
 *  - `unreadable` offers repair, never sign-in, because a fresh sign-in
 *    overwrites a stored session that was merely unreadable;
 *  - it stays quiet before the first status lands, or it would claim
 *    "signed out" for a frame on every single launch.
 */

const accountState = vi.hoisted(() => ({
  signedIn: false,
  loading: false,
  sessionState: "signed_out" as AdeAccountSessionState,
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

import { AccountSignedOutBanner } from "./AccountSignedOutBanner";

function renderBanner(route = "/work") {
  const navigate = vi.fn();
  render(
    <MemoryRouter initialEntries={[route]}>
      <AccountSignedOutBanner navigate={navigate} />
    </MemoryRouter>,
  );
  return navigate;
}

describe("AccountSignedOutBanner", () => {
  afterEach(() => {
    cleanup();
    accountState.signedIn = false;
    accountState.loading = false;
    accountState.sessionState = "signed_out";
  });

  it("stays silent while the account is usable", () => {
    accountState.signedIn = true;
    accountState.sessionState = "active";

    renderBanner();

    expect(screen.queryByTestId("account-signed-out-banner")).toBeNull();
  });

  it("stays silent until the first status lands", () => {
    accountState.loading = true;

    renderBanner();

    expect(screen.queryByTestId("account-signed-out-banner")).toBeNull();
  });

  it.each(["signed_out", "expired"] as const)("offers sign-in for a %s session", (sessionState) => {
    accountState.sessionState = sessionState;

    const navigate = renderBanner();

    const banner = screen.getByTestId("account-signed-out-banner");
    expect(banner.getAttribute("data-session-state")).toBe(sessionState);

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(navigate).toHaveBeenCalledWith("/account", { state: { returnTo: "/work" } });
  });

  // The whole reason the session state is a tri-state: inviting a sign-in over
  // a session that is only unreadable is how the user destroys a valid one.
  it("offers repair, never sign-in, when the store is unreadable", () => {
    accountState.sessionState = "unreadable";

    renderBanner();

    expect(screen.getByRole("button", { name: "Repair" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("cannot be dismissed", () => {
    renderBanner();

    expect(screen.getByTestId("account-signed-out-banner")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /dismiss/i })).toBeNull();
  });

  it("hides on the account page, where its own action would lead", () => {
    renderBanner("/account");

    expect(screen.queryByTestId("account-signed-out-banner")).toBeNull();
  });
});
