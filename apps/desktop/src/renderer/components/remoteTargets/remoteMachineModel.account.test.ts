import { describe, expect, it } from "vitest";
import type {
  AdeAccountMachine,
  RemoteRuntimeConnectionStatus,
  RemoteRuntimeTarget,
} from "../../../shared/types";
import {
  accountMachineMatchesTarget,
  accountMachineSshRoutes,
  assignMachineSections,
} from "./remoteMachineModel";

function accountMachine(overrides: Partial<AdeAccountMachine> = {}): AdeAccountMachine {
  return {
    machineKey: "mk_default",
    deviceId: "dev_default",
    name: "Studio",
    platform: "darwin",
    deviceType: "desktop",
    reachableEndpoints: [{ kind: "tailnet", host: "100.92.14.3", port: 22 }],
    lastSeenAt: Date.now() - 30_000,
    online: true,
    ...overrides,
  };
}

function savedTarget(overrides: Partial<RemoteRuntimeTarget> = {}): RemoteRuntimeTarget {
  return {
    id: "target-1",
    name: "Studio",
    hostname: "100.92.14.3",
    sshUser: null,
    port: 22,
    sshKeyPath: null,
    lastSeenArch: null,
    runtimeBinaryVersion: null,
    lastConnectedAt: null,
    ...overrides,
  };
}

const NO_STATUS = new Map<string, RemoteRuntimeConnectionStatus>();

describe("accountMachineSshRoutes", () => {
  it("returns direct SSH routes tailnet-first and excludes relay-only machines", () => {
    expect(
      accountMachineSshRoutes(
        accountMachine({
          reachableEndpoints: [
            { kind: "lan", host: "10.0.0.9", port: 8787 },
            { kind: "tailnet", host: "100.92.14.3", port: 8787 },
          ],
        }),
      ),
    ).toEqual([
      {
        hostname: "100.92.14.3",
        port: null,
        source: "tailscale",
        lastSucceededAt: null,
      },
      {
        hostname: "10.0.0.9",
        port: null,
        source: "bonjour",
        lastSucceededAt: null,
      },
    ]);
    expect(
      accountMachineSshRoutes(
        accountMachine({
          reachableEndpoints: [{ kind: "relay", url: "wss://relay/x" }],
        }),
      ),
    ).toEqual([]);
  });
});

describe("assignMachineSections — account machines", () => {
  it("buckets an online account machine into AVAILABLE and offline into UNAVAILABLE", () => {
    const sections = assignMachineSections({
      targets: [],
      statusById: NO_STATUS,
      connectedFallbackId: null,
      discoveredMachines: [],
      accountMachines: [
        accountMachine({ machineKey: "mk_online", online: true }),
        accountMachine({
          machineKey: "mk_offline",
          name: "Mac mini",
          online: false,
          reachableEndpoints: [{ kind: "relay", url: "wss://relay/mini" }],
        }),
      ],
    });

    expect(sections.available.map((row) => row.id)).toEqual(["account:mk_online"]);
    expect(sections.unavailable.map((row) => row.id)).toEqual(["account:mk_offline"]);
    expect(sections.available[0]).toMatchObject({ kind: "account" });
  });

  it("buckets an online relay-only account machine into UNAVAILABLE", () => {
    const sections = assignMachineSections({
      targets: [],
      statusById: NO_STATUS,
      connectedFallbackId: null,
      discoveredMachines: [],
      accountMachines: [
        accountMachine({
          machineKey: "mk_relay_only",
          reachableEndpoints: [{ kind: "relay", url: "wss://relay/x" }],
        }),
      ],
    });

    expect(sections.available).toHaveLength(0);
    expect(sections.unavailable.map((row) => row.id)).toEqual(["account:mk_relay_only"]);
  });

  it("keeps an online account machine with a direct route in AVAILABLE", () => {
    const sections = assignMachineSections({
      targets: [],
      statusById: NO_STATUS,
      connectedFallbackId: null,
      discoveredMachines: [],
      accountMachines: [
        accountMachine({
          machineKey: "mk_lan",
          reachableEndpoints: [{ kind: "lan", host: "10.0.0.9", port: 22 }],
        }),
      ],
    });

    expect(sections.available.map((row) => row.id)).toEqual(["account:mk_lan"]);
    expect(sections.unavailable).toHaveLength(0);
  });

  it("dedupes an account machine that maps to a saved target by host identity", () => {
    const sections = assignMachineSections({
      targets: [savedTarget()],
      statusById: NO_STATUS,
      connectedFallbackId: null,
      discoveredMachines: [],
      accountMachines: [accountMachine({ machineKey: "mk_dupe" })],
    });

    // The saved target owns the host; no duplicate account row is emitted.
    const accountRows = [
      ...sections.connected,
      ...sections.available,
      ...sections.unavailable,
    ].filter((row) => row.kind === "account");
    expect(accountRows).toHaveLength(0);
    expect(sections.available.some((row) => row.kind === "saved")).toBe(true);
  });

  it("dedupes a URL-valued account endpoint against a saved target by host identity", () => {
    const sections = assignMachineSections({
      targets: [savedTarget()],
      statusById: NO_STATUS,
      connectedFallbackId: null,
      discoveredMachines: [],
      accountMachines: [
        accountMachine({
          machineKey: "mk_url_dupe",
          reachableEndpoints: [
            { kind: "tailnet", url: "https://100.92.14.3:8787" },
          ],
        }),
      ],
    });

    const accountRows = [
      ...sections.connected,
      ...sections.available,
      ...sections.unavailable,
    ].filter((row) => row.kind === "account");
    expect(accountRows).toHaveLength(0);
    expect(sections.available.some((row) => row.kind === "saved")).toBe(true);
  });

  it("accountMachineMatchesTarget matches on shared host:port", () => {
    expect(accountMachineMatchesTarget(accountMachine(), savedTarget())).toBe(true);
    expect(
      accountMachineMatchesTarget(
        accountMachine({ reachableEndpoints: [{ kind: "lan", host: "10.0.0.9", port: 22 }] }),
        savedTarget(),
      ),
    ).toBe(false);
  });

  it("matches a saved SSH target even when the account endpoint advertises the ADE service port", () => {
    // Real account-directory endpoints advertise the ADE service port (8787),
    // not the SSH port — matching/dedup must ignore it and key on the host.
    expect(
      accountMachineMatchesTarget(
        accountMachine({
          reachableEndpoints: [{ kind: "tailnet", host: "100.92.14.3", port: 8787 }],
        }),
        savedTarget(),
      ),
    ).toBe(true);

    const sections = assignMachineSections({
      targets: [savedTarget()],
      statusById: NO_STATUS,
      connectedFallbackId: null,
      discoveredMachines: [],
      accountMachines: [
        accountMachine({
          machineKey: "mk_service_port",
          reachableEndpoints: [{ kind: "tailnet", host: "100.92.14.3", port: 8787 }],
        }),
      ],
    });
    const accountRows = [
      ...sections.connected,
      ...sections.available,
      ...sections.unavailable,
    ].filter((row) => row.kind === "account");
    expect(accountRows).toHaveLength(0);
  });

  it("is a no-op when no account machines are supplied", () => {
    const sections = assignMachineSections({
      targets: [],
      statusById: NO_STATUS,
      connectedFallbackId: null,
      discoveredMachines: [],
    });
    expect(sections.available).toHaveLength(0);
    expect(sections.unavailable).toHaveLength(0);
  });
});
