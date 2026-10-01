import { describe, expect, it } from "vitest";
import {
  activeMachineForGroup,
  groupRecentProjects,
  groupProjectTabs,
  remoteBindingFromRecent,
  resolveProjectTabFallback,
  LOCAL_MACHINE_NAME,
} from "./projectTabGrouping";
import type { RecentProjectSummary, RemoteOpenProjectBinding } from "../../../shared/types";

function local(rootPath: string, gitOriginUrl?: string | null): RecentProjectSummary {
  return {
    rootPath,
    displayName: rootPath.split("/").pop() ?? rootPath,
    lastOpenedAt: "",
    exists: true,
    kind: "local",
    ...(gitOriginUrl === undefined ? {} : { gitOriginUrl }),
  } as RecentProjectSummary;
}

function remote(targetId: string, projectId: string, runtimeName: string): RemoteOpenProjectBinding {
  return {
    kind: "remote",
    key: `remote:${targetId}:${projectId}`,
    targetId,
    projectId,
    runtimeName,
    rootPath: `/Users/other/${projectId}`,
    displayName: projectId,
  } as RemoteOpenProjectBinding;
}

function remoteRecent(
  targetId: string,
  projectId: string,
  runtimeName: string,
  gitOriginUrl: string,
  lastOpenedAt: string,
): RecentProjectSummary {
  return {
    rootPath: `/Users/other/${projectId}`,
    displayName: projectId,
    lastOpenedAt,
    exists: true,
    kind: "remote",
    gitOriginUrl,
    remote: {
      targetId,
      projectId,
      runtimeName,
      hostname: runtimeName,
      gitOriginUrl,
    },
  };
}

