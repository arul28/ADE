import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ProcessExecution from "../shared/processExecution";

const taskkillMocks = vi.hoisted(() => ({
  sync: vi.fn(() => true),
  async: vi.fn(async () => true),
}));

vi.mock("../shared/processExecution", async (importActual) => ({
  ...(await importActual<typeof ProcessExecution>()),
  killWindowsProcessTree: taskkillMocks.sync,
  killWindowsProcessTreeAsync: taskkillMocks.async,
}));

import {
  isLegacyCursorSdkWorkerCommand,
  recoverCursorSdkWorkerOrphans,
  resetCursorSdkWorkerOrphanSweepForTests,
  selectOrphanedCursorSdkWorkers,
} from "./cursorSdkWorkerOrphans";
import { parseProcessRows } from "../shared/processOrphans";

const WORKER = "/Applications/ADE.app/Contents/Resources/ade-cli/cursorSdkWorker.cjs";
const noWait = async () => {};

afterEach(() => {
  resetCursorSdkWorkerOrphanSweepForTests();
  taskkillMocks.sync.mockClear();
  taskkillMocks.async.mockClear();
});

describe("isLegacyCursorSdkWorkerCommand", () => {
  it("accepts the executables old builds forked the worker with", () => {
    expect(isLegacyCursorSdkWorkerCommand(`/Applications/ADE.app/Contents/MacOS/ADE ${WORKER}`)).toBe(true);
    expect(isLegacyCursorSdkWorkerCommand(
      "/Applications/ADE Beta.app/Contents/MacOS/ADE Beta /Applications/ADE Beta.app/Contents/Resources/ade-cli/cursorSdkWorker.cjs",
    )).toBe(true);
    expect(isLegacyCursorSdkWorkerCommand(
      "/Users/me/Applications/ADE Alpha.app/Contents/MacOS/ADE Alpha /Users/me/Applications/ADE Alpha.app/Contents/Resources/app.asar.unpacked/dist/main/cursorSdkWorker.cjs",
    )).toBe(true);
    // A dev brain, and the npm CLI under a version manager.
    expect(isLegacyCursorSdkWorkerCommand("node /Users/me/src/ADE/apps/ade-cli/dist/cursorSdkWorker.cjs")).toBe(true);
    expect(isLegacyCursorSdkWorkerCommand(
      "/Users/me/.nvm/versions/node/v22.12.0/bin/node /Users/me/.nvm/versions/node/v22.12.0/lib/node_modules/ade-cli/dist/cursorSdkWorker.cjs",
    )).toBe(true);
    // Electron as node, from the dev desktop build.
    expect(isLegacyCursorSdkWorkerCommand(
      "/Users/me/src/ADE/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /Users/me/src/ADE/apps/desktop/dist/main/cursorSdkWorker.cjs",
    )).toBe(true);
    expect(isLegacyCursorSdkWorkerCommand("/usr/bin/node /opt/ade/cursorSdkWorker.cjs\n")).toBe(true);
  });

  it("rejects other programs that only name the worker script", () => {
    expect(isLegacyCursorSdkWorkerCommand(`tail -f ${WORKER}`)).toBe(false);
    expect(isLegacyCursorSdkWorkerCommand("/usr/bin/tail -f /x/cursorSdkWorker.cjs")).toBe(false);
    expect(isLegacyCursorSdkWorkerCommand(`vim ${WORKER}`)).toBe(false);
    expect(isLegacyCursorSdkWorkerCommand(`cat ${WORKER}`)).toBe(false);
    // A folder named ADE is not the app binary.
    expect(isLegacyCursorSdkWorkerCommand("/Users/me/ADE/bin/watch /Users/me/ADE/cursorSdkWorker.cjs")).toBe(false);
    expect(isLegacyCursorSdkWorkerCommand("/Users/me/ADE /Users/me/ADE/cursorSdkWorker.cjs")).toBe(false);
    // The app binary running a script outside its own bundle.
    expect(isLegacyCursorSdkWorkerCommand(
      "/Applications/ADE.app/Contents/MacOS/ADE /tmp/cursorSdkWorker.cjs",
    )).toBe(false);
    // node with flags, or with more arguments after the script.
    expect(isLegacyCursorSdkWorkerCommand("node --inspect /x/cursorSdkWorker.cjs")).toBe(false);
    expect(isLegacyCursorSdkWorkerCommand("node /x/cursorSdkWorker.cjs --watch")).toBe(false);
    expect(isLegacyCursorSdkWorkerCommand("node /x/cursorSdkWorker.cjs.bak")).toBe(false);
  });
});

