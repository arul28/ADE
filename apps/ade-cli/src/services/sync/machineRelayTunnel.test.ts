import { describe, expect, it, vi } from "vitest";
import type { AccountAuthStatus } from "../account/accountAuthService";
import { createMachineRelayAccountLease } from "./machineRelayTunnel";

const signedIn: AccountAuthStatus = {
  signedIn: true,
  userId: "user_1",
  expiresAt: "2026-08-06T00:00:00.000Z",
  sessionState: "active",
} as AccountAuthStatus;

const expired: AccountAuthStatus = {
  signedIn: false,
  userId: null,
  expiresAt: null,
  sessionState: "expired",
} as AccountAuthStatus;

const signedOut: AccountAuthStatus = {
  signedIn: false,
  userId: null,
  expiresAt: null,
  sessionState: "signed_out",
} as AccountAuthStatus;

describe("createMachineRelayAccountLease", () => {
  it("keeps the lease when refreshing the token THROWS and the owner is retained", async () => {
    // The 2026-08-05 shape: a dead refresh grant does not merely blank the
    // status, it rejects. A rejection escaping here used to take the whole
    // relay tunnel down for a machine the user still owns.
    const statuses = [signedIn, expired, expired];
    const getStatus = vi.fn(() => statuses.shift() ?? expired);
    const getAccessToken = vi.fn(async () => {
      throw new Error("refresh grant rejected");
    });

    const lease = createMachineRelayAccountLease({ getStatus, getAccessToken });

    await expect(lease.getAccountLease()).resolves.toEqual({
      userId: "user_1",
      expiresAt: null,
    });
    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });

  it("drops the lease when the user deliberately signed out", async () => {
    const statuses = [signedIn, signedOut, signedOut];
    const getStatus = vi.fn(() => statuses.shift() ?? signedOut);
    const getAccessToken = vi.fn(async () => {
      throw new Error("no session");
    });

    const lease = createMachineRelayAccountLease({ getStatus, getAccessToken });

    await expect(lease.getAccountLease()).resolves.toBeNull();
  });

  it("returns the live grant while the session is healthy", async () => {
    const getStatus = vi.fn(() => signedIn);
    const getAccessToken = vi.fn(async () => "token");

    const lease = createMachineRelayAccountLease({ getStatus, getAccessToken });

    await expect(lease.getAccountLease()).resolves.toEqual({
      userId: "user_1",
      expiresAt: signedIn.expiresAt,
    });
  });
});
