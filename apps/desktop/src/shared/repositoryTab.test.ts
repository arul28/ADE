import { describe, expect, it } from "vitest";
import type { AccountProjectCopy } from "./accountProject";
import {
  buildRepositoryCopies,
  copyAddress,
  repositoryReaderAddress,
  repositoryTabFromAccountProject,
  resolveDefaultCopy,
  resolveStartOn,
  startOnDefault,
  startOnMachines,
  thisComputerOnlyTab,
  type RepositoryCopyInputs,
  type RepositoryTab,
  type StartOnChoice,
} from "./repositoryTab";
import type { RecentProjectSummary } from "./types/core";
import type { RemoteRuntimeConnectionStatus, RemoteRuntimeProjectRecord } from "./types/remoteRuntime";

const ORIGIN = "git@github.com:acme/app.git";
const AP = "ap_00000000000000000000000000000001";

const tab: RepositoryTab = repositoryTabFromAccountProject({
  id: AP,
  host: "github.com",
  repoKey: "repo:github.com/acme/app",
  name: "app",
});
const gheTab: RepositoryTab = repositoryTabFromAccountProject({
  id: AP,
  host: "acme.ghe.com",
  repoKey: "repo:acme.ghe.com/acme/app",
  name: "app",
});

function row(projectId: string, rootPath: string, extra: Partial<RemoteRuntimeProjectRecord> = {}): RemoteRuntimeProjectRecord {
  return { projectId, rootPath, displayName: "app", addedAt: 1, lastOpenedAt: 1, gitOriginUrl: ORIGIN, ...extra };
}

function machine(
  id: string,
  projects: RemoteRuntimeProjectRecord[],
  opts: { online?: boolean; machineKey?: string; hostname?: string } = {},
): RemoteRuntimeConnectionStatus {
  return {
    target: {
      id,
      name: id.toUpperCase(),
      hostname: opts.hostname ?? `${id}.local`,
      transport: "paired",
      pairedMachine: { hostIdentity: `host-${id}`, machineKey: opts.machineKey ?? `mk-${id}` },
      sshUser: null,
      port: null,
      sshKeyPath: null,
      lastSeenArch: null,
      runtimeBinaryVersion: null,
      lastConnectedAt: null,
    },
    state: opts.online === false ? "error" : "connected",
    arch: null,
    version: null,
    projects,
    lastError: null,
    lastAttemptedAt: null,
    connectedAt: null,
  } as RemoteRuntimeConnectionStatus;
}

function recent(rootPath: string, extra: Partial<RecentProjectSummary> = {}): RecentProjectSummary {
  return { rootPath, displayName: "app", lastOpenedAt: "2026-11-01T00:00:00.000Z", exists: true, gitOriginUrl: ORIGIN, ...extra };
}

function accountCopy(machineKey: string, checkoutId: string, rootPath: string, isMain: boolean, lastSeenAt = 1): AccountProjectCopy {
  return { projectId: AP, machineKey, checkoutId, rootPath, isMain, lastSeenAt };
}

type Setup = {
  local?: RecentProjectSummary[];
  connections?: RemoteRuntimeConnectionStatus[];
  accountCopies?: AccountProjectCopy[];
  web?: boolean;
  cloudHosts?: string[];
};

function inputsFor(setup: Setup): RepositoryCopyInputs {
  return {
    accountCopies: setup.accountCopies ?? null,
    connections: setup.connections ?? [],
    thisMachine: setup.web ? null : { machineKey: "mk-this", localProjects: setup.local ?? [] },
    isAdeCloudMachine: (entry) => Boolean(entry.hostname && setup.cloudHosts?.includes(entry.hostname)),
  };
}

function choiceLabel(choice: StartOnChoice): string {
  if (choice.kind === "cloud") return "cloud";
  if (choice.kind === "clone") return `clone:${choice.machineId}`;
  return `${choice.why}:${choice.copy.address?.key ?? `${choice.copy.machineId}${choice.copy.rootPath}`}`;
}

describe("copyAddress", () => {
  const remoteCopy = { projectId: AP, isThisMachine: false, rootPath: "/srv/app", displayName: "app", gitOriginUrl: ORIGIN };
  it.each([
    ["a local copy", { ...remoteCopy, isThisMachine: true, rootPath: "/Users/me/app", checkoutId: null }, null, "local:/Users/me/app"],
    ["a listed registry id", { ...remoteCopy, checkoutId: "project_b" }, machine("m1", [row("project_a", "/srv/other"), row("project_b", "/srv/app")]), "remote:m1:project_b"],
    ["the account project id when the registry id moved", { ...remoteCopy, checkoutId: "project_gone" }, machine("m1", [row("project_n", "/srv/app", { accountProjectId: AP })]), "remote:m1:project_n"],
    ["the folder when nothing else matches", { ...remoteCopy, checkoutId: null }, machine("m1", [row("project_f", "/srv/app")]), "remote:m1:project_f"],
    ["an offline machine", { ...remoteCopy, checkoutId: "project_b" }, machine("m1", [row("project_b", "/srv/app")], { online: false }), null],
    ["a machine that does not list the folder", { ...remoteCopy, checkoutId: "project_b" }, machine("m1", [row("project_x", "/srv/elsewhere")]), null],
    ["no connection", { ...remoteCopy, checkoutId: "project_b" }, null, null],
    ["a folder the machine reports as gone", { ...remoteCopy, checkoutId: "project_b" }, machine("m1", [row("project_b", "/srv/app", { exists: false })]), null],
  ])("addresses %s", (_label, copy, connection, expectedKey) => {
    expect(copyAddress(copy, connection)?.key ?? null).toBe(expectedKey);
  });
});