describe("groupProjectTabs", () => {
  it("offers an unopened remote checkout of an open repo as a second machine", () => {
    const groups = groupProjectTabs({
      localTabs: [local("/Users/me/ADE", "git@github.com:arul28/ADE.git")],
      remoteTabs: [],
      knownRemoteTabs: [remote("t1", "p1", "MacBook Pro (97)")],
      remoteOriginByKey: { "remote:t1:p1": "https://github.com/arul28/ADE" },
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].machines.map((m) => m.machineName)).toEqual([
      LOCAL_MACHINE_NAME,
      "MacBook Pro (97)",
    ]);
  });

  it("matches SSH and HTTPS forms of the same origin", () => {
    const groups = groupProjectTabs({
      localTabs: [local("/Users/me/ADE", "git@github.com:arul28/ADE.git")],
      remoteTabs: [],
      knownRemoteTabs: [remote("t1", "p1", "MacBook Pro (97)")],
      remoteOriginByKey: { "remote:t1:p1": "https://github.com/arul28/ADE.git" },
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].machines).toHaveLength(2);
  });

  it("keeps different repos in separate tabs", () => {
    const groups = groupProjectTabs({
      localTabs: [
        local("/Users/me/ADE", "git@github.com:arul28/ADE.git"),
        local("/Users/me/Versic", "git@github.com:arul28/Versic.git"),
      ],
      remoteTabs: [],
    });
    expect(groups).toHaveLength(2);
  });

  it("never merges projects that have no resolvable origin", () => {
    // Two unrelated origin-less folders must not collapse into one tab.
    const groups = groupProjectTabs({
      localTabs: [local("/Users/me/scratch-a", null), local("/Users/me/scratch-b")],
      remoteTabs: [],
    });
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.machines.length === 1)).toBe(true);
  });

  it("does not merge two checkouts of one repo on the same machine", () => {
    // A lane worktree shares its parent repo's origin. Merging them would make a
    // single tab that cannot represent both checkouts.
    const origin = "git@github.com:arul28/ADE.git";
    const groups = groupProjectTabs({
      localTabs: [local("/Users/me/ADE", origin), local("/Users/me/ADE/.ade/worktrees/lane-x", origin)],
      remoteTabs: [],
    });
    expect(groups).toHaveLength(2);
    expect(groups[0].machines).toHaveLength(1);
    expect(groups[1].machines).toHaveLength(1);
  });

  it("attaches an unopened remote checkout to the parent repo, not the worktree", () => {
    const origin = "git@github.com:arul28/ADE.git";
    const groups = groupProjectTabs({
      localTabs: [local("/Users/me/ADE", origin), local("/Users/me/ADE/.ade/worktrees/lane-x", origin)],
      remoteTabs: [],
      knownRemoteTabs: [remote("t1", "p1", "MacBook Pro (97)")],
      remoteOriginByKey: { "remote:t1:p1": origin },
    });
    expect(groups).toHaveLength(2);
    const merged = groups.find((g) => g.machines.length > 1);
    expect(merged?.machines.map((m) => m.machineName)).toEqual([
      LOCAL_MACHINE_NAME,
      "MacBook Pro (97)",
    ]);
  });

  it("keeps two open tabs on two machines independent when they share an origin", () => {
    // The owner's repro: two projects the user opened deliberately, on two
    // machines, that happen to be checkouts of one repo. Collapsing them left a
    // single tab whose machine followed whichever tab was active, so the tab
    // being left looked like it jumped to the other machine.
    const origin = "git@github.com:arul28/ADE.git";
    const studio = { ...remote("studio", "project-1", "Mac Studio"), gitOriginUrl: origin };
    const laptop = { ...remote("laptop", "project-2", "MacBook Pro"), gitOriginUrl: origin };

    const shown = (activeBindingKey: string) => {
      const groups = groupProjectTabs({
        localTabs: [],
        remoteTabs: [studio, laptop],
        remoteOriginByKey: { [studio.key]: origin, [laptop.key]: origin },
        activeBindingKey,
      });
      expect(groups).toHaveLength(2);
      return groups.map((group) => activeMachineForGroup(group)?.machineName);
    };

    expect(shown(studio.key)).toEqual(["Mac Studio", "MacBook Pro"]);
    expect(shown(laptop.key)).toEqual(["Mac Studio", "MacBook Pro"]);
  });

  it("tracks which machine the active tab is bound to", () => {
    // Activating a machine from the switcher binds a checkout that is not yet
    // an open tab of its own, so the group must follow it.
    const groups = groupProjectTabs({
      localTabs: [local("/Users/me/ADE", "git@github.com:arul28/ADE.git")],
      remoteTabs: [],
      knownRemoteTabs: [remote("t1", "p1", "MacBook Pro (97)")],
      remoteOriginByKey: { "remote:t1:p1": "git@github.com:arul28/ADE.git" },
      activeBindingKey: "remote:t1:p1",
    });
    expect(activeMachineForGroup(groups[0])?.machineName).toBe("MacBook Pro (97)");
  });

  it("falls back to the first machine when nothing is bound", () => {
    const groups = groupProjectTabs({
      localTabs: [local("/Users/me/ADE", "git@github.com:arul28/ADE.git")],
      remoteTabs: [],
    });
    expect(activeMachineForGroup(groups[0])?.isLocal).toBe(true);
    expect(groups[0].machines).toHaveLength(1);
  });

  it("treats a remote binding with unknown origin as its own tab", () => {
    const groups = groupProjectTabs({
      localTabs: [local("/Users/me/ADE", "git@github.com:arul28/ADE.git")],
      remoteTabs: [remote("t1", "p1", "MacBook Pro (97)")],
      remoteOriginByKey: {},
    });
    expect(groups).toHaveLength(2);
  });

  it("attaches a known unopened checkout without creating another tab", () => {
    const origin = "git@github.com:arul28/ADE.git";
    const groups = groupProjectTabs({
      localTabs: [],
      remoteTabs: [{ ...remote("t1", "p1", "Mac Studio"), gitOriginUrl: origin }],
      knownLocalTabs: [local("/Users/me/ADE", origin)],
      knownRemoteTabs: [remote("t2", "p2", "MacBook Pro")],
      remoteOriginByKey: { "remote:t2:p2": "git@github.com:arul28/other.git" },
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].machines.map((machine) => machine.machineName)).toEqual([
      "Mac Studio",
      LOCAL_MACHINE_NAME,
    ]);
  });

  it("keeps an inactive repo on its preferred machine when a local counterpart appears", () => {
    const origin = "git@github.com:arul28/Versic.git";
    const remoteBinding = { ...remote("studio", "versic", "Mac Studio"), gitOriginUrl: origin };
    const groups = groupProjectTabs({
      localTabs: [local("/Users/me/Other", "git@github.com:arul28/Other.git")],
      remoteTabs: [remoteBinding],
      knownLocalTabs: [local("/Users/me/Versic", origin)],
      preferredBindingKeyByGroup: {
        "origin:github.com/arul28/versic": remoteBinding.key,
      },
    });
    const versic = groups.find((group) => group.machines.some(
      (machine) => machine.bindingKey === remoteBinding.key,
    ));

    expect(activeMachineForGroup(versic!)?.machineName).toBe("Mac Studio");
  });
});

