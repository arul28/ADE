import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createLaneService, parseGitWorktreePorcelain } from "./laneService";

vi.mock("../git/git", () => ({
  getHeadSha: vi.fn(),
  runGit: vi.fn(),
  runGitOrThrow: vi.fn(),
}));

import { getHeadSha, runGit, runGitOrThrow } from "../git/git";

/**
 * A fixture repo root in the same path space real git reports from. `os.tmpdir()`
 * is a symlink on macOS, and these tests fabricate git's output from the paths
 * they build — git itself always answers with symlinks resolved, so an
 * unresolved fixture root would model something git never produces. Tests that
 * need a symlinked root build one explicitly.
 */
function makeTempRepoRoot(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

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

  it("includes worktree availability in lane summaries", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-service-worktree-available-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    try {
      await seedProjectAndStack(db, { projectId: "proj-worktree-available", repoRoot });
      const missingChildPath = path.join(repoRoot, "child");

      vi.mocked(runGit).mockImplementation(async (args: string[], opts?: { cwd?: string }) => {
        const laneBranchGitStub = defaultLaneBranchGitStub(args);
        if (laneBranchGitStub) return laneBranchGitStub;
        const cwd = opts?.cwd ?? repoRoot;
        if (args[0] === "worktree" && args[1] === "list") return { exitCode: 0, stdout: "", stderr: "" };
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") {
          return { exitCode: 0, stdout: "main\n", stderr: "" };
        }
        if (args[0] === "rev-parse" && args[1] === "--path-format=absolute" && args[2] === "--show-toplevel") {
          return cwd === missingChildPath
            ? { exitCode: 128, stdout: "", stderr: "missing worktree" }
            : { exitCode: 0, stdout: `${cwd}\n`, stderr: "" };
        }
        if (args[0] === "rev-parse" && args[1] === "--verify") return { exitCode: 1, stdout: "", stderr: "" };
        if (args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" };
        if (args[0] === "rev-list" && args[1] === "--left-right") return { exitCode: 0, stdout: "0\t0\n", stderr: "" };
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args.includes("@{upstream}")) {
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        if (args[0] === "rev-parse" && args[1] === "--path-format=absolute" && args[2] === "--git-dir") {
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        throw new Error(`Unexpected git call: ${args.join(" ")}`);
      });

      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-worktree-available",
        defaultBaseRef: "main",
        worktreesDir: path.join(repoRoot, "worktrees"),
      });

      const lanes = await service.list({ includeStatus: true });

      expect(lanes.find((lane) => lane.id === "lane-main")?.worktreeAvailable).toBe(true);
      expect(lanes.find((lane) => lane.id === "lane-parent")?.worktreeAvailable).toBe(true);
      expect(lanes.find((lane) => lane.id === "lane-child")?.worktreeAvailable).toBe(false);
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("preserves agent summaries during status-only snapshot refreshes", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-service-status-snapshot-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    try {
      await seedProjectAndStack(db, { projectId: "proj-status-snapshot", repoRoot });
      const now = "2026-03-11T12:00:00.000Z";
      db.run(
        "insert into lane_state_snapshots(lane_id, agent_summary_json, updated_at) values (?, ?, ?)",
        ["lane-child", JSON.stringify({ headline: "Keep this summary" }), now],
      );

      vi.mocked(runGit).mockImplementation(async (args: string[], opts?: { cwd?: string }) => {
        const laneBranchGitStub = defaultLaneBranchGitStub(args);
        if (laneBranchGitStub) return laneBranchGitStub;
        const cwd = opts?.cwd ?? repoRoot;
        if (args[0] === "worktree" && args[1] === "list") return { exitCode: 0, stdout: "", stderr: "" };
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") {
          return { exitCode: 0, stdout: "main\n", stderr: "" };
        }
        if (args[0] === "rev-parse" && args[1] === "--path-format=absolute" && args[2] === "--show-toplevel") {
          return { exitCode: 0, stdout: `${cwd}\n`, stderr: "" };
        }
        if (args[0] === "rev-parse" && args[1] === "--verify") return { exitCode: 1, stdout: "", stderr: "" };
        if (args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" };
        if (args[0] === "rev-list" && args[1] === "--left-right") return { exitCode: 0, stdout: "0\t0\n", stderr: "" };
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args.includes("@{upstream}")) {
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        if (args[0] === "rev-parse" && args[1] === "--path-format=absolute" && args[2] === "--git-dir") {
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        throw new Error(`Unexpected git call: ${args.join(" ")}`);
      });

      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-status-snapshot",
        defaultBaseRef: "main",
        worktreesDir: path.join(repoRoot, "worktrees"),
      });

      await service.getSummary("lane-child", { includeStatus: true });

      expect(service.getStateSnapshot("lane-child")?.agentSummary).toEqual({
        headline: "Keep this summary",
      });
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("skips lane_state_snapshots writes when the lane status is unchanged", async () => {
    // Regression: unchanged status polls used to rewrite updated_at on every
    // summary read, replicating a CRDT row change to phones every poll and
    // hammering the mobile Lanes list with no-op invalidations.
    const repoRoot = makeTempRepoRoot("ade-lane-service-noop-snapshot-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    try {
      await seedProjectAndStack(db, { projectId: "proj-noop-snapshot", repoRoot });

      let statusStdout = "";
      vi.mocked(runGit).mockImplementation(async (args: string[], opts?: { cwd?: string }) => {
        const laneBranchGitStub = defaultLaneBranchGitStub(args);
        if (laneBranchGitStub) return laneBranchGitStub;
        const cwd = opts?.cwd ?? repoRoot;
        if (args[0] === "worktree" && args[1] === "list") return { exitCode: 0, stdout: "", stderr: "" };
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") {
          return { exitCode: 0, stdout: "main\n", stderr: "" };
        }
        if (args[0] === "rev-parse" && args[1] === "--path-format=absolute" && args[2] === "--show-toplevel") {
          return { exitCode: 0, stdout: `${cwd}\n`, stderr: "" };
        }
        if (args[0] === "rev-parse" && args[1] === "--verify") return { exitCode: 1, stdout: "", stderr: "" };
        if (args[0] === "status") return { exitCode: 0, stdout: statusStdout, stderr: "" };
        if (args[0] === "rev-list" && args[1] === "--left-right") return { exitCode: 0, stdout: "0\t0\n", stderr: "" };
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args.includes("@{upstream}")) {
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        if (args[0] === "rev-parse" && args[1] === "--path-format=absolute" && args[2] === "--git-dir") {
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        throw new Error(`Unexpected git call: ${args.join(" ")}`);
      });

      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-noop-snapshot",
        defaultBaseRef: "main",
        worktreesDir: path.join(repoRoot, "worktrees"),
      });

      await service.getSummary("lane-child", { includeStatus: true });
      const row = () =>
        db.get<{ dirty: number; updated_at: string }>(
          "select dirty, updated_at from lane_state_snapshots where lane_id = ?",
          ["lane-child"],
        );
      expect(row()?.dirty).toBe(0);

      // Pin updated_at to a sentinel; an unchanged-status read must not touch it.
      const sentinel = "2026-03-11T12:34:56.000Z";
      db.run("update lane_state_snapshots set updated_at = ? where lane_id = ?", [sentinel, "lane-child"]);
      await service.getSummary("lane-child", { includeStatus: true });
      expect(row()).toEqual({ dirty: 0, updated_at: sentinel });

      // A real status change still writes.
      statusStdout = " M file.txt\n";
      await service.getSummary("lane-child", { includeStatus: true });
      expect(row()?.dirty).toBe(1);
      expect(row()?.updated_at).not.toBe(sentinel);
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("recreates the primary lane when the only stored primary lane is archived", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-service-primary-archived-");
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-linear-card-");
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-linear-projectless-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-linear-projectless", repoRoot });

    const onLinearIssueLinked = vi.fn();
    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-linear-projectless",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
      onLinearIssueLinked,
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
    expect(onLinearIssueLinked).toHaveBeenCalledWith(expect.objectContaining({
      lane: expect.objectContaining({ id: "lane-child" }),
      issue: expect.objectContaining({ identifier: "ADE-45" }),
    }));
  });

  it("moves unstaged and untracked changes into a new child lane", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-service-rescue-success-");
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
      if (args[0] === "status" && String(args[1]).startsWith("--porcelain")) {
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-rescue-staged-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-rescue-staged", repoRoot });

    const sourceWorktreePath = path.join(repoRoot, "parent");

    vi.mocked(getHeadSha).mockResolvedValue("sha-parent-head");
    vi.mocked(runGit).mockImplementation(async (args: string[], options: { cwd?: string } = {}) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "status" && String(args[1]).startsWith("--porcelain") && options.cwd === sourceWorktreePath) {
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-rescue-primary-");
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
      if (args[0] === "status" && String(args[1]).startsWith("--porcelain")) {
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-rescue-rollback-");
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
      if (args[0] === "status" && String(args[1]).startsWith("--porcelain")) {
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-rescue-empty-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-rescue-empty", repoRoot });

    const sourceWorktreePath = path.join(repoRoot, "parent");

    vi.mocked(getHeadSha).mockResolvedValue("sha-parent-head");
    vi.mocked(runGit).mockImplementation(async (args: string[], options: { cwd?: string } = {}) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "status" && String(args[1]).startsWith("--porcelain") && options.cwd === sourceWorktreePath) {
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

describe("laneService automatic lane identity", () => {
  beforeEach(() => {
    vi.mocked(getHeadSha).mockReset();
    vi.mocked(runGit).mockReset();
    vi.mocked(runGitOrThrow).mockReset();
  });

  it("serializes duplicate completions and renames the exact temporary branch once", async () => {
    const repoRoot = makeTempRepoRoot("ade-auto-lane-identity-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    try {
      await seedProjectAndStack(db, { projectId: "proj-auto-identity", repoRoot });
      db.run("update lanes set name = ?, branch_ref = ? where id = ?", [
        "Naming Auto Created Lanes",
        "ade/1a2b3c4d",
        "lane-child",
      ]);
      let releaseRename!: () => void;
      const renameStarted = new Promise<void>((resolve) => {
        vi.mocked(runGit).mockImplementation(async (args: string[]) => {
          if (args[0] === "branch" && args[1] === "--show-current") {
            return { exitCode: 0, stdout: "ade/1a2b3c4d\n", stderr: "" };
          }
          if (args[0] === "rev-parse" && args.includes("@{upstream}")) {
            return { exitCode: 1, stdout: "", stderr: "" };
          }
          if (args[0] === "remote" && args[1] === "get-url") {
            return { exitCode: 2, stdout: "", stderr: "" };
          }
          if (args[0] === "check-ref-format") return { exitCode: 0, stdout: "", stderr: "" };
          if (args[0] === "show-ref") return { exitCode: 1, stdout: "", stderr: "" };
          if (args[0] === "branch" && args[1] === "-m") {
            resolve();
            await new Promise<void>((done) => { releaseRename = done; });
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          throw new Error(`Unexpected git call: ${args.join(" ")}`);
        });
      });
      const identityUpdateBranchRefs: string[] = [];
      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-auto-identity",
        defaultBaseRef: "main",
        worktreesDir: path.join(repoRoot, "worktrees"),
        onLifecycleEvent: (event) => {
          if (event.type !== "lane-branch-updated") return;
          const row = db.get<{ branch_ref: string }>(
            "select branch_ref from lanes where id = ?",
            ["lane-child"],
          );
          identityUpdateBranchRefs.push(row?.branch_ref ?? "");
        },
      });
      const mutation = {
        laneId: "lane-child",
        expectedLaneName: "Naming Auto Created Lanes",
        temporaryBranch: "ade/1a2b3c4d",
        laneTitle: "Naming Auto Created Lanes",
        branchFragment: "naming-auto-created-lanes",
      };

      const first = service.applyAutoLaneIdentity(mutation);
      await renameStarted;
      const duplicate = await service.applyAutoLaneIdentity(mutation);
      releaseRename();
      const completed = await first;

      expect(duplicate).toMatchObject({
        branchRenameOutcome: "skipped",
        reason: "identity_mutation_in_flight",
      });
      expect(completed).toMatchObject({
        branchRenameOutcome: "renamed",
        branchRef: "ade/naming-auto-created-lanes",
      });
      expect(vi.mocked(runGit).mock.calls.filter(([args]) => args[0] === "branch" && args[1] === "-m")).toHaveLength(1);
      expect(db.get("select branch_ref from lanes where id = ?", ["lane-child"])).toMatchObject({
        branch_ref: "ade/naming-auto-created-lanes",
      });
      expect(identityUpdateBranchRefs).toEqual(["ade/naming-auto-created-lanes"]);
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("laneService create", () => {
  beforeEach(() => {
    vi.mocked(getHeadSha).mockReset();
    vi.mocked(runGit).mockReset();
    vi.mocked(runGitOrThrow).mockReset();
  });

  it("creates an unparented lane from the requested base branch", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-service-create-root-");
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
        if (args[0] === "status" && String(args[1]).startsWith("--porcelain")) {
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

  it("does not let a concurrent list adopt a half-created worktree as a duplicate lane", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-service-create-race-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const now = "2026-03-11T12:00:00.000Z";

    // Hoisted so the finally can always release the gate and drain the create,
    // even if an assertion throws mid-test.
    let releaseWorktreeAdd: () => void = () => {};
    let createPromise: Promise<unknown> = Promise.resolve();

    try {
      db.run(
        "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
        ["proj-create-race", repoRoot, "demo", "main", now, now],
      );
      db.run(
        `
          insert into lanes(
            id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
            attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        ["lane-main", "proj-create-race", "Main", null, "primary", "main", "main", repoRoot, null, 1, null, null, null, null, "active", now, null],
      );

      // `git worktree list` reports a new worktree the moment `worktree add`
      // registers it, before checkout completes. Park the add on a gate so a
      // list() can run inside that window.
      let pendingWorktree: { path: string; branch: string } | null = null;
      const worktreeAddGate = new Promise<void>((resolve) => {
        releaseWorktreeAdd = resolve;
      });

      vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
        if (args[0] === "worktree" && args[1] === "add") {
          pendingWorktree = { branch: args[3], path: args[4] };
          await worktreeAddGate;
          return { exitCode: 0, stdout: "", stderr: "" } as any;
        }
        if (args[0] === "worktree" && args[1] === "list") {
          const blocks = [`worktree ${repoRoot}\nbranch refs/heads/main`];
          if (pendingWorktree) {
            blocks.push(`worktree ${pendingWorktree.path}\nbranch refs/heads/${pendingWorktree.branch}`);
          }
          return { exitCode: 0, stdout: `${blocks.join("\n\n")}\n`, stderr: "" } as any;
        }
        throw new Error(`Unexpected git call: ${args.join(" ")}`);
      });

      vi.mocked(runGit).mockImplementation(async (args: string[]) => {
        const laneBranchGitStub = defaultLaneBranchGitStub(args);
        if (laneBranchGitStub) return laneBranchGitStub;
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") {
          return { exitCode: 0, stdout: "main\n", stderr: "" };
        }
        if (args[0] === "rev-parse" && args[1] === "main") {
          return { exitCode: 0, stdout: "sha-main\n", stderr: "" };
        }
        if (args[0] === "push" && args[1] === "-u") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "status" && String(args[1]).startsWith("--porcelain")) {
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
        projectId: "proj-create-race",
        defaultBaseRef: "main",
        worktreesDir: path.join(repoRoot, "worktrees"),
      });

      createPromise = service.create({ name: "Race lane", baseBranch: "main" });
      await vi.waitFor(() => {
        expect(pendingWorktree).not.toBeNull();
      });

      // List while the create's checkout is still running: recovery must not
      // adopt the pending worktree.
      const lanesDuringCreate = await service.list({ includeStatus: false });
      expect(lanesDuringCreate.some((lane) => lane.worktreePath === pendingWorktree!.path)).toBe(false);

      releaseWorktreeAdd();
      const lane = (await createPromise) as { id: string; worktreePath: string };

      const lanesAfterCreate = await service.list({ includeStatus: false });
      const lanesOnPath = lanesAfterCreate.filter((entry) => entry.worktreePath === lane.worktreePath);
      expect(lanesOnPath.map((entry) => entry.id)).toEqual([lane.id]);
    } finally {
      // Always release the gate and drain the create so an assertion failure
      // before line 777 cannot leave `createPromise` blocked and hang CI.
      releaseWorktreeAdd();
      await Promise.resolve(createPromise).catch(() => undefined);
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("creates an unparented lane from an explicit start point", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-service-create-start-point-");
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
        if (args[0] === "status" && String(args[1]).startsWith("--porcelain")) {
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-create-from-primary-");
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
        if (args[0] === "status" && String(args[1]).startsWith("--porcelain")) {
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-create-primary-parent-");
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
        if (args[0] === "status" && String(args[1]).startsWith("--porcelain")) {
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-repair-root-base-");
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

  it("dedupes duplicate lane rows sharing a managed worktree, keeping the creator row", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-service-repair-dup-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const worktreesDir = path.join(repoRoot, "worktrees");
    const sharedWorktreePath = path.join(worktreesDir, "claude-pre-launch-review-ba241a46");
    // The creator row's id matches the suffix embedded in the worktree dir name.
    const keeperId = "ba241a46-0000-4000-8000-000000000001";
    // The adoption artifact raced in first, so created_at alone would keep the wrong row.
    const artifactId = "f2862e51-0000-4000-8000-000000000002";

    try {
      db.run(
        "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
        ["proj-repair-dup", repoRoot, "demo", "main", "2026-06-11T17:41:00.000Z", "2026-06-11T17:41:00.000Z"],
      );
      const insertLane = `
        insert into lanes(
          id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
          attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      db.run(insertLane, ["lane-main", "proj-repair-dup", "Main", null, "primary", "main", "main", repoRoot, null, 1, null, null, null, null, "active", "2026-06-11T17:41:00.000Z", null]);
      db.run(insertLane, [artifactId, "proj-repair-dup", "claude pre launch review", null, "worktree", "main", "ade/claude-pre-launch-review-ba241a46", sharedWorktreePath, null, 0, null, null, null, null, "active", "2026-06-11T17:41:33.000Z", null]);
      db.run(insertLane, [keeperId, "proj-repair-dup", "claude pre-launch review", null, "worktree", "main", "ade/claude-pre-launch-review-ba241a46", sharedWorktreePath, null, 0, null, null, null, null, "active", "2026-06-11T17:41:33.933Z", null]);
      // Work that landed on the duplicate must survive the dedupe.
      db.run(insertLane, ["lane-dup-child", "proj-repair-dup", "Child of duplicate", null, "worktree", "ade/claude-pre-launch-review-ba241a46", "ade/dup-child", path.join(worktreesDir, "dup-child-11112222"), null, 0, artifactId, null, null, null, "active", "2026-06-11T18:00:00.000Z", null]);
      db.run(
        `
          insert into terminal_sessions(id, lane_id, title, started_at, transcript_path, status)
          values (?, ?, ?, ?, ?, ?)
        `,
        ["session-on-dup", artifactId, "shell", "2026-06-11T17:50:00.000Z", "/tmp/transcript.jsonl", "running"],
      );
      // A Linear issue link the user attached while the duplicate (artifact)
      // row was the one surfaced in the Lanes tab must survive onto the keeper.
      // `referenced` is a different role than the keeper's `worked` for the same
      // issue, so it must be preserved (role-aware dedupe), while a same-role
      // collision is dropped.
      const insertLink = `
        insert into lane_linear_issue_links(
          id, project_id, lane_id, issue_id, issue_json, role, source, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      db.run(insertLink, ["link-keeper-worked", "proj-repair-dup", keeperId, "ISS-99", "{}", "worked", "chat_attach", "2026-06-11T17:54:00.000Z", "2026-06-11T17:54:00.000Z"]);
      db.run(insertLink, ["link-dup-referenced", "proj-repair-dup", artifactId, "ISS-99", "{}", "referenced", "chat_attach", "2026-06-11T17:55:00.000Z", "2026-06-11T17:55:00.000Z"]);
      db.run(insertLink, ["link-dup-worked-dupe", "proj-repair-dup", artifactId, "ISS-99", "{}", "worked", "chat_attach", "2026-06-11T17:56:00.000Z", "2026-06-11T17:56:00.000Z"]);
      // A session-scoped Linear issue attached directly to the duplicate lane
      // must move to the keeper, not be cascade-deleted.
      db.run(
        `
          insert into session_linear_issues(
            id, project_id, session_id, lane_id, issue_id, issue_json, role, source, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        ["sess-link-on-dup", "proj-repair-dup", "session-on-dup", artifactId, "ISS-77", "{}", "worked", "chat_attach", "2026-06-11T17:57:00.000Z", "2026-06-11T17:57:00.000Z"],
      );
      db.run(
        `
          insert into lane_branch_profiles(
            id, project_id, lane_id, branch_ref, normalized_branch_ref, base_ref,
            parent_lane_id, source_branch_ref, created_at, updated_at, last_checked_out_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        ["profile-on-dup", "proj-repair-dup", artifactId, "ade/dup-switched", "ade/dup-switched", "main", null, null, "2026-06-11T17:58:00.000Z", "2026-06-11T17:58:00.000Z", "2026-06-11T17:58:00.000Z"],
      );

      vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return { exitCode: 0, stdout: "", stderr: "" } as any;
        }
        throw new Error(`Unexpected git call: ${args.join(" ")}`);
      });
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
        projectId: "proj-repair-dup",
        defaultBaseRef: "main",
        worktreesDir,
      });

      const lanes = await service.list({ includeStatus: false });

      const sharedPathLanes = lanes.filter((lane) => lane.worktreePath === sharedWorktreePath);
      expect(sharedPathLanes.map((lane) => lane.id)).toEqual([keeperId]);
      expect(lanes.some((lane) => lane.id === artifactId)).toBe(false);
      expect(lanes.find((lane) => lane.id === "lane-dup-child")?.parentLaneId).toBe(keeperId);
      expect(
        db.get<{ lane_id: string }>("select lane_id from terminal_sessions where id = ?", ["session-on-dup"])?.lane_id,
      ).toBe(keeperId);
      // The differently-roled link survives on the keeper; the same-role
      // collision is dropped (keeper's own `worked` wins). The keeper ends up
      // with exactly one `worked` and one `referenced` row for the issue.
      const keeperLinks = db.all<{ id: string; role: string }>(
        "select id, role from lane_linear_issue_links where lane_id = ? and issue_id = ? order by role",
        [keeperId, "ISS-99"],
      );
      expect(keeperLinks.map((r) => r.role)).toEqual(["referenced", "worked"]);
      expect(db.get<{ id: string }>("select id from lane_linear_issue_links where id = ?", ["link-dup-worked-dupe"])).toBeNull();
      // The session-scoped Linear issue moved to the keeper instead of being deleted.
      expect(
        db.get<{ lane_id: string }>("select lane_id from session_linear_issues where id = ?", ["sess-link-on-dup"])?.lane_id,
      ).toBe(keeperId);
      expect(
        db.get<{ lane_id: string }>("select lane_id from lane_branch_profiles where id = ?", ["profile-on-dup"])?.lane_id,
      ).toBe(keeperId);
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("laneService list cache invalidation", () => {
  beforeEach(() => {
    vi.mocked(getHeadSha).mockReset();
    vi.mocked(runGit).mockReset();
    vi.mocked(runGitOrThrow).mockReset();
  });

  it("does not cache a build whose rows were read before a mid-build invalidation", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-service-list-cache-epoch-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const now = "2026-03-11T12:00:00.000Z";
    const alphaPath = path.join(repoRoot, "alpha");
    const betaPath = path.join(repoRoot, "beta");

    try {
      db.run(
        "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
        ["proj-list-cache-epoch", repoRoot, "demo", "main", now, now],
      );
      const insertLane = `
        insert into lanes(
          id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
          attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      db.run(insertLane, ["lane-main", "proj-list-cache-epoch", "Main", null, "primary", "main", "main", repoRoot, null, 1, null, null, null, null, "active", now, null]);
      db.run(insertLane, ["lane-alpha", "proj-list-cache-epoch", "Alpha", null, "worktree", "main", "feature/alpha", alphaPath, null, 0, null, null, null, null, "active", now, null]);
      db.run(insertLane, ["lane-beta", "proj-list-cache-epoch", "Beta", null, "worktree", "main", "feature/beta", betaPath, null, 0, null, null, null, null, "active", now, null]);

      // The first build parks here — after it has read its lane rows, before it
      // writes the cache — so the test can land a deletion inside the window.
      let reachedStatusProbe!: () => void;
      const statusProbeReached = new Promise<void>((resolve) => { reachedStatusProbe = resolve; });
      let releaseStatusProbe!: () => void;
      const statusProbeGate = new Promise<void>((resolve) => { releaseStatusProbe = resolve; });
      let gateArmed = true;

      vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
        if (args[0] === "worktree" && args[1] === "list") return { exitCode: 0, stdout: "", stderr: "" } as any;
        throw new Error(`Unexpected git call: ${args.join(" ")}`);
      });
      vi.mocked(runGit).mockImplementation(async (args: string[], opts?: { cwd?: string }) => {
        const laneBranchGitStub = defaultLaneBranchGitStub(args);
        if (laneBranchGitStub) return laneBranchGitStub;
        const cwd = opts?.cwd ?? repoRoot;
        if (args[0] === "worktree" && args[1] === "list") return { exitCode: 0, stdout: "", stderr: "" };
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") {
          return { exitCode: 0, stdout: "main\n", stderr: "" };
        }
        if (args[0] === "rev-parse" && args[1] === "--path-format=absolute" && args[2] === "--show-toplevel") {
          if (cwd === alphaPath && gateArmed) {
            gateArmed = false;
            reachedStatusProbe();
            await statusProbeGate;
          }
          return { exitCode: 0, stdout: `${cwd}\n`, stderr: "" };
        }
        if (args[0] === "rev-parse" && args[1] === "--verify") return { exitCode: 1, stdout: "", stderr: "" };
        if (args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" };
        if (args[0] === "rev-list" && args[1] === "--left-right") return { exitCode: 0, stdout: "0\t0\n", stderr: "" };
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args.includes("@{upstream}")) {
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        if (args[0] === "rev-parse" && args[1] === "--path-format=absolute" && args[2] === "--git-dir") {
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        throw new Error(`Unexpected git call: ${args.join(" ")}`);
      });

      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-list-cache-epoch",
        defaultBaseRef: "main",
        worktreesDir: path.join(repoRoot, "worktrees"),
      });

      const firstList = service.list({ includeStatus: true });
      await statusProbeReached;

      // What `delete` does to the database, minus the worktree teardown: drop
      // the lane row, then invalidate.
      db.run("delete from lanes where id = ?", ["lane-alpha"]);
      service.invalidateListCache();

      releaseStatusProbe();
      const before = await firstList;
      // Sanity: the parked build really did read its rows before the delete, so
      // the window this test is about actually opened.
      expect(before.map((lane) => lane.id)).toContain("lane-alpha");

      const after = await service.list({ includeStatus: true });
      expect(after.map((lane) => lane.id)).not.toContain("lane-alpha");
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("laneService worktree reconcile", () => {
  const INSERT_LANE = `
    insert into lanes(
      id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
      attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const NOW = "2026-08-01T12:00:00.000Z";

  beforeEach(() => {
    vi.mocked(getHeadSha).mockReset();
    vi.mocked(runGit).mockReset();
    vi.mocked(runGitOrThrow).mockReset();
  });

  async function makeProject(projectId: string, prefix: string) {
    // Resolved, because that is the only kind of path real git ever reports and
    // these fixtures stand in for its output. `os.tmpdir()` is itself a symlink
    // on macOS, so without this the fixtures would sit in a path space git
    // never produces.
    const repoRoot = makeTempRepoRoot(prefix);
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      [projectId, repoRoot, "demo", "main", NOW, NOW],
    );
    db.run(INSERT_LANE, ["lane-main", projectId, "Main", null, "primary", "main", "main", repoRoot, null, 1, null, null, null, null, "active", NOW, null]);
    return { db, repoRoot, worktreesDir: path.join(repoRoot, ".ade", "worktrees") };
  }

  function porcelain(entries: Array<{ path: string; branch?: string; bare?: boolean; prunable?: string }>): string {
    return entries
      .map((entry) =>
        [
          `worktree ${entry.path}`,
          "HEAD 1111111",
          ...(entry.bare ? ["bare"] : []),
          ...(entry.branch ? [`branch refs/heads/${entry.branch}`] : []),
          ...(entry.prunable ? [`prunable ${entry.prunable}`] : []),
          "",
        ].join("\n"),
      )
      .join("\n");
  }

  /**
   * `git worktree list` plus the one-shot ownership probe are the only git calls
   * a statusless lane list needs. Real git answers both `--show-toplevel` and
   * `--git-common-dir` with symlinks resolved no matter which spelling of the
   * cwd it was handed, so the stub resolves `opts.cwd` the same way.
   * `commonDir` defaults to the project's own `.git`: a root checkout, which
   * owns every worktree of the repository. Pass a directory outside the project
   * root to model a project whose root is itself a linked worktree.
   */
  function stubGit(listWorktrees: () => string | Error, commonDir?: string) {
    const resolvedCwd = (cwd: unknown) => {
      const raw = String(cwd ?? "");
      try {
        return fs.realpathSync(raw);
      } catch {
        return raw;
      }
    };
    vi.mocked(runGit).mockImplementation(async (args: string[], opts?: { cwd?: string }) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") {
        return { exitCode: 0, stdout: "main\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--path-format=absolute") {
        const topLevel = resolvedCwd(opts?.cwd);
        const resolvedCommonDir = commonDir ?? path.join(topLevel, ".git");
        const lines = args.slice(2).map((flag) => (flag === "--show-toplevel" ? topLevel : resolvedCommonDir));
        if (!lines.length) throw new Error(`Unexpected git call: ${args.join(" ")}`);
        return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });
    vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") {
        const result = listWorktrees();
        if (result instanceof Error) throw result;
        return result as any;
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });
  }

  it("adopts every git worktree as a lane, wherever it lives, and skips prunable ones", async () => {
    const { db, repoRoot, worktreesDir } = await makeProject("proj-adopt-all", "ade-lane-adopt-all-");
    const externalPath = path.resolve(path.join(repoRoot, "..", "external-checkout"));
    const managedPath = path.join(worktreesDir, "managed-1234abcd");
    const prunablePath = path.resolve(path.join(repoRoot, "..", "already-gone"));
    try {
      stubGit(() =>
        porcelain([
          { path: repoRoot, branch: "main" },
          { path: externalPath, branch: "feature/external" },
          { path: managedPath, branch: "ade/managed-1234abcd" },
          { path: prunablePath, branch: "feature/gone", prunable: "gitdir file points to non-existent location" },
        ]),
      );

      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-adopt-all",
        defaultBaseRef: "main",
        worktreesDir,
      });

      const lanes = await service.list({ includeStatus: false });

      expect(lanes.find((lane) => lane.branchRef === "feature/external")).toMatchObject({
        laneType: "worktree",
        baseRef: "main",
        worktreePath: externalPath,
      });
      expect(lanes.find((lane) => lane.branchRef === "ade/managed-1234abcd")).toMatchObject({
        laneType: "worktree",
        worktreePath: managedPath,
      });
      // Prunable worktrees are already half-gone; adopting one would resurrect
      // a lane that the next `git worktree prune` deletes.
      expect(lanes.some((lane) => lane.branchRef === "feature/gone")).toBe(false);
      // The repository root stays the primary lane and is never adopted twice.
      expect(lanes.filter((lane) => lane.worktreePath === repoRoot)).toHaveLength(1);
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  // A project can be rooted at a linked worktree — WorktreeOpenDialog's "Open as
  // a separate project instead", plus grandfathered projects. `git worktree list`
  // run from there reports the whole repository, so an unscoped adopt would give
  // this project lane rows for the main checkout and every sibling project's
  // worktree — and a lane row is what the delete rails check before removing a
  // folder.
  it("adopts nothing outside its own .ade/worktrees when the project root is itself a linked worktree", async () => {
    const { db, repoRoot, worktreesDir } = await makeProject("proj-linked-root", "ade-lane-linked-root-");
    const mainCheckout = path.resolve(path.join(repoRoot, "..", "main-checkout"));
    const siblingProject = path.resolve(path.join(repoRoot, "..", "sibling-project"));
    const ownManagedPath = path.join(worktreesDir, "own-1234abcd");
    try {
      stubGit(
        () =>
          porcelain([
            { path: mainCheckout, branch: "main" },
            { path: repoRoot, branch: "feature/this-project" },
            { path: siblingProject, branch: "feature/sibling" },
            { path: ownManagedPath, branch: "ade/own-1234abcd" },
          ]),
        path.join(mainCheckout, ".git"),
      );

      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-linked-root",
        defaultBaseRef: "main",
        worktreesDir,
      });

      const lanes = await service.list({ includeStatus: false });

      expect(lanes.find((lane) => lane.branchRef === "ade/own-1234abcd")).toMatchObject({
        laneType: "worktree",
        worktreePath: ownManagedPath,
      });
      expect(lanes.some((lane) => lane.worktreePath === mainCheckout)).toBe(false);
      expect(lanes.some((lane) => lane.worktreePath === siblingProject)).toBe(false);
      expect(lanes.some((lane) => lane.branchRef === "feature/sibling")).toBe(false);
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  // The mirror image: the repo-wide listing does not speak for paths this
  // project does not own, so it must not be used to declare their rows vanished.
  it("does not reap a lane whose worktree lies outside its own .ade/worktrees when rooted at a linked worktree", async () => {
    const { db, repoRoot, worktreesDir } = await makeProject("proj-linked-reap", "ade-lane-linked-reap-");
    const mainCheckout = path.resolve(path.join(repoRoot, "..", "main-checkout"));
    const foreignPath = path.resolve(path.join(repoRoot, "..", "someone-elses-worktree"));
    const ownGonePath = path.join(worktreesDir, "own-gone-aaaabbbb");
    try {
      db.run(INSERT_LANE, ["lane-foreign", "proj-linked-reap", "Foreign", null, "worktree", "main", "ade/foreign", foreignPath, null, 0, null, null, null, null, "active", NOW, null]);
      db.run(INSERT_LANE, ["lane-own-gone", "proj-linked-reap", "Own gone", null, "worktree", "main", "ade/own-gone", ownGonePath, null, 0, null, null, null, null, "active", NOW, null]);
      stubGit(
        () => porcelain([{ path: mainCheckout, branch: "main" }, { path: repoRoot, branch: "feature/this-project" }]),
        path.join(mainCheckout, ".git"),
      );

      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-linked-reap",
        defaultBaseRef: "main",
        worktreesDir,
      });

      const lanes = await service.list({ includeStatus: false });

      expect(lanes.some((lane) => lane.id === "lane-foreign")).toBe(true);
      expect(db.get("select id from lanes where id = ?", ["lane-foreign"])).toMatchObject({ id: "lane-foreign" });
      // A lane this project does own is still reaped normally.
      expect(lanes.some((lane) => lane.id === "lane-own-gone")).toBe(false);
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  // git answers every path question with symlinks already resolved, while ADE
  // holds whatever the user picked — routinely a symlinked parent such as
  // `~/Projects` pointing at an external volume. Comparing the two spellings
  // directly made the ownership probe read the repo's own checkout as foreign,
  // scoping the project down to `managed-only` and then failing even that test,
  // so adoption and reaping both went silently dead for the whole project.
  it("adopts and reaps through a symlinked project root", async () => {
    const projectId = "proj-symlink-root";
    const realBase = makeTempRepoRoot("ade-lane-symlink-real-");
    const linkHome = makeTempRepoRoot("ade-lane-symlink-link-");
    const linkBase = path.join(linkHome, "projects");
    fs.symlinkSync(realBase, linkBase, "dir");

    const realRoot = path.join(realBase, "repo");
    // Every path ADE is configured with goes through the symlink.
    const linkRoot = path.join(linkBase, "repo");
    const linkWorktreesDir = path.join(linkRoot, ".ade", "worktrees");
    const realManaged = path.join(realRoot, ".ade", "worktrees", "adopted-1234abcd");
    const realExternal = path.join(realBase, "external-checkout");
    // A lane row written before the fix, spelled through the symlink, whose
    // folder is gone from both git and disk.
    const linkGone = path.join(linkWorktreesDir, "gone-aaaabbbb");

    fs.mkdirSync(realManaged, { recursive: true });
    fs.mkdirSync(realExternal, { recursive: true });

    const db = await openKvDb(path.join(realRoot, "kv.sqlite"), createLogger());
    try {
      db.run(
        "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
        [projectId, linkRoot, "demo", "main", NOW, NOW],
      );
      db.run(INSERT_LANE, ["lane-main", projectId, "Main", null, "primary", "main", "main", linkRoot, null, 1, null, null, null, null, "active", NOW, null]);
      db.run(INSERT_LANE, ["lane-gone", projectId, "Gone", null, "worktree", "main", "ade/gone", linkGone, null, 0, null, null, null, null, "active", NOW, null]);

      stubGit(() =>
        porcelain([
          { path: realRoot, branch: "main" },
          { path: realManaged, branch: "ade/adopted-1234abcd" },
          { path: realExternal, branch: "feature/external" },
        ]),
      );

      const service = createLaneService({
        db,
        projectRoot: linkRoot,
        projectId,
        defaultBaseRef: "main",
        worktreesDir: linkWorktreesDir,
      });

      const lanes = await service.list({ includeStatus: false });

      // `repository` scope, so a worktree outside `.ade/worktrees` is adopted too.
      expect(lanes.find((lane) => lane.branchRef === "ade/adopted-1234abcd")).toMatchObject({
        laneType: "worktree",
        worktreePath: realManaged,
      });
      expect(lanes.find((lane) => lane.branchRef === "feature/external")).toMatchObject({
        laneType: "worktree",
        worktreePath: realExternal,
      });
      expect(lanes.some((lane) => lane.id === "lane-gone")).toBe(false);
      expect(db.get("select id from lanes where id = ?", ["lane-gone"])).toBeNull();
      // The repository's own checkout stays the single primary lane under both
      // of its spellings — resolving paths must not stop excluding it.
      expect(lanes.filter((lane) => lane.worktreePath === realRoot || lane.worktreePath === linkRoot)).toHaveLength(1);
      expect(lanes.filter((lane) => lane.laneType === "primary")).toHaveLength(1);
    } finally {
      db.close();
      fs.rmSync(linkHome, { recursive: true, force: true });
      fs.rmSync(realBase, { recursive: true, force: true });
    }
  });

  it("removes a lane whose worktree is gone from both git and disk, purging its sessions", async () => {
    const { db, repoRoot, worktreesDir } = await makeProject("proj-reap", "ade-lane-reap-");
    const gonePath = path.join(worktreesDir, "gone-aaaabbbb");
    const lifecycleEvents: any[] = [];
    try {
      db.run(INSERT_LANE, ["lane-gone", "proj-reap", "Gone", null, "worktree", "main", "ade/gone", gonePath, null, 0, null, null, null, null, "active", NOW, null]);
      db.run(
        "insert into claude_sessions(session_id, lane_id, title, created_at, updated_at) values (?, ?, ?, ?, ?)",
        ["chat-gone", "lane-gone", "Chat in the removed lane", NOW, NOW],
      );
      db.run(
        "insert into terminal_sessions(id, lane_id, title, status, started_at, transcript_path) values (?, ?, ?, 'exited', ?, ?)",
        ["pty-gone", "lane-gone", "Terminal in the removed lane", NOW, "/tmp/gone.log"],
      );
      stubGit(() => porcelain([{ path: repoRoot, branch: "main" }]));

      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-reap",
        defaultBaseRef: "main",
        worktreesDir,
        onLifecycleEvent: (event) => lifecycleEvents.push(event),
      });

      const lanes = await service.list({ includeStatus: false });

      expect(lanes.some((lane) => lane.id === "lane-gone")).toBe(false);
      expect(db.get("select id from lanes where id = ?", ["lane-gone"])).toBeNull();
      expect(db.get("select session_id from claude_sessions where session_id = ?", ["chat-gone"])).toBeNull();
      expect(db.get("select id from terminal_sessions where id = ?", ["pty-gone"])).toBeNull();
      expect(lifecycleEvents).toContainEqual(
        expect.objectContaining({ type: "lane-deleted", laneId: "lane-gone" }),
      );
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  // The reap deletes the same rows a user-initiated delete does, so it owes the
  // same file cleanup: without it every proof file the lane wrote is orphaned on
  // disk with no row left pointing at it.
  it("removes the reaped lane's proof files along with its rows", async () => {
    const { db, repoRoot, worktreesDir } = await makeProject("proj-reap-proof", "ade-lane-reap-proof-");
    const gonePath = path.join(worktreesDir, "gone-proof-aaaabbbb");
    const artifactsDir = path.join(repoRoot, ".ade", "artifacts", "computer-use");
    const proofFile = path.join(artifactsDir, "reaped.png");
    try {
      db.run(INSERT_LANE, ["lane-gone", "proj-reap-proof", "Gone", null, "worktree", "main", "ade/gone", gonePath, null, 0, null, null, null, null, "active", NOW, null]);
      fs.mkdirSync(artifactsDir, { recursive: true });
      fs.writeFileSync(proofFile, "reaped");
      db.run(
        `insert into computer_use_artifacts(
           id, project_id, artifact_kind, backend_style, backend_name, source_tool_name,
           original_type, title, description, uri, storage_kind, mime_type, metadata_json,
           lane_id, created_at
         ) values (?, 'proj-reap-proof', 'screenshot', 'manual', 'ade-cli', null, null, ?, null, ?, 'file', null, '{}', 'lane-gone', ?)`,
        ["reaped", "reaped", ".ade/artifacts/computer-use/reaped.png", NOW],
      );
      stubGit(() => porcelain([{ path: repoRoot, branch: "main" }]));

      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-reap-proof",
        defaultBaseRef: "main",
        worktreesDir,
      });

      await service.list({ includeStatus: false });

      expect(db.get("select id from lanes where id = ?", ["lane-gone"])).toBeNull();
      expect(db.get("select id from computer_use_artifacts where id = ?", ["reaped"])).toBeNull();
      expect(fs.existsSync(proofFile)).toBe(false);
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("keeps a lane when only one of the two signals says the worktree is gone", async () => {
    const { db, repoRoot, worktreesDir } = await makeProject("proj-reap-partial", "ade-lane-reap-partial-");
    const onDiskPath = path.join(worktreesDir, "on-disk-aaaabbbb");
    const registeredPath = path.join(worktreesDir, "registered-ccccdddd");
    try {
      // Directory still on disk, but git no longer registers it.
      fs.mkdirSync(onDiskPath, { recursive: true });
      db.run(INSERT_LANE, ["lane-on-disk", "proj-reap-partial", "On disk", null, "worktree", "main", "ade/on-disk", onDiskPath, null, 0, null, null, null, null, "active", NOW, null]);
      // Registered by git (as prunable), but the directory is gone.
      db.run(INSERT_LANE, ["lane-registered", "proj-reap-partial", "Registered", null, "worktree", "main", "ade/registered", registeredPath, null, 0, null, null, null, null, "active", NOW, null]);
      stubGit(() =>
        porcelain([
          { path: repoRoot, branch: "main" },
          { path: registeredPath, branch: "ade/registered", prunable: "gitdir file points to non-existent location" },
        ]),
      );

      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-reap-partial",
        defaultBaseRef: "main",
        worktreesDir,
      });

      const lanes = await service.list({ includeStatus: false });

      expect(lanes.map((lane) => lane.id)).toEqual(expect.arrayContaining(["lane-on-disk", "lane-registered"]));
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("never removes lanes when git worktree list fails", async () => {
    const { db, repoRoot, worktreesDir } = await makeProject("proj-reap-git-fail", "ade-lane-reap-git-fail-");
    try {
      db.run(INSERT_LANE, ["lane-a", "proj-reap-git-fail", "A", null, "worktree", "main", "ade/a", path.join(worktreesDir, "a-11112222"), null, 0, null, null, null, null, "active", NOW, null]);
      db.run(INSERT_LANE, ["lane-b", "proj-reap-git-fail", "B", null, "worktree", "main", "ade/b", path.join(worktreesDir, "b-33334444"), null, 0, null, null, null, null, "active", NOW, null]);
      stubGit(() => new Error("fatal: not a git repository"));

      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-reap-git-fail",
        defaultBaseRef: "main",
        worktreesDir,
      });

      const lanes = await service.list({ includeStatus: false });

      expect(lanes.map((lane) => lane.id).sort()).toEqual(["lane-a", "lane-b", "lane-main"]);
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("never removes an archived lane whose folder was reclaimed on purpose", async () => {
    const { db, repoRoot, worktreesDir } = await makeProject("proj-reap-archived", "ade-lane-reap-archived-");
    try {
      db.run(INSERT_LANE, [
        "lane-reclaimed", "proj-reap-archived", "Reclaimed", null, "worktree", "main", "ade/reclaimed",
        path.join(worktreesDir, "reclaimed-aaaabbbb"), null, 0, null, null, null, null, "archived", NOW, NOW,
      ]);
      stubGit(() => porcelain([{ path: repoRoot, branch: "main" }]));

      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-reap-archived",
        defaultBaseRef: "main",
        worktreesDir,
      });

      await service.list({ includeStatus: false });

      expect(db.get("select status from lanes where id = ?", ["lane-reclaimed"])).toMatchObject({ status: "archived" });
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("laneService delete outside .ade/worktrees", () => {
  const INSERT_LANE = `
    insert into lanes(
      id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
      attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const NOW = "2026-08-01T12:00:00.000Z";

  beforeEach(() => {
    vi.mocked(getHeadSha).mockReset();
    vi.mocked(runGit).mockReset();
    vi.mocked(runGitOrThrow).mockReset();
  });

  async function setup(opts: {
    projectId: string;
    prefix: string;
    laneType?: "worktree" | "attached";
    /** Where the lane's worktree lives; defaults to an external directory. */
    makeWorktreePath?: (repoRoot: string) => string;
    createDirectory?: boolean;
  }) {
    const repoRoot = makeTempRepoRoot(opts.prefix);
    const worktreesDir = path.join(repoRoot, ".ade", "worktrees");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      [opts.projectId, repoRoot, "demo", "main", NOW, NOW],
    );
    db.run(INSERT_LANE, ["lane-main", opts.projectId, "Main", null, "primary", "main", "main", repoRoot, null, 1, null, null, null, null, "active", NOW, null]);
    // A sibling of the repo, i.e. a worktree the user created outside ADE.
    const worktreePath = (opts.makeWorktreePath
      ?? ((root: string) => path.resolve(root, "..", `${path.basename(root)}-external`)))(repoRoot);
    if (opts.createDirectory !== false) fs.mkdirSync(worktreePath, { recursive: true });
    db.run(INSERT_LANE, [
      "lane-external", opts.projectId, "External", null, opts.laneType ?? "worktree", "main", "feature/external",
      worktreePath, opts.laneType === "attached" ? worktreePath : null, 0, null, null, null, null, "active", NOW, null,
    ]);
    const events: any[] = [];
    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: opts.projectId,
      defaultBaseRef: "main",
      worktreesDir,
      onDeleteEvent: (event) => events.push(event),
    });
    return { db, service, repoRoot, worktreesDir, worktreePath, events };
  }

  /** Clean worktree, `git worktree remove` behaves like the real thing. */
  function stubGitForDelete(args: {
    worktreePath: string;
    removeExitCode?: number;
    removeStderr?: string;
    topLevel?: string | null;
  }) {
    vi.mocked(runGit).mockImplementation(async (gitArgs: string[], opts?: { cwd?: string }) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(gitArgs);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--path-format=absolute" && gitArgs[2] === "--show-toplevel") {
        if (args.topLevel === null) return { exitCode: 128, stdout: "", stderr: "not a git repository" };
        return { exitCode: 0, stdout: `${args.topLevel ?? opts?.cwd ?? ""}\n`, stderr: "" };
      }
      if (gitArgs[0] === "status") return { exitCode: 0, stdout: "", stderr: "" };
      if (gitArgs[0] === "worktree" && gitArgs[1] === "remove") {
        const exitCode = args.removeExitCode ?? 0;
        if (exitCode === 0) fs.rmSync(args.worktreePath, { recursive: true, force: true });
        return { exitCode, stdout: "", stderr: args.removeStderr ?? "" };
      }
      if (gitArgs[0] === "worktree" && gitArgs[1] === "prune") return { exitCode: 0, stdout: "", stderr: "" };
      if (gitArgs[0] === "show-ref") return { exitCode: 1, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    vi.mocked(runGitOrThrow).mockImplementation(async (gitArgs: string[]) => {
      if (gitArgs[0] === "worktree" && gitArgs[1] === "list") return "" as any;
      return { exitCode: 0, stdout: "", stderr: "" } as any;
    });
  }

  it("really removes a worktree that lives outside .ade/worktrees", async () => {
    const { db, service, worktreePath, events } = await setup({
      projectId: "proj-delete-external",
      prefix: "ade-lane-delete-external-",
    });
    try {
      stubGitForDelete({ worktreePath });

      await service.delete({ laneId: "lane-external", deleteBranch: false });

      expect(fs.existsSync(worktreePath)).toBe(false);
      expect(db.get("select id from lanes where id = ?", ["lane-external"])).toBeNull();
      const last = events[events.length - 1];
      expect(last.progress.overallStatus).toBe("completed");
      expect(last.progress.steps.find((step: any) => step.name === "git_worktree_remove")?.status).toBe("completed");
    } finally {
      db.close();
    }
  });

  it("really removes the worktree of a legacy attached lane row", async () => {
    const { db, service, worktreePath, events } = await setup({
      projectId: "proj-delete-attached",
      prefix: "ade-lane-delete-attached-",
      laneType: "attached",
    });
    try {
      stubGitForDelete({ worktreePath });

      await service.delete({ laneId: "lane-external", deleteBranch: false });

      expect(fs.existsSync(worktreePath)).toBe(false);
      expect(db.get("select id from lanes where id = ?", ["lane-external"])).toBeNull();
      expect(events[events.length - 1].progress.steps.some((step: any) => step.name === "git_worktree_remove")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("refuses to remove an external lane folder reached through a symlink", async () => {
    const { db, service, repoRoot, worktreePath } = await setup({
      projectId: "proj-delete-symlink",
      prefix: "ade-lane-delete-symlink-",
      createDirectory: false,
    });
    const realDirectory = path.resolve(repoRoot, "..", `${path.basename(repoRoot)}-real-external`);
    try {
      fs.mkdirSync(realDirectory, { recursive: true });
      fs.writeFileSync(path.join(realDirectory, "work.txt"), "user work\n", "utf8");
      fs.symlinkSync(realDirectory, worktreePath, "dir");
      stubGitForDelete({ worktreePath });

      await expect(service.delete({ laneId: "lane-external", deleteBranch: false })).rejects.toThrow(
        "ADE will not remove a lane folder through a symbolic link.",
      );

      expect(fs.existsSync(path.join(realDirectory, "work.txt"))).toBe(true);
      expect(fs.existsSync(worktreePath)).toBe(true);
      expect(vi.mocked(runGit).mock.calls.some(([gitArgs]) => gitArgs[0] === "worktree" && gitArgs[1] === "remove")).toBe(false);
      expect(db.get("select id from lanes where id = ?", ["lane-external"])).toMatchObject({ id: "lane-external" });
    } finally {
      db.close();
      fs.rmSync(realDirectory, { recursive: true, force: true });
    }
  });

  it("refuses to delete an external folder that is not a git worktree root", async () => {
    const { db, service, worktreePath } = await setup({
      projectId: "proj-delete-unverified",
      prefix: "ade-lane-delete-unverified-",
    });
    try {
      fs.writeFileSync(path.join(worktreePath, "work.txt"), "user work\n", "utf8");
      stubGitForDelete({ worktreePath, topLevel: null });

      await expect(service.delete({ laneId: "lane-external", deleteBranch: false })).rejects.toThrow(
        /no longer points at its Git worktree root/i,
      );

      expect(fs.existsSync(path.join(worktreePath, "work.txt"))).toBe(true);
      expect(db.get("select id from lanes where id = ?", ["lane-external"])).toMatchObject({ id: "lane-external" });
    } finally {
      db.close();
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it("surfaces a failed git worktree remove instead of deleting an external folder itself", async () => {
    const { db, service, worktreePath } = await setup({
      projectId: "proj-delete-git-failure",
      prefix: "ade-lane-delete-git-failure-",
    });
    try {
      fs.writeFileSync(path.join(worktreePath, "work.txt"), "user work\n", "utf8");
      stubGitForDelete({
        worktreePath,
        removeExitCode: 128,
        removeStderr: "fatal: validation failed, cannot remove working tree",
      });

      await expect(service.delete({ laneId: "lane-external", deleteBranch: false })).rejects.toThrow(
        /cannot remove working tree/i,
      );

      expect(fs.existsSync(path.join(worktreePath, "work.txt"))).toBe(true);
      expect(db.get("select id from lanes where id = ?", ["lane-external"])).toMatchObject({ id: "lane-external" });
      expect(
        db.get(
          "select worktree_path from local_worktree_residual_cleanups where project_id = ? and worktree_path = ?",
          ["proj-delete-git-failure", worktreePath],
        ),
      ).toBeNull();
    } finally {
      db.close();
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  });
});

// A lane row adopted from `git worktree list` holds the resolved spelling of its
// folder, while ADE is configured with whatever the user picked — routinely a
// symlinked parent. Every guard that decides "is this ADE's own worktree folder"
// has to accept both spellings, or ADE stops recognising the worktrees it made.
describe("laneService symlinked project root path space", () => {
  const INSERT_LANE = `
    insert into lanes(
      id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
      attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const NOW = "2026-08-01T12:00:00.000Z";

  beforeEach(() => {
    vi.mocked(getHeadSha).mockReset();
    vi.mocked(runGit).mockReset();
    vi.mocked(runGitOrThrow).mockReset();
  });

  /** Project configured through `linkBase -> realBase`, exactly as a user's `~/Projects` symlink. */
  async function makeSymlinkedProject(projectId: string, prefix: string) {
    const realBase = makeTempRepoRoot(`${prefix}real-`);
    const linkHome = makeTempRepoRoot(`${prefix}link-`);
    const linkBase = path.join(linkHome, "projects");
    fs.symlinkSync(realBase, linkBase, "dir");

    const realRoot = path.join(realBase, "repo");
    const linkRoot = path.join(linkBase, "repo");
    fs.mkdirSync(path.join(realRoot, ".ade", "worktrees"), { recursive: true });

    const db = await openKvDb(path.join(realRoot, "kv.sqlite"), createLogger());
    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      [projectId, linkRoot, "demo", "main", NOW, NOW],
    );
    db.run(INSERT_LANE, ["lane-main", projectId, "Main", null, "primary", "main", "main", linkRoot, null, 1, null, null, null, null, "active", NOW, null]);
    return {
      db,
      realBase,
      linkHome,
      realRoot,
      linkRoot,
      // What ADE is configured with, versus what git reports.
      linkWorktreesDir: path.join(linkRoot, ".ade", "worktrees"),
      realWorktreesDir: path.join(realRoot, ".ade", "worktrees"),
      cleanup: () => {
        db.close();
        fs.rmSync(linkHome, { recursive: true, force: true });
        fs.rmSync(realBase, { recursive: true, force: true });
      },
    };
  }

  it("recovers a managed worktree spelled the way git reports it, and still refuses one outside the folder", async () => {
    const projectId = "proj-symlink-delete";
    const fixture = await makeSymlinkedProject(projectId, "ade-lane-symlink-delete-");
    const managedPath = path.join(fixture.realWorktreesDir, "managed-1234abcd");
    const externalPath = path.join(fixture.realBase, "external-checkout");
    try {
      for (const dir of [managedPath, externalPath]) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "work.txt"), "work\n", "utf8");
      }
      fixture.db.run(INSERT_LANE, ["lane-managed", projectId, "Managed", null, "worktree", "main", "ade/managed", managedPath, null, 0, null, null, null, null, "active", NOW, null]);
      fixture.db.run(INSERT_LANE, ["lane-external", projectId, "External", null, "worktree", "main", "feature/external", externalPath, null, 0, null, null, null, null, "active", NOW, null]);
      // `git worktree remove` fails the way a half-deleted worktree makes it
      // fail — the stale state the filesystem fallback exists for.
      vi.mocked(runGit).mockImplementation(async (gitArgs: string[], opts?: { cwd?: string }) => {
        const laneBranchGitStub = defaultLaneBranchGitStub(gitArgs);
        if (laneBranchGitStub) return laneBranchGitStub;
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--path-format=absolute") {
          // Real git resolves symlinks whichever spelling of the cwd it is handed.
          let topLevel = String(opts?.cwd ?? "");
          try {
            topLevel = fs.realpathSync(topLevel);
          } catch {
            // A cwd that no longer exists answers with itself.
          }
          const lines = gitArgs.slice(2).map((flag) =>
            (flag === "--show-toplevel" ? topLevel : path.join(fixture.realRoot, ".git")));
          return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
        }
        if (gitArgs[0] === "worktree" && gitArgs[1] === "remove") {
          return { exitCode: 128, stdout: "", stderr: "fatal: validation failed, cannot remove working tree" };
        }
        if (gitArgs[0] === "show-ref") return { exitCode: 1, stdout: "", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      });
      vi.mocked(runGitOrThrow).mockImplementation(async (gitArgs: string[]) => {
        if (gitArgs[0] === "worktree" && gitArgs[1] === "list") return "" as any;
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      });

      const service = createLaneService({
        db: fixture.db,
        projectRoot: fixture.linkRoot,
        projectId,
        defaultBaseRef: "main",
        worktreesDir: fixture.linkWorktreesDir,
      });

      await service.delete({ laneId: "lane-managed", deleteBranch: false });

      // ADE's own folder, so the stale-state failure escalates to a real removal.
      expect(fs.existsSync(managedPath)).toBe(false);
      expect(fixture.db.get("select id from lanes where id = ?", ["lane-managed"])).toBeNull();

      // A sibling of the project root is not ADE's to delete, under either spelling.
      await expect(service.delete({ laneId: "lane-external", deleteBranch: false })).rejects.toThrow(
        /cannot remove working tree/i,
      );
      expect(fs.existsSync(path.join(externalPath, "work.txt"))).toBe(true);
      expect(fixture.db.get("select id from lanes where id = ?", ["lane-external"])).toMatchObject({ id: "lane-external" });
      expect(
        fixture.db.get(
          "select worktree_path from local_worktree_residual_cleanups where project_id = ? and worktree_path = ?",
          [projectId, externalPath],
        ),
      ).toBeNull();
    } finally {
      fixture.cleanup();
    }
  });

  // The residual sweep walks the configured spelling of `.ade/worktrees` while
  // the "leave this alone" sets are built from git and from lane rows, which
  // hold the resolved one. A live worktree that reads as unclaimed is one empty
  // moment away from being swept as an unknown residual.
  it("does not sweep a live worktree whose lane row spells it the way git does", async () => {
    const projectId = "proj-symlink-sweep";
    const fixture = await makeSymlinkedProject(projectId, "ade-lane-symlink-sweep-");
    const savedPath = path.join(fixture.realWorktreesDir, "live-1234abcd");
    try {
      // Empty and old enough to look like an abandoned residual to the sweep.
      fs.mkdirSync(savedPath, { recursive: true });
      const longAgo = new Date(Date.now() - 60 * 60_000);
      fs.utimesSync(savedPath, longAgo, longAgo);
      fixture.db.run(INSERT_LANE, ["lane-live", projectId, "Live", null, "worktree", "main", "ade/live", savedPath, null, 0, null, null, null, null, "active", NOW, null]);

      vi.mocked(runGit).mockImplementation(async (gitArgs: string[], opts?: { cwd?: string }) => {
        const laneBranchGitStub = defaultLaneBranchGitStub(gitArgs);
        if (laneBranchGitStub) return laneBranchGitStub;
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--path-format=absolute") {
          let topLevel = String(opts?.cwd ?? "");
          try {
            topLevel = fs.realpathSync(topLevel);
          } catch {
            // A cwd that no longer exists answers with itself.
          }
          const lines = gitArgs.slice(2).map((flag) =>
            (flag === "--show-toplevel" ? topLevel : path.join(fixture.realRoot, ".git")));
          return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });
      vi.mocked(runGitOrThrow).mockImplementation(async (gitArgs: string[]) => {
        // Registered by the lane row alone, so the row's spelling is the only
        // thing standing between this folder and the sweep.
        if (gitArgs[0] === "worktree" && gitArgs[1] === "list") {
          return `worktree ${fixture.realRoot}\nHEAD 1111111\nbranch refs/heads/main\n\n` as any;
        }
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      });

      const service = createLaneService({
        db: fixture.db,
        projectRoot: fixture.linkRoot,
        projectId,
        defaultBaseRef: "main",
        worktreesDir: fixture.linkWorktreesDir,
      });

      await service.list({ includeStatus: false });

      expect(fs.existsSync(savedPath)).toBe(true);
      expect(fixture.db.get("select id from lanes where id = ?", ["lane-live"])).toMatchObject({ id: "lane-live" });
    } finally {
      fixture.cleanup();
    }
  });

  it("restores an archived lane at its saved path instead of relocating it to a fresh one", async () => {
    const projectId = "proj-symlink-restore";
    const fixture = await makeSymlinkedProject(projectId, "ade-lane-symlink-restore-");
    // Adopted from git, so the row holds the resolved spelling; the folder is
    // gone, which is the only case that can relocate the worktree.
    const savedPath = path.join(fixture.realWorktreesDir, "archived-1234abcd");
    const addedPaths: string[] = [];
    try {
      fixture.db.run(INSERT_LANE, ["lane-archived", projectId, "Archived", null, "worktree", "main", "ade/archived", savedPath, null, 0, null, null, null, null, "archived", NOW, NOW]);

      vi.mocked(runGit).mockImplementation(async (gitArgs: string[]) => {
        const laneBranchGitStub = defaultLaneBranchGitStub(gitArgs);
        if (laneBranchGitStub) return laneBranchGitStub;
        if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--path-format=absolute") {
          const lines = gitArgs.slice(2).map((flag) =>
            flag === "--show-toplevel" ? fixture.realRoot : path.join(fixture.realRoot, ".git"));
          return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });
      vi.mocked(runGitOrThrow).mockImplementation(async (gitArgs: string[]) => {
        if (gitArgs[0] === "worktree" && gitArgs[1] === "add") {
          // `ade/*` branches only exist on origin in these fixtures, so restore
          // takes the `worktree add -b <branch> <path> origin/<branch>` form.
          const target = (gitArgs[2] === "-b" ? gitArgs[4] : gitArgs[2]) ?? "";
          addedPaths.push(target);
          fs.mkdirSync(target, { recursive: true });
          return { exitCode: 0, stdout: "", stderr: "" } as any;
        }
        if (gitArgs[0] === "worktree" && gitArgs[1] === "list") {
          return `worktree ${fixture.realRoot}\nHEAD 1111111\nbranch refs/heads/main\n\n` as any;
        }
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      });

      const service = createLaneService({
        db: fixture.db,
        projectRoot: fixture.linkRoot,
        projectId,
        defaultBaseRef: "main",
        worktreesDir: fixture.linkWorktreesDir,
      });

      const result = await service.unarchive({ laneId: "lane-archived" });

      expect(result.worktreeRecreated).toBe(true);
      expect(addedPaths).toEqual([savedPath]);
      expect(fixture.db.get<{ worktree_path: string }>(
        "select worktree_path from lanes where id = ?",
        ["lane-archived"],
      )?.worktree_path).toBe(savedPath);
    } finally {
      fixture.cleanup();
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-list-managed-orphan-");
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-import-upstream-");
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
      if (args[0] === "status" && String(args[1]).startsWith("--porcelain")) {
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-import-duplicate-");
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-import-managed-orphan-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-import-managed-orphan", repoRoot });
    const worktreesDir = path.join(repoRoot, ".ade", "worktrees");
    const orphanPath = path.join(worktreesDir, "dashboard-f6949524");

    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      if (args[0] === "show-ref" && args[1] === "--verify" && args[3] === "refs/heads/ade/dashboard-f6949524") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      // Ownership probe: this project root is the repository's own checkout.
      if (args[0] === "rev-parse" && args[1] === "--path-format=absolute" && args[2] === "--git-common-dir") {
        return { exitCode: 0, stdout: `${path.join(repoRoot, ".git")}\n`, stderr: "" };
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

  it("adopts a worktree checked out outside .ade/worktrees instead of importing its branch again", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-service-import-external-orphan-");
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
      // Ownership probe: this project root is the repository's own checkout, so
      // adoption reaches worktrees outside `.ade/worktrees` such as this one.
      if (args[0] === "rev-parse" && args[1] === "--path-format=absolute" && args[2] === "--git-common-dir") {
        return { exitCode: 0, stdout: `${path.join(repoRoot, ".git")}\n`, stderr: "" };
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
      "Lane already exists for branch 'feature/taken'",
    );
    expect(
      db.get<{ branch_ref: string; worktree_path: string; lane_type: string; status: string }>(
        "select branch_ref, worktree_path, lane_type, status from lanes where project_id = ? and branch_ref = ?",
        ["proj-import-external-orphan", "feature/taken"],
      ),
    ).toMatchObject({
      branch_ref: "feature/taken",
      worktree_path: path.resolve(externalPath),
      lane_type: "worktree",
      status: "active",
    });
    expect(vi.mocked(runGitOrThrow).mock.calls.some(([args]) => args[0] === "worktree" && args[1] === "add")).toBe(false);
  });

  it("reuses an existing local branch when importing a remote-qualified ref", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-service-import-local-existing-");
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
      if (args[0] === "status" && String(args[1]).startsWith("--porcelain")) {
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

  it("absorbs raced recovered rows while importing a branch", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-service-import-race-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const projectId = "proj-import-race";
    const racedLaneId = "raced-import-row";
    const now = "2026-03-11T12:05:00.000Z";
    await seedProjectAndStack(db, { projectId, repoRoot });

    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "show-ref" && args[1] === "--verify" && args[3] === "refs/heads/feature/import-race") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "status" && String(args[1]).startsWith("--porcelain")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "rev-list" && args[1] === "--left-right" && args[2] === "--count") {
        return { exitCode: 0, stdout: "0\t0\n", stderr: "" };
      }
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "--symbolic-full-name" && args[3] === "@{upstream}") {
        return { exitCode: 0, stdout: "origin/feature/import-race\n", stderr: "" };
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
      if (args[0] === "worktree" && args[1] === "list") {
        return [`worktree ${repoRoot}`, "HEAD 1111111", "branch refs/heads/main", ""].join("\n") as any;
      }
      if (args[0] === "worktree" && args[1] === "add") {
        const worktreePath = args[2];
        const branchRef = args[3];
        db.run(
          `
            insert into lanes(
              id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
              attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [racedLaneId, projectId, "Recovered import race", null, "worktree", "main", branchRef, worktreePath, null, 0, null, null, null, null, "active", now, null],
        );
        db.run(
          `
            insert into terminal_sessions(id, lane_id, title, started_at, transcript_path, status)
            values (?, ?, ?, ?, ?, ?)
          `,
          ["session-on-import-race", racedLaneId, "shell", now, "/tmp/transcript.jsonl", "running"],
        );
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId,
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    const result = await service.importBranch({ branchRef: "feature/import-race", name: "Imported race" });

    const worktreeRows = db.all<{ id: string }>(
      "select id from lanes where project_id = ? and lane_type = 'worktree' and branch_ref = ?",
      [projectId, "feature/import-race"],
    );
    expect(worktreeRows.map((row) => row.id)).toEqual([result.id]);
    expect(result.id).not.toBe(racedLaneId);
    expect(
      db.get<{ lane_id: string }>("select lane_id from terminal_sessions where id = ?", ["session-on-import-race"])?.lane_id,
    ).toBe(result.id);
  });

  it("removes a created tracking branch when worktree setup fails during import", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-service-import-cleanup-");
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-skip-");
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-root-base-");
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
      if (args[0] === "status" && String(args[1]).startsWith("--porcelain")) {
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-root-override-");
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
      if (args[0] === "status" && String(args[1]).startsWith("--porcelain")) {
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-overlap-");
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
      if (args[0] === "status" && String(args[1]).startsWith("--porcelain")) {
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-root-override-");
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
      if (args[0] === "status" && String(args[1]).startsWith("--porcelain")) {
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-primary-remote-");
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
      if (args[0] === "status" && String(args[1]).startsWith("--porcelain")) {
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-origin-fallback-");
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
      if (args[0] === "status" && String(args[1]).startsWith("--porcelain")) {
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-all-remote-fail-");
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-worktree-parent-");
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
      if (args[0] === "status" && String(args[1]).startsWith("--porcelain")) {
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-unresolvable-");
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-skip-label-");
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-dirty-");
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
      if (args[0] === "status" && String(args[1]).startsWith("--porcelain")) {
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-dedup-");
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-reparent-primary-");
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-reparent-stack-base-");
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-reparent-rollback-");
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-reparent-noop-");
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-child-deps-");
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
      if (args[0] === "status" && String(args[1]).startsWith("--porcelain")) return { exitCode: 0, stdout: "", stderr: "" };
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-child-primary-default-base-");
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
        if (args[0] === "status" && String(args[1]).startsWith("--porcelain")) {
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
    const repoRoot = makeTempRepoRoot("ade-lane-service-child-base-override-");
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
      if (args[0] === "status" && String(args[1]).startsWith("--porcelain")) {
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
    const repoRoot = makeTempRepoRoot("ade-lane-color-uniqueness-");
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

  it("keeps the primary lane on its reserved color during appearance updates", async () => {
    const { db, service } = await setup();
    db.run(
      "update lanes set lane_type = 'primary', color = ? where id = ?",
      ["#a78bfa", "lane-parent"],
    );

    service.updateAppearance({ laneId: "lane-parent", color: "#60a5fa", icon: "star" });

    const primary = db.get<{ color: string | null; icon: string | null }>(
      "select color, icon from lanes where id = ?",
      ["lane-parent"],
    );
    expect(primary).toEqual({ color: "#a78bfa", icon: "star" });
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

describe("laneService stale worktree status", () => {
  beforeEach(() => {
    vi.mocked(getHeadSha).mockReset();
    vi.mocked(runGit).mockReset();
    vi.mocked(runGitOrThrow).mockReset();
  });

  it("does not report main checkout status for a stale lane directory inside the repo", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-stale-status-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-stale-status", repoRoot });
    const childPath = path.join(repoRoot, "child");
    fs.mkdirSync(childPath, { recursive: true });

    vi.mocked(runGit).mockImplementation(async (args: string[], opts?: { cwd?: string }) => {
      if (args[0] === "rev-parse" && args[1] === "--path-format=absolute" && args[2] === "--show-toplevel") {
        expect(opts?.cwd).toBe(childPath);
        return { exitCode: 0, stdout: `${repoRoot}\n`, stderr: "" } as any;
      }
      if (args[0] === "status") return { exitCode: 0, stdout: " M main-only-file\n", stderr: "" } as any;
      if (args[0] === "rev-list") return { exitCode: 0, stdout: "0\t5\n", stderr: "" } as any;
      return { exitCode: 1, stdout: "", stderr: "" } as any;
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-stale-status",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    const lanes = await service.list({ includeStatus: true });
    const child = lanes.find((lane) => lane.id === "lane-child");
    expect(child?.status).toEqual({
      dirty: false,
      ahead: 0,
      behind: 0,
      remoteBehind: -1,
      rebaseInProgress: false,
      headBranchRef: null,
    });
    expect(vi.mocked(runGit).mock.calls.some(([args, opts]) =>
      args[0] === "status" && (opts as { cwd?: string } | undefined)?.cwd === childPath
    )).toBe(false);
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
    const agentChatService = {
      countActiveForLane: vi.fn(() => 0),
      disposeForLane: vi.fn(async () => {
        calls.push("stop_chats");
        return 0;
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
    return { calls, agentChatService, ptyService, fileWatcherService, autoRebaseService, rebaseSuggestionService };
  }

  async function setupWithLane(opts: { teardown: ReturnType<typeof makeFakeServices>; events: any[]; createWorktree?: boolean }) {
    const repoRoot = makeTempRepoRoot("ade-lane-delete-");
    const worktreesDir = path.join(repoRoot, "worktrees");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const projectId = "proj-delete";
    await seedProjectAndStack(db, { projectId, repoRoot });
    db.run("update lanes set worktree_path = ? where id = ?", [path.join(worktreesDir, "parent"), "lane-parent"]);
    db.run("update lanes set worktree_path = ? where id = ?", [path.join(worktreesDir, "child"), "lane-child"]);
    // Materialize the lane-child worktree dir so the delete flow exercises git_worktree_remove.
    const childPath = path.join(worktreesDir, "child");
    if (opts.createWorktree !== false) fs.mkdirSync(childPath, { recursive: true });
    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId,
      defaultBaseRef: "main",
      worktreesDir,
      onDeleteEvent: (event) => opts.events.push(event),
      teardownDeps: {
        agentChatService: opts.teardown.agentChatService,
        ptyService: opts.teardown.ptyService,
        fileWatcherService: opts.teardown.fileWatcherService,
        autoRebaseService: opts.teardown.autoRebaseService,
        rebaseSuggestionService: opts.teardown.rebaseSuggestionService,
      },
    });
    // First call (lane-child) has no children rows after the seed; we delete lane-child.
    return { db, service, repoRoot, worktreesDir, childPath };
  }

  it("stops the lane's runtime work before archiving it", async () => {
    // Archive used to be a bare status write. Every caller releases the lane's
    // port lease and proxy route the moment it returns, so the lane's dev
    // servers and agents were still bound to those ports when the lease was
    // handed back — and, filtered out of every surface, went on holding them
    // indefinitely.
    const events: any[] = [];
    const fake = makeFakeServices();
    const { db, service } = await setupWithLane({ teardown: fake, events });

    await service.archive({ laneId: "lane-child" });

    expect(fake.calls).toContain("stop_chats");
    expect(fake.calls).toContain("stop_ptys");
    expect(fake.calls).toContain("stop_watchers");
    expect(
      db.get<{ status: string }>("select status from lanes where id = ?", ["lane-child"])?.status,
    ).toBe("archived");
  });

  it("still archives when one teardown step throws, after attempting it", async () => {
    // Each step is best-effort on purpose — a lane must not become
    // un-archivable because one watcher refuses to stop. What must hold is
    // that every stop is ATTEMPTED before the status write, and that a failure
    // is logged rather than swallowed silently.
    const events: any[] = [];
    const fake = makeFakeServices();
    fake.ptyService.disposeForLane.mockImplementation(() => {
      throw new Error("pty teardown exploded");
    });
    const { db, service } = await setupWithLane({ teardown: fake, events });

    // Individual steps are best-effort, so the archive still completes — what
    // must hold is that the stop was ATTEMPTED before the status write.
    await service.archive({ laneId: "lane-child" });
    expect(fake.ptyService.disposeForLane).toHaveBeenCalledWith("lane-child");
    expect(
      db.get<{ status: string }>("select status from lanes where id = ?", ["lane-child"])?.status,
    ).toBe("archived");
  });

  it("skips teardown for an already-archived lane", async () => {
    const events: any[] = [];
    const fake = makeFakeServices();
    const { service } = await setupWithLane({ teardown: fake, events });
    await service.archive({ laneId: "lane-child" });
    const callsAfterFirst = [...fake.calls];
    await service.archive({ laneId: "lane-child" });
    expect(fake.calls).toEqual(callsAfterFirst);
  });

  it("transfers shared proof ownership so the final owning lane can delete it", async () => {
    const events: any[] = [];
    const fake = makeFakeServices();
    const { db, service, repoRoot } = await setupWithLane({ teardown: fake, events });
    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      return { exitCode: 0, stdout: "", stderr: "" } as any;
    });
    vi.mocked(runGitOrThrow).mockImplementation(async () => ({ exitCode: 0, stdout: "", stderr: "" }) as any);

    const artifactsDir = path.join(repoRoot, ".ade", "artifacts", "computer-use");
    fs.mkdirSync(artifactsDir, { recursive: true });
    const ownedFile = path.join(artifactsDir, "owned.png");
    const sharedFile = path.join(artifactsDir, "shared.png");
    fs.writeFileSync(ownedFile, "a");
    fs.writeFileSync(sharedFile, "b");

    const insertArtifact = (id: string, laneId: string, relative: string) => {
      db.run(
        `insert into computer_use_artifacts(
           id, project_id, artifact_kind, backend_style, backend_name, source_tool_name,
           original_type, title, description, uri, storage_kind, mime_type, metadata_json,
           lane_id, created_at
         ) values (?, 'proj-delete', 'screenshot', 'manual', 'ade-cli', null, null, ?, null, ?, 'file', null, '{}', ?, ?)`,
        [id, id, relative, laneId, "2026-03-12T14:00:00.000Z"],
      );
    };
    insertArtifact("art-owned", "lane-child", ".ade/artifacts/computer-use/owned.png");
    insertArtifact("art-shared", "lane-child", ".ade/artifacts/computer-use/shared.png");

    // The shared artifact is also attached to a chat that lives in another
    // lane, so deleting this lane must not take it away from that chat.
    db.run(
      `insert into terminal_sessions(id, lane_id, title, status, started_at, transcript_path)
       values (?, ?, ?, 'exited', ?, ?)`,
      ["chat-other", "lane-parent", "Other lane chat", "2026-03-12T14:00:00.000Z", "/tmp/other.log"],
    );
    db.run(
      `insert into computer_use_artifact_links(
         id, artifact_id, project_id, owner_kind, owner_id, relation, metadata_json, created_at
       ) values (?, ?, ?, 'chat_session', ?, 'attached_to', null, ?)`,
      ["link-1", "art-shared", "proj-delete", "chat-other", "2026-03-12T14:00:00.000Z"],
    );

    await service.delete({ laneId: "lane-child", deleteBranch: false });

    const remaining = db.all<{ id: string; lane_id: string | null }>(
      "select id, lane_id from computer_use_artifacts",
    );
    expect(remaining).toEqual([{ id: "art-shared", lane_id: "lane-parent" }]);
    expect(fs.existsSync(ownedFile)).toBe(false);
    expect(fs.existsSync(sharedFile)).toBe(true);

    await service.delete({ laneId: "lane-parent", deleteBranch: false });

    const afterFinalOwnerDelete = db.all<{ id: string }>("select id from computer_use_artifacts");
    expect(afterFinalOwnerDelete).toEqual([]);
    expect(fs.existsSync(sharedFile)).toBe(false);
  });

  it("keeps a proof file when a surviving artifact row uses an equivalent URI spelling", async () => {
    const events: any[] = [];
    const fake = makeFakeServices();
    const { db, service, repoRoot } = await setupWithLane({ teardown: fake, events });
    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      return { exitCode: 0, stdout: "", stderr: "" } as any;
    });
    vi.mocked(runGitOrThrow).mockImplementation(async () => ({ exitCode: 0, stdout: "", stderr: "" }) as any);

    const relativeUri = ".ade/artifacts/computer-use/shared-uri.png";
    const artifactFile = path.join(repoRoot, relativeUri);
    fs.mkdirSync(path.dirname(artifactFile), { recursive: true });
    fs.writeFileSync(artifactFile, "shared");

    const insertArtifact = (id: string, laneId: string, uri: string) => {
      db.run(
        `insert into computer_use_artifacts(
           id, project_id, artifact_kind, backend_style, backend_name, source_tool_name,
           original_type, title, description, uri, storage_kind, mime_type, metadata_json,
           lane_id, created_at
         ) values (?, 'proj-delete', 'screenshot', 'manual', 'ade-cli', null, null, ?, null, ?, 'file', null, '{}', ?, ?)`,
        [id, id, uri, laneId, "2026-03-12T14:00:00.000Z"],
      );
    };
    insertArtifact("art-deleted", "lane-child", relativeUri);
    insertArtifact("art-survivor", "lane-parent", `ade-artifact://project/${relativeUri}`);

    await service.delete({ laneId: "lane-child", deleteBranch: false });

    const remaining = db.all<{ id: string }>("select id from computer_use_artifacts").map((row) => row.id);
    expect(remaining).toContain("art-survivor");
    expect(remaining).not.toContain("art-deleted");
    expect(fs.existsSync(artifactFile)).toBe(true);
  });

  it("reports only proof files actually removed when lane cleanup partially fails", async () => {
    const events: any[] = [];
    const fake = makeFakeServices();
    const { db, service, repoRoot } = await setupWithLane({ teardown: fake, events });
    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      return { exitCode: 0, stdout: "", stderr: "" } as any;
    });
    vi.mocked(runGitOrThrow).mockImplementation(async () => ({ exitCode: 0, stdout: "", stderr: "" }) as any);

    const artifactsDir = path.join(repoRoot, ".ade", "artifacts", "computer-use");
    const removedFile = path.join(artifactsDir, "removed.png");
    const failedFile = path.join(artifactsDir, "failed.png");
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.writeFileSync(removedFile, "removed");
    fs.writeFileSync(failedFile, "failed");
    for (const [id, uri] of [
      ["removed", ".ade/artifacts/computer-use/removed.png"],
      ["failed", ".ade/artifacts/computer-use/failed.png"],
    ]) {
      db.run(
        `insert into computer_use_artifacts(
           id, project_id, artifact_kind, backend_style, backend_name, source_tool_name,
           original_type, title, description, uri, storage_kind, mime_type, metadata_json,
           lane_id, created_at
         ) values (?, 'proj-delete', 'screenshot', 'manual', 'ade-cli', null, null, ?, null, ?, 'file', null, '{}', 'lane-child', ?)`,
        [id, id, uri, "2026-03-12T14:00:00.000Z"],
      );
    }
    const originalRmSync = fs.rmSync;
    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementation(((candidate, options) => {
      if (path.resolve(String(candidate)) === fs.realpathSync(failedFile)) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return originalRmSync(candidate, options);
    }) as typeof fs.rmSync);

    try {
      await service.delete({ laneId: "lane-child", deleteBranch: false });
    } finally {
      rmSpy.mockRestore();
    }

    const last = events[events.length - 1];
    expect(last.progress.steps.find((step: any) => step.name === "database_cleanup")?.detail)
      .toBe("1 of 2 proof file(s) removed; see logs");
    expect(fs.existsSync(removedFile)).toBe(false);
    expect(fs.existsSync(failedFile)).toBe(true);
  });

  it("runs teardown steps before git_worktree_remove and broadcasts per-step progress", async () => {
    const events: any[] = [];
    const fake = makeFakeServices();
    fake.agentChatService.countActiveForLane.mockReturnValue(1);
    fake.agentChatService.disposeForLane.mockImplementation(async () => {
      fake.calls.push("stop_chats");
      return 1;
    });
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
    expect(fake.calls.indexOf("stop_chats")).toBeLessThan(wtIdx);
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
    const { service, db, childPath } = await setupWithLane({ teardown: fake, events });
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
    expect(vi.mocked(runGit).mock.calls.some(([args]) => args[0] === "worktree" && args[1] === "prune")).toBe(true);
    const last = events[events.length - 1];
    expect(last.progress.steps.find((s: any) => s.name === "git_worktree_remove")?.detail).toContain("removed residual files");
  });

  it("recovers stale worktree directories with unreadable residual folders", async () => {
    const events: any[] = [];
    const fake = makeFakeServices();
    const { service, childPath } = await setupWithLane({ teardown: fake, events });
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

  it("deletes the lane row and records retryable cleanup when only unregistered residual files remain", async () => {
    const events: any[] = [];
    const fake = makeFakeServices();
    const { service, db, repoRoot, childPath } = await setupWithLane({ teardown: fake, events });
    fs.writeFileSync(path.join(childPath, "residual.log"), "left behind by git\n", "utf8");
    const realRm = fs.promises.rm.bind(fs.promises);
    const rmSpy = vi.spyOn(fs.promises, "rm").mockImplementation(async (target: fs.PathLike, options?: Parameters<typeof fs.promises.rm>[1]) => {
      if (path.resolve(String(target)) === childPath) {
        const error = new Error(`ENOTEMPTY: directory not empty, rmdir '${childPath}'`) as NodeJS.ErrnoException;
        error.code = "ENOTEMPTY";
        throw error;
      }
      return realRm(target, options);
    });

    vi.mocked(runGit).mockImplementation(async (args: string[], opts?: { cwd?: string }) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "rev-parse" && args[1] === "--path-format=absolute" && args[2] === "--show-toplevel") {
        return { exitCode: 0, stdout: `${repoRoot}\n`, stderr: "" } as any;
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        expect(opts?.cwd).toBe(repoRoot);
        return {
          exitCode: 128,
          stdout: "",
          stderr: `fatal: '${childPath}' is not a working tree`,
        } as any;
      }
      if (args[0] === "worktree" && args[1] === "prune") {
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      if (args[0] === "show-ref") return { exitCode: 1, stdout: "", stderr: "" } as any;
      return { exitCode: 0, stdout: "", stderr: "" } as any;
    });
    vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") return "";
      return "";
    });

    await service.list({ includeStatus: false });

    try {
      await service.delete({ laneId: "lane-child", deleteBranch: false, force: true });
    } finally {
      rmSpy.mockRestore();
    }

    expect(db.get<{ id: string }>("select id from lanes where id = ?", ["lane-child"])).toBeNull();
    expect(fs.existsSync(childPath)).toBe(true);
    expect(
      db.get<{ lane_id: string; worktree_path: string; attempts: number; last_error: string }>(
        "select lane_id, worktree_path, attempts, last_error from local_worktree_residual_cleanups where project_id = ? and worktree_path = ?",
        ["proj-delete", childPath],
      ),
    ).toMatchObject({
      lane_id: "lane-child",
      worktree_path: childPath,
      attempts: 0,
    });
    const last = events[events.length - 1];
    expect(last.progress.overallStatus).toBe("completed_with_warnings");
    const wtStep = last.progress.steps.find((s: any) => s.name === "git_worktree_remove");
    expect(wtStep?.status).toBe("completed");
    expect(wtStep?.detail).toContain("manual cleanup failed");

    await service.list({ includeStatus: false });

    expect(fs.existsSync(childPath)).toBe(false);
    expect(
      db.get<{ lane_id: string }>(
        "select lane_id from local_worktree_residual_cleanups where project_id = ? and worktree_path = ?",
        ["proj-delete", childPath],
      ),
    ).toBeNull();
  });

  it("does not clean up non-git directories still referenced by archived lanes", async () => {
    const events: any[] = [];
    const fake = makeFakeServices();
    const { service, db, worktreesDir } = await setupWithLane({ teardown: fake, events });
    const archivedPath = path.join(worktreesDir, "archived");
    fs.mkdirSync(archivedPath, { recursive: true });
    fs.writeFileSync(path.join(archivedPath, "keep.txt"), "archived lane files\n", "utf8");
    const now = "2026-03-11T12:00:00.000Z";
    db.run(
      `
        insert into lanes(
          id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
          attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ["lane-archived", "proj-delete", "Archived", null, "worktree", "main", "feature/archived", archivedPath, null, 0, null, null, null, null, "archived", now, now],
    );
    db.run(
      `
        insert into local_worktree_residual_cleanups(
          id, project_id, lane_id, branch_ref, worktree_path, reason, attempts, last_error, created_at, updated_at
        ) values (?, ?, ?, ?, ?, 'delete_residual', 0, ?, ?, ?)
      `,
      ["cleanup-archived", "proj-delete", "lane-archived", "feature/archived", archivedPath, "stale cleanup debt", now, now],
    );

    vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") return "";
      return "";
    });

    await service.list({ includeStatus: false });

    expect(fs.existsSync(path.join(archivedPath, "keep.txt"))).toBe(true);
    expect(
      db.get<{ lane_id: string }>(
        "select lane_id from local_worktree_residual_cleanups where project_id = ? and worktree_path = ?",
        ["proj-delete", archivedPath],
      ),
    ).not.toBeNull();
  });

  it("cleans only empty untracked directories and leaves unknown non-empty directories alone", async () => {
    const events: any[] = [];
    const fake = makeFakeServices();
    const { service, worktreesDir } = await setupWithLane({ teardown: fake, events });
    const emptyPath = path.join(worktreesDir, "empty-residual");
    const youngEmptyPath = path.join(worktreesDir, "young-empty-residual");
    const nonEmptyPath = path.join(worktreesDir, "non-empty-residual");
    fs.mkdirSync(path.join(emptyPath, ".ade"), { recursive: true });
    fs.mkdirSync(path.join(youngEmptyPath, ".ade"), { recursive: true });
    fs.mkdirSync(nonEmptyPath, { recursive: true });
    fs.writeFileSync(path.join(nonEmptyPath, "user-file.txt"), "not ours\n", "utf8");
    const oldEnough = new Date(Date.now() - 15 * 60_000);
    fs.utimesSync(path.join(emptyPath, ".ade"), oldEnough, oldEnough);
    fs.utimesSync(emptyPath, oldEnough, oldEnough);

    vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "list") return "";
      return "";
    });

    await service.list({ includeStatus: false });

    expect(fs.existsSync(emptyPath)).toBe(false);
    expect(fs.existsSync(youngEmptyPath)).toBe(true);
    expect(fs.existsSync(path.join(nonEmptyPath, "user-file.txt"))).toBe(true);
  });

  it("keeps retained delete progress queryable for remounted renderers", async () => {
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
    const last = events[events.length - 1];
    expect(last.progress.laneId).toBe("lane-child");
    expect(last.progress.overallStatus).toBe("completed");
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

  it("keeps the lane visible when required remote branch cleanup fails", async () => {
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

    await expect(
      service.delete({
        laneId: "lane-child",
        deleteBranch: true,
        deleteRemoteBranch: true,
        requireRemoteBranchDelete: true,
        remoteName: "origin",
      }),
    ).rejects.toThrow("remote rejected delete");

    const last = events[events.length - 1];
    expect(last.progress.overallStatus).toBe("failed");
    expect(last.progress.steps.find((s: any) => s.name === "git_branch_delete")?.status).toBe("completed");
    const remoteStep = last.progress.steps.find((s: any) => s.name === "git_remote_branch_delete");
    expect(remoteStep?.status).toBe("failed");
    expect(remoteStep?.errorMessage).toContain("remote rejected delete");
    expect(db.get<{ id: string }>("select id from lanes where id = ?", ["lane-child"])?.id).toBe("lane-child");
  });

  it("normalizes remote-shaped lane refs before deleting local and remote branches", async () => {
    const events: any[] = [];
    const fake = makeFakeServices();
    const { service, db } = await setupWithLane({ teardown: fake, events, createWorktree: false });
    db.run("update lanes set branch_ref = ? where id = ?", ["origin/feature/child", "lane-child"]);
    const gitOrThrowCalls: string[][] = [];
    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "show-ref") return { exitCode: 0, stdout: "", stderr: "" } as any;
      if (args[0] === "remote" && args[1] === "get-url") return { exitCode: 0, stdout: "git@example.test/repo.git\n", stderr: "" } as any;
      if (args[0] === "ls-remote") return { exitCode: 0, stdout: "abc\trefs/heads/feature/child\n", stderr: "" } as any;
      return { exitCode: 0, stdout: "", stderr: "" } as any;
    });
    vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
      gitOrThrowCalls.push(args);
      return { exitCode: 0, stdout: "", stderr: "" } as any;
    });

    await service.delete({
      laneId: "lane-child",
      deleteBranch: true,
      deleteRemoteBranch: true,
      remoteName: "origin",
    });

    expect(runGit).toHaveBeenCalledWith(
      ["ls-remote", "--heads", "origin", "feature/child"],
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
    expect(gitOrThrowCalls).toContainEqual(["branch", "-D", "feature/child"]);
    expect(gitOrThrowCalls).toContainEqual(["push", "origin", "--delete", "feature/child"]);
    const last = events[events.length - 1];
    expect(last.progress.overallStatus).toBe("completed");
  });

  it("surfaces remote branch lookup failures as delete warnings", async () => {
    const events: any[] = [];
    const fake = makeFakeServices();
    const { service } = await setupWithLane({ teardown: fake, events, createWorktree: false });
    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "show-ref") return { exitCode: 0, stdout: "", stderr: "" } as any;
      if (args[0] === "remote" && args[1] === "get-url") return { exitCode: 0, stdout: "git@example.test/repo.git\n", stderr: "" } as any;
      if (args[0] === "ls-remote") return { exitCode: 128, stdout: "", stderr: "Could not read from remote repository.\n" } as any;
      return { exitCode: 0, stdout: "", stderr: "" } as any;
    });
    vi.mocked(runGitOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as any);

    await service.delete({
      laneId: "lane-child",
      deleteBranch: true,
      deleteRemoteBranch: true,
      remoteName: "origin",
    });

    const last = events[events.length - 1];
    expect(last.progress.overallStatus).toBe("completed_with_warnings");
    const remoteStep = last.progress.steps.find((s: any) => s.name === "git_remote_branch_delete");
    expect(remoteStep?.status).toBe("warning");
    expect(remoteStep?.errorMessage).toContain("Could not read from remote repository");
  });

  it("cleans lane-owned database state when deleting a lane", async () => {
    const events: any[] = [];
    const fake = makeFakeServices();
    const { service, db, repoRoot, childPath } = await setupWithLane({ teardown: fake, events, createWorktree: false });
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
      ["workspace-child", "lane", "lane-child", "Child", childPath, now],
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
        insert into claude_sessions(session_id, lane_id, chat_session_id, title, tags_json, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?)
      `,
      ["chat-child", "lane-child", null, "Child chat", null, now, now],
    );
    db.run(
      `
        insert into session_linear_issues(
          id, project_id, session_id, lane_id, issue_id, issue_json, role, source,
          include_in_pr, close_on_merge, evidence_json, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ["session-link-terminal", projectId, "session-child", "lane-child", "issue-child", JSON.stringify(makeLinearIssue()), "worked", "chat_attach", 1, 0, null, now, now],
    );
    db.run(
      `
        insert into session_linear_issues(
          id, project_id, session_id, lane_id, issue_id, issue_json, role, source,
          include_in_pr, close_on_merge, evidence_json, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ["session-link-chat", projectId, "chat-child", "lane-child", "issue-child", JSON.stringify(makeLinearIssue()), "worked", "chat_attach", 1, 0, null, now, now],
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
      ["child-key", childPath, "lane-child", "pr", "PR #1", "token", now, now, now],
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
    db.run(
      `
        insert into pr_auto_link_ignores(
          project_id, repo_owner, repo_name, github_pr_number, lane_id, head_branch, created_at
        ) values (?, ?, ?, ?, ?, ?, ?)
      `,
      [projectId, "acme", "demo", 1, "lane-child", "feature/child", now],
    );
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
    // The PR row is DETACHED, not deleted: a merged PR outlives its lane, and deleting
    // the row is what made merged PRs render as `unmapped` in the PRs tab.
    expect(count("pull_requests", "id = ?", ["pr-child"])).toBe(1);
    const detachedPr = db.get<{
      lane_id: string;
      detached_at: string | null;
      detached_lane_name: string | null;
      detached_provenance: string | null;
    }>(
      "select lane_id, detached_at, detached_lane_name, detached_provenance from pull_requests where id = ?",
      ["pr-child"],
    );
    expect(detachedPr?.detached_at).toBeTruthy();
    // lane_id deliberately still points at the deleted lane — it is NOT NULL, CRR
    // strips the FK, and it stays useful as a provenance key.
    expect(detachedPr?.lane_id).toBe("lane-child");
    expect(detachedPr?.detached_lane_name).toBeTruthy();
    expect(JSON.parse(detachedPr?.detached_provenance ?? "{}")).toMatchObject({
      chats: expect.any(Number),
      artifacts: expect.any(Number),
      checkpoints: expect.any(Number),
    });
    expect(count("pr_group_members", "lane_id = ?", ["lane-child"])).toBe(0);
    // The snapshot row survives with the bulky kinds purged, so storage does not grow.
    expect(count("pull_request_snapshots", "pr_id = ?", ["pr-child"])).toBe(1);
    expect(
      db.get<{ files_json: string | null; checks_json: string | null }>(
        "select files_json, checks_json, comments_json, reviews_json from pull_request_snapshots where pr_id = ?",
        ["pr-child"],
      ),
    ).toEqual({ files_json: null, checks_json: null, comments_json: null, reviews_json: null });
    expect(count("pr_auto_link_ignores", "lane_id = ?", ["lane-child"])).toBe(0);
    expect(count("review_runs", "id = ?", ["review-run-child"])).toBe(0);
    expect(count("review_reviewer_runs", "id = ?", ["reviewer-run-child"])).toBe(0);
    expect(count("review_candidate_findings", "id = ?", ["candidate-child"])).toBe(0);
    expect(count("claude_sessions", "lane_id = ?", ["lane-child"])).toBe(0);
    expect(count("session_linear_issues", "lane_id = ? or session_id in (?, ?)", ["lane-child", "session-child", "chat-child"])).toBe(0);
    expect(count("terminal_sessions", "lane_id = ?", ["lane-child"])).toBe(0);
    expect(count("session_deltas", "lane_id = ?", ["lane-child"])).toBe(0);
    expect(count("checkpoints", "lane_id = ?", ["lane-child"])).toBe(0);
    expect(count("operations", "lane_id = ?", ["lane-child"])).toBe(0);
    expect(count("packs_index", "lane_id = ?", ["lane-child"])).toBe(0);
    expect(count("test_runs", "lane_id = ?", ["lane-child"])).toBe(0);
    expect(count("rebase_deferred", "lane_id = ?", ["lane-child"])).toBe(0);
    expect(count("rebase_dismissed", "lane_id = ?", ["lane-child"])).toBe(0);
    expect(count("lane_worktree_locks", "lane_id = ?", ["lane-child"])).toBe(0);
  });

  it("continues lane delete with a warning when active chat teardown fails", async () => {
    const events: any[] = [];
    const fake = makeFakeServices();
    fake.agentChatService.countActiveForLane.mockReturnValue(1);
    fake.agentChatService.disposeForLane.mockRejectedValue(new Error("chat refused to close"));
    const { service, db } = await setupWithLane({ teardown: fake, events, createWorktree: false });
    vi.mocked(runGit).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as any);
    vi.mocked(runGitOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as any);

    await service.delete({ laneId: "lane-child", deleteBranch: false });

    expect(db.get<{ id: string }>("select id from lanes where id = ?", ["lane-child"])).toBeNull();
    const last = events[events.length - 1];
    expect(last.progress.overallStatus).toBe("completed_with_warnings");
    expect(last.progress.steps.find((s: any) => s.name === "stop_chats")?.status).toBe("warning");
  });


  it("getDeleteRisk reports chats, ptys, watchers, and unpushed commits", async () => {
    const events: any[] = [];
    const fake = makeFakeServices();
    fake.agentChatService.countActiveForLane.mockReturnValue(1);
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
    expect(risk.activeChatCount).toBe(1);
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
      if (args[0] === "status" && String(args[1]).startsWith("--porcelain")) {
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
      const repoRoot = makeTempRepoRoot("ade-bsw-list-profile-");
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
      const repoRoot = makeTempRepoRoot("ade-bsw-list-missing-");
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
      const repoRoot = makeTempRepoRoot("ade-bsw-update-bref-");
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
      const repoRoot = makeTempRepoRoot("ade-bsw-prev-laneid-");
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
      const repoRoot = makeTempRepoRoot("ade-bsw-prev-branchname-");
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
      const repoRoot = makeTempRepoRoot("ade-bsw-prev-archived-");
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
      const repoRoot = makeTempRepoRoot("ade-bsw-prev-flags-");
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

        vi.mocked(runGit).mockImplementation(makeRunGitResponder((args, opts) => {
          if (args[0] === "show-ref" && args[1] === "--verify" && args[2] === "--quiet") {
            if (args[3] === "refs/heads/feature/target") return { exitCode: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "status" && String(args[1]).startsWith("--porcelain") && opts.cwd === path.join(repoRoot, "src")) {
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
        expect(preview.activeWork.length).toBeGreaterThanOrEqual(1);
        expect(preview.activeWork.some((w) => w.kind === "terminal")).toBe(true);
        expect(preview.targetBranchRef).toBe("feature/target");
        expect(preview.mode).toBe("existing");
      } finally {
        db.close();
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it("strips remote prefix when only the remote ref exists", async () => {
      const repoRoot = makeTempRepoRoot("ade-bsw-prev-remote-");
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
      const repoRoot = makeTempRepoRoot("ade-bsw-prev-create-");
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
      const repoRoot = makeTempRepoRoot("ade-bsw-switch-dirty-");
      const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
      try {
        seedBswProject(db, { projectId: "proj-1", repoRoot });
        insertBswLane(db, { id: "lane-d", projectId: "proj-1", name: "D", laneType: "worktree", branchRef: "feature/d", worktreePath: path.join(repoRoot, "d") });

        vi.mocked(runGit).mockImplementation(makeRunGitResponder((args, opts) => {
          if (args[0] === "show-ref" && args[3] === "refs/heads/main") return { exitCode: 0, stdout: "", stderr: "" };
          if (args[0] === "status" && String(args[1]).startsWith("--porcelain") && opts.cwd === path.join(repoRoot, "d")) {
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
      const repoRoot = makeTempRepoRoot("ade-bsw-switch-dup-");
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
      const repoRoot = makeTempRepoRoot("ade-bsw-switch-active-");
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
          .rejects.toThrow(/active sessions/);
      } finally {
        db.close();
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it("checks out an existing local branch and updates the lane row + branch profile", async () => {
      const repoRoot = makeTempRepoRoot("ade-bsw-switch-existing-");
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
      const repoRoot = makeTempRepoRoot("ade-bsw-switch-create-");
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
      const repoRoot = makeTempRepoRoot("ade-bsw-switch-create-no-base-");
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
      const repoRoot = makeTempRepoRoot("ade-bsw-switch-create-exists-");
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

    it("preserves current PR rows and retains previous-branch PR history", async () => {
      const repoRoot = makeTempRepoRoot("ade-bsw-switch-pr-detach-");
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
        db.run("insert into pull_request_ai_summaries(pr_id, head_sha, summary_json, generated_at) values (?, ?, ?, ?)", ["pr-stale", "abc123", "{}", BSW_NOW]);
        db.run("insert into pull_request_snapshots(pr_id, updated_at) values (?, ?)", ["pr-stale", BSW_NOW]);

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

        // Branch switching changes the lane's current role, not the PR's lane
        // ownership. The old row remains available as previous-branch history.
        const stale = db.get<{ lane_id: string | null; detached_at: string | null; detached_lane_name: string | null }>(
          "select lane_id, detached_at, detached_lane_name from pull_requests where id = ?",
          ["pr-stale"],
        );
        expect(stale?.detached_at).toBeNull();
        expect(stale?.lane_id).toBe("lane-a");
        // Both rows still belong to the lane; the renderer derives active vs
        // previous from the lane branch and each PR head branch.
        expect(
          db.get<{ count: number }>(
            "select count(1) as count from pull_requests where lane_id = ? and detached_at is null",
            ["lane-a"],
          )?.count,
        ).toBe(2);
      } finally {
        db.close();
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });
  });
});

describe("laneService session-scoped Linear issue links", () => {
  function seedClaudeSession(db: any, args: { sessionId: string; laneId: string; title?: string | null }) {
    const now = "2026-05-20T10:00:00.000Z";
    db.run(
      `
        insert into claude_sessions(session_id, lane_id, chat_session_id, title, tags_json, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?)
      `,
      [args.sessionId, args.laneId, null, args.title ?? null, null, now, now],
    );
  }

  it("persists and lists Linear issues attached to a standalone session with no lane", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-service-session-standalone-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    try {
      await seedProjectAndStack(db, { projectId: "proj-session-standalone", repoRoot });
      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-session-standalone",
        defaultBaseRef: "main",
        worktreesDir: path.join(repoRoot, "worktrees"),
      });

      // "chat-no-lane" is not present in claude_sessions/terminal_sessions, so
      // it resolves to no lane — the standalone case.
      const links = service.attachLinearIssueToSession({
        chatSessionId: "chat-no-lane",
        issues: [makeLinearIssue()],
      });

      expect(links).toHaveLength(1);
      expect(links[0]?.sessionId).toBe("chat-no-lane");
      expect(links[0]?.laneId).toBeNull();
      expect(links[0]?.role).toBe("worked");
      expect(links[0]?.source).toBe("chat_attach");
      expect(links[0]?.issue.identifier).toBe("ABC-42");

      const listed = service.listLinearIssuesForSession({ chatSessionId: "chat-no-lane" });
      expect(listed).toHaveLength(1);
      expect(listed[0]?.issue.id).toBe("issue-1");

      // No lane → nothing mirrored into the lane-scoped link table.
      expect(service.listLinearIssuesForLaneSessions({ laneId: "lane-child" })).toHaveLength(0);
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("attaches multiple issues in one batch call", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-service-session-batch-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    try {
      await seedProjectAndStack(db, { projectId: "proj-session-batch", repoRoot });
      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-session-batch",
        defaultBaseRef: "main",
        worktreesDir: path.join(repoRoot, "worktrees"),
      });

      const links = service.attachLinearIssueToSession({
        chatSessionId: "chat-batch",
        issues: [
          makeLinearIssue(),
          { ...makeLinearIssue(), id: "issue-2", identifier: "ABC-43", title: "Second" },
          // Duplicate id is deduped.
          { ...makeLinearIssue(), title: "Dupe id" },
        ],
      });

      expect(links).toHaveLength(2);
      expect(service.listLinearIssuesForSession({ chatSessionId: "chat-batch" })).toHaveLength(2);
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("mirrors a session attach into the lane link table when the session has a lane", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-service-session-laned-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    try {
      await seedProjectAndStack(db, { projectId: "proj-session-laned", repoRoot });
      seedClaudeSession(db, { sessionId: "chat-on-child", laneId: "lane-child", title: "Fix flaky sync run" });
      const onLinearIssueLinked = vi.fn();
      const onLinearIssueSessionLinked = vi.fn();
      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-session-laned",
        defaultBaseRef: "main",
        worktreesDir: path.join(repoRoot, "worktrees"),
        onLinearIssueLinked,
        onLinearIssueSessionLinked,
      });

      const links = service.attachLinearIssueToSession({
        chatSessionId: "chat-on-child",
        issues: [makeLinearIssue()],
      });
      expect(links[0]?.laneId).toBe("lane-child");

      // Mirrored into lane_linear_issue_links so the lane surfaces the issue.
      const lanes = await service.list({ includeStatus: false });
      const child = lanes.find((lane) => lane.id === "lane-child");
      expect(child?.linearIssueLinks).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: "chat_attach",
          issue: expect.objectContaining({ identifier: "ABC-42" }),
        }),
      ]));

      // And aggregated by lane across its sessions.
      const laneSessionLinks = service.listLinearIssuesForLaneSessions({ laneId: "lane-child" });
      expect(laneSessionLinks).toHaveLength(1);
      expect(laneSessionLinks[0]?.sessionId).toBe("chat-on-child");
      expect(onLinearIssueLinked).toHaveBeenCalledWith(expect.objectContaining({
        lane: expect.objectContaining({ id: "lane-child" }),
        issue: expect.objectContaining({ identifier: "ABC-42" }),
      }));
      expect(onLinearIssueSessionLinked).toHaveBeenCalledWith(expect.objectContaining({
        laneId: "lane-child",
        sessionId: "chat-on-child",
        sessionTitle: "Fix flaky sync run",
        issue: expect.objectContaining({ identifier: "ABC-42" }),
      }));

      onLinearIssueLinked.mockClear();
      const mirroredAgain = service.linkLinearIssues({
        laneId: "lane-child",
        issues: [makeLinearIssue()],
        role: "worked",
        source: "chat_attach",
        evidence: { chatSessionId: "chat-on-child" },
      });
      expect(mirroredAgain).toHaveLength(1);
      expect(onLinearIssueLinked).not.toHaveBeenCalled();
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("detaches an issue from both the session and the mirrored lane link", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-service-session-detach-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    try {
      await seedProjectAndStack(db, { projectId: "proj-session-detach", repoRoot });
      seedClaudeSession(db, { sessionId: "chat-detach", laneId: "lane-child" });
      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-session-detach",
        defaultBaseRef: "main",
        worktreesDir: path.join(repoRoot, "worktrees"),
      });

      service.attachLinearIssueToSession({ chatSessionId: "chat-detach", issues: [makeLinearIssue()] });
      expect(service.listLinearIssuesForSession({ chatSessionId: "chat-detach" })).toHaveLength(1);
      expect(service.listLinearIssuesForLaneSessions({ laneId: "lane-child" })).toHaveLength(1);

      const detached = service.detachLinearIssueFromSession({ chatSessionId: "chat-detach", issueId: "issue-1" });
      expect(detached).toBe(true);
      expect(service.listLinearIssuesForSession({ chatSessionId: "chat-detach" })).toHaveLength(0);
      expect(service.listLinearIssuesForLaneSessions({ laneId: "lane-child" })).toHaveLength(0);

      const lanes = await service.list({ includeStatus: false });
      const child = lanes.find((lane) => lane.id === "lane-child");
      expect((child?.linearIssueLinks ?? []).some((l) => l.source === "chat_attach")).toBe(false);

      // Detaching an unknown issue is a no-op.
      expect(service.detachLinearIssueFromSession({ chatSessionId: "chat-detach", issueId: "issue-1" })).toBe(false);
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("detaches all issues from a session when issueId is omitted", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-service-session-detach-all-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    try {
      await seedProjectAndStack(db, { projectId: "proj-session-detach-all", repoRoot });
      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-session-detach-all",
        defaultBaseRef: "main",
        worktreesDir: path.join(repoRoot, "worktrees"),
      });

      service.attachLinearIssueToSession({
        chatSessionId: "chat-all",
        issues: [
          makeLinearIssue(),
          { ...makeLinearIssue(), id: "issue-2", identifier: "ABC-43", title: "Second" },
        ],
      });
      expect(service.listLinearIssuesForSession({ chatSessionId: "chat-all" })).toHaveLength(2);

      const detached = service.detachLinearIssueFromSession({ chatSessionId: "chat-all" });
      expect(detached).toBe(true);
      expect(service.listLinearIssuesForSession({ chatSessionId: "chat-all" })).toHaveLength(0);
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("re-attaching the same issue+role replaces rather than duplicates", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-service-session-dedupe-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    try {
      await seedProjectAndStack(db, { projectId: "proj-session-dedupe", repoRoot });
      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-session-dedupe",
        defaultBaseRef: "main",
        worktreesDir: path.join(repoRoot, "worktrees"),
      });

      service.attachLinearIssueToSession({ chatSessionId: "chat-dupe", issues: [makeLinearIssue()] });
      service.attachLinearIssueToSession({
        chatSessionId: "chat-dupe",
        issues: [{ ...makeLinearIssue(), stateName: "Done", stateType: "completed" }],
      });

      const listed = service.listLinearIssuesForSession({ chatSessionId: "chat-dupe" });
      expect(listed).toHaveLength(1);
      // Latest write wins.
      expect(listed[0]?.issue.stateName).toBe("Done");
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("skips issues missing required fields without persisting them", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-service-session-invalid-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    try {
      await seedProjectAndStack(db, { projectId: "proj-session-invalid", repoRoot });
      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-session-invalid",
        defaultBaseRef: "main",
        worktreesDir: path.join(repoRoot, "worktrees"),
      });

      // Mirrors linkLinearIssues: unlinkable issues are skipped, not thrown.
      const links = service.attachLinearIssueToSession({
        chatSessionId: "chat-invalid",
        issues: [{ ...makeLinearIssue(), id: "", identifier: "" }],
      });
      expect(links).toHaveLength(0);
      expect(service.listLinearIssuesForSession({ chatSessionId: "chat-invalid" })).toHaveLength(0);
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("laneService unlinkLinearIssues", () => {
  function seedPrimaryLinearIssue(db: any, args: { projectId: string; laneId: string; issue: ReturnType<typeof makeLinearIssue> }) {
    const now = "2026-05-20T10:00:00.000Z";
    db.run(
      `
        insert into lane_linear_issues(id, project_id, lane_id, issue_id, issue_json, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?)
      `,
      [`primary-${args.laneId}`, args.projectId, args.laneId, args.issue.id, JSON.stringify(args.issue), now, now],
    );
  }

  it("removes a specific non-primary lane link, leaving the primary intact", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-service-unlink-one-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    try {
      await seedProjectAndStack(db, { projectId: "proj-unlink-one", repoRoot });
      const primaryIssue = { ...makeLinearIssue(), id: "issue-primary", identifier: "ABC-1", title: "Primary" };
      seedPrimaryLinearIssue(db, { projectId: "proj-unlink-one", laneId: "lane-child", issue: primaryIssue });
      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-unlink-one",
        defaultBaseRef: "main",
        worktreesDir: path.join(repoRoot, "worktrees"),
      });

      service.linkLinearIssues({
        laneId: "lane-child",
        issues: [
          { ...makeLinearIssue(), id: "issue-a", identifier: "ABC-2", title: "A" },
          { ...makeLinearIssue(), id: "issue-b", identifier: "ABC-3", title: "B" },
        ],
      });

      const removed = service.unlinkLinearIssues({ laneId: "lane-child", issueId: "issue-a" });
      expect(removed).toBe(true);

      const lanes = await service.list({ includeStatus: false });
      const child = lanes.find((lane) => lane.id === "lane-child");
      const linkIds = (child?.linearIssueLinks ?? []).map((l) => l.issue.id);
      expect(linkIds).not.toContain("issue-a");
      expect(linkIds).toContain("issue-b");
      // Primary survives.
      expect(child?.linearIssue?.id).toBe("issue-primary");
      expect(linkIds).toContain("issue-primary");
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("removes all non-primary links when issueId is omitted but never the primary", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-service-unlink-all-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    try {
      await seedProjectAndStack(db, { projectId: "proj-unlink-all", repoRoot });
      const primaryIssue = { ...makeLinearIssue(), id: "issue-primary", identifier: "ABC-1", title: "Primary" };
      seedPrimaryLinearIssue(db, { projectId: "proj-unlink-all", laneId: "lane-child", issue: primaryIssue });
      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-unlink-all",
        defaultBaseRef: "main",
        worktreesDir: path.join(repoRoot, "worktrees"),
      });

      service.linkLinearIssues({
        laneId: "lane-child",
        issues: [
          { ...makeLinearIssue(), id: "issue-a", identifier: "ABC-2", title: "A" },
          { ...makeLinearIssue(), id: "issue-b", identifier: "ABC-3", title: "B" },
        ],
      });

      const removed = service.unlinkLinearIssues({ laneId: "lane-child" });
      expect(removed).toBe(true);

      const lanes = await service.list({ includeStatus: false });
      const child = lanes.find((lane) => lane.id === "lane-child");
      const linkIds = (child?.linearIssueLinks ?? []).map((l) => l.issue.id);
      expect(linkIds).not.toContain("issue-a");
      expect(linkIds).not.toContain("issue-b");
      // Primary is preserved (synthesized as a link + the lane primary issue).
      expect(child?.linearIssue?.id).toBe("issue-primary");

      // Nothing left to remove → no-op.
      expect(service.unlinkLinearIssues({ laneId: "lane-child" })).toBe(false);
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("laneService createWorktreeLane orphan cleanup", () => {
  beforeEach(() => {
    vi.mocked(getHeadSha).mockReset();
    vi.mocked(runGit).mockReset();
    vi.mocked(runGitOrThrow).mockReset();
  });

  it("removes the created worktree and branch when the lane-row insert fails", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-service-create-cleanup-");
    const realDb = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    const now = "2026-05-12T20:00:00.000Z";
    realDb.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      ["proj-create-cleanup", repoRoot, "demo", "main", now, now],
    );

    // Inject a failure on the `insert into lanes(...)` AFTER `git worktree add`
    // already succeeded, simulating a DB write that orphans the worktree.
    const db = new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === "run") {
          return (sql: string, params?: unknown[]) => {
            if (/insert into lanes\(/i.test(sql)) {
              throw new Error("simulated lane insert failure");
            }
            return (target.run as (sql: string, params?: unknown[]) => void)(sql, params as never);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    let worktreeAdded = false;
    let worktreeRemoved = false;
    let branchDeleted = false;

    vi.mocked(runGitOrThrow).mockImplementation(async (args: string[]) => {
      if (args[0] === "worktree" && args[1] === "add") {
        worktreeAdded = true;
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      if (args[0] === "worktree" && args[1] === "remove") {
        worktreeRemoved = true;
        return { exitCode: 0, stdout: "", stderr: "" } as any;
      }
      return { exitCode: 0, stdout: "", stderr: "" } as any;
    });

    vi.mocked(runGit).mockImplementation(async (args: string[]) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(args);
      if (laneBranchGitStub) return laneBranchGitStub;
      if (args[0] === "rev-parse" && args[1] === "main") return { exitCode: 0, stdout: "sha-main\n", stderr: "" };
      if (args[0] === "branch" && args[1] === "-D") {
        branchDeleted = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-create-cleanup",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    try {
      await expect(
        service.create({ name: "ENG-9 Orphan guard" }),
      ).rejects.toThrow(/simulated lane insert failure/);

      // The worktree was created, so cleanup must remove it and the branch.
      expect(worktreeAdded).toBe(true);
      expect(worktreeRemoved).toBe(true);
      expect(branchDeleted).toBe(true);

      // No lane row was persisted for the failed create.
      const rows = realDb.all<{ id: string }>(
        "select id from lanes where project_id = ?",
        ["proj-create-cleanup"],
      );
      expect(rows).toHaveLength(0);
    } finally {
      realDb.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("laneService rename", () => {
  const RENAME_NOW = "2026-06-29T12:00:00.000Z";

  function seedRenameProject(db: any, args: { projectId: string; repoRoot: string }) {
    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      [args.projectId, args.repoRoot, "demo", "main", RENAME_NOW, RENAME_NOW],
    );
  }

  function insertRenameLane(
    db: any,
    args: {
      id: string;
      projectId: string;
      name: string;
      laneType: "primary" | "worktree";
      branchRef: string;
      worktreePath: string;
      status?: "active" | "archived";
      archivedAt?: string | null;
    },
  ) {
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
        "main",
        args.branchRef,
        args.worktreePath,
        null,
        args.laneType === "primary" ? 1 : 0,
        null,
        null,
        null,
        null,
        args.status ?? "active",
        RENAME_NOW,
        args.archivedAt ?? null,
      ],
    );
  }

  it("updates the lane display name", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-rename-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    try {
      seedRenameProject(db, { projectId: "proj-rename", repoRoot });
      insertRenameLane(db, {
        id: "lane-a",
        projectId: "proj-rename",
        name: "old-name",
        laneType: "worktree",
        branchRef: "ade/old-name",
        worktreePath: path.join(repoRoot, "lane-a"),
      });

      const onLifecycleEvent = vi.fn();
      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-rename",
        defaultBaseRef: "main",
        worktreesDir: path.join(repoRoot, "worktrees"),
        onLifecycleEvent,
        logger: createLogger(),
      });

      service.rename({ laneId: "lane-a", name: "new-name" });

      const row = db.get<{ name: string }>(
        "select name from lanes where id = ? and project_id = ?",
        ["lane-a", "proj-rename"],
      );
      expect(row?.name).toBe("new-name");
      expect(onLifecycleEvent).toHaveBeenCalledWith({
        type: "lane-renamed",
        laneId: "lane-a",
        laneName: "new-name",
        previousLaneName: "old-name",
        color: null,
      });
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("does not emit lifecycle events when archive and unarchive do not change status", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-archive-noop-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    try {
      seedRenameProject(db, { projectId: "proj-archive-noop", repoRoot });
      insertRenameLane(db, {
        id: "lane-active",
        projectId: "proj-archive-noop",
        name: "active-lane",
        laneType: "worktree",
        branchRef: "ade/active-lane",
        worktreePath: path.join(repoRoot, "lane-active"),
      });
      insertRenameLane(db, {
        id: "lane-archived",
        projectId: "proj-archive-noop",
        name: "archived-lane",
        laneType: "worktree",
        branchRef: "ade/archived-lane",
        worktreePath: path.join(repoRoot, "lane-archived"),
        status: "archived",
        archivedAt: RENAME_NOW,
      });

      const onLifecycleEvent = vi.fn();
      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-archive-noop",
        defaultBaseRef: "main",
        worktreesDir: path.join(repoRoot, "worktrees"),
        onLifecycleEvent,
        logger: createLogger(),
      });

      service.archive({ laneId: "lane-archived" });
      await service.unarchive({ laneId: "lane-active" });

      expect(onLifecycleEvent).not.toHaveBeenCalled();
      expect(db.get<{ status: string }>("select status from lanes where id = ?", ["lane-archived"])?.status).toBe("archived");
      expect(db.get<{ status: string }>("select status from lanes where id = ?", ["lane-active"])?.status).toBe("active");
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects duplicate lane names case-insensitively", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-rename-dup-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    try {
      seedRenameProject(db, { projectId: "proj-rename-dup", repoRoot });
      insertRenameLane(db, {
        id: "lane-a",
        projectId: "proj-rename-dup",
        name: "alpha-lane",
        laneType: "worktree",
        branchRef: "ade/alpha-lane",
        worktreePath: path.join(repoRoot, "lane-a"),
      });
      insertRenameLane(db, {
        id: "lane-b",
        projectId: "proj-rename-dup",
        name: "Beta-Lane",
        laneType: "worktree",
        branchRef: "ade/beta-lane",
        worktreePath: path.join(repoRoot, "lane-b"),
      });

      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-rename-dup",
        defaultBaseRef: "main",
        worktreesDir: path.join(repoRoot, "worktrees"),
        logger: createLogger(),
      });

      expect(() => service.rename({ laneId: "lane-a", name: "beta-lane" }))
        .toThrow(/already exists/i);
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects renaming the primary lane", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-rename-primary-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    try {
      seedRenameProject(db, { projectId: "proj-rename-primary", repoRoot });
      insertRenameLane(db, {
        id: "lane-primary",
        projectId: "proj-rename-primary",
        name: "primary",
        laneType: "primary",
        branchRef: "main",
        worktreePath: repoRoot,
      });

      const service = createLaneService({
        db,
        projectRoot: repoRoot,
        projectId: "proj-rename-primary",
        defaultBaseRef: "main",
        worktreesDir: path.join(repoRoot, "worktrees"),
        logger: createLogger(),
      });

      expect(() => service.rename({ laneId: "lane-primary", name: "renamed-primary" }))
        .toThrow(/primary lane cannot be renamed/i);
    } finally {
      db.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("laneService branch drift", () => {
  beforeEach(() => {
    vi.mocked(getHeadSha).mockReset();
    vi.mocked(runGit).mockReset();
    vi.mocked(runGitOrThrow).mockReset();
  });

  /**
   * Permissive git stub: everything the lane-status refresh needs, with a
   * per-worktree HEAD branch so drift can be simulated.
   */
  function stubDriftGit(args: {
    repoRoot: string;
    headBranchByPath: Record<string, string>;
    dirtyPaths?: string[];
  }) {
    const checkouts: Array<{ cwd: string; branch: string }> = [];
    vi.mocked(runGitOrThrow).mockImplementation(async (gitArgs: string[], opts?: { cwd?: string }) => {
      if (gitArgs[0] === "checkout") {
        checkouts.push({ cwd: opts?.cwd ?? "", branch: gitArgs[gitArgs.length - 1] ?? "" });
      }
      return "";
    });
    vi.mocked(runGit).mockImplementation(async (gitArgs: string[], opts?: { cwd?: string }) => {
      const laneBranchGitStub = defaultLaneBranchGitStub(gitArgs);
      if (laneBranchGitStub) return laneBranchGitStub;
      const cwd = opts?.cwd ?? args.repoRoot;
      const head = args.headBranchByPath[cwd] ?? "main";
      const dirty = (args.dirtyPaths ?? []).includes(cwd);
      if (gitArgs[0] === "rev-parse" && gitArgs[1] === "--path-format=absolute" && gitArgs[2] === "--show-toplevel") {
        return { exitCode: 0, stdout: `${cwd}\n`, stderr: "" };
      }
      if (gitArgs[0] === "symbolic-ref") {
        return { exitCode: 0, stdout: `${head}\n`, stderr: "" };
      }
      if (gitArgs[0] === "status" && String(gitArgs[1]).startsWith("--porcelain=v2")) {
        const body = dirty ? "1 .M N... 100644 100644 100644 aaa bbb src/app.ts\n" : "";
        return { exitCode: 0, stdout: `# branch.oid abc\n# branch.head ${head}\n${body}`, stderr: "" };
      }
      if (gitArgs[0] === "status") {
        return { exitCode: 0, stdout: dirty ? " M src/app.ts\n" : "", stderr: "" };
      }
      if (gitArgs[0] === "show-ref") return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "" };
    });
    return { checkouts };
  }

  it("surfaces branchDrift on the lane summary when HEAD wandered off branch_ref", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-drift-detect-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-drift-detect", repoRoot });
    const childPath = path.join(repoRoot, "child");
    stubDriftGit({
      repoRoot,
      headBranchByPath: {
        [childPath]: "hotfix-auth",
        [path.join(repoRoot, "parent")]: "feature/parent",
        [path.join(repoRoot, "main")]: "main",
      },
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-drift-detect",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    const lanes = await service.list({ includeStatus: true });
    expect(lanes.find((lane) => lane.id === "lane-child")?.branchDrift).toEqual({
      expectedBranchRef: "feature/child",
      headBranchRef: "hotfix-auth",
    });
    expect(lanes.find((lane) => lane.id === "lane-parent")?.branchDrift).toBeNull();
  });

  it("switch-back refuses on a dirty worktree and leaves branch_ref untouched", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-drift-dirty-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-drift-dirty", repoRoot });
    const childPath = path.join(repoRoot, "child");
    const { checkouts } = stubDriftGit({
      repoRoot,
      headBranchByPath: { [childPath]: "hotfix-auth" },
      dirtyPaths: [childPath],
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-drift-dirty",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    await expect(
      service.resolveBranchDrift({ laneId: "lane-child", resolution: "switch-back" }),
    ).rejects.toThrow(/uncommitted changes/i);
    expect(checkouts).toHaveLength(0);
    expect(db.get("select branch_ref from lanes where id = ?", ["lane-child"])).toMatchObject({
      branch_ref: "feature/child",
    });
  });

  it("switch-back checks the recorded branch back out on a clean worktree", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-drift-switchback-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-drift-switchback", repoRoot });
    const childPath = path.join(repoRoot, "child");
    const { checkouts } = stubDriftGit({
      repoRoot,
      headBranchByPath: { [childPath]: "hotfix-auth" },
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-drift-switchback",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    const result = await service.resolveBranchDrift({
      laneId: "lane-child",
      resolution: "switch-back",
      expectedHeadBranchRef: "hotfix-auth",
    });

    expect(result.resolution).toBe("switch-back");
    expect(result.branchRef).toBe("feature/child");
    expect(checkouts).toContainEqual({ cwd: childPath, branch: "feature/child" });
    expect(db.get("select branch_ref from lanes where id = ?", ["lane-child"])).toMatchObject({
      branch_ref: "feature/child",
    });
  });

  it("keep-head re-points branch_ref and the branch-derived lane name in one write", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-drift-keep-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-drift-keep", repoRoot });
    // The lane name is literally advertising the branch it tracks.
    db.run("update lanes set name = ? where id = ?", ["feature/child", "lane-child"]);
    const childPath = path.join(repoRoot, "child");
    const { checkouts } = stubDriftGit({
      repoRoot,
      headBranchByPath: { [childPath]: "hotfix-auth" },
    });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-drift-keep",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    const result = await service.resolveBranchDrift({
      laneId: "lane-child",
      resolution: "keep-head",
      expectedHeadBranchRef: "hotfix-auth",
    });

    expect(result).toMatchObject({
      resolution: "keep-head",
      previousBranchRef: "feature/child",
      branchRef: "hotfix-auth",
      previousLaneName: "feature/child",
      laneName: "hotfix-auth",
    });
    // keep-head never touches the worktree — HEAD is already where we want it.
    expect(checkouts).toHaveLength(0);
    expect(db.get("select branch_ref, name from lanes where id = ?", ["lane-child"])).toMatchObject({
      branch_ref: "hotfix-auth",
      name: "hotfix-auth",
    });
  });

  it("keep-head preserves a hand-written lane name", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-drift-keep-name-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-drift-keep-name", repoRoot });
    // A hand-written name — it advertises no branch, so it must survive.
    db.run("update lanes set name = ? where id = ?", ["Auth work", "lane-child"]);
    const childPath = path.join(repoRoot, "child");
    stubDriftGit({ repoRoot, headBranchByPath: { [childPath]: "hotfix-auth" } });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-drift-keep-name",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    const result = await service.resolveBranchDrift({ laneId: "lane-child", resolution: "keep-head" });

    expect(result.previousLaneName).toBeNull();
    expect(db.get("select branch_ref, name from lanes where id = ?", ["lane-child"])).toMatchObject({
      branch_ref: "hotfix-auth",
      name: "Auth work",
    });
  });

  it("rejects a resolution whose expected HEAD no longer matches the worktree", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-drift-stale-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-drift-stale", repoRoot });
    const childPath = path.join(repoRoot, "child");
    stubDriftGit({ repoRoot, headBranchByPath: { [childPath]: "hotfix-auth" } });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-drift-stale",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    await expect(
      service.resolveBranchDrift({
        laneId: "lane-child",
        resolution: "keep-head",
        expectedHeadBranchRef: "some-other-branch",
      }),
    ).rejects.toThrow(/Refresh and try again/i);
    expect(db.get("select branch_ref from lanes where id = ?", ["lane-child"])).toMatchObject({
      branch_ref: "feature/child",
    });
  });

  it("refuses when the lane is already on its recorded branch", async () => {
    const repoRoot = makeTempRepoRoot("ade-lane-drift-none-");
    const db = await openKvDb(path.join(repoRoot, "kv.sqlite"), createLogger());
    await seedProjectAndStack(db, { projectId: "proj-drift-none", repoRoot });
    const childPath = path.join(repoRoot, "child");
    stubDriftGit({ repoRoot, headBranchByPath: { [childPath]: "feature/child" } });

    const service = createLaneService({
      db,
      projectRoot: repoRoot,
      projectId: "proj-drift-none",
      defaultBaseRef: "main",
      worktreesDir: path.join(repoRoot, "worktrees"),
    });

    await expect(
      service.resolveBranchDrift({ laneId: "lane-child", resolution: "switch-back" }),
    ).rejects.toThrow(/already on its recorded branch/i);
    expect(await service.getBranchDrift({ laneId: "lane-child" })).toBeNull();
  });
});


describe("parseGitWorktreePorcelain", () => {
  // The parser resolves each recorded path, so expectations are built the same
  // way rather than pinned to a posix spelling Windows would rewrite.
  const repo = path.resolve("/repo");
  const lane = path.resolve("/repo/.ade/worktrees/lane-a");
  const LF = [
    "worktree /repo",
    "HEAD abc",
    "branch refs/heads/main",
    "",
    "worktree /repo/.ade/worktrees/lane-a",
    "HEAD def",
    "branch refs/heads/ade/lane-a",
    "",
  ].join("\n");

  it("parses the LF stream git for Windows emits today", () => {
    const parsed = parseGitWorktreePorcelain(LF);
    expect(parsed.map((wt) => wt.path)).toEqual([repo, lane]);
    expect(parsed[1]?.branch).toBe("ade/lane-a");
  });

  it("parses a CRLF stream into the same worktrees", () => {
    // The block separator was /\n\n+/ while the line split one line below was
    // already CRLF-aware. A CRLF stream matched no separator at all, collapsed
    // the whole listing into a single block, and returned exactly one worktree
    // — silently disabling worktree reconcile rather than failing.
    const parsed = parseGitWorktreePorcelain(LF.split("\n").join("\r\n"));
    expect(parsed.map((wt) => wt.path)).toEqual([repo, lane]);
    expect(parsed[1]?.branch).toBe("ade/lane-a");
  });

  it("still parses a bare worktree entry out of a CRLF stream", () => {
    const parsed = parseGitWorktreePorcelain(["worktree /repo.git", "bare", ""].join("\r\n"));
    expect(parsed).toEqual([expect.objectContaining({ path: path.resolve("/repo.git"), isBare: true })]);
  });
});
