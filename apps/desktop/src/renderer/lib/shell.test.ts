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
});
