import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createLaneService } from "./laneService";

vi.mock("../git/git", () => ({
  getHeadSha: vi.fn(),
  runGit: vi.fn(),
  runGitOrThrow: vi.fn(),
}));

import { getHeadSha, runGit, runGitOrThrow } from "../git/git";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;
}

/** Default stubs for `resolveCreateBranchRef` git probes. Limits `show-ref` to `ade/*` lane branches so tests can still mock specific feature/upstream refs. */
function defaultLaneBranchGitStub(args: string[]): { exitCode: number; stdout: string; stderr: string } | null {
  if (args[0] === "check-ref-format" && args[1] === "--branch") {
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  if (args[0] === "show-ref" && args[1] === "--verify" && args[2] === "--quiet") {
    const ref = args[3] ?? "";
    if (ref.startsWith("refs/heads/ade/") || ref.startsWith("refs/remotes/origin/ade/")) {
      return { exitCode: 1, stdout: "", stderr: "fatal: not a valid ref" };
    }
  }
  return null;
}

function makeLinearIssue() {
  return {
    id: "issue-1",
    identifier: "ABC-42",
    title: "Fix flaky sync run",
    description: "Occasional sync failure under load.",
    url: "https://linear.app/acme/issue/ABC-42/fix-flaky-sync-run",
    projectId: "project-1",
    projectSlug: "acme-platform",
    projectName: "Acme Platform",
    teamId: "team-1",
    teamKey: "ABC",
    teamName: "Platform",
    stateId: "state-1",
    stateName: "In Progress",
    stateType: "started",
    priority: 2,
    priorityLabel: "high" as const,
    labels: ["bug"],
    assigneeId: "user-1",
    assigneeName: "Taylor",
    creatorId: "creator-1",
    creatorName: "Alex",
    dueDate: null,
    estimate: null,
    createdAt: "2026-05-11T20:00:00.000Z",
    updatedAt: "2026-05-12T19:00:00.000Z",
  };
}

async function seedProjectAndStack(db: any, args: { projectId: string; repoRoot: string }) {
  const now = "2026-03-11T12:00:00.000Z";
  db.run(
    "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
    [args.projectId, args.repoRoot, "demo", "main", now, now],
  );
  db.run(
    `
      insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ["lane-main", args.projectId, "Main", null, "primary", "main", "main", path.join(args.repoRoot, "main"), null, 0, null, null, null, null, "active", now, null],
  );
  db.run(
    `
      insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ["lane-parent", args.projectId, "Parent", null, "worktree", "main", "feature/parent", path.join(args.repoRoot, "parent"), null, 0, "lane-main", null, null, null, "active", now, null],
  );
  db.run(
    `
      insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ["lane-child", args.projectId, "Child", null, "worktree", "feature/parent", "feature/child", path.join(args.repoRoot, "child"), null, 0, "lane-parent", null, null, null, "active", now, null],
  );
}

describe("laneService createFromUnstaged", () => {
  beforeEach(() => {
    vi.mocked(getHeadSha).mockReset();
    vi.mocked(runGit).mockReset();
    vi.mocked(runGitOrThrow).mockReset();
  });

  it("recreates the primary lane when the only stored primary lane is archived", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-primary-archived-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const now = "2026-03-11T12:00:00.000Z";
    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      ["proj-primary-archived", repoRoot, "demo", "main", now, now],
    );
    db.run(
      `
        insert into lanes(
          id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
          attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ["lane-main-archived", "proj-primary-archived", "Main", null, "primary", "main", "main", repoRoot, null, 1, null, null, null, null, "archived", now, now],
    );

    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") {
        return { exitCode: 0, stdout: "main\n", stderr: "" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-primary-archived",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    await service.ensurePrimaryLane();

    const lanes = await service.list({ includeArchived: true, includeStatus: false });
    const activePrimary = lanes.find((lane) => lane.laneType === "primary" && lane.archivedAt == null);
    expect(activePrimary).toBeTruthy();
    expect(lanes.filter((lane) => lane.laneType === "primary")).toHaveLength(2);
  });

  it("notifies when a new lane is linked to a Linear issue", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-linear-card-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const now = "2026-05-12T20:00:00.000Z";
    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      ["proj-linear-card", repoRoot, "demo", "main", now, now],
    );

    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "rev-parse" && args[1] === "main") return { exitCode: 0, stdout: "sha-main\n", stderr: "" };
      if (args[0] === "show-ref" && args[1] === "--verify" && args[2] === "--quiet") return { exitCode: 1, stdout: "", stderr: "" };
      if (args[0] === "ls-remote") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "push") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-list" && args[1] === "--left-right") return { exitCode: 0, stdout: "0\t0\n", stderr: "" };
      if (args[0] === "rev-parse" && args.includes("@{upstream}")) return { exitCode: 1, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args.includes("--git-dir")) return { exitCode: 1, stdout: "", stderr: "" };
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });
    vi.mocked(runGitOrThrow).mockResolvedValue("");

    const onLinearIssueLinked = vi.fn();
    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-linear-card",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
      onLinearIssueLinked,
    });

    const lane = await service.create({
      name: "ABC-42 Fix flaky sync run",
      linearIssue: makeLinearIssue(),
    });

    expect(lane.linearIssue?.identifier).toBe("ABC-42");
    expect(onLinearIssueLinked).toHaveBeenCalledWith(expect.objectContaining({
      lane: expect.objectContaining({ id: lane.id, name: "ABC-42 Fix flaky sync run" }),
      issue: expect.objectContaining({ id: "issue-1", identifier: "ABC-42" }),
      linkedAt: lane.createdAt,
    }));
  });

  it("links Linear issues that do not belong to a Linear project", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-linear-projectless-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-linear-projectless", repoRoot });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-linear-projectless",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    const issue = {
      ...makeLinearIssue(),
      id: "issue-projectless",
      identifier: "ADE-45",
      title: "Run Cursor SDK audit",
      url: "https://linear.app/ade-linear/issue/ADE-45/run-cursor-sdk-audit",
      projectId: "",
      projectSlug: "",
      projectName: null,
      teamId: "team-ade",
      teamKey: "ADE",
      teamName: "ADE",
    };

    const links = service.linkLinearIssues({
      laneId: "lane-child",
      issues: [issue],
      source: "manual",
    });

    expect(links).toHaveLength(1);
    expect(links[0]?.issue).toEqual(expect.objectContaining({
      identifier: "ADE-45",
      projectId: "",
      projectSlug: "",
      teamKey: "ADE",
    }));

    const lanes = await service.list({ includeStatus: false });
    const child = lanes.find((lane) => lane.id === "lane-child");
    expect(child?.linearIssueLinks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "worked",
        source: "manual",
        issue: expect.objectContaining({
          identifier: "ADE-45",
          projectId: "",
          projectSlug: "",
          teamKey: "ADE",
        }),
      }),
    ]));
  });

  it("moves unstaged and untracked changes into a new child lane", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-rescue-success-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-rescue-success", repoRoot });

    const sourceWorktreePath = path.join(repoRoot, "parent");
    const primaryWorktreePath = path.join(repoRoot, "main");
    let stashMessage = "";
    let stashPushed = false;
    let createdWorktreePath = "";

    vi.mocked(getHeadSha).mockImplementation(async (cwd: string) => {
      if (cwd === sourceWorktreePath) return "sha-parent-head";
      return "sha-generic";
    });

    vi.mocked(runGitOrThrow).mockImplementation(async (args: string[], options: { cwd?: string } = {}) => {
      if (args[0] === "stash" && args[1] === "push") {
        stashPushed = true;
        stashMessage = args[args.length - 1] ?? "";
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      if (args[0] === "worktree" && args[1] === "add") {
        createdWorktreePath = args[4] ?? "";
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      if (args[0] === "stash" && args[1] === "apply") {
        expect(options.cwd).toBe(createdWorktreePath);
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      if (args[0] === "stash" && args[1] === "drop") {
        expect(options.cwd).toBe(sourceWorktreePath);
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    vi.mocked(runGit).mockImplementation(async (args: string[], options: { cwd?: string } = {}) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "status" && args[1] === "--porcelain=v1") {
        if (options.cwd === sourceWorktreePath) {
          return { exitCode: 0, stdout: stashPushed ? "" : " M src/file.ts\n?? src/new.ts\n", stderr: "" };
        }
        if (options.cwd === createdWorktreePath) {
          return { exitCode: 0, stdout: " M src/file.ts\n?? src/new.ts\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "stash" && args[1] === "list") {
        return { exitCode: 0, stdout: `stash@{0}\u001fOn feature/parent: ${stashMessage}\n`, stderr: "" };
      }
      if (args[0] === "push" && args[1] === "-u") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-list" && args[1] === "--left-right" && args[2] === "--count") {
        return { exitCode: 0, stdout: "0\t0\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "--symbolic-full-name" && args[3] === "@{upstream}") {
        return { exitCode: 1, stdout: "", stderr: "fatal: no upstream configured" };
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        return { exitCode: 1, stdout: "", stderr: "fatal: not a valid ref" };
      }
      if (args[0] === "rev-parse" && args[1] === "--path-format=absolute" && args[2] === "--git-dir") {
        return { exitCode: 1, stdout: "", stderr: "fatal: no git dir" };
      }
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") {
        expect(options.cwd).toBe(primaryWorktreePath);
        return { exitCode: 0, stdout: "main\n", stderr: "" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-rescue-success",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    const result = await service.createFromUnstaged({ sourceLaneId: "lane-parent", name: "Rescue lane" });

    expect(result.parentLaneId).toBe("lane-parent");
    expect(result.baseRef).toBe("feature/parent");
    expect(result.status.dirty).toBe(true);
    expect(runGitOrThrow).toHaveBeenCalledWith(
      ["stash", "push", "--keep-index", "-u", "-m", expect.stringContaining("ade-rescue-unstaged:lane-parent:")],
      expect.objectContaining({ cwd: sourceWorktreePath }),
    );
  });

  it("rejects the rescue flow when staged changes exist", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-rescue-staged-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-rescue-staged", repoRoot });

    const sourceWorktreePath = path.join(repoRoot, "parent");

    vi.mocked(getHeadSha).mockResolvedValue("sha-parent-head");
    vi.mocked(runGit).mockImplementation(async (args: string[], options: { cwd?: string } = {}) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "status" && args[1] === "--porcelain=v1" && options.cwd === sourceWorktreePath) {
        return { exitCode: 0, stdout: "M  src/file.ts\n", stderr: "" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-rescue-staged",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    await expect(service.createFromUnstaged({ sourceLaneId: "lane-parent", name: "Rescue lane" })).rejects.toThrow(
      /unstage all changes/i,
    );
    expect(runGitOrThrow).not.toHaveBeenCalled();
  });

  it("allows rescuing unstaged changes from the primary lane even when it is behind remote", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-rescue-primary-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-rescue-primary", repoRoot });

    const sourceWorktreePath = path.join(repoRoot, "main");
    let stashMessage = "";
    let stashPushed = false;
    let createdWorktreePath = "";

    vi.mocked(getHeadSha).mockImplementation(async (cwd: string) => {
      if (cwd === sourceWorktreePath) return "sha-main-head";
      return "sha-generic";
    });

    vi.mocked(runGitOrThrow).mockImplementation(async (args: string[], options: { cwd?: string } = {}) => {
      if (args[0] === "stash" && args[1] === "push") {
        stashPushed = true;
        stashMessage = args[args.length - 1] ?? "";
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      if (args[0] === "worktree" && args[1] === "add") {
        createdWorktreePath = args[4] ?? "";
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      if (args[0] === "stash" && args[1] === "apply") {
        expect(options.cwd).toBe(createdWorktreePath);
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      if (args[0] === "stash" && args[1] === "drop") {
        expect(options.cwd).toBe(sourceWorktreePath);
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    vi.mocked(runGit).mockImplementation(async (args: string[], options: { cwd?: string } = {}) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "status" && args[1] === "--porcelain=v1") {
        if (options.cwd === sourceWorktreePath) {
          return { exitCode: 0, stdout: stashPushed ? "" : " M README.md\n", stderr: "" };
        }
        if (options.cwd === createdWorktreePath) {
          return { exitCode: 0, stdout: " M README.md\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "stash" && args[1] === "list") {
        return { exitCode: 0, stdout: `stash@{0}\u001fOn main: ${stashMessage}\n`, stderr: "" };
      }
      if (args[0] === "push" && args[1] === "-u") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-list" && args[1] === "--left-right" && args[2] === "--count") {
        return { exitCode: 0, stdout: "3\t0\n", stderr: "" };
      }
      if (args[0] === "rev-list" && args[1] === "HEAD..@{upstream}" && args[2] === "--count") {
        return { exitCode: 0, stdout: "3\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "main@{upstream}") {
        return { exitCode: 0, stdout: "sha-origin-main\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "--symbolic-full-name" && args[3] === "@{upstream}") {
        return { exitCode: 0, stdout: "origin/main\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--path-format=absolute" && args[2] === "--git-dir") {
        return { exitCode: 1, stdout: "", stderr: "fatal: no git dir" };
      }
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") {
        return { exitCode: 0, stdout: "main\n", stderr: "" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-rescue-primary",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    const result = await service.createFromUnstaged({ sourceLaneId: "lane-main", name: "Primary rescue lane" });

    expect(result.parentLaneId).toBeNull();
    expect(result.baseRef).toBe("main");
    expect(vi.mocked(runGitOrThrow).mock.calls.some(([args]) => Array.isArray(args) && args[0] === "fetch")).toBe(false);
  });

  it("restores the source work and removes the new lane when applying in the target lane fails", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-rescue-rollback-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-rescue-rollback", repoRoot });

    const sourceWorktreePath = path.join(repoRoot, "parent");
    let stashMessage = "";
    let stashPushed = false;
    let createdWorktreePath = "";
    let restoredSource = false;

    vi.mocked(getHeadSha).mockImplementation(async (cwd: string) => {
      if (cwd === sourceWorktreePath) return "sha-parent-head";
      return "sha-generic";
    });

    vi.mocked(runGitOrThrow).mockImplementation(async (args: string[], options: { cwd?: string } = {}) => {
      if (args[0] === "stash" && args[1] === "push") {
        stashPushed = true;
        stashMessage = args[args.length - 1] ?? "";
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      if (args[0] === "worktree" && args[1] === "add") {
        createdWorktreePath = args[4] ?? "";
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      if (args[0] === "stash" && args[1] === "apply") {
        if (options.cwd === createdWorktreePath) {
          throw new Error("target apply failed");
        }
        if (options.cwd === sourceWorktreePath) {
          restoredSource = true;
          return { exitCode: 0, stdout: "", stderr: "" } as any;
        }
      }
      if (args[0] === "stash" && args[1] === "drop") {
        expect(options.cwd).toBe(sourceWorktreePath);
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        expect(args).toEqual(["worktree", "remove", "--force", createdWorktreePath]);
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      if (args[0] === "branch" && args[1] === "-D") {
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    vi.mocked(runGit).mockImplementation(async (args: string[], options: { cwd?: string } = {}) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "status" && args[1] === "--porcelain=v1") {
        if (options.cwd === sourceWorktreePath) {
          return { exitCode: 0, stdout: stashPushed ? "" : " M src/file.ts\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "stash" && args[1] === "list") {
        return { exitCode: 0, stdout: `stash@{0}\u001fOn feature/parent: ${stashMessage}\n`, stderr: "" };
      }
      if (args[0] === "push" && args[1] === "-u") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-list" && args[1] === "--left-right" && args[2] === "--count") {
        return { exitCode: 0, stdout: "0\t0\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "--symbolic-full-name" && args[3] === "@{upstream}") {
        return { exitCode: 1, stdout: "", stderr: "fatal: no upstream configured" };
      }
      if (args[0] === "rev-parse" && args[1] === "--path-format=absolute" && args[2] === "--git-dir") {
        return { exitCode: 1, stdout: "", stderr: "fatal: no git dir" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-rescue-rollback",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    await expect(service.createFromUnstaged({ sourceLaneId: "lane-parent", name: "Broken rescue lane" })).rejects.toThrow(
      /couldn't move unstaged changes/i,
    );
    expect(restoredSource).toBe(true);
    expect(db.get<{ count: number }>("select count(*) as count from lanes where project_id = ?", ["proj-rescue-rollback"])?.count).toBe(3);
  });

  it("rejects the rescue flow when there are no unstaged changes", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-rescue-empty-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-rescue-empty", repoRoot });

    const sourceWorktreePath = path.join(repoRoot, "parent");

    vi.mocked(getHeadSha).mockResolvedValue("sha-parent-head");
    vi.mocked(runGit).mockImplementation(async (args: string[], options: { cwd?: string } = {}) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "status" && args[1] === "--porcelain=v1" && options.cwd === sourceWorktreePath) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-rescue-empty",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    await expect(service.createFromUnstaged({ sourceLaneId: "lane-parent", name: "Empty rescue lane" })).rejects.toThrow(
      /no unstaged changes/i,
    );
    expect(runGitOrThrow).not.toHaveBeenCalled();
  });
});

describe("laneService create", () => {
  beforeEach(() => {
    vi.mocked(getHeadSha).mockReset();
    vi.mocked(runGit).mockReset();
    vi.mocked(runGitOrThrow).mockReset();
  });

  it("creates an unparented lane from the requested base branch", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-create-root-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const now = "2026-03-11T12:00:00.000Z";

    try {
      db.run(
        "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
        ["proj-create-root", repoRoot, "demo", "main", now, now],
      );
      db.run(
        `
          insert into lanes(
            id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
            attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        ["lane-main", "proj-create-root", "Main", null, "primary", "main", "fix-rebase-and-new-lane-flow", repoRoot, null, 0, null, null, null, null, "active", now, null],
      );

      vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
        if (args[0] === "worktree" && args[1] === "add") {
          return { exitCode: 0, stdout: "", stderr: "" } as any;
        }
        throw new Error(`Unexpected git call: ${args.join(" ")}`);
      });

      vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
        if (args[0] === "rev-parse" && args[1] === "main") {
          return { exitCode: 0, stdout: "sha-main\n", stderr: "" };
        }
        if (args[0] === "push" && args[1] === "-u") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "status" && args[1] === "--porcelain=v1") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "rev-list" && args[1] === "--left-right" && args[2] === "--count") {
          return { exitCode: 0, stdout: "0\t0\n", stderr: "" };
        }
        if (
          args[0] === "rev-parse"
          && args[1] === "--abbrev-ref"
          && args[2] === "--symbolic-full-name"
          && args[3] === "@{upstream}"
        ) {
          return { exitCode: 1, stdout: "", stderr: "fatal: no upstream configured" };
        }
        if (args[0] === "rev-parse" && args[1] === "--path-format=absolute" && args[2] === "--git-dir") {
          return { exitCode: 1, stdout: "", stderr: "fatal: no git dir" };
        }
        throw new Error(`Unexpected git call: ${args.join(" ")}`);
      });

      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-create-root",
        defaultBaseRef: "main",
        worktreesDir: path.join(repoRoot, "worktrees"),
      });

      const lane = await service.create({ name: "Git actions fixes", baseBranch: "main" });

      expect(lane.parentLaneId).toBeNull();
      expect(lane.baseRef).toBe("main");
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("cleans up the row, worktree, and branch when VM lane wiring fails", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-create-vm-fail-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const now = "2026-03-11T12:00:00.000Z";

    try {
      db.run(
        "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
        ["proj-create-vm-fail", repoRoot, "demo", "main", now, now],
      );
      db.run(
        `
          insert into lanes(
            id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
            attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        ["lane-main", "proj-create-vm-fail", "Main", null, "primary", "main", "main", repoRoot, null, 0, null, null, null, null, "active", now, null],
      );

      vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
        if (args[0] === "worktree" && args[1] === "add") {
          return { exitCode: 0, stdout: "", stderr: "" } as any;
        }
        if (args[0] === "worktree" && args[1] === "remove") {
          return { exitCode: 0, stdout: "", stderr: "" } as any;
        }
        throw new Error(`Unexpected git call: ${args.join(" ")}`);
      });

      vi.mocked(runGit).mockImplementation(async (args: string[]) => {
        const laneBranchGitStub = defaultLaneBranchGitStub(args);
        if (laneBranchGitStub) return laneBranchGitStub;
        if (args[0] === "rev-parse" && args[1] === "main") {
          return { exitCode: 0, stdout: "sha-main\n", stderr: "" };
        }
        if (args[0] === "branch" && args[1] === "-D") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        throw new Error(`Unexpected git call: ${args.join(" ")}`);
      });

      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-create-vm-fail",
        defaultBaseRef: "main",
        worktreesDir: path.join(repoRoot, "worktrees"),
        macosVmHooks: {
          linkLaneToCurrentVm: vi.fn(async () => {
            throw new Error("vm link failed");
          }),
        } as any,
      });

      await expect(
        service.create({
          name: "VM lane",
          baseBranch: "main",
          runtimePlacement: "macos-vm",
        }),
      ).rejects.toThrow("vm link failed");

      expect(
        db.get<{ count: number }>(
          "select count(*) as count from lanes where project_id = ? and lane_type = 'worktree'",
          ["proj-create-vm-fail"],
        )?.count,
      ).toBe(0);
      expect(vi.mocked(runGitOrThrow).mock.calls).toEqual(
        expect.arrayContaining([
          [
            expect.arrayContaining(["worktree", "remove", "--force"]),
            expect.objectContaining({ cwd: repoRoot }),
          ],
        ]),
      );
      expect(vi.mocked(runGit).mock.calls).toEqual(
        expect.arrayContaining([
          [
            expect.arrayContaining(["branch", "-D"]),
            expect.objectContaining({ cwd: repoRoot }),
          ],
        ]),
      );
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("does not emit placement changed when re-attaching a lane that is already on the VM", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-reattach-vm-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const now = "2026-03-11T12:00:00.000Z";
    const onPlacementChanged = vi.fn();
    const linkLaneToCurrentVm = vi.fn(async () => undefined);

    try {
      db.run(
        "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
        ["proj-reattach-vm", repoRoot, "demo", "main", now, now],
      );
      db.run(
        `
          insert into lanes(
            id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
            attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, runtime_placement, status, created_at, archived_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        ["lane-vm", "proj-reattach-vm", "VM", null, "worktree", "main", "feature/vm", path.join(repoRoot, "vm"), null, 0, null, null, null, null, "macos-vm", "active", now, null],
      );

      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-reattach-vm",
        defaultBaseRef: "main",
        worktreesDir: path.join(repoRoot, "worktrees"),
        onPlacementChanged,
        macosVmHooks: { linkLaneToCurrentVm } as any,
      });

      await service.attachLaneToVm({ laneId: "lane-vm" });

      expect(linkLaneToCurrentVm).toHaveBeenCalledWith({ laneId: "lane-vm" });
      expect(onPlacementChanged).not.toHaveBeenCalled();
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("creates an unparented lane from an explicit start point", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-create-start-point-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const now = "2026-03-11T12:00:00.000Z";
    let worktreeStartPoint: string | null = null;

    try {
      db.run(
        "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
        ["proj-create-start-point", repoRoot, "demo", "main", now, now],
      );

      vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
        if (args[0] === "worktree" && args[1] === "add") {
          worktreeStartPoint = args[5] ?? null;
          return { exitCode: 0, stdout: "", stderr: "" } as any;
        }
        throw new Error(`Unexpected git call: ${args.join(" ")}`);
      });

      vi.mocked(runGit).mockImplementation(async (args: string[]) => {
        const laneBranchGitStub = defaultLaneBranchGitStub(args);
        if (laneBranchGitStub) return laneBranchGitStub;
        if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "abc123456789") {
          return { exitCode: 0, stdout: "sha-selected\n", stderr: "" };
        }
        if (args[0] === "show-ref" && args[1] === "--verify" && args[2] === "--quiet") {
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        if (args[0] === "ls-remote") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "push" && args[1] === "-u") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "status" && args[1] === "--porcelain=v1") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "rev-list" && args[1] === "--left-right" && args[2] === "--count") {
          return { exitCode: 0, stdout: "0\t0\n", stderr: "" };
        }
        if (args[0] === "rev-parse" && args.includes("@{upstream}")) {
          return { exitCode: 1, stdout: "", stderr: "fatal: no upstream configured" };
        }
        if (args[0] === "rev-parse" && args.includes("--git-dir")) {
          return { exitCode: 1, stdout: "", stderr: "fatal: no git dir" };
        }
        throw new Error(`Unexpected git call: ${args.join(" ")}`);
      });

      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-create-start-point",
        defaultBaseRef: "main",
        worktreesDir: path.join(repoRoot, "worktrees"),
      });

      const lane = await service.create({
        name: "History point",
        baseBranch: "main",
        branchName: "history/point",
        startPoint: "abc123456789",
      });

      expect(lane.baseRef).toBe("main");
      expect(lane.branchRef).toBe("history/point");
      expect(worktreeStartPoint).toBe("sha-selected");
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("creates a fresh lane from primary using the project default base by default", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-create-from-primary-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const now = "2026-03-11T12:00:00.000Z";

    try {
      db.run(
        "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
        ["proj-create-from-primary", repoRoot, "demo", "main", now, now],
      );
      db.run(
        `
          insert into lanes(
            id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
            attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        ["lane-main", "proj-create-from-primary", "Main", null, "primary", "main", "feature/live-primary", repoRoot, null, 1, null, null, null, null, "active", now, null],
      );

      vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
        if (args[0] === "fetch" && args[1] === "--prune") {
          return { exitCode: 0, stdout: "", stderr: "" } as any;
        }
        if (args[0] === "worktree" && args[1] === "add") {
          return { exitCode: 0, stdout: "", stderr: "" } as any;
        }
        throw new Error(`Unexpected git call: ${args.join(" ")}`);
      });

      vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
        if (args[0] === "rev-parse" && args[1] === "@{upstream}") {
          return { exitCode: 1, stdout: "", stderr: "fatal: no upstream configured" };
        }
        if (args[0] === "rev-parse" && args[1] === "main") {
          return { exitCode: 0, stdout: "sha-main\n", stderr: "" };
        }
        if (args[0] === "push" && args[1] === "-u") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "status" && args[1] === "--porcelain=v1") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "rev-list" && args[1] === "--left-right" && args[2] === "--count") {
          return { exitCode: 0, stdout: "0\t0\n", stderr: "" };
        }
        if (
          args[0] === "rev-parse"
          && args[1] === "--abbrev-ref"
          && args[2] === "--symbolic-full-name"
          && args[3] === "@{upstream}"
        ) {
          return { exitCode: 1, stdout: "", stderr: "fatal: no upstream configured" };
        }
        if (args[0] === "rev-parse" && args[1] === "--path-format=absolute" && args[2] === "--git-dir") {
          return { exitCode: 1, stdout: "", stderr: "fatal: no git dir" };
        }
        throw new Error(`Unexpected git call: ${args.join(" ")}`);
      });

      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-create-from-primary",
        defaultBaseRef: "main",
        worktreesDir: path.join(repoRoot, "worktrees"),
      });

      const lane = await service.create({ name: "Fresh lane", parentLaneId: "lane-main" });

      expect(lane.parentLaneId).toBeNull();
      expect(lane.baseRef).toBe("main");
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("creates a root lane from the default base when the requested parent is primary", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-create-primary-parent-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const now = "2026-03-11T12:00:00.000Z";

    try {
      db.run(
        "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
        ["proj-create-primary-parent", repoRoot, "demo", "main", now, now],
      );
      db.run(
        `
          insert into lanes(
            id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
            attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        ["lane-main", "proj-create-primary-parent", "Primary", null, "primary", "main", "feature-overhaul", repoRoot, null, 1, null, null, null, null, "active", now, null],
      );

      vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
        if (args[0] === "worktree" && args[1] === "add") {
          return { exitCode: 0, stdout: "", stderr: "" } as any;
        }
        throw new Error(`Unexpected git call: ${args.join(" ")}`);
      });

      vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
        if (args[0] === "rev-parse" && args[1] === "main") {
          return { exitCode: 0, stdout: "sha-main\n", stderr: "" };
        }
        if (args[0] === "push" && args[1] === "-u") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "status" && args[1] === "--porcelain=v1") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "rev-list" && args[1] === "--left-right" && args[2] === "--count") {
          return { exitCode: 0, stdout: "0\t0\n", stderr: "" };
        }
        if (
          args[0] === "rev-parse"
          && args[1] === "--abbrev-ref"
          && args[2] === "--symbolic-full-name"
          && args[3] === "@{upstream}"
        ) {
          return { exitCode: 1, stdout: "", stderr: "fatal: no upstream configured" };
        }
        if (args[0] === "rev-parse" && args[1] === "--path-format=absolute" && args[2] === "--git-dir") {
          return { exitCode: 1, stdout: "", stderr: "fatal: no git dir" };
        }
        throw new Error(`Unexpected git call: ${args.join(" ")}`);
      });

      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-create-primary-parent",
        defaultBaseRef: "main",
        worktreesDir: path.join(repoRoot, "worktrees"),
      });

      const lane = await service.create({ name: "Fresh root lane", parentLaneId: "lane-main" });

      expect(lane.parentLaneId).toBeNull();
      expect(lane.baseRef).toBe("main");
      expect(vi.mocked(runGitOrThrow).mock.calls.some(([args]) => Array.isArray(args) && args[0] === "fetch")).toBe(false);
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("laneService list repairs", () => {
  beforeEach(() => {
    vi.mocked(getHeadSha).mockReset();
    vi.mocked(runGit).mockReset();
    vi.mocked(runGitOrThrow).mockReset();
  });

  it("repairs legacy root ADE lanes back to the default base when they have no open PR", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-repair-root-base-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const now = "2026-03-11T12:00:00.000Z";

    try {
      db.run(
        "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
        ["proj-repair-root-base", repoRoot, "demo", "main", now, now],
      );
      db.run(
        `
          insert into lanes(
            id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
            attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        ["lane-main", "proj-repair-root-base", "Main", null, "primary", "main", "feature-overhaul", repoRoot, null, 1, null, null, null, null, "active", now, null],
      );
      db.run(
        `
          insert into lanes(
            id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
            attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        ["lane-repair", "proj-repair-root-base", "Needs repair", null, "worktree", "proof-drawer", "ade/needs-repair", path.join(repoRoot, "repair"), null, 0, null, null, null, null, "active", now, null],
      );
      db.run(
        `
          insert into lanes(
            id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
            attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        ["lane-pr", "proj-repair-root-base", "Keep PR base", null, "worktree", "proof-drawer", "ade/keep-pr-base", path.join(repoRoot, "pr"), null, 0, null, null, null, null, "active", now, null],
      );
      db.run(
        `
          insert into pull_requests(
            id, project_id, lane_id, repo_owner, repo_name, github_pr_number, github_url, title,
            state, base_branch, head_branch, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          "pr-1",
          "proj-repair-root-base",
          "lane-pr",
          "ade",
          "ade",
          1,
          "https://example.com/pr/1",
          "Keep PR base",
          "open",
          "proof-drawer",
          "ade/keep-pr-base",
          now,
          now,
        ],
      );

      vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") {
          return { exitCode: 0, stdout: "feature-overhaul\n", stderr: "" };
        }
        throw new Error(`Unexpected git call: ${args.join(" ")}`);
      });

      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-repair-root-base",
        defaultBaseRef: "main",
        worktreesDir: path.join(repoRoot, "worktrees"),
      });

      const lanes = await service.list({ includeStatus: false });

      expect(lanes.find((lane) => lane.id === "lane-repair")?.baseRef).toBe("main");
      expect(lanes.find((lane) => lane.id === "lane-pr")?.baseRef).toBe("proof-drawer");
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("laneService importBranch", () => {
  beforeEach(() => {
    vi.mocked(getHeadSha).mockReset();
    vi.mocked(runGit).mockReset();
    vi.mocked(runGitOrThrow).mockReset();
  });

  it("surfaces unregistered managed .ade worktrees during lane list", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-list-managed-orphan-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-list-managed-orphan", repoRoot });
    const worktreesDir = path.join(repoRoot, ".ade", "worktrees");
    const orphanPath = path.join(worktreesDir, "dashboard-f6949524");

    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") {
        return { exitCode: 0, stdout: "main\n", stderr: "" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });
    vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return [
          `worktree ${repoRoot}`,
          "HEAD 1111111",
          "branch refs/heads/main",
          "",
          `worktree ${orphanPath}`,
          "HEAD 2222222",
          "branch refs/heads/ade/dashboard-f6949524",
          "",
        ].join("\n") as any;
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-list-managed-orphan",
      defaultBaseRef: "main",
      worktreesDir,
    });

    const lanes = await service.list({ includeStatus: false });
    const recovered = lanes.find((lane) => lane.branchRef === "ade/dashboard-f6949524");

    expect(recovered).toMatchObject({
      laneType: "worktree",
      baseRef: "main",
      branchRef: "ade/dashboard-f6949524",
      worktreePath: orphanPath,
    });
  });

  it("imports a branch from an explicit non-origin remote", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-import-upstream-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-import-upstream", repoRoot });

    vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
      if (args[0] === "branch" && args[1] === "--track") {
        expect(args).toEqual(["branch", "--track", "feature/import", "upstream/feature/import"]);
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      if (args[0] === "worktree" && args[1] === "add") {
        expect(args[2]).toContain(path.join("worktrees", "imported-lane-"));
        expect(args[3]).toBe("feature/import");
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "show-ref" && args[1] === "--verify" && args[3] === "refs/heads/upstream/feature/import") {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "fetch" && args[1] === "--prune" && args[2] === "--all") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "show-ref" && args[1] === "--verify" && args[3] === "refs/remotes/upstream/feature/import") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "show-ref" && args[1] === "--verify" && args[3] === "refs/heads/feature/import") {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "status" && args[1] === "--porcelain=v1") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-list" && args[1] === "--left-right" && args[2] === "--count") {
        return { exitCode: 0, stdout: "0\t0\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "--symbolic-full-name" && args[3] === "@{upstream}") {
        return { exitCode: 0, stdout: "upstream/feature/import\n", stderr: "" };
      }
      if (args[0] === "rev-list" && args[1] === "HEAD..@{upstream}" && args[2] === "--count") {
        return { exitCode: 0, stdout: "0\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--path-format=absolute" && args[2] === "--git-dir") {
        return { exitCode: 1, stdout: "", stderr: "fatal: no git dir" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-import-upstream",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    const result = await service.importBranch({ branchRef: "upstream/feature/import", name: "Imported lane" });

    expect(result.branchRef).toBe("feature/import");
    expect(result.baseRef).toBe("main");
    expect(result.parentLaneId).toBeNull();
    expect(runGitOrThrow).toHaveBeenCalledWith(
      ["branch", "--track", "feature/import", "upstream/feature/import"],
      expect.objectContaining({ cwd: repoRoot }),
    );
  });

  it("rejects duplicate imported branches before creating a local tracking branch", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-import-duplicate-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-import-duplicate", repoRoot });
    const now = "2026-03-11T12:05:00.000Z";
    db.run(
      `
        insert into lanes(
          id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
          attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ["lane-existing-import", "proj-import-duplicate", "Existing import", null, "worktree", "main", "feature/existing", path.join(repoRoot, "existing"), null, 0, "lane-main", null, null, null, "active", now, null],
    );

    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "show-ref" && args[1] === "--verify" && args[3] === "refs/heads/origin/feature/existing") {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "fetch" && args[1] === "--prune" && args[2] === "--all") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "show-ref" && args[1] === "--verify" && args[3] === "refs/remotes/origin/feature/existing") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "show-ref" && args[1] === "--verify" && args[3] === "refs/heads/feature/existing") {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-import-duplicate",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    await expect(service.importBranch({ branchRef: "origin/feature/existing" })).rejects.toThrow(
      "Lane already exists for branch 'feature/existing'",
    );
    expect(vi.mocked(runGitOrThrow).mock.calls.some(([args]) => args[0] === "branch" && args[1] === "--track")).toBe(false);
  });

  it("restores a managed orphan worktree before rejecting an import duplicate", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-import-managed-orphan-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-import-managed-orphan", repoRoot });
    const worktreesDir = path.join(repoRoot, ".ade", "worktrees");
    const orphanPath = path.join(worktreesDir, "dashboard-f6949524");

    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      if (args[0] === "show-ref" && args[1] === "--verify" && args[3] === "refs/heads/ade/dashboard-f6949524") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });
    vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return [
          `worktree ${repoRoot}`,
          "HEAD 1111111",
          "branch refs/heads/main",
          "",
          `worktree ${orphanPath}`,
          "HEAD 2222222",
          "branch refs/heads/ade/dashboard-f6949524",
          "",
        ].join("\n") as any;
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-import-managed-orphan",
      defaultBaseRef: "main",
      worktreesDir,
    });

    await expect(service.importBranch({ branchRef: "ade/dashboard-f6949524" })).rejects.toThrow(
      "Lane already exists for branch 'ade/dashboard-f6949524'",
    );

    const restored = db.get<{ branch_ref: string; worktree_path: string; status: string }>(
      "select branch_ref, worktree_path, status from lanes where project_id = ? and branch_ref = ?",
      ["proj-import-managed-orphan", "ade/dashboard-f6949524"],
    );
    expect(restored).toMatchObject({
      branch_ref: "ade/dashboard-f6949524",
      worktree_path: orphanPath,
      status: "active",
    });
    expect(vi.mocked(runGitOrThrow).mock.calls.some(([args]) => args[0] === "worktree" && args[1] === "add")).toBe(false);
  });

  it("reports an actionable error when a branch is already checked out outside ADE lanes", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-import-external-orphan-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-import-external-orphan", repoRoot });
    const externalPath = path.join(repoRoot, "..", "feature-taken");

    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      if (args[0] === "show-ref" && args[1] === "--verify" && args[3] === "refs/heads/origin/feature/taken") {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "fetch" && args[1] === "--prune" && args[2] === "--all") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "show-ref" && args[1] === "--verify" && args[3] === "refs/remotes/origin/feature/taken") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "show-ref" && args[1] === "--verify" && args[3] === "refs/heads/feature/taken") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });
    vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        return [
          `worktree ${repoRoot}`,
          "HEAD 1111111",
          "branch refs/heads/main",
          "",
          `worktree ${externalPath}`,
          "HEAD 2222222",
          "branch refs/heads/feature/taken",
          "",
        ].join("\n") as any;
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-import-external-orphan",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, ".ade", "worktrees"),
    });

    await expect(service.importBranch({ branchRef: "origin/feature/taken" })).rejects.toThrow(
      `Branch 'feature/taken' is already checked out at '${path.resolve(externalPath)}'`,
    );
    expect(vi.mocked(runGitOrThrow).mock.calls.some(([args]) => args[0] === "worktree" && args[1] === "add")).toBe(false);
  });

  it("reuses an existing local branch when importing a remote-qualified ref", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-import-local-existing-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-import-local-existing", repoRoot });

    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "show-ref" && args[1] === "--verify" && args[3] === "refs/heads/origin/feature/existing-local") {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "fetch" && args[1] === "--prune" && args[2] === "--all") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "show-ref" && args[1] === "--verify" && args[3] === "refs/remotes/origin/feature/existing-local") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "show-ref" && args[1] === "--verify" && args[3] === "refs/heads/feature/existing-local") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "status" && args[1] === "--porcelain=v1") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-list" && args[1] === "--left-right" && args[2] === "--count") {
        return { exitCode: 0, stdout: "0\t0\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "--symbolic-full-name" && args[3] === "@{upstream}") {
        return { exitCode: 0, stdout: "origin/feature/existing-local\n", stderr: "" };
      }
      if (args[0] === "rev-list" && args[1] === "HEAD..@{upstream}" && args[2] === "--count") {
        return { exitCode: 0, stdout: "0\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--path-format=absolute" && args[2] === "--git-dir") {
        return { exitCode: 1, stdout: "", stderr: "fatal: no git dir" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "add") {
        expect(args[3]).toBe("feature/existing-local");
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-import-local-existing",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    const result = await service.importBranch({ branchRef: "origin/feature/existing-local" });

    expect(result.branchRef).toBe("feature/existing-local");
    expect(vi.mocked(runGitOrThrow).mock.calls.some(([args]) => args[0] === "branch" && args[1] === "--track")).toBe(false);
  });

  it("removes a created tracking branch when worktree setup fails during import", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-import-cleanup-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-import-cleanup", repoRoot });

    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "show-ref" && args[1] === "--verify" && args[3] === "refs/heads/origin/feature/broken") {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "fetch" && args[1] === "--prune" && args[2] === "--all") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "show-ref" && args[1] === "--verify" && args[3] === "refs/remotes/origin/feature/broken") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "show-ref" && args[1] === "--verify" && args[3] === "refs/heads/feature/broken") {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
      if (args[0] === "branch" && args[1] === "--track") {
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      if (args[0] === "worktree" && args[1] === "add") {
        throw new Error("worktree add failed");
      }
      if (args[0] === "branch" && args[1] === "-D") {
        expect(args[2]).toBe("feature/broken");
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-import-cleanup",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    await expect(service.importBranch({ branchRef: "origin/feature/broken" })).rejects.toThrow("worktree add failed");
    expect(runGitOrThrow).toHaveBeenCalledWith(
      ["branch", "-D", "feature/broken"],
      expect.objectContaining({ cwd: repoRoot }),
    );
  });
});

describe("laneService rebaseStart", () => {
  beforeEach(() => {
    vi.mocked(getHeadSha).mockReset();
    vi.mocked(runGit).mockReset();
    vi.mocked(runGitOrThrow).mockReset();
  });

  it("skips rebasing when the parent head is already an ancestor of the lane head", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-skip-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-skip", repoRoot });
    const logs: string[] = [];

    vi.mocked(getHeadSha).mockImplementation(async (cwd: string) => {
      if (cwd.endsWith("/parent")) return "sha-parent";
      if (cwd.endsWith("/child")) return "sha-child";
      return "sha-main";
    });
    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-skip",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
      onRebaseEvent: (event) => {
        if (event.type === "rebase-run-log") logs.push(event.message);
      },
    });

    const result = await service.rebaseStart({ laneId: "lane-child", scope: "lane_only", actor: "user" });

    expect(result.run.state).toBe("completed");
    expect(result.run.error).toBeNull();
    expect(result.run.lanes).toHaveLength(1);
    expect(result.run.lanes[0]?.status).toBe("skipped");
    expect(result.run.lanes[0]?.preHeadSha).toBe("sha-child");
    expect(result.run.lanes[0]?.postHeadSha).toBe("sha-child");
    expect(logs.some((line) => line.includes("already up to date"))).toBe(true);
  });

  it("rebases an unparented lane against its stored base branch", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-root-base-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const now = "2026-03-11T12:00:00.000Z";
    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      ["proj-root-base", repoRoot, "demo", "main", now, now],
    );
    db.run(
      `insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["lane-main", "proj-root-base", "Main", null, "primary", "main", "main", path.join(repoRoot, "main"), null, 0, null, null, null, null, "active", now, null],
    );
    db.run(
      `insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["lane-root", "proj-root-base", "Root lane", null, "worktree", "main", "feature/root", path.join(repoRoot, "root"), null, 0, null, null, null, null, "active", now, null],
    );

    let rootHeadReads = 0;
    vi.mocked(getHeadSha).mockImplementation(async (cwd: string) => {
      if (cwd.endsWith("/root")) {
        rootHeadReads += 1;
        return rootHeadReads === 1 ? "sha-root-before" : "sha-root-after";
      }
      return "sha-main";
    });
    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "fetch" && args[1] === "--prune" && args[2] === "origin") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "origin/main") {
        return { exitCode: 0, stdout: "sha-origin-main\n", stderr: "" };
      }
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        expect(args[2]).toBe("sha-origin-main");
        expect(args[3]).toBe("sha-root-before");
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "status" && args[1] === "--porcelain=v1") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rebase") {
        expect(args[1]).toBe("sha-origin-main");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-root-base",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    const result = await service.rebaseStart({ laneId: "lane-root", scope: "lane_only", actor: "user" });

    expect(result.run.state).toBe("completed");
    expect(result.run.lanes[0]?.status).toBe("succeeded");
  });

  it("persists and restores the overridden base branch for PR-target rebases", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-root-override-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const now = "2026-03-11T12:00:00.000Z";
    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      ["proj-root-override", repoRoot, "demo", "main", now, now],
    );
    db.run(
      `insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["lane-main", "proj-root-override", "Main", null, "primary", "main", "main", path.join(repoRoot, "main"), null, 0, null, null, null, null, "active", now, null],
    );
    db.run(
      `insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["lane-root", "proj-root-override", "Root lane", null, "worktree", "release-9", "feature/root", path.join(repoRoot, "root"), null, 0, null, null, null, null, "active", now, null],
    );

    const rootHeadSequence = ["sha-root-before", "sha-root-after", "sha-root-after", "sha-root-before"];
    vi.mocked(getHeadSha).mockImplementation(async (cwd: string) => {
      if (cwd.endsWith("/root")) {
        return rootHeadSequence.shift() ?? "sha-root-before";
      }
      return "sha-main";
    });
    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "origin/main") {
        return { exitCode: 0, stdout: "sha-origin-main\n", stderr: "" };
      }
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        expect(args[2]).toBe("sha-origin-main");
        expect(args[3]).toBe("sha-root-before");
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "status" && args[1] === "--porcelain=v1") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rebase") {
        expect(args[1]).toBe("sha-origin-main");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });
    vi.mocked(runGitOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as any);

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-root-override",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    const started = await service.rebaseStart({
      laneId: "lane-root",
      scope: "lane_only",
      actor: "user",
      baseBranchOverride: "main",
    });

    const afterRebase = db.get("select base_ref from lanes where id = ?", ["lane-root"]) as { base_ref: string };
    expect(afterRebase.base_ref).toBe("main");

    await service.rebaseRollback({ runId: started.runId });

    const afterRollback = db.get("select base_ref from lanes where id = ?", ["lane-root"]) as { base_ref: string };
    expect(afterRollback.base_ref).toBe("release-9");
  });

  it("rejects overlapping rebase runs for the same stack while one is active", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-overlap-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-overlap", repoRoot });

    let resolveRebase: ((value: { exitCode: number; stdout: string; stderr: string }) => void) | null = null;
    vi.mocked(getHeadSha).mockImplementation(async (cwd: string) => {
      if (cwd.endsWith("/parent")) return "sha-parent";
      if (cwd.endsWith("/child")) return "sha-child";
      return "sha-main";
    });
    vi.mocked(runGit).mockImplementation((args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return Promise.resolve(laneBranchGitStub);
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        return Promise.resolve({ exitCode: 1, stdout: "", stderr: "" });
      }
      if (args[0] === "status" && args[1] === "--porcelain=v1") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      }
      if (args[0] === "rebase") {
        return new Promise((resolve) => {
          resolveRebase = resolve;
        });
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-overlap",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    const firstRun = service.rebaseStart({ laneId: "lane-child", scope: "lane_only", actor: "user" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(service.rebaseStart({ laneId: "lane-parent", scope: "lane_only", actor: "user" })).rejects.toThrow(
      /already active for this lane stack/i,
    );

    if (!resolveRebase) {
      throw new Error("Expected rebase resolver to be registered");
    }
    (resolveRebase as (value: { exitCode: number; stdout: string; stderr: string }) => void)({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const completed = await firstRun;
    expect(completed.run.state).toBe("completed");
  });

  it("rebases an unparented lane onto an override branch and persists the new base ref", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-root-override-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-root-override", repoRoot });
    const now = "2026-03-11T12:00:00.000Z";
    db.run(
      `
        insert into lanes(
          id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
          attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ["lane-root", "proj-root-override", "Root Lane", null, "worktree", "release-9", "feature/root", path.join(repoRoot, "root"), null, 0, null, null, null, null, "active", now, null],
    );

    let rootHeadReads = 0;
    vi.mocked(getHeadSha).mockImplementation(async (cwd: string) => {
      if (cwd.endsWith("/root")) {
        rootHeadReads += 1;
        return rootHeadReads === 1 ? "sha-root-pre" : "sha-root-post";
      }
      return "sha-unused";
    });
    vi.mocked(runGitOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as any);
    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "origin/main") {
        return { exitCode: 0, stdout: "sha-origin-main\n", stderr: "" };
      }
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        expect(args[2]).toBe("sha-origin-main");
        expect(args[3]).toBe("sha-root-pre");
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "status" && args[1] === "--porcelain=v1") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rebase") {
        expect(args[1]).toBe("sha-origin-main");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "fetch" && args[1] === "--prune" && args[2] === "origin") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-root-override",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    const result = await service.rebaseStart({
      laneId: "lane-root",
      scope: "lane_only",
      actor: "user",
      baseBranchOverride: "main",
    });

    expect(result.run.state).toBe("completed");
    expect(result.run.baseBranch).toBe("main");
    expect(result.run.rootBaseRefBefore).toBe("release-9");
    expect(result.run.rootBaseRefAfter).toBe("main");
    const updated = await service.list({ includeStatus: false });
    expect(updated.find((lane) => lane.id === "lane-root")?.baseRef).toBe("main");
    expect(updated.find((lane) => lane.id === "lane-root")?.parentLaneId).toBeNull();
  });

  it("rebases against the primary lane remote tracking ref when it is available", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-primary-remote-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-primary-remote", repoRoot });

    vi.mocked(runGitOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as any);
    vi.mocked(getHeadSha).mockImplementation(async (cwd: string) => {
      if (cwd.endsWith("/parent")) return "sha-parent";
      return "sha-main";
    });
    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (
        args[0] === "rev-parse"
        && args[1] === "--abbrev-ref"
        && args[2] === "--symbolic-full-name"
        && args[3] === "@{upstream}"
      ) {
        return { exitCode: 0, stdout: "origin/main\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "origin/main") {
        return { exitCode: 0, stdout: "sha-origin-main\n", stderr: "" };
      }
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        expect(args[2]).toBe("sha-origin-main");
        expect(args[3]).toBe("sha-parent");
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "status" && args[1] === "--porcelain=v1") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rebase") {
        expect(args[1]).toBe("sha-origin-main");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-primary-remote",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    const result = await service.rebaseStart({ laneId: "lane-parent", scope: "lane_only", actor: "user" });

    expect(result.run.state).toBe("completed");
    expect(result.run.error).toBeNull();
    expect(result.run.lanes[0]?.status).toBe("succeeded");
    expect(vi.mocked(runGitOrThrow)).toHaveBeenCalled();
  });

  it("falls back to origin/<base_ref> for a detached root lane", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-origin-fallback-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-origin-fallback", repoRoot });
    const logs: string[] = [];

    vi.mocked(runGitOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as any);
    vi.mocked(getHeadSha).mockImplementation(async (cwd: string) => {
      if (cwd.endsWith("/parent")) return "sha-parent";
      return "sha-main";
    });
    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      // upstream detection fails (no upstream configured)
      if (
        args[0] === "rev-parse"
        && args[1] === "--abbrev-ref"
        && args[2] === "--symbolic-full-name"
        && args[3] === "@{upstream}"
      ) {
        return { exitCode: 1, stdout: "", stderr: "fatal: no upstream configured" };
      }
      // origin/main exists and resolves
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "origin/main") {
        return { exitCode: 0, stdout: "sha-origin-main\n", stderr: "" };
      }
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        expect(args[2]).toBe("sha-origin-main");
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "status" && args[1] === "--porcelain=v1") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rebase") {
        expect(args[1]).toBe("sha-origin-main");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-origin-fallback",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
      onRebaseEvent: (event) => {
        if (event.type === "rebase-run-log") logs.push(event.message);
      },
    });

    const result = await service.rebaseStart({ laneId: "lane-parent", scope: "lane_only", actor: "user" });

    expect(result.run.state).toBe("completed");
    expect(result.run.lanes[0]?.status).toBe("succeeded");
    // Detached root lanes log the resolved base branch label directly.
    const rebaseLog = logs.find((line) => line.includes("Rebasing"));
    expect(rebaseLog, "expected a 'Rebasing' log entry").toBeTruthy();
    expect(rebaseLog).toContain("main (origin/main)");
  });

  it("fails when neither origin/<base_ref> nor the local base branch can be resolved for a detached root lane", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-all-remote-fail-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-all-remote-fail", repoRoot });
    const logs: string[] = [];

    vi.mocked(runGitOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as any);
    vi.mocked(getHeadSha).mockImplementation(async (cwd: string) => {
      if (cwd.endsWith("/parent")) return "sha-parent-local";
      if (cwd.endsWith("/main")) return "sha-main-local";
      return "sha-main";
    });
    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      // upstream detection fails
      if (
        args[0] === "rev-parse"
        && args[1] === "--abbrev-ref"
        && args[2] === "--symbolic-full-name"
        && args[3] === "@{upstream}"
      ) {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      // origin/main also fails to resolve
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        return { exitCode: 1, stdout: "", stderr: "fatal: not a valid ref" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-all-remote-fail",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
      onRebaseEvent: (event) => {
        if (event.type === "rebase-run-log") logs.push(event.message);
      },
    });

    const result = await service.rebaseStart({ laneId: "lane-parent", scope: "lane_only", actor: "user" });

    expect(result.run.state).toBe("failed");
    expect(result.run.error).toContain('Unable to resolve base branch "main".');
    expect(result.run.lanes[0]?.status).toBe("blocked");
  });

  it("uses parent HEAD directly for non-primary (worktree) parent without remote resolution", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-worktree-parent-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-worktree-parent", repoRoot });
    const logs: string[] = [];

    // lane-child has parent lane-parent (which is lane_type=worktree, not primary)
    vi.mocked(runGitOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as any);
    vi.mocked(getHeadSha).mockImplementation(async (cwd: string) => {
      if (cwd.endsWith("/parent")) return "sha-parent-head";
      if (cwd.endsWith("/child")) return "sha-child-head";
      return "sha-main";
    });
    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      // For a worktree parent, resolveParentRebaseTarget should NOT call
      // rev-parse for upstream or origin refs. It goes straight to getHeadSha.
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        throw new Error("Should not resolve upstream for non-primary parent");
      }
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        expect(args[2]).toBe("sha-parent-head");
        expect(args[3]).toBe("sha-child-head");
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "status" && args[1] === "--porcelain=v1") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rebase") {
        expect(args[1]).toBe("sha-parent-head");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-worktree-parent",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
      onRebaseEvent: (event) => {
        if (event.type === "rebase-run-log") logs.push(event.message);
      },
    });

    const result = await service.rebaseStart({ laneId: "lane-child", scope: "lane_only", actor: "user" });

    expect(result.run.state).toBe("completed");
    expect(result.run.lanes[0]?.status).toBe("succeeded");
    // For worktree parent, the label is the parent name itself, so no parenthesized ref
    const rebaseLog = logs.find((line) => line.includes("Rebasing"));
    expect(rebaseLog, "expected a 'Rebasing' log entry").toBeTruthy();
    // parentHead.slice(0, 8) truncates the sha, so check substring
    expect(rebaseLog).toContain("onto Parent (sha-pare");
    expect(rebaseLog).not.toContain("origin/");
  });

  it("fails the rebase run when the detached root lane base branch cannot be resolved", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-unresolvable-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-unresolvable", repoRoot });

    vi.mocked(runGitOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as any);
    // Detached root lanes no longer consult the primary parent HEAD.
    vi.mocked(getHeadSha).mockImplementation(async (cwd: string) => {
      if (cwd.endsWith("/parent")) return "sha-parent";
      if (cwd.endsWith("/main")) return null;
      return null;
    });
    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      // All remote resolution attempts fail
      if (args[0] === "rev-parse") {
        return { exitCode: 1, stdout: "", stderr: "fatal: not found" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-unresolvable",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    const result = await service.rebaseStart({ laneId: "lane-parent", scope: "lane_only", actor: "user" });

    expect(result.run.state).toBe("failed");
    expect(result.run.error).toContain('Unable to resolve base branch "main".');
    expect(result.run.lanes[0]?.status).toBe("blocked");
  });

  it("includes the resolved base-branch label in skip logs for detached root lanes", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-skip-label-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-skip-label", repoRoot });
    const logs: string[] = [];

    vi.mocked(runGitOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as any);
    vi.mocked(getHeadSha).mockImplementation(async (cwd: string) => {
      if (cwd.endsWith("/parent")) return "sha-parent";
      return "sha-main";
    });
    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (
        args[0] === "rev-parse"
        && args[1] === "--abbrev-ref"
        && args[2] === "--symbolic-full-name"
        && args[3] === "@{upstream}"
      ) {
        return { exitCode: 0, stdout: "origin/main\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "origin/main") {
        return { exitCode: 0, stdout: "sha-origin-main\n", stderr: "" };
      }
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        // Already an ancestor => skip
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-skip-label",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
      onRebaseEvent: (event) => {
        if (event.type === "rebase-run-log") logs.push(event.message);
      },
    });

    const result = await service.rebaseStart({ laneId: "lane-parent", scope: "lane_only", actor: "user" });

    expect(result.run.state).toBe("completed");
    expect(result.run.lanes[0]?.status).toBe("skipped");
    const skipLog = logs.find((line) => line.includes("already up to date"));
    expect(skipLog, "expected an 'already up to date' log entry").toBeTruthy();
    expect(skipLog).toContain("main (origin/main)");
  });

  it("fails the rebase run when the worktree has uncommitted changes", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-dirty-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-dirty", repoRoot });
    const logs: string[] = [];

    vi.mocked(getHeadSha).mockImplementation(async (cwd: string) => {
      if (cwd.endsWith("/parent")) return "sha-parent";
      if (cwd.endsWith("/child")) return "sha-child";
      return "sha-main";
    });
    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "status" && args[1] === "--porcelain=v1") {
        // Worktree is dirty
        return { exitCode: 0, stdout: " M src/file.ts\n", stderr: "" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-dirty",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
      onRebaseEvent: (event) => {
        if (event.type === "rebase-run-log") logs.push(event.message);
      },
    });

    const result = await service.rebaseStart({ laneId: "lane-child", scope: "lane_only", actor: "user" });

    expect(result.run.state).toBe("failed");
    expect(result.run.error).toContain("uncommitted changes");
    expect(result.run.lanes[0]?.status).toBe("blocked");
    const dirtyLog = logs.find((line) => line.includes("dirty"));
    expect(dirtyLog, "expected a dirty worktree log entry").toBeTruthy();
  });

  it("uses deduplicated candidate refs when upstream equals origin/<branch_ref>", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-dedup-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-dedup", repoRoot });

    vi.mocked(runGitOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as any);
    vi.mocked(getHeadSha).mockImplementation(async (cwd: string) => {
      if (cwd.endsWith("/parent")) return "sha-parent";
      return "sha-main";
    });

    const revParseVerifyCalls: string[] = [];
    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (
        args[0] === "rev-parse"
        && args[1] === "--abbrev-ref"
        && args[2] === "--symbolic-full-name"
        && args[3] === "@{upstream}"
      ) {
        // upstream IS origin/main, matching the fallback origin/<branch_ref>
        return { exitCode: 0, stdout: "origin/main\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        revParseVerifyCalls.push(args[2] ?? "");
        return { exitCode: 0, stdout: "sha-origin-main\n", stderr: "" };
      }
      if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-dedup",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    const result = await service.rebaseStart({ laneId: "lane-parent", scope: "lane_only", actor: "user" });

    expect(result.run.state).toBe("completed");
    // When upstream is already origin/main, it should NOT add origin/main twice
    // to candidateRefs. So only one rev-parse --verify call should happen.
    expect(revParseVerifyCalls).toHaveLength(1);
    expect(revParseVerifyCalls[0]).toBe("origin/main");
  });
});

describe("laneService reparent", () => {
  beforeEach(() => {
    vi.mocked(getHeadSha).mockReset();
    vi.mocked(runGit).mockReset();
    vi.mocked(runGitOrThrow).mockReset();
  });

  it("uses the primary lane's remote tracking ref when reparenting under primary", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-reparent-primary-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-reparent-primary", repoRoot });

    let childHeadReads = 0;
    vi.mocked(getHeadSha).mockImplementation(async (cwd: string) => {
      if (cwd.endsWith("/child")) {
        childHeadReads += 1;
        return childHeadReads === 1 ? "sha-child-pre" : "sha-child-post";
      }
      return "sha-unused";
    });

    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (
        args[0] === "rev-parse"
        && args[1] === "--abbrev-ref"
        && args[2] === "--symbolic-full-name"
        && args[3] === "@{upstream}"
      ) {
        return { exitCode: 0, stdout: "origin/main\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "origin/main") {
        return { exitCode: 0, stdout: "sha-origin-main\n", stderr: "" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
      if (args[0] === "rebase") {
        expect(args[1]).toBe("sha-origin-main");
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-reparent-primary",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    const result = await service.reparent({ laneId: "lane-child", newParentLaneId: "lane-main" });

    expect(result.previousParentLaneId).toBe("lane-parent");
    expect(result.newParentLaneId).toBe("lane-main");
    expect(result.preHeadSha).toBe("sha-child-pre");
    expect(result.postHeadSha).toBe("sha-child-post");
    expect(runGitOrThrow).toHaveBeenCalledWith(
      ["rebase", "sha-origin-main"],
      expect.objectContaining({ cwd: path.join(repoRoot, "child") }),
    );
    expect(
      db.get<{ base_ref: string; parent_lane_id: string | null }>(
        "select base_ref, parent_lane_id from lane_branch_profiles where lane_id = ? and branch_ref = ?",
        ["lane-child", "feature/child"],
      ),
    ).toEqual({ base_ref: "main", parent_lane_id: null });
  });

  it("reparents onto stackBaseBranchRef when provided", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-reparent-stack-base-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-reparent-stack-base", repoRoot });

    let childHeadReads = 0;
    vi.mocked(getHeadSha).mockImplementation(async (cwd: string) => {
      if (cwd.endsWith("/child")) {
        childHeadReads += 1;
        return childHeadReads === 1 ? "sha-child-pre" : "sha-child-post";
      }
      return "sha-unused";
    });

    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "origin/develop") {
        return { exitCode: 0, stdout: "sha-origin-develop\n", stderr: "" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
      if (args[0] === "rebase") {
        expect(args[1]).toBe("sha-origin-develop");
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-reparent-stack-base",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    const result = await service.reparent({
      laneId: "lane-child",
      newParentLaneId: "lane-main",
      stackBaseBranchRef: "develop",
    });

    expect(result.newBaseRef).toBe("develop");
    expect(result.newParentLaneId).toBe("lane-main");
    expect(runGitOrThrow).toHaveBeenCalledWith(
      ["rebase", "sha-origin-develop"],
      expect.objectContaining({ cwd: path.join(repoRoot, "child") }),
    );
    expect(
      db.get<{ base_ref: string; parent_lane_id: string | null }>(
        "select base_ref, parent_lane_id from lane_branch_profiles where lane_id = ? and branch_ref = ?",
        ["lane-child", "feature/child"],
      ),
    ).toEqual({ base_ref: "develop", parent_lane_id: null });
  });

  it("restores the active branch profile when reparent rebase fails", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-reparent-rollback-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-reparent-rollback", repoRoot });

    vi.mocked(getHeadSha).mockResolvedValue("sha-child");
    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (
        args[0] === "rev-parse"
        && args[1] === "--abbrev-ref"
        && args[2] === "--symbolic-full-name"
        && args[3] === "@{upstream}"
      ) {
        return { exitCode: 0, stdout: "origin/main\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "origin/main") {
        return { exitCode: 0, stdout: "sha-origin-main\n", stderr: "" };
      }
      if (args[0] === "rebase" && args[1] === "--abort") {
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
      if (args[0] === "rebase") throw new Error("rebase failed");
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-reparent-rollback",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    await expect(service.reparent({ laneId: "lane-child", newParentLaneId: "lane-main" })).rejects.toThrow("rebase failed");
    expect(
      db.get<{ base_ref: string; parent_lane_id: string | null }>(
        "select base_ref, parent_lane_id from lanes where id = ?",
        ["lane-child"],
      ),
    ).toEqual({ base_ref: "feature/parent", parent_lane_id: "lane-parent" });
    expect(
      db.get<{ base_ref: string; parent_lane_id: string | null }>(
        "select base_ref, parent_lane_id from lane_branch_profiles where lane_id = ? and branch_ref = ?",
        ["lane-child", "feature/child"],
      ),
    ).toEqual({ base_ref: "feature/parent", parent_lane_id: "lane-parent" });
  });

  it("skips git rebase when parent and base ref are unchanged", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-reparent-noop-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-reparent-noop", repoRoot });

    vi.mocked(getHeadSha).mockResolvedValue("sha-stable");
    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });
    vi.mocked(runGitOrThrow).mockReset();

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-reparent-noop",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    await service.reparent({ laneId: "lane-child", newParentLaneId: "lane-parent" });

    expect(runGitOrThrow).not.toHaveBeenCalled();
  });
});

describe("laneService createChild", () => {
  beforeEach(() => {
    vi.mocked(getHeadSha).mockReset();
    vi.mocked(runGit).mockReset();
    vi.mocked(runGitOrThrow).mockReset();
  });

  it("createChild links existing app dependency installs into the worktree", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-child-deps-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-child-deps", repoRoot });
    fs.mkdirSync(path.join(repoRoot, "apps", "desktop", "node_modules"), { recursive: true });

    const parentWorktreePath = path.join(repoRoot, "parent");
    vi.mocked(getHeadSha).mockImplementation(async (cwd: string) => {
      if (cwd === parentWorktreePath) return "sha-parent-head";
      return "sha-generic";
    });

    let createdWorktreePath = "";
    vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "add") {
        createdWorktreePath = args[4] ?? "";
        fs.mkdirSync(path.join(createdWorktreePath, "apps", "desktop"), { recursive: true });
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });
    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "push" && args[1] === "-u") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "status" && args[1] === "--porcelain=v1") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "rev-list" && args[1] === "--left-right" && args[2] === "--count") return { exitCode: 0, stdout: "0\t0\n", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "--symbolic-full-name" && args[3] === "@{upstream}") return { exitCode: 1, stdout: "", stderr: "" };
      if (args[0] === "rev-parse" && args[1] === "--path-format=absolute" && args[2] === "--git-dir") return { exitCode: 1, stdout: "", stderr: "" };
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-child-deps",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    await service.createChild({
      parentLaneId: "lane-parent",
      name: "Worker lane",
    });

    expect(createdWorktreePath).toBeTruthy();
    const linked = fs.lstatSync(path.join(createdWorktreePath, "apps", "desktop", "node_modules"));
    expect(linked.isSymbolicLink()).toBe(true);
  });

  it("createChild from primary anchors the new lane to the project default base", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-child-primary-default-base-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const now = "2026-03-11T12:00:00.000Z";

    try {
      db.run(
        "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
        ["proj-child-primary-default-base", repoRoot, "demo", "main", now, now],
      );
      db.run(
        `
          insert into lanes(
            id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
            attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        ["lane-main", "proj-child-primary-default-base", "Main", null, "primary", "main", "feature/live-primary", repoRoot, null, 1, null, null, null, null, "active", now, null],
      );

      vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
        if (args[0] === "worktree" && args[1] === "add") {
          return { exitCode: 0, stdout: "", stderr: "" } as any;
        }
        throw new Error(`Unexpected git call: ${args.join(" ")}`);
      });

      vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
        if (args[0] === "rev-parse" && args[1] === "main") {
          return { exitCode: 0, stdout: "sha-main\n", stderr: "" };
        }
        if (args[0] === "push" && args[1] === "-u") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "status" && args[1] === "--porcelain=v1") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "rev-list" && args[1] === "--left-right" && args[2] === "--count") {
          return { exitCode: 0, stdout: "0\t0\n", stderr: "" };
        }
        if (
          args[0] === "rev-parse"
          && args[1] === "--abbrev-ref"
          && args[2] === "--symbolic-full-name"
          && args[3] === "@{upstream}"
        ) {
          return { exitCode: 1, stdout: "", stderr: "fatal: no upstream configured" };
        }
        if (args[0] === "rev-parse" && args[1] === "--path-format=absolute" && args[2] === "--git-dir") {
          return { exitCode: 1, stdout: "", stderr: "fatal: no git dir" };
        }
        throw new Error(`Unexpected git call: ${args.join(" ")}`);
      });

      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-child-primary-default-base",
        defaultBaseRef: "main",
        worktreesDir: path.join(repoRoot, "worktrees"),
      });

      const lane = await service.createChild({
        parentLaneId: "lane-main",
        name: "Primary child lane",
      });

      expect(lane.parentLaneId).toBeNull();
      expect(lane.baseRef).toBe("main");
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("createChild with baseBranchRef tracks remote-only branch and bases lane on it", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-child-base-override-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-child-base-override", repoRoot });

    const trackCalls: string[][] = [];

    vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
      if (args[0] === "branch" && args[1] === "--track") {
        trackCalls.push([...args]);
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      if (args[0] === "worktree" && args[1] === "add") {
        // worktree add -b <new-branch> <path> <startPoint>
        expect(args[2]).toBe("-b");
        expect(args[5]).toBe("sha-feature-remote");
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "show-ref" && args[1] === "--verify" && args[3] === "refs/heads/origin/feature/remote-only") {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "fetch" && args[1] === "--prune" && args[2] === "--all") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "show-ref" && args[1] === "--verify" && args[3] === "refs/remotes/origin/feature/remote-only") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "show-ref" && args[1] === "--verify" && args[3] === "refs/heads/feature/remote-only") {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "feature/remote-only") {
        return { exitCode: 0, stdout: "sha-feature-remote\n", stderr: "" };
      }
      if (args[0] === "push" && args[1] === "-u") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "status" && args[1] === "--porcelain=v1") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-list" && args[1] === "--left-right" && args[2] === "--count") {
        return { exitCode: 0, stdout: "0\t0\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "--symbolic-full-name" && args[3] === "@{upstream}") {
        return { exitCode: 1, stdout: "", stderr: "fatal: no upstream configured" };
      }
      if (args[0] === "rev-parse" && args[1] === "--path-format=absolute" && args[2] === "--git-dir") {
        return { exitCode: 1, stdout: "", stderr: "fatal: no git dir" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-child-base-override",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    const lane = await service.createChild({
      parentLaneId: "lane-parent",
      name: "Override base child",
      baseBranchRef: "origin/feature/remote-only",
    });

    expect(trackCalls).toEqual([["branch", "--track", "feature/remote-only", "origin/feature/remote-only"]]);
    expect(lane.baseRef).toBe("feature/remote-only");
    expect(lane.parentLaneId).toBe("lane-parent");
  });

});

