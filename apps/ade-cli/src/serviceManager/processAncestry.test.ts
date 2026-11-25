import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServiceManagerProcessResult, ServiceManagerSpawnSync } from "./common";
import {
  buildWindowsAncestryQueryArgs,
  isCurrentProcessDescendantOfPid,
  PARENT_PID_UNKNOWN,
  readCurrentProcessAncestorPids,
  refuseSelfServiceMutation,
} from "./processAncestry";

describe("isCurrentProcessDescendantOfPid", () => {
  it.each([
    ["descends from the target pid", { 400: 300, 300: 100, 100: 1 }, true],
    ["is in an unrelated process tree", { 400: 300, 300: 1 }, false],
    ["sits under a parent cycle", { 400: 300, 300: 200, 200: 300 }, false],
  ])("answers when the current process %s", (_name, tree, expected) => {
    expect(isCurrentProcessDescendantOfPid({
      targetPid: 100,
      currentPid: 400,
      parentPid: (pid) => (tree as Record<number, number>)[pid] ?? null,
    })).toBe(expected);
  });
});

// These exercise the DEFAULT Windows ancestry backend. The suite above injects a
// fake `parentPid` every time, which is exactly how a Windows host could ship an
// ancestry read that always ended at the first hop — and therefore a
// self-shutdown guard that never fired — with a green Windows CI job.
describe("process ancestry on win32", () => {
  // A trusted powershell path, never a bare `powershell` resolved off PATH.
  const TRUSTED_POWERSHELL = /[\\/]system32[\\/]windowspowershell[\\/]v1\.0[\\/]powershell\.exe$/i;

  type FakeProcess = { parent: number; exe?: string };

  /**
   * A Windows host: `Win32_Process` answers from `processes` (a pid missing from
   * it does not exist), and an MSYS `ps.exe` answers `ps` when one is asked.
   */
  const windowsHost = (
    processes: Record<number, FakeProcess>,
    ps?: ServiceManagerProcessResult,
  ): { run: ServiceManagerSpawnSync; calls: Array<{ command: string; args: string[] }> } => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const known = new Set<number>();
    for (const [pid, row] of Object.entries(processes)) known.add(Number(pid)).add(row.parent);
    const run: ServiceManagerSpawnSync = (command, args) => {
      calls.push({ command, args });
      if (/[\\/]ps\.exe$/i.test(command)) return ps ?? { status: 1, stdout: "", stderr: "no ps" };
      if (!TRUSTED_POWERSHELL.test(command)) {
        // Git Bash's `ps` rejects the POSIX flags; a clean Windows box reports ENOENT.
        return { status: 1, stdout: "", stderr: "ps: unknown option -- o\n" };
      }
      let cursor = [...known].find((pid) => pid > 0
        && JSON.stringify(args) === JSON.stringify(buildWindowsAncestryQueryArgs(pid))) ?? 0;
      if (!cursor) return { status: 1, stdout: "", stderr: "not the ancestry query" };
      const lines: string[] = [];
      const seen = new Set<number>();
      while (cursor > 0 && !seen.has(cursor)) {
        seen.add(cursor);
        const row = processes[cursor];
        if (!row) return { status: 0, stdout: [...lines, "E\tbroken"].join("\n") };
        lines.push(`P\t${cursor}\t${row.parent}\t${row.exe ?? ""}`);
        cursor = row.parent;
      }
      return { status: 0, stdout: [...lines, "E\troot"].join("\n") };
    };
    return { run, calls };
  };

  it("walks the whole chain in one trusted PowerShell call", () => {
    const { run, calls } = windowsHost({ 400: { parent: 300 }, 300: { parent: 100 }, 100: { parent: 0 } });

    expect(readCurrentProcessAncestorPids({ run, currentPid: 400, platform: "win32" })).toEqual(new Set([400, 300, 100]));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toMatch(TRUSTED_POWERSHELL);
  });

  it.each([
    ["inside the runtime's process tree", { 400: { parent: 300 }, 300: { parent: 100 }, 100: { parent: 0 } }, true],
    ["an unrelated process tree", { 400: { parent: 300 }, 300: { parent: 1 }, 1: { parent: 0 } }, false],
    // A parent that is gone (outside MSYS) is the end of the chain, as it always was.
    ["a chain whose parent is gone", { 400: { parent: 300 }, 300: { parent: 250 } }, false],
  ])("answers for %s", (_name, processes, expected) => {
    const { run } = windowsHost(processes);
    expect(isCurrentProcessDescendantOfPid({ targetPid: 100, currentPid: 400, platform: "win32", run })).toBe(expected);
  });

  it.each<[string, ServiceManagerProcessResult]>([
    ["the query fails", { status: 1, stdout: "", stderr: "Get-CimInstance is not recognized" }],
    ["the query never ran", { status: null, stdout: null, stderr: null }],
    ["the output has no end line", { status: 0, stdout: "P\t400\t300\t" }],
    ["the output is not the walk", { status: 0, stdout: "not-a-pid" }],
    ["the walk ran out of depth", { status: 0, stdout: "P\t400\t300\t\nE\tdepth" }],
    // This process exists while it asks; a walk that cannot find it found nothing.
    ["the walk cannot find this process", { status: 0, stdout: "E\tbroken" }],
  ])("fails closed when %s", (_name, reply) => {
    // Destroying a live runtime is unrecoverable; a refusal that names the
    // ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION override is not.
    expect(readCurrentProcessAncestorPids({ run: () => reply, currentPid: 400, platform: "win32" })).toBe(PARENT_PID_UNKNOWN);
    expect(isCurrentProcessDescendantOfPid({ targetPid: 100, currentPid: 400, platform: "win32", run: () => reply })).toBe(true);
  });

  describe("inside Git Bash (MSYS)", () => {
    let msysBin: string;
    beforeAll(() => {
      msysBin = fs.mkdtempSync(path.join(os.tmpdir(), "ade-msys-bin-"));
      fs.writeFileSync(path.join(msysBin, "msys-2.0.dll"), "");
    });
    afterAll(() => { fs.rmSync(msysBin, { recursive: true, force: true }); });

    // `ade` from Git Bash is a `#!/bin/sh … exec ade.exe` shim. MSYS replaces
    // `sh.exe`'s Windows process on exec, so ade.exe (400) has a live `sh.exe`
    // parent (350) whose own Windows parent (349) is gone. MSYS pid 12 is that
    // script, now running as Windows pid 400; its MSYS parent 11 is the agent's
    // bash, Windows pid 300, a child of the brain (100).
    const brokenByExec = (): Record<number, FakeProcess> => ({
      400: { parent: 350 },
      350: { parent: 349, exe: path.join(msysBin, "sh.exe") },
      300: { parent: 100, exe: path.join(msysBin, "bash.exe") },
      100: { parent: 0 },
    });
    const psListing = (rows: string[]): ServiceManagerProcessResult => ({
      status: 0,
      stdout: ["      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND", ...rows].join("\n"),
    });

    it("follows MSYS's own parent across the exec and finds the brain", () => {
      const { run } = windowsHost(brokenByExec(), psListing([
        "       11       1      11        300  ?         197609 00:25:19 /usr/bin/bash",
        "       12      11      11        400  ?         197609 00:25:19 /c/Program Files/ADE/ADE",
        "    65540       0       0          4  ?              0   Oct 20 System",
      ]));
      expect(isCurrentProcessDescendantOfPid({ targetPid: 100, currentPid: 400, platform: "win32", run })).toBe(true);
    });

    it.each<[string, ServiceManagerProcessResult]>([
      ["MSYS cannot list its processes", { status: 1, stdout: "", stderr: "ps failed" }],
      ["MSYS does not know the process", psListing(["       11       1      11        300  ?    197609 00:25:19 /usr/bin/bash"])],
    ])("fails closed when %s", (_name, ps) => {
      const { run } = windowsHost(brokenByExec(), ps);
      expect(readCurrentProcessAncestorPids({ run, currentPid: 400, platform: "win32" })).toBe(PARENT_PID_UNKNOWN);
    });

    it("ends the chain at an MSYS process that has no MSYS parent", () => {
      const { run } = windowsHost(brokenByExec(), psListing([
        "       12       1      12        400  ?         197609 00:25:19 /c/Program Files/ADE/ADE",
      ]));
      expect(isCurrentProcessDescendantOfPid({ targetPid: 100, currentPid: 400, platform: "win32", run })).toBe(false);
    });
  });

  // A blown `timeout` budget is the one failure that is purely about the host
  // being busy: powershell.exe cold start plus the first CIM call of a session
  // can outrun the budget on a saturated box. Treating that as "ancestry
  // unknown" refuses a teardown the user is entitled to, so it gets one retry.
  const timedOut = (): ServiceManagerProcessResult => ({
    status: null,
    stdout: null,
    stderr: null,
    signal: "SIGTERM",
    error: Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), {
      code: "ETIMEDOUT",
    }),
  });

  const budgetRecordingRun = (
    replies: Array<() => ServiceManagerProcessResult>,
  ): { run: ServiceManagerSpawnSync; timeouts: Array<number | undefined> } => {
    const timeouts: Array<number | undefined> = [];
    const run: ServiceManagerSpawnSync = (_command, _args, options) => {
      const reply = replies[timeouts.length];
      timeouts.push(options?.timeout);
      if (!reply) throw new Error("the ancestry query ran more attempts than expected");
      return reply();
    };
    return { run, timeouts };
  };
  const rootWalk = (): ServiceManagerProcessResult => ({ status: 0, stdout: "P\t400\t0\t\nE\troot" });
  const read = (run: ServiceManagerSpawnSync) => readCurrentProcessAncestorPids({ run, currentPid: 400, platform: "win32" });

  it("retries a timed-out query once, on a longer budget", () => {
    const { run, timeouts } = budgetRecordingRun([timedOut, rootWalk]);
    expect(read(run)).toEqual(new Set([400]));
    expect(timeouts).toHaveLength(2);
    // The retry must be strictly more generous, or it just repeats the failure.
    expect(timeouts[1]).toBeGreaterThan(timeouts[0] ?? 0);
  });

  it("stops after the retry also times out", () => {
    const { run, timeouts } = budgetRecordingRun([timedOut, timedOut]);
    expect(read(run)).toBe(PARENT_PID_UNKNOWN);
    expect(timeouts).toHaveLength(2);
  });

  it.each<[string, () => ServiceManagerProcessResult]>([
    ["an answer", rootWalk],
    ["a real tool failure", () => ({ status: 1, stdout: "", stderr: "CIM unavailable" })],
    // powershell absent: no ETIMEDOUT and no SIGTERM.
    ["a spawn that never ran", () => ({ status: null, stdout: null, stderr: null })],
  ])("does not retry %s", (_name, reply) => {
    const { run, timeouts } = budgetRecordingRun([reply]);
    read(run);
    expect(timeouts).toHaveLength(1);
  });
});