describe("selectOrphanedCursorSdkWorkers", () => {
  it("selects only workers whose owner is dead", () => {
    const alive = new Set([100, 200]);
    const rows = [
      { pid: 11, ppid: 100, command: `node ${WORKER} --ade-owner-pid=100` },
      { pid: 12, ppid: 1, command: `node ${WORKER} --ade-owner-pid=300` },
      { pid: 13, ppid: 200, command: `node ${WORKER} --ade-owner-pid=200` },
      { pid: 14, ppid: 1, command: `node ${WORKER} --ade-owner-pid=500` },
      { pid: 15, ppid: 1, command: "node /usr/local/bin/some-other-worker.cjs --ade-owner-pid=300" },
    ];

    const selected = selectOrphanedCursorSdkWorkers(rows, {
      selfPid: 500,
      platform: "darwin",
      isAlive: (pid) => alive.has(pid),
    });

    // 11 and 13 have live owners (13 may be another brain). 14 is owned by
    // this process. 15 is not a Cursor worker.
    expect(selected).toEqual([{ pid: 12, ppid: 1, ownerPid: 300 }]);
  });

  it("treats an unmarked worker as orphaned only when POSIX reparented it to init", () => {
    const rows = [
      { pid: 21, ppid: 1, command: `/Applications/ADE.app/Contents/MacOS/ADE ${WORKER}` },
      { pid: 22, ppid: 900, command: `node ${WORKER}` },
      { pid: 23, ppid: 1, command: `tail -f ${WORKER}` },
    ];
    const isAlive = () => true;

    expect(selectOrphanedCursorSdkWorkers(rows, { selfPid: 1, platform: "linux", isAlive }).map((row) => row.pid))
      .toEqual([21]);
    // Windows keeps a dead parent's pid as the ppid, so an unmarked worker
    // cannot be judged there.
    expect(selectOrphanedCursorSdkWorkers(rows, { selfPid: 1, platform: "win32", isAlive })).toEqual([]);
  });

  it("reads POSIX ps rows and the tab-separated Windows query", () => {
    expect(parseProcessRows(`  41   1 node ${WORKER} --ade-owner-pid=7\n`)).toEqual([
      { pid: 41, ppid: 1, command: `node ${WORKER} --ade-owner-pid=7` },
    ]);
    const windowsLine = "42\t7\t\"C:\\Program Files\\ADE\\ADE.exe\" \"C:\\Program Files\\ADE\\resources\\ade-cli\\cursorSdkWorker.cjs\" --ade-owner-pid=7\r\n";
    const [row] = parseProcessRows(windowsLine);
    expect(row).toMatchObject({ pid: 42, ppid: 7 });
    expect(selectOrphanedCursorSdkWorkers([row!], { selfPid: 1, platform: "win32", isAlive: () => false }))
      .toEqual([{ pid: 42, ppid: 7, ownerPid: 7 }]);
  });
});