describe("laneService updateAppearance color uniqueness", () => {
  beforeEach(() => {
    vi.mocked(getHeadSha).mockReset();
    vi.mocked(runGit).mockReset();
    vi.mocked(runGitOrThrow).mockReset();
  });

  async function setup() {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-color-uniqueness-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-color-uniqueness", repoRoot });
    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-color-uniqueness",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });
    return { db, service };
  }

  it("rejects an update when another active lane already uses the color", async () => {
    const { db, service } = await setup();
    db.run("update lanes set color = ? where id = ?", ["#a78bfa", "lane-parent"]);

    expect(() =>
      service.updateAppearance({ laneId: "lane-child", color: "#a78bfa" }),
    ).toThrow(/already in use by lane "Parent"/);

    const child = db.get<{ color: string | null }>("select color from lanes where id = ?", ["lane-child"]);
    expect(child?.color).toBeNull();
  });

  it("treats hex comparison case-insensitively when detecting conflicts", async () => {
    const { service, db } = await setup();
    db.run("update lanes set color = ? where id = ?", ["#a78bfa", "lane-parent"]);

    expect(() =>
      service.updateAppearance({ laneId: "lane-child", color: "#A78BFA" }),
    ).toThrow(/already in use/i);
  });

  it("allows assigning a color that no other active lane is using", async () => {
    const { db, service } = await setup();
    db.run("update lanes set color = ? where id = ?", ["#a78bfa", "lane-parent"]);

    service.updateAppearance({ laneId: "lane-child", color: "#60a5fa" });

    const child = db.get<{ color: string | null }>("select color from lanes where id = ?", ["lane-child"]);
    expect(child?.color).toBe("#60a5fa");
  });

  it("ignores archived lanes when checking for color conflicts", async () => {
    const { db, service } = await setup();
    db.run(
      "update lanes set color = ?, status = 'archived', archived_at = ? where id = ?",
      ["#a78bfa", "2026-04-01T00:00:00.000Z", "lane-parent"],
    );

    service.updateAppearance({ laneId: "lane-child", color: "#a78bfa" });

    const child = db.get<{ color: string | null }>("select color from lanes where id = ?", ["lane-child"]);
    expect(child?.color).toBe("#a78bfa");
  });

  it("does not run the conflict probe when the color is unchanged (idempotent appearance updates)", async () => {
    const { db, service } = await setup();
    // Two active lanes share the same stored color (e.g. legacy data before
    // the uniqueness check existed). Updating one of them with the SAME color
    // should succeed because the new value equals lane.color.
    db.run("update lanes set color = ? where id = ?", ["#a78bfa", "lane-parent"]);
    db.run("update lanes set color = ? where id = ?", ["#a78bfa", "lane-child"]);

    expect(() =>
      service.updateAppearance({ laneId: "lane-child", color: "#a78bfa", icon: "star" }),
    ).not.toThrow();

    const child = db.get<{ color: string | null; icon: string | null }>(
      "select color, icon from lanes where id = ?",
      ["lane-child"],
    );
    expect(child?.color).toBe("#a78bfa");
    expect(child?.icon).toBe("star");
  });
});

