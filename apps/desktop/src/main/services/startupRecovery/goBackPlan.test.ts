import { describe, expect, it } from "vitest";
import type { DatabaseCopyInfo } from "../../../shared/types/startupRecovery";
import { chooseGoBackPlan, parseDatabaseCopyName } from "./goBackPlan";

function copy(dbPath: string, toVersion: string, fromVersion: string | null, takenAt: number): DatabaseCopyInfo {
  const fileName = `ade.db.pre-${toVersion}-from-${fromVersion ?? "unknown"}.bak`;
  return {
    path: `${dbPath}.pre-${toVersion}-from-${fromVersion ?? "unknown"}.bak`,
    fileName,
    databaseKind: "machine",
    databaseLabel: "m",
    databasePath: dbPath,
    toVersion,
    fromVersion,
    takenAt,
    sizeBytes: 1,
  };
}

describe("parseDatabaseCopyName", () => {
  it.each([
    ["ade.db.pre-1.2.128-beta.3-from-1.2.128-beta.2.bak", { toVersion: "1.2.128-beta.3", fromVersion: "1.2.128-beta.2" }],
    ["ade.db.pre-1.2.128-from-1.2.128-beta.4.bak", { toVersion: "1.2.128", fromVersion: "1.2.128-beta.4" }],
    // A second copy of the same move.
    ["ade.db.pre-1.2.127-from-1.2.128-beta.3_2.bak", { toVersion: "1.2.127", fromVersion: "1.2.128-beta.3" }],
    // No known previous version: nothing to go back to.
    ["ade.db.pre-1.2.128-from-unknown.bak", { toVersion: "1.2.128", fromVersion: null }],
    ["ade.db.pre-1.2.128-from-before-1.2.127.bak", { toVersion: "1.2.128", fromVersion: null }],
    // Not version copies.
    ["ade.db.pre-crsqlite-w1.bak", null],
    ["ade.db.pre-1.2.128-from-1.2.127.bak.123.tmp", null],
    ["other.db.pre-1.2.128-from-1.2.127.bak", null],
  ])("%s", (fileName, expected) => {
    expect(parseDatabaseCopyName("ade.db", fileName)).toEqual(expected);
  });
});

describe("chooseGoBackPlan", () => {
  const machine = "/h/ade.db";
  const project = "/p/.ade/ade.db";
  const running = "1.2.128-beta.3";

  it.each([
    {
      name: "the update record wins when a copy for that move exists",
      record: { version: running, fromVersion: "1.2.128-beta.1" },
      copies: [copy(machine, running, "1.2.128-beta.2", 300), copy(machine, running, "1.2.128-beta.1", 100)],
      target: "1.2.128-beta.1",
    },
    {
      name: "without a matching copy, the newest copy's version decides",
      record: { version: running, fromVersion: "1.2.127" },
      copies: [copy(machine, running, "1.2.128-beta.2", 300), copy(machine, running, "1.2.128-beta.1", 100)],
      target: "1.2.128-beta.2",
    },
    {
      name: "a record for another version is ignored",
      record: { version: "1.2.128-beta.2", fromVersion: "1.2.128-beta.1" },
      copies: [copy(machine, running, "1.2.128-beta.2", 300), copy(machine, running, "1.2.128-beta.1", 100)],
      target: "1.2.128-beta.2",
    },
    {
      name: "copies into another version are not this update's",
      record: null,
      copies: [copy(machine, "1.2.128-beta.2", "1.2.128-beta.1", 300)],
      target: null,
    },
    {
      name: "no known previous version",
      record: null,
      copies: [copy(machine, running, null, 300)],
      target: null,
    },
    {
      name: "a dev build is never a release to go back to",
      record: null,
      copies: [copy(machine, running, "1.0.0-beta.1", 300), copy(machine, running, "0.0.0", 200)],
      target: null,
    },
  ])("$name", ({ record, copies, target }) => {
    const plan = chooseGoBackPlan({ runningVersion: running, updateRecord: record, databases: [{ label: "m", dbPath: machine, copies }] });
    expect(plan?.targetVersion ?? null).toBe(target);
  });

  it("restores each database's copy for that move and leaves the rest as they are", () => {
    const plan = chooseGoBackPlan({
      runningVersion: running,
      updateRecord: { version: running, fromVersion: "1.2.128-beta.2" },
      databases: [
        { label: "m", dbPath: machine, copies: [copy(machine, running, "1.2.128-beta.2", 100), copy(machine, "1.2.128-beta.2", "1.2.127", 50)] },
        {
          label: "p",
          dbPath: project,
          copies: [
            copy(project, running, "1.2.128-beta.2", 200),
            { ...copy(project, running, "1.2.128-beta.2", 250), path: `${project}.pre-${running}-from-1.2.128-beta.2_2.bak` },
          ],
        },
        // First opened on the running version: no copy for this move.
        { label: "new", dbPath: "/n/.ade/ade.db", copies: [] },
      ],
    });
    expect(plan).toEqual({
      targetVersion: "1.2.128-beta.2",
      restores: [
        { label: "m", dbPath: machine, copy: expect.objectContaining({ takenAt: 100 }) },
        { label: "p", dbPath: project, copy: expect.objectContaining({ takenAt: 250 }) },
      ],
      untouched: [{ label: "new", dbPath: "/n/.ade/ade.db" }],
      dataFrom: 250,
    });
  });
});