describe("refuseSelfServiceMutation", () => {
  // This process (400) runs inside brain 100.
  const insideBrain = (pid: number) => ({ 400: 300, 300: 100, 100: 1 } as Record<number, number>)[pid] ?? null;
  const base = {
    action: "uninstall" as const,
    path: "/svc",
    platform: "darwin" as const,
    currentPid: 400,
    parentPid: insideBrain,
  };

  it.each([
    ["a pid it would stop is an ancestor", { pids: [999, 100], env: {} }, { selfMutationBlocked: true }],
    ["no pid it would stop is an ancestor", { pids: [999], env: {} }, null],
    ["the override is set", { pids: [100], env: { ADE_ALLOW_RUNTIME_SERVICE_SELF_MUTATION: "1" } }, null],
    ["it would stop nothing", { pids: [null, undefined], env: {} }, null],
  ])("answers when %s", (_name, args, expected) => {
    const result = refuseSelfServiceMutation({ ...base, ...args });
    if (expected === null) expect(result).toBeNull();
    else expect(result).toMatchObject({ ok: false, ...expected });
  });

  it("refuses, marked unconfirmed, when the ancestry cannot be read", () => {
    const result = refuseSelfServiceMutation({ ...base, pids: [100], env: {}, parentPid: () => PARENT_PID_UNKNOWN });
    expect(result).toMatchObject({ ok: false, selfMutationBlocked: true, selfMutationUnconfirmed: true });
  });
});

describe.runIf(process.platform === "win32")("process ancestry against the real Windows host", () => {
  // 90s, not 30s: the lookup's own worst case is a cold-start timeout plus its
  // retry, and this suite runs alongside other Windows suites on a 2-core
  // runner. A test budget under the code's budget turns a slow host into a
  // failure that reads like a broken ancestry query.
  it("includes this process's actual parent", () => {
    // process.ppid is an independent oracle for the same fact.
    const ancestors = readCurrentProcessAncestorPids();
    expect(ancestors).not.toBe(PARENT_PID_UNKNOWN);
    expect((ancestors as ReadonlySet<number>).has(process.ppid)).toBe(true);
  }, 90_000);

  it("reports the real parent as an ancestor of this process", () => {
    expect(isCurrentProcessDescendantOfPid({ targetPid: process.ppid })).toBe(true);
  }, 90_000);
});