describe("groupRecentProjects", () => {
  it("renders one recent card for two machine checkouts of the same origin", () => {
    const groups = groupRecentProjects({
      recentProjects: [
        local("/Users/me/ADE", "git@github.com:arul28/ADE.git"),
        remoteRecent(
          "studio",
          "ade",
          "Mac Studio",
          "https://github.com/arul28/ADE",
          "2026-07-28T12:00:00.000Z",
        ),
      ],
      remoteSnapshot: {
        connectedCount: 1,
        updatedAt: 1,
        connections: [{
          target: { id: "studio", name: "Mac Studio", hostname: "studio.local" },
          state: "connected",
          projects: [],
        }],
      } as never,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].locations.map((location) => location.machineName)).toEqual([
      "Mac Studio",
      LOCAL_MACHINE_NAME,
    ]);
  });

  it("uses the newest reachable checkout and fails over when the newest machine is offline", () => {
    const localRecent = {
      ...local("/Users/me/Versic", "git@github.com:arul28/Versic.git"),
      lastOpenedAt: "2026-07-28T11:00:00.000Z",
    };
    const groups = groupRecentProjects({
      recentProjects: [
        localRecent,
        remoteRecent(
          "studio",
          "versic",
          "Mac Studio",
          "git@github.com:arul28/Versic.git",
          "2026-07-28T12:00:00.000Z",
        ),
      ],
      remoteSnapshot: {
        connectedCount: 0,
        updatedAt: 1,
        connections: [{
          target: { id: "studio", name: "Mac Studio", hostname: "studio.local" },
          state: "idle",
          projects: [],
        }],
      } as never,
    });

    expect(groups[0].primary.machineId).toBe("this-mac");
  });

  it("auto-binds a never-opened connected catalog checkout by strict origin", () => {
    const groups = groupRecentProjects({
      recentProjects: [{
        ...local("/Users/me/ADE", "git@github.com:arul28/ADE.git"),
        lastOpenedAt: "2026-07-28T10:00:00.000Z",
      }],
      remoteSnapshot: {
        connectedCount: 1,
        updatedAt: 1,
        connections: [{
          target: { id: "studio", name: "Mac Studio", hostname: "studio.local" },
          state: "connected",
          projects: [{
            projectId: "ade",
            rootPath: "/Users/studio/ADE",
            displayName: "ADE",
            gitOriginUrl: "https://github.com/arul28/ADE.git",
            lastOpenedAt: 123,
            icon: null,
          }],
        }],
      } as never,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].locations).toHaveLength(2);
    expect(groups[0].locations[1].recentKey).toBeNull();
    expect(groups[0].locations[1].summary.remote?.projectId).toBe("ade");
  });

  it("includes activity from a newly discovered connected checkout", () => {
    const groups = groupRecentProjects({
      recentProjects: [{
        ...local("/Users/me/ADE", "git@github.com:arul28/ADE.git"),
        lastOpenedAt: "2026-07-28T10:00:00.000Z",
      }],
      remoteSnapshot: {
        connectedCount: 1,
        updatedAt: 1,
        connections: [{
          target: { id: "studio", name: "Mac Studio", hostname: "studio.local" },
          state: "connected",
          projects: [{
            projectId: "ade",
            rootPath: "/Users/studio/ADE",
            displayName: "ADE",
            gitOriginUrl: "https://github.com/arul28/ADE.git",
            lastOpenedAt: Date.parse("2026-07-28T12:00:00.000Z"),
            icon: null,
          }],
        }],
      } as never,
    });

    expect(groups[0].lastOpenedAt).toBe("2026-07-28T12:00:00.000Z");
    expect(groups[0].primary.machineName).toBe("Mac Studio");
  });
});

