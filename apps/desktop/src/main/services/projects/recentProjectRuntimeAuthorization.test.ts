import { describe, expect, it, vi } from "vitest";

// `ssh -G` is the process boundary: on this machine `github.com-work` is GitHub.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: ((_command: string, args: string[]) => {
      const host = args[args.length - 1];
      return {
        status: 0,
        stdout: `hostname ${host === "github.com-work" ? "github.com" : host}\n`,
        stderr: "",
        signal: null,
        error: undefined,
      };
    }) as unknown as typeof actual.spawnSync,
  };
});

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

  it("never resolves another machine's SSH alias against this machine's ssh config", () => {
    const localRecentProjects = [{
      rootPath: "/nonexistent/ADE",
      displayName: "ADE",
      lastOpenedAt: "2026-07-28T00:00:00.000Z",
      exists: true,
      kind: "local" as const,
      gitOriginUrl: "git@github.com:arul28/ADE.git",
    }];
    const authorize = (activeGitOriginUrl: string, activeOriginIsPeer: boolean) =>
      authorizeRecentProjectRuntimeRoot({
        requestedRootPath: "/nonexistent/ADE",
        activeGitOriginUrl,
        activeOriginIsPeer,
        localRecentProjects,
      });
    // The alias is this machine's own, so it resolves here.
    expect(authorize("git@github.com-work:arul28/ADE.git", false)).toBe("/nonexistent/ADE");
    // The same text from a peer names a host in the peer's ssh config.
    expect(authorize("git@github.com-work:arul28/ADE.git", true)).toBeNull();
    // A current peer sends the canonical form.
    expect(authorize("https://github.com/arul28/ade", true)).toBe("/nonexistent/ADE");
    expect(authorize("https://github.com/arul28/Versic", true)).toBeNull();
  });
});