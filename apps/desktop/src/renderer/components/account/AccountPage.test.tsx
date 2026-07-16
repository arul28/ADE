/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AccountPage, SignInCard } from "./AccountPage";
import { docs } from "../../onboarding/docsLinks";
import type { AdeAccountMachine, AdeAccountStatus } from "../../../shared/types";

const beginLogin = vi.fn(async () => undefined);
const refreshAccount = vi.fn(async () => SIGNED_OUT);

const SIGNED_OUT: AdeAccountStatus = {
  signedIn: false,
  configured: true,
  userId: null,
  email: null,
  name: null,
  expiresAt: null,
  provider: null,
  imageUrl: null,
};

// A mutable status ref the useAccountStatus mock reads from, so a single suite
// can exercise both signed-out and signed-in renders.
const { statusRef } = vi.hoisted(() => ({
  statusRef: { current: null as AdeAccountStatus | null },
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
      status: statusRef.current ?? actual.SIGNED_OUT_ACCOUNT,
      loading: false,
      refresh: refreshAccount,
    }),
  };
});

function machine(overrides: Partial<AdeAccountMachine>): AdeAccountMachine {
  return {
    machineKey: "key",
    deviceId: "dev",
    name: "Machine",
    platform: "darwin",
    deviceType: "laptop",
    reachableEndpoints: [],
    lastSeenAt: null,
    online: false,
    ...overrides,
  };
}

describe("AccountPage signed-out card", () => {
  const originalAde = window.ade;

  beforeEach(() => {
    statusRef.current = SIGNED_OUT;
    window.ade = {
      app: { openExternal: vi.fn(async () => undefined) },
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
    expect(screen.getByText("Sign in to use ADE Relay")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Sign in or create account" }));
    expect(beginLogin).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Learn about ADE Relay" }));
    expect(window.ade.app.openExternal).toHaveBeenCalledWith(docs.adeRelay);
  });

  it("states only that account sign-in is unavailable when it is not configured", () => {
    render(<SignInCard configured={false} onSignedIn={vi.fn()} />);

    expect(screen.getByText("Account sign-in isn't available in this build.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in or create account" }).hasAttribute("disabled")).toBe(true);
  });

  it("keeps a Back button and returns a signed-out user to the page they came from", async () => {
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

describe("AccountPage signed-in", () => {
  const originalAde = window.ade;
  const listMachines = vi.fn();
  const getLocalMachineIdentity = vi.fn();
  const removeMachine = vi.fn(async (machineKey: string) => ({ ok: true as const, machineKey }));
  const signOut = vi.fn(async () => SIGNED_OUT);

  beforeEach(() => {
    statusRef.current = {
      signedIn: true,
      configured: true,
      userId: "user_1",
      email: "ada@example.com",
      name: "Ada Lovelace",
      expiresAt: null,
      provider: "google",
      imageUrl: null,
    };
    listMachines.mockResolvedValue({
      state: "ok",
      message: null,
      machines: [
        machine({ machineKey: "studio-key", deviceId: "studio-dev", name: "Studio", online: false, lastSeenAt: Date.now() - 3_600_000 }),
        machine({ machineKey: "this-key", deviceId: "this-dev", name: "MacBook Pro", online: true, reachableEndpoints: [{ kind: "lan", host: "192.168.1.5" }] }),
      ],
    });
    getLocalMachineIdentity.mockResolvedValue({ machineKey: "this-key", deviceId: "this-dev" });
    window.ade = {
      app: { openExternal: vi.fn(async () => undefined) },
      github: {
        getStatus: vi.fn(async () => ({ connected: false })),
        onStatusChanged: vi.fn(() => () => {}),
      },
      account: { listMachines, getLocalMachineIdentity, removeMachine, signOut },
    } as unknown as typeof window.ade;
  });

  afterEach(() => {
    cleanup();
    listMachines.mockReset();
    getLocalMachineIdentity.mockReset();
    removeMachine.mockClear();
    signOut.mockClear();
    window.ade = originalAde;
  });

  function renderPage() {
    render(
      <MemoryRouter initialEntries={["/account"]}>
        <Routes>
          <Route path="/account" element={<AccountPage />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("shows identity, keeps a Back button, and drops the just-signed-in banner", () => {
    renderPage();
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("ada@example.com")).toBeTruthy();
    expect(screen.getByText("Signed in with Google")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.queryByText(/you're in/i)).toBeNull();
  });

  it("pins this Mac first with a badge and hides its removal menu", async () => {
    renderPage();
    await screen.findByText("MacBook Pro");

    const rows = screen.getAllByText(/MacBook Pro|Studio/);
    expect(rows[0].textContent).toBe("MacBook Pro");
    expect(screen.getByText("This Mac")).toBeTruthy();

    // Only the other Mac exposes an options (removal) menu.
    expect(screen.queryByRole("button", { name: /Options for MacBook Pro/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Options for Studio/ })).toBeTruthy();
  });

  it("portals the machine menu and manages focus through Escape", async () => {
    renderPage();
    await screen.findByText("Studio");

    const trigger = screen.getByRole("button", { name: /Options for Studio/ });
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu");
    // Portaled directly under document.body, outside the scrolling account column.
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.position).toBe("fixed");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("menuitem")));

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("removes another Mac only after confirmation", async () => {
    renderPage();
    await screen.findByText("Studio");

    fireEvent.click(screen.getByRole("button", { name: /Options for Studio/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Remove from account/ }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Remove this Mac from your account\?/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(removeMachine).toHaveBeenCalledWith("studio-key"));
  });

  it("signs out only after the honest confirmation", async () => {
    renderPage();
    await screen.findByText("MacBook Pro");

    expect(screen.getByText("Signed in on this Mac")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(
        "Signing out removes this Mac's access to your account and its account-connected machines. Devices paired directly with a code stay connected.",
      ),
    ).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
  });

  it("falls back to a monogram when the account avatar image fails to load", async () => {
    statusRef.current = {
      signedIn: true,
      configured: true,
      userId: "user_1",
      email: "ada@example.com",
      name: "Ada Lovelace",
      expiresAt: null,
      provider: "google",
      imageUrl: "https://img.clerk.com/broken-avatar.png",
    };
    const { container } = render(
      <MemoryRouter initialEntries={["/account"]}>
        <Routes>
          <Route path="/account" element={<AccountPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText("Ada Lovelace");

    const avatar = container.querySelector('img[src="https://img.clerk.com/broken-avatar.png"]');
    expect(avatar).toBeTruthy();
    // No monogram while the image is presumed loading.
    expect(screen.queryByText("AL")).toBeNull();

    fireEvent.error(avatar as HTMLImageElement);

    // The broken image is replaced by the initials monogram.
    expect(container.querySelector('img[src="https://img.clerk.com/broken-avatar.png"]')).toBeNull();
    expect(screen.getByText("AL")).toBeTruthy();
  });

  it("opens the Connections panel from the single Manage connections button", async () => {
    renderPage();
    await screen.findByText("MacBook Pro");
    const dispatch = vi.spyOn(window, "dispatchEvent");

    fireEvent.click(screen.getByRole("button", { name: /Manage connections/ }));
    expect(dispatch).toHaveBeenCalled();
    dispatch.mockRestore();

    // The old Mobile / Web clients shortcuts are gone.
    expect(screen.queryByRole("button", { name: "Mobile" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Web clients" })).toBeNull();
  });
});
