/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAccountDeviceLogin } from "./accountLogin";
import type { AdeAccountStatus } from "../../shared/types";

const SIGNED_IN: AdeAccountStatus = {
  signedIn: true,
  configured: true,
  userId: "user_1",
  email: "ada@example.com",
  name: "Ada Lovelace",
  expiresAt: null,
  provider: "google",
  imageUrl: null,
};

const openExternal = vi.fn(async () => undefined);
const startLogin = vi.fn();
const pollLogin = vi.fn();
const startDeviceLogin = vi.fn();
const pollDeviceLogin = vi.fn();
const cancelDeviceLogin = vi.fn(async () => SIGNED_IN);

function deviceStart(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "sess_1",
    userCode: "WDJB-MJHT",
    verificationUri: "https://directory.test/device",
    verificationUriComplete: "https://directory.test/device?user_code=WDJB-MJHT",
    // Far enough out that the deadline never decides a test.
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    // Poll immediately; the flow's own floor is what is under test elsewhere.
    intervalSec: 0.001,
    ...overrides,
  };
}

describe("runAccountDeviceLogin", () => {
  const originalAde = window.ade;
  const originalTimeout = window.setTimeout;

  beforeEach(() => {
    // The flow clamps its poll interval to a one-second floor so it cannot spin
    // the directory; collapse real waiting rather than weakening that floor.
    window.setTimeout = ((fn: () => void) => originalTimeout(fn, 0)) as typeof window.setTimeout;
    window.ade = {
      app: { openExternal },
      account: {
        startLogin,
        pollLogin,
        cancelLogin: vi.fn(),
        startDeviceLogin,
        pollDeviceLogin,
        cancelDeviceLogin,
      },
    } as unknown as typeof window.ade;
    startDeviceLogin.mockResolvedValue(deviceStart());
    pollDeviceLogin.mockResolvedValue({
      status: "signed_in",
      message: null,
      intervalSec: null,
      authStatus: SIGNED_IN,
    });
  });

  afterEach(() => {
    window.setTimeout = originalTimeout;
    window.ade = originalAde;
    vi.clearAllMocks();
  });

  /**
   * The reason this flow exists. `startLogin`'s loopback PKCE goes straight to
   * the issuer, so ADE's account directory never observes it and can never mint
   * the pairing grant a removed machine needs to re-join.
   */
  it("asks the directory-observed device flow, never the loopback flow", async () => {
    const outcome = await runAccountDeviceLogin();

    expect(startDeviceLogin).toHaveBeenCalledTimes(1);
    expect(startLogin).not.toHaveBeenCalled();
    expect(pollLogin).not.toHaveBeenCalled();
    expect(outcome).toEqual({ status: "signed_in", authStatus: SIGNED_IN });
  });

  it("opens the pre-filled page so the sign-in costs one Continue click", async () => {
    const prompts: string[] = [];
    await runAccountDeviceLogin({ onPrompt: (prompt) => prompts.push(prompt.userCode) });

    expect(openExternal).toHaveBeenCalledWith(
      "https://directory.test/device?user_code=WDJB-MJHT",
    );
    // The code is still surfaced, for a page that opened without it.
    expect(prompts).toEqual(["WDJB-MJHT"]);
  });

  it("falls back to the bare verification URI when no pre-filled one is offered", async () => {
    startDeviceLogin.mockResolvedValue(deviceStart({ verificationUriComplete: null }));

    await runAccountDeviceLogin();

    expect(openExternal).toHaveBeenCalledWith("https://directory.test/device");
  });

  it("keeps waiting through a pending answer and honours the directory's backoff", async () => {
    pollDeviceLogin
      .mockResolvedValueOnce({ status: "pending", message: null, intervalSec: 1, authStatus: SIGNED_IN })
      .mockResolvedValueOnce({ status: "signed_in", message: null, intervalSec: null, authStatus: SIGNED_IN });

    const outcome = await runAccountDeviceLogin();

    expect(pollDeviceLogin).toHaveBeenCalledTimes(2);
    expect(outcome.status).toBe("signed_in");
  });

  it("treats a transient IPC throw as a hiccup, not a failed sign-in", async () => {
    pollDeviceLogin
      .mockRejectedValueOnce(new Error("IPC channel closed"))
      .mockResolvedValueOnce({ status: "signed_in", message: null, intervalSec: null, authStatus: SIGNED_IN });

    expect((await runAccountDeviceLogin()).status).toBe("signed_in");
  });

  it("surfaces the directory's own message when the sign-in is refused", async () => {
    pollDeviceLogin.mockResolvedValue({
      status: "error",
      message: "That code was already used.",
      intervalSec: null,
      authStatus: SIGNED_IN,
    });

    expect(await runAccountDeviceLogin()).toEqual({
      status: "failed",
      message: "That code was already used.",
    });
  });

  it("abandons the daemon-held session when the caller cancels", async () => {
    let cancelled = false;
    pollDeviceLogin.mockImplementation(async () => {
      cancelled = true;
      return { status: "pending", message: null, intervalSec: null, authStatus: SIGNED_IN };
    });

    const outcome = await runAccountDeviceLogin({ isCancelled: () => cancelled });

    expect(outcome).toEqual({ status: "cancelled" });
    expect(cancelDeviceLogin).toHaveBeenCalledWith({ sessionId: "sess_1" });
  });

  it("says so plainly on a build with no device flow rather than hanging", async () => {
    window.ade = {
      app: { openExternal },
      account: { startLogin, pollLogin, cancelLogin: vi.fn() },
    } as unknown as typeof window.ade;

    expect(await runAccountDeviceLogin()).toEqual({
      status: "failed",
      message: "Signing in again on this computer isn't available on this build.",
    });
    expect(startLogin).not.toHaveBeenCalled();
  });

  it("reports a refused start with main's copy, and opens nothing", async () => {
    startDeviceLogin.mockRejectedValue(
      new Error("ADE's background service isn't running on this computer, so it can't sign in."),
    );

    expect(await runAccountDeviceLogin()).toEqual({
      status: "failed",
      message: "ADE's background service isn't running on this computer, so it can't sign in.",
    });
    expect(openExternal).not.toHaveBeenCalled();
  });
});