describe("recoverCursorSdkWorkerOrphans", () => {
  it("uses a forced tree kill on Windows and never a POSIX signal", async () => {
    const running = new Set([31]);
    const killTree = vi.fn((pid: number) => {
      running.delete(pid);
      return true;
    });
    const kill = vi.fn();

    const result = await recoverCursorSdkWorkerOrphans({
      deps: {
        platform: "win32",
        selfPid: 1,
        listProcesses: async () => [
          { pid: 31, ppid: 30, command: `"C:\\ADE\\ADE.exe" "C:\\ADE\\cursorSdkWorker.cjs" --ade-owner-pid=30` },
          { pid: 32, ppid: 40, command: `"C:\\ADE\\ADE.exe" "C:\\ADE\\cursorSdkWorker.cjs" --ade-owner-pid=40` },
        ],
        isAlive: (pid) => pid === 40 || running.has(pid),
        killTree,
        kill,
        waitMs: noWait,
      },
    });

    expect(killTree).toHaveBeenCalledTimes(1);
    expect(killTree).toHaveBeenCalledWith(31);
    expect(kill).not.toHaveBeenCalled();
    expect(result).toEqual({ recoveredPids: [31], failedPids: [] });
  });

  it("kills with the async taskkill on Windows, so the startup sweep never blocks", async () => {
    await recoverCursorSdkWorkerOrphans({
      deps: {
        platform: "win32",
        selfPid: 1,
        listProcesses: async () => [
          { pid: 33, ppid: 30, command: `"C:\\ADE\\ADE.exe" "C:\\ADE\\cursorSdkWorker.cjs" --ade-owner-pid=30` },
        ],
        isAlive: () => false,
        waitMs: noWait,
      },
    });

    expect(taskkillMocks.async).toHaveBeenCalledWith(33);
    expect(taskkillMocks.sync).not.toHaveBeenCalled();
  });

  it("escalates SIGTERM to SIGKILL for an orphan that ignores SIGTERM", async () => {
    const running = new Set([51]);
    const kill = vi.fn((pid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") running.delete(pid);
    });
    const listProcesses = vi.fn(async () => (
      running.has(51) ? [{ pid: 51, ppid: 1, command: `node ${WORKER} --ade-owner-pid=50` }] : []
    ));

    const result = await recoverCursorSdkWorkerOrphans({
      deps: {
        platform: "darwin",
        selfPid: 1,
        listProcesses,
        isAlive: (pid) => running.has(pid),
        kill,
        waitMs: noWait,
      },
    });

    expect(kill.mock.calls).toEqual([[51, "SIGTERM"], [51, "SIGKILL"]]);
    expect(result).toEqual({ recoveredPids: [51], failedPids: [] });
  });

  it("does not escalate against a pid that no longer names the orphan", async () => {
    // The orphan survives SIGTERM, but by the recheck the pid belongs to
    // something else, so SIGKILL must not go out.
    let listed = 0;
    const kill = vi.fn();
    const result = await recoverCursorSdkWorkerOrphans({
      deps: {
        platform: "linux",
        selfPid: 1,
        // The initial listing and the recheck before SIGTERM see the orphan;
        // the recheck before SIGKILL does not.
        listProcesses: async () => (
          listed++ < 2 ? [{ pid: 61, ppid: 1, command: `node ${WORKER} --ade-owner-pid=60` }] : []
        ),
        isAlive: (pid) => pid === 61,
        kill,
        waitMs: noWait,
      },
    });

    expect(kill.mock.calls).toEqual([[61, "SIGTERM"]]);
    expect(result).toEqual({ recoveredPids: [], failedPids: [61] });
  });

  it("re-lists before the first kill of every later orphan", async () => {
    // Orphan 71 takes a full grace to die. By then pid 72 was reused by a
    // process that is not a worker, so its tree must not be killed.
    const running = new Set([71, 72]);
    let reused = false;
    const killTree = vi.fn((pid: number) => {
      running.delete(pid);
      if (pid === 71) reused = true;
      return true;
    });
    const listProcesses = vi.fn(async () => [
      ...(running.has(71) ? [{ pid: 71, ppid: 70, command: `"C:\\ADE\\ADE.exe" "C:\\ADE\\cursorSdkWorker.cjs" --ade-owner-pid=70` }] : []),
      reused
        ? { pid: 72, ppid: 4, command: "\"C:\\Windows\\explorer.exe\"" }
        : { pid: 72, ppid: 70, command: `"C:\\ADE\\ADE.exe" "C:\\ADE\\cursorSdkWorker.cjs" --ade-owner-pid=70` },
    ]);

    const result = await recoverCursorSdkWorkerOrphans({
      deps: {
        platform: "win32",
        selfPid: 1,
        listProcesses,
        isAlive: (pid) => pid === 72 || running.has(pid),
        killTree,
        waitMs: noWait,
      },
    });

    expect(killTree.mock.calls).toEqual([[71]]);
    // The initial listing, then one recheck before each orphan's first kill.
    expect(listProcesses).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ recoveredPids: [71], failedPids: [72] });
  });

  // A current worker can exit on its own once its owner's channel closes, so
  // even the first orphan's pid can be reused between the listing and the kill.
  it("rechecks before the very first kill, so a pid freed after listing is never signalled", async () => {
    let listed = 0;
    const kill = vi.fn();
    const result = await recoverCursorSdkWorkerOrphans({
      deps: {
        platform: "linux",
        selfPid: 1,
        listProcesses: async () => (
          listed++ === 0 ? [{ pid: 81, ppid: 1, command: `node ${WORKER} --ade-owner-pid=80` }] : []
        ),
        isAlive: (pid) => pid === 81,
        kill,
        waitMs: noWait,
      },
    });

    expect(kill).not.toHaveBeenCalled();
    expect(listed).toBe(2);
    expect(result).toEqual({ recoveredPids: [], failedPids: [81] });
  });

  it("runs once per process until a test resets it", async () => {
    const listProcesses = vi.fn(async () => []);
    const deps = { platform: "linux" as const, selfPid: 1, listProcesses, waitMs: noWait };

    await recoverCursorSdkWorkerOrphans({ deps });
    await recoverCursorSdkWorkerOrphans({ deps });
    expect(listProcesses).toHaveBeenCalledTimes(1);

    resetCursorSdkWorkerOrphanSweepForTests();
    await recoverCursorSdkWorkerOrphans({ deps });
    expect(listProcesses).toHaveBeenCalledTimes(2);
  });
});
