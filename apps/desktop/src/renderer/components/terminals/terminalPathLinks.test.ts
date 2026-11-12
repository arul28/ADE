import { describe, expect, it } from "vitest";
import { scanTerminalPathTokens } from "./terminalPathLinks";

describe("scanTerminalPathTokens", () => {
  it.each([
    String.raw`\\evil-host\share\secret.ts:3:10`,
    String.raw`see \\evil.example.com\c$\a.ts now`,
    "//evil-host/share/a.ts:3",
    String.raw`/\evil-host/share/a.ts`,
    String.raw`\/evil-host\share\a.ts`,
    "file://evil-host/share/a.ts",
    String.raw`file:\\evil-host\share\a.ts`,
  ])("never offers a network path from %s", (line) => {
    const tokens = scanTerminalPathTokens(line);
    expect(tokens.filter((token) => /^[\\/]{2}/.test(token.location.path))).toEqual([]);
    expect(tokens.filter((token) => token.location.path.includes("evil"))).toEqual([]);
  });
});
