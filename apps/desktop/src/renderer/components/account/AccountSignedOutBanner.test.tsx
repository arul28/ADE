/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const runAccountDeviceLogin = vi.hoisted(() => vi.fn());
vi.mock("../../lib/accountLogin", () => ({
  runAccountDeviceLogin: (options?: unknown) => runAccountDeviceLogin(options),
}));

import { AccountSignedOutBanner } from "./AccountSignedOutBanner";
import { AppBannerHost } from "../ui/notice";
import { resetAppBannersForTests } from "../ui/notice/appBannerStore";
import { resetLocalSyncStatusReaderForTests } from "../../lib/localSyncStatusReader";
import { resetReconnectFlowForTests } from "../../lib/reconnectThisComputer";
import { createSyncAccountDirectoryHealth, type SyncAccountDirectoryHealth } from "../../../shared/types";

function renderBanner(route = "/work") {
  const navigate = vi.fn();
  render(
    <MemoryRouter initialEntries={[route]}>
      <AccountSignedOutBanner navigate={navigate} />
      <AppBannerHost />
    </MemoryRouter>,
  );
  return navigate;
}

function signedOutBanner(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-banner-id^="account-"]');
}

async function findRefusedBanner(): Promise<HTMLElement> {
  return waitFor(() => {
    const el = document.querySelector<HTMLElement>('[data-banner-id="this-computer-refused"]');
    if (!el) throw new Error("this-computer-refused banner not shown");
    return el;
  });
}

function refusedBanner(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-banner-id="this-computer-refused"]');
}

// The reconnect flow is one per window, so it outlives each test's render.
afterEach(() => {
  resetReconnectFlowForTests();
  resetAppBannersForTests();
});

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

    expect(signedOutBanner()).toBeNull();
  });

  it("stays silent until the first status lands", () => {
    accountState.loading = true;

    renderBanner();

    expect(signedOutBanner()).toBeNull();
  });

  it.each(["signed_out", "expired"] as const)("offers sign-in for a %s session", (sessionState) => {
    accountState.sessionState = sessionState;

    const navigate = renderBanner();

    const banner = signedOutBanner();
    expect(banner?.getAttribute("data-banner-id")).toBe(`account-${sessionState}`);

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

    expect(signedOutBanner()).toBeTruthy();
    expect(screen.queryByRole("button", { name: /dismiss/i })).toBeNull();
  });

  it("hides on the account page, where its own action would lead", () => {
    renderBanner("/account");

    expect(signedOutBanner()).toBeNull();
  });
});

/**
 * A signed-in person whose computer the account directory refuses. The repair
 * loop used to give up with only a diagnostic toast, so one install sat
 * removed for a month. The bar must name the date, offer the one button that
 * fixes it, and never say "Sign in again" to someone who is signed in.
 */
