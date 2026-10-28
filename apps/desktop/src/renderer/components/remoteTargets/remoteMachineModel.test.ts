import { describe, expect, it } from "vitest";
import type {
  AdeAccountMachine,
  RemoteRuntimeConnectionSnapshot,
  RemoteRuntimeConnectionStatus,
  RemoteRuntimeDiscoveredMachine,
  RemoteRuntimeTarget,
} from "../../../shared/types";
import { DEFAULT_ADE_TUNNEL_RELAY_URL } from "../../../shared/accountDirectory";
import {
  PUBLISH_FAILING_ALARM_MS,
  accountMachineMatchesTarget,
  assignMachineSections,
  autoConnectOffReason,
  connectedMachinesFromSnapshot,
  describeMachineUpdateAttempt,
  describePublishHealth,
  formatLastSeen,
  formatRemoteTargetError,
  isMachineVersionCurrent,
  isVersionSkewWarning,
  MACHINE_UPDATE_DOWNLOAD_GRACE_MS,
  MACHINE_UPDATE_INSTALL_GRACE_MS,
  machineUpdateAttemptFromResult,
  outdatedMachines,
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

  it("alarms on a sync host that never came back, but not on a boot-time blip", () => {
    // The brain stamps `failingSinceMs` with when it first found no host.
    // 2026-09-21: a dev brain took the lease and exited, and the installed
    // brain reported this state for an hour with nothing to press.
    expect(
      describePublishHealth(health({ state: "sync_not_started", failingSinceMs: NOW - 60 * 60_000 }), NOW),
    ).toEqual({ kind: "failing", minutes: 60 });
    expect(
      describePublishHealth(health({ state: "sync_not_started", failingSinceMs: NOW - 30_000 }), NOW),
    ).toEqual({ kind: "none" });
    expect(
      describePublishHealth(health({ state: "sync_not_started", failingSinceMs: null }), NOW),
    ).toEqual({ kind: "none" });
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

describe("formatLastSeen", () => {
  it("uses a relative last-connected phrase", () => {
    expect(formatLastSeen(null)).toBe("Never connected");
    expect(formatLastSeen(Date.now() - 2 * 60 * 60_000)).toBe("Last connected 2h ago");
  });
});

describe("autoConnectOffReason", () => {
  it.each([
    [
      "a machine that reconnects on its own says nothing",
      { autoConnect: true, lastConnectedAt: 1_700_000_000, manuallyDisconnectedAt: null },
      null,
    ],
    [
      "a switched-off machine that connected before says why",
      { autoConnect: false, lastConnectedAt: 1_700_000_000, manuallyDisconnectedAt: null },
      "Reconnect automatically is off",
    ],
    [
      "a machine never connected says nothing yet",
      { autoConnect: false, lastConnectedAt: null, manuallyDisconnectedAt: null },
      null,
    ],
  ])("%s", (_name, target, expected) => {
    expect(autoConnectOffReason(target)).toBe(expected);
  });

  it("names the day of a manual disconnect, which wins over the preference", () => {
    expect(autoConnectOffReason({
      autoConnect: false,
      lastConnectedAt: 1_700_000_000,
      manuallyDisconnectedAt: 1_700_000_100_000,
    })).toMatch(/^you disconnected it on /);
  });
});

describe("isVersionSkewWarning", () => {
  it("recognizes both the old jargon and the new version-skew copy", () => {
    expect(
      isVersionSkewWarning(
        "Remote ADE service reported 1.2.57; local ADE is 1.2.59. The versions differ but their RPC capabilities match, so ADE connected normally — nothing to do.",
      ),
    ).toBe(true);
    expect(
      isVersionSkewWarning(
        "This machine is on ADE 1.2.59. The other machine is on 1.2.57. They can still connect — update the other machine when you can.",
      ),
    ).toBe(true);
    expect(isVersionSkewWarning("Remote ADE service is missing project capabilities: create.")).toBe(
      false,
    );
  });
});

describe("isMachineVersionCurrent", () => {
  it.each([
    ["the same version", "1.2.55", "1.2.55", true],
    ["a newer version", "1.2.56", "1.2.55", true],
    ["an older version", "1.2.54", "1.2.55", false],
    ["a v-prefixed target", "1.2.55", "v1.2.55", true],
    ["a missing version", null, "1.2.55", false],
    ["an unreadable version", "not-a-version", "1.2.55", false],
  ])("is current: %s", (_label, version, target, expected) => {
    expect(isMachineVersionCurrent(version, target)).toBe(expected);
  });
});

describe("connected machine versions (brain and desktop app)", () => {
  // A machine whose brain was updated alone (`ade brain update`) but whose app
  // was not must read as behind, and show both versions.
  it.each([
    ["app and brain agree", "1.2.125", "1.2.125", "1.2.125", false],
    ["no app (a headless server)", "1.2.125", null, "1.2.125", false],
    ["an older brain that does not report the app", "1.2.125", undefined, "1.2.125", false],
    ["app behind a newer brain", "1.2.125", "1.2.123", "1.2.123 · brain 1.2.125", true],
    ["brain behind a newer app", "1.2.123", "1.2.125", "1.2.125 · brain 1.2.123", true],
    ["both behind", "1.2.124", "1.2.123", "1.2.123 · brain 1.2.124", true],
    ["a v-prefixed app version", "1.2.125", "v1.2.125", "1.2.125", false],
  ])("%s", (_label, brainVersion, appVersion, expectedLabel, expectedBehind) => {
    const status: RemoteRuntimeConnectionStatus = {
      target: savedTarget({ runtimeBinaryVersion: "1.2.100" }),
      state: "connected",
      arch: "darwin-arm64",
      version: brainVersion,
      ...(appVersion !== undefined ? { appVersion } : {}),
      projects: [],
      lastError: null,
      lastAttemptedAt: null,
      connectedAt: 1,
    };
    const machines = connectedMachinesFromSnapshot({ connections: [status], connectedCount: 1, updatedAt: 1 } satisfies RemoteRuntimeConnectionSnapshot);
    expect(machines[0]?.versionLabel).toBe(expectedLabel);
    expect(outdatedMachines(machines, "1.2.125").length > 0).toBe(expectedBehind);
  });
});

describe("formatRemoteTargetError", () => {
  it("does not blame sshd for a refused paired-sync port", () => {
    expect(formatRemoteTargetError("ECONNREFUSED")).toBe(
      "The machine refused the connection. Check that ADE is running on that computer and reachable on the saved port.",
    );
    expect(formatRemoteTargetError("ECONNREFUSED")).not.toMatch(/sshd|Remote Login/);
  });

  it("does not blame sshd for a reset paired connection", () => {
    expect(formatRemoteTargetError("ECONNRESET")).not.toMatch(/sshd|Remote Login|SSH/);
  });

  it("keeps SSH recovery copy when the error already names SSH", () => {
    expect(formatRemoteTargetError("SSH ECONNREFUSED")).toMatch(/Remote Login\/sshd/);
    expect(formatRemoteTargetError("sshd ECONNRESET")).toMatch(/Remote Login\/sshd/);
  });

  it("keeps SSH recovery copy when only the IPC method name embeds Ssh", () => {
    expect(
      formatRemoteTargetError(
        "Error invoking remote method 'ade.remoteRuntime.getSshHostKeyTrust': Error: read ECONNRESET",
      ),
    ).toMatch(/SSH server closed the connection before ADE could finish the SSH handshake/);
  });

  it("replaces a raw pairMachine IPC timeout with human copy", () => {
    const message = formatRemoteTargetError(
      "Error invoking remote method 'ade.account.pairMachine': Error: IPC handler for 'ade.account.pairMachine' timed out after 30000ms (callId=23714)",
    );
    expect(message).not.toMatch(/IPC handler|callId/);
    expect(message).toMatch(/stopped waiting for that computer/);
  });
});

describe("describeMachineUpdateAttempt", () => {
  const startedAtMs = 1_000_000;
  const installing = machineUpdateAttemptFromResult(
    { ok: true, updateApplied: true, targetVersion: "1.2.91", route: "desktop_app", pendingVersion: "1.2.91", message: "Installing" },
    "fallback",
    startedAtMs,
  );
  const downloading = machineUpdateAttemptFromResult(
    { ok: true, updateApplied: false, targetVersion: "1.2.91", route: "desktop_app", pendingVersion: "1.2.91", message: "Downloading" },
    "fallback",
    startedAtMs,
  );
  // A host from before `pendingVersion`: its reply on 2026-10-05 said
  // "Updating to 1.2.91 — reconnecting…" while the machine stayed on 1.2.90.
  const olderHost = machineUpdateAttemptFromResult(
    { ok: true, updateApplied: true, targetVersion: "1.2.91", message: "Updating to 1.2.91 — reconnecting…" },
    "fallback",
    startedAtMs,
  );

  it.each([
    ["landed: the machine reports the target", installing, { connected: true, version: "1.2.91" }, 0, { ok: true, inFlight: false, landed: true }],
    ["landed: the machine reports something newer", installing, { connected: true, version: "1.2.92" }, 0, { ok: true, inFlight: false, landed: true }],
    ["waiting: still old inside the grace", installing, { connected: true, version: "1.2.90" }, MACHINE_UPDATE_INSTALL_GRACE_MS - 1, { ok: true, inFlight: true, landed: false }],
    ["failed: still old after the grace", installing, { connected: true, version: "1.2.90" }, MACHINE_UPDATE_INSTALL_GRACE_MS + 1, { ok: false, inFlight: false, landed: false }],
    ["failed: an older host's update that never landed", olderHost, { connected: true, version: "1.2.90" }, MACHINE_UPDATE_INSTALL_GRACE_MS + 1, { ok: false, inFlight: false, landed: false }],
    ["failed: never came back", installing, { connected: false, version: null }, MACHINE_UPDATE_INSTALL_GRACE_MS + 1, { ok: false, inFlight: false, landed: false }],
    ["waiting: a download gets longer than an install", downloading, { connected: true, version: "1.2.90" }, MACHINE_UPDATE_INSTALL_GRACE_MS + 1, { ok: true, inFlight: true, landed: false }],
    ["failed: a download that never landed", downloading, { connected: true, version: "1.2.90" }, MACHINE_UPDATE_DOWNLOAD_GRACE_MS + 1, { ok: false, inFlight: false, landed: false }],
  ] as const)("%s", (_label, attempt, machine, elapsedMs, expected) => {
    const status = describeMachineUpdateAttempt(attempt, machine, startedAtMs + elapsedMs);
    expect(status.ok).toBe(expected.ok);
    expect(status.inFlight).toBe(expected.inFlight);
    // Landed is the one settled-ok state that replaces the host's own line.
    expect(status.ok && !status.inFlight && status.message !== attempt.message).toBe(expected.landed);
    if (!expected.ok && machine.connected) expect(status.message).toContain(machine.version);
  });

  it("shows a refusal as-is, with nothing in flight", () => {
    const attempt = machineUpdateAttemptFromResult(
      { ok: false, updateApplied: false, targetVersion: "1.2.91", route: "desktop_app", pendingVersion: null, message: "No newer version." },
      "fallback",
      startedAtMs,
    );
    expect(describeMachineUpdateAttempt(attempt, { connected: true, version: "1.2.90" }, startedAtMs + 10 * 60_000))
      .toEqual({ ok: false, message: "No newer version.", inFlight: false });
  });
});
