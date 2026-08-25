import { describe, expect, it } from "vitest";
import type { AdeAccountMachine } from "../../../../shared/types/account";
import type { WebClientEnvironmentRecord } from "../../sync";
import type { WebMachineWorkspaceSnapshot } from "../WebMachineSessionManager";
import {
  mergeWebMachines,
  webMachineHeldSessionCount,
  webMachineRosterSummary,
  webMachineRowStatusLine,
} from "../webWorkspaceModel";

const RELAY = "wss://ade-tunnel-relay.arulsharma1028.workers.dev";

function accountMachine(overrides: Partial<AdeAccountMachine> & { machineKey: string; name: string }): AdeAccountMachine {
  return {
    deviceId: overrides.machineKey,
    customName: null,
    platform: "darwin",
    deviceType: "desktop",
    pubkey: null,
    reachableEndpoints: [{ kind: "relay", url: `${RELAY}/connect/${overrides.machineKey}` }],
    lastSeenAt: Date.now(),
    online: true,
    ...overrides,
  };
}

function pairing(hostDeviceId: string, machineName: string): WebClientEnvironmentRecord {
  return {
    envId: `${hostDeviceId}-env`,
    machineName,
    hostDeviceId,
    addressCandidates: [],
    port: 0,
    pairedDeviceId: "browser",
    secret: "",
    dpopKeys: {} as CryptoKeyPair,
    siteId: "site",
    localDeviceId: "browser",
    localDeviceName: "Browser",
    createdAt: new Date().toISOString(),
  };
}

function snapshot(overrides: Partial<WebMachineWorkspaceSnapshot> = {}): WebMachineWorkspaceSnapshot {
  return {
    sessions: [],
    environments: [],
    activeTargetId: null,
    catalogs: [],
    lastActiveMachineKey: null,
    updatedAt: 0,
    ...overrides,
  };
}

describe("mergeWebMachines roster", () => {
  it("marks a leftover browser pairing as remembered-only, not an account computer", () => {
    const environment = pairing("alpha", "windows alpha");
    const machines = mergeWebMachines({
      accountMachines: [
        accountMachine({ machineKey: "studio", name: "Arul's Mac Studio" }),
      ],
      snapshot: snapshot({
        environments: [environment],
        sessions: [{
          targetId: environment.envId,
          environment,
          status: { state: "reconnecting" } as never,
          state: "reconnecting",
          projects: [],
          lastUsedAt: Date.now(),
          activeProjectId: null,
          error: null,
        }],
      }),
      relayBaseUrls: [RELAY],
    });

    expect(machines).toHaveLength(2);
    const remembered = machines.find((machine) => machine.name === "windows alpha");
    expect(remembered?.rememberedOnly).toBe(true);
    expect(remembered?.accountMachine).toBeNull();
    expect(webMachineRowStatusLine(remembered!)).toBe(
      "Remembered in this browser · Reconnecting…",
    );
    expect(webMachineRosterSummary(machines)).toBe(
      "1 on this account · 1 remembered in this browser",
    );
  });

  it("counts live and reconnecting rows toward the browser session cap", () => {
    const live = pairing("air", "MacBook Air");
    const machines = mergeWebMachines({
      accountMachines: [
        accountMachine({ machineKey: "air", name: "MacBook Air" }),
        accountMachine({ machineKey: "studio", name: "Mac Studio" }),
      ],
      snapshot: snapshot({
        environments: [live],
        sessions: [{
          targetId: live.envId,
          environment: live,
          status: { state: "connected", readiness: "ready" } as never,
          state: "live",
          projects: [],
          lastUsedAt: Date.now(),
          activeProjectId: null,
          error: null,
        }],
      }),
      relayBaseUrls: [RELAY],
    });

    expect(webMachineHeldSessionCount(machines)).toBe(1);
    expect(webMachineRosterSummary(machines)).toBe(
      "2 on this account · 1 connected in this tab",
    );
  });
});