describe("AccountSignedOutBanner — this computer refused", () => {
  const originalAde = window.ade;
  const repairMachinePairing = vi.fn();
  const listMachines = vi.fn();
  let health: SyncAccountDirectoryHealth;

  function refusedHealth(overrides: Partial<SyncAccountDirectoryHealth> = {}): SyncAccountDirectoryHealth {
    return createSyncAccountDirectoryHealth("http_error", "This machine was removed from your ADE account.", {
      lastHttpStatus: 403,
      lastHttpReason: "machine_revoked",
      failingSinceMs: 1,
      revokedAt: "2026-08-14T09:30:00.000Z",
      ...overrides,
    });
  }

  beforeEach(() => {
    resetLocalSyncStatusReaderForTests();
    accountState.signedIn = true;
    accountState.sessionState = "active";
    health = refusedHealth();
    window.ade = {
      sync: {
        getLocalStatus: vi.fn(async () => ({ routeHealth: { accountDirectory: health } })),
        onEvent: vi.fn(() => () => {}),
      },
      account: { repairMachinePairing, listMachines, getLocalMachineIdentity: vi.fn(async () => ({ machineKey: "this-key", deviceId: "this-dev" })) },
    } as unknown as typeof window.ade;
    listMachines.mockResolvedValue({ state: "ok", message: null, machines: [] });
  });

  afterEach(() => {
    cleanup();
    accountState.signedIn = false;
    accountState.sessionState = "signed_out";
    window.ade = originalAde;
    repairMachinePairing.mockReset();
    listMachines.mockReset();
    runAccountDeviceLogin.mockReset();
  });

  it("names the removal date and offers Reconnect this computer", async () => {
    renderBanner();

    const banner = await findRefusedBanner();
    const removedOn = new Date("2026-08-14T09:30:00.000Z").toLocaleDateString(undefined, { day: "numeric", month: "long" });
    expect(banner.textContent).toContain(`This computer was removed from your account on ${removedOn}`);
    expect(screen.getByRole("button", { name: "Reconnect this computer" })).toBeTruthy();
    expect(banner.textContent).not.toMatch(/sign in again/i);
    // Lasting, not a toast: nothing to dismiss.
    expect(screen.queryByRole("button", { name: /dismiss/i })).toBeNull();
  });

  it("says the automatic repair stopped once it gave up", async () => {
    health = refusedHealth({ recoveryGaveUpAt: 5 });
    renderBanner();

    const banner = await findRefusedBanner();
    expect(banner.textContent).toContain("ADE stopped trying to reconnect it on its own.");
  });

  it("asks a refused re-pair to confirm it's you, not to sign in again", async () => {
    health = refusedHealth({ lastHttpReason: "pairing_authentication_required" });
    renderBanner();

    const banner = await findRefusedBanner();
    expect(banner.textContent).toContain(
      "This computer needs you to confirm it's you before it can rejoin your account",
    );
    expect(screen.getByRole("button", { name: "Confirm it's you" })).toBeTruthy();
    expect(banner.textContent).not.toMatch(/sign in again/i);
  });

  it("runs the Account page's reconnect flow and shows the browser code", async () => {
    repairMachinePairing.mockResolvedValue({
      repaired: false,
      wasRevoked: true,
      published: false,
      pushRestored: false,
      state: "http_error",
      reason: "Confirm it's you on this computer",
      reasonCode: "pairing_authentication_required",
    });
    let finish!: () => void;
    runAccountDeviceLogin.mockImplementation(async (options: {
      onPrompt?: (prompt: { userCode: string; verificationUri: string; verificationUriComplete: string | null }) => void;
    }) => {
      options.onPrompt?.({ userCode: "WDJB-MJHT", verificationUri: "https://directory.test/device", verificationUriComplete: null });
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { status: "cancelled" as const };
    });
    renderBanner();

    fireEvent.click(await screen.findByRole("button", { name: "Reconnect this computer" }));

    await waitFor(() => expect(repairMachinePairing).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText("Confirm it's you in your browser. If the page asks for a code, enter WDJB-MJHT."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    finish();
    await waitFor(() => expect(screen.getByRole("button", { name: "Reconnect this computer" })).toBeTruthy());
  });

  it("shows Reconnecting… as a disabled action while the attempt runs", async () => {
    let release!: () => void;
    repairMachinePairing.mockReturnValue(new Promise((resolve) => {
      release = () => resolve({
        repaired: true,
        wasRevoked: true,
        published: true,
        pushRestored: true,
        state: "registered",
        reason: null,
      });
    }));
    renderBanner();

    fireEvent.click(await screen.findByRole("button", { name: "Reconnect this computer" }));

    const pending = await screen.findByRole("button", { name: "Reconnecting…" });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(pending);
    expect(repairMachinePairing).toHaveBeenCalledTimes(1);

    release();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Reconnecting…" })).toBeNull());
  });

  it("stays silent for a healthy machine and for a 403 it cannot name", async () => {
    health = createSyncAccountDirectoryHealth("published", null);
    renderBanner();
    await waitFor(() => expect(window.ade.sync.getLocalStatus).toHaveBeenCalled());
    expect(refusedBanner()).toBeNull();
    cleanup();

    resetLocalSyncStatusReaderForTests();
    health = refusedHealth({ lastHttpReason: "forbidden_by_proxy" });
    renderBanner();
    await waitFor(() => expect(window.ade.sync.getLocalStatus).toHaveBeenCalledTimes(2));
    expect(refusedBanner()).toBeNull();
  });

  it("hides on the account page, whose card carries the same button", async () => {
    renderBanner("/account");
    await waitFor(() => expect(window.ade.sync.getLocalStatus).toHaveBeenCalled());
    expect(refusedBanner()).toBeNull();
  });
});
