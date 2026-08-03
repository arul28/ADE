import { describe, expect, it } from "vitest";
import {
  activeMachineForGroup,
  groupRecentProjects,
  groupProjectTabs,
  isMultiMachine,
  LOCAL_MACHINE_NAME,
  type RemoteProjectTabBinding,
} from "./projectTabGrouping";
import type { RecentProjectSummary } from "../../../shared/types";

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

function remote(targetId: string, projectId: string, runtimeName: string): RemoteProjectTabBinding {
  return {
    kind: "remote",
    key: `remote:${targetId}:${projectId}`,
    targetId,
    projectId,
    runtimeName,
    rootPath: `/Users/other/${projectId}`,
    displayName: projectId,
  } as RemoteProjectTabBinding;
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
    expect(isMultiMachine(groups[0])).toBe(true);
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
    expect(isMultiMachine(groups[0])).toBe(false);
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
});
