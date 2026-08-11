import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createSessionService } from "./sessionService";

/**
 * The settle-lifecycle chokepoint.
 *
 * `settled_at` is written and cleared from ten call paths, four of them not
 * named "settle" or "unsettle" and one of them running per terminal output
 * chunk. Attaching an async teardown to that was tried and cut in PR #1059: it
 * produced a P1 every review round, because a decision taken at t0 and applied
 * at t0+T has no way to know the world moved in between.
 *
 * These pin the two properties that fix the class: every mutation goes through
 * one function, and every mutation moves a revision a later write can be made
 * conditional on.
 */

const WRITER_MODULE = path.join(__dirname, "settleLifecycleWriter.ts");

function createLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as const;
}

function makeProjectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-settle-chokepoint-"));
  fs.mkdirSync(path.join(root, ".ade", "artifacts"), { recursive: true });
  return root;
}

function insertProjectGraph(db: Awaited<ReturnType<typeof openKvDb>>) {
  const now = "2026-08-11T00:00:00.000Z";
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
      "lane-1", "project-1", "Lane 1", null, "worktree", "main", "ade/lane-1",
      "/repo/ade/.ade/worktrees/lane-1", null, 0, null, null, null, "[]", null, "active", now, null,
    ],
  );
}

describe("settle-lifecycle writer", () => {
  const activeDisposers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (activeDisposers.length) await activeDisposers.pop()?.();
  });

  async function withService(): Promise<ReturnType<typeof createSessionService>> {
    const projectRoot = makeProjectRoot();
    const db = await openKvDb(path.join(projectRoot, ".ade", "ade.db"), createLogger() as any);
    activeDisposers.push(async () => db.close());
    insertProjectGraph(db);
    const service = createSessionService({ db });
    service.create({
      sessionId: "session-1",
      laneId: "lane-1",
      ptyId: null,
      tracked: true,
      title: "Chat",
      startedAt: "2026-08-11T00:01:00.000Z",
      transcriptPath: "/tmp/session-1.log",
      toolType: "codex-chat",
    });
    return service;
  }

  /**
   * The load-bearing one. A guard belongs to the writer, not the callers — so
   * the guarantee is only real if no other writer exists. This scans the source
   * rather than trusting review, because the failure mode is someone adding an
   * eleventh path in six months.
   */
  it("has no settle-tuple assignment anywhere outside the chokepoint", () => {
    // Repo-wide, not just this file. The invariant is "no other writer exists",
    // and an eleventh path added in a new service would otherwise pass clean.
    const roots = [
      path.resolve(__dirname, "../../.."),                       // apps/desktop/src
      path.resolve(__dirname, "../../../../../ade-cli/src"),     // apps/ade-cli/src
    ];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "dist") continue;
          walk(full);
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          files.push(full);
        }
      }
    };
    for (const root of roots) if (fs.existsSync(root)) walk(root);
    expect(files.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const file of files) {
      // The writer module is the one place allowed to assign the tuple. A FILE
      // boundary, not offsets inside a 1900-line module — that is why the writer
      // was extracted, and it means no future reordering can widen the blind
      // spot.
      if (file === WRITER_MODULE) continue;
      const source = fs.readFileSync(file, "utf8");
      // Strip comments first: prose describing what the host writes (the web
      // adapter documents the host's SQL in JSDoc) is not a writer, and matching
      // it would make this test cry wolf until someone weakened it.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
      // `=` only, never `==` — a `where settle_override = ?` comparison in a
      // SELECT is legitimate, so require the assignment form used in a SET list.
      for (const match of code.match(/\b(settled_at|settle_override|settle_source)\s*=(?!=)/g) ?? []) {
        offenders.push(`${path.relative(roots[0], file)}: ${match}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("bumps the revision on every settle-lifecycle path", async () => {
    const service = await withService();
    let previous = service.getSettleLifecycleRevision("session-1");
    expect(previous).toBe(0);

    const bumped = (label: string) => {
      const next = service.getSettleLifecycleRevision("session-1");
      expect(next, `${label} must move the revision`).toBeGreaterThan(previous);
      previous = next;
    };

    service.settleSessions(["session-1"]);
    bumped("settleSessions (W1)");

    service.unsettleSession("session-1");
    bumped("unsettleSession (C1)");

    service.settleSession("session-1");
    bumped("settleSession (W2)");

    service.unsettleSessions(["session-1"]);
    bumped("unsettleSessions (C2)");

    // `settle_override` never touches `settled_at`, but a `'settled'` pin makes
    // the row read as settled all the same — so it has to move the revision or
    // the guard is blind to it.
    service.setSettleOverride("session-1", "settled");
    bumped("setSettleOverride (W3)");

    service.setSettleOverrides(["session-1"], null);
    bumped("setSettleOverrides (W3 bulk)");

    service.clearTurnStartMarkers("session-1");
    bumped("clearTurnStartMarkers (C3)");

    service.setLastOutputPreview("session-1", "output", { clearSettled: true });
    bumped("setLastOutputPreview (C4)");

    service.touchSessionActivity("session-1");
    bumped("touchSessionActivity (C5)");

    service.markLastTurnFailed("session-1");
    bumped("markLastTurnFailed (C6)");

    service.requestAttention("session-1", "need you");
    bumped("requestAttention (C7)");
  });

  /**
   * The counterpart: a write that does NOT touch the settle tuple must leave
   * the revision alone, or a guard built on it would reject settles for reasons
   * that have nothing to do with settling.
   */
  it("leaves the revision alone for writes that do not touch the settle tuple", async () => {
    const service = await withService();
    service.settleSessions(["session-1"]);
    const settled = service.getSettleLifecycleRevision("session-1");

    // Explicitly opted out of clearing the settle — the agent-CLI case.
    service.setLastOutputPreview("session-1", "trailing agent output");
    service.touchSessionActivity("session-1", "2026-08-11T00:05:00.000Z", { clearSettled: false });
    service.setSummary("session-1", "a summary");

    expect(service.getSettleLifecycleRevision("session-1")).toBe(settled);
    expect(service.get("session-1")?.settledAt).toBeTruthy();
  });

  it("keeps revisions per session", async () => {
    const service = await withService();
    service.create({
      sessionId: "session-2",
      laneId: "lane-1",
      ptyId: null,
      tracked: true,
      title: "Other",
      startedAt: "2026-08-11T00:02:00.000Z",
      transcriptPath: "/tmp/session-2.log",
      toolType: "codex-chat",
    });

    service.settleSessions(["session-1"]);

    expect(service.getSettleLifecycleRevision("session-1")).toBe(1);
    expect(service.getSettleLifecycleRevision("session-2")).toBe(0);
  });

  it("bumps every id in a bulk mutation, not just the first", async () => {
    const service = await withService();
    service.create({
      sessionId: "session-2",
      laneId: "lane-1",
      ptyId: null,
      tracked: true,
      title: "Other",
      startedAt: "2026-08-11T00:02:00.000Z",
      transcriptPath: "/tmp/session-2.log",
      toolType: "codex-chat",
    });

    service.settleSessions(["session-1", "session-2"]);

    expect(service.getSettleLifecycleRevision("session-1")).toBe(1);
    expect(service.getSettleLifecycleRevision("session-2")).toBe(1);
  });

  /**
   * A bump can land in either store — the table normally, memory when the table
   * write fails. If the table then starts working it begins its own count at 1,
   * so a reader that preferred one store could hand back a LOWER number than it
   * had already returned. A revision that moves backwards is worse than none: it
   * lets a stale settle match a token it should have missed.
   */
  it("never reports a revision lower than one it has already reported", async () => {
    const projectRoot = makeProjectRoot();
    const db = await openKvDb(path.join(projectRoot, ".ade", "ade.db"), createLogger() as any);
    activeDisposers.push(async () => db.close());
    insertProjectGraph(db);

    // Force the persisted bump to fail so it falls back to memory.
    const realRun = db.run.bind(db);
    (db as unknown as { run: typeof db.run }).run = (sql: string, params?: unknown[]) => {
      if (sql.includes("session_lifecycle_revisions")) throw new Error("table unavailable");
      return realRun(sql, params as never);
    };

    const service = createSessionService({ db });
    service.create({
      sessionId: "session-1",
      laneId: "lane-1",
      ptyId: null,
      tracked: true,
      title: "Chat",
      startedAt: "2026-08-11T00:01:00.000Z",
      transcriptPath: "/tmp/session-1.log",
      toolType: "codex-chat",
    });

    service.settleSessions(["session-1"]);
    service.unsettleSessions(["session-1"]);
    service.settleSessions(["session-1"]);
    const afterFallback = service.getSettleLifecycleRevision("session-1");
    expect(afterFallback).toBeGreaterThanOrEqual(3);

    // The table starts working again; its own count restarts at 1.
    (db as unknown as { run: typeof db.run }).run = realRun;
    service.unsettleSessions(["session-1"]);

    expect(service.getSettleLifecycleRevision("session-1")).toBeGreaterThan(afterFallback);
  });

  it("keeps the revision table out of CRR replication", async () => {
    const projectRoot = makeProjectRoot();
    const db = await openKvDb(path.join(projectRoot, ".ade", "ade.db"), createLogger() as any);
    activeDisposers.push(async () => db.close());

    const clockTable = (table: string) =>
      db.get<{ present: number }>(
        "select 1 as present from sqlite_master where type = 'table' and name = ?",
        [`${table}__crsql_clock`],
      );

    // A host-local concurrency token must never reach another device: it is
    // meaningless there, and on the CRR `terminal_sessions` row it would add a
    // per-column clock entry to the throttled preview write path.
    expect(clockTable("session_lifecycle_revisions")).toBeNull();
    // Positive control. Without it this assertion passes for a table that does
    // not exist, or if the clock naming convention ever changes — which is
    // exactly how the first version of this test managed to assert nothing.
    expect(clockTable("terminal_sessions")).not.toBeNull();

    expect(
      db.get<{ name: string }>(
        "select name from sqlite_master where type = 'table' and name = 'session_lifecycle_revisions'",
      )?.name,
    ).toBe("session_lifecycle_revisions");
  });

});
