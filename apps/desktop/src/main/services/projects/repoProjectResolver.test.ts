import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseGithubRemoteUrl } from "../../../shared/githubRemote";
import type { RecentProjectSummary } from "../../../shared/types";
import {
  clearRepoProjectResolverCacheForTests,
  findRecentProjectForRepo,
  readOriginRemoteUrlFromGitConfig,
} from "./repoProjectResolver";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeGitConfig(rootPath: string, remoteUrl: string, options?: { gitFile?: boolean }): void {
  if (options?.gitFile) {
    const gitDir = path.join(rootPath, "..", `${path.basename(rootPath)}.gitdir`);
    tempDirs.push(gitDir);
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(rootPath, ".git"), `gitdir: ${path.relative(rootPath, gitDir)}\n`, "utf8");
    fs.writeFileSync(path.join(gitDir, "config"), gitConfig(remoteUrl), "utf8");
    return;
  }

  const gitDir = path.join(rootPath, ".git");
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, "config"), gitConfig(remoteUrl), "utf8");
}

function gitConfig(remoteUrl: string): string {
  return [
    "[core]",
    "\trepositoryformatversion = 0",
    "[remote \"upstream\"]",
    "\turl = git@github.com:other/upstream.git",
    "[remote \"origin\"]",
    `\turl = ${remoteUrl}`,
    "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    "",
  ].join("\n");
}

function recent(rootPath: string, displayName: string, overrides: Partial<RecentProjectSummary> = {}): RecentProjectSummary {
  return {
    rootPath,
    displayName,
    lastOpenedAt: "2026-07-06T12:00:00.000Z",
    exists: true,
    ...overrides,
  };
}

afterEach(() => {
  clearRepoProjectResolverCacheForTests();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseGithubRemoteUrl", () => {
  it("parses ssh and https GitHub origin URLs", () => {
    expect(parseGithubRemoteUrl("git@github.com:Acme/ADE.git")).toEqual({
      owner: "Acme",
      repo: "ADE",
    });
    expect(parseGithubRemoteUrl("https://github.com/acme/ade")).toEqual({
      owner: "acme",
      repo: "ade",
    });
  });

  it("ignores non-GitHub or nested remote URLs", () => {
    expect(parseGithubRemoteUrl("https://example.com/acme/ade.git")).toBeNull();
    expect(parseGithubRemoteUrl("git@github.com:acme/ade/extra.git")).toBeNull();
  });
});

describe("readOriginRemoteUrlFromGitConfig", () => {
  it("returns the origin remote URL from a git config", () => {
    expect(readOriginRemoteUrlFromGitConfig(gitConfig("https://github.com/acme/ade.git")))
      .toBe("https://github.com/acme/ade.git");
  });

  it("returns null when origin is missing", () => {
    expect(readOriginRemoteUrlFromGitConfig("[remote \"upstream\"]\n\turl = git@github.com:acme/ade.git\n"))
      .toBeNull();
  });
});

describe("findRecentProjectForRepo", () => {
  it("returns the first local recent project whose origin matches the repo", () => {
    const first = makeTempDir("ade-repo-resolver-first-");
    const second = makeTempDir("ade-repo-resolver-second-");
    writeGitConfig(first, "git@github.com:acme/ade.git");
    writeGitConfig(second, "https://github.com/acme/ade.git");

    expect(findRecentProjectForRepo(
      [recent(first, "ADE first"), recent(second, "ADE second")],
      { repoOwner: "ACME", repoName: "ade" },
    )).toEqual({
      rootPath: first,
      displayName: "ADE first",
    });
  });

  it("handles worktree-style .git files with gitdir pointers", () => {
    const root = makeTempDir("ade-repo-resolver-worktree-");
    writeGitConfig(root, "git@github.com:acme/portable.git", { gitFile: true });

    expect(findRecentProjectForRepo(
      [recent(root, "Portable")],
      { repoOwner: "acme", repoName: "portable" },
    )).toEqual({
      rootPath: root,
      displayName: "Portable",
    });
  });

  it("skips missing and remote recent projects", () => {
    const root = makeTempDir("ade-repo-resolver-skip-");
    writeGitConfig(root, "git@github.com:acme/ade.git");

    expect(findRecentProjectForRepo(
      [
        recent(root, "Missing", { exists: false }),
        recent(root, "Remote", {
          kind: "remote",
          remote: {
            targetId: "target-1",
            projectId: "project-1",
            runtimeName: "Studio",
            hostname: "studio.local",
          },
        }),
      ],
      { repoOwner: "acme", repoName: "ade" },
    )).toBeNull();
  });
});
