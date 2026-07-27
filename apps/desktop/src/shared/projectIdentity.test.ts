import { describe, expect, it } from "vitest";
import type { OpenProjectBinding, RecentProjectSummary } from "./types/core";
import { projectBindingKey, recentProjectStateKey, remoteProjectBindingKey } from "./projectIdentity";

describe("projectIdentity", () => {
  it("keys a remote binding by target and project, not by path", () => {
    const binding: OpenProjectBinding = {
      kind: "remote",
      key: remoteProjectBindingKey("target-1", "project-1"),
      targetId: "target-1",
      runtimeName: "MacBook Pro (97)",
      projectId: "project-1",
      rootPath: "/Users/someone/Projects/ADE",
      displayName: "ADE",
    } as OpenProjectBinding;

    expect(projectBindingKey(binding)).toBe("remote:target-1:project-1");
  });

  it("keys a local binding by root path", () => {
    const binding: OpenProjectBinding = {
      kind: "local",
      key: "/Users/me/Projects/ADE",
      rootPath: "/Users/me/Projects/ADE",
      displayName: "ADE",
    } as OpenProjectBinding;

    expect(projectBindingKey(binding)).toBe("/Users/me/Projects/ADE");
  });

  it("gives a remote recents row the same key its open binding would have", () => {
    // Cache retention protects open remote tabs by binding key. When recents
    // resolved to `rootPath` instead, a closed-but-recent remote project fell
    // outside the retained set and lost its warm lane cache on the next switch.
    const row = {
      rootPath: "/Users/someone/Projects/ADE",
      displayName: "ADE",
      lastOpenedAt: "",
      exists: true,
      kind: "remote",
      remote: {
        targetId: "target-1",
        projectId: "project-1",
        runtimeName: "MacBook Pro (97)",
        hostname: "macbook-pro-97.tail7497a6.ts.net",
      },
    } as RecentProjectSummary;

    expect(recentProjectStateKey(row)).toBe("remote:target-1:project-1");
    expect(recentProjectStateKey(row)).toBe(
      projectBindingKey({
        kind: "remote",
        key: "remote:target-1:project-1",
        targetId: "target-1",
        runtimeName: "MacBook Pro (97)",
        projectId: "project-1",
        rootPath: row.rootPath,
        displayName: "ADE",
      } as OpenProjectBinding),
    );
  });

  it("treats a recents row with no kind as local", () => {
    const row = {
      rootPath: "/Users/me/Projects/ADE",
      displayName: "ADE",
      lastOpenedAt: "",
      exists: true,
    } as RecentProjectSummary;

    expect(recentProjectStateKey(row)).toBe("/Users/me/Projects/ADE");
  });

  it("does not collide a local checkout with a remote checkout of the same path", () => {
    const path = "/Users/me/Projects/ADE";
    const local = { rootPath: path, displayName: "ADE", lastOpenedAt: "", exists: true } as RecentProjectSummary;
    const remote = {
      ...local,
      kind: "remote",
      remote: { targetId: "t", projectId: "p", runtimeName: "Other Mac", hostname: "h" },
    } as RecentProjectSummary;

    expect(recentProjectStateKey(local)).not.toBe(recentProjectStateKey(remote));
  });
});
