import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Machine widget's ports list and its Stop action, driven through
 * `createMachineMonitor` with the OS tools faked at the process boundary
 * (`execFile`). What it must never do is stop a process that is ADE's own,
 * a Windows service or core process, or root's on macOS, and it must only
 * report success when the process stopped listening.
 */
const tools = vi.hoisted(() => ({
  netstat: "",
  tasklist: "",
  lsof: "",
  taskkill: (_pid: number): { code: number; stdout?: string; stderr?: string } => ({ code: 0 }),
  calls: [] as string[],
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (command: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      const line = `${command} ${args.join(" ")}`;
      tools.calls.push(line);
      queueMicrotask(() => {
        if (/netstat/i.test(command)) return callback(null, tools.netstat, "");
        if (/tasklist/i.test(line)) return callback(null, tools.tasklist, "");
        if (/lsof/.test(command)) return callback(null, tools.lsof, "");
        if (/taskkill/i.test(command)) {
          const result = tools.taskkill(Number(args[1]));
          const error = result.code === 0 ? null : Object.assign(new Error("taskkill failed"), { code: result.code });
          return callback(error, result.stdout ?? "", result.stderr ?? "");
        }
        callback(Object.assign(new Error(`unexpected ${line}`), { code: "ENOENT" }), "", "");
      });
      return {} as never;
    },
  };
});

const { createMachineMonitor } = await import("./homeMachine");

function netstat(rows: Array<[pid: number, port: number]>): string {
  return [
    "Active Connections",
    "  Proto  Local Address          Foreign Address        State           PID",
    ...rows.map(([pid, port]) => `  TCP    0.0.0.0:${port}           0.0.0.0:0              LISTENING       ${pid}`),
  ].join("\r\n");
}

function tasklist(rows: Array<[name: string, pid: number, session: number]>): string {
  return rows.map(([name, pid, session]) => `"${name}","${pid}","${session === 0 ? "Services" : "Console"}","${session}","10,000 K"`).join("\r\n");
}

const OWN_PID = 4242;

function windowsMonitor(isPackaged = true) {
  return createMachineMonitor({ platform: "win32", ownPids: () => [OWN_PID], isPackaged });
}

