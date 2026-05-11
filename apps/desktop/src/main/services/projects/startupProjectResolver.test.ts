import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveStartupProject } from "./startupProjectResolver";

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
