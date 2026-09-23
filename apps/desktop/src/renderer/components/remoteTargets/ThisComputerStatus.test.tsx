// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetReconnectFlowForTests } from "../../lib/reconnectThisComputer";
import { reconnectBrowserPromptText } from "../../lib/thisComputerRefusal";
import { ThisComputerStatus } from "./ThisComputerStatus";

const appMock = {
  writeClipboardText: vi.fn(async () => undefined),
  getInfo: vi.fn(),
  restartBackgroundService: vi.fn(),
  openExternal: vi.fn(async () => undefined),
};

const accountMock = {
  repairMachinePairing: vi.fn(),
  startSyncHost: vi.fn(),
  startDeviceLogin: vi.fn(),
  pollDeviceLogin: vi.fn(),
  cancelDeviceLogin: vi.fn(async () => ({})),
};

const syncMock = {
  getStatus: vi.fn(async () => ({ routeHealth: { accountDirectory: null } })),
  onEvent: vi.fn(() => () => {}),
};

function installAdeMock(
  publishHealth: Record<string, unknown> | null,
  accountDirectory: Record<string, unknown> | null = null,
): void {
  syncMock.getStatus.mockResolvedValue({ routeHealth: { accountDirectory } } as never);
  appMock.getInfo.mockResolvedValue({ localRuntime: publishHealth ? { publishHealth } : null });
  accountMock.repairMachinePairing.mockResolvedValue({
    repaired: false,
    wasRevoked: true,
    published: false,
    pushRestored: false,
    state: "not_revoked",
    reason: null,
  });
  Object.defineProperty(window, "ade", {
    configurable: true,
    value: { app: appMock, account: accountMock, sync: syncMock },
  });
}

function refusal(lastHttpReason: string) {
  return {
    state: "http_error",
    failingSinceMs: Date.now() - 5 * 60_000,
    lastLegDurations: { snapshot: null, token: null, http: null },
    lastHttpStatus: 403,
    lastHttpReason,
  };
}

afterEach(() => {
  cleanup();
  resetReconnectFlowForTests();
  vi.clearAllMocks();
});

describe("ThisComputerStatus", () => {
  it("names the removal and offers one Reconnect button when the directory revoked this machine", async () => {
    installAdeMock(refusal("machine_revoked"));
    accountMock.repairMachinePairing.mockResolvedValue({
      repaired: true,
      wasRevoked: true,
      published: true,
      pushRestored: true,
      state: "registered",
      reason: null,
    });

    render(<ThisComputerStatus accountSignedIn />);

    expect(await screen.findByText("This computer was removed from your ADE account")).toBeTruthy();
    // The directory answered; "couldn't publish it" would be a lie.
    expect(screen.queryByText(/couldn't publish it/)).toBeNull();
    const card = screen.getByText("This computer was removed from your ADE account")
      .closest("[data-this-computer-card]") as HTMLElement;
    // One owner, one button.
    expect(within(card).getAllByRole("button")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Reconnect this computer" }));
    await waitFor(() => expect(accountMock.repairMachinePairing).toHaveBeenCalledTimes(1));
  });

  it("says Confirm it's you, never Sign in again, when the directory wants fresh proof", async () => {
    installAdeMock(refusal("pairing_authentication_required"));
    render(<ThisComputerStatus accountSignedIn />);
    expect(await screen.findByRole("button", { name: "Confirm it's you" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull();
  });

  it("uses the shared reconnect wording, removal date included, when this machine's sync snapshot names the refusal", async () => {
    const revoked = {
      ...refusal("machine_revoked"),
      revokedAt: "2026-08-14T03:46:07.933Z",
      recoveryGaveUpAt: null,
    };
    installAdeMock(revoked, revoked);
    render(<ThisComputerStatus accountSignedIn />);
    expect(await screen.findByText(/^This computer was removed from your account on .*1[34]/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect this computer" })).toBeTruthy();
  });

  it("shows the shared flow's browser line with Cancel while the sign-in runs, never Done", async () => {
    installAdeMock(refusal("pairing_authentication_required"));
    accountMock.repairMachinePairing.mockResolvedValue({
      repaired: false,
      wasRevoked: true,
      published: false,
      pushRestored: false,
      state: "http_error",
      reason: null,
      reasonCode: "pairing_authentication_required",
    });
    accountMock.startDeviceLogin.mockResolvedValue({
      sessionId: "sess_1",
      userCode: "WDJB-MJHT",
      verificationUri: "https://directory.test/device",
      verificationUriComplete: "https://directory.test/device?user_code=WDJB-MJHT",
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      intervalSec: 60,
    });
    // The prompt is what is under test; never let a poll resolve into it.
    accountMock.pollDeviceLogin.mockReturnValue(new Promise(() => {}));

    render(<ThisComputerStatus accountSignedIn />);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm it's you" }));

    expect(await screen.findByText(reconnectBrowserPromptText("WDJB-MJHT"))).toBeTruthy();
    const card = screen.getByText(reconnectBrowserPromptText("WDJB-MJHT"))
      .closest("[data-this-computer-card]") as HTMLElement;
    const labels = within(card).getAllByRole("button").map((button) => button.textContent);
    expect(labels).toEqual(["Cancel"]);
    expect(labels).not.toContain("Done");
  });

  it("offers Repair only for an unreadable brain session, and clears when the brain recovers", async () => {
    installAdeMock({
      state: "token_unreadable",
      failingSinceMs: Date.now() - 5 * 60_000,
      lastLegDurations: { snapshot: null, token: null, http: null },
    });
    appMock.restartBackgroundService.mockResolvedValue(undefined);

    render(<ThisComputerStatus accountSignedIn={false} />);
    const repair = await screen.findByRole("button", { name: "Repair" });

    appMock.getInfo.mockResolvedValue({ localRuntime: null });
    fireEvent.click(repair);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Repair" })).toBeNull());
    expect(appMock.restartBackgroundService).toHaveBeenCalledTimes(1);
  });

  it("offers Retry, not Repair, for a plain failure a restart cannot help", async () => {
    installAdeMock({
      state: "http_error",
      failingSinceMs: Date.now() - 5 * 60_000,
      lastLegDurations: { snapshot: null, token: null, http: null },
      lastHttpStatus: 502,
      lastHttpReason: null,
    });
    render(<ThisComputerStatus accountSignedIn />);
    expect(await screen.findByText(/Can't reach your ADE account right now/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Repair" })).toBeNull();
  });

  it("offers Start sync when sync has not started, and reports the brain's answer", async () => {
    installAdeMock({
      state: "sync_not_started",
      // Set by the brain to when it first found no host; a boot-time blip
      // under the alarm threshold renders nothing.
      failingSinceMs: Date.now() - 5 * 60_000,
      lastLegDurations: { snapshot: null, token: null, http: null },
    });
    accountMock.startSyncHost.mockResolvedValue({ ok: true, state: "ready", message: "ok" });

    render(<ThisComputerStatus accountSignedIn />);
    expect(await screen.findByText("Sync hasn't started on this computer yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start sync" }));

    await waitFor(() => expect(accountMock.startSyncHost).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Sync is running on this computer.")).toBeTruthy();
    expect(accountMock.repairMachinePairing).not.toHaveBeenCalled();
  });

  it("renders nothing while signed out and the brain can read its session", async () => {
    installAdeMock(refusal("machine_revoked"));
    const { container } = render(<ThisComputerStatus accountSignedIn={false} />);
    await waitFor(() => expect(appMock.getInfo).toHaveBeenCalled());
    expect(container.querySelector("[data-this-computer-card]")).toBeNull();
  });
});
