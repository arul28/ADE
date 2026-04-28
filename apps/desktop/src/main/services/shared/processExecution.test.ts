import type * as childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof childProcess>("node:child_process");
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
  };
});

import {
  killWindowsProcessTree,
  quoteWindowsCmdArg,
  resolveCliSpawnInvocation,
  resolveWindowsCmdLineInvocation,
  resolveWindowsCmdInvocation,
  shouldUseWindowsCmdWrapper,
  terminateProcessTree,
} from "./processExecution";

describe("processExecution", () => {
  it("detects Windows command shims and extensionless commands", () => {
    expect(shouldUseWindowsCmdWrapper("codex", "win32")).toBe(true);
    expect(shouldUseWindowsCmdWrapper("C:\\tools\\codex.cmd", "win32")).toBe(true);
    expect(shouldUseWindowsCmdWrapper("C:\\tools\\codex.bat", "win32")).toBe(true);
    expect(shouldUseWindowsCmdWrapper("C:\\tools\\codex.exe", "win32")).toBe(false);
    expect(shouldUseWindowsCmdWrapper("codex", "linux")).toBe(false);
  });

  it("quotes cmd arguments consistently", () => {
    expect(quoteWindowsCmdArg("C:\\Program Files\\tool.cmd")).toBe('"C:\\Program Files\\tool.cmd"');
    expect(quoteWindowsCmdArg("C:\\Program Files\\")).toBe('"C:\\Program Files\\\\"');
    expect(quoteWindowsCmdArg("100% done")).toBe('"100%% done"');
    expect(quoteWindowsCmdArg('say "hi"')).toBe('"say ""hi"""');
    expect(quoteWindowsCmdArg('C:\\path\\"quoted"')).toBe('"C:\\path\\\\\"\"quoted\"\"\"');
    expect(quoteWindowsCmdArg("line one\r\nline two")).toBe('"line one  line two"');
  });

  it("wraps Windows shim invocations with ComSpec", () => {
    const invocation = resolveCliSpawnInvocation(
      "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd",
      ["exec", "--cd", "C:\\repo path"],
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" } as NodeJS.ProcessEnv,
      "win32",
    );

    expect(invocation).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '""C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd" "exec" "--cd" "C:\\repo path""',
      ],
      windowsVerbatimArguments: true,
    });
  });

  it("keeps metacharacters quoted inside the outer cmd /c payload", () => {
    const invocation = resolveCliSpawnInvocation(
      "C:\\Program Files\\ADE Tools\\ade.cmd",
      ["chat", "send", "--text", "a & b | c"],
      { ComSpec: "cmd.exe" } as NodeJS.ProcessEnv,
      "win32",
    );

    expect(invocation.args).toEqual([
      "/d",
      "/s",
      "/c",
      '""C:\\Program Files\\ADE Tools\\ade.cmd" "chat" "send" "--text" "a & b | c""',
    ]);
  });

  it("builds explicit Windows shell invocations", () => {
    expect(resolveWindowsCmdInvocation("npm", ["run", "test"], {} as NodeJS.ProcessEnv)).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", '""npm" "run" "test""'],
      windowsVerbatimArguments: true,
    });
  });

  it("wraps pre-built Windows cmd lines without re-quoting the payload", () => {
    expect(
      resolveWindowsCmdLineInvocation(
        'set "ADE_OPENCODE_MANAGED=1"&&"C:\\Program Files\\OpenCode\\opencode.cmd" "serve"',
        { ComSpec: "C:\\Windows\\System32\\cmd.exe" } as NodeJS.ProcessEnv,
      ),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '"set "ADE_OPENCODE_MANAGED=1"&&"C:\\Program Files\\OpenCode\\opencode.cmd" "serve""',
      ],
      windowsVerbatimArguments: true,
    });
  });
});

