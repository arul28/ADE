/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { AccountDeviceLoginPrompt } from "../lib/accountLogin";

const runAccountDeviceLogin = vi.hoisted(() => vi.fn());
vi.mock("../lib/accountLogin", () => ({
  runAccountDeviceLogin: (options?: unknown) => runAccountDeviceLogin(options),
}));

import { resetReconnectFlowForTests } from "../lib/reconnectThisComputer";
import { reconnectActionView } from "../lib/thisComputerRefusal";
import { useReconnectThisComputer } from "./useReconnectThisComputer";

const PAIRING_REFUSAL = {
  repaired: false,
  wasRevoked: true,
  published: false,
  pushRestored: false,
  state: "http_error",
  reason: "Confirm it's you on this computer",
  reasonCode: "pairing_authentication_required",
};

const PROMPT: AccountDeviceLoginPrompt = {
  userCode: "WDJB-MJHT",
  verificationUri: "https://directory.test/device",
  verificationUriComplete: null,
  browserOpened: true,
};

const repairMachinePairing = vi.fn();
const listMachines = vi.fn();

beforeEach(() => {
  (window as { ade?: unknown }).ade = {
    account: {
      repairMachinePairing,
      listMachines,
      getLocalMachineIdentity: vi.fn(async () => ({ machineKey: "this-key", deviceId: "this-dev" })),
    },
  };
  listMachines.mockResolvedValue({ state: "ok", message: null, machines: [] });
});

afterEach(() => {
  cleanup();
  resetReconnectFlowForTests();
  delete (window as { ade?: unknown }).ade;
  repairMachinePairing.mockReset();
  listMachines.mockReset();
  runAccountDeviceLogin.mockReset();
});

/**
 * The shell banner and the Connections pane can be on screen together. Two
 * separate flows there meant two device logins and two browser tabs for one
 * computer, so the flow is one per window and every button joins it.
 */
describe("useReconnectThisComputer — one flow per window", () => {
  it("joins a running attempt instead of starting a second device login", async () => {
    repairMachinePairing.mockResolvedValue(PAIRING_REFUSAL);
    let finish!: () => void;
    let isCancelled: (() => boolean) | undefined;
    runAccountDeviceLogin.mockImplementation(async (options: {
      onPrompt?: (prompt: AccountDeviceLoginPrompt) => void;
      isCancelled?: () => boolean;
    }) => {
      isCancelled = options.isCancelled;
      options.onPrompt?.(PROMPT);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { status: "cancelled" as const };
    });
    const bannerSettled = vi.fn();
    const paneSettled = vi.fn();
    const banner = renderHook(() => useReconnectThisComputer({ onSettled: bannerSettled }));
    const pane = renderHook(() => useReconnectThisComputer({ onSettled: paneSettled }));

    let first!: Promise<void>;
    act(() => {
      first = banner.result.current.reconnect();
    });
    const promptText = "Confirm it's you in your browser. If the page asks for a code, enter WDJB-MJHT.";
    const idle = { label: "Reconnect this computer" };
    await waitFor(() => expect(pane.result.current.view(idle).detail).toBe(promptText));
    expect(banner.result.current.view(idle)).toMatchObject({ label: "Cancel", detail: promptText });

    let second!: Promise<void>;
    act(() => {
      second = pane.result.current.reconnect();
    });
    expect(second).toBe(first);
    expect(repairMachinePairing).toHaveBeenCalledTimes(1);
    expect(runAccountDeviceLogin).toHaveBeenCalledTimes(1);

    // A Cancel on either surface stops the one browser step.
    act(() => {
      pane.result.current.view(idle).onClick();
    });
    expect(isCancelled?.()).toBe(true);
    expect(banner.result.current.view(idle).label).toBe("Reconnecting…");

    await act(async () => {
      finish();
      await first;
    });
    expect(banner.result.current.reconnecting).toBe(false);
    expect(pane.result.current.reconnecting).toBe(false);
    // Every surface on screen refreshes its own refusal read.
    expect(bannerSettled).toHaveBeenCalledTimes(1);
    expect(paneSettled).toHaveBeenCalledTimes(1);
  });

  it("reports the outcome on every surface that was on screen for the attempt, and not on a later one", async () => {
    repairMachinePairing.mockResolvedValue({
      repaired: false,
      wasRevoked: true,
      published: false,
      pushRestored: false,
      state: "directory_rejected",
      reason: "The account directory did not accept this machine",
    });
    const banner = renderHook(() => useReconnectThisComputer());
    const pane = renderHook(() => useReconnectThisComputer());

    await act(async () => {
      await banner.result.current.reconnect();
    });

    const message =
      "Couldn't reconnect this computer: The account directory did not accept this machine. It's still disconnected from your account.";
    expect(banner.result.current.outcome?.message).toBe(message);
    expect(pane.result.current.outcome?.message).toBe(message);

    // Opened after the attempt ended: it must not announce an old result.
    const later = renderHook(() => useReconnectThisComputer());
    expect(later.result.current.outcome).toBeNull();
  });

  it("refreshes a surface's own machine list even when another surface pressed the button", async () => {
    repairMachinePairing.mockResolvedValue({
      repaired: true,
      wasRevoked: true,
      published: true,
      pushRestored: true,
      state: "registered",
      reason: null,
    });
    const cardLoad = vi.fn(async () => ({ state: "ok" as const, message: null, machines: [] }));
    renderHook(() => useReconnectThisComputer({ reloadMachines: cardLoad }));
    const pane = renderHook(() => useReconnectThisComputer());

    await act(async () => {
      await pane.result.current.reconnect();
    });

    expect(cardLoad).toHaveBeenCalledTimes(1);
    expect(listMachines).toHaveBeenCalledTimes(1);
  });
});

