import { describe, expect, it } from "vitest";
import {
  activeMachineForGroup,
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

describe("groupProjectTabs", () => {
  it("merges a local and a remote checkout of the same repo into one tab", () => {
    const groups = groupProjectTabs({
      localTabs: [local("/Users/me/ADE", "git@github.com:arul28/ADE.git")],
      remoteTabs: [remote("t1", "p1", "MacBook Pro (97)")],
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
      remoteTabs: [remote("t1", "p1", "MacBook Pro (97)")],
      remoteOriginByKey: { "remote:t1:p1": "https://github.com/arul28/ADE.git" },
    });
    expect(groups).toHaveLength(1);
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

  it("still merges the remote checkout when a local worktree is also open", () => {
    const origin = "git@github.com:arul28/ADE.git";
    const groups = groupProjectTabs({
      localTabs: [local("/Users/me/ADE", origin), local("/Users/me/ADE/.ade/worktrees/lane-x", origin)],
      remoteTabs: [remote("t1", "p1", "MacBook Pro (97)")],
      remoteOriginByKey: { "remote:t1:p1": origin },
    });
    const merged = groups.find((g) => g.machines.length > 1);
    expect(merged?.machines.map((m) => m.machineName)).toEqual([
      LOCAL_MACHINE_NAME,
      "MacBook Pro (97)",
    ]);
  });

  it("tracks which machine the active tab is bound to", () => {
    const groups = groupProjectTabs({
      localTabs: [local("/Users/me/ADE", "git@github.com:arul28/ADE.git")],
      remoteTabs: [remote("t1", "p1", "MacBook Pro (97)")],
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
});