describe("killWindowsProcessTree", () => {
  afterEach(() => {
    spawnSyncMock.mockReset();
  });

  it("shells out to taskkill /T /F and returns true on exit 0", () => {
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: "", stderr: "", error: null });
    const failure = vi.fn();

    expect(killWindowsProcessTree(4321, failure)).toBe(true);
    expect(failure).not.toHaveBeenCalled();
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnSyncMock.mock.calls[0]!;
    expect(command).toBe("taskkill.exe");
    expect(args).toEqual(["/T", "/F", "/PID", "4321"]);
    expect(options).toMatchObject({ windowsHide: true });
  });

  it("invokes the failure callback with taskkill stderr when exit is non-zero", () => {
    spawnSyncMock.mockReturnValueOnce({
      status: 128,
      stdout: Buffer.from("out", "utf8"),
      stderr: Buffer.from("Access denied.", "utf8"),
      error: null,
    });
    const failure = vi.fn();

    expect(killWindowsProcessTree(1234, failure)).toBe(false);
    expect(failure).toHaveBeenCalledTimes(1);
    expect(failure).toHaveBeenCalledWith({
      pid: 1234,
      status: 128,
      stdout: "out",
      stderr: "Access denied.",
      error: null,
    });
  });

  it("invokes the failure callback when spawnSync throws", () => {
    const thrown = new Error("spawn failed");
    spawnSyncMock.mockImplementationOnce(() => {
      throw thrown;
    });
    const failure = vi.fn();

    expect(killWindowsProcessTree(55, failure)).toBe(false);
    expect(failure).toHaveBeenCalledWith({
      pid: 55,
      status: null,
      stdout: "",
      stderr: "",
      error: thrown,
    });
  });

  it("rejects non-positive or non-integer pids without shelling out", () => {
    const failure = vi.fn();

    expect(killWindowsProcessTree(0, failure)).toBe(false);
    expect(killWindowsProcessTree(-7, failure)).toBe(false);
    expect(killWindowsProcessTree(3.14, failure)).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
  });
});

type FakeChildShape = Pick<childProcess.ChildProcess, "kill" | "pid" | "exitCode" | "signalCode">;

function fakeChild(overrides: Partial<FakeChildShape> = {}): FakeChildShape & { kill: ReturnType<typeof vi.fn> } {
  return {
    pid: 4321,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
    ...overrides,
  } as FakeChildShape & { kill: ReturnType<typeof vi.fn> };
}

const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value,
    configurable: true,
  });
}

describe("terminateProcessTree", () => {
  afterEach(() => {
    spawnSyncMock.mockReset();
    setPlatform(originalPlatform);
  });

  it("on non-Windows, forwards the signal to child.kill and returns its result", () => {
    setPlatform("linux");
    const child = fakeChild();

    expect(terminateProcessTree(child, "SIGTERM")).toBe(true);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("on non-Windows, returns false and does not throw when child.kill throws", () => {
    setPlatform("linux");
    const child = fakeChild({
      kill: vi.fn(() => {
        throw new Error("ESRCH");
      }),
    });

    expect(terminateProcessTree(child, "SIGKILL")).toBe(false);
  });

  it("on Windows, calls taskkill for a live child and skips child.kill on success", () => {
    setPlatform("win32");
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: "", stderr: "", error: null });
    const child = fakeChild();

    expect(terminateProcessTree(child)).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(spawnSyncMock.mock.calls[0]![1]).toEqual(["/T", "/F", "/PID", "4321"]);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("on Windows, falls back to child.kill when taskkill fails", () => {
    setPlatform("win32");
    spawnSyncMock.mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: Buffer.from("err", "utf8"),
      error: null,
    });
    const child = fakeChild();
    const failure = vi.fn();

    expect(terminateProcessTree(child, "SIGTERM", failure)).toBe(true);
    expect(failure).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("on Windows, skips taskkill entirely when the child has already exited", () => {
    setPlatform("win32");
    const child = fakeChild({ exitCode: 0 });

    expect(terminateProcessTree(child)).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("on Windows, skips taskkill entirely when the child already received a signal", () => {
    setPlatform("win32");
    const child = fakeChild({ signalCode: "SIGTERM" });

    expect(terminateProcessTree(child)).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("on Windows, falls back to child.kill when pid is missing", () => {
    setPlatform("win32");
    const child = fakeChild({ pid: undefined });

    expect(terminateProcessTree(child, "SIGKILL")).toBe(true);
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
