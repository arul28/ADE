import { describe, expect, it } from "vitest";
import { rememberKnownTerminalId } from "./knownTerminalIds";

describe("rememberKnownTerminalId", () => {
  it("never forgets an id on its own, however many newer ids arrive", () => {
    const known = new Set<string>();
    rememberKnownTerminalId(known, "terminal-live");
    for (let i = 0; i < 20_000; i += 1) rememberKnownTerminalId(known, `terminal-${i}`);

    expect(known.has("terminal-live")).toBe(true);
    expect(known.size).toBe(20_001);
  });

  it("keeps one entry for an id remembered twice", () => {
    const known = new Set<string>();
    rememberKnownTerminalId(known, "terminal-a");
    rememberKnownTerminalId(known, "terminal-a");

    expect(known.size).toBe(1);
  });
});
