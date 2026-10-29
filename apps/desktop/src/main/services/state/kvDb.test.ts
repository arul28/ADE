import fs from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { build } from "esbuild";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openKvDb,
  rebuildTableInTransaction,
  sweepOrphanedRepairStagingTables,
  type TableRebuildPlan,
} from "./kvDb";
import { isCrsqliteAvailable } from "./crsqliteExtension";
import { stripCrrUnsupportedTableConstraints } from "./sqliteDdl";
import { EVENT_LOG_RETENTION_DAYS } from "./dbMaintenanceApi";

const testRequire = createRequire(import.meta.url);
const { DatabaseSync } = testRequire("node:sqlite") as {
  DatabaseSync: new (dbPath: string) => DatabaseSyncType;
};

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as const;
}

/**
 * Every unique index on `table` other than the primary key — i.e. exactly what
 * `crsql_as_crr` refuses to turn into a CRR.
 *
 * Must NOT be written as `sqlite_master.sql like '%unique%'`: `sql` is NULL for
 * implicitly created indexes, so a UNIQUE column/table constraint (which yields
 * `sqlite_autoindex_<table>_N`) would never match and the guard would pass on
 * the very schema it exists to catch. `pragma index_list` reports those, with
 * `origin` distinguishing 'pk' (allowed) from 'u' (UNIQUE constraint) and
 * 'c' (CREATE UNIQUE INDEX).
 */
function blockingUniqueIndexes(
  db: Awaited<ReturnType<typeof openKvDb>>,
  table: string,
): { name: string; origin: string }[] {
  return db
    .all<{ name: string; unique: number; origin: string }>(`pragma index_list('${table}')`)
    .filter((index) => Number(index.unique) === 1 && index.origin !== "pk")
    .map((index) => ({ name: index.name, origin: index.origin }));
}

function makeProjectRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, ".ade", "artifacts"), { recursive: true });
  return root;
}

