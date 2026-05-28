import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openKvDb, type AdeDb } from "../state/kvDb";
import { createProcessRegistryService } from "./processRegistryService";

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

async function createDb(): Promise<AdeDb> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-process-registry-"));
  return await openKvDb(path.join(root, ".ade", "ade.db"), createLogger() as any);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("processRegistryService", () => {
  it("start inserts a row and stop removes it", async () => {
    const db = await createDb();
    const service = createProcessRegistryService({
      db,
      logger: createLogger() as any,
      pid: 12_345,
      role: "desktop-main",
      projectRoot: "/repo/ade",
      heartbeatIntervalMs: 60_000,
      livenessWindowMs: 15_000,
    });

    service.start();
    expect(service.listAllProcesses()).toEqual([
      expect.objectContaining({
        pid: 12_345,
        role: "desktop-main",
        projectRoot: "/repo/ade",
      }),
    ]);

    service.stop();
    expect(service.listAllProcesses()).toEqual([]);
    db.close();
  });

  it("heartbeat advances last_seen", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-17T00:00:00.000Z"));
    const db = await createDb();
    const service = createProcessRegistryService({
      db,
      logger: createLogger() as any,
      pid: 12_345,
      role: "tui-runtime",
      heartbeatIntervalMs: 60_000,
      livenessWindowMs: 15_000,
    });

    service.start();
    const first = service.listAllProcesses()[0]?.lastSeen;
    vi.setSystemTime(new Date("2026-03-17T00:00:05.000Z"));
    service.heartbeat();
    const second = service.listAllProcesses()[0]?.lastSeen;

    expect(first).toBe("2026-03-17T00:00:00.000Z");
    expect(second).toBe("2026-03-17T00:00:05.000Z");
    service.stop();
    db.close();
  });

  it("listLivePids includes own pid before start and excludes stale peers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-17T00:00:20.000Z"));
    const db = await createDb();
    db.run(
      "insert into runtime_processes(pid, role, project_root, started_at, last_seen) values (?, ?, ?, ?, ?)",
      [99_999, "desktop-main", "/repo/ade", "2026-03-17T00:00:00.000Z", "2026-03-17T00:00:00.000Z"],
    );
    const service = createProcessRegistryService({
      db,
      logger: createLogger() as any,
      pid: 12_345,
      role: "tui-runtime",
      heartbeatIntervalMs: 5_000,
      livenessWindowMs: 15_000,
    });

    expect(service.listLivePids()).toEqual(new Set([12_345]));
    expect(service.listKnownPids()).toEqual(new Set([12_345, 99_999]));
    expect(service.listKnownProcessIdentities()).toEqual(expect.arrayContaining([
      { pid: 99_999, startedAt: "2026-03-17T00:00:00.000Z" },
    ]));
    expect(service.isPidLive(12_345)).toBe(true);
    expect(service.isPidLive(99_999)).toBe(false);
    db.close();
  });

  it("isPidLive matches live peer rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-17T00:00:20.000Z"));
    const db = await createDb();
    db.run(
      "insert into runtime_processes(pid, role, project_root, started_at, last_seen) values (?, ?, ?, ?, ?)",
      [99_999, "ade-serve-daemon", "/repo/ade", "2026-03-17T00:00:10.000Z", "2026-03-17T00:00:10.000Z"],
    );
    const service = createProcessRegistryService({
      db,
      logger: createLogger() as any,
      pid: 12_345,
      role: "desktop-main",
      heartbeatIntervalMs: 5_000,
      livenessWindowMs: 15_000,
      pidLivenessCheck: (pid) => pid === 99_999,
    });

    expect(service.listLivePids()).toEqual(new Set([12_345, 99_999]));
    expect(service.isPidLive(99_999)).toBe(true);
    expect(service.listLiveProcessIdentities()).toEqual(expect.arrayContaining([
      { pid: 99_999, startedAt: "2026-03-17T00:00:10.000Z" },
    ]));
    expect(service.isProcessIdentityLive(99_999, "2026-03-17T00:00:10.000Z")).toBe(true);
    expect(service.isProcessIdentityLive(99_999, "2026-03-17T00:00:09.000Z")).toBe(false);
    db.close();
  });

  it("keeps previous process incarnations known but not live when a pid is reused", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-17T00:00:20.000Z"));
    const db = await createDb();
    db.run(
      "insert into runtime_processes(pid, role, project_root, started_at, last_seen) values (?, ?, ?, ?, ?)",
      [12_345, "desktop-main", "/repo/ade", "2026-03-17T00:00:10.000Z", "2026-03-17T00:00:19.000Z"],
    );
    const service = createProcessRegistryService({
      db,
      logger: createLogger() as any,
      pid: 12_345,
      role: "tui-runtime",
      heartbeatIntervalMs: 5_000,
      livenessWindowMs: 15_000,
      pidLivenessCheck: (pid) => pid === 12_345,
    });

    service.start();

    expect(service.listKnownProcessIdentities()).toEqual(expect.arrayContaining([
      { pid: 12_345, startedAt: "2026-03-17T00:00:10.000Z" },
      { pid: 12_345, startedAt: "2026-03-17T00:00:20.000Z" },
    ]));
    expect(service.listLiveProcessIdentities()).toEqual([
      { pid: 12_345, startedAt: "2026-03-17T00:00:20.000Z" },
    ]);
    expect(service.isProcessIdentityLive(12_345, "2026-03-17T00:00:10.000Z")).toBe(false);
    expect(service.isProcessIdentityLive(12_345, "2026-03-17T00:00:20.000Z")).toBe(true);

    service.stop();
    db.close();
  });

  it("excludes fresh heartbeat rows whose process no longer exists", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-17T00:00:20.000Z"));
    const db = await createDb();
    db.run(
      "insert into runtime_processes(pid, role, project_root, started_at, last_seen) values (?, ?, ?, ?, ?)",
      [99_999, "ade-serve-daemon", "/repo/ade", "2026-03-17T00:00:10.000Z", "2026-03-17T00:00:19.000Z"],
    );
    const service = createProcessRegistryService({
      db,
      logger: createLogger() as any,
      pid: 12_345,
      role: "desktop-main",
      heartbeatIntervalMs: 5_000,
      livenessWindowMs: 15_000,
      pidLivenessCheck: () => false,
    });

    expect(service.listLivePids()).toEqual(new Set([12_345]));
    expect(service.listLiveProcessIdentities()).toEqual([{ pid: 12_345, startedAt: "2026-03-17T00:00:20.000Z" }]);
    expect(service.isPidLive(99_999)).toBe(false);
    expect(service.isProcessIdentityLive(99_999, "2026-03-17T00:00:10.000Z")).toBe(false);
    db.close();
  });

  it("pruneStale deletes old peer rows and keeps own row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-17T00:01:00.000Z"));
    const db = await createDb();
    const service = createProcessRegistryService({
      db,
      logger: createLogger() as any,
      pid: 12_345,
      role: "desktop-main",
      heartbeatIntervalMs: 5_000,
      livenessWindowMs: 1_000,
    });
    service.start();
    db.run(
      "insert into runtime_processes(pid, role, project_root, started_at, last_seen) values (?, ?, ?, ?, ?)",
      [99_999, "tui-runtime", "/repo/ade", "2026-03-17T00:00:00.000Z", "2026-03-17T00:00:00.000Z"],
    );

    expect(service.pruneStale()).toBe(1);
    expect(service.listAllProcesses().map((row) => row.pid)).toEqual([12_345]);
    service.stop();
    db.close();
  });
});
