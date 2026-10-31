import { describe, expect, it } from "vitest";
import type { DatabaseCopyInfo, LocalDatabaseKind } from "../../../shared/types/startupRecovery";
import { chooseGoBackPlan, parseDatabaseCopyName, type GoBackDatabase } from "./goBackPlan";

function copy(
  dbPath: string,
  toVersion: string,
  fromVersion: string | null,
  takenAt: number,
  kept = false,
): DatabaseCopyInfo {
  const fileName = `ade.db.pre-${toVersion}-from-${fromVersion ?? "unknown"}${kept ? "_kept" : ""}.bak`;
  return {
    path: `${dbPath}.pre-${toVersion}-from-${fromVersion ?? "unknown"}${kept ? "_kept" : ""}.bak`,
    fileName,
    databaseKind: "machine",
    databaseLabel: "m",
    databasePath: dbPath,
    toVersion,
    fromVersion,
    kept,
    takenAt,
    sizeBytes: 1,
  };
}

function database(kind: LocalDatabaseKind, dbPath: string, copies: DatabaseCopyInfo[], label: string = kind): GoBackDatabase {
  return { kind, label, dbPath, copies };
}

describe("parseDatabaseCopyName", () => {
  it.each([
    ["ade.db.pre-1.2.128-beta.3-from-1.2.128-beta.2.bak", { toVersion: "1.2.128-beta.3", fromVersion: "1.2.128-beta.2", kept: false }],
    ["ade.db.pre-1.2.128-from-1.2.128-beta.4.bak", { toVersion: "1.2.128", fromVersion: "1.2.128-beta.4", kept: false }],
    // What "Go back" set aside, and a second time between the same versions.
    ["ade.db.pre-1.2.127-from-1.2.128-beta.3_kept.bak", { toVersion: "1.2.127", fromVersion: "1.2.128-beta.3", kept: true }],
    ["ade.db.pre-1.2.127-from-1.2.128_kept2.bak", { toVersion: "1.2.127", fromVersion: "1.2.128", kept: true }],
    // No known previous version: nothing to go back to.
    ["ade.db.pre-1.2.128-from-unknown.bak", { toVersion: "1.2.128", fromVersion: null, kept: false }],
    ["ade.db.pre-1.2.128-from-before-1.2.127.bak", { toVersion: "1.2.128", fromVersion: null, kept: false }],
    // Not copies: never listed, never deleted by cleanup.
    ["ade.db", null],
    ["ade.db-wal", null],
    ["ade.db.compat.json", null],
    ["ade.db.pre-crsqlite-w1.bak", null],
    ["ade.db.pre-1.2.128-from-1.2.127.bak-wal", null],
    ["ade.db.pre-1.2.128-from-1.2.127.bak.123.tmp", null],
    ["other.db.pre-1.2.128-from-1.2.127.bak", null],
  ])("%s", (fileName, expected) => {
    expect(parseDatabaseCopyName("ade.db", fileName)).toEqual(expected);
  });
});

describe("chooseGoBackPlan", () => {
  const machine = "/h/ade.db";
  const personal = "/h/personal/.ade/ade.db";
  const project = "/p/.ade/ade.db";
  const running = "1.2.128-beta.3";

  it.each([
    {
      name: "the update record wins when a copy for that move exists",
      record: { version: running, fromVersion: "1.2.128-beta.1" },
      databases: [database("machine", machine, [copy(machine, running, "1.2.128-beta.2", 300), copy(machine, running, "1.2.128-beta.1", 100)])],
      failed: null,
      target: "1.2.128-beta.1",
    },
    {
      name: "without a matching copy, the newest copy's version decides",
      record: { version: running, fromVersion: "1.2.127" },
      databases: [database("machine", machine, [copy(machine, running, "1.2.128-beta.2", 300), copy(machine, running, "1.2.128-beta.1", 100)])],
      failed: null,
      target: "1.2.128-beta.2",
    },
    {
      name: "a record for another version is ignored",
      record: { version: "1.2.128-beta.2", fromVersion: "1.2.128-beta.1" },
      databases: [database("machine", machine, [copy(machine, running, "1.2.128-beta.2", 300), copy(machine, running, "1.2.128-beta.1", 100)])],
      failed: null,
      target: "1.2.128-beta.2",
    },
    {
      name: "copies into another version are not this update's",
      record: null,
      databases: [database("machine", machine, [copy(machine, "1.2.128-beta.2", "1.2.128-beta.1", 300)])],
      failed: null,
      target: null,
    },
    {
      name: "no known previous version",
      record: null,
      databases: [database("machine", machine, [copy(machine, running, null, 300)])],
      failed: null,
      target: null,
    },
    {
      name: "a dev build is never a release to go back to",
      record: null,
      databases: [database("machine", machine, [copy(machine, running, "1.0.0-beta.1", 300), copy(machine, running, "0.0.0", 200)])],
      failed: null,
      target: null,
    },
    {
      name: "what Go back set aside is never a way back",
      record: null,
      databases: [database("machine", machine, [copy(machine, running, "1.2.128-beta.4", 300, true)])],
      failed: null,
      target: null,
    },
    {
      name: "a project that works is not a way back",
      record: null,
      databases: [database("project", project, [copy(project, running, "1.2.128-beta.2", 300)])],
      failed: null,
      target: null,
    },
    {
      name: "the project that failed is",
      record: null,
      databases: [database("project", project, [copy(project, running, "1.2.128-beta.2", 300)])],
      failed: project,
      target: "1.2.128-beta.2",
    },
  ])("$name", ({ record, databases, failed, target }) => {
    const plan = chooseGoBackPlan({ runningVersion: running, updateRecord: record, databases, failedDbPath: failed });
    expect(plan?.targetVersion ?? null).toBe(target);
  });

  it("puts back this computer's and the personal chats' data and the failed project, and leaves the other projects", () => {
    const other = "/o/.ade/ade.db";
    const plan = chooseGoBackPlan({
      runningVersion: running,
      updateRecord: { version: running, fromVersion: "1.2.128-beta.2" },
      failedDbPath: project,
      databases: [
        database("machine", machine, [copy(machine, running, "1.2.128-beta.2", 100)]),
        database("personal", personal, [copy(personal, running, "1.2.128-beta.2", 120)]),
        database("project", project, [copy(project, running, "1.2.128-beta.2", 250)], "broken"),
        // Works, and has a copy: its edits since the update stay.
        database("project", other, [copy(other, running, "1.2.128-beta.2", 400)], "fine"),
        // First opened on the running version: no copy for this move.
        database("project", "/n/.ade/ade.db", [], "new"),
      ],
    });
    expect(plan).toEqual({
      targetVersion: "1.2.128-beta.2",
      restores: [
        { kind: "machine", label: "machine", dbPath: machine, copy: expect.objectContaining({ takenAt: 100 }) },
        { kind: "personal", label: "personal", dbPath: personal, copy: expect.objectContaining({ takenAt: 120 }) },
        { kind: "project", label: "broken", dbPath: project, copy: expect.objectContaining({ takenAt: 250 }) },
      ],
      untouched: [
        { kind: "project", label: "fine", dbPath: other },
        { kind: "project", label: "new", dbPath: "/n/.ade/ade.db" },
      ],
      dataFrom: 250,
    });
  });
});