describe("resolveDefaultCopy", () => {
  it.each<[string, Setup, { pick?: string; current?: string }, string | null]>([
    ["local only", { local: [recent("/Users/me/app")] }, {}, "local:/Users/me/app"],
    ["remote only", { connections: [machine("m1", [row("p1", "/srv/app")])] }, {}, "remote:m1:p1"],
    ["two machines, tab on the remote: this computer wins", { local: [recent("/Users/me/app")], connections: [machine("m1", [row("p1", "/srv/app")])] }, { current: "remote:m1:p1" }, "local:/Users/me/app"],
    ["two machines, explicit pick of the remote", { local: [recent("/Users/me/app")], connections: [machine("m1", [row("p1", "/srv/app")])] }, { pick: "remote:m1:p1", current: "remote:m1:p1" }, "remote:m1:p1"],
    ["explicit pick whose machine went offline", { local: [recent("/Users/me/app")], connections: [machine("m1", [row("p1", "/srv/app")], { online: false })] }, { pick: "remote:m1:p1" }, "local:/Users/me/app"],
    ["zero online copies", { web: true, connections: [machine("m1", [row("p1", "/srv/app")], { online: false })] }, {}, null],
    ["offline copy is never the default", { connections: [machine("m1", [row("p1", "/srv/app")], { online: false })] }, { current: "remote:m1:p1" }, null],
    ["web, restored to the second machine", { web: true, local: [recent("/Users/me/app")], connections: [machine("m1", [row("p1", "/srv/app")]), machine("m2", [row("p2", "/srv/app")])] }, { current: "remote:m2:p2" }, "remote:m2:p2"],
    ["web, no current: the newest main copy", { web: true, connections: [machine("m1", [row("p1", "/srv/app")]), machine("m2", [row("p2", "/srv/app")])], accountCopies: [accountCopy("mk-m2", "p2", "/srv/app", true, 5)] }, {}, "remote:m2:p2"],
    ["second clone on this computer in use stays", { local: [recent("/Users/me/app"), recent("/Users/me/app-2")], accountCopies: [accountCopy("mk-this", "pa", "/Users/me/app", true), accountCopy("mk-this", "pb", "/Users/me/app-2", false)] }, { current: "local:/Users/me/app-2" }, "local:/Users/me/app-2"],
    ["two clones on this computer, none in use: the main one", { local: [recent("/Users/me/app-2"), recent("/Users/me/app")], accountCopies: [accountCopy("mk-this", "pa", "/Users/me/app", true), accountCopy("mk-this", "pb", "/Users/me/app-2", false)] }, {}, "local:/Users/me/app"],
    ["this computer only project", { local: [recent("/Users/me/notes", { gitOriginUrl: null })] }, {}, "local:/Users/me/notes"],
    ["an account copy whose folder this computer reports as gone", { local: [recent("/Users/me/app", { exists: false })], accountCopies: [accountCopy("mk-this", "pa", "/Users/me/app", true)] }, { current: "local:/Users/me/app" }, null],
    ["an account copy whose folder another machine reports as gone", { connections: [machine("m1", [row("p1", "/srv/app", { exists: false })])], accountCopies: [accountCopy("mk-m1", "p1", "/srv/app", true)] }, {}, null],
  ])("%s", (label, setup, keys, expectedKey) => {
    const subject = label === "this computer only project"
      ? thisComputerOnlyTab({ rootPath: "/Users/me/notes", displayName: "notes" })
      : tab;
    const copies = buildRepositoryCopies(subject, inputsFor(setup));
    expect(resolveDefaultCopy({ copies, explicitPickKey: keys.pick, currentKey: keys.current })?.key ?? null).toBe(expectedKey);
  });

  it("joins on an equal account project id OR an equal origin", () => {
    const copies = buildRepositoryCopies(tab, inputsFor({
      web: true,
      connections: [machine("m1", [
        row("p_renamed", "/srv/renamed", { gitOriginUrl: "git@github.com:acme/old-name.git", accountProjectId: AP }),
        row("p_other_account", "/srv/other-account", { accountProjectId: "ap_00000000000000000000000000000002" }),
        row("p_plain", "/srv/app"),
        row("p_unrelated", "/srv/unrelated", { gitOriginUrl: "git@github.com:acme/unrelated.git", accountProjectId: "ap_00000000000000000000000000000003" }),
      ])],
    }));
    // Renamed: joins by id. Other account, same origin: joins by origin. Unrelated: neither.
    expect(copies.map((copy) => copy.address?.key).sort()).toEqual(["remote:m1:p_other_account", "remote:m1:p_plain", "remote:m1:p_renamed"]);
  });
});