describe("machine monitor: stopping a listening process", () => {
  const previousOffThread = process.env.ADE_DISABLE_OFF_THREAD_SPAWN;
  const previousVite = process.env.VITE_DEV_SERVER_URL;

  beforeEach(() => {
    // The off-thread spawner is the same capture on a worker; execFile is the boundary here.
    process.env.ADE_DISABLE_OFF_THREAD_SPAWN = "1";
    delete process.env.VITE_DEV_SERVER_URL;
    tools.calls = [];
    tools.netstat = netstat([[900, 3000], [910, 135], [920, 445], [OWN_PID, 7777], [930, 5173]]);
    tools.tasklist = tasklist([
      ["node.exe", 900, 1],
      ["svchost.exe", 910, 1],
      ["vmms.exe", 920, 0],
      ["ADE.exe", OWN_PID, 1],
      ["node.exe", 930, 1],
    ]);
    tools.taskkill = () => ({ code: 0 });
  });

  afterEach(() => {
    if (previousOffThread === undefined) delete process.env.ADE_DISABLE_OFF_THREAD_SPAWN;
    else process.env.ADE_DISABLE_OFF_THREAD_SPAWN = previousOffThread;
    if (previousVite === undefined) delete process.env.VITE_DEV_SERVER_URL;
    else process.env.VITE_DEV_SERVER_URL = previousVite;
  });

  it.each([
    ["a core Windows process outside session 0", 910, true, /system process/],
    ["a service in session 0", 920, true, /system process/],
    ["ADE itself", OWN_PID, true, /ADE's own/],
    ["the dev renderer's server in an unpackaged build", 930, false, /ADE's own/],
    ["a pid nothing is listening on", 1234, true, /no longer listening/],
    ["the System pids", 4, true, /Not a process/],
  ])("refuses to stop %s", async (_label, pid, isPackaged, error) => {
    const monitor = windowsMonitor(isPackaged);
    await expect(monitor.kill(pid)).resolves.toEqual({ ok: false, error: expect.stringMatching(error) });
    expect(tools.calls.some((call) => /taskkill/i.test(call))).toBe(false);
  });

  it("lists the refused ones as protected or system rather than offering them", async () => {
    const result = await windowsMonitor(false).listeners();
    if (!result.ok) throw new Error(result.error);
    const byPid = new Map(result.processes.map((entry) => [entry.pid, entry]));
    expect(byPid.get(900)).toMatchObject({ name: "node.exe", dev: true, protected: false, system: false });
    expect(byPid.get(910)).toMatchObject({ system: true });
    expect(byPid.get(920)).toMatchObject({ system: true });
    expect(byPid.get(OWN_PID)).toMatchObject({ protected: true });
    expect(byPid.get(930)).toMatchObject({ protected: true });
  });

  it("stops the dev server port's process in a packaged build, where 5173 is not ADE's", async () => {
    tools.taskkill = (pid) => {
      tools.netstat = netstat([[900, 3000], [910, 135]].filter(([listener]) => listener !== pid) as Array<[number, number]>);
      return { code: 0 };
    };
    await expect(windowsMonitor(true).kill(930)).resolves.toEqual({ ok: true });
  });

  it.each([
    ["it stopped listening", 0, true, { ok: true }],
    ["taskkill succeeded but it is still listening", 0, false, { ok: false, error: "It is still running." }],
    ["taskkill was denied and it is still listening", 1, false, { ok: false, error: "Reason: Access is denied." }],
    ["taskkill reported failure but the process is gone", 128, true, { ok: true }],
  ])("reports success only when %s", async (_label, code, stops, expected) => {
    tools.taskkill = () => {
      if (stops) tools.netstat = netstat([[910, 135]]);
      return { code, stderr: code === 0 ? "" : "ERROR: Reason: Access is denied." };
    };
    await expect(windowsMonitor().kill(900)).resolves.toEqual(expected);
  });

  it("names a recycled pid afresh before stopping it", async () => {
    const monitor = windowsMonitor();
    const before = await monitor.listeners();
    expect(before.ok && before.processes.find((entry) => entry.pid === 900)).toMatchObject({ name: "node.exe", system: false });

    // The dev server exited and a service took its pid.
    tools.tasklist = tasklist([["svchost.exe", 900, 0], ["svchost.exe", 910, 1]]);
    await expect(monitor.kill(900)).resolves.toEqual({ ok: false, error: expect.stringMatching(/system process/) });
    expect(tools.calls.some((call) => /taskkill/i.test(call))).toBe(false);
  });

  it("refuses root's listeners on macOS when ADE is not root", async () => {
    tools.lsof = ["p700", "claunchd", "u0", "n*:88", "p701", "cnode", "u501", "n127.0.0.1:3000"].join("\n");
    const getuid = Object.getOwnPropertyDescriptor(process, "getuid");
    Object.defineProperty(process, "getuid", { configurable: true, writable: true, value: () => 501 });
    try {
      const monitor = createMachineMonitor({ platform: "darwin", ownPids: () => [] });
      const result = await monitor.listeners();
      if (!result.ok) throw new Error(result.error);
      expect(result.processes.find((entry) => entry.pid === 700)).toMatchObject({ name: "launchd", system: true });
      expect(result.processes.find((entry) => entry.pid === 701)).toMatchObject({ name: "node", system: false, dev: true });
      await expect(monitor.kill(700)).resolves.toEqual({ ok: false, error: expect.stringMatching(/system process/) });
    } finally {
      if (getuid) Object.defineProperty(process, "getuid", getuid);
      else delete (process as { getuid?: unknown }).getuid;
    }
  });
});