describe("resolveProjectTabFallback", () => {
  const ORIGIN = "git@github.com:arul28/ADE.git";
  const localCheckout = local("/Users/me/ADE", ORIGIN);
  const studio = { ...remote("studio", "ade", "Mac Studio"), gitOriginUrl: ORIGIN };
  const laptop = { ...remote("laptop", "ade", "MacBook Pro"), gitOriginUrl: ORIGIN };
  const desktop = { ...remote("desktop", "ade", "Mac mini"), gitOriginUrl: ORIGIN };

  function groupsWith(
    knownLocal: RecentProjectSummary[],
    knownRemote: RemoteOpenProjectBinding[],
  ) {
    return groupProjectTabs({
      localTabs: [],
      remoteTabs: [studio],
      knownLocalTabs: knownLocal,
      knownRemoteTabs: knownRemote,
      remoteOriginByKey: Object.fromEntries(
        [studio, ...knownRemote].map((binding) => [binding.key, ORIGIN]),
      ),
    });
  }

  // The tab's machine is going away (`excludeTargetId`); the tab is the repo,
  // so it must land on another checkout of that repo, local first.
  it.each([
    {
      name: "prefers the local checkout of the same repo",
      knownLocal: [localCheckout],
      knownRemote: [] as RemoteOpenProjectBinding[],
      connected: [] as string[],
      expected: { kind: "local", rootPath: "/Users/me/ADE" },
    },
    {
      name: "skips a missing local checkout and uses a connected machine",
      knownLocal: [{ ...localCheckout, exists: false }],
      knownRemote: [laptop],
      connected: ["laptop"],
      expected: { kind: "remote", binding: laptop },
    },
    {
      name: "prefers a connected machine over a disconnected one",
      knownLocal: [],
      knownRemote: [laptop, desktop],
      connected: ["desktop"],
      expected: { kind: "remote", binding: desktop },
    },
  ])("$name", ({ knownLocal, knownRemote, connected, expected }) => {
    expect(
      resolveProjectTabFallback({
        bindingKey: studio.key,
        groups: groupsWith(knownLocal, knownRemote),
        openLocalRoots: [],
        openRemoteBindingKeys: [studio.key],
        connectedTargetIds: new Set(connected),
        excludeTargetId: "studio",
      }),
    ).toEqual(expected);
  });

  it("returns null when the repo lives only on the machine being removed", () => {
    expect(
      resolveProjectTabFallback({
        bindingKey: studio.key,
        groups: groupProjectTabs({
          localTabs: [],
          remoteTabs: [studio],
          remoteOriginByKey: { [studio.key]: ORIGIN },
        }),
        openLocalRoots: [],
        openRemoteBindingKeys: [studio.key],
        connectedTargetIds: new Set(["studio"]),
        excludeTargetId: "studio",
      }),
    ).toBeNull();
  });

  it("returns null when no group contains the tab", () => {
    expect(
      resolveProjectTabFallback({
        bindingKey: studio.key,
        groups: [],
        openLocalRoots: [],
        openRemoteBindingKeys: [],
        connectedTargetIds: new Set(),
        excludeTargetId: "studio",
      }),
    ).toBeNull();
  });
});

describe("groupProjectTabs tab order", () => {
  it("ranks ordered tabs first and keeps unranked tabs in their relative order", () => {
    const groups = groupProjectTabs({
      localTabs: [local("/Users/me/a"), local("/Users/me/b"), local("/Users/me/c")],
      remoteTabs: [],
      order: ["/Users/me/c", "/Users/me/a"],
    });

    expect(groups.map((group) => group.machines[0]!.bindingKey)).toEqual([
      "/Users/me/c",
      "/Users/me/a",
      "/Users/me/b",
    ]);
  });
});

describe("remoteBindingFromRecent", () => {
  function remoteRecent(transport?: "ssh" | "paired"): RecentProjectSummary {
    return {
      rootPath: "/srv/app",
      displayName: "App",
      lastOpenedAt: "",
      exists: true,
      kind: "remote",
      remote: {
        targetId: "t1",
        projectId: "p1",
        runtimeName: "Mac Studio",
        hostname: "studio.local",
        ...(transport ? { transport } : {}),
      },
    };
  }

  it("preserves the paired transport so the binding is not read as SSH", () => {
    const paired = remoteBindingFromRecent(remoteRecent("paired"));

    expect(paired?.transport).toBe("paired");
    expect(paired?.key).toBe("remote:t1:p1");
  });

  it("omits transport for a legacy recent with none and returns null for a local one", () => {
    const legacy = remoteBindingFromRecent(remoteRecent());
    expect(legacy && "transport" in legacy).toBe(false);

    expect(remoteBindingFromRecent(local("/Users/me/ADE"))).toBeNull();
  });
});
