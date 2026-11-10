import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductAnalyticsCapture } from "../../../../desktop/src/shared/types/productAnalytics";
import {
  createResourcePressureMonitor,
  readResourcePressureRecord,
  RESOURCE_PRESSURE_REARM_MS,
  type ResourcePressureMemory,
} from "./resourcePressureMonitor";

const dirs: string[] = [];
const TICK_MS = 5 * 60_000;

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const memory = (overrides: Partial<ResourcePressureMemory> = {}): ResourcePressureMemory => ({
  totalMb: 36_864,
  availableMb: 20_000,
  pressure: "normal",
  swapUsedMb: 2_000,
  swapTotalMb: 4_096,
  commitUsedMb: null,
  commitLimitMb: null,
  psiSomeAvg10: null,
  ...overrides,
});

function harness(runtimeDir?: string) {
  const dir = runtimeDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "ade-resource-pressure-"));
  if (!runtimeDir) dirs.push(dir);
  let nowMs = Date.parse("2026-11-06T09:00:00.000Z");
  let current = memory();
  const warn = vi.fn();
  const captures: ProductAnalyticsCapture[] = [];
  const readProcesses = vi.fn(async () => ({
    groups: [
      { group: "installed_brain" as const, count: 1, mb: 900, cpuPercent: 2 },
      { group: "android_emulator" as const, count: 6, mb: 26_000, cpuPercent: 40 },
    ],
    emulatorCount: 5,
    devBrainRunning: true,
  }));
  const monitor = createResourcePressureMonitor({
    runtimeDir: dir,
    platform: "darwin",
    logger: { warn, info: vi.fn() },
    capture: (input) => captures.push(input),
    now: () => nowMs,
    readMemory: async () => current,
    readWal: async () => [12],
    readProcesses,
    takeWrites: () => [{ table: "chat_events", writes: 4_000 }],
    cpuUsage: () => ({ user: 0, system: 0 }),
  });
  const tick = async (next?: ResourcePressureMemory) => {
    if (next) current = next;
    nowMs += TICK_MS;
    await monitor.tick();
  };
  return { dir, monitor, tick, warn, captures, readProcesses };
}

describe("createResourcePressureMonitor", () => {
  it("opens one episode per breach, re-arms only after 30 healthy minutes, and keeps the last five", async () => {
    const h = harness();
    // The 2026-11-06 freeze: kernel pressure critical, 15 GB swapped, five
    // emulators. Six breaching samples in a row are one episode, not six.
    for (let index = 0; index < 6; index += 1) {
      await h.tick(memory({ pressure: "critical", swapUsedMb: 15_000, swapTotalMb: 16_384 }));
    }
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn.mock.calls[0]?.[0]).toBe("machine.resource_pressure");
    expect(h.readProcesses).toHaveBeenCalledTimes(1);
    expect(h.captures).toHaveLength(1);
    expect(h.captures[0]).toMatchObject({
      event: "ade_resource_pressure",
      dedupeKey: "resource_pressure:memory",
      minimumIntervalMs: 6 * 60 * 60_000,
      properties: {
        kind: "memory",
        severity: "critical",
        emulator_count: "5_plus",
        dev_brain_running: true,
        ram_gb_bucket: "33_64",
        available_pct: 54,
        ade_mb: 900,
        ade_pct_of_ram: 2,
      },
    });
    // The top table names a database only for a WAL or CPU breach.
    expect(h.captures[0]?.properties).not.toHaveProperty("top_table");
    // Group names and numbers only on the way out.
    expect(JSON.stringify(h.warn.mock.calls[0]?.[1])).not.toMatch(/\/|qemu|ADE\.app/);

    // A healthy dip shorter than the re-arm window does not end the episode.
    await h.tick(memory());
    await h.tick(memory({ pressure: "warn" }));
    expect(h.captures).toHaveLength(1);
    // Thirty minutes healthy ends it; the next breach is a new episode.
    for (let elapsed = 0; elapsed <= RESOURCE_PRESSURE_REARM_MS; elapsed += TICK_MS) await h.tick(memory());
    await h.tick(memory({ availableMb: 1_000 }));
    expect(h.captures).toHaveLength(2);
    expect(readResourcePressureRecord(h.dir)?.episodes.map((episode) => episode.kinds)).toEqual([
      ["memory", "swap"],
      ["memory"],
    ]);
    expect(readResourcePressureRecord(h.dir)?.episodes[0]?.closedAt).not.toBeNull();

    // A brain restarted mid-episode continues it rather than opening another.
    const restarted = harness(h.dir);
    await restarted.tick(memory({ availableMb: 1_000 }));
    expect(restarted.captures).toHaveLength(0);

    // Only the last five episodes stay on disk.
    for (let episode = 0; episode < 6; episode += 1) {
      for (let elapsed = 0; elapsed <= RESOURCE_PRESSURE_REARM_MS; elapsed += TICK_MS) await restarted.tick(memory());
      await restarted.tick(memory({ availableMb: 1_000 }));
    }
    expect(restarted.captures).toHaveLength(6);
    expect(readResourcePressureRecord(h.dir)?.episodes).toHaveLength(5);
  });

  it("reads a Mac's elastic swap against its RAM, not against the swap it has grown", async () => {
    const h = harness();
    // macOS grows swap as it needs it, so used-of-total is near full on any
    // Mac that swaps at all; that alone is not pressure.
    await h.tick(memory({ swapUsedMb: 4_000, swapTotalMb: 4_096 }));
    expect(h.captures).toHaveLength(0);
    await h.tick(memory({ swapUsedMb: 13_000, swapTotalMb: 14_336 }));
    expect(h.captures[0]?.properties).toMatchObject({ kind: "swap", severity: "warn" });
  });
});
