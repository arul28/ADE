import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { watchAntigravityTurnOutcome } from "./antigravityTurnOutcome";

// A static `node:sqlite` import is rewritten by the test bundler into a missing
// `sqlite` URL; load it at runtime, as readOnlySqlite.ts does.
type TestDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => { run: (...args: unknown[]) => unknown };
  close: () => void;
};
const requireForTest = createRequire(path.join(process.cwd(), "antigravity-outcome-test.cjs"));
const { DatabaseSync } = requireForTest("node:sqlite") as {
  DatabaseSync: new (dbPath: string) => TestDatabase;
};

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeSession(sessionId: string): { dir: string; db: TestDatabase } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-agy-outcome-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "conversations"), { recursive: true });
  const db = new DatabaseSync(path.join(dir, "conversations", `${sessionId}.db`));
  db.exec("CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)");
  return { dir, db };
}

function addStep(db: TestDatabase, index: number, type: number, text = ""): void {
  db.prepare("INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)")
    .run(index, type, new TextEncoder().encode(text));
}

/** Takes the check before the turn, then adds the turn's steps and reads the outcome. */
async function outcomeFor(steps: Array<[type: number, text: string]>) {
  const sessionId = crypto.randomUUID();
  const { dir, db } = makeSession(sessionId);
  try {
    addStep(db, 0, 14, "user turn");
    const check = await watchAntigravityTurnOutcome({ sessionId }, dir);
    steps.forEach(([type, text], index) => addStep(db, index + 1, type, text));
    return await check({ stopReason: "end_turn" });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    const cached = tempDirs.indexOf(dir);
    if (cached >= 0) tempDirs.splice(cached, 1);
  }
}

const PLANNER = 15;
const ERROR = 17;

describe("antigravityTurnOutcome", () => {
  it("resumes a 404 that arrives after the model answered, in the Go form", async () => {
    const failure = await outcomeFor([
      [PLANNER, "I will read that document."],
      [ERROR, "Error 404, Message: Requested entity was not found., Status: NOT_FOUND\nstack trace"],
    ]);

    expect(failure).toMatchObject({
      kind: "provider_error",
      message: "Requested entity was not found.",
      code: "NOT_FOUND",
      retryable: true,
      resumeWith: "continue",
    });
  });

  it("resumes a 404 in Antigravity 1.5's status form", async () => {
    const failure = await outcomeFor([
      [PLANNER, "I will read that document."],
      [ERROR, "NOT_FOUND (code 404): Requested entity was not found."],
    ]);

    expect(failure).toMatchObject({
      message: "Requested entity was not found.",
      code: "NOT_FOUND",
      retryable: true,
      resumeWith: "continue",
    });
  });

  it("does not resume a 404 that arrives before the model answered", async () => {
    const failure = await outcomeFor([
      [ERROR, "NOT_FOUND (code 404): Requested entity was not found."],
    ]);

    expect(failure).toMatchObject({
      message: "Requested entity was not found.",
      code: "NOT_FOUND",
      retryable: false,
    });
    expect(failure?.resumeWith).toBeUndefined();
  });

  it("marks a 5xx retryable without resuming it", async () => {
    const failure = await outcomeFor([
      [PLANNER, "I will read that document."],
      [ERROR, "Error 500, Message: Internal error., Status: INTERNAL"],
    ]);

    expect(failure).toMatchObject({ retryable: true });
    expect(failure?.resumeWith).toBeUndefined();
  });

  it("keeps quota exhaustion and its reset time unchanged", async () => {
    const failure = await outcomeFor([
      [PLANNER, "Working."],
      [ERROR, "resource exhausted reason:QUOTA_EXHAUSTED quotaResetDelay:30s ]"],
    ]);

    expect(failure).toMatchObject({ kind: "usage_limit", retryable: true });
    expect(failure?.resetAt).toBeTruthy();
    expect(failure?.resumeWith).toBeUndefined();
  });

  it("keeps an unparseable error generic and non-retryable", async () => {
    const failure = await outcomeFor([[ERROR, "something went wrong"]]);

    expect(failure).toMatchObject({
      kind: "provider_error",
      code: null,
      retryable: false,
    });
    expect(failure?.resumeWith).toBeUndefined();
  });
});
