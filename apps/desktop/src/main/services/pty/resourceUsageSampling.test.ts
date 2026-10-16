import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  classifyProcessRoles,
  computeAppResourceUsageSnapshot,
  createProcessMetricRowsCollector,
  parseProcessMetricRows,
  type ProcessMetricRow,
  type ProcessMetricSample,
  type ProcessRoleClassification,
} from "./resourceUsageSampling";

type FakeChild = EventEmitter & {
  pid: number;
  stdout: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function createFakeChild(pid = 12_345): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child;
}

function createUnixProcessMetricRowsCollector(
  options: Parameters<typeof createProcessMetricRowsCollector>[0] = {},
) {
  return createProcessMetricRowsCollector({ ...options, platform: "linux" });
}

function row(pid: number, ppid: number, cpuPercent: number, rssKB: number): ProcessMetricRow {
  return { pid, ppid, cpuPercent, rssKB };
}

function usageFor(
  result: ProcessRoleClassification,
  role: ProcessRoleClassification["roleUsage"][number]["role"],
) {
  const usage = result.roleUsage.find((entry) => entry.role === role);
  if (!usage) throw new Error(`Missing role usage for ${role}`);
  return usage;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("parseProcessMetricRows", () => {
  it("parses valid rows and skips malformed, negative-RSS, non-numeric, and empty lines", () => {
    const rows = parseProcessMetricRows([
      "101 1 2.5 2048",
      "garbage text",
      "102 101 0.25 512",
      "103 1 4.0 -1",
      "not-a-pid 1 3.0 1024",
      "",
      "   ",
    ].join("\n"));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ pid: 101, ppid: 1, cpuPercent: 2.5, rssKB: 2048 });
    expect(rows[1]).toEqual({ pid: 102, ppid: 101, cpuPercent: 0.25, rssKB: 512 });
  });
});

