import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cleanGitConfigValue,
  clearGitOriginCacheForTests,
  parseGitOriginUrlFromConfig,
  readGitOriginUrl,
  resolveGitConfigDirectory,
  toShallowRecentProjectSummary,
} from "./recentProjectSummary";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-recent-origin-"));
  tempDirs.push(dir);
  return dir;
}

/** Writes a plain (non-worktree) checkout at `rootPath` with the given config. */
function writeRepo(rootPath: string, configText: string): string {
  const gitDir = path.join(rootPath, ".git");
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, "config"), configText, "utf8");
  return rootPath;
}

function originConfig(url: string, bare = false): string {
  return ["[core]", `\tbare = ${bare}`, "[remote \"origin\"]", `\turl = ${url}`, "\tfetch = +refs/heads/*:refs/remotes/origin/*", ""].join("\n");
}

function writeLinkedWorktree(
  tmp: string,
  commonGitDirName: string,
  originUrl: string,
  bare = false,
): string {
  const commonGitDir = path.join(tmp, commonGitDirName);
  fs.mkdirSync(commonGitDir, { recursive: true });
  fs.writeFileSync(path.join(commonGitDir, "config"), originConfig(originUrl, bare), "utf8");

  const worktreeGitDir = path.join(commonGitDir, "worktrees", "lane-x");
  fs.mkdirSync(worktreeGitDir, { recursive: true });
  fs.writeFileSync(
    path.join(worktreeGitDir, "commondir"),
    `${path.relative(worktreeGitDir, commonGitDir)}\n`,
    "utf8",
  );

  const worktreeRoot = path.join(tmp, "lane-x");
  fs.mkdirSync(worktreeRoot, { recursive: true });
  fs.writeFileSync(path.join(worktreeRoot, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf8");
  return worktreeRoot;
}

beforeEach(() => {
  clearGitOriginCacheForTests();
});

afterEach(() => {
  clearGitOriginCacheForTests();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseGitOriginUrlFromConfig", () => {
  it("stops at an indented section header instead of reading the next remote", () => {
    // The failure this guards is not cosmetic: returning upstream's URL merges
    // two unrelated repositories into a single tab.
    const config = [
      "[remote \"origin\"]",
      "\turl = git@github.com:arul28/ADE.git",
      "  [remote \"upstream\"]",
      "\turl = git@github.com:someone-else/ADE.git",
      "",
    ].join("\n");

    expect(parseGitOriginUrlFromConfig(config)).toBe("git@github.com:arul28/ADE.git");
  });

  it("strips surrounding quotes from a quoted url", () => {
    const config = ["[remote \"origin\"]", "\turl = \"git@github.com:a/b.git\"", ""].join("\n");
    expect(parseGitOriginUrlFromConfig(config)).toBe("git@github.com:a/b.git");
  });

  it("strips an unquoted trailing comment", () => {
    expect(
      parseGitOriginUrlFromConfig(["[remote \"origin\"]", "\turl = git@github.com:a/b.git ; work laptop", ""].join("\n")),
    ).toBe("git@github.com:a/b.git");
    expect(
      parseGitOriginUrlFromConfig(["[remote \"origin\"]", "\turl = git@github.com:a/b.git # work laptop", ""].join("\n")),
    ).toBe("git@github.com:a/b.git");
  });

  it("keeps comment characters that are inside a quoted url", () => {
    const config = ["[remote \"origin\"]", "\turl = \"https://example.com/a/b.git#frag\"", ""].join("\n");
    expect(parseGitOriginUrlFromConfig(config)).toBe("https://example.com/a/b.git#frag");
  });

  it("matches the section name case-insensitively", () => {
    const config = ["[REMOTE \"origin\"]", "\tURL = git@github.com:a/b.git", ""].join("\n");
    expect(parseGitOriginUrlFromConfig(config)).toBe("git@github.com:a/b.git");
  });

  it("returns null when there is no origin remote", () => {
    expect(parseGitOriginUrlFromConfig(["[remote \"upstream\"]", "\turl = git@github.com:a/b.git", ""].join("\n")))
      .toBeNull();
    expect(parseGitOriginUrlFromConfig("")).toBeNull();
  });
});

describe("cleanGitConfigValue", () => {
  it("honours backslash escapes inside a quoted value", () => {
    expect(cleanGitConfigValue("\"git@github.com:a/b\\\"c.git\"")).toBe("git@github.com:a/b\"c.git");
  });

  it("returns null for an empty or comment-only value", () => {
    expect(cleanGitConfigValue("   ")).toBeNull();
    expect(cleanGitConfigValue("; just a comment")).toBeNull();
  });
});

describe("resolveGitConfigDirectory", () => {
  it("walks a linked worktree's metadata dir back to the main repo", () => {
    const gitDir = path.join("/repos", "main", ".git", "worktrees", "lane-x");
    expect(resolveGitConfigDirectory(gitDir)).toBe(path.join("/repos", "main", ".git"));
  });

  it("leaves a repo that merely lives under a folder named worktrees alone", () => {
    const gitDir = path.join("/Users", "me", "worktrees", "myrepo", ".git");
    expect(resolveGitConfigDirectory(gitDir)).toBe(gitDir);
  });

  it("leaves a submodule nested inside a linked worktree alone", () => {
    const gitDir = path.join("/repos", "main", ".git", "worktrees", "lane-x", "modules", "sub");
    expect(resolveGitConfigDirectory(gitDir)).toBe(gitDir);
  });
});

describe("readGitOriginUrl", () => {
  it("reads the origin of a plain checkout", () => {
    const root = writeRepo(path.join(makeTempDir(), "repo"), originConfig("git@github.com:arul28/ADE.git"));
    expect(readGitOriginUrl(root)).toBe("git@github.com:arul28/ADE.git");
  });

  it("reads the main repo's origin from a linked worktree", () => {
    const tmp = makeTempDir();
    const mainRoot = writeRepo(path.join(tmp, "main"), originConfig("git@github.com:arul28/ADE.git"));
    const worktreeGitDir = path.join(mainRoot, ".git", "worktrees", "lane-x");
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    const worktreeRoot = path.join(tmp, "lane-x");
    fs.mkdirSync(worktreeRoot, { recursive: true });
    fs.writeFileSync(path.join(worktreeRoot, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf8");

    expect(readGitOriginUrl(worktreeRoot)).toBe("git@github.com:arul28/ADE.git");
  });

  it("reads the origin from a linked worktree backed by a bare repository", () => {
    const worktreeRoot = writeLinkedWorktree(
      makeTempDir(),
      "central.git",
      "git@github.com:arul28/bare-backed.git",
      true,
    );

    expect(readGitOriginUrl(worktreeRoot)).toBe("git@github.com:arul28/bare-backed.git");
  });

  it("reads the origin from a linked worktree with a separately named common Git directory", () => {
    const worktreeRoot = writeLinkedWorktree(
      makeTempDir(),
      "git-metadata",
      "git@github.com:arul28/separate-metadata.git",
    );

    expect(readGitOriginUrl(worktreeRoot)).toBe("git@github.com:arul28/separate-metadata.git");
  });

  it("does not truncate a repo that lives under a directory named worktrees", () => {
    // The old marker search cut `<home>/worktrees/myrepo/.git` down to `<home>`
    // and read `<home>/config` — a file that either does not exist or belongs
    // to something else entirely.
    const tmp = makeTempDir();
    fs.writeFileSync(path.join(tmp, "config"), originConfig("git@github.com:someone/decoy.git"), "utf8");
    const root = writeRepo(
      path.join(tmp, "worktrees", "myrepo"),
      originConfig("git@github.com:arul28/myrepo.git"),
    );

    expect(readGitOriginUrl(root)).toBe("git@github.com:arul28/myrepo.git");
  });

  it("reads a submodule's own origin when it sits inside a linked worktree", () => {
    const tmp = makeTempDir();
    const mainRoot = writeRepo(path.join(tmp, "main"), originConfig("git@github.com:arul28/super.git"));
    const submoduleGitDir = path.join(mainRoot, ".git", "worktrees", "lane-x", "modules", "sub");
    fs.mkdirSync(submoduleGitDir, { recursive: true });
    fs.writeFileSync(
      path.join(submoduleGitDir, "config"),
      originConfig("git@github.com:arul28/sub.git"),
      "utf8",
    );
    const submoduleRoot = path.join(tmp, "lane-x", "sub");
    fs.mkdirSync(submoduleRoot, { recursive: true });
    fs.writeFileSync(path.join(submoduleRoot, ".git"), `gitdir: ${submoduleGitDir}\n`, "utf8");

    expect(readGitOriginUrl(submoduleRoot)).toBe("git@github.com:arul28/sub.git");
  });

  it("returns null when the checkout has no git metadata", () => {
    const dir = makeTempDir();
    expect(readGitOriginUrl(path.join(dir, "not-a-repo"))).toBeNull();
  });

  it("re-reads after the config changes", () => {
    const root = writeRepo(path.join(makeTempDir(), "repo"), originConfig("git@github.com:arul28/ADE.git"));
    expect(readGitOriginUrl(root)).toBe("git@github.com:arul28/ADE.git");

    const configPath = path.join(root, ".git", "config");
    fs.writeFileSync(configPath, originConfig("git@github.com:arul28/renamed.git"), "utf8");
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(configPath, future, future);

    expect(readGitOriginUrl(root)).toBe("git@github.com:arul28/renamed.git");
  });
});

describe("toShallowRecentProjectSummary", () => {
  it("carries the git origin so the tab bar can join checkouts of one repo", () => {
    // IPC.projectListRecent serves the renderer from this shallow path. Without
    // gitOriginUrl here, every tab arrives origin-less and nothing ever merges.
    const root = writeRepo(path.join(makeTempDir(), "repo"), originConfig("git@github.com:arul28/ADE.git"));

    const summary = toShallowRecentProjectSummary({
      rootPath: root,
      displayName: "ADE",
      lastOpenedAt: "2026-07-27T00:00:00.000Z",
    });

    expect(summary.gitOriginUrl).toBe("git@github.com:arul28/ADE.git");
  });

  it("omits the origin for a project that is not on disk", () => {
    const summary = toShallowRecentProjectSummary({
      rootPath: path.join(makeTempDir(), "gone"),
      displayName: "Gone",
      lastOpenedAt: "2026-07-27T00:00:00.000Z",
    });

    expect(summary.exists).toBe(false);
    expect(summary.gitOriginUrl).toBeUndefined();
  });

  it("carries a persisted remote origin without touching the remote filesystem", () => {
    const summary = toShallowRecentProjectSummary({
      rootPath: "/srv/ade/app",
      displayName: "App",
      lastOpenedAt: "2026-07-27T00:00:00.000Z",
      remote: {
        targetId: "studio",
        projectId: "project-1",
        runtimeName: "Mac Studio",
        hostname: "studio.local",
        gitOriginUrl: "git@github.com:arul28/ADE.git",
      },
    });

    expect(summary.kind).toBe("remote");
    expect(summary.gitOriginUrl).toBe("git@github.com:arul28/ADE.git");
  });
});