function insertProjectGraph(db: Awaited<ReturnType<typeof openKvDb>>) {
  const now = "2026-03-17T00:00:00.000Z";
  db.run(
    `insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
     values (?, ?, ?, ?, ?, ?)`,
    ["project-1", "/repo/ade", "ADE", "main", now, now],
  );
  db.run(
    `insert into lanes(
      id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path, attached_root_path,
      is_edit_protected, parent_lane_id, color, icon, tags_json, folder, status, created_at, archived_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "lane-primary",
      "project-1",
      "Primary",
      null,
      "primary",
      "main",
      "main",
      "/repo/ade",
      null,
      1,
      null,
      null,
      null,
      null,
      null,
      "active",
      now,
      null,
    ],
  );
  db.run(
    `insert into lanes(
      id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path, attached_root_path,
      is_edit_protected, parent_lane_id, color, icon, tags_json, folder, status, created_at, archived_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "lane-child",
      "project-1",
      "linear test",
      null,
      "worktree",
      "main",
      "ade/linear-test",
      "/repo/ade/.ade/worktrees/linear-test",
      null,
      0,
      "lane-primary",
      null,
      null,
      null,
      null,
      "active",
      "2026-03-17T00:05:00.000Z",
      null,
    ],
  );
  db.run(
    `insert into lane_state_snapshots(
      lane_id, dirty, ahead, behind, remote_behind, rebase_in_progress, agent_summary_json, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["lane-primary", 0, 0, 0, 0, 0, null, now],
  );
  db.run(
    `insert into lane_state_snapshots(
      lane_id, dirty, ahead, behind, remote_behind, rebase_in_progress, agent_summary_json, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["lane-child", 1, 0, 1, 0, 0, null, "2026-03-17T00:05:00.000Z"],
  );
}

function insertSessionAndPr(db: Awaited<ReturnType<typeof openKvDb>>) {
  const now = "2026-03-17T00:10:00.000Z";
  db.run(
    `insert into terminal_sessions(
      id, lane_id, pty_id, tracked, goal, tool_type, pinned, title, started_at, ended_at,
      exit_code, transcript_path, head_sha_start, head_sha_end, status, last_output_preview,
      last_output_at, summary, resume_command
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "session-1",
      "lane-child",
      null,
      1,
      "Ship W5",
      "shell",
      0,
      "npm test",
      now,
      null,
      null,
      "/tmp/session-1.log",
      null,
      null,
      "running",
      "Tests starting",
      now,
      null,
      "npm test",
    ],
  );
  db.run(
    `insert into pull_requests(
      id, project_id, lane_id, repo_owner, repo_name, github_pr_number, github_url, github_node_id,
      title, state, base_branch, head_branch, checks_status, review_status, additions, deletions,
      last_synced_at, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "pr-1",
      "project-1",
      "lane-child",
      "arul",
      "ade",
      42,
      "https://github.com/arul/ade/pull/42",
      "node-42",
      "Fix mobile hydration",
      "open",
      "main",
      "ade/linear-test",
      "pending",
      "requested",
      12,
      4,
      now,
      now,
      now,
    ],
  );
  db.run(
    `insert into pull_request_snapshots(
      pr_id, detail_json, status_json, checks_json, reviews_json, comments_json, files_json, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "pr-1",
      JSON.stringify({
        prId: "pr-1",
        body: "Hydration fix",
        assignees: [],
        author: { login: "arul", avatarUrl: null },
        isDraft: false,
        labels: [],
        requestedReviewers: [],
        milestone: null,
        linkedIssues: [],
      }),
      JSON.stringify({
        prId: "pr-1",
        state: "open",
        checksStatus: "pending",
        reviewStatus: "requested",
        isMergeable: true,
        mergeConflicts: false,
        behindBaseBy: 0,
      }),
      "[]",
      "[]",
      "[]",
      "[]",
      now,
    ],
  );
}

const activeDisposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (activeDisposers.length > 0) {
    const dispose = activeDisposers.pop();
    if (dispose) await dispose();
  }
});

describe("openKvDb SQL binding", () => {
  // Windows holds SQLite's open files against rename; this relocation is a
  // POSIX failure mode. The native-boundary identity guard is cross-platform.
  it.skipIf(process.platform === "win32").each([false, true])("pauses a moved database and resumes after restoration (replacement: %s)", async (replacement) => {
    const fixtureParent = path.join(process.cwd(), "node_modules", ".cache");
    fs.mkdirSync(fixtureParent, { recursive: true });
    const projectRoot = fs.mkdtempSync(path.join(fixtureParent, "ade-kvdb-relocation-"));
    const adePath = path.join(projectRoot, ".ade");
    const movedPath = path.join(projectRoot, "moved-ade");
    const dbPath = path.join(adePath, "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => {
      db.close();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    });
    db.setJson("relocation:probe", "original");
    db.flushNow();
    fs.renameSync(adePath, movedPath);
    if (replacement) {
      fs.mkdirSync(adePath);
      fs.copyFileSync(path.join(movedPath, "ade.db"), dbPath);
    }
    const movedContents = fs.readFileSync(path.join(movedPath, "ade.db"));
    const operations = [
      () => db.setJson("relocation:probe", "unsafe"),
      () => db.getJson("relocation:probe"),
      () => db.run("delete from kv"),
      () => db.runChanged("delete from kv"),
      () => db.get("select * from kv"),
      () => db.all("select * from kv"),
      () => db.flushNow(),
      () => db.maintenance!.prunePrSnapshots(),
    ];
    for (const operation of operations) {
      expect(operation).toThrowError(expect.objectContaining({ code: "db_path_changed" }));
    }
    await expect(db.maintenance!.pruneEventLogs()).rejects.toMatchObject({ code: "db_path_changed" });
    if (db.sync?.isAvailable?.()) {
      expect(() => db.sync!.exportChangesSince(0)).toThrowError(expect.objectContaining({ code: "db_path_changed" }));
    }
    expect(fs.readFileSync(path.join(movedPath, "ade.db"))).toEqual(movedContents);
    expect(fs.existsSync(path.join(movedPath, "ade.db-wal")) && fs.statSync(path.join(movedPath, "ade.db-wal")).size).toBe(0);
    if (replacement) fs.rmSync(adePath, { recursive: true });
    fs.renameSync(movedPath, adePath);
    expect(db.getJson("relocation:probe")).toBe("original");
    db.setJson("relocation:probe", "resumed");
    expect(db.getJson("relocation:probe")).toBe("resumed");
  });

  // Exercise a native storage boundary that checkpoints on close, even on
  // SQLite builds whose own moved-file detection normally prevents it.
  // A child process also proves GC/exit safety without disturbing its locks
  // by reading the database bytes in the same process that owns the handle.
  it.skipIf(process.platform === "win32").each(["exit", "restore"])("preserves pending WAL through relocated shutdown and GC (%s)", async (mode) => {
    const fixtureParent = path.join(process.cwd(), "node_modules", ".cache");
    fs.mkdirSync(fixtureParent, { recursive: true });
    const projectRoot = fs.mkdtempSync(path.join(fixtureParent, "ade-kvdb-shutdown-"));
    activeDisposers.push(async () => fs.rmSync(projectRoot, { recursive: true, force: true }));
    const workerPath = path.join(projectRoot, "shutdown.cjs");
    await build({
      stdin: {
        resolveDir: process.cwd(),
        contents: `
          import fs from "node:fs";
          import path from "node:path";
          import { DatabaseSync } from "node:sqlite";
          import { openKvDb } from "./src/main/services/state/kvDb";
          (async () => {
            const root = process.argv[2];
            const adeDir = path.join(root, ".ade");
            const moved = path.join(root, "moved");
            const logger = { debug() {}, info() {}, warn() {}, error() {} };
            let db = await openKvDb(path.join(adeDir, "ade.db"), logger);
            db.flushNow();
            db.setJson("shutdown:pending", "committed");
            const nativeClose = DatabaseSync.prototype.close;
            DatabaseSync.prototype.close = function () {
              if (fs.existsSync(moved)) {
                const checkpoint = new DatabaseSync(path.join(moved, "ade.db"));
                checkpoint.exec("pragma wal_checkpoint(TRUNCATE)");
                nativeClose.call(checkpoint);
              }
              return nativeClose.call(this);
            };
            fs.renameSync(adeDir, moved);
            const wait = () => new Promise((resolve) => process.once("message", resolve));
            process.send("ready");
            await wait();
            db.close();
            const disposed = process.argv[3] === "restore" ? db : null;
            db = null;
            global.gc();
            global.gc();
            if (disposed) {
              process.send("paused");
              await wait();
              fs.renameSync(moved, adeDir);
              const restored = await openKvDb(path.join(adeDir, "ade.db"), logger);
              let released = false;
              try { disposed.getJson("shutdown:pending"); } catch { released = true; }
              if (!released) throw new Error("Restored handle was not released");
              if (restored.getJson("shutdown:pending") !== "committed") throw new Error("Lost pending changes");
              restored.close();
            }
          })().catch((error) => { console.error(error); process.exitCode = 1; })
            .finally(() => process.disconnect());
        `,
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: workerPath,
      logLevel: "silent",
    });
    const child = spawn(process.execPath, ["--expose-gc", workerPath, projectRoot, mode], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    child.stderr?.on("data", (data) => { stderr += String(data); });
    const exit = once(child, "exit");
    try {
      const nextMessage = () => Promise.race([
        once(child, "message"),
        exit.then(() => { throw new Error(`Child exited before its receipt: ${stderr}`); }),
      ]);
      await nextMessage();
      const moved = path.join(projectRoot, "moved");
      const before = ["ade.db", "ade.db-wal"].map((file) => fs.readFileSync(path.join(moved, file)));
      expect(before[1]!.length).toBeGreaterThan(0);
      const paused = mode === "restore" ? nextMessage() : null;
      child.send("shutdown");
      if (paused) await paused;
      else expect((await exit)[0], stderr).toBe(0);
      for (const [index, file] of ["ade.db", "ade.db-wal"].entries()) {
        expect(fs.readFileSync(path.join(moved, file)).equals(before[index]!)).toBe(true);
      }
      if (paused) {
        child.send("restore");
        expect((await exit)[0], stderr).toBe(0);
      }
      const recovered = new DatabaseSync(path.join(projectRoot, mode === "exit" ? "moved" : ".ade", "ade.db"));
      try {
        expect(recovered.prepare("select value from kv where key = ?").get("shutdown:pending")).toEqual({ value: '"committed"' });
      } finally {
        recovered.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exit;
      }
    }
  });

  it("binds boolean params and reports unsupported param types with context", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-bind-values-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => db.close());

    db.run("create table if not exists db_value_test(flag integer not null)");
    db.run("insert into db_value_test(flag) values (?)", [true]);
    expect(db.get<{ flag: number }>("select flag from db_value_test limit 1")?.flag).toBe(1);

    expect(() =>
      db.run("insert into db_value_test(flag) values (?)", [{} as any]),
    ).toThrow(/Unsupported database value at parameter 1: object .*sql=insert into db_value_test/i);
    expect(() =>
      db.get("select flag from db_value_test where flag = ?", [{} as any]),
    ).toThrow(/Unsupported database value at parameter 1: object .*sql=select flag from db_value_test/i);
    expect(() =>
      db.all("select flag from db_value_test where flag = ?", [{} as any]),
    ).toThrow(/Unsupported database value at parameter 1: object .*sql=select flag from db_value_test/i);
  });

  it("checkpoints pending writes when flushed", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-flush-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => db.close());

    db.setJson("flush:probe", { ok: true });
    expect(() => db.flushNow()).not.toThrow();
    expect(db.getJson<{ ok: boolean }>("flush:probe")).toEqual({ ok: true });
  });
});

describe("openKvDb against a peer holding the database", () => {
  // `PRAGMA journal_mode = WAL` needs an EXCLUSIVE lock, which a sibling ADE
  // process (the brain and the desktop main process both open the same
  // `<project>/.ade/ade.db`) can refuse for the whole write timeout. A peer
  // transaction on a database that is not yet in WAL is exactly that case.
  it("waits a peer out for WAL instead of failing on its lock", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-wal-contended-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const peer = new DatabaseSync(dbPath);
    peer.exec("create table peer_probe(value integer)");
    peer.exec("insert into peer_probe(value) values (1)");
    peer.exec("BEGIN");
    peer.prepare("select * from peer_probe").all();
    let peerInTransaction = true;
    const release = () => {
      if (!peerInTransaction) return;
      peerInTransaction = false;
      peer.exec("ROLLBACK");
    };
    // The peer finishes its transaction as soon as the open first yields. The
    // old open never yielded: it blocked inside the native busy handler for the
    // whole 5,000 ms write timeout and then threw.
    const releaseTimer = setTimeout(release, 0);
    activeDisposers.push(async () => {
      clearTimeout(releaseTimer);
      release();
      peer.close();
    });

    const warnings: string[] = [];
    const settled: Array<{ attempt: number }> = [];
    const logger = {
      debug: () => {},
      info: (event: string, data: { attempt: number }) => { if (event === "db.wal_conversion_settled") settled.push(data); },
      warn: (event: string) => { warnings.push(event); },
      error: () => {},
    };
    const db = await openKvDb(dbPath, logger as never);
    activeDisposers.push(async () => db.close());

    // The conversion still won — an open left in rollback mode would make every
    // later write wait on the peer instead — and it won on a retry after one
    // short attempt, not by spending the connection's 5,000 ms write timeout on
    // one blocked call.
    expect(db.all<{ journal_mode: string }>("pragma journal_mode")[0]?.journal_mode).toBe("wal");
    expect(settled).toEqual([{ attempt: 2 }]);
    expect(warnings).not.toContain("db.wal_conversion_deferred");
    db.setJson("wal:contended", { ok: true });
    expect(db.getJson<{ ok: boolean }>("wal:contended")).toEqual({ ok: true });
  });

  // A peer holding an EXCLUSIVE lock refuses reads as well as the conversion, so
  // the open's first journal-mode read is refused too. That read must not fail
  // the open: the conversion is retried (or deferred), and the open still succeeds.
  it("opens while a peer holds an EXCLUSIVE lock, without throwing on the first read", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-wal-exclusive-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    (await openKvDb(dbPath, createLogger() as any)).close();
    const reset = new DatabaseSync(dbPath);
    reset.exec("PRAGMA journal_mode = DELETE");
    reset.close();

    const peer = new DatabaseSync(dbPath);
    peer.exec("BEGIN EXCLUSIVE");
    let peerInTransaction = true;
    const release = () => {
      if (!peerInTransaction) return;
      peerInTransaction = false;
      peer.exec("ROLLBACK");
    };
    const releaseTimer = setTimeout(release, 0);
    activeDisposers.push(async () => {
      clearTimeout(releaseTimer);
      release();
      peer.close();
    });

    const db = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => db.close());
    db.setJson("wal:exclusive", { ok: true });
    expect(db.getJson<{ ok: boolean }>("wal:exclusive")).toEqual({ ok: true });
  });

  it("defers the WAL conversion after one attempt when the budget runs out, and still opens", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-wal-budget-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    // Initialise the schema, then drop the database back to rollback mode.
    (await openKvDb(dbPath, createLogger() as any)).close();
    const reset = new DatabaseSync(dbPath);
    reset.exec("PRAGMA journal_mode = DELETE");
    reset.close();

    const peer = new DatabaseSync(dbPath);
    peer.exec("BEGIN");
    peer.prepare("select * from kv").all();
    let peerInTransaction = true;
    const releasePeer = () => {
      if (!peerInTransaction) return;
      peerInTransaction = false;
      peer.exec("ROLLBACK");
    };
    activeDisposers.push(async () => {
      releasePeer();
      peer.close();
    });

    // The conversion budget is 8 s of wall clock. Advance the clock past it on
    // the read after the first failed attempt, so the test does not wait the
    // budget out. The peer still holds its lock through that one attempt.
    const realNow = Date.now();
    let clockReads = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => (clockReads++ === 0 ? realNow : realNow + 60_000));

    const warnings: string[] = [];
    let deferredAttempts: number | undefined;
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (event: string, data: { attempts?: number }) => {
        warnings.push(event);
        if (event !== "db.wal_conversion_deferred") return;
        deferredAttempts = data.attempts;
        // Stand in for the peer finishing once this process has moved on: the
        // open's own writes (migrations) then go through on their own budget.
        releasePeer();
      },
      error: () => {},
    };
    let db: Awaited<ReturnType<typeof openKvDb>>;
    const startedAt = performance.now();
    try {
      db = await openKvDb(dbPath, logger as never);
    } finally {
      nowSpy.mockRestore();
    }
    const elapsedMs = performance.now() - startedAt;
    activeDisposers.push(async () => db.close());

    // The conversion gave up after its single attempt rather than retrying for
    // the budget, and the open still produced a usable database. The final
    // journal mode is not pinned here: a later open step may convert it again.
    expect(warnings).toContain("db.wal_conversion_deferred");
    expect(deferredAttempts).toBe(1);
    // One blocked attempt is 150 ms; the 5,000 ms connection timeout must not
    // be spent on the blocked conversion.
    expect(elapsedMs).toBeLessThan(3000);
    db.setJson("wal:deferred", { ok: true });
    expect(db.getJson<{ ok: boolean }>("wal:deferred")).toEqual({ ok: true });
  });
});

describe("GitHub stacked pull request schema", () => {
  it("stores repository stacks and their ordered pull requests locally", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-github-stacks-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => db.close());

    expect(
      db.all<{ name: string }>("pragma table_info('github_pr_stacks')").map((row) => row.name),
    ).toEqual(expect.arrayContaining([
      "project_id",
      "repo_owner",
      "repo_name",
      "github_stack_number",
      "github_stack_id",
      "base_branch",
      "is_open",
      "synced_at",
      "last_error",
    ]));
    expect(
      db.all<{ name: string }>("pragma table_info('github_pr_stack_entries')").map((row) => row.name),
    ).toEqual(expect.arrayContaining([
      "project_id",
      "repo_owner",
      "repo_name",
      "github_stack_number",
      "github_pr_number",
      "position",
      "state",
      "is_draft",
      "merged_at",
      "head_branch",
      "head_sha",
    ]));
    expect(
      db.all<{ name: string; unique: number }>("pragma index_list('github_pr_stack_entries')")
        .find((index) => index.name === "idx_github_pr_stack_entries_membership"),
    ).toEqual(expect.objectContaining({ unique: 1 }));
    expect(
      db.all<{ table: string; on_delete: string }>("pragma foreign_key_list('github_pr_stack_entries')")
        .some((foreignKey) =>
          foreignKey.table === "github_pr_stacks" && foreignKey.on_delete.toLowerCase() === "cascade"),
    ).toBe(true);
  });

  it("rebuilds a table whose foreign key wraps onto its own references line", async () => {
    // `github_pr_stack_entries` above carries a foreign key whose `references`
    // and `on delete` sit on their own lines. The repair that strips foreign
    // keys out of stored DDL used to work one line at a time, so it deleted the
    // `foreign key(` line and kept the continuation: SQLite rejected
    // `…, references github_pr_stacks(…) on delete cascade )` and the whole
    // database failed to open. An older CLI opening a newer database hit
    // exactly that, which is why this fixture repeats the wrapped shape under a
    // name the local-only exclusion list does not cover.
    const projectRoot = makeProjectRoot("ade-kvdb-wrapped-foreign-key-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const first = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(first);

    first.run(`
      create table repair_probe_entries (
        project_id text not null,
        repo_owner text collate nocase not null,
        repo_name text collate nocase not null,
        github_stack_number integer not null,
        github_pr_number integer not null,
        position integer not null,
        primary key(project_id, repo_owner, repo_name, github_stack_number, github_pr_number),
        foreign key(project_id) references projects(id),
        foreign key(project_id, repo_owner, repo_name, github_stack_number)
          references github_pr_stacks(project_id, repo_owner, repo_name, github_stack_number)
          on delete cascade
      )
    `);
    first.run(
      `create unique index uq_repair_probe_entries_position
         on repair_probe_entries(project_id, github_stack_number, position)`,
    );
    // The probe's foreign keys are enforced on write, so the parent stack has
    // to exist before the child row does.
    first.run(
      `insert into github_pr_stacks(
         project_id, repo_owner, repo_name, github_stack_number, github_stack_id,
         base_branch, created_at, synced_at
       ) values ('project-1', 'arul28', 'ADE', 7, 'S_7', 'main',
                 '2026-03-17T00:00:00.000Z', '2026-03-17T00:00:00.000Z')`,
    );
    first.run(
      `insert into repair_probe_entries(
         project_id, repo_owner, repo_name, github_stack_number, github_pr_number, position
       ) values ('project-1', 'arul28', 'ADE', 7, 42, 1)`,
    );
    first.close();

    // Reopening IS the assertion: the rewritten DDL has to be valid SQLite.
    const reopened = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => reopened.close());

    expect(
      reopened.get<{ position: number }>(
        "select position from repair_probe_entries where project_id = ? and github_pr_number = ?",
        ["project-1", 42],
      )?.position,
    ).toBe(1);
    const storedSql = (
      reopened.get<{ sql: string }>(
        "select sql from sqlite_master where type = 'table' and name = 'repair_probe_entries'",
      )?.sql ?? ""
    ).toLowerCase();
    expect(storedSql).not.toContain("references");
    expect(storedSql).not.toContain("foreign key");
    expect(blockingUniqueIndexes(reopened, "repair_probe_entries")).toEqual([]);
  });
});

describe("lane_linear_issue_links schema", () => {
  it("does not keep a non-PK unique index that blocks crsql_as_crr", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-linear-issue-links-index-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => db.close());

    expect(
      db.get<{ present: number }>(
        "select 1 as present from sqlite_master where type = 'index' and name = 'uq_lane_linear_issue_links_role' limit 1",
      ),
    ).toBeNull();
  });
});

describe("terminal_sessions snooze + settle-override schema", () => {
  it("adds the columns as nullable text", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-terminal-sessions-snooze-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => db.close());

    const columns = db.all<{ name: string; type: string; notnull: number }>(
      "pragma table_info('terminal_sessions')",
    );
    for (const name of [
      "attention_source",
      "settle_override",
      "settle_source",
      "snoozed_until",
      "snoozed_at",
      "woke_at",
      "woke_reason",
    ]) {
      const column = columns.find((entry) => entry.name === name);
      expect(column, `${name} column missing`).toBeTruthy();
      expect(column?.type.toLowerCase()).toBe("text");
      // Nullable is mandatory: these columns replicate to iOS through
      // cr-sqlite and existing rows must merge without a value.
      expect(column?.notnull).toBe(0);
    }
  });

  it("carries no non-PK unique index that would block crsql_as_crr", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-terminal-sessions-index-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => db.close());

    expect(blockingUniqueIndexes(db, "terminal_sessions")).toEqual([]);
  });
});

describe("session_linear_issues schema", () => {
  it("creates the table with session/lane/issue columns", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-session-linear-cols-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => db.close());

    const columns = db
      .all<{ name: string }>("pragma table_info('session_linear_issues')")
      .map((row) => row.name);
    expect(columns).toEqual(expect.arrayContaining([
      "id",
      "project_id",
      "session_id",
      "lane_id",
      "issue_id",
      "issue_json",
      "role",
      "source",
      "include_in_pr",
      "close_on_merge",
      "evidence_json",
      "created_at",
      "updated_at",
    ]));
  });

  it("carries no non-PK unique index that would block crsql_as_crr", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-session-linear-index-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => db.close());

    expect(blockingUniqueIndexes(db, "session_linear_issues")).toEqual([]);
  });
});

describe.skipIf(!isCrsqliteAvailable())("openKvDb CRR repair", () => {
  it("enables CRR on lane_linear_issue_links without a blocking unique index", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-linear-issue-links-crr-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => db.close());

    expect(() => db.get("select crsql_as_crr(?) as ok", ["lane_linear_issue_links"])).not.toThrow();
    expect(
      db.get<{ present: number }>(
        "select 1 as present from sqlite_master where type = 'table' and name = 'lane_linear_issue_links__crsql_clock' limit 1",
      )?.present,
    ).toBe(1);
  });

  it("enables CRR on session_linear_issues without a blocking unique index", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-session-linear-crr-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => db.close());

    expect(() => db.get("select crsql_as_crr(?) as ok", ["session_linear_issues"])).not.toThrow();
    expect(
      db.get<{ present: number }>(
        "select 1 as present from sqlite_master where type = 'table' and name = 'session_linear_issues__crsql_clock' limit 1",
      )?.present,
    ).toBe(1);
  });

  it("keeps the composite-key PR auto-link ignore table local-only", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-auto-link-ignores-local-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => db.close());

    expect(
      db.get<{ present: number }>(
        "select 1 as present from sqlite_master where type = 'table' and name = 'pr_auto_link_ignores__crsql_clock' limit 1",
      ),
    ).toBeNull();
    expect(
      db.get<{ present: number }>(
        "select 1 as present from sqlite_master where type = 'table' and name = 'pr_auto_link_ignores__crsql_pks' limit 1",
      ),
    ).toBeNull();
  });

  it("removes stale CRR metadata for a local-only table", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-auto-link-ignores-crr-cleanup-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const first = await openKvDb(dbPath, createLogger() as any);
    first.run("create table pr_auto_link_ignores__crsql_clock(dummy integer)");
    first.run("create table pr_auto_link_ignores__crsql_pks(dummy integer)");
    first.run(`
      create trigger pr_auto_link_ignores__crsql_utrig
      after update on pr_auto_link_ignores
      begin
        select 1;
      end
    `);
    first.close();

    const reopened = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => reopened.close());

    expect(
      reopened.get<{ present: number }>(
        "select 1 as present from sqlite_master where type = 'table' and name = 'pr_auto_link_ignores__crsql_clock' limit 1",
      ),
    ).toBeNull();
    expect(
      reopened.get<{ present: number }>(
        "select 1 as present from sqlite_master where type = 'table' and name = 'pr_auto_link_ignores__crsql_pks' limit 1",
      ),
    ).toBeNull();
    expect(
      reopened.get<{ present: number }>(
        "select 1 as present from sqlite_master where type = 'trigger' and name = 'pr_auto_link_ignores__crsql_utrig' limit 1",
      ),
    ).toBeNull();
  });

  it("removes metadata-only CRR rows for a local-only table", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-auto-link-ignores-crr-metadata-only-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const first = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(first);
    insertSessionAndPr(first);
    // Old builds' schema retrofit stripped checked FK constraints from every
    // non-CRR table, so a DB that an older build mis-converted to CRR has the
    // FK-less shape on disk. Recreate that legacy shape here — the current
    // retrofit intentionally no longer rewrites CRR-excluded tables, and
    // crsql_as_crr refuses tables with checked foreign keys.
    first.run("drop table pr_auto_link_ignores");
    first.run(`
      create table pr_auto_link_ignores (
        project_id text not null,
        repo_owner text not null default '',
        repo_name text not null default '',
        github_pr_number integer not null default 0,
        lane_id text not null,
        head_branch text,
        created_at text not null default '',
        primary key(project_id, repo_owner, repo_name, github_pr_number, lane_id)
      )
    `);
    first.get("select crsql_as_crr(?)", ["pr_auto_link_ignores"]);
    first.run(
      `insert into pr_auto_link_ignores(project_id, repo_owner, repo_name, github_pr_number, lane_id, created_at)
       values (?, ?, ?, ?, ?, ?)`,
      ["proj-1", "acme", "ade", 1, "lane-1", "2026-03-17T00:00:00.000Z"],
    );
    expect(first.get<{ count: number }>("select count(1) as count from crsql_changes where [table] = ?", ["pr_auto_link_ignores"])?.count).toBeGreaterThan(0);
    for (const trigger of first.all<{ name: string }>(
      "select name from sqlite_master where type = 'trigger' and tbl_name = ? and name like ?",
      ["pr_auto_link_ignores", "pr_auto_link_ignores__crsql_%trig"],
    )) {
      first.run(`drop trigger if exists "${trigger.name}"`);
    }
    first.run("drop table pr_auto_link_ignores__crsql_clock");
    first.run("drop table pr_auto_link_ignores__crsql_pks");
    first.close();

    const reopened = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => reopened.close());

    expect(
      reopened.get<{ count: number }>(
        "select count(1) as count from crsql_changes where [table] = ?",
        ["pr_auto_link_ignores"],
      )?.count,
    ).toBe(0);
  });

  it("keeps the config-snapshot test_suites table local-only", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-config-snapshot-local-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => db.close());

    for (const table of ["test_suites"]) {
      expect(
        db.get<{ present: number }>(
          `select 1 as present from sqlite_master where type = 'table' and name = '${table}__crsql_clock' limit 1`,
        ),
      ).toBeNull();
      expect(
        db.get<{ present: number }>(
          `select 1 as present from sqlite_master where type = 'trigger' and tbl_name = '${table}' and name like '${table}__crsql_%trig' limit 1`,
        ),
      ).toBeNull();
    }
  });


  it("backfills phone-critical tables whose rows predate CRR enablement", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-pre-crr-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const first = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(first);
    insertSessionAndPr(first);

    first.run("drop table terminal_sessions__crsql_clock");
    first.run("drop table terminal_sessions__crsql_pks");
    first.run("drop table pull_request_snapshots__crsql_clock");
    first.run("drop table pull_request_snapshots__crsql_pks");
    first.close();

    const reopened = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => reopened.close());

    expect(reopened.get<{ count: number }>("select count(1) as count from terminal_sessions__crsql_pks")?.count).toBe(1);
    expect(reopened.get<{ count: number }>("select count(1) as count from pull_request_snapshots__crsql_pks")?.count).toBe(1);
    expect(reopened.get<{ count: number }>("select count(1) as count from terminal_sessions")?.count).toBe(1);
    expect(reopened.get<{ count: number }>("select count(1) as count from pull_request_snapshots")?.count).toBe(1);
  });

  it("repairs divergent __crsql_pks counts without losing rows or indexes", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-mismatch-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const first = await openKvDb(dbPath, createLogger() as any);
    insertProjectGraph(first);
    insertSessionAndPr(first);

    first.run("delete from lanes__crsql_pks where __crsql_key = (select max(__crsql_key) from lanes__crsql_pks)");
    first.run(
      "delete from lane_state_snapshots__crsql_pks where __crsql_key = (select max(__crsql_key) from lane_state_snapshots__crsql_pks)",
    );
    first.run("delete from terminal_sessions__crsql_pks");
    first.run("delete from pull_requests__crsql_pks");
    first.close();

    const reopened = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => reopened.close());

    expect(reopened.get<{ count: number }>("select count(1) as count from lanes")?.count).toBe(2);
    expect(reopened.get<{ count: number }>("select count(1) as count from lanes__crsql_pks")?.count).toBe(2);
    expect(reopened.get<{ count: number }>("select count(1) as count from lane_state_snapshots__crsql_pks")?.count).toBe(2);
    expect(reopened.get<{ count: number }>("select count(1) as count from terminal_sessions__crsql_pks")?.count).toBe(1);
    expect(reopened.get<{ count: number }>("select count(1) as count from pull_requests__crsql_pks")?.count).toBe(1);
    expect(
      reopened.get<{ present: number }>(
        "select 1 as present from sqlite_master where type = 'index' and name = 'idx_terminal_sessions_started_at' limit 1",
      )?.present,
    ).toBe(1);
  });

  it("keeps CRR change capture enabled after failed runtime ALTER TABLE", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-crr-alter-failure-");
    const dbPath = path.join(projectRoot, ".ade", "ade.db");
    const db = await openKvDb(dbPath, createLogger() as any);
    activeDisposers.push(async () => db.close());

    expect(
      db.get<{ present: number }>(
        "select 1 as present from sqlite_master where type = 'table' and name = 'automation_runs__crsql_clock' limit 1",
      )?.present,
    ).toBe(1);

    const alterSql = "alter table automation_runs add column ade_crr_alter_failure_probe text";
    db.run(alterSql);
    expect(() => db.run(alterSql)).toThrow();

    insertProjectGraph(db);
    const countAutomationRunChanges = () =>
      db.get<{ count: number }>("select count(1) as count from crsql_changes where [table] = ?", ["automation_runs"])
        ?.count ?? 0;
    const changesBeforeInsert = countAutomationRunChanges();
    db.run(
      `insert into automation_runs(
         id, project_id, automation_id, trigger_type, started_at, status, actions_total
       ) values (?, ?, ?, ?, ?, ?, ?)`,
      [
        "run-probe",
        "project-1",
        "automation-probe",
        "manual",
        "2026-05-26T00:00:00.000Z",
        "queued",
        0,
      ],
    );

    expect(
      db.get<{ id: string }>("select id from automation_runs where id = ? limit 1", ["run-probe"])?.id,
    ).toBe("run-probe");
    expect(countAutomationRunChanges()).toBeGreaterThan(changesBeforeInsert);
  });
});

describe("rebuildTableInTransaction leftover staging guard", () => {
  it("rebuilds successfully when a leftover __ade_crr_repair_ staging table already exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-kvdb-guard-"));
    const dbPath = path.join(root, "ade.db");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("create table widgets (id integer primary key, payload text not null)");
      const insert = db.prepare("insert into widgets(payload) values (?)");
      for (let i = 0; i < 25; i += 1) insert.run(`payload-${i}`);

      // Simulate the wedge: an aborted/killed rebuild left the staging table
      // behind, populated. Without the inline drop-guard the bare CREATE inside
      // rebuildTableInTransaction throws "table __ade_crr_repair_widgets already
      // exists" and every future repair fails the same way.
      db.exec(
        "create table __ade_crr_repair_widgets (id integer primary key, payload text not null default '')",
      );
      db.exec("insert into __ade_crr_repair_widgets(id, payload) values (999, 'stale')");

      const plan: TableRebuildPlan = {
        tableName: "widgets",
        stagingName: "__ade_crr_repair_widgets",
        createStagingSql:
          'create table "__ade_crr_repair_widgets" (id integer primary key, payload text not null default \'\')',
        columnsSql: '"id", "payload"',
        indexSqlsToRecreate: [],
      };

      expect(() => rebuildTableInTransaction(db, plan)).not.toThrow();

      // Original rows preserved, staging gone, stale orphan row not leaked in.
      expect(db.prepare("select count(*) as count from widgets").get()).toEqual({ count: 25 });
      expect(db.prepare("select count(*) as count from widgets where id = 999").get()).toEqual({ count: 0 });
      expect(
        db.prepare("select 1 from sqlite_master where type = 'table' and name = '__ade_crr_repair_widgets'").get(),
      ).toBeUndefined();
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("sweepOrphanedRepairStagingTables", () => {
  it("drops non-ambiguous repair orphans and crsql siblings while preserving ambiguous staging", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-kvdb-sweep-"));
    const dbPath = path.join(root, "ade.db");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        create table alpha (id integer primary key);
        create table __ade_crr_repair_alpha (id integer primary key);
        create table __ade_crr_repair_alpha__crsql_clock (id integer primary key);
        create table __ade_fk_repair_beta (id integer primary key);
        create table gamma (id integer primary key);
        create table __ade_crr_repair_gamma (id integer primary key);
      `);

      // `gamma` is ambiguous (recovery could not classify it) → its staging table
      // must survive; every other repair orphan is swept.
      sweepOrphanedRepairStagingTables(db, new Set(["gamma"]));

      const remaining = db
        .prepare(
          "select name from sqlite_master where type = 'table' and (name like '__ade_crr_repair_%' or name like '__ade_fk_repair_%') order by name",
        )
        .all()
        .map((row) => (row as { name: string }).name);
      expect(remaining).toEqual(["__ade_crr_repair_gamma"]);

      // Real tables are untouched.
      expect(db.prepare("select 1 from sqlite_master where name = 'alpha'").get()).toBeTruthy();
      expect(db.prepare("select 1 from sqlite_master where name = 'gamma'").get()).toBeTruthy();
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves crsql shadow siblings of an ambiguous staging table while still sweeping non-ambiguous ones", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-kvdb-sweep-shadow-"));
    const dbPath = path.join(root, "ade.db");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        create table gamma (id integer primary key);
        create table __ade_crr_repair_gamma (id integer primary key);
        create table __ade_crr_repair_gamma__crsql_clock (id integer primary key);
        create table __ade_crr_repair_gamma__crsql_pks (id integer primary key);
        create table __ade_crr_repair_delta (id integer primary key);
        create table __ade_crr_repair_delta__crsql_clock (id integer primary key);
      `);

      // `gamma` is ambiguous. Its shadow siblings share the `__ade_crr_repair_%`
      // prefix, so a naive sweep would strip the prefix to `gamma__crsql_clock`
      // (not `gamma`), miss the ambiguous check, and drop them — silently
      // breaking the deliberately-preserved base. Non-ambiguous `delta` + its
      // shadow must still be swept.
      sweepOrphanedRepairStagingTables(db, new Set(["gamma"]));

      const remaining = db
        .prepare(
          "select name from sqlite_master where type = 'table' and name like '__ade_%_repair_%' order by name",
        )
        .all()
        .map((row) => (row as { name: string }).name);
      expect(remaining).toEqual([
        "__ade_crr_repair_gamma",
        "__ade_crr_repair_gamma__crsql_clock",
        "__ade_crr_repair_gamma__crsql_pks",
      ]);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});


describe("retention maintenance", () => {
  async function openScratchDb() {
    const root = makeProjectRoot("ade-kvdb-retention-");
    const db = await openKvDb(path.join(root, ".ade", "ade.db"), createLogger() as any);
    return { db, root };
  }

  const daysAgo = (days: number): string =>
    new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();

  it("prunes event logs on created_at and leaves fresh rows", async () => {
    const { db } = await openScratchDb();
    try {
      db.run(
        `insert into pack_events (id, project_id, pack_key, event_type, created_at)
         values ('pack-old', 'proj', 'k', 'installed', ?)`,
        [daysAgo(EVENT_LOG_RETENTION_DAYS + 5)],
      );
      db.run(
        `insert into pack_events (id, project_id, pack_key, event_type, created_at)
         values ('pack-fresh', 'proj', 'k', 'installed', ?)`,
        [daysAgo(1)],
      );

      const result = await db.maintenance!.pruneEventLogs();
      expect(result.itemsAffected).toBe(1);
      expect(db.all<{ id: string }>("select id from pack_events").map((r) => r.id))
        .toEqual(["pack-fresh"]);
    } finally {
      db.close();
    }
  });

  // The webhook replay guard, the CTO log that a reconcile re-inserts, and the
  // worker lifecycle table are all deliberately exempt — pruning any of them
  // would be a bug, not a saving.
  it("leaves the deliberately-unretained tables alone", async () => {
    const { db } = await openScratchDb();
    try {
      const stale = daysAgo(EVENT_LOG_RETENTION_DAYS + 60);
      db.run(
        `insert into linear_ingress_events (id, project_id, source, delivery_id, created_at)
         values ('ing-1', 'proj', 'linear', 'delivery-1', ?)`,
        [stale],
      );
      db.run(
        `insert into cto_session_logs (id, project_id, session_id, created_at)
         values ('cto-1', 'proj', 'sess', ?)`,
        [stale],
      );
      db.run(
        `insert into worker_agent_runs (id, project_id, agent_id, created_at)
         values ('run-1', 'proj', 'agent', ?)`,
        [stale],
      );

      await db.maintenance!.pruneEventLogs();

      expect(db.all("select id from linear_ingress_events")).toHaveLength(1);
      expect(db.all("select id from cto_session_logs")).toHaveLength(1);
      expect(db.all("select id from worker_agent_runs")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  // A locked or malformed database must not read as "step not supported" —
  // that renders as a tidy completed sweep in the journal, the analytics event,
  // and the Settings summary.
  it("surfaces a prune failure instead of reporting it as unsupported", async () => {
    const { db } = await openScratchDb();
    try {
      // A malformed table is a real SQL failure, not "this handle does not
      // implement the step" — the doctor must record it as an error rather than
      // rendering a tidy completed sweep.
      db.run("drop table pack_events");
      db.run("create table pack_events (id text primary key)");
      await expect(db.maintenance!.pruneEventLogs()).rejects.toThrow();
    } finally {
      db.close();
    }
  });

  // SQLite orders INTEGER before TEXT, so an epoch-number timestamp would match
  // every cutoff; CRR repair can also leave an empty-string timestamp.
  it("does not treat a non-text or empty timestamp as expired", async () => {
    const { db } = await openScratchDb();
    try {
      db.run("insert into pack_events (id, project_id, pack_key, event_type, created_at) values ('epoch', 'p', 'k', 'e', 1767225600000)");
      db.run("insert into pack_events (id, project_id, pack_key, event_type, created_at) values ('empty', 'p', 'k', 'e', '')");

      await db.maintenance!.pruneEventLogs();

      expect(db.all<{ id: string }>("select id from pack_events order by id").map((r) => r.id))
        .toEqual(["empty", "epoch"]);
    } finally {
      db.close();
    }
  });
});

describe("inbound settle-tuple reconciliation hook", () => {
  /**
   * The path with the least margin for error in the settle-teardown work: a
   * hand-rolled decode of cr-sqlite's packed primary key. If it is wrong, peer
   * settles quietly stop being reconciled — no exception, no log, and the only
   * visible symptom is a race that reappears months later.
   *
   * Driven through the real `applyChanges` rather than by calling the handler,
   * so the whole chain is exercised: column detection, pk decode, and the
   * guarantee that the change still APPLIES (holding it back would desynchronise
   * the per-column clocks).
   */
  it("reports settle-tuple columns to the handler and still applies them", async () => {
    const projectRoot = makeProjectRoot("ade-kvdb-settle-hook-");
    const source = await openKvDb(path.join(projectRoot, "source", ".ade", "ade.db"), createLogger() as any);
    activeDisposers.push(async () => source.close());
    const target = await openKvDb(path.join(projectRoot, "target", ".ade", "ade.db"), createLogger() as any);
    activeDisposers.push(async () => target.close());

    const crrLoaded = source.get<{ present: number }>(
      "select 1 as present from sqlite_master where type = 'table' and name = 'terminal_sessions__crsql_clock' limit 1",
    ) !== null;
    // cr-sqlite ships macOS-only binaries; without it there are no changesets to
    // apply and the assertions below would be vacuously true.
    if (!crrLoaded) return;

    const insertSession = (db: typeof source) => {
      db.run(
        `insert into terminal_sessions (id, lane_id, title, status, started_at, tool_type)
         values (?, ?, ?, ?, ?, ?)`,
        ["peer-session", "lane-1", "Chat", "ended", "2026-08-11T00:00:00.000Z", "codex-chat"],
      );
    };
    insertSession(source);
    insertSession(target);

    const seen: Array<{ sessionId: string; column: string }> = [];
    target.sync.setRemoteSettleTupleHandler((changes) => { seen.push(...changes); });

    const before = source.sync.getDbVersion();
    source.run("update terminal_sessions set settled_at = ? where id = ?", ["2026-08-11T01:00:00.000Z", "peer-session"]);
    const changes = source.sync.exportChangesSince(before)
      .filter((change) => change.table === "terminal_sessions");
    expect(changes.length, "the peer must actually have exported a settle change").toBeGreaterThan(0);

    target.sync.applyChanges(changes);

    // The decode worked: the handler learned WHICH session and column moved.
    expect(seen).toContainEqual({ sessionId: "peer-session", column: "settled_at" });
    // And the value landed, which is what keeps the per-column clocks convergent.
    expect(
      target.get<{ settled_at: string | null }>(
        "select settled_at from terminal_sessions where id = ?",
        ["peer-session"],
      )?.settled_at,
    ).toBe("2026-08-11T01:00:00.000Z");

    // A re-delivered batch must report NOTHING. The peer's outbound cursor only
    // advances on an ok ack, so a dropped ack re-sends the identical range —
    // and reporting it would bump the lifecycle revision and trip the abort,
    // killing a user's in-flight settle over a duplicate packet.
    //
    // `sqlite3_changes` cannot be used to detect this: `crsql_changes` is a
    // virtual table, so SQLite counts the call even when cr-sqlite discards the
    // row as a losing merge. That guard was tried and measured inert; this test
    // is what caught it.
    const seenAfterFirst = seen.length;
    target.sync.applyChanges(changes);
    expect(seen.length, "a duplicate changeset must not be reported again").toBe(seenAfterFirst);
  });
});

/**
 * The CRR repair reads a stored CREATE TABLE and drops the constraints cr-sqlite
 * cannot carry. It used to do that one line at a time, which left a wrapped
 * foreign key's `references …` line behind and produced invalid SQLite — the
 * failure that aborted a database open in the field. These are the shapes a
 * line-based filter gets wrong, plus the ones it must not damage.
 */
describe("CREATE TABLE constraint stripping", () => {
  /** A throwaway database, so each rewritten statement is validated on its own. */
  const accept = (sql: string): void => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  };

  it.each([
    {
      name: "a foreign key whose references and action wrap onto their own lines",
      sql: [
        "create table t (",
        "  id text not null,",
        "  primary key(id),",
        "  foreign key(id)",
        "    references other(id)",
        "    on delete cascade",
        ")",
      ].join("\n"),
      gone: /foreign key|references/i,
      kept: "primary key(id)",
    },
    {
      name: "a foreign key on its own line among several",
      sql: [
        "create table t (",
        "  id text not null,",
        "  other text not null,",
        "  primary key(id),",
        "  foreign key(id) references other(id),",
        "  foreign key(other) references other(id)",
        ")",
      ].join("\n"),
      gone: /foreign key|references/i,
      kept: "other text not null",
    },
    {
      name: "a constraint keyword in front of the wrapped foreign key",
      sql: [
        "create table t (",
        "  id text not null,",
        "  primary key(id),",
        "  constraint fk_other foreign key(id)",
        "    references other(id)",
        ")",
      ].join("\n"),
      gone: /constraint|foreign key|references/i,
      kept: "primary key(id)",
    },
    {
      name: "a table-level unique constraint",
      sql: "create table t (id text not null, other text not null, unique(id, other))",
      gone: /unique/i,
      kept: "other text not null",
    },
    {
      name: "a comment in front of the keyword, whose apostrophe would open a string",
      sql: [
        "create table t (",
        "  id text not null,",
        "  primary key(id),",
        "  -- it's a foreign key",
        "  foreign key(id) references other(id)",
        ")",
      ].join("\n"),
      gone: /foreign key|references/i,
      kept: "primary key(id)",
    },
  ])("drops $name", ({ sql, gone, kept }) => {
    const rewritten = stripCrrUnsupportedTableConstraints(sql);

    expect(rewritten).not.toMatch(gone);
    expect(rewritten).toContain(kept);
    // The point of the rewrite: SQLite has to accept what comes out of it.
    expect(() => accept(rewritten)).not.toThrow();
  });

  it.each([
    {
      name: "a comma inside a string default",
      sql: "create table t (label text not null default 'a, b', primary key(label))",
      kept: "'a, b'",
    },
    {
      name: "the word unique inside a string default",
      sql: "create table t (flag text not null default 'unique', primary key(flag))",
      kept: "'unique'",
    },
    {
      name: "a doubled quote inside the constraint's own name",
      sql: "create table t (id text not null, constraint 'it''s fk' unique(id))",
      kept: "id text not null",
    },
    {
      name: "a statement with no parenthesised body",
      sql: "create table t as select 1 as one",
      kept: "select 1 as one",
    },
    {
      name: "a body whose only clause is a column",
      sql: "create table t (id text not null primary key)",
      kept: "primary key",
    },
  ])("leaves $name alone", ({ sql, kept }) => {
    const rewritten = stripCrrUnsupportedTableConstraints(sql);

    expect(rewritten).toContain(kept);
    expect(() => accept(rewritten)).not.toThrow();
  });

  it("returns converged DDL byte-identical, so a settled table is never rebuilt", () => {
    const sql = [
      "create table t (",
      "  id text not null,",
      "  label text not null default '',",
      "  primary key(id)",
      ")",
    ].join("\n");

    const once = stripCrrUnsupportedTableConstraints(sql);
    const twice = stripCrrUnsupportedTableConstraints(once);

    expect(once).toBe(sql);
    expect(twice).toBe(once);
    expect(() => accept(once)).not.toThrow();
  });
});

// Update tracks (docs/plans/beta-track.md): before a new app version first
// opens a database, a copy is taken, and the file records the highest
// compatibility level that ran its migrations, which a Beta-to-Stable switch
// checks. A real file on disk, through the real open.
describe("openKvDb version copies and compatibility records", () => {
  it("copies a database before a new version opens it, keeps one copy per move, and never lowers the recorded level", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-kvdb-version-copy-"));
    const dbPath = path.join(dir, "ade.db");
    const copies = () => fs.readdirSync(dir).filter((name) => /^ade\.db\.pre-\d.*\.bak$/.test(name)).sort();
    const open = async (appVersion: string) => {
      const db = await openKvDb(dbPath, createLogger() as any, { appVersion });
      return db;
    };
    activeDisposers.push(async () => fs.rmSync(dir, { recursive: true, force: true }));

    let db = await open("1.2.127");
    db.setJson("track:probe", "written by 1.2.127");
    db.flushNow();
    db.close();
    // A brand-new file has nothing to protect.
    expect(copies()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(`${dbPath}.compat.json`, "utf8"))).toMatchObject({ level: 1, lastOpenedVersion: "1.2.127" });

    // A newer build left a higher level: an older open must not lower it.
    fs.writeFileSync(`${dbPath}.compat.json`, JSON.stringify({ level: 5, lastOpenedVersion: "1.2.127" }));
    db = await open("1.2.128-beta.1");
    db.close();
    expect(copies()).toEqual(["ade.db.pre-1.2.128-beta.1-from-1.2.127.bak"]);
    const copy = new DatabaseSync(path.join(dir, copies()[0]!));
    expect((copy.prepare("select value from kv where key = ?").get("track:probe") as { value: string }).value)
      .toContain("written by 1.2.127");
    copy.close();
    expect(JSON.parse(fs.readFileSync(`${dbPath}.compat.json`, "utf8"))).toMatchObject({ level: 5, lastOpenedVersion: "1.2.128-beta.1" });

    // The same version again takes no copy; going back takes a new one.
    db = await open("1.2.128-beta.1");
    db.close();
    expect(copies()).toHaveLength(1);
    db = await open("1.2.127");
    db.close();
    expect(copies()).toEqual([
      "ade.db.pre-1.2.127-from-1.2.128-beta.1.bak",
      "ade.db.pre-1.2.128-beta.1-from-1.2.127.bak",
    ]);
  });
});
