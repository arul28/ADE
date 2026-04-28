import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browseProjectDirectories } from "./projectBrowserService";

vi.mock("./projectService", () => ({
  resolveRepoRoot: vi.fn(async (selectedPath: string) => {
    const normalized = path.resolve(selectedPath);
    if (normalized.endsWith(path.join("alpha", "nested"))) {
      return path.dirname(normalized);
    }
    if (normalized.endsWith("alpha")) {
      return normalized;
    }
    throw new Error("Not a git repository");
  }),
}));

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.clearAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("browseProjectDirectories", () => {
  it("returns matching directories for a partial path", async () => {
    const root = makeTempDir("ade-project-browse-");
    fs.mkdirSync(path.join(root, "alpha"));
    fs.mkdirSync(path.join(root, "alpine"));
    fs.writeFileSync(path.join(root, "alpha.txt"), "ignore me", "utf8");

    const result = await browseProjectDirectories({
      partialPath: path.join(root, "alp"),
    });

    expect(result.exactDirectoryPath).toBeNull();
    expect(result.directoryPath).toBe(root);
    expect(result.openableProjectRoot).toBeNull();
    expect(result.entries.map((entry) => entry.name)).toEqual(["alpha", "alpine"]);
  });

  it("lists directory contents and reports an openable repo for an exact directory", async () => {
    const root = makeTempDir("ade-project-browse-dir-");
    const repoRoot = path.join(root, "alpha");
    fs.mkdirSync(path.join(repoRoot, "nested"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, ".config"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });

    const result = await browseProjectDirectories({
      partialPath: repoRoot,
    });

    expect(result.exactDirectoryPath).toBe(repoRoot);
    expect(result.openableProjectRoot).toBe(repoRoot);
    expect(result.entries.map((entry) => entry.name)).toEqual([".config", ".git", "nested", "src"]);
  });

  it("supports relative paths when cwd is provided", async () => {
    const root = makeTempDir("ade-project-browse-rel-");
    const repoRoot = path.join(root, "alpha");
    fs.mkdirSync(path.join(repoRoot, "nested"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });

    const result = await browseProjectDirectories({
      cwd: repoRoot,
      partialPath: "./nested",
    });

    expect(result.exactDirectoryPath).toBe(path.join(repoRoot, "nested"));
    expect(result.openableProjectRoot).toBe(repoRoot);
  });

  it("marks entries with a .git directory as git repos", async () => {
    const root = makeTempDir("ade-project-browse-flags-");
    fs.mkdirSync(path.join(root, "alpha", ".git"), { recursive: true });
    fs.mkdirSync(path.join(root, "alpine"));

    const result = await browseProjectDirectories({
      partialPath: withTrailingSlash(root),
    });

    const byName = new Map(result.entries.map((entry) => [entry.name, entry]));
    expect(byName.get("alpha")?.isGitRepo).toBe(true);
    expect(byName.get("alpine")?.isGitRepo).toBe(false);
  });
});

function withTrailingSlash(input: string): string {
  return input.endsWith(path.sep) ? input : `${input}${path.sep}`;
}
