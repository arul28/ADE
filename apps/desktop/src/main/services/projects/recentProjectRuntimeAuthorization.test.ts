import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

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

  // A chat's work copy here, made for a chat on another machine, lives in a
  // project this machine's ADE registered and this window never opened. The
  // window reaches it only when it exists here, exactly at the requested
  // root, and its origin ON DISK is the window's repository.
  describe("a registered project this window never opened", () => {
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-runtime-root-")));
    afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
    const checkout = (name: string, originUrl: string): string => {
      const root = path.join(temp, name);
      fs.mkdirSync(path.join(root, ".git"), { recursive: true });
      fs.writeFileSync(path.join(root, ".git", "config"), `[remote "origin"]
	url = ${originUrl}
`);
      return root;
    };
    const ade = checkout("ade", "git@github.com:arul28/ADE.git");
    // Its record still says ADE; the origin on disk was changed since.
    const repointed = checkout("repointed", "git@github.com:arul28/Versic.git");
    const missing = path.join(temp, "gone");
    const registered = (rootPath: string, gitOriginUrl = "git@github.com:arul28/ADE.git") => () => ({ rootPath, gitOriginUrl });

    it.each([
      ["the same repository, exactly at the root", ade, registered(ade), "git@github.com:arul28/ADE.git", false, ade],
      ["another repository on disk, whatever was recorded", repointed, registered(repointed), "git@github.com:arul28/ADE.git", false, null],
      ["a registered root whose folder is gone", missing, registered(missing), "git@github.com:arul28/ADE.git", false, null],
      ["a registry answer for another root than the one asked", path.join(ade, "sub"), registered(ade), "git@github.com:arul28/ADE.git", false, null],
      ["a registry that cannot be read", ade, () => { throw new Error("locked"); }, "git@github.com:arul28/ADE.git", false, null],
      // The peer rules themselves are the recent-project test's above.
      ["a peer's canonical origin of the same repository", ade, registered(ade), "https://github.com/arul28/ade", true, ade],
    ] as const)("%s", (_label, requestedRootPath, findRegisteredProject, activeGitOriginUrl, activeOriginIsPeer, expected) => {
      const answer = authorizeRecentProjectRuntimeRoot({
        requestedRootPath,
        activeGitOriginUrl,
        activeOriginIsPeer,
        localRecentProjects: [],
        findRegisteredProject,
        logger: { warn: () => {} },
      });
      expect(answer).toBe(expected);
      // Never more than the folder asked for, and only one this machine has.
      if (answer) {
        expect(answer).toBe(requestedRootPath);
        expect(fs.existsSync(answer)).toBe(true);
      }
    });
  });
});