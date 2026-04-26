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

const NOW = "2026-04-25T10:00:00.000Z";

function seedProject(db: any, args: { projectId: string; repoRoot: string }) {
  db.run(
    "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
    [args.projectId, args.repoRoot, "demo", "main", NOW, NOW],
  );
}

function insertLane(db: any, args: {
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
      NOW,
      args.status === "archived" ? NOW : null,
    ],
  );
}

/**
 * Make a generic runGit responder that returns success for the most common
 * read-only ancillary calls performed by listLanes(). Test-specific behaviour
 * can be layered on top.
 */
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

function makeService(db: any, projectRoot: string, projectId: string) {
  return createLaneService({
    db,
    projectRoot,
    projectId,
    defaultBaseRef: "main",
    worktreesDir: path.join(projectRoot, "worktrees"),
    logger: createLogger(),
  });
}

describe("laneService.listBranchProfiles", () => {
  beforeEach(() => {
    vi.mocked(getHeadSha).mockReset();
    vi.mocked(runGit).mockReset();
    vi.mocked(runGitOrThrow).mockReset();
  });

  it("ensures and returns a profile for the lane's current branch_ref", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-bsw-list-profile-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    try {
      seedProject(db, { projectId: "proj-1", repoRoot });
      insertLane(db, { id: "lane-a", projectId: "proj-1", name: "Lane A", laneType: "worktree", branchRef: "feature/lane-a", worktreePath: path.join(repoRoot, "lane-a") });

      vi.mocked(runGit).mockImplementation(makeRunGitResponder() as any);

      const service = makeService(db, repoRoot, "proj-1");
      const profiles = service.listBranchProfiles("lane-a");

      expect(profiles).toHaveLength(1);
      expect(profiles[0]?.branchRef).toBe("feature/lane-a");
      expect(profiles[0]?.laneId).toBe("lane-a");
      expect(profiles[0]?.baseRef).toBe("main");

      // Calling again should not duplicate.
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
      seedProject(db, { projectId: "proj-1", repoRoot });
      const service = makeService(db, repoRoot, "proj-1");
      expect(() => service.listBranchProfiles("nonexistent")).toThrow(/Lane not found/);
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("laneService.updateBranchRef", () => {
  beforeEach(() => {
    vi.mocked(getHeadSha).mockReset();
    vi.mocked(runGit).mockReset();
    vi.mocked(runGitOrThrow).mockReset();
  });

  it("updates the lane's branch_ref AND upserts a matching branch profile", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-bsw-update-bref-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    try {
      seedProject(db, { projectId: "proj-1", repoRoot });
      insertLane(db, { id: "lane-a", projectId: "proj-1", name: "Lane A", laneType: "worktree", branchRef: "feature/lane-a", worktreePath: path.join(repoRoot, "lane-a") });

      vi.mocked(runGit).mockImplementation(makeRunGitResponder() as any);

      const service = makeService(db, repoRoot, "proj-1");

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

describe("laneService.previewBranchSwitch", () => {
  beforeEach(() => {
    vi.mocked(getHeadSha).mockReset();
    vi.mocked(runGit).mockReset();
    vi.mocked(runGitOrThrow).mockReset();
  });

  it("rejects when laneId is empty", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-bsw-prev-laneid-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    try {
      seedProject(db, { projectId: "proj-1", repoRoot });
      const service = makeService(db, repoRoot, "proj-1");
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
      seedProject(db, { projectId: "proj-1", repoRoot });
      insertLane(db, { id: "lane-a", projectId: "proj-1", name: "Lane A", laneType: "worktree", branchRef: "feature/lane-a", worktreePath: path.join(repoRoot, "lane-a") });
      const service = makeService(db, repoRoot, "proj-1");
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
      seedProject(db, { projectId: "proj-1", repoRoot });
      insertLane(db, {
        id: "lane-archived", projectId: "proj-1", name: "Archived", laneType: "worktree",
        branchRef: "feature/old", worktreePath: path.join(repoRoot, "old"), status: "archived",
      });
      const service = makeService(db, repoRoot, "proj-1");
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
      seedProject(db, { projectId: "proj-1", repoRoot });
      insertLane(db, { id: "lane-src", projectId: "proj-1", name: "Source", laneType: "worktree", branchRef: "feature/src", worktreePath: path.join(repoRoot, "src") });
      insertLane(db, { id: "lane-other", projectId: "proj-1", name: "Other Lane", laneType: "worktree", branchRef: "feature/target", worktreePath: path.join(repoRoot, "other") });

      // Active terminal session on lane-src.
      db.run(
        `insert into terminal_sessions(id, lane_id, tracked, title, started_at, status, transcript_path)
         values (?, ?, ?, ?, ?, ?, ?)`,
        ["term-1", "lane-src", 1, "shell", NOW, "running", path.join(repoRoot, "t.log")],
      );
      // Active process_runtime row on lane-src.
      db.run(
        `insert into process_runtime(project_id, lane_id, process_key, status, readiness, updated_at)
         values (?, ?, ?, ?, ?, ?)`,
        ["proj-1", "lane-src", "vite", "running", "ready", NOW],
      );

      // Dirty worktree; target branch resolves locally to keep the same key as lane-other.
      vi.mocked(runGit).mockImplementation(makeRunGitResponder((args, opts) => {
        if (args[0] === "show-ref" && args[1] === "--verify" && args[2] === "--quiet") {
          if (args[3] === "refs/heads/feature/target") return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "status" && args[1] === "--porcelain=v1" && opts.cwd === path.join(repoRoot, "src")) {
          return { exitCode: 0, stdout: " M file.ts\n", stderr: "" };
        }
        return null;
      }) as any);

      const service = makeService(db, repoRoot, "proj-1");
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
      seedProject(db, { projectId: "proj-1", repoRoot });
      insertLane(db, { id: "lane-x", projectId: "proj-1", name: "X", laneType: "worktree", branchRef: "feature/x", worktreePath: path.join(repoRoot, "x") });

      vi.mocked(runGit).mockImplementation(makeRunGitResponder((args) => {
        if (args[0] === "show-ref" && args[1] === "--verify" && args[2] === "--quiet") {
          if (args[3] === "refs/heads/origin/foo") return { exitCode: 1, stdout: "", stderr: "" };
          if (args[3] === "refs/remotes/origin/foo") return { exitCode: 0, stdout: "", stderr: "" };
        }
        return null;
      }) as any);

      const service = makeService(db, repoRoot, "proj-1");
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
      seedProject(db, { projectId: "proj-1", repoRoot });
      insertLane(db, { id: "lane-y", projectId: "proj-1", name: "Y", laneType: "worktree", branchRef: "feature/y", worktreePath: path.join(repoRoot, "y") });

      const showRefCalls: string[] = [];
      vi.mocked(runGit).mockImplementation(makeRunGitResponder((args) => {
        if (args[0] === "show-ref") showRefCalls.push(args.join(" "));
        return null;
      }) as any);

      const service = makeService(db, repoRoot, "proj-1");
      const preview = await service.previewBranchSwitch({ laneId: "lane-y", branchName: "feature/new", mode: "create" });

      expect(preview.mode).toBe("create");
      expect(preview.targetBranchRef).toBe("feature/new");
      // create mode should NOT probe local/remote refs to resolve an existing branch.
      expect(showRefCalls).toHaveLength(0);
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("laneService.switchBranch", () => {
  beforeEach(() => {
    vi.mocked(getHeadSha).mockReset();
    vi.mocked(runGit).mockReset();
    vi.mocked(runGitOrThrow).mockReset();
  });

  it("refuses to switch when the lane has uncommitted changes", async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-bsw-switch-dirty-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    try {
      seedProject(db, { projectId: "proj-1", repoRoot });
      insertLane(db, { id: "lane-d", projectId: "proj-1", name: "D", laneType: "worktree", branchRef: "feature/d", worktreePath: path.join(repoRoot, "d") });

      vi.mocked(runGit).mockImplementation(makeRunGitResponder((args, opts) => {
        if (args[0] === "show-ref" && args[3] === "refs/heads/main") return { exitCode: 0, stdout: "", stderr: "" };
        if (args[0] === "status" && args[1] === "--porcelain=v1" && opts.cwd === path.join(repoRoot, "d")) {
          return { exitCode: 0, stdout: " M src/foo.ts\n", stderr: "" };
        }
        return null;
      }) as any);

      const service = makeService(db, repoRoot, "proj-1");
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
      seedProject(db, { projectId: "proj-1", repoRoot });
      insertLane(db, { id: "lane-src", projectId: "proj-1", name: "Source", laneType: "worktree", branchRef: "feature/src", worktreePath: path.join(repoRoot, "src") });
      insertLane(db, { id: "lane-other", projectId: "proj-1", name: "Other Lane", laneType: "worktree", branchRef: "feature/duplicate", worktreePath: path.join(repoRoot, "other") });

      vi.mocked(runGit).mockImplementation(makeRunGitResponder((args) => {
        if (args[0] === "show-ref" && args[3] === "refs/heads/feature/duplicate") return { exitCode: 0, stdout: "", stderr: "" };
        return null;
      }) as any);

      const service = makeService(db, repoRoot, "proj-1");
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
      seedProject(db, { projectId: "proj-1", repoRoot });
      insertLane(db, { id: "lane-a", projectId: "proj-1", name: "A", laneType: "worktree", branchRef: "feature/a", worktreePath: path.join(repoRoot, "a") });

      db.run(
        `insert into terminal_sessions(id, lane_id, tracked, title, started_at, status, transcript_path)
         values (?, ?, ?, ?, ?, ?, ?)`,
        ["t-1", "lane-a", 1, "shell", NOW, "running", path.join(repoRoot, "t.log")],
      );

      vi.mocked(runGit).mockImplementation(makeRunGitResponder((args) => {
        if (args[0] === "show-ref" && args[3] === "refs/heads/main") return { exitCode: 0, stdout: "", stderr: "" };
        return null;
      }) as any);

      const service = makeService(db, repoRoot, "proj-1");
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
      seedProject(db, { projectId: "proj-1", repoRoot });
      insertLane(db, { id: "lane-main", projectId: "proj-1", name: "Main", laneType: "primary", branchRef: "main", worktreePath: repoRoot });
      insertLane(db, { id: "lane-a", projectId: "proj-1", name: "A", laneType: "worktree", branchRef: "feature/a", worktreePath: path.join(repoRoot, "a") });

      const checkoutCalls: string[][] = [];
      vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
        if (args[0] === "checkout") checkoutCalls.push(args);
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      });
      vi.mocked(runGit).mockImplementation(makeRunGitResponder((args) => {
        if (args[0] === "show-ref" && args[3] === "refs/heads/feature/b") return { exitCode: 0, stdout: "", stderr: "" };
        return null;
      }) as any);

      const service = makeService(db, repoRoot, "proj-1");
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
      seedProject(db, { projectId: "proj-1", repoRoot });
      insertLane(db, { id: "lane-main", projectId: "proj-1", name: "Main", laneType: "primary", branchRef: "main", worktreePath: repoRoot });
      insertLane(db, { id: "lane-c", projectId: "proj-1", name: "C", laneType: "worktree", branchRef: "feature/c", worktreePath: path.join(repoRoot, "c") });

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
          return { exitCode: 1, stdout: "", stderr: "" }; // does not exist yet
        }
        return null;
      }) as any);

      const service = makeService(db, repoRoot, "proj-1");
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
      seedProject(db, { projectId: "proj-1", repoRoot });
      insertLane(db, { id: "lane-c", projectId: "proj-1", name: "C", laneType: "worktree", branchRef: "feature/c", worktreePath: path.join(repoRoot, "c") });

      vi.mocked(runGit).mockImplementation(makeRunGitResponder() as any);

      const service = makeService(db, repoRoot, "proj-1");
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
      seedProject(db, { projectId: "proj-1", repoRoot });
      insertLane(db, { id: "lane-c", projectId: "proj-1", name: "C", laneType: "worktree", branchRef: "feature/c", worktreePath: path.join(repoRoot, "c") });

      vi.mocked(runGit).mockImplementation(makeRunGitResponder((args) => {
        if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "main") {
          return { exitCode: 0, stdout: "sha\n", stderr: "" };
        }
        if (args[0] === "show-ref" && args[3] === "refs/heads/feature/existing") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return null;
      }) as any);

      const service = makeService(db, repoRoot, "proj-1");
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
    // pull_requests.lane_id is NOT NULL, so stale PR rows whose head_branch
    // no longer matches the lane's branch are DELETED (along with their
    // child rows in pr_convergence_state / pr_pipeline_settings /
    // pr_issue_inventory / pr_group_members), not nulled.
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-bsw-switch-pr-detach-"));
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    try {
      seedProject(db, { projectId: "proj-1", repoRoot });
      insertLane(db, { id: "lane-main", projectId: "proj-1", name: "Main", laneType: "primary", branchRef: "main", worktreePath: repoRoot });
      insertLane(db, { id: "lane-a", projectId: "proj-1", name: "A", laneType: "worktree", branchRef: "feature/a", worktreePath: path.join(repoRoot, "a") });

      // PR already keyed to the new branch — should be left untouched.
      db.run(
        `insert into pull_requests(
          id, project_id, lane_id, repo_owner, repo_name, github_pr_number, github_url,
          title, state, base_branch, head_branch, additions, deletions, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "pr-keep", "proj-1", "lane-a", "acme", "ade", 1, "https://example.com/pr/1",
          "keep", "open", "main", "feature/b", 0, 0, NOW, NOW,
        ],
      );
      // PR for the previous branch — should be deleted on switch.
      db.run(
        `insert into pull_requests(
          id, project_id, lane_id, repo_owner, repo_name, github_pr_number, github_url,
          title, state, base_branch, head_branch, additions, deletions, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "pr-stale", "proj-1", "lane-a", "acme", "ade", 2, "https://example.com/pr/2",
          "stale", "open", "main", "feature/a", 0, 0, NOW, NOW,
        ],
      );

      vi.mocked(runGitOrThrow).mockImplementation(async () => ({ exitCode: 0, stdout: "", stderr: "" } as any));
      vi.mocked(runGit).mockImplementation(makeRunGitResponder((args) => {
        if (args[0] === "show-ref" && args[3] === "refs/heads/feature/b") return { exitCode: 0, stdout: "", stderr: "" };
        return null;
      }) as any);

      const service = makeService(db, repoRoot, "proj-1");
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
