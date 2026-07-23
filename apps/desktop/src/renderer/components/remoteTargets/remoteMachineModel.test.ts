import { describe, expect, it } from "vitest";
import type {
  AdeAccountMachine,
  RemoteRuntimeConnectionStatus,
  RemoteRuntimeDiscoveredMachine,
  RemoteRuntimeTarget,
} from "../../../shared/types";
import { DEFAULT_ADE_TUNNEL_RELAY_URL } from "../../../shared/accountDirectory";
import {
  PUBLISH_FAILING_ALARM_MS,
  accountMachineMatchesTarget,
  assignMachineSections,
  describePublishHealth,
  type LocalPublishHealth,
} from "./remoteMachineModel";

function accountMachine(overrides: Partial<AdeAccountMachine> = {}): AdeAccountMachine {
  const machine: AdeAccountMachine = {
    machineKey: "mk_default",
    deviceId: "dev_default",
    name: "Studio",
    platform: "darwin",
    deviceType: "desktop",
    reachableEndpoints: [],
    lastSeenAt: Date.now() - 30_000,
    online: true,
    ...overrides,
  };
  if (overrides.reachableEndpoints === undefined) {
    machine.reachableEndpoints = [
      { kind: "tailnet", host: "100.92.14.3", port: 22 },
      { kind: "relay", url: `${DEFAULT_ADE_TUNNEL_RELAY_URL.replace("https:", "wss:")}/connect/${machine.machineKey}` },
    ];
  }
  return machine;
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

describe("assignMachineSections — account machines", () => {
  it("uses discovery for dedupe without leaking unsaved peers into the saved list", () => {
    const discovered = {
      id: "nearby-studio",
      serviceName: "Studio",
      machineName: "Studio",
      hostIdentity: "studio-device",
      hostName: "studio.local",
      port: 22,
      addresses: ["10.0.0.9"],
      primaryRoute: "studio.local",
      tailscaleAddress: null,
      runtimeKind: "ade",
      runtimeVersion: "1.2.3",
      connectable: true,
      projectIds: [],
      projectCount: 0,
      lastSeenAt: Date.now(),
    } satisfies RemoteRuntimeDiscoveredMachine;

    const sections = assignMachineSections({
      targets: [],
      statusById: NO_STATUS,
      connectedFallbackId: null,
      discoveredMachines: [discovered],
      includeDiscoveredRows: false,
    });

    expect(sections.available).toEqual([]);
    expect(sections.unavailable).toEqual([]);
  });

  it("keeps the account row when matching nearby rows are intentionally hidden", () => {
    const discovered = {
      id: "nearby-studio",
      serviceName: "Studio",
      machineName: "Studio",
      hostIdentity: "studio-device",
      hostName: "studio.local",
      port: 22,
      addresses: ["10.0.0.9"],
      primaryRoute: "studio.local",
      tailscaleAddress: null,
      runtimeKind: "ade",
      runtimeVersion: "1.2.3",
      connectable: true,
      projectIds: [],
      projectCount: 0,
      lastSeenAt: Date.now(),
    } satisfies RemoteRuntimeDiscoveredMachine;

    const sections = assignMachineSections({
      targets: [],
      statusById: NO_STATUS,
      connectedFallbackId: null,
      discoveredMachines: [discovered],
      accountMachines: [accountMachine({
        machineKey: "mk_studio",
        deviceId: "studio-device",
      })],
      includeDiscoveredRows: false,
    });

    expect(sections.available.map((row) => row.id)).toEqual(["account:mk_studio"]);
  });

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

  it("keeps an online account machine with an internet route AVAILABLE for paired transport", () => {
    const sections = assignMachineSections({
      targets: [],
      statusById: NO_STATUS,
      connectedFallbackId: null,
      discoveredMachines: [],
      accountMachines: [
        accountMachine({
          machineKey: "mk_relay_only",
          reachableEndpoints: [{
            kind: "relay",
            url: `${DEFAULT_ADE_TUNNEL_RELAY_URL.replace("https:", "wss:")}/connect/mk_relay_only`,
          }],
        }),
      ],
    });

    expect(sections.available.map((row) => row.id)).toEqual(["account:mk_relay_only"]);
    expect(sections.unavailable).toHaveLength(0);
  });

  it("keeps an online direct-only account machine UNAVAILABLE until secure adoption is possible", () => {
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

    expect(sections.available).toHaveLength(0);
    expect(sections.unavailable.map((row) => row.id)).toEqual(["account:mk_lan"]);
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

  it("dedupes a locally paired machine by stable device id after later sign-in", () => {
    const sections = assignMachineSections({
      targets: [savedTarget({
        hostname: "studio.local",
        transport: "paired",
        pairedMachine: {
          hostIdentity: "dev_same_machine",
          machineKey: null,
        },
      })],
      statusById: NO_STATUS,
      connectedFallbackId: null,
      discoveredMachines: [],
      accountMachines: [accountMachine({
        machineKey: "mk_account",
        deviceId: "dev_same_machine",
        reachableEndpoints: [],
      })],
    });

    expect([
      ...sections.connected,
      ...sections.available,
      ...sections.unavailable,
    ].filter((row) => row.kind === "account")).toHaveLength(0);
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
const NOW = 1_700_000_000_000;

function health(overrides: Partial<LocalPublishHealth>): LocalPublishHealth {
  return { state: "published", failingSinceMs: null, ...overrides };
}

describe("describePublishHealth", () => {
  it("reports none when there is no publish health", () => {
    expect(describePublishHealth(null, NOW)).toEqual({ kind: "none" });
    expect(describePublishHealth(undefined, NOW)).toEqual({ kind: "none" });
  });

  it("reports healthy when routes are published", () => {
    expect(describePublishHealth(health({ state: "published" }), NOW)).toEqual({
      kind: "healthy",
    });
  });

  it("stays silent for non-publishing states", () => {
    for (const state of [
      "sync_disabled",
      "no_active_sync_scope",
      "not_host",
      "account_signed_out",
      "machine_key_unavailable",
      "missing_pairing_connect_info",
    ] as const) {
      expect(
        describePublishHealth(health({ state, failingSinceMs: NOW - 60 * 60_000 }), NOW),
      ).toEqual({ kind: "none" });
    }
  });

  it("does not alarm on a failure without a start time", () => {
    expect(
      describePublishHealth(health({ state: "http_error", failingSinceMs: null }), NOW),
    ).toEqual({ kind: "none" });
  });

  it("does not alarm before the failure has persisted two minutes", () => {
    const failingSinceMs = NOW - (PUBLISH_FAILING_ALARM_MS - 1);
    expect(
      describePublishHealth(health({ state: "timeout", failingSinceMs }), NOW),
    ).toEqual({ kind: "none" });
  });

  it("alarms once a failure has persisted at least two minutes", () => {
    const failingSinceMs = NOW - 12 * 60_000;
    expect(
      describePublishHealth(health({ state: "transport_error", failingSinceMs }), NOW),
    ).toEqual({ kind: "failing", minutes: 12 });
  });

  it("floors the failing minutes", () => {
    const failingSinceMs = NOW - (5 * 60_000 + 59_000);
    expect(
      describePublishHealth(health({ state: "http_timeout", failingSinceMs }), NOW),
    ).toEqual({ kind: "failing", minutes: 5 });
  });
});
