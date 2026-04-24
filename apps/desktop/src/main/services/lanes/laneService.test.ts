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
      if (args[0] === "show-ref" && args[1] === "--verify" && args[2] === "--quiet") {
        return { exitCode: 0, stdout: "", stderr: "" };
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
        ["lane-main", "proj-create-primary-parent", "Primary", null, "primary", "main", "missions-overhaul", repoRoot, null, 1, null, null, null, null, "active", now, null],
      );

      vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
        if (args[0] === "worktree" && args[1] === "add") {
          return { exitCode: 0, stdout: "", stderr: "" } as any;
        }
        throw new Error(`Unexpected git call: ${args.join(" ")}`);
      });

      vi.mocked(runGit).mockImplementation(async (args: string[]) => {
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
        ["lane-main", "proj-repair-root-base", "Main", null, "primary", "main", "missions-overhaul", repoRoot, null, 1, null, null, null, null, "active", now, null],
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
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") {
          return { exitCode: 0, stdout: "missions-overhaul\n", stderr: "" };
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

  it("reuses an existing local branch when importing a remote-qualified ref", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-import-local-existing-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-import-local-existing", repoRoot });

    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
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
  });
});

describe("laneService missionId and laneRole", () => {
  beforeEach(() => {
    vi.mocked(getHeadSha).mockReset();
    vi.mocked(runGit).mockReset();
    vi.mocked(runGitOrThrow).mockReset();
  });

  it("createChild persists missionId and laneRole on the created lane", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-child-mission-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-child-mission", repoRoot });

    const parentWorktreePath = path.join(repoRoot, "parent");

    vi.mocked(getHeadSha).mockImplementation(async (cwd: string) => {
      if (cwd === parentWorktreePath) return "sha-parent-head";
      return "sha-generic";
    });

    vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "add") {
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    vi.mocked(runGit).mockImplementation(async (args: string[], options: { cwd?: string } = {}) => {
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

    // Insert a mission row so the FK on lanes.mission_id is satisfied
    const now = "2026-03-11T12:00:00.000Z";
    db.run(
      `insert into missions(id, project_id, title, prompt, status, priority, execution_mode, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["mission-abc", "proj-child-mission", "Test mission", "do something", "pending", "normal", "local", now, now],
    );

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-child-mission",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    const lane = await service.createChild({
      parentLaneId: "lane-parent",
      name: "Mission worker lane",
      missionId: "mission-abc",
      laneRole: "worker",
    });

    expect(lane.missionId).toBe("mission-abc");
    expect(lane.laneRole).toBe("worker");
  });

  it("createChild defaults missionId and laneRole to null when omitted", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-child-no-mission-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-child-no-mission", repoRoot });

    const parentWorktreePath = path.join(repoRoot, "parent");

    vi.mocked(getHeadSha).mockImplementation(async (cwd: string) => {
      if (cwd === parentWorktreePath) return "sha-parent-head";
      return "sha-generic";
    });

    vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "add") {
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
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
      projectId: "proj-child-no-mission",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    const lane = await service.createChild({
      parentLaneId: "lane-parent",
      name: "Plain child lane",
    });

    expect(lane.missionId).toBeNull();
    expect(lane.laneRole).toBeNull();
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

  it("setMissionOwnership updates missionId and laneRole on an existing lane", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-set-ownership-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-set-ownership", repoRoot });

    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
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

    // Insert a mission row so the FK on lanes.mission_id is satisfied
    const now = "2026-03-11T12:00:00.000Z";
    db.run(
      `insert into missions(id, project_id, title, prompt, status, priority, execution_mode, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["mission-xyz", "proj-set-ownership", "Test mission", "do something", "pending", "normal", "local", now, now],
    );

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-set-ownership",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    // Verify initially null
    const before = (await service.list({ includeStatus: false })).find((l) => l.id === "lane-parent");
    expect(before?.missionId).toBeNull();
    expect(before?.laneRole).toBeNull();

    // Set mission ownership
    service.setMissionOwnership({
      laneId: "lane-parent",
      missionId: "mission-xyz",
      laneRole: "mission_root",
    });

    const after = (await service.list({ includeStatus: false })).find((l) => l.id === "lane-parent");
    expect(after?.missionId).toBe("mission-xyz");
    expect(after?.laneRole).toBe("mission_root");
  });

  it("setMissionOwnership clears fields when passed null", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-clear-ownership-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-clear-ownership", repoRoot });

    // Insert a mission row so the FK on lanes.mission_id is satisfied
    const now = "2026-03-11T12:00:00.000Z";
    db.run(
      `insert into missions(id, project_id, title, prompt, status, priority, execution_mode, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["mission-existing", "proj-clear-ownership", "Test mission", "do something", "pending", "normal", "local", now, now],
    );

    // Manually set mission_id/lane_role in DB first
    db.run("update lanes set mission_id = ?, lane_role = ? where id = ?", ["mission-existing", "worker", "lane-parent"]);

    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
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
      projectId: "proj-clear-ownership",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    // Verify pre-existing values
    const before = (await service.list({ includeStatus: false })).find((l) => l.id === "lane-parent");
    expect(before?.missionId).toBe("mission-existing");
    expect(before?.laneRole).toBe("worker");

    // Clear by setting null
    service.setMissionOwnership({
      laneId: "lane-parent",
      missionId: null,
      laneRole: null,
    });

    const after = (await service.list({ includeStatus: false })).find((l) => l.id === "lane-parent");
    expect(after?.missionId).toBeNull();
    expect(after?.laneRole).toBeNull();
  });

  it("setMissionOwnership throws for empty laneId", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-empty-id-"));

    // Create a minimal service — we only need the sync method to throw
    const setup = async () => {
      const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
      const now = "2026-03-11T12:00:00.000Z";
      db.run(
        "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
        ["proj-empty-id", repoRoot, "demo", "main", now, now],
      );
      return createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-empty-id",
        defaultBaseRef: "main",
        worktreesDir: path.join(repoRoot, "worktrees"),
      });
    };

    return setup().then((service) => {
      expect(() =>
        service.setMissionOwnership({ laneId: "", missionId: "m-1", laneRole: "worker" })
      ).toThrow("laneId is required");
    });
  });

  it("setMissionOwnership throws for non-existent lane", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-no-lane-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const now = "2026-03-11T12:00:00.000Z";
    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      ["proj-no-lane", repoRoot, "demo", "main", now, now],
    );

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-no-lane",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    expect(() =>
      service.setMissionOwnership({ laneId: "nonexistent", missionId: "m-1", laneRole: "worker" })
    ).toThrow("Lane not found: nonexistent");
  });

  it("toLaneSummary maps mission_id and lane_role from DB row", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-service-summary-map-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-summary-map", repoRoot });

    // Insert mission row so FK constraint is satisfied, then set mission fields
    db.run(
      `insert into missions(id, project_id, title, prompt, status, priority, execution_mode, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["mission-map-test", "proj-summary-map", "Test Mission", "test", "active", "medium", "background", new Date().toISOString(), new Date().toISOString()]
    );
    db.run("update lanes set mission_id = ?, lane_role = ? where id = ?", ["mission-map-test", "integration", "lane-parent"]);

    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
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
      projectId: "proj-summary-map",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    const lanes = await service.list({ includeStatus: false });
    const lane = lanes.find((l) => l.id === "lane-parent");
    expect(lane?.missionId).toBe("mission-map-test");
    expect(lane?.laneRole).toBe("integration");
  });
});
