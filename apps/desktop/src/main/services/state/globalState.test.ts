import { describe, expect, it } from "vitest";

import { upsertRecentProject, type GlobalState } from "./globalState";

describe("upsertRecentProject", () => {
  it("keeps an existing project in place when preserving recent order", () => {
    const state: GlobalState = {
      lastProjectRoot: "/projects/a",
      recentProjects: [
        { rootPath: "/projects/a", displayName: "A", lastOpenedAt: "2026-04-01T00:00:00.000Z" },
        { rootPath: "/projects/b", displayName: "B", lastOpenedAt: "2026-04-02T00:00:00.000Z" },
        { rootPath: "/projects/c", displayName: "C", lastOpenedAt: "2026-04-03T00:00:00.000Z" },
      ],
    };

    const next = upsertRecentProject(
      state,
      { rootPath: "/projects/b", displayName: "B renamed" },
      { preserveRecentOrder: true },
    );

    expect(next.lastProjectRoot).toBe("/projects/b");
    expect(next.recentProjects?.map((entry) => entry.rootPath)).toEqual([
      "/projects/a",
      "/projects/b",
      "/projects/c",
    ]);
    expect(next.recentProjects?.[1]).toEqual({
      rootPath: "/projects/b",
      displayName: "B renamed",
      lastOpenedAt: expect.any(String),
    });
  });

  it("adds unknown projects to the front", () => {
    const state: GlobalState = {
      recentProjects: [
        { rootPath: "/projects/a", displayName: "A", lastOpenedAt: "2026-04-01T00:00:00.000Z" },
      ],
    };

    const next = upsertRecentProject(
      state,
      { rootPath: "/projects/b", displayName: "B" },
      { preserveRecentOrder: true },
    );

    expect(next.recentProjects?.map((entry) => entry.rootPath)).toEqual([
      "/projects/b",
      "/projects/a",
    ]);
  });
});
