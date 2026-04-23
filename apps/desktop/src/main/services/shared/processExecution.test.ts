import { describe, expect, it } from "vitest";
import {
  quoteWindowsCmdArg,
  resolveCliSpawnInvocation,
  resolveWindowsCmdInvocation,
  shouldUseWindowsCmdWrapper,
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
    expect(quoteWindowsCmdArg("100% done")).toBe('"100%% done"');
    expect(quoteWindowsCmdArg('say "hi"')).toBe('"say ""hi"""');
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
        '"C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd" "exec" "--cd" "C:\\repo path"',
      ],
      windowsVerbatimArguments: true,
    });
  });

  it("builds explicit Windows shell invocations", () => {
    expect(resolveWindowsCmdInvocation("npm", ["run", "test"], {} as NodeJS.ProcessEnv)).toEqual({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", '"npm" "run" "test"'],
      windowsVerbatimArguments: true,
    });
  });
});
