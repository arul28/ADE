import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openKvDb, type AdeDb } from "../state/kvDb";
import { createLaneService } from "./laneService";

vi.mock("../git/git", () => ({
  getHeadSha: vi.fn(),
  runGit: vi.fn(),
  runGitOrThrow: vi.fn(),
}));

import { runGit, runGitOrThrow } from "../git/git";

const roots: string[] = [];
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function gitResult(exitCode = 0, stdout = "", stderr = "") {
  return { exitCode, stdout, stderr };
}

function seed(db: AdeDb, root: string, options: { status?: "active" | "archived"; worktreePath?: string } = {}) {
  const projectId = "project-storage";
  const worktreesDir = path.join(root, ".ade", "worktrees");
  fs.mkdirSync(worktreesDir, { recursive: true });
  const worktreePath = options.worktreePath ?? path.join(worktreesDir, "feature-12345678");
  const now = "2026-07-01T00:00:00.000Z";
  db.run(
    "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
    [projectId, root, "Fixture", "main", now, now],
  );
  db.run(
    `insert into lanes(
       id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
       attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
     ) values (?, ?, ?, null, 'worktree', 'main', 'feature/storage', ?, null, 0, null, null, null, null, ?, ?, ?)`,
    [
      "12345678-lane",
      projectId,
      "Storage feature",
      worktreePath,
      options.status ?? "active",
      now,
      options.status === "archived" ? now : null,
    ],
  );
  return { projectId, worktreesDir, worktreePath };
}

function installGitStub(args: { dirty?: boolean; onRemove?: () => Promise<void> | void; onAdd?: (target: string) => void } = {}) {
  vi.mocked(runGit).mockImplementation(async (command: string[], options?: { cwd?: string }) => {
    if (command[0] === "rev-parse" && command.includes("--show-toplevel")) {
      if (!options?.cwd || !fs.existsSync(options.cwd)) return gitResult(1, "", "missing");
      return gitResult(0, `${options?.cwd ?? ""}\n`);
    }
    if (command[0] === "status") return gitResult(0, args.dirty ? " M changed.txt\n" : "");
    if (command[0] === "rev-list" && command[1] === "--count") return gitResult(0, "0\n");
    if (command[0] === "ls-remote") return gitResult(0, "abc\trefs/heads/feature/storage\n");
    if (command[0] === "merge-base") return gitResult(0);
    if (command[0] === "worktree" && command[1] === "remove") {
      await args.onRemove?.();
      fs.rmSync(command.at(-1)!, { recursive: true, force: true });
      return gitResult(0);
    }
    if (command[0] === "worktree" && command[1] === "prune") return gitResult(0);
    if (command[0] === "show-ref") return gitResult(0);
    if (command[0] === "rev-list" && command[1] === "--left-right") return gitResult(0, "0\t0\n");
    if (command[0] === "rev-parse" && command.includes("@{upstream}")) return gitResult(1);
    if (command[0] === "rev-parse" && command.includes("--git-dir")) return gitResult(1);
    return gitResult(0);
  });
  vi.mocked(runGitOrThrow).mockImplementation(async (command: string[], options?: { cwd?: string }) => {
    if (command[0] === "worktree" && command[1] === "list") {
      const worktreesDir = path.join(options?.cwd ?? "", ".ade", "worktrees");
      const names = fs.existsSync(worktreesDir) ? fs.readdirSync(worktreesDir) : [];
      const stdout = names
        .map((name) => `worktree ${path.join(worktreesDir, name)}\nbranch refs/heads/feature/storage\n`)
        .join("\n");
      return stdout as never;
    }
    if (command[0] === "worktree" && command[1] === "add") {
      const target = command[2] === "-b" ? command[4] : command[2];
      fs.mkdirSync(target, { recursive: true });
      args.onAdd?.(target);
    }
    return gitResult(0) as never;
  });
}

async function fixture(options: { status?: "active" | "archived"; worktreePath?: string } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-storage-lifecycle-"));
  roots.push(root);
  const db = await openKvDb(path.join(root, ".ade", "ade.db"), logger as any);
  const seeded = seed(db, root, options);
  const service = createLaneService({
    db,
    projectRoot: root,
    projectId: seeded.projectId,
    defaultBaseRef: "main",
    worktreesDir: seeded.worktreesDir,
    logger: logger as any,
  });
  return { root, db, service, ...seeded };
}

