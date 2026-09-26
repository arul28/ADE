import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Same anchored require the module under test uses: a static `node:sqlite`
// import is a build-time dependency vitest cannot resolve (see rosterBuilder).
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (dbPath: string) => DatabaseSyncType;
};
import {
  applyOpenCodeStorePrune,
  openCodeStoreHasActiveWriter,
  planOpenCodeStorePrune,
  parseOpenCodeStoreDuration,
  resolveOpenCodeStoreTarget,
  runOpenCodeStoreRetention,
} from "./opencodeStoreMaintenance";

/**
 * The prune engine's contract: a whole session goes, its event log goes with it
 * through `event_sequence`, a session inside the cutoff stays, and a dry run
 * writes nothing. The cascade wiring is exactly what the handoff asked to
 * confirm before deleting anything, so it is pinned here against a real
 * SQLite file rather than mocked.
 */
function seedStore(dbPath: string, nowMs: number): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        time_updated INTEGER NOT NULL
      );
      CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY);
      CREATE TABLE event (
        id TEXT PRIMARY KEY,
        aggregate_id TEXT NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
        data TEXT NOT NULL
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
        data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
        data TEXT NOT NULL
      );
    `);
    const oldMs = nowMs - 10 * 86_400_000;
    const freshMs = nowMs - 60_000;
    for (const [sessionId, updated] of [
      ["ses_old_parent", oldMs],
      ["ses_old_child", oldMs],
      ["ses_fresh", freshMs],
    ] as const) {
      db.prepare("INSERT INTO session (id, parent_id, time_updated) VALUES (?, ?, ?)").run(
        sessionId,
        sessionId === "ses_old_child" ? "ses_old_parent" : null,
        updated,
      );
      db.prepare("INSERT INTO event_sequence (aggregate_id) VALUES (?)").run(sessionId);
      db.prepare("INSERT INTO event (id, aggregate_id, data) VALUES (?, ?, ?)").run(
        `evt_${sessionId}`,
        sessionId,
        "x".repeat(2048),
      );
      db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)").run(
        `msg_${sessionId}`,
        sessionId,
        "{}",
      );
      db.prepare("INSERT INTO part (id, session_id, message_id, data) VALUES (?, ?, ?, ?)").run(
        `part_${sessionId}`,
        sessionId,
        `msg_${sessionId}`,
        "{}",
      );
    }
  } finally {
    db.close();
  }
}

describe("openCodeStoreMaintenance", () => {
  let tmpRoot: string;
  let dbPath: string;
  const nowMs = Date.UTC(2026, 8, 25, 12, 0, 0);

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-oc-prune-"));
    dbPath = path.join(tmpRoot, "opencode.db");
    seedStore(dbPath, nowMs);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("plans old sessions including their children and leaves the fresh one out", () => {
    const plan = planOpenCodeStorePrune({ dbPath, cutoffMs: nowMs - 86_400_000 });
    expect(plan.totalSessions).toBe(3);
    expect(plan.eligibleSessions).toEqual(["ses_old_child", "ses_old_parent"]);
    expect(plan.reclaimablePayloadBytes).toBeGreaterThan(0);
  });

  it("deletes the session, its projections, and the event log through event_sequence", () => {
    const plan = planOpenCodeStorePrune({ dbPath, cutoffMs: nowMs - 86_400_000 });
    const result = applyOpenCodeStorePrune({ plan });
    expect(result.deletedSessions).toBe(2);
    expect(result.deletedEvents).toBe(2);
    expect(result.deletedMessages).toBe(2);
    expect(result.deletedParts).toBe(2);

    const db = new DatabaseSync(dbPath);
    try {
      const ids = db.prepare("SELECT id FROM session ORDER BY id").all().map((row) => (row as { id: string }).id);
      expect(ids).toEqual(["ses_fresh"]);
      // The event log is only reachable through its sequence row; a session
      // deleted without it would leave every event behind.
      const events = db.prepare("SELECT aggregate_id FROM event ORDER BY aggregate_id").all()
        .map((row) => (row as { aggregate_id: string }).aggregate_id);
      expect(events).toEqual(["ses_fresh"]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM part").get()).toMatchObject({ n: 1 });
    } finally {
      db.close();
    }
  });

  it("dry-run planning writes nothing, and an active writer is detected", () => {
    const before = fs.readFileSync(dbPath);
    planOpenCodeStorePrune({ dbPath, cutoffMs: nowMs });
    expect(fs.readFileSync(dbPath)).toEqual(before);
    expect(openCodeStoreHasActiveWriter(dbPath)).toBe(false);

    const holder = new DatabaseSync(dbPath);
    try {
      holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      expect(openCodeStoreHasActiveWriter(dbPath)).toBe(true);
      holder.exec("ROLLBACK");
    } finally {
      holder.close();
    }
  });
});

describe("runOpenCodeStoreRetention", () => {
  let tmpRoot: string;
  let nowMs: number;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-oc-retention-"));
    nowMs = Date.now();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function sessionIds(storeDir: string): string[] {
    const db = new DatabaseSync(path.join(storeDir, "opencode.db"));
    try {
      return db.prepare("SELECT id FROM session ORDER BY id").all()
        .map((row) => (row as { id: string }).id);
    } finally {
      db.close();
    }
  }

  it("removes sessions past the retention age and keeps fresh ones", () => {
    const storeDir = path.join(tmpRoot, "store");
    fs.mkdirSync(storeDir, { recursive: true });
    seedStore(path.join(storeDir, "opencode.db"), nowMs);

    const result = runOpenCodeStoreRetention({
      storeDir,
      nowMs,
      maxAgeMs: 7 * 86_400_000,
      minFileBytes: 0,
      vacuum: false,
    });
    expect(result.ran).toBe(true);
    expect(result.eligibleSessions).toBe(2);
    expect(result.applied?.deletedSessions).toBe(2);
    expect(sessionIds(storeDir)).toEqual(["ses_fresh"]);

    // Idempotent: a second run finds nothing left to do.
    const second = runOpenCodeStoreRetention({
      storeDir,
      nowMs,
      maxAgeMs: 7 * 86_400_000,
      minFileBytes: 0,
      vacuum: false,
    });
    expect(second.ran).toBe(false);
    expect(second.reason).toBe("no-eligible-sessions");
    expect(sessionIds(storeDir)).toEqual(["ses_fresh"]);
  });

  it("skips a store below the size threshold and never throws on a missing one", () => {
    const storeDir = path.join(tmpRoot, "store");
    fs.mkdirSync(storeDir, { recursive: true });
    seedStore(path.join(storeDir, "opencode.db"), nowMs);
    const below = runOpenCodeStoreRetention({
      storeDir,
      nowMs,
      maxAgeMs: 7 * 86_400_000,
      minFileBytes: 1024 * 1024 * 1024,
      vacuum: false,
    });
    expect(below.ran).toBe(false);
    expect(below.reason).toBe("below-threshold");
    expect(sessionIds(storeDir)).toHaveLength(3);

    const missing = runOpenCodeStoreRetention({
      storeDir: path.join(tmpRoot, "nope"),
      nowMs,
      minFileBytes: 0,
    });
    expect(missing.ran).toBe(false);
    expect(missing.reason).toBe("no-store");
  });

  it("leaves a store the caller did not name untouched", () => {
    const ownedDir = path.join(tmpRoot, "owned");
    const otherDir = path.join(tmpRoot, "other");
    fs.mkdirSync(ownedDir, { recursive: true });
    fs.mkdirSync(otherDir, { recursive: true });
    seedStore(path.join(ownedDir, "opencode.db"), nowMs);
    seedStore(path.join(otherDir, "opencode.db"), nowMs);

    runOpenCodeStoreRetention({
      storeDir: ownedDir,
      nowMs,
      maxAgeMs: 7 * 86_400_000,
      minFileBytes: 0,
      vacuum: false,
    });
    expect(sessionIds(ownedDir)).toEqual(["ses_fresh"]);
    expect(sessionIds(otherDir)).toEqual(["ses_fresh", "ses_old_child", "ses_old_parent"]);
  });
});

describe("parseOpenCodeStoreDuration", () => {
  it("reads the documented units", () => {
    expect(parseOpenCodeStoreDuration("30m")).toBe(30 * 60_000);
    expect(parseOpenCodeStoreDuration("12h")).toBe(12 * 3_600_000);
    expect(parseOpenCodeStoreDuration("14d")).toBe(14 * 86_400_000);
    expect(parseOpenCodeStoreDuration("2w")).toBe(14 * 86_400_000);
    expect(() => parseOpenCodeStoreDuration("soon")).toThrow(/Invalid duration/);
  });
});

describe("resolveOpenCodeStoreTarget", () => {
  it("targets the store directory under the ADE owned data home", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-oc-target-"));
    try {
    const adeHome = path.join(root, "ade-home");
    const storeDir = path.join(adeHome, "opencode-runtime", "xdg-v1", "data", "opencode");
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, "opencode.db"), "");
    const target = resolveOpenCodeStoreTarget("ade", { ADE_HOME: adeHome } as NodeJS.ProcessEnv);
    expect(target.dbPath).toBe(path.join(storeDir, "opencode.db"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