describe("laneService delete teardown + cancellation + streaming", () => {
  beforeEach(() => {
    vi.mocked(getHeadSha).mockReset();
    vi.mocked(runGit).mockReset();
    vi.mocked(runGitOrThrow).mockReset();
  });

  function makeFakeServices() {
    const calls: string[] = [];
    const processService = {
      listRuntime: vi.fn(() => [
        { status: "running", processId: "vite", laneId: "lane-target", runId: "r1" } as any,
      ]),
      stopAll: vi.fn(async (_args: { laneId: string }) => {
        calls.push("stop_processes");
      }),
    };
    const ptyService = {
      countActiveForLane: vi.fn(() => 2),
      disposeForLane: vi.fn(() => {
        calls.push("stop_ptys");
        return 2;
      }),
    };
    const fileWatcherService = {
      countActiveForWorkspace: vi.fn(() => 1),
      stopAllForWorkspace: vi.fn(() => {
        calls.push("stop_watchers");
        return 1;
      }),
    };
    const autoRebaseService = {
      cancelForLane: vi.fn(() => {
        calls.push("cancel_auto_rebase");
      }),
    };
    const rebaseSuggestionService = {
      dismiss: vi.fn(async () => {
        // already counted by cancel_auto_rebase step; do not duplicate
      }),
    };
    return { calls, processService, ptyService, fileWatcherService, autoRebaseService, rebaseSuggestionService };
  }

  async function setupWithLane(opts: { teardown: ReturnType<typeof makeFakeServices>; events: any[]; createWorktree?: boolean }) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-delete-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const projectId = "proj-delete";
    await seedProjectAndStack(db, { projectId, repoRoot });
    // Materialize the lane-child worktree dir so the delete flow exercises git_worktree_remove.
    const childPath = path.join(repoRoot, "child");
    if (opts.createWorktree !== false) fs.mkdirSync(childPath, { recursive: true });
    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId,
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
      onDeleteEvent: (event) => opts.events.push(event),
      teardownDeps: {
        processService: opts.teardown.processService,
        ptyService: opts.teardown.ptyService,
        fileWatcherService: opts.teardown.fileWatcherService,
        autoRebaseService: opts.teardown.autoRebaseService,
        rebaseSuggestionService: opts.teardown.rebaseSuggestionService,
      },
    });
    // First call (lane-child) has no children rows after the seed; we delete lane-child.
    return { db, service, repoRoot };
  }

  it("runs teardown steps before git_worktree_remove and broadcasts per-step progress", async () => {
    const events: any[] = [];
    const fake = makeFakeServices();
    const { service } = await setupWithLane({ teardown: fake, events });
    // git status: clean. git_worktree_remove: succeeds. branch ref check: not found (skip branch delete).
    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" } as any;
      if (args[0] === "show-ref") return { exitCode: 1, stdout: "", stderr: "" } as any;
      if (args[0] === "worktree" && args[1] === "remove") {
        fake.calls.push("git_worktree_remove");
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      return { exitCode: 0, stdout: "", stderr: "" } as any;
    });
    vi.mocked(runGitOrThrow).mockImplementation(async () => {
      return { exitCode: 0, stdout: "", stderr: "" } as any;
    });

    await service.delete({ laneId: "lane-child", deleteBranch: false });

    // Teardown happens before the git destructive step.
    const wtIdx = fake.calls.indexOf("git_worktree_remove");
    expect(fake.calls.indexOf("stop_processes")).toBeLessThan(wtIdx);
    expect(fake.calls.indexOf("stop_ptys")).toBeLessThan(wtIdx);
    expect(fake.calls.indexOf("stop_watchers")).toBeLessThan(wtIdx);
    expect(fake.calls.indexOf("cancel_auto_rebase")).toBeLessThan(wtIdx);

    // Final event reports overall completion.
    const last = events[events.length - 1];
    expect(last.type).toBe("lane-delete");
    expect(last.progress.overallStatus).toBe("completed");
    // git_worktree_remove step reached.
    const wtStep = last.progress.steps.find((s: any) => s.name === "git_worktree_remove");
    expect(wtStep?.status).toBe("completed");
  });

  it("removes residual worktree files before deleting the lane row", async () => {
    const events: any[] = [];
    const fake = makeFakeServices();
    const { service, db, repoRoot } = await setupWithLane({ teardown: fake, events });
    const childPath = path.join(repoRoot, "child");
    fs.writeFileSync(path.join(childPath, "residual.log"), "left behind by git\n", "utf8");

    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" } as any;
      if (args[0] === "show-ref") return { exitCode: 1, stdout: "", stderr: "" } as any;
      if (args[0] === "worktree" && args[1] === "remove") {
        fake.calls.push("git_worktree_remove");
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      return { exitCode: 0, stdout: "", stderr: "" } as any;
    });
    vi.mocked(runGitOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as any);

    await service.delete({ laneId: "lane-child", deleteBranch: false });

    expect(fs.existsSync(childPath)).toBe(false);
    expect(db.get<{ id: string }>("select id from lanes where id = ?", ["lane-child"])).toBeNull();
    expect(vi.mocked(runGitOrThrow).mock.calls.some(([args]) => args[0] === "worktree" && args[1] === "prune")).toBe(true);
    const last = events[events.length - 1];
    expect(last.progress.steps.find((s: any) => s.name === "git_worktree_remove")?.detail).toContain("removed residual files");
  });

  it("recovers stale worktree directories with VM guest-created unreadable folders", async () => {
    const events: any[] = [];
    const fake = makeFakeServices();
    const { service, repoRoot } = await setupWithLane({ teardown: fake, events });
    const childPath = path.join(repoRoot, "child");
    const guestTrashPath = path.join(childPath, ".Trashes");
    fs.mkdirSync(guestTrashPath, { recursive: true });
    fs.chmodSync(guestTrashPath, 0o311);

    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" } as any;
      if (args[0] === "worktree" && args[1] === "remove") {
        return {
          exitCode: 128,
          stdout: "",
          stderr: `fatal: '${childPath}' is not a working tree`,
        } as any;
      }
      return { exitCode: 0, stdout: "", stderr: "" } as any;
    });
    vi.mocked(runGitOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as any);

    try {
      await service.delete({ laneId: "lane-child", deleteBranch: false });
    } finally {
      if (fs.existsSync(guestTrashPath)) fs.chmodSync(guestTrashPath, 0o700);
    }

    expect(fs.existsSync(childPath)).toBe(false);
    const last = events[events.length - 1];
    expect(last.progress.overallStatus).toBe("completed");
    expect(last.progress.steps.find((s: any) => s.name === "git_worktree_remove")?.detail).toContain("recovered from stale state");
  });

  it("keeps recent delete progress queryable for remounted renderers", async () => {
    const events: any[] = [];
    const fake = makeFakeServices();
    const { service } = await setupWithLane({ teardown: fake, events });
    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" } as any;
      if (args[0] === "show-ref") return { exitCode: 1, stdout: "", stderr: "" } as any;
      if (args[0] === "worktree" && args[1] === "remove") {
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      return { exitCode: 0, stdout: "", stderr: "" } as any;
    });
    vi.mocked(runGitOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as any);

    const deletePromise = service.delete({ laneId: "lane-child", deleteBranch: false });
    const runningProgress = service.listDeleteProgress();

    expect(runningProgress).toHaveLength(1);
    expect(runningProgress[0]?.laneId).toBe("lane-child");
    expect(runningProgress[0]?.overallStatus).toBe("running");

    runningProgress[0]!.steps[0]!.status = "failed";
    expect(service.listDeleteProgress()[0]?.steps[0]?.status).not.toBe("failed");

    await deletePromise;

    const completedProgress = service.listDeleteProgress();
    expect(completedProgress).toHaveLength(1);
    expect(completedProgress[0]?.laneId).toBe("lane-child");
    expect(completedProgress[0]?.overallStatus).toBe("completed");
  });

  it("reports whether a lane delete is currently running", async () => {
    const events: any[] = [];
    const fake = makeFakeServices();
    let releaseStop: (() => void) | null = null;
    let stopStarted: (() => void) | null = null;
    const stopStartedPromise = new Promise<void>((resolve) => {
      stopStarted = resolve;
    });
    fake.processService.stopAll.mockImplementation(async () => {
      fake.calls.push("stop_processes");
      stopStarted?.();
      await new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
    });
    const { service } = await setupWithLane({ teardown: fake, events });
    vi.mocked(runGit).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as any);
    vi.mocked(runGitOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as any);

    const deletePromise = service.delete({ laneId: "lane-child", deleteBranch: false, force: true });
    await stopStartedPromise;
    expect(service.hasRunningDelete()).toBe(true);

    expect(releaseStop).not.toBeNull();
    releaseStop!();
    await deletePromise;

    expect(service.hasRunningDelete()).toBe(false);
  });

  it("runs independent lane delete teardown concurrently", async () => {
    const events: any[] = [];
    const fake = makeFakeServices();
    const { service, db, repoRoot } = await setupWithLane({ teardown: fake, events });
    const now = "2026-03-11T12:00:00.000Z";
    const siblingPath = path.join(repoRoot, "sibling");
    fs.mkdirSync(siblingPath, { recursive: true });
    db.run(
      `
        insert into lanes(
          id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
          attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ["lane-sibling", "proj-delete", "Sibling", null, "worktree", "feature/parent", "feature/sibling", siblingPath, null, 0, "lane-parent", null, null, null, "active", now, null],
    );

    const order: string[] = [];
    const startedStops = new Set<string>();
    let releaseStops: (() => void) | null = null;
    const stopGate = new Promise<void>((resolve) => {
      releaseStops = resolve;
    });
    fake.processService.stopAll.mockImplementation(async ({ laneId }: { laneId: string }) => {
      startedStops.add(laneId);
      order.push(`stop:${laneId}`);
      await stopGate;
    });
    vi.mocked(runGit).mockImplementation(async (args: string[], opts?: { cwd?: string }) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" } as any;
      if (args[0] === "show-ref") return { exitCode: 1, stdout: "", stderr: "" } as any;
      if (args[0] === "worktree" && args[1] === "remove") {
        order.push(`worktree:${opts?.cwd ?? ""}:${args[2] ?? args[3] ?? ""}`);
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      return { exitCode: 0, stdout: "", stderr: "" } as any;
    });
    vi.mocked(runGitOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as any);

    const deletePromises = [
      service.delete({ laneId: "lane-child", deleteBranch: false, force: true }),
      service.delete({ laneId: "lane-sibling", deleteBranch: false, force: true }),
    ];
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect([...startedStops].sort()).toEqual(["lane-child", "lane-sibling"]);
    expect(order.some((entry) => entry.startsWith("worktree:"))).toBe(false);

    expect(releaseStops).not.toBeNull();
    releaseStops!();
    await Promise.all(deletePromises);

    expect(db.get<{ id: string }>("select id from lanes where id = ?", ["lane-child"])).toBeNull();
    expect(db.get<{ id: string }>("select id from lanes where id = ?", ["lane-sibling"])).toBeNull();
  });

  it("allows lane creation while an in-flight delete is still in teardown", async () => {
    const events: any[] = [];
    const fake = makeFakeServices();
    const order: string[] = [];
    let releaseStop: (() => void) | null = null;
    let stopStarted: (() => void) | null = null;
    const stopStartedPromise = new Promise<void>((resolve) => {
      stopStarted = resolve;
    });
    fake.processService.stopAll.mockImplementation(async () => {
      fake.calls.push("stop_processes");
      order.push("delete:stop_processes");
      stopStarted?.();
      await new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
    });
    const { service } = await setupWithLane({ teardown: fake, events });
    vi.mocked(getHeadSha).mockResolvedValue("parent-head");
    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" } as any;
      if (args[0] === "worktree" && args[1] === "remove") {
        order.push("delete:worktree_remove");
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      if (args[0] === "push") return { exitCode: 0, stdout: "", stderr: "" } as any;
      if (args[0] === "rev-list") return { exitCode: 0, stdout: "0\n", stderr: "" } as any;
      if (args[0] === "rev-parse") return { exitCode: 0, stdout: "parent-head\n", stderr: "" } as any;
      return { exitCode: 0, stdout: "", stderr: "" } as any;
    });
    vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "add") {
        order.push("create:worktree_add");
      }
      return { exitCode: 0, stdout: "", stderr: "" } as any;
    });

    const deletePromise = service.delete({ laneId: "lane-child", deleteBranch: false, force: true });
    await stopStartedPromise;

    const createPromise = service.create({ name: "New lane", parentLaneId: "lane-parent" });
    for (let i = 0; i < 10 && !order.includes("create:worktree_add"); i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(order).toContain("create:worktree_add");
    expect(order).not.toContain("delete:worktree_remove");

    expect(releaseStop).not.toBeNull();
    releaseStop!();
    await Promise.all([deletePromise, createPromise]);

    expect(order.indexOf("delete:worktree_remove")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("create:worktree_add")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("create:worktree_add")).toBeLessThan(order.indexOf("delete:worktree_remove"));
  });

  it("deletes the lane locally when optional remote branch cleanup fails", async () => {
    const events: any[] = [];
    const fake = makeFakeServices();
    const { service, db } = await setupWithLane({ teardown: fake, events, createWorktree: false });
    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "show-ref") return { exitCode: 0, stdout: "", stderr: "" } as any;
      if (args[0] === "remote" && args[1] === "get-url") return { exitCode: 0, stdout: "git@example.test/repo.git\n", stderr: "" } as any;
      if (args[0] === "ls-remote") return { exitCode: 0, stdout: "abc\trefs/heads/feature/child\n", stderr: "" } as any;
      return { exitCode: 0, stdout: "", stderr: "" } as any;
    });
    vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
      if (args[0] === "push") throw new Error("remote rejected delete");
      return { exitCode: 0, stdout: "", stderr: "" } as any;
    });

    await service.delete({
      laneId: "lane-child",
      deleteBranch: true,
      deleteRemoteBranch: true,
      remoteName: "origin",
    });

    const last = events[events.length - 1];
    expect(last.progress.overallStatus).toBe("completed_with_warnings");
    expect(last.progress.steps.find((s: any) => s.name === "git_branch_delete")?.status).toBe("completed");
    const remoteStep = last.progress.steps.find((s: any) => s.name === "git_remote_branch_delete");
    expect(remoteStep?.status).toBe("warning");
    expect(remoteStep?.errorMessage).toContain("remote rejected delete");
    expect(db.get<{ id: string }>("select id from lanes where id = ?", ["lane-child"])).toBeNull();
  });

  it("cleans lane-owned database state when deleting a lane", async () => {
    const events: any[] = [];
    const fake = makeFakeServices();
    const { service, db, repoRoot } = await setupWithLane({ teardown: fake, events, createWorktree: false });
    const projectId = "proj-delete";
    const now = "2026-03-11T12:30:00.000Z";

    db.run(
      `
        insert into lane_branch_profiles(
          id, project_id, lane_id, branch_ref, normalized_branch_ref, base_ref,
          parent_lane_id, source_branch_ref, created_at, updated_at, last_checked_out_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ["profile-child", projectId, "lane-child", "feature/child", "feature/child", "feature/parent", null, null, now, now, null],
    );
    db.run(
      `
        insert into lane_branch_profiles(
          id, project_id, lane_id, branch_ref, normalized_branch_ref, base_ref,
          parent_lane_id, source_branch_ref, created_at, updated_at, last_checked_out_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ["profile-parent-ref", projectId, "lane-parent", "feature/parent-next", "feature/parent-next", "feature/child", "lane-child", null, now, now, null],
    );
    db.run("insert into lane_state_snapshots(lane_id, updated_at) values (?, ?)", ["lane-child", now]);
    db.run(
      "insert into conflict_predictions(id, project_id, lane_a_id, lane_b_id, status, predicted_at) values (?, ?, ?, ?, ?, ?)",
      ["prediction-child", projectId, "lane-child", "lane-parent", "open", now],
    );
    db.run(
      "insert into conflict_proposals(id, project_id, lane_id, peer_lane_id, prediction_id, source, diff_patch, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["proposal-child", projectId, "lane-child", "lane-parent", "prediction-child", "ai", "diff --git a/file b/file", "open", now, now],
    );
    db.run(
      "insert into files_workspaces(id, kind, lane_id, name, root_path, updated_at) values (?, ?, ?, ?, ?, ?)",
      ["workspace-child", "lane", "lane-child", "Child", path.join(repoRoot, "child"), now],
    );
    db.run(
      "insert into file_directory_snapshots(workspace_id, parent_path, include_hidden, nodes_json, updated_at) values (?, ?, ?, ?, ?)",
      ["workspace-child", "", 0, "[]", now],
    );
    db.run(
      "insert into terminal_sessions(id, lane_id, title, started_at, transcript_path, status) values (?, ?, ?, ?, ?, ?)",
      ["session-child", "lane-child", "Child session", now, path.join(repoRoot, "session.log"), "ended"],
    );
    db.run(
      `
        insert into session_deltas(
          session_id, project_id, lane_id, started_at, files_changed, insertions, deletions,
          touched_files_json, failure_lines_json, computed_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ["session-child", projectId, "lane-child", now, 1, 2, 3, "[]", "[]", now],
    );
    db.run(
      "insert into checkpoints(id, project_id, lane_id, session_id, sha, created_at) values (?, ?, ?, ?, ?, ?)",
      ["checkpoint-child", projectId, "lane-child", "session-child", "abc123", now],
    );
    db.run(
      "insert into operations(id, project_id, lane_id, kind, started_at, status) values (?, ?, ?, ?, ?, ?)",
      ["operation-child", projectId, "lane-child", "checkout", now, "completed"],
    );
    db.run(
      "insert into packs_index(pack_key, project_id, lane_id, pack_type, pack_path, deterministic_updated_at) values (?, ?, ?, ?, ?, ?)",
      ["pack-child", projectId, "lane-child", "lane", path.join(repoRoot, "pack.json"), now],
    );
    db.run(
      "insert into process_runtime(project_id, lane_id, process_key, status, readiness, updated_at) values (?, ?, ?, ?, ?, ?)",
      [projectId, "lane-child", "vite", "running", "unknown", now],
    );
    db.run(
      "insert into process_runs(id, project_id, lane_id, process_key, started_at, termination_reason, log_path) values (?, ?, ?, ?, ?, ?, ?)",
      ["process-run-child", projectId, "lane-child", "vite", now, "completed", path.join(repoRoot, "process.log")],
    );
    db.run(
      "insert into test_runs(id, project_id, lane_id, suite_key, started_at, status, log_path) values (?, ?, ?, ?, ?, ?, ?)",
      ["test-run-child", projectId, "lane-child", "unit", now, "passed", path.join(repoRoot, "test.log")],
    );
    db.run("insert into rebase_deferred(lane_id, project_id, deferred_until) values (?, ?, ?)", ["lane-child", projectId, now]);
    db.run("insert into rebase_dismissed(lane_id, project_id, dismissed_at) values (?, ?, ?)", ["lane-child", projectId, now]);
    db.run(
      `
        insert into lane_worktree_locks(
          worktree_key, worktree_path, lane_id, owner_kind, owner_label, token,
          created_at, heartbeat_at, expires_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ["child-key", path.join(repoRoot, "child"), "lane-child", "pr", "PR #1", "token", now, now, now],
    );

    db.run(
      `
        insert into pull_requests(
          id, project_id, lane_id, repo_owner, repo_name, github_pr_number, github_url,
          state, base_branch, head_branch, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ["pr-child", projectId, "lane-child", "acme", "demo", 1, "https://example.com/pr/1", "open", "main", "feature/child", now, now],
    );
    db.run(
      `
        insert into pull_requests(
          id, project_id, lane_id, repo_owner, repo_name, github_pr_number, github_url,
          state, base_branch, head_branch, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ["pr-parent", projectId, "lane-parent", "acme", "demo", 2, "https://example.com/pr/2", "open", "main", "feature/parent", now, now],
    );
    db.run("insert into pr_groups(id, project_id, group_type, name, created_at) values (?, ?, ?, ?, ?)", ["group-child", projectId, "queue", "Queue", now]);
    db.run("insert into pr_group_members(id, group_id, pr_id, lane_id, position, role) values (?, ?, ?, ?, ?, ?)", ["member-child", "group-child", "pr-child", "lane-child", 0, "member"]);
    db.run("insert into pull_request_ai_summaries(pr_id, head_sha, summary_json, generated_at) values (?, ?, ?, ?)", ["pr-child", "abc123", "{}", now]);
    db.run("insert into pull_request_snapshots(pr_id, updated_at) values (?, ?)", ["pr-child", now]);
    db.run("insert into pr_pipeline_settings(pr_id, updated_at) values (?, ?)", ["pr-child", now]);
    db.run(
      "insert into pr_issue_inventory(id, pr_id, source, type, external_id, headline, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      ["issue-child", "pr-child", "review", "comment", "1", "Fix it", now, now],
    );
    db.run(
      `
        insert into pr_auto_link_ignores(
          project_id, repo_owner, repo_name, github_pr_number, lane_id, head_branch, created_at
        ) values (?, ?, ?, ?, ?, ?, ?)
      `,
      [projectId, "acme", "demo", 1, "lane-child", "feature/child", now],
    );
    db.run("insert into pr_convergence_state(pr_id, active_lane_id, created_at, updated_at) values (?, ?, ?, ?)", ["pr-child", "lane-child", now, now]);
    db.run("insert into pr_convergence_state(pr_id, active_lane_id, created_at, updated_at) values (?, ?, ?, ?)", ["pr-parent", "lane-child", now, now]);
    db.run(
      `
        insert into review_runs(
          id, project_id, lane_id, target_json, config_json, target_label,
          status, created_at, started_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ["review-run-child", projectId, "lane-child", "{}", "{}", "Lane review", "completed", now, now, now],
    );
    db.run(
      `
        insert into review_reviewer_runs(
          id, run_id, reviewer_key, label, focus, status, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ["reviewer-run-child", "review-run-child", "diff-risk", "Diff risk", "Diff risk", "completed", now, now],
    );
    db.run(
      `
        insert into review_candidate_findings(
          id, run_id, reviewer_run_id, reviewer_key, title, severity, body, anchor_state, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ["candidate-child", "review-run-child", "reviewer-run-child", "diff-risk", "Candidate", "medium", "Body", "anchored", now],
    );

    await service.delete({ laneId: "lane-child", deleteBranch: false });

    const count = (table: string, where: string, params: any[] = []) =>
      Number(db.get<{ count: number }>(`select count(1) as count from ${table} where ${where}`, params)?.count ?? 0);

    expect(count("lanes", "id = ?", ["lane-child"])).toBe(0);
    expect(count("lane_branch_profiles", "lane_id = ?", ["lane-child"])).toBe(0);
    expect(db.get<{ parent_lane_id: string | null }>("select parent_lane_id from lane_branch_profiles where id = ?", ["profile-parent-ref"])?.parent_lane_id).toBeNull();
    expect(count("lane_state_snapshots", "lane_id = ?", ["lane-child"])).toBe(0);
    expect(count("conflict_predictions", "lane_a_id = ? or lane_b_id = ?", ["lane-child", "lane-child"])).toBe(0);
    expect(count("conflict_proposals", "lane_id = ? or peer_lane_id = ?", ["lane-child", "lane-child"])).toBe(0);
    expect(count("files_workspaces", "lane_id = ?", ["lane-child"])).toBe(0);
    expect(count("file_directory_snapshots", "workspace_id = ?", ["workspace-child"])).toBe(0);
    expect(count("pull_requests", "id = ?", ["pr-child"])).toBe(0);
    expect(count("pr_group_members", "lane_id = ?", ["lane-child"])).toBe(0);
    expect(count("pull_request_ai_summaries", "pr_id = ?", ["pr-child"])).toBe(0);
    expect(count("pull_request_snapshots", "pr_id = ?", ["pr-child"])).toBe(0);
    expect(count("pr_pipeline_settings", "pr_id = ?", ["pr-child"])).toBe(0);
    expect(count("pr_issue_inventory", "pr_id = ?", ["pr-child"])).toBe(0);
    expect(count("pr_auto_link_ignores", "lane_id = ?", ["lane-child"])).toBe(0);
    expect(db.get<{ active_lane_id: string | null }>("select active_lane_id from pr_convergence_state where pr_id = ?", ["pr-parent"])?.active_lane_id).toBeNull();
    expect(count("review_runs", "id = ?", ["review-run-child"])).toBe(0);
    expect(count("review_reviewer_runs", "id = ?", ["reviewer-run-child"])).toBe(0);
    expect(count("review_candidate_findings", "id = ?", ["candidate-child"])).toBe(0);
    expect(count("terminal_sessions", "lane_id = ?", ["lane-child"])).toBe(0);
    expect(count("session_deltas", "lane_id = ?", ["lane-child"])).toBe(0);
    expect(count("checkpoints", "lane_id = ?", ["lane-child"])).toBe(0);
    expect(count("operations", "lane_id = ?", ["lane-child"])).toBe(0);
    expect(count("packs_index", "lane_id = ?", ["lane-child"])).toBe(0);
    expect(count("process_runtime", "lane_id = ?", ["lane-child"])).toBe(0);
    expect(count("process_runs", "lane_id = ?", ["lane-child"])).toBe(0);
    expect(count("test_runs", "lane_id = ?", ["lane-child"])).toBe(0);
    expect(count("rebase_deferred", "lane_id = ?", ["lane-child"])).toBe(0);
    expect(count("rebase_dismissed", "lane_id = ?", ["lane-child"])).toBe(0);
    expect(count("lane_worktree_locks", "lane_id = ?", ["lane-child"])).toBe(0);
  });

  it("does not cancel a lane delete after it starts", async () => {
    const events: any[] = [];
    const fake = makeFakeServices();
    fake.processService.stopAll.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const { service } = await setupWithLane({ teardown: fake, events });
    vi.mocked(runGit).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as any);
    vi.mocked(runGitOrThrow).mockImplementation(async () => {
      fake.calls.push("git_worktree_remove");
      return { exitCode: 0, stdout: "", stderr: "" } as any;
    });

    const deletePromise = service.delete({ laneId: "lane-child", deleteBranch: false });
    await new Promise((r) => setTimeout(r, 5));
    const cancelResult = service.cancelDelete("lane-child");
    expect(cancelResult.cancelled).toBe(false);
    await deletePromise;

    const last = events[events.length - 1];
    expect(last.progress.overallStatus).toBe("completed");
    expect(last.progress.cancellable).toBe(false);
    expect(last.progress.steps.find((step: any) => step.name === "git_worktree_remove")?.status).toBe("completed");
  });

  it("getDeleteRisk reports running processes, ptys, watchers, and unpushed commits", async () => {
    const events: any[] = [];
    const fake = makeFakeServices();
    const { service } = await setupWithLane({ teardown: fake, events });
    // 3 unpushed commits + remote branch exists.
    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" } as any;
      if (args[0] === "rev-list") return { exitCode: 0, stdout: "3", stderr: "" } as any;
      if (args[0] === "ls-remote") return { exitCode: 0, stdout: "abc123\trefs/heads/feature/child", stderr: "" } as any;
      return { exitCode: 0, stdout: "", stderr: "" } as any;
    });

    const risk = await service.getDeleteRisk("lane-child");
    expect(risk.runningProcessCount).toBe(1);
    expect(risk.activePtyCount).toBe(2);
    expect(risk.activeWatcherCount).toBe(1);
    expect(risk.hasUnpushedCommits).toBe(true);
    expect(risk.unpushedCommitCount).toBe(3);
    expect(risk.remoteBranchExists).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// laneService - branchSwitch (merged from laneService.branchSwitch.test.ts)
// ---------------------------------------------------------------------------

describe("laneService - branchSwitch", () => {
  const BSW_NOW = "2026-04-25T10:00:00.000Z";

  function seedBswProject(db: any, args: { projectId: string; repoRoot: string }) {
    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      [args.projectId, args.repoRoot, "demo", "main", BSW_NOW, BSW_NOW],
    );
  }

  function insertBswLane(db: any, args: {
    id: string;
    projectId: string;
    name: string;
    laneType: "primary" | "worktree";
    branchRef: string;
    baseRef?: string;
    worktreePath: string;
    parentLaneId?: string | null;
    status?: string;
  }) {
    db.run(
      `insert into lanes(
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        args.id,
        args.projectId,
        args.name,
        null,
        args.laneType,
        args.baseRef ?? "main",
        args.branchRef,
        args.worktreePath,
        null,
        args.laneType === "primary" ? 1 : 0,
        args.parentLaneId ?? null,
        null,
        null,
        null,
        args.status ?? "active",
        BSW_NOW,
        args.status === "archived" ? BSW_NOW : null,
      ],
    );
  }

  function makeRunGitResponder(custom?: (args: string[], opts: any) => { exitCode: number; stdout: string; stderr: string } | null) {
    return async (args: string[], opts: any = {}) => {
      if (custom) {
        const v = custom(args, opts);
        if (v) return v;
      }
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") {
        return { exitCode: 0, stdout: "main\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--path-format=absolute" && args[2] === "--git-dir") {
        return { exitCode: 1, stdout: "", stderr: "fatal: no git dir" };
      }
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "--symbolic-full-name" && args[3] === "@{upstream}") {
        return { exitCode: 1, stdout: "", stderr: "no upstream" };
      }
      if (args[0] === "rev-parse" && args[1] === "@{upstream}") {
        return { exitCode: 1, stdout: "", stderr: "no upstream" };
      }
      if (args[0] === "rev-list" && args[1] === "--left-right" && args[2] === "--count") {
        return { exitCode: 0, stdout: "0\t0\n", stderr: "" };
      }
      if (args[0] === "status" && args[1] === "--porcelain=v1") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: `unhandled: ${args.join(" ")}` };
    };
  }

  function makeBswService(db: any, projectRoot: string, projectId: string) {
    return createLaneService({
      db,
      projectRoot,
      projectId,
      defaultBaseRef: "main",
      worktreesDir: path.join(projectRoot, "worktrees"),
      logger: createLogger(),
    });
  }

  describe("listBranchProfiles", () => {
    beforeEach(() => {
      vi.mocked(getHeadSha).mockReset();
      vi.mocked(runGit).mockReset();
      vi.mocked(runGitOrThrow).mockReset();
    });

    it("ensures and returns a profile for the lane's current branch_ref", async () => {
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-bsw-list-profile-"));
      const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
      try {
        seedBswProject(db, { projectId: "proj-1", repoRoot });
        insertBswLane(db, { id: "lane-a", projectId: "proj-1", name: "Lane A", laneType: "worktree", branchRef: "feature/lane-a", worktreePath: path.join(repoRoot, "lane-a") });

        vi.mocked(runGit).mockImplementation(makeRunGitResponder() as any);

        const service = makeBswService(db, repoRoot, "proj-1");
        const profiles = service.listBranchProfiles("lane-a");

        expect(profiles).toHaveLength(1);
        expect(profiles[0]?.branchRef).toBe("feature/lane-a");
        expect(profiles[0]?.laneId).toBe("lane-a");
        expect(profiles[0]?.baseRef).toBe("main");

        const second = service.listBranchProfiles("lane-a");
        expect(second).toHaveLength(1);
        expect(second[0]?.id).toBe(profiles[0]?.id);
      } finally {
        db.close();
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it("throws when the lane is missing", async () => {
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-bsw-list-missing-"));
      const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
      try {
        seedBswProject(db, { projectId: "proj-1", repoRoot });
        const service = makeBswService(db, repoRoot, "proj-1");
        expect(() => service.listBranchProfiles("nonexistent")).toThrow(/Lane not found/);
      } finally {
        db.close();
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });
  });

  describe("updateBranchRef", () => {
    beforeEach(() => {
      vi.mocked(getHeadSha).mockReset();
      vi.mocked(runGit).mockReset();
      vi.mocked(runGitOrThrow).mockReset();
    });

    it("updates the lane's branch_ref AND upserts a matching branch profile", async () => {
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-bsw-update-bref-"));
      const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
      try {
        seedBswProject(db, { projectId: "proj-1", repoRoot });
        insertBswLane(db, { id: "lane-a", projectId: "proj-1", name: "Lane A", laneType: "worktree", branchRef: "feature/lane-a", worktreePath: path.join(repoRoot, "lane-a") });

        vi.mocked(runGit).mockImplementation(makeRunGitResponder() as any);

        const service = makeBswService(db, repoRoot, "proj-1");

        service.updateBranchRef("lane-a", "feature/renamed");

        const updated = db.get<{ branch_ref: string }>(
          "select branch_ref from lanes where id = ? and project_id = ?",
          ["lane-a", "proj-1"],
        );
        expect(updated?.branch_ref).toBe("feature/renamed");

        const profiles = service.listBranchProfiles("lane-a");
        const refs = profiles.map((p) => p.branchRef);
        expect(refs).toContain("feature/renamed");
        const renamed = profiles.find((p) => p.branchRef === "feature/renamed");
        expect(renamed?.lastCheckedOutAt).toBeTruthy();
      } finally {
        db.close();
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });
  });

  describe("previewBranchSwitch", () => {
    beforeEach(() => {
      vi.mocked(getHeadSha).mockReset();
      vi.mocked(runGit).mockReset();
      vi.mocked(runGitOrThrow).mockReset();
    });

    it("rejects when laneId is empty", async () => {
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-bsw-prev-laneid-"));
      const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
      try {
        seedBswProject(db, { projectId: "proj-1", repoRoot });
        const service = makeBswService(db, repoRoot, "proj-1");
        await expect(service.previewBranchSwitch({ laneId: "", branchName: "x" })).rejects.toThrow(/laneId is required/);
      } finally {
        db.close();
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it("rejects when branchName is empty", async () => {
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-bsw-prev-branchname-"));
      const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
      try {
        seedBswProject(db, { projectId: "proj-1", repoRoot });
        insertBswLane(db, { id: "lane-a", projectId: "proj-1", name: "Lane A", laneType: "worktree", branchRef: "feature/lane-a", worktreePath: path.join(repoRoot, "lane-a") });
        const service = makeBswService(db, repoRoot, "proj-1");
        await expect(service.previewBranchSwitch({ laneId: "lane-a", branchName: "  " })).rejects.toThrow(/Branch name is required/);
      } finally {
        db.close();
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it("rejects when the lane is archived", async () => {
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-bsw-prev-archived-"));
      const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
      try {
        seedBswProject(db, { projectId: "proj-1", repoRoot });
        insertBswLane(db, {
          id: "lane-archived", projectId: "proj-1", name: "Archived", laneType: "worktree",
          branchRef: "feature/old", worktreePath: path.join(repoRoot, "old"), status: "archived",
        });
        const service = makeBswService(db, repoRoot, "proj-1");
        await expect(service.previewBranchSwitch({ laneId: "lane-archived", branchName: "main" })).rejects.toThrow(/archived/);
      } finally {
        db.close();
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it("flags dirty worktree, duplicate owner, and active terminal sessions", async () => {
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-bsw-prev-flags-"));
      const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
      try {
        seedBswProject(db, { projectId: "proj-1", repoRoot });
        insertBswLane(db, { id: "lane-src", projectId: "proj-1", name: "Source", laneType: "worktree", branchRef: "feature/src", worktreePath: path.join(repoRoot, "src") });
        insertBswLane(db, { id: "lane-other", projectId: "proj-1", name: "Other Lane", laneType: "worktree", branchRef: "feature/target", worktreePath: path.join(repoRoot, "other") });

        db.run(
          `insert into terminal_sessions(id, lane_id, tracked, title, started_at, status, transcript_path)
           values (?, ?, ?, ?, ?, ?, ?)`,
          ["term-1", "lane-src", 1, "shell", BSW_NOW, "running", path.join(repoRoot, "t.log")],
        );
        db.run(
          `insert into process_runtime(project_id, lane_id, process_key, status, readiness, updated_at)
           values (?, ?, ?, ?, ?, ?)`,
          ["proj-1", "lane-src", "vite", "running", "ready", BSW_NOW],
        );

        vi.mocked(runGit).mockImplementation(makeRunGitResponder((args, opts) => {
          if (args[0] === "show-ref" && args[1] === "--verify" && args[2] === "--quiet") {
            if (args[3] === "refs/heads/feature/target") return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "status" && args[1] === "--porcelain=v1" && opts.cwd === path.join(repoRoot, "src")) {
            return { exitCode: 0, stdout: " M file.ts\n", stderr: "" };
          }
          return null;
        }) as any);

        const service = makeBswService(db, repoRoot, "proj-1");
        const preview = await service.previewBranchSwitch({ laneId: "lane-src", branchName: "feature/target" });

        expect(preview.laneId).toBe("lane-src");
        expect(preview.dirty).toBe(true);
        expect(preview.duplicateLaneId).toBe("lane-other");
        expect(preview.duplicateLaneName).toBe("Other Lane");
        expect(preview.activeWork.length).toBeGreaterThanOrEqual(2);
        expect(preview.activeWork.some((w) => w.kind === "terminal")).toBe(true);
        expect(preview.activeWork.some((w) => w.kind === "process")).toBe(true);
        expect(preview.targetBranchRef).toBe("feature/target");
        expect(preview.mode).toBe("existing");
      } finally {
        db.close();
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it("strips remote prefix when only the remote ref exists", async () => {
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-bsw-prev-remote-"));
      const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
      try {
        seedBswProject(db, { projectId: "proj-1", repoRoot });
        insertBswLane(db, { id: "lane-x", projectId: "proj-1", name: "X", laneType: "worktree", branchRef: "feature/x", worktreePath: path.join(repoRoot, "x") });

        vi.mocked(runGit).mockImplementation(makeRunGitResponder((args) => {
          if (args[0] === "show-ref" && args[1] === "--verify" && args[2] === "--quiet") {
            if (args[3] === "refs/heads/origin/foo") return { exitCode: 1, stdout: "", stderr: "" };
            if (args[3] === "refs/remotes/origin/foo") return { exitCode: 0, stdout: "", stderr: "" };
          }
          return null;
        }) as any);

        const service = makeBswService(db, repoRoot, "proj-1");
        const preview = await service.previewBranchSwitch({ laneId: "lane-x", branchName: "origin/foo" });
        expect(preview.targetBranchRef).toBe("foo");
        expect(preview.dirty).toBe(false);
        expect(preview.duplicateLaneId).toBeNull();
      } finally {
        db.close();
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it("returns mode=create without consulting refs when explicitly requested", async () => {
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-bsw-prev-create-"));
      const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
      try {
        seedBswProject(db, { projectId: "proj-1", repoRoot });
        insertBswLane(db, { id: "lane-y", projectId: "proj-1", name: "Y", laneType: "worktree", branchRef: "feature/y", worktreePath: path.join(repoRoot, "y") });

        const showRefCalls: string[] = [];
        vi.mocked(runGit).mockImplementation(makeRunGitResponder((args) => {
          if (args[0] === "show-ref") showRefCalls.push(args.join(" "));
          return null;
        }) as any);

        const service = makeBswService(db, repoRoot, "proj-1");
        const preview = await service.previewBranchSwitch({ laneId: "lane-y", branchName: "feature/new", mode: "create" });

        expect(preview.mode).toBe("create");
        expect(preview.targetBranchRef).toBe("feature/new");
        expect(showRefCalls).toHaveLength(0);
      } finally {
        db.close();
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });
  });

  describe("switchBranch", () => {
    beforeEach(() => {
      vi.mocked(getHeadSha).mockReset();
      vi.mocked(runGit).mockReset();
      vi.mocked(runGitOrThrow).mockReset();
    });

    it("refuses to switch when the lane has uncommitted changes", async () => {
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-bsw-switch-dirty-"));
      const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
      try {
        seedBswProject(db, { projectId: "proj-1", repoRoot });
        insertBswLane(db, { id: "lane-d", projectId: "proj-1", name: "D", laneType: "worktree", branchRef: "feature/d", worktreePath: path.join(repoRoot, "d") });

        vi.mocked(runGit).mockImplementation(makeRunGitResponder((args, opts) => {
          if (args[0] === "show-ref" && args[3] === "refs/heads/main") return { exitCode: 0, stdout: "", stderr: "" };
          if (args[0] === "status" && args[1] === "--porcelain=v1" && opts.cwd === path.join(repoRoot, "d")) {
            return { exitCode: 0, stdout: " M src/foo.ts\n", stderr: "" };
          }
          return null;
        }) as any);

        const service = makeBswService(db, repoRoot, "proj-1");
        await expect(service.switchBranch({ laneId: "lane-d", branchName: "main" }))
          .rejects.toThrow(/uncommitted changes/);
      } finally {
        db.close();
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it("refuses to switch to a branch that is already active in another lane", async () => {
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-bsw-switch-dup-"));
      const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
      try {
        seedBswProject(db, { projectId: "proj-1", repoRoot });
        insertBswLane(db, { id: "lane-src", projectId: "proj-1", name: "Source", laneType: "worktree", branchRef: "feature/src", worktreePath: path.join(repoRoot, "src") });
        insertBswLane(db, { id: "lane-other", projectId: "proj-1", name: "Other Lane", laneType: "worktree", branchRef: "feature/duplicate", worktreePath: path.join(repoRoot, "other") });

        vi.mocked(runGit).mockImplementation(makeRunGitResponder((args) => {
          if (args[0] === "show-ref" && args[3] === "refs/heads/feature/duplicate") return { exitCode: 0, stdout: "", stderr: "" };
          return null;
        }) as any);

        const service = makeBswService(db, repoRoot, "proj-1");
        await expect(service.switchBranch({ laneId: "lane-src", branchName: "feature/duplicate" }))
          .rejects.toThrow(/already active in lane 'Other Lane'/);
      } finally {
        db.close();
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it("refuses to switch when active work exists and acknowledgeActiveWork is not set", async () => {
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-bsw-switch-active-"));
      const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
      try {
        seedBswProject(db, { projectId: "proj-1", repoRoot });
        insertBswLane(db, { id: "lane-a", projectId: "proj-1", name: "A", laneType: "worktree", branchRef: "feature/a", worktreePath: path.join(repoRoot, "a") });

        db.run(
          `insert into terminal_sessions(id, lane_id, tracked, title, started_at, status, transcript_path)
           values (?, ?, ?, ?, ?, ?, ?)`,
          ["t-1", "lane-a", 1, "shell", BSW_NOW, "running", path.join(repoRoot, "t.log")],
        );

        vi.mocked(runGit).mockImplementation(makeRunGitResponder((args) => {
          if (args[0] === "show-ref" && args[3] === "refs/heads/main") return { exitCode: 0, stdout: "", stderr: "" };
          return null;
        }) as any);

        const service = makeBswService(db, repoRoot, "proj-1");
        await expect(service.switchBranch({ laneId: "lane-a", branchName: "main" }))
          .rejects.toThrow(/active sessions or processes/);
      } finally {
        db.close();
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it("checks out an existing local branch and updates the lane row + branch profile", async () => {
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-bsw-switch-existing-"));
      const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
      try {
        seedBswProject(db, { projectId: "proj-1", repoRoot });
        insertBswLane(db, { id: "lane-main", projectId: "proj-1", name: "Main", laneType: "primary", branchRef: "main", worktreePath: repoRoot });
        insertBswLane(db, { id: "lane-a", projectId: "proj-1", name: "A", laneType: "worktree", branchRef: "feature/a", worktreePath: path.join(repoRoot, "a") });

        const checkoutCalls: string[][] = [];
        vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
          if (args[0] === "checkout") checkoutCalls.push(args);
          return { exitCode: 0, stdout: "", stderr: "" } as any;
        });
        vi.mocked(runGit).mockImplementation(makeRunGitResponder((args) => {
          if (args[0] === "show-ref" && args[3] === "refs/heads/feature/b") return { exitCode: 0, stdout: "", stderr: "" };
          return null;
        }) as any);

        const service = makeBswService(db, repoRoot, "proj-1");
        const result = await service.switchBranch({ laneId: "lane-a", branchName: "feature/b" });

        expect(result.previousBranchRef).toBe("feature/a");
        expect(result.lane.branchRef).toBe("feature/b");
        expect(result.lane.id).toBe("lane-a");
        expect(checkoutCalls.some((cmd) => cmd.includes("feature/b") && !cmd.includes("--track"))).toBe(true);

        const row = db.get<{ branch_ref: string }>(
          "select branch_ref from lanes where id = ? and project_id = ?",
          ["lane-a", "proj-1"],
        );
        expect(row?.branch_ref).toBe("feature/b");

        const profiles = service.listBranchProfiles("lane-a");
        expect(profiles.map((p) => p.branchRef)).toEqual(expect.arrayContaining(["feature/a", "feature/b"]));
      } finally {
        db.close();
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it("creates a new branch via 'checkout -b' when mode='create'", async () => {
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-bsw-switch-create-"));
      const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
      try {
        seedBswProject(db, { projectId: "proj-1", repoRoot });
        insertBswLane(db, { id: "lane-main", projectId: "proj-1", name: "Main", laneType: "primary", branchRef: "main", worktreePath: repoRoot });
        insertBswLane(db, { id: "lane-c", projectId: "proj-1", name: "C", laneType: "worktree", branchRef: "feature/c", worktreePath: path.join(repoRoot, "c") });

        const checkoutCalls: string[][] = [];
        vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
          if (args[0] === "checkout") checkoutCalls.push(args);
          return { exitCode: 0, stdout: "", stderr: "" } as any;
        });

        vi.mocked(runGit).mockImplementation(makeRunGitResponder((args) => {
          if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "main") {
            return { exitCode: 0, stdout: "sha-main\n", stderr: "" };
          }
          if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "feature/c") {
            return { exitCode: 0, stdout: "sha-c\n", stderr: "" };
          }
          if (args[0] === "show-ref" && args[3] === "refs/heads/feature/new") {
            return { exitCode: 1, stdout: "", stderr: "" };
          }
          return null;
        }) as any);

        const service = makeBswService(db, repoRoot, "proj-1");
        const result = await service.switchBranch({
          laneId: "lane-c",
          branchName: "feature/new",
          mode: "create",
          baseRef: "main",
        });

        expect(result.previousBranchRef).toBe("feature/c");
        expect(result.lane.branchRef).toBe("feature/new");
        expect(checkoutCalls.some((cmd) => cmd[0] === "checkout" && cmd[1] === "-b" && cmd[2] === "feature/new")).toBe(true);

        const profile = service.listBranchProfiles("lane-c").find((p) => p.branchRef === "feature/new");
        expect(profile?.sourceBranchRef).toBe("feature/c");
        expect(profile?.baseRef).toBe("main");
      } finally {
        db.close();
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it("rejects mode='create' when baseRef is missing", async () => {
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-bsw-switch-create-no-base-"));
      const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
      try {
        seedBswProject(db, { projectId: "proj-1", repoRoot });
        insertBswLane(db, { id: "lane-c", projectId: "proj-1", name: "C", laneType: "worktree", branchRef: "feature/c", worktreePath: path.join(repoRoot, "c") });

        vi.mocked(runGit).mockImplementation(makeRunGitResponder() as any);

        const service = makeBswService(db, repoRoot, "proj-1");
        await expect(service.switchBranch({ laneId: "lane-c", branchName: "feature/new", mode: "create" }))
          .rejects.toThrow(/Base branch is required/);
      } finally {
        db.close();
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it("rejects mode='create' when the target branch already exists locally", async () => {
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-bsw-switch-create-exists-"));
      const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
      try {
        seedBswProject(db, { projectId: "proj-1", repoRoot });
        insertBswLane(db, { id: "lane-c", projectId: "proj-1", name: "C", laneType: "worktree", branchRef: "feature/c", worktreePath: path.join(repoRoot, "c") });

        vi.mocked(runGit).mockImplementation(makeRunGitResponder((args) => {
          if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "main") {
            return { exitCode: 0, stdout: "sha\n", stderr: "" };
          }
          if (args[0] === "show-ref" && args[3] === "refs/heads/feature/existing") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return null;
        }) as any);

        const service = makeBswService(db, repoRoot, "proj-1");
        await expect(service.switchBranch({
          laneId: "lane-c",
          branchName: "feature/existing",
          mode: "create",
          baseRef: "main",
        })).rejects.toThrow(/already exists/);
      } finally {
        db.close();
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it("preserves PR rows whose head_branch matches the new branch and deletes stale ones", async () => {
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-bsw-switch-pr-detach-"));
      const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
      try {
        seedBswProject(db, { projectId: "proj-1", repoRoot });
        insertBswLane(db, { id: "lane-main", projectId: "proj-1", name: "Main", laneType: "primary", branchRef: "main", worktreePath: repoRoot });
        insertBswLane(db, { id: "lane-a", projectId: "proj-1", name: "A", laneType: "worktree", branchRef: "feature/a", worktreePath: path.join(repoRoot, "a") });

        db.run(
          `insert into pull_requests(
            id, project_id, lane_id, repo_owner, repo_name, github_pr_number, github_url,
            title, state, base_branch, head_branch, additions, deletions, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            "pr-keep", "proj-1", "lane-a", "acme", "ade", 1, "https://example.com/pr/1",
            "keep", "open", "main", "feature/b", 0, 0, BSW_NOW, BSW_NOW,
          ],
        );
        db.run(
          `insert into pull_requests(
            id, project_id, lane_id, repo_owner, repo_name, github_pr_number, github_url,
            title, state, base_branch, head_branch, additions, deletions, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            "pr-stale", "proj-1", "lane-a", "acme", "ade", 2, "https://example.com/pr/2",
            "stale", "open", "main", "feature/a", 0, 0, BSW_NOW, BSW_NOW,
          ],
        );

        vi.mocked(runGitOrThrow).mockImplementation(async () => ({ exitCode: 0, stdout: "", stderr: "" } as any));
        vi.mocked(runGit).mockImplementation(makeRunGitResponder((args) => {
          if (args[0] === "show-ref" && args[3] === "refs/heads/feature/b") return { exitCode: 0, stdout: "", stderr: "" };
          return null;
        }) as any);

        const service = makeBswService(db, repoRoot, "proj-1");
        const result = await service.switchBranch({ laneId: "lane-a", branchName: "feature/b" });

        expect(result.lane.branchRef).toBe("feature/b");

        const keep = db.get<{ lane_id: string | null }>(
          "select lane_id from pull_requests where id = ?",
          ["pr-keep"],
        );
        expect(keep?.lane_id).toBe("lane-a");

        const stale = db.get<{ lane_id: string | null }>(
          "select lane_id from pull_requests where id = ?",
          ["pr-stale"],
        );
        expect(stale).toBeNull();
      } finally {
        db.close();
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });
  });
});
