/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AccountPage, SignInCard, reconnectNeedsFreshSignIn } from "./AccountPage";
import { PAIRING_REAUTHENTICATION_REQUIRED_MESSAGE } from "../../../../../ade-cli/src/services/account/accountMachinePublisherService";
import { docs } from "../../onboarding/docsLinks";
import type { AdeAccountMachine, AdeAccountStatus } from "../../../shared/types";
import { THIS_MACHINE_NAME } from "../../../shared/machineIdentity";

const beginLogin = vi.fn(async () => undefined);
const refreshAccount = vi.fn(async () => SIGNED_OUT);
const runAccountDeviceLogin = vi.fn();

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
  runAccountDeviceLogin: (options?: {
    onPrompt?: (prompt: { userCode: string; verificationUri: string; verificationUriComplete: string | null }) => void;
    isCancelled?: () => boolean;
  }) => runAccountDeviceLogin(options),
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
    delete window.__adeWebClient;
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
    delete window.__adeWebClient;
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
  const renameMachine = vi.fn(async (machineKey: string, customName: string | null) =>
    machine({ machineKey, deviceId: "this-dev", name: "MacBook Pro", customName }),
  );
  const signOut = vi.fn(async () => SIGNED_OUT);
  const repairMachinePairing = vi.fn();

  /** The directory answers `ok` but has no row for this computer — i.e. removed. */
  function machinesWithoutThisComputer() {
    listMachines.mockResolvedValue({
      state: "ok",
      message: null,
      machines: [machine({ machineKey: "studio-key", deviceId: "studio-dev", name: "Studio" })],
    });
  }

  beforeEach(() => {
    delete window.__adeWebClient;
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
      account: {
        listMachines,
        getLocalMachineIdentity,
        removeMachine,
        renameMachine,
        repairMachinePairing,
        signOut,
      },
    } as unknown as typeof window.ade;
    repairMachinePairing.mockResolvedValue({
      repaired: true,
      wasRevoked: true,
      published: true,
      pushRestored: true,
      state: "registered",
      reason: null,
    });
  });

  afterEach(() => {
    cleanup();
    delete window.__adeWebClient;
    listMachines.mockReset();
    getLocalMachineIdentity.mockReset();
    removeMachine.mockClear();
    renameMachine.mockClear();
    repairMachinePairing.mockReset();
    runAccountDeviceLogin.mockReset();
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

  it("pins this computer first with a badge and offers rename but never removal", async () => {
    renderPage();
    await screen.findByText("MacBook Pro");

    const rows = screen.getAllByText(/MacBook Pro|Studio/);
    expect(rows[0].textContent).toBe("MacBook Pro");
    // Composed from THIS_MACHINE_NAME, never spelled out: this badge was
    // macOS-only copy ("This Mac") until ADE shipped on Windows, and pinning the
    // literal here is what let Settings and Account miss the rename.
    expect(screen.getByText(THIS_MACHINE_NAME)).toBeTruthy();

    // This list is the only place the local machine appears, so it is the only
    // place its name can be changed — but removal stays withheld for it.
    fireEvent.click(screen.getByRole("button", { name: /Options for MacBook Pro/ }));
    expect(screen.getByRole("menuitem", { name: /Rename/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Remove from account/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    // Another computer can be both renamed and evicted.
    fireEvent.click(screen.getByRole("button", { name: /Options for Studio/ }));
    expect(screen.getByRole("menuitem", { name: /Rename/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Remove from account/ })).toBeTruthy();
  });

  it("renames this computer through the account directory", async () => {
    renderPage();
    await screen.findByText("MacBook Pro");

    fireEvent.click(screen.getByRole("button", { name: /Options for MacBook Pro/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Rename/ }));

    const input = screen.getByLabelText(/Name for MacBook Pro/);
    fireEvent.change(input, { target: { value: "Arul's PC" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // The local machine goes through the same bridge call as a remote peer;
    // there is no second rename mechanism to keep in sync.
    await waitFor(() =>
      expect(renameMachine).toHaveBeenCalledWith("this-key", "Arul's PC"),
    );
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
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /Rename/ })),
    );

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("removes another computer only after confirmation", async () => {
    renderPage();
    await screen.findByText("Studio");

    fireEvent.click(screen.getByRole("button", { name: /Options for Studio/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Remove from account/ }));

    const dialog = screen.getByRole("dialog");
    // The sheet names the machine being removed. "This computer" would collide
    // with the local-machine badge, and removal never targets the local machine.
    expect(within(dialog).getByText(/Remove Studio from your account\?/)).toBeTruthy();
    expect(dialog.textContent).not.toContain(THIS_MACHINE_NAME);

    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(removeMachine).toHaveBeenCalledWith("studio-key"));
  });

  it("signs out only after the honest confirmation", async () => {
    renderPage();
    await screen.findByText("MacBook Pro");

    expect(screen.getByText("Signed in on this computer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(
        "Signing out removes this computer's access to your account and its account-connected machines. Devices paired directly with a code stay connected.",
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

  it("does not offer the desktop Connections panel in hosted web mode", async () => {
    window.__adeWebClient = true;
    renderPage();
    await screen.findByText("MacBook Pro");

    expect(screen.queryByRole("button", { name: /Manage connections/ })).toBeNull();
  });

  // Removal revokes the machine durably: it cannot resurrect itself through its
  // own heartbeat, and restarting, signing out and in, or reinstalling all
  // leave it removed. These tests cover the only way back.
  it("offers a reconnect when this computer is missing from its own account directory", async () => {
    machinesWithoutThisComputer();
    renderPage();

    expect(await screen.findByText("This computer isn't on your account")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect this computer" }));

    await waitFor(() => expect(repairMachinePairing).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText(
        "This computer is back on your account. Activity and alerts are delivering again.",
      ),
    ).toBeTruthy();
  });

  it("shows the brain's reason and says the computer is still disconnected on failure", async () => {
    machinesWithoutThisComputer();
    repairMachinePairing.mockResolvedValue({
      repaired: false,
      wasRevoked: true,
      published: false,
      pushRestored: false,
      state: "directory_rejected",
      reason: "The account directory did not accept this machine",
    });
    renderPage();
    await screen.findByText("This computer isn't on your account");

    fireEvent.click(screen.getByRole("button", { name: "Reconnect this computer" }));

    expect(
      await screen.findByText(
        "Couldn't reconnect this computer: The account directory did not accept this machine. It's still disconnected from your account.",
      ),
    ).toBeTruthy();
    // A rejected re-pair leaves the push gate latched on purpose; claiming
    // success here is the failure this whole path exists to prevent.
    expect(screen.queryByText(/back on your account\./)).toBeNull();
  });

  it("never calls a half-restored machine reconnected", async () => {
    machinesWithoutThisComputer();
    // The directory took the machine back, but the push half did not lift — it
    // is on the roster and delivering nothing.
    repairMachinePairing.mockResolvedValue({
      repaired: true,
      wasRevoked: true,
      published: true,
      pushRestored: false,
      state: "registered",
      reason: null,
    });
    renderPage();
    await screen.findByText("This computer isn't on your account");

    fireEvent.click(screen.getByRole("button", { name: "Reconnect this computer" }));

    expect(
      await screen.findByText(
        "This computer is back on your account, but it isn't delivering Activity yet. Reopen ADE on this computer to finish.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/delivering again/)).toBeNull();
  });

  it("blocks a second reconnect while the first is still in flight", async () => {
    machinesWithoutThisComputer();
    let release!: () => void;
    const pendingRepair = new Promise((resolve) => {
      release = () =>
        resolve({
          repaired: true,
          wasRevoked: true,
          published: true,
          pushRestored: true,
          state: "registered",
          reason: null,
        });
    });
    repairMachinePairing.mockReturnValue(pendingRepair);
    renderPage();
    await screen.findByText("This computer isn't on your account");

    fireEvent.click(screen.getByRole("button", { name: "Reconnect this computer" }));
    const pending = await screen.findByRole("button", { name: "Reconnecting…" });
    expect(pending.hasAttribute("disabled")).toBe(true);

    fireEvent.click(pending);
    expect(repairMachinePairing).toHaveBeenCalledTimes(1);

    release();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Reconnect this computer" })).toBeTruthy(),
    );
  });

  it("keeps reconnect reachable from this computer's menu when detection cannot fire", async () => {
    renderPage();
    await screen.findByText("MacBook Pro");
    // This computer IS on the directory, so no banner — but the action stays
    // available for the cases detection cannot see (failed directory read, an
    // account with no rows yet).
    expect(screen.queryByText("This computer isn't on your account")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Options for MacBook Pro/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Reconnect this computer" }));
    await waitFor(() => expect(repairMachinePairing).toHaveBeenCalledTimes(1));
  });

  // The directory refuses a re-pair without proof of a fresh interactive
  // sign-in, and it can only observe — and therefore only prove — its own
  // `/device/*` flow. The desktop's normal sign-in is a loopback PKCE flow
  // straight to the issuer, so escalating to it here would hand the user back
  // the same refusal they just tried to act on.
  const REAUTHENTICATION_REFUSAL = {
    repaired: false,
    wasRevoked: true,
    published: false,
    pushRestored: false,
    state: "http_error",
    reason: PAIRING_REAUTHENTICATION_REQUIRED_MESSAGE,
  };

  it("decides on the brain's reason code, not the sentence", () => {
    // The code is what drives the recovery. Both refusals share
    // `state: "http_error"`, so this is the only real discriminator.
    expect(
      reconnectNeedsFreshSignIn({
        ...REAUTHENTICATION_REFUSAL,
        reasonCode: "pairing_authentication_required",
      }),
    ).toBe(true);
    expect(
      reconnectNeedsFreshSignIn({
        ...REAUTHENTICATION_REFUSAL,
        reasonCode: "machine_revoked",
        reason: "This machine was removed from your ADE account. Pair it again to reconnect.",
      }),
    ).toBe(false);
    // A present code is authoritative in BOTH directions: reworded copy cannot
    // switch the recovery off, and a re-auth-shaped sentence cannot switch it on
    // when the directory said the machine is simply revoked.
    expect(
      reconnectNeedsFreshSignIn({
        ...REAUTHENTICATION_REFUSAL,
        reasonCode: "pairing_authentication_required",
        reason: "Some completely rewritten copy that mentions nothing familiar.",
      }),
    ).toBe(true);
    expect(
      reconnectNeedsFreshSignIn({
        ...REAUTHENTICATION_REFUSAL,
        reasonCode: "machine_revoked",
        reason: PAIRING_REAUTHENTICATION_REQUIRED_MESSAGE,
      }),
    ).toBe(false);
    // An unrecognised code from a newer brain fails closed rather than guessing.
    expect(
      reconnectNeedsFreshSignIn({
        ...REAUTHENTICATION_REFUSAL,
        reasonCode: "pairing_grant_expired",
        reason: PAIRING_REAUTHENTICATION_REQUIRED_MESSAGE,
      }),
    ).toBe(false);
    // A repaired result is never a refusal, whatever else it carries.
    expect(
      reconnectNeedsFreshSignIn({
        ...REAUTHENTICATION_REFUSAL,
        repaired: true,
        reasonCode: "pairing_authentication_required",
      }),
    ).toBe(false);
  });

  // COMPATIBILITY SHIM COVERAGE — delete alongside the shim once every
  // supported brain sends `reasonCode`.
  it("falls back to the sentence when an older brain sends no reason code", () => {
    expect(REAUTHENTICATION_REFUSAL).not.toHaveProperty("reasonCode");
    expect(reconnectNeedsFreshSignIn(REAUTHENTICATION_REFUSAL)).toBe(true);
    // A null code is the same "unknown" as an absent one — the main-process
    // reader normalises missing to null — so it must not read as a negative.
    expect(
      reconnectNeedsFreshSignIn({ ...REAUTHENTICATION_REFUSAL, reasonCode: null }),
    ).toBe(true);
    // Fails closed: an unrecognised failure is reported, not escalated.
    expect(
      reconnectNeedsFreshSignIn({
        ...REAUTHENTICATION_REFUSAL,
        reason: "The account directory did not accept this machine.",
      }),
    ).toBe(false);
    expect(reconnectNeedsFreshSignIn({ ...REAUTHENTICATION_REFUSAL, reason: null })).toBe(false);
    expect(
      reconnectNeedsFreshSignIn({ ...REAUTHENTICATION_REFUSAL, repaired: true }),
    ).toBe(false);
  });

  it("signs in through the device flow when the directory demands fresh proof", async () => {
    machinesWithoutThisComputer();
    repairMachinePairing.mockResolvedValue(REAUTHENTICATION_REFUSAL);
    runAccountDeviceLogin.mockImplementation(async (options?: {
      onPrompt?: (prompt: { userCode: string; verificationUri: string; verificationUriComplete: string | null }) => void;
    }) => {
      options?.onPrompt?.({
        userCode: "WDJB-MJHT",
        verificationUri: "https://directory.test/device",
        verificationUriComplete: "https://directory.test/device?user_code=WDJB-MJHT",
      });
      // The brain re-pairs on its own when an interactive sign-in completes
      // while this machine is revoked, so the directory now lists it again.
      listMachines.mockResolvedValue({
        state: "ok",
        message: null,
        machines: [
          machine({ machineKey: "studio-key", deviceId: "studio-dev", name: "Studio" }),
          machine({ machineKey: "this-key", deviceId: "this-dev", name: "MacBook Pro", online: true }),
        ],
      });
      return { status: "signed_in", authStatus: statusRef.current };
    });
    renderPage();
    await screen.findByText("This computer isn't on your account");

    fireEvent.click(screen.getByRole("button", { name: "Reconnect this computer" }));

    await waitFor(() => expect(runAccountDeviceLogin).toHaveBeenCalledTimes(1));
    // The loopback sign-in the card uses is never reached from this path.
    expect(beginLogin).not.toHaveBeenCalled();
    expect(
      await screen.findByText(
        "This computer is back on your account. Activity and alerts are delivering again.",
      ),
    ).toBeTruthy();
    // The brain's own post-sign-in repair is the follow-through. A second
    // repair here would re-publish a pairing the grant can no longer prove.
    expect(repairMachinePairing).toHaveBeenCalledTimes(1);
    // And the user never had to press Reconnect again.
    expect(screen.queryByText("This computer isn't on your account")).toBeNull();
  });

  it("names the code while the browser sign-in is in flight, and can be cancelled", async () => {
    machinesWithoutThisComputer();
    repairMachinePairing.mockResolvedValue(REAUTHENTICATION_REFUSAL);
    let cancelled: (() => boolean) | undefined;
    let finish!: () => void;
    runAccountDeviceLogin.mockImplementation(async (options?: {
      onPrompt?: (prompt: { userCode: string; verificationUri: string; verificationUriComplete: string | null }) => void;
      isCancelled?: () => boolean;
    }) => {
      cancelled = options?.isCancelled;
      options?.onPrompt?.({
        userCode: "WDJB-MJHT",
        verificationUri: "https://directory.test/device",
        verificationUriComplete: null,
      });
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { status: "cancelled" as const };
    });
    renderPage();
    await screen.findByText("This computer isn't on your account");

    fireEvent.click(screen.getByRole("button", { name: "Reconnect this computer" }));

    expect(
      await screen.findByText(/Finish signing in in your browser to reconnect this computer/),
    ).toBeTruthy();
    expect(screen.getByText("WDJB-MJHT")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Signing in…" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancelled?.()).toBe(true);

    finish();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Reconnect this computer" })).toBeTruthy(),
    );
    // A cancelled sign-in states nothing; the banner already says what is wrong.
    expect(screen.queryByText(/back on your account/)).toBeNull();
  });

  it("says the sign-in landed but the reconnect did not, when the directory still omits it", async () => {
    machinesWithoutThisComputer();
    repairMachinePairing.mockResolvedValue(REAUTHENTICATION_REFUSAL);
    runAccountDeviceLogin.mockResolvedValue({
      status: "signed_in",
      authStatus: statusRef.current,
    });
    renderPage();
    await screen.findByText("This computer isn't on your account");

    fireEvent.click(screen.getByRole("button", { name: "Reconnect this computer" }));

    expect(
      await screen.findByText(
        "You're signed in, but this computer still isn't on your account. Try reconnecting it again.",
      ),
    ).toBeTruthy();
  });

  it("never opens a browser for a failure a sign-in would not fix", async () => {
    machinesWithoutThisComputer();
    repairMachinePairing.mockResolvedValue({
      repaired: false,
      wasRevoked: true,
      published: false,
      pushRestored: false,
      state: "transport_error",
      reason: "The account directory could not be reached",
    });
    renderPage();
    await screen.findByText("This computer isn't on your account");

    fireEvent.click(screen.getByRole("button", { name: "Reconnect this computer" }));

    await screen.findByText(
      "Couldn't reconnect this computer: The account directory could not be reached. It's still disconnected from your account.",
    );
    expect(runAccountDeviceLogin).not.toHaveBeenCalled();
  });

  it("does not offer to reconnect a hosted browser, which owns no machine identity", async () => {
    window.__adeWebClient = true;
    machinesWithoutThisComputer();
    // The web adapter reports a blank identity, so every row is "not this
    // machine" — without the web guard the banner would fire on every session.
    getLocalMachineIdentity.mockResolvedValue({ machineKey: "", deviceId: "" });
    renderPage();
    await screen.findByText("Studio");

    expect(screen.queryByText("This computer isn't on your account")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Options for Studio/ }));
    expect(screen.queryByRole("menuitem", { name: "Reconnect this computer" })).toBeNull();
  });

  it("directs hosted web users to the machine menu when the directory is unavailable", async () => {
    window.__adeWebClient = true;
    listMachines.mockResolvedValueOnce({ state: "unavailable", message: null, machines: [] });

    renderPage();

    expect(await screen.findByText("Use the machine menu above to switch computers.")).toBeTruthy();
    expect(screen.queryByText(/still connect from Connections/)).toBeNull();
  });
});
