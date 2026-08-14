import { describe, expect, it } from "vitest";
import type { AdeAccountMachine } from "../../../../desktop/src/shared/types/account";
import type { RemoteRuntimeTarget } from "../../../../desktop/src/shared/types/remoteRuntime";
import {
  LOCAL_MACHINE_KEY,
  buildMachinePickerRows,
  matchAccountMachine,
  matchSavedRemoteTarget,
  pickProjectRecord,
  sortProjectRecords,
  rankProjectsForPicker,
  coerceProjectRecords,
} from "../connectionPool";

function target(overrides: Partial<RemoteRuntimeTarget> = {}): RemoteRuntimeTarget {
  return {
    id: "target-1",
    name: "Studio",
    hostname: "studio.local",
    transport: "paired",
    pairedMachine: { hostIdentity: "dev-studio", machineKey: "mk-studio" },
    accountOwnerUserId: "user-1",
    sshUser: null,
    port: null,
    sshKeyPath: null,
    routes: [],
    lastSeenArch: null,
    runtimeBinaryVersion: null,
    lastConnectedAt: null,
    ...overrides,
  };
}

function machine(overrides: Partial<AdeAccountMachine> = {}): AdeAccountMachine {
  return {
    machineKey: "mk-studio",
    deviceId: "dev-studio",
    name: "Studio",
    customName: null,
    platform: "darwin",
    deviceType: "desktop",
    reachableEndpoints: [],
    lastSeenAt: Date.now(),
    online: true,
    ...overrides,
  };
}

describe("matchSavedRemoteTarget", () => {
  it("matches paired machineKey, host identity, or target id", () => {
    const saved = target();
    expect(matchSavedRemoteTarget([saved], { machineKey: "mk-studio" })?.id).toBe("target-1");
    expect(matchSavedRemoteTarget([saved], { machineKey: "other", deviceId: "dev-studio" })?.id).toBe("target-1");
    expect(matchSavedRemoteTarget([saved], { machineKey: "target-1" })?.id).toBe("target-1");
  });

  it("falls back to a unique name and prefers the paired twin", () => {
    const paired = target();
    const ssh = target({
      id: "target-ssh",
      transport: "ssh",
      pairedMachine: null,
      sshUser: "me",
    });
    expect(matchSavedRemoteTarget([paired, ssh], { machineKey: "nope", name: "Studio" })?.id).toBe("target-1");
    expect(matchSavedRemoteTarget([paired, ssh], { machineKey: "mk-studio" })?.transport).toBe("paired");
  });

  it("returns null when the name is ambiguous", () => {
    const a = target({ id: "a", pairedMachine: { hostIdentity: "a", machineKey: "a" } });
    const b = target({ id: "b", pairedMachine: { hostIdentity: "b", machineKey: "b" } });
    expect(matchSavedRemoteTarget([a, b], { machineKey: "missing", name: "Studio" })).toBeNull();
  });
});

describe("matchAccountMachine", () => {
  it("matches machineKey or deviceId, then a unique display name", () => {
    const studio = machine();
    expect(matchAccountMachine([studio], { machineKey: "mk-studio" })?.deviceId).toBe("dev-studio");
    expect(matchAccountMachine([studio], { machineKey: "x", deviceId: "dev-studio" })?.machineKey).toBe("mk-studio");
    expect(matchAccountMachine(
      [studio, machine({ machineKey: "other", deviceId: "other", name: "Tower" })],
      { machineKey: "missing", name: "Studio" },
    )?.machineKey).toBe("mk-studio");
  });
});

describe("pickProjectRecord", () => {
  const projects = sortProjectRecords(coerceProjectRecords([
    { projectId: "uuid-old", rootPath: "/repos/old", displayName: "old", lastOpenedAt: 1 },
    { projectId: "uuid-ade", rootPath: "/repos/ADE", displayName: "ADE", lastOpenedAt: 9 },
  ]));

  it("prefers canonical id, then root path, then unique name, then most recent", () => {
    expect(pickProjectRecord(projects, { rootPath: "/repos/old" })?.projectId).toBe("uuid-old");
    expect(pickProjectRecord(projects, { name: "ADE" })?.projectId).toBe("uuid-ade");
    expect(pickProjectRecord(projects)?.projectId).toBe("uuid-ade");
  });
});

describe("buildMachinePickerRows", () => {
  it("lists this machine first and does not duplicate pooled/saved/account rows", () => {
    const rows = buildMachinePickerRows({
      localLabel: "this machine",
      localProjectRoot: "/repos/ADE",
      pooled: [{
        machineKey: "mk-studio",
        label: "Studio",
        connection: {} as never,
        projectRoot: "/repos/ADE",
        remoteLabel: "Studio",
        bridge: null,
      }],
      targets: [target()],
      accountMachines: [machine(), machine({ machineKey: "mk-tower", deviceId: "dev-tower", name: "Tower", online: false })],
      activeMachineKey: LOCAL_MACHINE_KEY,
    });
    expect(rows.map((row) => row.id)).toEqual([LOCAL_MACHINE_KEY, "mk-studio", "mk-tower"]);
    expect(rows[0]?.label).toContain("this session");
    expect(rows[1]?.kind).toBe("connected");
    expect(rows[2]?.detail).toContain("offline");
  });
});

describe("rankProjectsForPicker", () => {
  it("puts the current project first and keeps recency among the rest", () => {
    const projects = sortProjectRecords(coerceProjectRecords([
      { projectId: "a", rootPath: "/repos/old", displayName: "Old", lastOpenedAt: 1 },
      { projectId: "b", rootPath: "/repos/ADE", displayName: "ADE", lastOpenedAt: 5 },
      { projectId: "c", rootPath: "/repos/newer", displayName: "Newer", lastOpenedAt: 9 },
    ]));
    expect(rankProjectsForPicker(projects, "/repos/old").map((entry) => entry.displayName)).toEqual([
      "Old",
      "Newer",
      "ADE",
    ]);
  });
});
