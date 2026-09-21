/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMachinePairingReconnect } from "./machinePairingReconnect";
import type { AccountDeviceLoginPrompt } from "./accountLogin";
import type { AdeAccountMachinePairingRepairResult, AdeAccountStatus } from "../../shared/types";

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

/** The directory refused the re-pair and wants a fresh sign-in first. */
const NEEDS_SIGN_IN: AdeAccountMachinePairingRepairResult = {
  repaired: false,
  wasRevoked: true,
  published: false,
  pushRestored: false,
  state: "http_error",
  reason: null,
  reasonCode: "pairing_authentication_required",
};

const startDeviceLogin = vi.fn();
const pollDeviceLogin = vi.fn();
const cancelDeviceLogin = vi.fn(async () => SIGNED_IN);
const openExternal = vi.fn(async () => undefined);

function deviceStart() {
  return {
    sessionId: "sess_1",
    userCode: "WDJB-MJHT",
    verificationUri: "https://directory.test/device",
    verificationUriComplete: "https://directory.test/device?user_code=WDJB-MJHT",
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    intervalSec: 0.001,
  };
}

describe("runMachinePairingReconnect device prompt", () => {
  const originalAde = window.ade;
  const originalTimeout = window.setTimeout;

  beforeEach(() => {
    // Collapse the flow's poll floor rather than weakening it in production.
    window.setTimeout = ((fn: () => void) => originalTimeout(fn, 0)) as typeof window.setTimeout;
    window.ade = {
      app: { openExternal },
      account: {
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

  it("marks the prompt as browser-opened when the sign-in page opened", async () => {
    const prompts: AccountDeviceLoginPrompt[] = [];
    await runMachinePairingReconnect({
      repair: async () => NEEDS_SIGN_IN,
      onPrompt: (prompt) => {
        if (prompt) prompts.push(prompt);
      },
      afterAttempt: async () => "unverified",
    });

    expect(openExternal).toHaveBeenCalledWith(
      "https://directory.test/device?user_code=WDJB-MJHT",
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      userCode: "WDJB-MJHT",
      browserOpened: true,
    });
  });

  it("marks the prompt as manual when the browser could not be opened", async () => {
    openExternal.mockRejectedValueOnce(new Error("No application to open the link."));
    const prompts: AccountDeviceLoginPrompt[] = [];
    await runMachinePairingReconnect({
      repair: async () => NEEDS_SIGN_IN,
      onPrompt: (prompt) => {
        if (prompt) prompts.push(prompt);
      },
      afterAttempt: async () => "unverified",
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ browserOpened: false });
    // The URL the manual prompt has to carry is still on the prompt.
    expect(prompts[0]?.verificationUriComplete).toBe(
      "https://directory.test/device?user_code=WDJB-MJHT",
    );
  });
});