beforeEach(() => {
  vi.mocked(runGit).mockReset();
  vi.mocked(runGitOrThrow).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("lane storage lifecycle", () => {
  it("does not reclaim a dirty lane without the explicit dirty confirmation", async () => {
    const { db, service, worktreePath } = await fixture();
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "changed.txt"), "keep me");
    installGitStub({ dirty: true });

    await expect(service.archiveAndReclaim({
      laneId: "12345678-lane",
      confirmation: "RECLAIM",
    })).rejects.toThrow(/uncommitted files/i);

    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(db.get<{ status: string }>("select status from lanes where id = ?", ["12345678-lane"])?.status).toBe("active");
    db.close();
  });

  it("reclaims only managed files while preserving the lane, branch, and chat", async () => {
    const { db, service, worktreePath } = await fixture();
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "generated.bin"), Buffer.alloc(128));
    db.run(
      "insert into claude_sessions(session_id, lane_id, title, created_at, updated_at) values (?, ?, ?, ?, ?)",
      ["chat-1", "12345678-lane", "Keep this chat", "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z"],
    );
    installGitStub();

    const result = await service.archiveAndReclaim({
      laneId: "12345678-lane",
      confirmation: "RECLAIM",
    });

    expect(result.reclaimedBytes).toBeGreaterThanOrEqual(128);
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(db.get("select status, branch_ref from lanes where id = ?", ["12345678-lane"])).toMatchObject({
      status: "archived",
      branch_ref: "feature/storage",
    });
    expect(db.get("select session_id from claude_sessions where session_id = ?", ["chat-1"])).toMatchObject({ session_id: "chat-1" });
    db.close();
  });

  it("restores a reclaimed lane at a safe managed path when the saved database path is stale", async () => {
    const stalePath = path.join(os.tmpdir(), "old-machine", "feature");
    const { db, service, worktreesDir } = await fixture({ status: "archived", worktreePath: stalePath });
    installGitStub();

    const result = await service.unarchive({ laneId: "12345678-lane" });

    const expectedPath = path.join(worktreesDir, "storage-feature-12345678");
    expect(result.worktreeRecreated).toBe(true);
    expect(result.lane.worktreePath).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(db.get("select status, worktree_path from lanes where id = ?", ["12345678-lane"])).toMatchObject({
      status: "active",
      worktree_path: expectedPath,
    });
    db.close();
  });

  it("does not reclaim a managed path that Git does not register to this lane", async () => {
    const { db, service, worktreePath } = await fixture({ status: "archived" });
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "unrelated.txt"), "keep this");
    installGitStub();
    vi.mocked(runGitOrThrow).mockImplementation(async (command: string[]) => {
      if (command[0] === "worktree" && command[1] === "list") {
        return "worktree /somewhere/else\nbranch refs/heads/feature/storage\n" as never;
      }
      return gitResult(0) as never;
    });

    await expect(service.archiveAndReclaim({
      laneId: "12345678-lane",
      confirmation: "RECLAIM",
    })).rejects.toThrow(/not the lane worktree registered/i);

    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(db.get<{ status: string }>("select status from lanes where id = ?", ["12345678-lane"])?.status).toBe("archived");
    db.close();
  });

  it("does not restore against an unregistered repository occupying the saved path", async () => {
    const { db, service, worktreePath } = await fixture({ status: "archived" });
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "unrelated.txt"), "keep this");
    installGitStub();
    vi.mocked(runGitOrThrow).mockImplementation(async (command: string[]) => {
      if (command[0] === "worktree" && command[1] === "list") return "" as never;
      return gitResult(0) as never;
    });

    await expect(service.unarchive({ laneId: "12345678-lane" })).rejects.toThrow(/occupied by a different/i);

    expect(fs.readFileSync(path.join(worktreePath, "unrelated.txt"), "utf8")).toBe("keep this");
    expect(db.get<{ status: string }>("select status from lanes where id = ?", ["12345678-lane"])?.status).toBe("archived");
    db.close();
  });

  it("records a failed reclaim for safe retry", async () => {
    const { db, service, worktreePath } = await fixture({ status: "archived" });
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "file.bin"), "data");
    installGitStub();
    vi.mocked(runGit).mockImplementation(async (command: string[], options?: { cwd?: string }) => {
      if (command[0] === "worktree" && command[1] === "remove") return gitResult(1, "", "remove failed");
      if (command[0] === "worktree" && command[1] === "prune") return gitResult(0);
      if (command[0] === "rev-parse" && command.includes("--show-toplevel")) return gitResult(0, `${options?.cwd}\n`);
      if (command[0] === "status") return gitResult(0, "");
      if (command[0] === "rev-list") return gitResult(0, "0\n");
      if (command[0] === "ls-remote") return gitResult(0, "");
      if (command[0] === "merge-base") return gitResult(0);
      return gitResult(0);
    });
    const originalRm = fs.promises.rm.bind(fs.promises);
    vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
      if (path.resolve(String(target)) === path.resolve(worktreePath)) throw new Error("disk is busy");
      return originalRm(target, options);
    });

    await expect(service.archiveAndReclaim({
      laneId: "12345678-lane",
      confirmation: "RECLAIM",
    })).rejects.toThrow(/disk is busy/i);

    expect(db.get("select reclaim_state, attempts, last_error from local_lane_storage_state where lane_id = ?", ["12345678-lane"]))
      .toMatchObject({ reclaim_state: "failed", attempts: 1, last_error: "disk is busy" });
    expect(db.get<{ status: string }>("select status from lanes where id = ?", ["12345678-lane"])?.status).toBe("archived");
    db.close();
  });

  it("records generated-data deletion failures and retries the remaining files", async () => {
    const { root, db, service, worktreePath } = await fixture({ status: "archived" });
    const lanePackDir = path.join(root, ".ade", "artifacts", "packs", "lanes", "12345678-lane");
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "file.bin"), "worktree");
    fs.mkdirSync(lanePackDir, { recursive: true });
    fs.writeFileSync(path.join(lanePackDir, "generated.bin"), "generated");
    installGitStub();

    const originalRm = fs.promises.rm.bind(fs.promises);
    let failedOnce = false;
    vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
      if (!failedOnce && path.resolve(String(target)) === path.resolve(lanePackDir)) {
        failedOnce = true;
        throw new Error("pack is busy");
      }
      return originalRm(target, options);
    });

    await expect(service.archiveAndReclaim({
      laneId: "12345678-lane",
      confirmation: "RECLAIM",
    })).rejects.toThrow(/pack is busy/i);

    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(fs.existsSync(lanePackDir)).toBe(true);
    expect(db.get("select reclaim_state, attempts, last_known_bytes from local_lane_storage_state where lane_id = ?", ["12345678-lane"]))
      .toMatchObject({ reclaim_state: "failed", attempts: 1, last_known_bytes: 9 });

    const retry = await service.archiveAndReclaim({
      laneId: "12345678-lane",
      confirmation: "RECLAIM",
    });
    expect(retry.generatedDataRemoved).toBe(true);
    expect(fs.existsSync(lanePackDir)).toBe(false);
    expect(db.get("select reclaim_state, last_error from local_lane_storage_state where lane_id = ?", ["12345678-lane"]))
      .toMatchObject({ reclaim_state: "reclaimed", last_error: null });
    db.close();
  });

  it("rejects a concurrent reclaim of the same lane", async () => {
    const { root, db, service, projectId, worktreesDir, worktreePath } = await fixture({ status: "archived" });
    const secondService = createLaneService({
      db,
      projectRoot: root,
      projectId,
      defaultBaseRef: "main",
      worktreesDir,
      logger: logger as any,
    });
    fs.mkdirSync(worktreePath, { recursive: true });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let removeStarted!: () => void;
    const started = new Promise<void>((resolve) => { removeStarted = resolve; });
    installGitStub({ onRemove: async () => { removeStarted(); await gate; } });

    const first = service.archiveAndReclaim({ laneId: "12345678-lane", confirmation: "RECLAIM" });
    await started;
    await expect(service.archiveAndReclaim({
      laneId: "12345678-lane",
      confirmation: "RECLAIM",
    })).rejects.toThrow(/already running/i);
    await expect(service.unarchive({ laneId: "12345678-lane" })).rejects.toThrow(/wait for archive & reclaim/i);
    await expect(secondService.unarchive({ laneId: "12345678-lane" }))
      .rejects.toThrow(/blocked by archive & reclaim.*before changing or restoring this lane/i);
    release();
    await first;
    db.close();
  });
});
