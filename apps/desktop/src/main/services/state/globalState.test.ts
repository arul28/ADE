import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { readGlobalState, upsertRecentProject, writeGlobalState, type GlobalState } from "./globalState";

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

    expect(next.lastProjectRoot).toBeUndefined();
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
    expect(next.lastProjectRoot).toBeUndefined();
  });

  it("records lastProjectRoot only when explicitly requested", () => {
    const next = upsertRecentProject(
      {},
      { rootPath: "/projects/a", displayName: "A" },
      { recordLastProject: true },
    );

    expect(next.lastProjectRoot).toBe("/projects/a");
  });
});

describe("writeGlobalState", () => {
  it("persists state through an atomic temp-file rename", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-global-state-"));
    const filePath = path.join(dir, "global-state.json");
    const state: GlobalState = {
      lastProjectRoot: "/repo/ade",
      recentProjects: [
        { rootPath: "/repo/ade", displayName: "ADE", lastOpenedAt: "2026-05-31T00:00:00.000Z" },
      ],
    };

    writeGlobalState(filePath, state);

    expect(readGlobalState(filePath)).toEqual(state);
    expect(fs.readdirSync(dir).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });
});
