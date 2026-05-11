import path from "node:path";
import { describe, expect, it } from "vitest";

import { normalizeStartupProjectState, resolveStartupProject } from "./startupProjectResolver";

const normalizeProjectPath = (value: string) => path.resolve("/", value);

describe("resolveStartupProject", () => {
  it("prefers an explicit ADE_PROJECT_ROOT", () => {
    const result = resolveStartupProject({
      envRoot: "env-project",
      pendingStartupProjectRoot: "pending-project",
      validLastProjectRoot: "last-project",
      recentProjects: [
        { rootPath: "recent-project", displayName: "Recent", lastOpenedAt: "2026-05-11T00:00:00.000Z" },
      ],
      normalizeProjectPath,
    });

    expect(result).toEqual({ rootPath: "/env-project", source: "env" });
  });

  it("restores the last valid project on normal packaged startup", () => {
    const result = resolveStartupProject({
      envRoot: "",
      pendingStartupProjectRoot: null,
      validLastProjectRoot: "last-project",
      recentProjects: [
        { rootPath: "recent-project", displayName: "Recent", lastOpenedAt: "2026-05-11T00:00:00.000Z" },
      ],
      normalizeProjectPath,
    });

    expect(result).toEqual({ rootPath: "/last-project", source: "last-project" });
  });

  it("falls back to the first recent project when lastProjectRoot is unavailable", () => {
    const result = resolveStartupProject({
      envRoot: null,
      pendingStartupProjectRoot: null,
      validLastProjectRoot: "",
      recentProjects: [
        { rootPath: "recent-project", displayName: "Recent", lastOpenedAt: "2026-05-11T00:00:00.000Z" },
      ],
      normalizeProjectPath,
    });

    expect(result).toEqual({ rootPath: "/recent-project", source: "recent-project" });
  });
});

describe("normalizeStartupProjectState", () => {
  const nowIso = "2026-05-11T12:00:00.000Z";
  const isLikelyRepoRoot = (value: string) => value !== "/missing";

  it("keeps a valid last project even when older runtime-backed opens did not add it to recents", () => {
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

    expect(result.validLastProjectRoot).toBe("/lost-project");
    expect(result.recentProjects).toEqual([
      { rootPath: "/lost-project", displayName: "lost-project", lastOpenedAt: nowIso },
      { rootPath: "/other-project", displayName: "Other", lastOpenedAt: "2026-05-10T00:00:00.000Z" },
    ]);
    expect(result.state.lastProjectRoot).toBe("/lost-project");
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

    expect(result.validLastProjectRoot).toBe("");
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
});
