import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openFreshKvDb } from "../../../test/freshKvDb";
import { createProcessRegistryService } from "./processRegistryService";

/**
 * Which earlier runs the startup rescan may call dead at once
 * (`listDeadProcessIdentities`): their chats then continue within seconds of
 * a restart instead of after the fresh-activity grace.
 */
describe("process registry: dead runs after a restart", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  const OWN_PID = 69;
  const OTHER_PID = 4_242;
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

  it.each<[string, { pid: number; startedAt: () => string; otherPidRunning?: boolean }, boolean]>([
    [
      "this process's pid from a run before it started (a restarted container reuses the pid): dead",
      { pid: OWN_PID, startedAt: () => "2020-01-01T00:00:00.000Z" },
      true,
    ],
    [
      "this process's pid from a registry it opened later (a project reopened): not dead",
      { pid: OWN_PID, startedAt: () => iso(60_000) },
      false,
    ],
    ["another pid that is gone: dead", { pid: OTHER_PID, startedAt: () => "2020-01-01T00:00:00.000Z", otherPidRunning: false }, true],
    [
      "another pid that a new process now holds: not dead (the safe side)",
      { pid: OTHER_PID, startedAt: () => "2020-01-01T00:00:00.000Z", otherPidRunning: true },
      false,
    ],
  ])("%s", async (_label, row, dead) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-process-registry-"));
    roots.push(root);
    const db = await openFreshKvDb(path.join(root, "ade.db"), logger as never);
    const startedAt = row.startedAt();
    db.run(
      "insert into runtime_processes (pid, role, project_root, started_at, last_seen) values (?, ?, ?, ?, ?)",
      [row.pid, "ade-serve-daemon", root, startedAt, startedAt],
    );
    const registry = createProcessRegistryService({
      db,
      logger: logger as never,
      pid: OWN_PID,
      role: "ade-serve-daemon",
      pidLivenessCheck: (pid) => pid === OWN_PID || (pid === OTHER_PID && row.otherPidRunning === true),
    });

    const found = registry.listDeadProcessIdentities().some((identity) => identity.pid === row.pid && identity.startedAt === startedAt);

    expect(found).toBe(dead);
    // This process's own run is never dead.
    expect(registry.listDeadProcessIdentities().some((identity) => identity.startedAt === registry.startedAt)).toBe(false);
  });
});
