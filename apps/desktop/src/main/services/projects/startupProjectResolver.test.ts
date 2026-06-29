import path from "node:path";
import { describe, expect, it } from "vitest";

import { normalizeStartupProjectState, resolveStartupProject } from "./startupProjectResolver";

const normalizeProjectPath = (value: string) => path.resolve("/", value);

describe("resolveStartupProject", () => {
  it("prefers an explicit ADE_PROJECT_ROOT", () => {
    const result = resolveStartupProject({
      envRoot: "env-project",
      pendingStartupProjectRoot: "pending-project",
      normalizeProjectPath,
    });

    expect(result).toEqual({ rootPath: "/env-project", source: "env" });
  });

  it("opens a project passed by the OS before the renderer starts", () => {
    const result = resolveStartupProject({
      envRoot: "",
      pendingStartupProjectRoot: "pending-project",
      normalizeProjectPath,
    });

    expect(result).toEqual({ rootPath: "/pending-project", source: "pending-open" });
  });

  it("does not restore a project on normal packaged startup", () => {
    const result = resolveStartupProject({
      envRoot: null,
      pendingStartupProjectRoot: null,
      normalizeProjectPath,
    });

    expect(result).toEqual({ rootPath: null, source: "none" });
  });
});

describe("normalizeStartupProjectState", () => {
  const nowIso = "2026-05-11T12:00:00.000Z";
  const isLikelyRepoRoot = (value: string) => value !== "/missing";

  it("moves a legacy valid last project into recents without preserving reopen state", () => {
    const result = normalizeStartupProjectState({
      saved: {
        lastProjectRoot: "lost-project",
        recentProjects: [
          { rootPath: "other-project", displayName: "Other", lastOpenedAt: "2026-05-10T00:00:00.000Z" },
        ],
      },
      isLikelyRepoRoot,
      normalizeProjectPath,
      nowIso,
    });

    expect(result.recentProjects).toEqual([
      { rootPath: "/lost-project", displayName: "lost-project", lastOpenedAt: nowIso },
      { rootPath: "/other-project", displayName: "Other", lastOpenedAt: "2026-05-10T00:00:00.000Z" },
    ]);
    expect(result.state.lastProjectRoot).toBeUndefined();
    expect(result.changed).toBe(true);
  });

  it("drops invalid startup roots without dropping valid recents", () => {
    const result = normalizeStartupProjectState({
      saved: {
        lastProjectRoot: "missing",
        recentProjects: [
          { rootPath: "valid-project", displayName: "", lastOpenedAt: "" },
          { rootPath: "missing", displayName: "Missing", lastOpenedAt: "2026-05-10T00:00:00.000Z" },
        ],
      },
      isLikelyRepoRoot,
      normalizeProjectPath,
      nowIso,
    });

    expect(result.recentProjects).toEqual([
      { rootPath: "/valid-project", displayName: "valid-project", lastOpenedAt: nowIso },
    ]);
    expect(result.state.lastProjectRoot).toBeUndefined();
    expect(result.changed).toBe(true);
  });

  it("uses machine registry projects when desktop state has no recent projects", () => {
    const result = normalizeStartupProjectState({
      saved: {},
      additionalRecentProjects: [
        { rootPath: "registry-project", displayName: "Registry project", lastOpenedAt: "2026-05-09T00:00:00.000Z" },
      ],
      isLikelyRepoRoot,
      normalizeProjectPath,
      nowIso,
    });

    expect(result.recentProjects).toEqual([
      { rootPath: "/registry-project", displayName: "Registry project", lastOpenedAt: "2026-05-09T00:00:00.000Z" },
    ]);
    expect(result.changed).toBe(true);
  });

  it("keeps remote recents without disk-checking or stripping their remote metadata", () => {
    const remote = {
      targetId: "t1",
      projectId: "p1",
      runtimeName: "mac-mini",
      hostname: "mac-mini.local",
    };
    const lastRemoteProjectBinding = {
      kind: "remote" as const,
      key: "remote:t1:p1",
      targetId: "t1",
      runtimeName: "mac-mini",
      hostname: "mac-mini.local",
      projectId: "p1",
      rootPath: "/home/u/webapp",
      displayName: "webapp",
      iconDataUrl: "data:image/png;base64,remote-icon",
    };
    const result = normalizeStartupProjectState({
      saved: {
        lastRemoteProjectBinding,
        recentProjects: [
          // A remote path that does NOT exist on this machine — must survive.
          { rootPath: "/home/u/webapp", displayName: "webapp", lastOpenedAt: "2026-05-10T00:00:00.000Z", remote, pinned: true },
          { rootPath: "valid-project", displayName: "Local", lastOpenedAt: "2026-05-09T00:00:00.000Z" },
        ],
      },
      isLikelyRepoRoot,
      normalizeProjectPath,
      nowIso,
    });

    const remoteEntry = result.recentProjects.find((p) => p.remote);
    expect(remoteEntry).toBeDefined();
    expect(remoteEntry?.remote).toEqual({
      ...remote,
      iconDataUrl: "data:image/png;base64,remote-icon",
    });
    expect(remoteEntry?.rootPath).toBe("/home/u/webapp"); // not normalized to a local path
    expect(remoteEntry?.pinned).toBe(true);
    // The local entry is still cleaned/normalized as before.
    expect(result.recentProjects.some((p) => !p.remote && p.rootPath === "/valid-project")).toBe(true);
  });

  it("reports changed when cleanup only normalizes pinned metadata", () => {
    const result = normalizeStartupProjectState({
      saved: {
        recentProjects: [
          {
            rootPath: "/valid-project",
            displayName: "Local",
            lastOpenedAt: "2026-05-09T00:00:00.000Z",
            pinned: false,
          },
        ],
      },
      isLikelyRepoRoot,
      normalizeProjectPath,
      nowIso,
    });

    expect(result.recentProjects).toEqual([
      {
        rootPath: "/valid-project",
        displayName: "Local",
        lastOpenedAt: "2026-05-09T00:00:00.000Z",
      },
    ]);
    expect(result.changed).toBe(true);
  });

  it("preserves the last remote project binding across startup cleanup", () => {
    const lastRemoteProjectBinding = {
      kind: "remote" as const,
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Studio",
      projectId: "project-1",
      rootPath: "/Users/arul/ADE",
      displayName: "ADE",
      updatedAt: "2026-05-10T00:00:00.000Z",
    };

    const result = normalizeStartupProjectState({
      saved: {
        lastProjectRoot: "lost-project",
        lastRemoteProjectBinding,
        recentProjects: [],
      },
      isLikelyRepoRoot,
      normalizeProjectPath,
      nowIso,
    });

    expect(result.state.lastProjectRoot).toBeUndefined();
    expect(result.state.lastRemoteProjectBinding).toEqual(lastRemoteProjectBinding);
  });
});
