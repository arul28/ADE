import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectMoveRecord } from "../../../../../desktop/src/shared/types/projectMove";
import { openKvDb } from "../../../../../desktop/src/main/services/state/kvDb";
import { loadNodeSqlite } from "../../../../../desktop/src/main/services/projects/readOnlySqlite";
import { ProjectRegistry } from "../projectRegistry";
import { relativeToRoot } from "./moveGitLinks";
import { currentBootMinute, isMoveProcessAlive, listMoveRecords, markMoveActive, readMovedMarker, writeMoveRecord } from "./moveJournal";
import { recoverInterruptedMoves, runProjectMove } from "./projectMoveEngine";
import { copyLocation } from "./projectMovePreflight";

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;
const hooks = { closeProject: async () => {}, onProgress: () => {} };

let tmp: string;

beforeEach(() => {
  // realpath: on macOS the temp dir is reached through /var → /private/var.
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-project-move-")));
  fs.mkdirSync(path.join(tmp, "home"));
  vi.stubEnv("ADE_HOME", path.join(tmp, "ade-home"));
  vi.stubEnv("HOME", path.join(tmp, "home"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).trimEnd();
}

function queryDb<T>(dbPath: string, sql: string): T[] {
  const { DatabaseSync } = loadNodeSqlite();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

/**
 * A project with a dirty lane inside it, a lane outside it, a gitignored
 * `node_modules`, a `node_modules` folder git tracks, and ADE data naming all
 * of them, registered in ADE's project list.
 */
async function makeProject(root: string): Promise<{ insideLane: string; outsideLane: string }> {
  fs.mkdirSync(root, { recursive: true });
  git(root, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(root, "a.txt"), "hi\n");
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n!vendor/node_modules/\n.ade/\n");
  fs.mkdirSync(path.join(root, "vendor", "node_modules", "patched"), { recursive: true });
  fs.writeFileSync(path.join(root, "vendor", "node_modules", "patched", "index.js"), "patched\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "init"]);
  fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "installed\n");

  const insideLane = path.join(root, ".ade", "worktrees", "alpha");
  git(root, ["worktree", "add", "-q", "-b", "alpha", insideLane]);
  fs.appendFileSync(path.join(insideLane, "a.txt"), "dirty\n");
  fs.writeFileSync(path.join(insideLane, "untracked.txt"), "new\n");
  const outsideLane = path.join(path.dirname(root), `${path.basename(root)}-outside`);
  git(root, ["worktree", "add", "-q", "-b", "outside", outsideLane]);

  const db = await openKvDb(path.join(root, ".ade", "ade.db"), logger);
  const now = "2026-10-01T00:00:00.000Z";
  db.run(
    "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
    ["project-1", root, path.basename(root), "main", now, now],
  );
  const lanes: Array<[id: string, type: string, worktreePath: string, branch: string]> = [
    ["lane-primary", "primary", root, "main"],
    ["lane-alpha", "worktree", insideLane, "alpha"],
    ["lane-outside", "worktree", outsideLane, "outside"],
  ];
  for (const [id, type, worktreePath, branch] of lanes) {
    db.run(
      `insert into lanes(id, project_id, name, lane_type, base_ref, branch_ref, worktree_path, is_edit_protected, status, created_at)
       values (?, 'project-1', ?, ?, 'main', ?, ?, 0, 'active', ?)`,
      [id, id, type, branch, worktreePath, now],
    );
  }
  db.run("insert into kv(key, value) values (?, ?)", [`dock_layout:${root}`, "\"layout\""]);
  db.run("insert into kv(key, value) values (?, ?)", [`tiling_tree:${root}:files`, "\"tree\""]);
  // The lane beside the project shares its name as a prefix; its layout is not the project's.
  db.run("insert into kv(key, value) values (?, ?)", [`dock_layout:${outsideLane}`, "\"outside\""]);
  db.flushNow();
  db.close();

  new ProjectRegistry().add(root, { catalogVisibility: "recent", registrationSource: "test" });
  return { insideLane, outsideLane };
}

function commonDir(checkout: string): string {
  return fs.realpathSync(path.resolve(checkout, git(checkout, ["rev-parse", "--git-common-dir"])));
}

// The copy is made with macOS `ditto`/`mkbom`; the feature is macOS only.
describe.skipIf(process.platform !== "darwin")("runProjectMove", () => {
  it("moves the project with its lanes, tracked dependencies and data, and keeps the original parked", async () => {
    const source = path.join(tmp, "Proj");
    const { outsideLane } = await makeProject(source);
    const destination = path.join(tmp, "drive", "Proj");
    // A stale layout already saved under the new path must give way to the moved one.
    const record = await (async () => {
      const db = await openKvDb(path.join(source, ".ade", "ade.db"), logger);
      db.run("insert into kv(key, value) values (?, ?)", [`dock_layout:${destination}`, "\"stale\""]);
      db.flushNow();
      db.close();
      return runProjectMove({ sourceRoot: source, destinationRoot: destination, moveAgentHistory: false, hooks });
    })();

    expect(record.state, record.error).toBe("done");
    expect(record.problems).toEqual([]);

    // Dependencies git tracks travel; installed ones are reinstalled later.
    expect(fs.readFileSync(path.join(destination, "vendor", "node_modules", "patched", "index.js"), "utf8")).toBe("patched\n");
    expect(fs.existsSync(path.join(destination, "node_modules"))).toBe(false);

    // The lane inside keeps its uncommitted work and belongs to the moved repo.
    const movedLane = path.join(destination, ".ade", "worktrees", "alpha");
    expect(git(movedLane, ["status", "--porcelain"]).split("\n").sort()).toEqual([" M a.txt", "?? untracked.txt"]);
    expect(commonDir(movedLane)).toBe(path.join(destination, ".git"));
    // The lane outside stays where it is and follows the repo.
    expect(commonDir(outsideLane)).toBe(path.join(destination, ".git"));

    const dbPath = path.join(destination, ".ade", "ade.db");
    const lanes = queryDb<{ id: string; worktree_path: string }>(dbPath, "select id, worktree_path from lanes order by id");
    expect(lanes).toEqual([
      { id: "lane-alpha", worktree_path: movedLane },
      { id: "lane-outside", worktree_path: outsideLane },
      { id: "lane-primary", worktree_path: destination },
    ]);
    const kv = queryDb<{ key: string; value: string }>(dbPath, "select key, value from kv where key like 'dock_layout:%' or key like 'tiling_tree:%' order by key");
    expect(kv).toEqual([
      { key: `dock_layout:${outsideLane}`, value: "\"outside\"" },
      { key: `dock_layout:${destination}`, value: "\"layout\"" },
      { key: `tiling_tree:${destination}:files`, value: "\"tree\"" },
    ]);

    expect(record.originalParkedAt).toBeTruthy();
    expect(fs.existsSync(source)).toBe(false);
    expect(readMovedMarker(record.originalParkedAt!)).toMatchObject({ movedTo: destination, moveId: record.moveId });
    const registry = new ProjectRegistry();
    expect(registry.findByRootPath(destination)).not.toBeNull();
    expect(registry.findByRootPath(source)).toBeNull();
  });

  it("moves an already-moved project again, whose lanes now use relative links", async () => {
    const source = path.join(tmp, "Proj");
    const { outsideLane } = await makeProject(source);
    const first = path.join(tmp, "drive", "Proj");
    const second = path.join(tmp, "other", "Proj");
    expect((await runProjectMove({ sourceRoot: source, destinationRoot: first, moveAgentHistory: false, hooks })).state).toBe("done");

    const record = await runProjectMove({ sourceRoot: first, destinationRoot: second, moveAgentHistory: false, hooks });

    expect(record.state, record.error).toBe("done");
    const movedLane = path.join(second, ".ade", "worktrees", "alpha");
    expect(commonDir(movedLane)).toBe(path.join(second, ".git"));
    expect(commonDir(outsideLane)).toBe(path.join(second, ".git"));
    const lanes = queryDb<{ worktree_path: string }>(path.join(second, ".ade", "ade.db"), "select worktree_path from lanes order by id");
    expect(lanes.map((lane) => lane.worktree_path)).toEqual([movedLane, outsideLane, second]);
  });

  it("never removes a folder at the copy's place that ADE didn't create", async () => {
    const source = path.join(tmp, "Proj");
    await makeProject(source);
    const destination = path.join(tmp, "drive", "Proj");
    const theirs = copyLocation(destination);
    fs.mkdirSync(theirs, { recursive: true });
    fs.writeFileSync(path.join(theirs, "keep.txt"), "mine\n");
    // An earlier move into the same place that failed before it copied anything.
    writeMoveRecord(moveRecord({ moveId: "move_earlier", sourceRoot: source, destinationRoot: destination, state: "failed", copyCreated: false }));

    const record = await runProjectMove({ sourceRoot: source, destinationRoot: destination, moveAgentHistory: false, hooks });

    expect(record.state).toBe("failed");
    expect(fs.readFileSync(path.join(theirs, "keep.txt"), "utf8")).toBe("mine\n");
    expect(fs.existsSync(path.join(source, ".ade", "ade.db"))).toBe(true);
  });

  it("replaces a partial copy its own earlier failed move left behind", async () => {
    const source = path.join(tmp, "Proj");
    await makeProject(source);
    const destination = path.join(tmp, "drive", "Proj");
    fs.mkdirSync(copyLocation(destination), { recursive: true });
    fs.writeFileSync(path.join(copyLocation(destination), "partial.txt"), "half\n");
    writeMoveRecord(moveRecord({ moveId: "move_earlier", sourceRoot: source, destinationRoot: destination, state: "failed", copyCreated: true }));

    const record = await runProjectMove({ sourceRoot: source, destinationRoot: destination, moveAgentHistory: false, hooks });

    expect(record.state, record.error).toBe("done");
    expect(fs.existsSync(path.join(destination, "partial.txt"))).toBe(false);
  });
});

function moveRecord(overrides: Partial<ProjectMoveRecord> & Pick<ProjectMoveRecord, "moveId" | "sourceRoot" | "destinationRoot">): ProjectMoveRecord {
  return {
    projectName: path.basename(overrides.sourceRoot),
    originalParkedAt: null,
    originalBytes: 0,
    destinationVolumeUuid: null,
    destinationVolumeName: null,
    destinationInternal: false,
    startedAt: Date.now(),
    finishedAt: null,
    state: "running",
    cleanup: { choice: "pending" },
    followUps: [],
    problems: [],
    // A pid that cannot be running: the process that ran the move is gone.
    pid: 0,
    bootMinute: currentBootMinute(),
    resume: { sourceSpellings: [overrides.sourceRoot], knownPaths: [overrides.sourceRoot], moveAgentHistory: false, outsideLanes: [] },
    ...overrides,
  };
}

describe("recoverInterruptedMoves", () => {
  it("finishes a move whose copy was already in place, and waits while its drive is missing", async () => {
    const source = path.join(tmp, "Proj");
    const parked = path.join(tmp, "Proj (moved to Dev)");
    const destination = path.join(tmp, "drive", "Proj");
    fs.mkdirSync(parked, { recursive: true });
    writeMoveRecord(moveRecord({ moveId: "move_switched", sourceRoot: source, destinationRoot: destination, originalParkedAt: parked, switched: true, copyCreated: true }));

    // Drive unplugged: nothing is undone and the move stays open.
    expect((await recoverInterruptedMoves()).settled).toEqual([]);
    expect(fs.existsSync(parked)).toBe(true);
    expect(fs.existsSync(source)).toBe(false);

    fs.mkdirSync(destination, { recursive: true });
    const { settled, tidyUp } = await recoverInterruptedMoves();
    await tidyUp;
    expect(settled.map((record) => record.state)).toEqual(["done"]);
    // Never rolled back: the original stays parked and is marked as the old copy.
    expect(fs.existsSync(source)).toBe(false);
    expect(readMovedMarker(parked)).toMatchObject({ movedTo: destination, moveId: "move_switched" });
  });

  it("puts the original back and removes the partial copy of a move that hadn't switched", async () => {
    const source = path.join(tmp, "Proj");
    const parked = path.join(tmp, "Proj (moved to Dev)");
    const destination = path.join(tmp, "drive", "Proj");
    fs.mkdirSync(parked, { recursive: true });
    fs.writeFileSync(path.join(parked, "a.txt"), "original\n");
    fs.mkdirSync(copyLocation(destination), { recursive: true });
    writeMoveRecord(moveRecord({ moveId: "move_mid", sourceRoot: source, destinationRoot: destination, parkingAt: parked, copyCreated: true }));

    const { settled, tidyUp } = await recoverInterruptedMoves();
    await tidyUp;

    expect(settled.map((record) => record.state)).toEqual(["failed"]);
    expect(fs.readFileSync(path.join(source, "a.txt"), "utf8")).toBe("original\n");
    expect(fs.readdirSync(path.dirname(destination))).toEqual([]);
  });

  it("leaves a folder at the copy's place alone when the move never created it", async () => {
    const source = path.join(tmp, "Proj");
    const destination = path.join(tmp, "drive", "Proj");
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(copyLocation(destination), { recursive: true });
    writeMoveRecord(moveRecord({ moveId: "move_early", sourceRoot: source, destinationRoot: destination, copyCreated: false }));

    const { tidyUp } = await recoverInterruptedMoves();
    await tidyUp;

    expect(fs.existsSync(copyLocation(destination))).toBe(true);
    expect(listMoveRecords().map((record) => record.state)).toEqual(["failed"]);
  });

  it("leaves a move alone while the process running it is alive", async () => {
    const source = path.join(tmp, "Proj");
    fs.mkdirSync(source, { recursive: true });
    writeMoveRecord(moveRecord({ moveId: "move_live", sourceRoot: source, destinationRoot: path.join(tmp, "drive", "Proj"), pid: process.ppid }));

    expect((await recoverInterruptedMoves()).settled).toEqual([]);
    expect(listMoveRecords().map((record) => record.state)).toEqual(["running"]);
  });
});

describe("isMoveProcessAlive", () => {
  const exited = spawnSync(process.execPath, ["-e", "0"]).pid!;
  const boot = currentBootMinute();

  it.each([
    ["this process, running that move", { moveId: "move_here", pid: process.pid, bootMinute: boot }, true],
    ["this process, not running that move (a reused pid)", { moveId: "move_other", pid: process.pid, bootMinute: boot }, false],
    ["another live process", { moveId: "move_a", pid: process.ppid, bootMinute: boot }, true],
    ["a live pid recorded before a reboot", { moveId: "move_b", pid: process.ppid, bootMinute: boot - 600 }, false],
    ["a process that exited", { moveId: "move_c", pid: exited, bootMinute: boot }, false],
    ["no pid", { moveId: "move_d", pid: 0, bootMinute: boot }, false],
  ])("%s", (_label, record, alive) => {
    markMoveActive("move_here", true);
    try {
      expect(isMoveProcessAlive(record)).toBe(alive);
    } finally {
      markMoveActive("move_here", false);
    }
  });

  it.skipIf(process.getuid?.() === 0)("counts a process owned by another user as alive", () => {
    // launchd / init: signalling it is refused (EPERM), which means it exists.
    expect(isMoveProcessAlive({ moveId: "move_e", pid: 1, bootMinute: boot })).toBe(true);
  });
});

describe("relativeToRoot", () => {
  it("matches the root's own spelling only at a folder boundary, and other casings when the disk ignores case", () => {
    const root = path.join(tmp, "Proj");
    fs.mkdirSync(root);
    const diskIgnoresCase = fs.existsSync(path.join(tmp, "PROJ"));

    expect(relativeToRoot(`${root}/lanes/a`, [root])).toBe("lanes/a");
    expect(relativeToRoot(root, [root])).toBe("");
    expect(relativeToRoot(`${root}-other/a`, [root])).toBeNull();
    expect(relativeToRoot(path.join(tmp, "proj", "lanes", "a"), [root])).toBe(diskIgnoresCase ? "lanes/a" : null);
  });
});
