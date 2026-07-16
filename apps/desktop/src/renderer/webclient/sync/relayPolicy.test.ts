import { describe, expect, it } from "vitest";
import type { BrowserDialCandidate } from "./endpoints";
import type { WebClientEnvironmentRecord } from "./envStore";
import {
  canUseRelayForEnvironment,
  filterEnvironmentEndpoints,
} from "./relayPolicy";

const relay: BrowserDialCandidate = {
  kind: "relay",
  url: "wss://relay.example/connect/host-1",
  dialable: true,
};
const direct: BrowserDialCandidate = {
  kind: "explicitWss",
  url: "wss://studio.example.test:8787",
  dialable: true,
};
const unknownLastGood: BrowserDialCandidate = {
  kind: "lastGood",
  url: "wss://unknown.example.test:8787",
  dialable: true,
};

const environment = {
  hostDeviceId: "host-1",
  accountOwnerUserId: null,
} as WebClientEnvironmentRecord;

describe("hosted web Relay policy", () => {
  it("blocks Relay signed out without hiding a local direct route", () => {
    expect(filterEnvironmentEndpoints(environment, [relay, unknownLastGood, direct], { kind: "signed_out" })).toEqual([direct]);
    expect(canUseRelayForEnvironment(environment, { kind: "signed_out" })).toBe(false);
  });

  it("lets a locally owned pairing use Relay when the account directory verifies the same host", () => {
    expect(canUseRelayForEnvironment(environment, {
      kind: "signed_in",
      userId: "user-1",
      hostDeviceIds: ["host-1"],
      getAccessToken: async () => "token",
    })).toBe(true);
    expect(environment.accountOwnerUserId).toBeNull();
  });

  it("keeps account-owned environments isolated from another account", () => {
    const owned = { ...environment, accountOwnerUserId: "user-1" };
    expect(canUseRelayForEnvironment(owned, {
      kind: "signed_in",
      userId: "user-2",
      hostDeviceIds: ["host-1"],
      getAccessToken: async () => "token",
    })).toBe(false);
    expect(canUseRelayForEnvironment(owned, {
      kind: "signed_in",
      userId: "user-1",
      hostDeviceIds: [],
      getAccessToken: async () => "token",
    })).toBe(true);
  });
});
