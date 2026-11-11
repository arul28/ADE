import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProjectRepoOrigin } from "./projectRepoOrigin";
import { findProjectCopyOnMachineForRepo, type RepoProjectCopyOnMachine } from "./repoProjectResolver";

// A project is the repository, not one machine's folder: these are the ways
// main learns which repository a tab is, and finds a copy of it elsewhere.

const roots: string[] = [];

function gitRepo(configLines: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-repo-origin-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", root]);
  for (const [key, value] of configLines.map((line) => line.split("=") as [string, string])) {
    execFileSync("git", ["-C", root, "config", key, value]);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("resolveProjectRepoOrigin", () => {
  it("reads this computer's copy when git wrote per-worktree config for lanes", async () => {
    // The owner's refusal: git sets `extensions.worktreeConfig` for lane
    // worktrees, and a strict file read gave "no GitHub origin" for ADE itself.
    const root = gitRepo(["remote.origin.url=https://github.com/arul28/ADE.git", "extensions.worktreeConfig=true"]);
    await expect(resolveProjectRepoOrigin({ gitOriginUrl: null, localRootPath: root })).resolves.toBe("https://github.com/arul28/ADE.git");
  });

  it("gives git's answer when the per-worktree config overrides the origin", async () => {
    // The main file alone names another repository: a cloud lane would clone it.
    const root = gitRepo(["remote.origin.url=https://github.com/someone/else.git", "extensions.worktreeConfig=true"]);
    execFileSync("git", ["-C", root, "config", "--worktree", "remote.origin.url", "https://github.com/arul28/ADE.git"]);
    await expect(resolveProjectRepoOrigin({ gitOriginUrl: null, localRootPath: root })).resolves.toBe("https://github.com/arul28/ADE.git");
  });

  it.each([
    {
      name: "the origin the tab holds wins",
      source: { gitOriginUrl: "https://github.com/arul28/ADE.git", remote: { targetId: "studio", projectId: "p1" } },
      projects: [{ projectId: "p1", gitOriginUrl: "https://github.com/someone/else.git" }],
      expected: "https://github.com/arul28/ADE.git",
    },
    {
      name: "a tab on another machine with no origin asks that machine",
      source: { gitOriginUrl: null, remote: { targetId: "studio", projectId: "p1" } },
      projects: [{ projectId: "p0", gitOriginUrl: "https://github.com/someone/else.git" }, { projectId: "p1", gitOriginUrl: "https://github.com/arul28/ADE.git" }],
      expected: "https://github.com/arul28/ADE.git",
    },
    {
      name: "a machine that cannot answer gives none, not an error",
      source: { gitOriginUrl: null, remote: { targetId: "studio", projectId: "p1" } },
      projects: "offline" as const,
      expected: null,
    },
    {
      name: "a project with no origin anywhere gives none",
      source: { gitOriginUrl: "  ", remote: { targetId: "studio", projectId: "p1" } },
      projects: [{ projectId: "p1", gitOriginUrl: null }],
      expected: null,
    },
  ])("$name", async ({ source, projects, expected }) => {
    const remoteProjects = async () => {
      if (projects === "offline") throw new Error("not connected");
      return projects;
    };
    await expect(resolveProjectRepoOrigin(source, { remoteProjects })).resolves.toBe(expected);
  });
});

describe("findProjectCopyOnMachineForRepo", () => {
  const copy = (overrides: Partial<RepoProjectCopyOnMachine>): RepoProjectCopyOnMachine => ({
    targetId: "studio",
    machineName: "Mac Studio",
    projectId: "p1",
    rootPath: "/Volumes/Dev/Projects/ADE",
    displayName: "ADE",
    gitOriginUrl: "https://github.com/arul28/ADE.git",
    ...overrides,
  });

  it.each([
    { name: "a copy on another machine opens there", copies: [copy({})], expected: { targetId: "studio", projectId: "p1", machineName: "Mac Studio" } },
    { name: "an SSH origin of the same repo matches", copies: [copy({ gitOriginUrl: "git@github.com:arul28/ADE.git" })], expected: { targetId: "studio", projectId: "p1", machineName: "Mac Studio" } },
    { name: "the owner and name match without case", copies: [copy({ gitOriginUrl: "https://github.com/Arul28/ade" })], expected: { targetId: "studio", projectId: "p1", machineName: "Mac Studio" } },
    { name: "a fork is another project", copies: [copy({ gitOriginUrl: "https://github.com/someone/ADE.git" })], expected: null },
    { name: "a copy with no origin is not guessed from its name", copies: [copy({ gitOriginUrl: null })], expected: null },
  ])("$name", async ({ copies, expected }) => {
    const found = await findProjectCopyOnMachineForRepo(copies, { repoOwner: "arul28", repoName: "ADE" });
    expect(found?.remote ?? null).toEqual(expected);
  });
});
