import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  persistableRemoteProjectBinding,
  persistableRemoteProjectIconDataUrl,
  readGlobalState,
  recentProjectKey,
  setRecentProjectPinned,
  upsertRecentProject,
  writeGlobalState,
  type GlobalState,
} from "./globalState";

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

  it("stores a remote project as a recent keyed by target + project id", () => {
    const remote = {
      targetId: "t1",
      projectId: "p1",
      runtimeName: "mac-mini",
      hostname: "mac-mini.local",
      iconDataUrl: "data:image/png;base64,remote-icon",
      gitOriginUrl: "https://token:secret@github.com/arul28/ADE.git?token=secret#fragment",
    };
    const next = upsertRecentProject(
      {},
      { rootPath: "/home/u/webapp", displayName: "webapp", remote },
    );

    expect(next.recentProjects).toHaveLength(1);
    expect(next.recentProjects?.[0]?.remote).toEqual({
      ...remote,
      gitOriginUrl: "https://github.com/arul28/ADE.git",
    });
    expect(recentProjectKey(next.recentProjects![0]!)).toBe("remote:t1:p1");
  });

  it("drops oversized remote project icons before storing recents", () => {
    const oversizedIcon = `data:image/png;base64,${"a".repeat(129 * 1024)}`;
    const next = upsertRecentProject(
      {},
      {
        rootPath: "/home/u/webapp",
        displayName: "webapp",
        remote: {
          targetId: "t1",
          projectId: "p1",
          runtimeName: "mac-mini",
          hostname: "mac-mini.local",
          iconDataUrl: oversizedIcon,
        },
      },
    );

    expect(next.recentProjects?.[0]?.remote).toEqual({
      targetId: "t1",
      projectId: "p1",
      runtimeName: "mac-mini",
      hostname: "mac-mini.local",
    });
  });

  it("dedupes remote recents by remote key, not by root path", () => {
    const remote = {
      targetId: "t1",
      projectId: "p1",
      runtimeName: "mac-mini",
      hostname: "mac-mini.local",
    };
    const localCollision: GlobalState = {
      recentProjects: [
        // Same path string, but local — must NOT be treated as the remote one.
        { rootPath: "/home/u/webapp", displayName: "local copy", lastOpenedAt: "2026-04-01T00:00:00.000Z" },
        { rootPath: "/home/u/webapp", displayName: "webapp", lastOpenedAt: "2026-04-02T00:00:00.000Z", remote },
      ],
    };

    const next = upsertRecentProject(
      localCollision,
      { rootPath: "/home/u/webapp", displayName: "webapp v2", remote },
    );

    // The local entry survives; only the remote entry is replaced + moved to front.
    expect(next.recentProjects).toHaveLength(2);
    expect(next.recentProjects?.[0]?.remote).toEqual(remote);
    expect(next.recentProjects?.[0]?.displayName).toBe("webapp v2");
    expect(next.recentProjects?.some((p) => !p.remote && p.displayName === "local copy")).toBe(true);
  });

  it("preserves the pinned flag across re-open", () => {
    const state: GlobalState = {
      recentProjects: [
        { rootPath: "/projects/a", displayName: "A", lastOpenedAt: "2026-04-01T00:00:00.000Z", pinned: true },
      ],
    };

    const next = upsertRecentProject(state, { rootPath: "/projects/a", displayName: "A" });
    expect(next.recentProjects?.[0]?.pinned).toBe(true);
  });

  it("retains pinned projects beyond the recency cap", () => {
    const recentProjects = Array.from({ length: 30 }, (_, i) => ({
      rootPath: `/projects/p${i}`,
      displayName: `P${i}`,
      lastOpenedAt: `2026-04-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      ...(i === 29 ? { pinned: true } : {}),
    }));
    const state: GlobalState = { recentProjects };

    const next = upsertRecentProject(state, { rootPath: "/projects/new", displayName: "New" });

    expect(next.recentProjects?.some((p) => p.rootPath === "/projects/p29" && p.pinned)).toBe(true);
  });
});

describe("persistableRemoteProjectIconDataUrl", () => {
  it("keeps small image data URLs", () => {
    expect(persistableRemoteProjectIconDataUrl("data:image/png;base64,abc")).toBe(
      "data:image/png;base64,abc",
    );
  });

  it("rejects non-image or oversized data URLs", () => {
    expect(persistableRemoteProjectIconDataUrl("data:text/plain;base64,abc")).toBeNull();
    expect(
      persistableRemoteProjectIconDataUrl(`data:image/png;base64,${"a".repeat(129 * 1024)}`),
    ).toBeNull();
  });
});

describe("persistableRemoteProjectBinding", () => {
  it("removes HTTP credentials and transient URL data before persistence", () => {
    const binding = persistableRemoteProjectBinding({
      kind: "remote" as const,
      key: "remote:studio:ade",
      targetId: "studio",
      projectId: "ade",
      rootPath: "/Users/arul/ADE",
      displayName: "ADE",
      runtimeName: "Studio",
      hostname: "studio.local",
      gitOriginUrl: "https://token:secret@github.com/arul28/ADE.git?token=secret#fragment",
    });

    expect(binding.gitOriginUrl).toBe("https://github.com/arul28/ADE.git");
    expect(JSON.stringify(binding)).not.toContain("secret");
    expect(JSON.stringify(binding)).not.toContain("token");
  });
});

describe("setRecentProjectPinned", () => {
  it("toggles pinned on the matching entry by key", () => {
    const remote = { targetId: "t1", projectId: "p1", runtimeName: "box", hostname: "box" };
    const state: GlobalState = {
      recentProjects: [
        { rootPath: "/projects/a", displayName: "A", lastOpenedAt: "2026-04-01T00:00:00.000Z" },
        { rootPath: "/home/u/web", displayName: "web", lastOpenedAt: "2026-04-02T00:00:00.000Z", remote },
      ],
    };

    const pinnedLocal = setRecentProjectPinned(state, "/projects/a", true);
    expect(pinnedLocal.recentProjects?.[0]?.pinned).toBe(true);
    expect(pinnedLocal.recentProjects?.[1]?.pinned).toBeUndefined();

    const pinnedRemote = setRecentProjectPinned(state, "remote:t1:p1", true);
    expect(pinnedRemote.recentProjects?.[1]?.pinned).toBe(true);
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