describe("resetReconnectFlowForTests", () => {
  it("frees the next test from an attempt that never ended", async () => {
    repairMachinePairing.mockReturnValueOnce(new Promise(() => {}));
    const first = renderHook(() => useReconnectThisComputer());
    act(() => {
      void first.result.current.reconnect();
    });
    expect(first.result.current.reconnecting).toBe(true);
    cleanup();
    resetReconnectFlowForTests();

    repairMachinePairing.mockResolvedValue({
      repaired: true,
      wasRevoked: false,
      published: true,
      pushRestored: false,
      state: "registered",
      reason: null,
    });
    const next = renderHook(() => useReconnectThisComputer());
    expect(next.result.current.reconnecting).toBe(false);
    await act(async () => {
      await next.result.current.reconnect();
    });
    expect(repairMachinePairing).toHaveBeenCalledTimes(2);
    expect(next.result.current.outcome?.message).toBe("This computer is already connected to your account.");
  });
});

describe("reconnectActionView", () => {
  const handlers = { reconnect: vi.fn(), cancel: vi.fn() };
  const idle = { label: "Reconnect this computer", detail: "Your other devices can't reach it." };

  it("offers the surface's own button while idle", () => {
    const view = reconnectActionView({ reconnecting: false, signInPrompt: null, outcome: null }, idle, handlers);
    expect(view).toMatchObject({
      label: "Reconnect this computer",
      detail: "Your other devices can't reach it.",
      disabled: false,
      busy: false,
      cancels: false,
    });
    expect(view.onClick).toBe(handlers.reconnect);
  });

  it("shows a disabled Reconnecting… while the attempt runs", () => {
    const view = reconnectActionView({ reconnecting: true, signInPrompt: null, outcome: null }, idle, handlers);
    expect(view).toMatchObject({ label: "Reconnecting…", disabled: true, busy: true, cancels: false });
    expect(view.detail).toBe("Your other devices can't reach it.");
  });

  it("offers Cancel with the browser code during the browser step", () => {
    const view = reconnectActionView({ reconnecting: true, signInPrompt: PROMPT, outcome: null }, idle, handlers);
    expect(view).toMatchObject({
      label: "Cancel",
      detail: "Confirm it's you in your browser. If the page asks for a code, enter WDJB-MJHT.",
      disabled: false,
      cancels: true,
    });
    expect(view.onClick).toBe(handlers.cancel);
  });

  it("keeps the button after a failure and says why", () => {
    const view = reconnectActionView(
      { reconnecting: false, signInPrompt: null, outcome: { tone: "danger", message: "The directory is down." } },
      idle,
      handlers,
    );
    expect(view).toMatchObject({ label: "Reconnect this computer", detail: "The directory is down.", disabled: false });
    expect(view.onClick).toBe(handlers.reconnect);
  });

  it("leaves a success to the surface, which usually disappears with the refusal", () => {
    const view = reconnectActionView(
      { reconnecting: false, signInPrompt: null, outcome: { tone: "success", message: "Back." } },
      idle,
      handlers,
    );
    expect(view.detail).toBe("Your other devices can't reach it.");
  });
});
