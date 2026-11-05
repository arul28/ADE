import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  forgetCliSessionsToReopen,
  recordCliSessionsToReopen,
  takeCliSessionsToReopen,
} from "./cliReopenAfterRestart";

const DAY_MS = 24 * 60 * 60_000;

describe("CLI reopen after restart", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });
  const projectRoot = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-reopen-"));
    roots.push(root);
    return root;
  };

  it("hands a stopped runtime's CLIs to the next start once, and drops stale or forgotten lists", () => {
    const root = projectRoot();
    const stoppedAt = new Date("2026-11-04T12:00:00.000Z");
    const aMinuteLater = () => new Date(stoppedAt.getTime() + 60_000);

    recordCliSessionsToReopen(root, [
      { sessionId: "cli-a", midTurn: true },
      { sessionId: "cli-b", midTurn: false },
    ], () => stoppedAt);
    expect(takeCliSessionsToReopen(root, DAY_MS, aMinuteLater)).toEqual([
      { sessionId: "cli-a", midTurn: true },
      { sessionId: "cli-b", midTurn: false },
    ]);
    // Taken once: another runtime of the project, or the next restart, never
    // reopens the same CLIs again.
    expect(takeCliSessionsToReopen(root, DAY_MS, aMinuteLater)).toEqual([]);

    // A list older than the bound names work that is stale.
    recordCliSessionsToReopen(root, [{ sessionId: "cli-c", midTurn: true }], () => stoppedAt);
    expect(takeCliSessionsToReopen(root, 1_000, () => new Date(stoppedAt.getTime() + 2_000))).toEqual([]);

    // A project removed from the machine forgets its list.
    recordCliSessionsToReopen(root, [{ sessionId: "cli-d", midTurn: false }], () => stoppedAt);
    forgetCliSessionsToReopen(root);
    expect(takeCliSessionsToReopen(root, DAY_MS, aMinuteLater)).toEqual([]);
  });
});