describe("resolveStartOn", () => {
  const local = recent("/Users/me/app");
  it.each<[string, RepositoryTab, Setup, { lastUsed?: string; cloud?: boolean }, string[], string | null]>([
    [
      "this computer first, other copies, clone, then ADE Cloud",
      tab,
      { local: [local], connections: [machine("m1", [row("p1", "/srv/app")]), machine("m2", [])] },
      {},
      ["this-computer:local:/Users/me/app", "other:remote:m1:p1", "clone:m2", "cloud"],
      "this-computer:local:/Users/me/app",
    ],
    [
      "the computer used last comes before other copies",
      tab,
      { web: true, connections: [machine("m1", [row("p1", "/srv/app")]), machine("m2", [row("p2", "/srv/app")])] },
      { lastUsed: "mk-m2" },
      ["last-used:remote:m2:p2", "other:remote:m1:p1", "cloud"],
      "last-used:remote:m2:p2",
    ],
    [
      "main copies before a second clone",
      tab,
      {
        web: true,
        connections: [machine("m1", [row("pa", "/srv/app"), row("pb", "/srv/app-2")]), machine("m2", [row("pc", "/srv/app")])],
        accountCopies: [accountCopy("mk-m1", "pa", "/srv/app", true), accountCopy("mk-m1", "pb", "/srv/app-2", false, 9), accountCopy("mk-m2", "pc", "/srv/app", true)],
      },
      { cloud: false },
      ["other:remote:m1:pa", "other:remote:m2:pc", "other:remote:m1:pb"],
      "other:remote:m1:pa",
    ],
    [
      "web has no this computer and never offers to clone onto it",
      tab,
      { web: true, local: [local], connections: [machine("m1", [])] },
      {},
      ["clone:m1", "cloud"],
      "clone:m1",
    ],
    [
      "this computer only: its folder, no clone, no ADE Cloud",
      thisComputerOnlyTab({ rootPath: "/Users/me/notes", displayName: "notes" }),
      { local: [recent("/Users/me/notes", { gitOriginUrl: null })], connections: [machine("m1", [])] },
      {},
      ["this-computer:local:/Users/me/notes"],
      "this-computer:local:/Users/me/notes",
    ],
    [
      "an ADE Cloud lane computer is never a copy to start on nor a machine without the project",
      tab,
      { web: true, connections: [machine("c1", [row("pc", "/home/ade/app")], { hostname: "inst-1" }), machine("c2", [], { hostname: "inst-2" })], cloudHosts: ["inst-1", "inst-2"] },
      {},
      ["cloud"],
      "cloud",
    ],
    [
      "offline copies are listed last and are never the default",
      gheTab,
      { web: true, connections: [machine("m1", [row("p1", "/srv/app", { gitOriginUrl: "git@acme.ghe.com:acme/app.git" })], { online: false })] },
      {},
      ["unavailable:m1/srv/app"],
      null,
    ],
    [
      "ADE Cloud only for a github.com project",
      gheTab,
      { web: true, connections: [machine("m1", [])] },
      {},
      ["clone:m1"],
      "clone:m1",
    ],
    [
      "zero machines online on a github.com project: ADE Cloud",
      tab,
      { web: true, connections: [machine("m1", [row("p1", "/srv/app")], { online: false })] },
      {},
      ["cloud", "unavailable:m1/srv/app"],
      "cloud",
    ],
    [
      "ADE Cloud turned off",
      tab,
      { web: true, connections: [machine("m1", [])] },
      { cloud: false },
      ["clone:m1"],
      "clone:m1",
    ],
  ])("%s", (_label, subject, setup, opts, expected, expectedDefault) => {
    const inputs = inputsFor(setup);
    const copies = buildRepositoryCopies(subject, inputs);
    const choices = resolveStartOn(subject, {
      copies,
      machines: startOnMachines(inputs),
      lastUsedMachineKey: opts.lastUsed ?? null,
      cloudAvailable: opts.cloud ?? true,
    });
    expect(choices.map(choiceLabel)).toEqual(expected);
    const fallback = startOnDefault(choices);
    expect(fallback ? choiceLabel(fallback) : null).toBe(expectedDefault);
  });

  it("the repository reader is the first online copy, and null with none", () => {
    const online = buildRepositoryCopies(tab, inputsFor({ web: true, connections: [machine("m1", []), machine("m2", [row("p2", "/srv/app")])] }));
    const inputs = inputsFor({ web: true, connections: [machine("m1", []), machine("m2", [row("p2", "/srv/app")])] });
    expect(repositoryReaderAddress(resolveStartOn(tab, { copies: online, machines: startOnMachines(inputs) }))?.key).toBe("remote:m2:p2");
    const none = buildRepositoryCopies(tab, inputsFor({ web: true, connections: [machine("m2", [row("p2", "/srv/app")], { online: false })] }));
    expect(repositoryReaderAddress(resolveStartOn(tab, { copies: none, machines: [] }))).toBeNull();
  });
});
