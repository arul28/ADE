import { describe, expect, it, vi } from "vitest";
import { parseProcessRows, terminateOrphanProcess, waitForProcessExit } from "./processOrphans";

const noWait = async () => {};

describe("parseProcessRows", () => {
  it("reads ps rows and tab-separated rows, and skips anything else", () => {
    expect(parseProcessRows([
      "  101     1 /usr/bin/node /x/server.js --port 4",
      "102\t101\t\"C:\\Program Files\\App\\app.exe\" serve",
      "PID PPID COMMAND",
      "",
    ].join("\r\n"))).toEqual([
      { pid: 101, ppid: 1, command: "/usr/bin/node /x/server.js --port 4" },
      { pid: 102, ppid: 101, command: "\"C:\\Program Files\\App\\app.exe\" serve" },
    ]);
  });
});

describe("waitForProcessExit", () => {
  it("polls until the process is gone, and gives up after the timeout", async () => {
    let checks = 0;
    const waitMs = vi.fn(noWait);
    expect(await waitForProcessExit(7, { timeoutMs: 500, isAlive: () => ++checks < 3, waitMs })).toBe(true);
    expect(waitMs).toHaveBeenCalledTimes(2);

    waitMs.mockClear();
    expect(await waitForProcessExit(7, { timeoutMs: 120, isAlive: () => true, waitMs })).toBe(false);
    // 120 ms at a 50 ms poll is three waits.
    expect(waitMs).toHaveBeenCalledTimes(3);
  });
});

describe("terminateOrphanProcess", () => {
  const base = { graceMs: 100, waitMs: noWait };

  it("escalates SIGTERM to SIGKILL on POSIX", async () => {
    const running = new Set([5]);
    const kill = vi.fn((pid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") running.delete(pid);
    });
    const killTree = vi.fn();

    expect(await terminateOrphanProcess(5, {
      ...base,
      platform: "darwin",
      isAlive: (pid) => running.has(pid),
      kill,
      killTree,
    })).toBe(true);
    expect(kill.mock.calls).toEqual([[5, "SIGTERM"], [5, "SIGKILL"]]);
    expect(killTree).not.toHaveBeenCalled();
  });

  it("uses the tree kill on both passes on Windows and awaits it", async () => {
    const order: string[] = [];
    const killTree = vi.fn(async (pid: number) => {
      await Promise.resolve();
      order.push(`kill ${pid}`);
      return true;
    });
    const kill = vi.fn();

    expect(await terminateOrphanProcess(9, {
      ...base,
      platform: "win32",
      isAlive: () => {
        order.push("check");
        return true;
      },
      kill,
      killTree,
    })).toBe(false);
    expect(killTree).toHaveBeenCalledTimes(2);
    expect(kill).not.toHaveBeenCalled();
    // Each pass waits only after its kill finished.
    expect(order[0]).toBe("kill 9");
  });

  it("stops before a kill that confirm refuses", async () => {
    const kill = vi.fn();
    let confirms = 0;
    const confirm = vi.fn(async () => ++confirms === 1);

    expect(await terminateOrphanProcess(3, {
      ...base,
      platform: "linux",
      isAlive: () => true,
      kill,
      killTree: vi.fn(),
      confirm,
    })).toBe(false);
    expect(kill.mock.calls).toEqual([[3, "SIGTERM"]]);
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});
