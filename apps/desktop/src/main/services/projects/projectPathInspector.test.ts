import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import { getProjectDetail } from "./projectDetailService";
import {
  inspectProjectPath,
  inspectProjectPathCached,
  invalidateProjectPathInspectionCache,
} from "./projectPathInspector";
import { toShallowRecentProjectSummary } from "./recentProjectSummary";
import { resolveWorktreeParentRef } from "./worktreeParent";

type DatabaseSyncConstructor = new (dbPath: string) => DatabaseSyncType;
const require = createRequire(path.join(process.cwd(), "ade-runtime.cjs"));
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: DatabaseSyncConstructor };

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function canonical(value: string): string {
  return fs.realpathSync.native(value);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function createRepo(prefix: string): { fixtureRoot: string; mainRoot: string } {
  const fixtureRoot = makeTempDir(prefix);
  const mainRoot = path.join(fixtureRoot, "main");
  fs.mkdirSync(mainRoot);
  git(mainRoot, ["init"]);
  git(mainRoot, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(mainRoot, ["config", "user.email", "ade@example.test"]);
  git(mainRoot, ["config", "user.name", "ADE Tests"]);
  fs.writeFileSync(path.join(mainRoot, "README.md"), "# Test repository\n", "utf8");
  git(mainRoot, ["add", "README.md"]);
  git(mainRoot, ["commit", "-m", "initial"]);
  return { fixtureRoot, mainRoot };
}

function addWorktree(mainRoot: string, worktreeRoot: string, branchRef: string): void {
  git(mainRoot, ["worktree", "add", "-b", branchRef, worktreeRoot]);
}

function createParentDatabase(mainRoot: string, worktreeRoot: string): void {
  const dbPath = resolveAdeLayout(mainRoot).dbPath;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      create table projects(id text primary key, root_path text not null);
      create table lanes(
        id text primary key,
        project_id text not null,
        name text not null,
        branch_ref text not null,
        color text,
        lane_type text not null,
        worktree_path text,
        attached_root_path text,
        status text,
        archived_at text
      );
    `);
    db.prepare("insert into projects(id, root_path) values (?, ?)")
      .run("project-main", canonical(mainRoot));
    db.prepare(
      `
        insert into lanes(
          id, project_id, name, branch_ref, color, lane_type,
          worktree_path, attached_root_path, status, archived_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      "lane-feat-a",
      "project-main",
      "Feature A",
      "feat-a",
      "#123456",
      "attached",
      canonical(worktreeRoot),
      canonical(worktreeRoot),
      "active",
      null,
    );
  } finally {
    db.close();
  }
}

afterEach(() => {
  invalidateProjectPathInspectionCache();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("inspectProjectPath", () => {
  it("returns not-git for a plain directory", async () => {
    const root = makeTempDir("ade-path-inspector-not-git-");

    const inspection = await inspectProjectPath(root);

    expect(inspection).toEqual({
      inputPath: root,
      worktreeRoot: null,
      kind: "not-git",
      branchRef: null,
      parent: null,
      standaloneState: null,
    });
  });

  it("recognizes a repository root", async () => {
    const { mainRoot } = createRepo("ade-path-inspector-repo-");

    const inspection = await inspectProjectPath(mainRoot);

    expect(canonical(inspection.worktreeRoot!)).toBe(canonical(mainRoot));
    expect(inspection.kind).toBe("repo-root");
    expect(inspection.branchRef).toBe("main");
    expect(inspection.parent).toBeNull();
  });

  it("resolves an external linked worktree and its non-ADE parent", async () => {
    const { fixtureRoot, mainRoot } = createRepo("ade-path-inspector-linked-");
    const worktreeRoot = path.join(fixtureRoot, "wt-a");
    addWorktree(mainRoot, worktreeRoot, "feat-a");

    const inspection = await inspectProjectPath(worktreeRoot);

    expect(inspection.kind).toBe("linked-worktree");
    expect(canonical(inspection.worktreeRoot!)).toBe(canonical(worktreeRoot));
    expect(inspection.branchRef).toBe("feat-a");
    expect(canonical(inspection.parent!.rootPath)).toBe(canonical(mainRoot));
    expect(inspection.parent).toMatchObject({
      displayName: path.basename(mainRoot),
      isKnownAdeProject: false,
      existingLane: null,
    });
    expect(inspection.standaloneState).toBeNull();
  });

  it("returns an existing active lane from the parent ADE database", async () => {
    const { fixtureRoot, mainRoot } = createRepo("ade-path-inspector-known-");
    const worktreeRoot = path.join(fixtureRoot, "wt-a");
    addWorktree(mainRoot, worktreeRoot, "feat-a");
    createParentDatabase(mainRoot, worktreeRoot);

    const inspection = await inspectProjectPath(worktreeRoot);

    expect(inspection.parent?.isKnownAdeProject).toBe(true);
    expect(inspection.parent?.existingLane).toEqual({
      id: "lane-feat-a",
      name: "Feature A",
      branchRef: "feat-a",
      color: "#123456",
      laneType: "attached",
    });
  });

  it("excludes the primary lane and counts only chat terminal sessions", async () => {
    const { fixtureRoot, mainRoot } = createRepo("ade-path-inspector-standalone-");
    const worktreeRoot = path.join(fixtureRoot, "wt-a");
    addWorktree(mainRoot, worktreeRoot, "feat-a");
    const dbPath = resolveAdeLayout(worktreeRoot).dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        create table lanes(
          id text primary key,
          status text,
          archived_at text,
          lane_type text not null
        );
        create table terminal_sessions(
          session_id text primary key,
          tool_type text,
          resume_command text
        );
        insert into lanes values ('lane-primary', 'active', null, 'primary');
        insert into lanes values ('lane-a', 'active', null, 'attached');
        insert into lanes values ('lane-b', null, null, 'worktree');
        insert into lanes values ('lane-archived', 'archived', '2026-07-13T00:00:00.000Z', 'attached');
        insert into terminal_sessions values ('chat-codex', 'codex-chat', null);
        insert into terminal_sessions values ('chat-cursor', 'cursor', null);
        insert into terminal_sessions values ('legacy-chat', 'other', 'chat:resume-abc');
        insert into terminal_sessions values ('other-shell', 'other', null);
        insert into terminal_sessions values ('plain-shell', 'shell', null);
        insert into terminal_sessions values ('missing-tool', null, null);
      `);
    } finally {
      db.close();
    }

    const inspection = await inspectProjectPath(worktreeRoot);

    expect(inspection.standaloneState).toEqual({ chatCount: 3, laneCount: 2 });
  });

  it("supports cached reads, fresh bypasses, and explicit invalidation", async () => {
    const { mainRoot } = createRepo("ade-path-inspector-cache-");

    expect((await inspectProjectPathCached(mainRoot)).branchRef).toBe("main");
    git(mainRoot, ["checkout", "-b", "feature/cache-fresh"]);
    expect((await inspectProjectPathCached(mainRoot)).branchRef).toBe("main");
    expect((await inspectProjectPathCached(mainRoot, { fresh: true })).branchRef)
      .toBe("feature/cache-fresh");

    git(mainRoot, ["checkout", "-b", "feature/cache-invalidated"]);
    invalidateProjectPathInspectionCache();
    expect((await inspectProjectPathCached(mainRoot)).branchRef)
      .toBe("feature/cache-invalidated");
  });

  it("returns a null branch for a detached worktree", async () => {
    const { fixtureRoot, mainRoot } = createRepo("ade-path-inspector-detached-");
    const worktreeRoot = path.join(fixtureRoot, "wt-detached");
    git(mainRoot, ["worktree", "add", "--detach", worktreeRoot, "HEAD"]);

    const inspection = await inspectProjectPath(worktreeRoot);

    expect(inspection.kind).toBe("linked-worktree");
    expect(inspection.branchRef).toBeNull();
  });

  it("does not invent a parent working tree for a bare repository", async () => {
    const { fixtureRoot, mainRoot } = createRepo("ade-path-inspector-bare-");
    const bareRoot = path.join(fixtureRoot, "repo.git");
    git(fixtureRoot, ["clone", "--bare", mainRoot, bareRoot]);
    const worktreeRoot = path.join(fixtureRoot, "wt-bare");
    git(bareRoot, ["worktree", "add", "-b", "feat-bare", worktreeRoot, "HEAD"]);

    const inspection = await inspectProjectPath(worktreeRoot);

    expect(inspection.kind).toBe("linked-worktree");
    expect(inspection.parent).toBeNull();
  });

  it("classifies worktrees under the owning ADE project as managed", async () => {
    const { mainRoot } = createRepo("ade-path-inspector-managed-");
    const worktreeRoot = path.join(mainRoot, ".ade", "worktrees", "managed-a");
    fs.mkdirSync(path.join(mainRoot, ".ade"), { recursive: true });
    addWorktree(mainRoot, worktreeRoot, "managed-a");

    const inspection = await inspectProjectPath(worktreeRoot);

    expect(inspection.kind).toBe("ade-managed-worktree");
    expect(canonical(inspection.parent!.rootPath)).toBe(canonical(mainRoot));
  });
});

describe("worktree parent disk metadata", () => {
  it("derives the linked parent from a .git file and populates project read models", async () => {
    const { fixtureRoot, mainRoot } = createRepo("ade-worktree-parent-helper-");
    const worktreeRoot = path.join(fixtureRoot, "wt-a");
    addWorktree(mainRoot, worktreeRoot, "feat-a");

    const parent = resolveWorktreeParentRef(worktreeRoot);
    const detail = await getProjectDetail(worktreeRoot);
    const recent = toShallowRecentProjectSummary({
      rootPath: worktreeRoot,
      displayName: "Feature A",
      lastOpenedAt: "2026-07-13T00:00:00.000Z",
    });

    expect(canonical(parent!.rootPath)).toBe(canonical(mainRoot));
    expect(canonical(detail.worktreeOf!.rootPath)).toBe(canonical(mainRoot));
    expect(canonical(recent.worktreeOf!.rootPath)).toBe(canonical(mainRoot));
  });

  it("returns null for a repository whose .git entry is a directory", () => {
    const { mainRoot } = createRepo("ade-worktree-parent-root-");

    expect(resolveWorktreeParentRef(mainRoot)).toBeNull();
  });

  it("does not misclassify a submodule gitdir pointer as a worktree", () => {
    const fixtureRoot = makeTempDir("ade-worktree-parent-submodule-");
    const superRoot = path.join(fixtureRoot, "super");
    const submoduleRoot = path.join(superRoot, "vendor", "dependency");
    const pointerTarget = path.join(superRoot, ".git", "modules", "dependency");
    fs.mkdirSync(pointerTarget, { recursive: true });
    fs.mkdirSync(submoduleRoot, { recursive: true });
    fs.writeFileSync(
      path.join(submoduleRoot, ".git"),
      `gitdir: ${pointerTarget}\n`,
      "utf8",
    );

    expect(resolveWorktreeParentRef(submoduleRoot)).toBeNull();
  });
});
