/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AccountPage, SignInCard } from "./AccountPage";
import { docs } from "../../onboarding/docsLinks";

const beginLogin = vi.fn(async () => undefined);
const refreshAccount = vi.fn(async () => ({
  signedIn: false,
  configured: true,
  userId: null,
  email: null,
  name: null,
  expiresAt: null,
  provider: null,
  imageUrl: null,
}));

vi.mock("../../lib/accountLogin", () => ({
  useAccountLogin: () => ({
    phase: "idle",
    error: null,
    beginLogin,
    cancel: vi.fn(),
  }),
}));

vi.mock("../../lib/account", async () => {
  const actual = await vi.importActual<typeof import("../../lib/account")>("../../lib/account");
  return {
    ...actual,
    useAccountStatus: () => ({
      status: {
        signedIn: false,
        configured: true,
        userId: null,
        email: null,
        name: null,
        expiresAt: null,
        provider: null,
        imageUrl: null,
      },
      loading: false,
      refresh: refreshAccount,
    }),
  };
});

describe("AccountPage signed-out card", () => {
  const originalAde = window.ade;

  beforeEach(() => {
    window.ade = {
      app: {
        openExternal: vi.fn(async () => undefined),
      },
      github: {
        getStatus: vi.fn(async () => ({ connected: false })),
        onStatusChanged: vi.fn(() => () => {}),
      },
    } as unknown as typeof window.ade;
  });

  afterEach(() => {
    cleanup();
    beginLogin.mockClear();
    refreshAccount.mockClear();
    window.ade = originalAde;
  });

  it("presents a direct sign-in action without feature or browser filler", () => {
    render(<SignInCard configured onSignedIn={vi.fn()} />);

    expect(screen.getByText("Sign in to ADE")).toBeTruthy();
    expect(screen.queryByText(/choose a sign-in method/i)).toBeNull();
    expect(screen.queryByText(/browser page offers/i)).toBeNull();
    expect(screen.queryByText(/local pairing/i)).toBeNull();
    expect(screen.getByText("Sign in to use ADE Relay")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Sign in or create account" }));
    expect(beginLogin).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Learn about ADE Relay" }));
    expect(window.ade.app.openExternal).toHaveBeenCalledWith(docs.adeRelay);
  });

  it("states only that account sign-in is unavailable when it is not configured", () => {
    render(<SignInCard configured={false} onSignedIn={vi.fn()} />);

    expect(screen.getByText("Account sign-in isn't available in this build.")).toBeTruthy();
    expect(screen.queryByText(/pair/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in or create account" }).hasAttribute("disabled")).toBe(true);
  });

  it("returns a signed-out user to the page they came from", async () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: "/account", state: { returnTo: "/files?view=tree" } }]}>
        <Routes>
          <Route path="/files" element={<div>Files page</div>} />
          <Route path="/account" element={<AccountPage />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(await screen.findByText("Files page")).toBeTruthy();
  });

  it("uses a safe in-app fallback when account is opened directly", async () => {
    render(
      <MemoryRouter initialEntries={["/account"]}>
        <Routes>
          <Route path="/work" element={<div>Work page</div>} />
          <Route path="/account" element={<AccountPage />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(await screen.findByText("Work page")).toBeTruthy();
  });
});
