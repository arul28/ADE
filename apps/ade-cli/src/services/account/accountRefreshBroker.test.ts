import { describe, expect, it, vi } from "vitest";
import { AccountRefreshUnavailableError } from "./accountAuthService";
import { createAccountRefreshBroker } from "./accountRefreshBroker";

describe("account refresh broker policy", () => {
  it("unwraps and trims a token without forwarding refresh options", async () => {
    const requestToken = vi.fn(async () => ({
      domain: "account",
      action: "getToken",
      result: "  token-from-brain  ",
    }));
    const broker = createAccountRefreshBroker({ requestToken });

    await expect(broker.getAccessToken({ forceRefresh: true })).resolves.toBe("token-from-brain");
    expect(requestToken).toHaveBeenCalledWith();
  });

  it("returns null when the transport probe cannot reach the brain", async () => {
    const requestToken = vi.fn(async () => "must-not-run");
    const broker = createAccountRefreshBroker({
      isReachable: async () => false,
      requestToken,
    });

    await expect(broker.getAccessToken({ forceRefresh: false })).resolves.toBeNull();
    expect(requestToken).not.toHaveBeenCalled();
  });

  it("maps transport and empty-token failures to transient unavailability", async () => {
    const broker = createAccountRefreshBroker({
      requestToken: async () => {
        throw new Error("socket closed");
      },
    });
    await expect(broker.getAccessToken({ forceRefresh: false })).rejects.toMatchObject({
      name: "AccountRefreshUnavailableError",
      transient: true,
    });

    const empty = createAccountRefreshBroker({ requestToken: async () => "  " });
    await expect(empty.getAccessToken({ forceRefresh: false })).rejects.toBeInstanceOf(
      AccountRefreshUnavailableError,
    );
  });
});