describe("createProcessMetricRowsCollector", () => {
  it("does not attempt the Unix process sampler on Windows", async () => {
    const spawnImpl = vi.fn(() => createFakeChild());
    const sample = await createProcessMetricRowsCollector({
      spawnImpl,
      platform: "win32",
    }).collect();

    expect(spawnImpl).not.toHaveBeenCalled();
    expect(sample).toMatchObject({
      rows: null,
      status: "unavailable",
      reason: "unsupported-platform",
      durationMs: 0,
    });
  });

  it("parses chunked stdout after a successful exit", async () => {
    const child = createFakeChild();
    const spawnImpl = vi.fn(() => child);
    const collector = createUnixProcessMetricRowsCollector({ spawnImpl });

    const samplePromise = collector.collect();
    child.stdout.emit("data", "201 1 1.5 1024\n202 ");
    child.stdout.emit("data", "201 2.25 2048\n");
    child.emit("close", 0);
    const sample = await samplePromise;

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(spawnImpl).toHaveBeenCalledWith(
      "ps",
      ["-axo", "pid=,ppid=,pcpu=,rss="],
      {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    expect(sample.status).toBe("ok");
    expect(sample.reason).toBeNull();
    expect(sample.rows).toEqual([
      row(201, 1, 1.5, 1024),
      row(202, 201, 2.25, 2048),
    ]);
    expect(sample.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns unavailable for a nonzero exit", async () => {
    const child = createFakeChild();
    const spawnImpl = vi.fn(() => child);
    const collector = createUnixProcessMetricRowsCollector({ spawnImpl });

    const samplePromise = collector.collect();
    child.stdout.emit("data", "201 1 1.5 1024\n");
    child.emit("close", 1);
    const sample = await samplePromise;

    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(sample.status).toBe("unavailable");
    expect(sample.reason).toBe("exit-code");
    expect(sample.rows).toBeNull();
  });

  it("resolves spawn failures from synchronous throws and child error events", async () => {
    const throwingSpawn = vi.fn(() => {
      throw new Error("spawn failed");
    });
    const thrownSample = await createUnixProcessMetricRowsCollector({
      spawnImpl: throwingSpawn,
    }).collect();

    const child = createFakeChild();
    const emittingSpawn = vi.fn(() => child);
    const emittedPromise = createUnixProcessMetricRowsCollector({
      spawnImpl: emittingSpawn,
    }).collect();
    child.emit("error", new Error("child failed"));
    const emittedSample = await emittedPromise;

    expect(thrownSample).toMatchObject({
      rows: null,
      status: "unavailable",
      reason: "spawn-error",
    });
    expect(emittedSample).toMatchObject({
      rows: null,
      status: "unavailable",
      reason: "spawn-error",
    });
    expect(throwingSpawn).toHaveBeenCalledTimes(1);
    expect(emittingSpawn).toHaveBeenCalledTimes(1);
  });

  it("kills and resolves an open child when sampling times out", async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    const spawnImpl = vi.fn(() => child);
    const collector = createUnixProcessMetricRowsCollector({ spawnImpl, timeoutMs: 50 });

    const samplePromise = collector.collect();
    vi.advanceTimersByTime(50);
    const sample = await samplePromise;

    expect(sample.status).toBe("unavailable");
    expect(sample.reason).toBe("timeout");
    expect(sample.rows).toBeNull();
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("kills and resolves a child whose stdout exceeds the configured bound", async () => {
    const child = createFakeChild();
    const spawnImpl = vi.fn(() => child);
    const collector = createUnixProcessMetricRowsCollector({
      spawnImpl,
      maxStdoutBytes: 64,
    });

    const samplePromise = collector.collect();
    child.stdout.emit("data", "x".repeat(65));
    const sample = await samplePromise;

    expect(sample.status).toBe("unavailable");
    expect(sample.reason).toBe("oversized-output");
    expect(sample.rows).toBeNull();
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("spawns a new child and recovers after a timed-out sample", async () => {
    vi.useFakeTimers();
    const firstChild = createFakeChild(101);
    const secondChild = createFakeChild(102);
    const spawnImpl = vi.fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const collector = createUnixProcessMetricRowsCollector({ spawnImpl, timeoutMs: 25 });

    const firstPromise = collector.collect();
    vi.advanceTimersByTime(25);
    const first = await firstPromise;

    const secondPromise = collector.collect();
    secondChild.stdout.emit("data", "301 1 7.5 4096\n");
    secondChild.emit("close", 0);
    const second = await secondPromise;

    expect(first.reason).toBe("timeout");
    expect(firstChild.kill).toHaveBeenCalledWith("SIGKILL");
    expect(second.status).toBe("ok");
    expect(second.rows).toEqual([row(301, 1, 7.5, 4096)]);
    expect(secondChild.kill).not.toHaveBeenCalled();
    expect(spawnImpl).toHaveBeenCalledTimes(2);
  });

  it("coalesces in-flight callers and spawns again after the sample settles", async () => {
    const firstChild = createFakeChild(101);
    const secondChild = createFakeChild(102);
    const spawnImpl = vi.fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const collector = createUnixProcessMetricRowsCollector({ spawnImpl });

    const first = collector.collect();
    const coalesced = collector.collect();

    expect(coalesced).toBe(first);
    expect(spawnImpl).toHaveBeenCalledTimes(1);

    firstChild.emit("close", 0);
    await first;

    const next = collector.collect();
    expect(next).not.toBe(first);
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    secondChild.emit("close", 0);
    await expect(next).resolves.toMatchObject({ status: "ok", reason: null });
  });

  it("returns immediately while unrelated microtasks and timers continue", async () => {
    vi.useFakeTimers();
    const child = createFakeChild();
    const spawnImpl = vi.fn(() => child);
    const collector = createUnixProcessMetricRowsCollector({ spawnImpl, timeoutMs: 500 });
    let settled = false;
    let microtaskRan = false;
    const unrelatedTimer = vi.fn();

    const samplePromise = collector.collect();
    samplePromise.then(() => {
      settled = true;
    });
    Promise.resolve().then(() => {
      microtaskRan = true;
    });
    setTimeout(unrelatedTimer, 0);

    expect(settled).toBe(false);
    await Promise.resolve();
    expect(microtaskRan).toBe(true);
    expect(settled).toBe(false);
    vi.advanceTimersByTime(0);
    expect(unrelatedTimer).toHaveBeenCalledOnce();

    child.emit("close", 0);
    await expect(samplePromise).resolves.toMatchObject({ status: "ok" });
  });

  it("kills an in-flight child and refuses to spawn after disposal", async () => {
    const child = createFakeChild();
    const spawnImpl = vi.fn(() => child);
    const collector = createUnixProcessMetricRowsCollector({ spawnImpl });

    const inFlight = collector.collect();
    collector.dispose();
    const afterDispose = await collector.collect();

    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(afterDispose).toMatchObject({
      rows: null,
      status: "unavailable",
      reason: "spawn-error",
    });
    expect(spawnImpl).toHaveBeenCalledTimes(1);

    child.emit("close", 1);
    await expect(inFlight).resolves.toMatchObject({ status: "unavailable" });
  });
});

describe("classifyProcessRoles", () => {
  it("gives Electron and ADE runtime identities disjoint precedence", () => {
    const result = classifyProcessRoles({
      rows: [
        row(10, 1, 1, 1024),
        row(20, 1, 2, 2048),
      ],
      electronPids: [10],
      adeRuntimePids: [10, 20],
      adePtyHostPids: [10, 20],
      desktopPtyRoots: [{ pid: 10, kind: "provider-agent" }],
      activePtyCount: 1,
    });

    expect(usageFor(result, "ade-runtime")).toEqual({
      role: "ade-runtime",
      processCount: 1,
      cpuPercent: 2,
      memoryMB: 2,
    });
    expect(usageFor(result, "ade-pty-host").processCount).toBe(0);
    expect(usageFor(result, "provider-agent").processCount).toBe(0);
    expect(result.ptyUsage).toEqual({
      activePtyCount: 1,
      ptyProcessCount: 1,
      ptyCpuPercent: 2,
      ptyMemoryMB: 2,
    });
  });

  it("attributes a provider root and its full descendant tree to provider-agent", () => {
    const result = classifyProcessRoles({
      rows: [
        row(100, 1, 1.25, 1024),
        row(101, 100, 2.25, 2048),
        row(102, 101, 3, 512),
        row(999, 1, 90, 8192),
      ],
      electronPids: [],
      adeRuntimePids: [],
      adePtyHostPids: [],
      desktopPtyRoots: [{ pid: 100, kind: "provider-agent" }],
      activePtyCount: 1,
    });

    expect(usageFor(result, "provider-agent")).toEqual({
      role: "provider-agent",
      processCount: 3,
      cpuPercent: 6.5,
      memoryMB: 3.5,
    });
    expect(result.ptyUsage.ptyProcessCount).toBe(3);
    expect(result.ptyUsage.ptyCpuPercent).toBe(6.5);
    expect(result.ptyUsage.ptyMemoryMB).toBe(3.5);
    expect(usageFor(result, "unknown").processCount).toBe(0);
  });

  it("keeps a shell root as shell while classifying descendants as unknown", () => {
    const result = classifyProcessRoles({
      rows: [
        row(200, 1, 1, 1024),
        row(201, 200, 2, 2048),
        row(202, 201, 3, 3072),
      ],
      electronPids: [],
      adeRuntimePids: [],
      adePtyHostPids: [],
      desktopPtyRoots: [{ pid: 200, kind: "shell" }],
      activePtyCount: 1,
    });

    expect(usageFor(result, "shell").processCount).toBe(1);
    expect(usageFor(result, "unknown")).toEqual({
      role: "unknown",
      processCount: 2,
      cpuPercent: 5,
      memoryMB: 5,
    });
    expect(usageFor(result, "provider-agent").processCount).toBe(0);
    expect(result.ptyUsage.ptyProcessCount).toBe(3);
  });

  it("keeps ADE runtime and PTY host roots explicit while descendants remain unknown", () => {
    const result = classifyProcessRoles({
      rows: [
        row(300, 1, 1, 1024),
        row(301, 300, 2, 2048),
        row(400, 1, 3, 3072),
        row(401, 400, 4, 4096),
      ],
      electronPids: [],
      adeRuntimePids: [300],
      adePtyHostPids: [400],
      desktopPtyRoots: [],
      activePtyCount: 2,
    });

    expect(usageFor(result, "ade-runtime").processCount).toBe(1);
    expect(usageFor(result, "ade-pty-host").processCount).toBe(1);
    expect(usageFor(result, "unknown")).toEqual({
      role: "unknown",
      processCount: 2,
      cpuPercent: 6,
      memoryMB: 6,
    });
    expect(result.ptyUsage.ptyProcessCount).toBe(4);
  });

  it("does not let a provider tree claim an Electron child", () => {
    const result = classifyProcessRoles({
      rows: [
        row(500, 1, 1, 1024),
        row(501, 500, 20, 2048),
        row(502, 501, 30, 4096),
      ],
      electronPids: [501],
      adeRuntimePids: [],
      adePtyHostPids: [],
      desktopPtyRoots: [{ pid: 500, kind: "provider-agent" }],
      activePtyCount: 1,
    });

    expect(usageFor(result, "provider-agent")).toEqual({
      role: "provider-agent",
      processCount: 1,
      cpuPercent: 1,
      memoryMB: 1,
    });
    expect(usageFor(result, "unknown").processCount).toBe(0);
    expect(result.ptyUsage.ptyProcessCount).toBe(1);
    expect(result.ptyUsage.ptyCpuPercent).toBe(1);
  });

  it("ignores a root PID that is absent from the sampled rows", () => {
    const result = classifyProcessRoles({
      rows: [row(601, 600, 5, 1024)],
      electronPids: [],
      adeRuntimePids: [],
      adePtyHostPids: [],
      desktopPtyRoots: [{ pid: 600, kind: "provider-agent" }],
      activePtyCount: 1,
    });

    expect(usageFor(result, "provider-agent").processCount).toBe(0);
    expect(usageFor(result, "unknown").processCount).toBe(0);
    expect(result.ptyUsage).toEqual({
      activePtyCount: 1,
      ptyProcessCount: 0,
      ptyCpuPercent: 0,
      ptyMemoryMB: 0,
    });
  });

  it("distinguishes idle null rows from unavailable active PTY rows", () => {
    const idle = classifyProcessRoles({
      rows: null,
      electronPids: [],
      adeRuntimePids: [],
      adePtyHostPids: [],
      desktopPtyRoots: [],
      activePtyCount: 0,
    });
    const active = classifyProcessRoles({
      rows: null,
      electronPids: [],
      adeRuntimePids: [],
      adePtyHostPids: [],
      desktopPtyRoots: [],
      activePtyCount: 2,
    });

    expect(idle.ptyUsage).toEqual({
      activePtyCount: 0,
      ptyProcessCount: 0,
      ptyCpuPercent: 0,
      ptyMemoryMB: 0,
    });
    expect(active.ptyUsage.ptyProcessCount).toBe(0);
    expect(active.ptyUsage.ptyCpuPercent).toBeNull();
    expect(active.ptyUsage.ptyMemoryMB).toBeNull();
  });

  it("returns only supported non-Electron roles whose counts match the PTY aggregate", () => {
    const result = classifyProcessRoles({
      rows: [
        row(700, 1, 1, 1024),
        row(701, 1, 2, 1024),
        row(702, 1, 3, 1024),
        row(703, 702, 4, 1024),
        row(704, 1, 5, 1024),
      ],
      electronPids: [],
      adeRuntimePids: [700],
      adePtyHostPids: [701],
      desktopPtyRoots: [
        { pid: 702, kind: "provider-agent" },
        { pid: 704, kind: "shell" },
      ],
      activePtyCount: 2,
    });
    const allowedRoles = new Set([
      "ade-runtime",
      "ade-pty-host",
      "provider-agent",
      "shell",
      "unknown",
    ]);

    expect(result.roleUsage).toHaveLength(5);
    expect(result.roleUsage.every((usage) => allowedRoles.has(usage.role))).toBe(true);
    expect(result.roleUsage.reduce((sum, usage) => sum + usage.processCount, 0))
      .toBe(result.ptyUsage.ptyProcessCount);
    expect(result.ptyUsage.ptyProcessCount).toBe(5);
  });
});

describe("computeAppResourceUsageSnapshot", () => {
  it("skips process collection while idle and reports zero legacy PTY fields", async () => {
    const collector = {
      collect: vi.fn(),
      dispose(): void {},
    };

    const snapshot = await computeAppResourceUsageSnapshot({
      getElectronMetrics: () => [],
      getSystemMemoryMB: () => ({ freeMemoryMB: 8_000, totalMemoryMB: 16_000 }),
      collector,
    }, {
      adeRuntimePids: [],
      adePtyHostPids: [],
      desktopPtyRoots: [],
      activePtyCount: 0,
    });

    expect(collector.collect).not.toHaveBeenCalled();
    expect(snapshot.processSample).toEqual({
      status: "skipped",
      reason: "idle",
      sampledAt: null,
      durationMs: null,
    });
    expect({
      activePtyCount: snapshot.activePtyCount,
      ptyProcessCount: snapshot.ptyProcessCount,
      ptyCpuPercent: snapshot.ptyCpuPercent,
      ptyMemoryMB: snapshot.ptyMemoryMB,
    }).toEqual({
      activePtyCount: 0,
      ptyProcessCount: 0,
      ptyCpuPercent: 0,
      ptyMemoryMB: 0,
    });
  });

  it("combines Electron metrics with classified PTY usage and role splits", async () => {
    const metrics = [
      { pid: 1_000, type: "Browser", cpu: { percentCPUUsage: 10.04 }, memory: { workingSetSize: 1024 } },
      { pid: 1_001, type: "Tab", cpu: { percentCPUUsage: 2.16 }, memory: { workingSetSize: 2048 } },
      { pid: 1_002, type: "renderer", cpu: { percentCPUUsage: 3.25 }, memory: { workingSetSize: 3072 } },
      { pid: 1_003, type: "Utility", cpu: { percentCPUUsage: 4.05 }, memory: { workingSetSize: 512 } },
    ];
    const sample: ProcessMetricSample = {
      rows: [
        row(2_000, 1, 5.55, 1536),
        row(2_001, 2_000, 1.05, 512),
      ],
      status: "ok",
      reason: null,
      sampledAt: "2026-07-13T12:00:00.000Z",
      durationMs: 7,
    };
    const collector = {
      collect: vi.fn().mockResolvedValue(sample),
      dispose(): void {},
    };

    const snapshot = await computeAppResourceUsageSnapshot({
      getElectronMetrics: () => metrics,
      getSystemMemoryMB: () => ({ freeMemoryMB: 10_000, totalMemoryMB: 20_000 }),
      collector,
    }, {
      adeRuntimePids: [],
      adePtyHostPids: [],
      desktopPtyRoots: [{ pid: 2_000, kind: "provider-agent" }],
      activePtyCount: 1,
    });

    expect(collector.collect).toHaveBeenCalledOnce();
    expect(snapshot.ptyProcessCount).toBe(2);
    expect(snapshot.ptyCpuPercent).toBe(6.6);
    expect(snapshot.ptyMemoryMB).toBe(2);
    expect(snapshot.processCount).toBe(metrics.length + snapshot.ptyProcessCount);
    expect(snapshot.cpuPercent).toBe(26.1);
    expect(snapshot.memoryMB).toBe(8.5);
    expect(snapshot.mainCpuPercent).toBe(10);
    expect(snapshot.rendererCpuPercent).toBe(5.4);
    expect(snapshot.mainMemoryMB).toBe(1);
    expect(snapshot.rendererMemoryMB).toBe(5);
    expect(snapshot.roleUsage?.slice(0, 3)).toEqual([
      { role: "electron-main", processCount: 1, cpuPercent: 10, memoryMB: 1 },
      { role: "electron-renderer", processCount: 2, cpuPercent: 5.4, memoryMB: 5 },
      { role: "electron-helper", processCount: 1, cpuPercent: 4.1, memoryMB: 0.5 },
    ]);
  });

  it("preserves unavailable sampling state and null PTY metrics", async () => {
    const sample: ProcessMetricSample = {
      rows: null,
      status: "unavailable",
      reason: "timeout",
      sampledAt: "2026-07-13T12:00:00.000Z",
      durationMs: 1_000,
    };
    const collector = {
      collect: vi.fn().mockResolvedValue(sample),
      dispose(): void {},
    };

    const snapshot = await computeAppResourceUsageSnapshot({
      getElectronMetrics: () => [],
      getSystemMemoryMB: () => ({ freeMemoryMB: null, totalMemoryMB: null }),
      collector,
    }, {
      adeRuntimePids: [],
      adePtyHostPids: [],
      desktopPtyRoots: [],
      activePtyCount: 2,
    });

    expect(collector.collect).toHaveBeenCalledOnce();
    expect(snapshot.ptyProcessCount).toBe(0);
    expect(snapshot.ptyCpuPercent).toBeNull();
    expect(snapshot.ptyMemoryMB).toBeNull();
    expect(snapshot.processSample).toEqual({
      status: "unavailable",
      reason: "timeout",
      sampledAt: "2026-07-13T12:00:00.000Z",
      durationMs: 1_000,
    });
  });
});
