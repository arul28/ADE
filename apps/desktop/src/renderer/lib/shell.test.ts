import { describe, expect, it } from "vitest";
import { commandArrayToLine, parseCommandLine, quoteShellArg } from "./shell";

describe("shell helpers", () => {
  it("quotes args with spaces when formatting a command line", () => {
    expect(quoteShellArg("web app")).toBe('"web app"');
    expect(commandArrayToLine(["pnpm", "--filter", "web app", "dev"])).toBe('pnpm --filter "web app" dev');
  });

  it("parses quoted args back into argv", () => {
    expect(parseCommandLine('pnpm --filter "web app" dev')).toEqual(["pnpm", "--filter", "web app", "dev"]);
  });

  it("round-trips escaped quotes inside a quoted argument", () => {
    const argv = parseCommandLine('node -e "console.log(\\"hello world\\")"');
    expect(argv).toEqual(["node", "-e", 'console.log("hello world")']);
    expect(parseCommandLine(commandArrayToLine(argv))).toEqual(argv);
  });

  it("preserves Windows executable paths with backslashes", () => {
    expect(parseCommandLine("C:\\Tools\\node.exe --version", { platform: "win32" })).toEqual([
      "C:\\Tools\\node.exe",
      "--version",
    ]);
  });

  it("parses quoted Windows paths with spaces", () => {
    expect(parseCommandLine('"C:\\Program Files\\nodejs\\node.exe" "C:\\repo path\\script.js"', { platform: "win32" })).toEqual([
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\repo path\\script.js",
    ]);
  });

  it("round-trips Windows cmd and PowerShell commands", () => {
    const cmd = ["cmd.exe", "/c", "npm run test"];
    const powershell = ["powershell.exe", "-NoProfile", "-Command", 'Write-Output "ok"'];

    expect(parseCommandLine(commandArrayToLine(cmd, { platform: "win32" }), { platform: "win32" })).toEqual(cmd);
    expect(parseCommandLine(commandArrayToLine(powershell, { platform: "win32" }), { platform: "win32" })).toEqual(powershell);
  });

  it("round-trips Windows arguments that end with a backslash", () => {
    const argv = ["node.exe", "C:\\repo path\\nested\\"];
    const line = commandArrayToLine(argv, { platform: "win32" });

    expect(line).toBe('node.exe "C:\\repo path\\nested\\\\"');
    expect(parseCommandLine(line, { platform: "win32" })).toEqual(argv);
  });

  it("round-trips Windows arguments with backslashes before quotes", () => {
    const argv = ["node.exe", 'C:\\repo path\\"quoted"'];
    const line = commandArrayToLine(argv, { platform: "win32" });

    expect(line).toBe('node.exe "C:\\repo path\\\\\"\"quoted\"\""');
    expect(parseCommandLine(line, { platform: "win32" })).toEqual(argv);
  });

  it("parses Windows doubled quotes without treating backslashes as escapes", () => {
    expect(parseCommandLine('"ab""c" "C:\\repo path\\\\" d', { platform: "win32" })).toEqual([
      'ab"c',
      "C:\\repo path\\",
      "d",
    ]);
  });

  it("uses ANSI-C $'...' quoting for posix args with embedded newlines", () => {
    // Plain double-quotes would preserve the \n literally, but when the
    // resulting startupCommand is written into an interactive PTY shell the
    // terminal's line discipline fires on every \n, dropping PS2 continuation
    // prompts into the command stream. $'...' keeps the line single-line on
    // the wire and lets the shell decode the escapes.
    expect(quoteShellArg("hello\nworld", { platform: "linux" })).toBe("$'hello\\nworld'");
    expect(quoteShellArg("ADE guidance.\n\nUse `ade`.", { platform: "linux" })).toBe(
      "$'ADE guidance.\\n\\nUse `ade`.'",
    );
    // Single quotes inside the arg must be backslash-escaped for ANSI-C form.
    expect(quoteShellArg("it's\nfine", { platform: "linux" })).toBe("$'it\\'s\\nfine'");
  });
});
