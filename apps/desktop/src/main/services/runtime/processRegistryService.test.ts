import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdeDb } from "../state/kvDb";
import { openFreshKvDb } from "../../../test/freshKvDb";

/**
 * Which earlier runs the startup rescan may call dead at once
 * (`listDeadProcessIdentities`): their chats then continue within seconds of
 * a restart instead of after the fresh-activity grace.
 */
describe("process registry: dead runs after a restart", () => {
  const roots: string[] = [];
  const dbs: AdeDb[] = [];
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  const OWN_PID = 69;
  const OTHER_PID = 4_242;
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  // The clock and this process's uptime are fixed: the process started 100 s before "now".
  const NOW_MS = Date.parse("2026-11-17T05:00:00.000Z");
  const PROCESS_START_MS = NOW_MS - 100_000;
  const iso = (ms: number) => new Date(ms).toISOString();

  it.each<[string, { pid: number; startedAt: string; otherPidRunning?: boolean }, boolean]>([
    ["this process's pid from a run before it started (a restarted container reuses the pid): dead", { pid: OWN_PID, startedAt: iso(PROCESS_START_MS - 60_000) }, true],
    ["this process's pid from just before its start, inside the 1 s allowance: not dead", { pid: OWN_PID, startedAt: iso(PROCESS_START_MS - 500) }, false],
    ["this process's pid from a registry it opened earlier (after the process started): not dead", { pid: OWN_PID, startedAt: iso(PROCESS_START_MS + 30_000) }, false],
    ["another pid that is gone: dead", { pid: OTHER_PID, startedAt: iso(PROCESS_START_MS - 60_000), otherPidRunning: false }, true],
    ["another pid that a new process now holds: not dead (the safe side)", { pid: OTHER_PID, startedAt: iso(PROCESS_START_MS - 60_000), otherPidRunning: true }, false],
  ])("%s", async (_label, row, dead) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-process-registry-"));
    roots.push(root);
    const db = await openFreshKvDb(path.join(root, "ade.db"), logger as never);
    dbs.push(db);
    db.run(
      "insert into runtime_processes (pid, role, project_root, started_at, last_seen) values (?, ?, ?, ?, ?)",
      [row.pid, "ade-serve-daemon", root, row.startedAt, row.startedAt],
    );
    vi.useFakeTimers({ now: NOW_MS, toFake: ["Date"] });
    vi.spyOn(process, "uptime").mockReturnValue((NOW_MS - PROCESS_START_MS) / 1000);
    // Loaded after the clock is set: the module reads the process start once, when it loads.
    const { createProcessRegistryService } = await import("./processRegistryService");
    const registry = createProcessRegistryService({
      db,
      logger: logger as never,
      pid: OWN_PID,
      role: "ade-serve-daemon",
      pidLivenessCheck: (pid) => pid === OWN_PID || (pid === OTHER_PID && row.otherPidRunning === true),
    });

    const found = registry.listDeadProcessIdentities();

    expect(found.some((identity) => identity.pid === row.pid && identity.startedAt === row.startedAt)).toBe(dead);
    // This registry's own run is never dead.
    expect(found.some((identity) => identity.startedAt === registry.startedAt)).toBe(false);
  });
});
