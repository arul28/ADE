import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => {
  const execFileImpl = vi.fn();
  const spawnImpl = vi.fn();
  return {
    execFile: execFileImpl,
    spawn: spawnImpl,
    __execFileMock: execFileImpl,
    __spawnMock: spawnImpl,
  };
});

import * as cp from "node:child_process";
import {
  buildResumeArgv,
  detectCodexResumeStrategy,
  shellQuote,
  spawnInNewTerminalWindow,
} from "./codexCliLauncher";

type MockedCp = typeof cp & {
  __execFileMock: ReturnType<typeof vi.fn>;
  __spawnMock: ReturnType<typeof vi.fn>;
};

const mocked = cp as MockedCp;

function stubExecFile(stdout: string, stderr = ""): void {
  mocked.__execFileMock.mockImplementation(((...allArgs: unknown[]) => {
    const cb = allArgs[allArgs.length - 1];
    if (typeof cb === "function") {
      setImmediate(() => (cb as (err: Error | null, stdout: string, stderr: string) => void)(null, stdout, stderr));
    }
    return {} as never;
  }) as never);
}

function stubExecFileError(): void {
  mocked.__execFileMock.mockImplementation(((...allArgs: unknown[]) => {
    const cb = allArgs[allArgs.length - 1];
    if (typeof cb === "function") {
      setImmediate(() => (cb as (err: Error) => void)(new Error("ENOENT")));
    }
    return {} as never;
  }) as never);
}

describe("codexCliLauncher", () => {
  describe("detectCodexResumeStrategy", () => {
    it("picks the resume subcommand when --help advertises it", async () => {
      stubExecFile("Usage: codex [OPTIONS] [COMMAND]\nCommands:\n  resume   Resume a thread\n  ...");
      const strategy = await detectCodexResumeStrategy("/usr/local/bin/codex");
      expect(strategy.flagForm.kind).toBe("subcommand");
      expect(strategy.copyThreadIdToClipboard).toBe(false);
      expect(buildResumeArgv(strategy, "abc-123")).toEqual(["resume", "abc-123"]);
    });

    it("falls back to --thread when only the flag is in help", async () => {
      stubExecFile("Usage: codex [OPTIONS]\n  --thread <id>   Resume a specific thread\n");
      const strategy = await detectCodexResumeStrategy("/usr/local/bin/codex");
      expect(strategy.flagForm.kind).toBe("long-flag");
      expect(strategy.copyThreadIdToClipboard).toBe(false);
      expect(buildResumeArgv(strategy, "abc-123")).toEqual(["--thread", "abc-123"]);
    });

    it("falls back to interactive launch + clipboard when neither form exists", async () => {
      stubExecFile("Usage: codex [OPTIONS]\nNo resume support");
      const strategy = await detectCodexResumeStrategy("/usr/local/bin/codex");
      expect(strategy.flagForm.kind).toBe("interactive");
      expect(strategy.copyThreadIdToClipboard).toBe(true);
      expect(buildResumeArgv(strategy, "abc-123")).toEqual([]);
    });

    it("falls back to interactive when the --help probe itself fails", async () => {
      stubExecFileError();
      const strategy = await detectCodexResumeStrategy("/usr/local/bin/codex");
      expect(strategy.flagForm.kind).toBe("interactive");
      expect(strategy.copyThreadIdToClipboard).toBe(true);
    });
  });

  describe("shellQuote", () => {
    it("wraps in double quotes and escapes embedded quotes", () => {
      expect(shellQuote("simple")).toBe("\"simple\"");
      expect(shellQuote("with space")).toBe("\"with space\"");
      expect(shellQuote("it's \"tricky\"")).toBe("\"it's \\\"tricky\\\"\"");
    });
  });

  describe("spawnInNewTerminalWindow", () => {
    it("uses osascript on darwin", () => {
      const spawnMock = mocked.__spawnMock;
      spawnMock.mockReset();
      const fakeChild = { unref: vi.fn() };
      spawnMock.mockReturnValue(fakeChild as never);

      spawnInNewTerminalWindow({
        binary: "/usr/local/bin/codex",
        argv: ["resume", "abc-123"],
        cwd: "/tmp/lane",
        platform: "darwin",
      });

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [bin, args, opts] = spawnMock.mock.calls[0]!;
      expect(bin).toBe("osascript");
      expect(args[0]).toBe("-e");
      expect(args[1]).toContain("Terminal");
      expect(args[1]).toContain("/tmp/lane");
      expect(args[1]).toContain("resume");
      expect(args[1]).toContain("abc-123");
      expect((opts as { detached: boolean }).detached).toBe(true);
      expect(fakeChild.unref).toHaveBeenCalled();
    });

    it("uses cmd /C start cmd /K on win32", () => {
      const spawnMock = mocked.__spawnMock;
      spawnMock.mockReset();
      const fakeChild = { unref: vi.fn() };
      spawnMock.mockReturnValue(fakeChild as never);

      spawnInNewTerminalWindow({
        binary: "C:\\codex.exe",
        argv: ["resume", "abc-123"],
        cwd: "C:\\lane",
        platform: "win32",
      });

      const [bin, args] = spawnMock.mock.calls[0]!;
      expect(bin).toBe("cmd.exe");
      expect(args[0]).toBe("/C");
      expect(args[1]).toBe("start");
      expect(args[2]).toBe("cmd");
      expect(args[3]).toBe("/K");
      expect(args[4]).toContain("resume");
      expect(args[4]).toContain("abc-123");
    });

    it("falls through to gnome-terminal on linux", () => {
      const spawnMock = mocked.__spawnMock;
      spawnMock.mockReset();
      const fakeChild = { unref: vi.fn() };
      spawnMock.mockReturnValue(fakeChild as never);

      spawnInNewTerminalWindow({
        binary: "/usr/local/bin/codex",
        argv: ["resume", "abc-123"],
        cwd: "/tmp/lane",
        platform: "linux",
      });

      const [bin] = spawnMock.mock.calls[0]!;
      expect(bin).toBe("gnome-terminal");
    });
  });
});
