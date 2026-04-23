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
    const powershell = ["powershell.exe", "-NoProfile", "-Command", "Write-Output \"ok\""];

    expect(parseCommandLine(commandArrayToLine(cmd, { platform: "win32" }), { platform: "win32" })).toEqual(cmd);
    expect(parseCommandLine(commandArrayToLine(powershell, { platform: "win32" }), { platform: "win32" })).toEqual(powershell);
  });
});
