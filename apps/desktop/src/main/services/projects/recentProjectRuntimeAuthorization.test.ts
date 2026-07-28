import { describe, expect, it } from "vitest";
import { authorizeRecentProjectRuntimeRoot } from "./recentProjectRuntimeAuthorization";

describe("authorizeRecentProjectRuntimeRoot", () => {
  it("authorizes an existing recent checkout of the active repository", () => {
    expect(authorizeRecentProjectRuntimeRoot({
      requestedRootPath: "/Users/admin/ADE",
      activeGitOriginUrl: "git@github.com:arul28/ADE.git",
      localRecentProjects: [{
        rootPath: "/Users/admin/ADE",
        displayName: "ADE",
        lastOpenedAt: "2026-07-28T00:00:00.000Z",
        exists: true,
        kind: "local",
        gitOriginUrl: "https://github.com/arul28/ade.git",
      }],
    })).toBe("/Users/admin/ADE");
  });

  it("rejects a recent checkout from a different repository", () => {
    expect(authorizeRecentProjectRuntimeRoot({
      requestedRootPath: "/Users/admin/Versic",
      activeGitOriginUrl: "git@github.com:arul28/ADE.git",
      localRecentProjects: [{
        rootPath: "/Users/admin/Versic",
        displayName: "Versic",
        lastOpenedAt: "2026-07-28T00:00:00.000Z",
        exists: true,
        kind: "local",
        gitOriginUrl: "git@github.com:arul28/Versic.git",
      }],
    })).toBeNull();
  });

  it("rejects missing, origin-less, and non-recent paths", () => {
    const localRecentProjects = [{
      rootPath: "/Users/admin/ADE",
      displayName: "ADE",
      lastOpenedAt: "2026-07-28T00:00:00.000Z",
      exists: false,
      kind: "local" as const,
      gitOriginUrl: "git@github.com:arul28/ADE.git",
    }];
    expect(authorizeRecentProjectRuntimeRoot({
      requestedRootPath: "/Users/admin/ADE",
      activeGitOriginUrl: "git@github.com:arul28/ADE.git",
      localRecentProjects,
    })).toBeNull();
    expect(authorizeRecentProjectRuntimeRoot({
      requestedRootPath: "/Users/admin/Other",
      activeGitOriginUrl: "git@github.com:arul28/ADE.git",
      localRecentProjects,
    })).toBeNull();
  });
});
