import { describe, expect, it } from "vitest";
import { KNOWN_TERMINAL_IDS_LIMIT, rememberKnownTerminalId } from "./knownTerminalIds";

describe("rememberKnownTerminalId", () => {
  it("keeps every id while the set is within the limit", () => {
    const known = new Set<string>();
    for (let i = 0; i < KNOWN_TERMINAL_IDS_LIMIT; i += 1) rememberKnownTerminalId(known, `terminal-${i}`);

    expect(known.size).toBe(KNOWN_TERMINAL_IDS_LIMIT);
    expect(known.has("terminal-0")).toBe(true);
  });

  it("stays bounded and evicts the oldest ids first", () => {
    const known = new Set<string>();
    const total = KNOWN_TERMINAL_IDS_LIMIT + 50;
    for (let i = 0; i < total; i += 1) rememberKnownTerminalId(known, `terminal-${i}`);

    expect(known.size).toBe(KNOWN_TERMINAL_IDS_LIMIT);
    expect(known.has("terminal-49")).toBe(false);
    expect(known.has("terminal-50")).toBe(true);
    expect(known.has(`terminal-${total - 1}`)).toBe(true);
  });

  it("counts a re-remembered id as recent, so it outlives older ids", () => {
    const known = new Set<string>();
    rememberKnownTerminalId(known, "terminal-old");
    for (let i = 0; i < KNOWN_TERMINAL_IDS_LIMIT - 1; i += 1) rememberKnownTerminalId(known, `terminal-${i}`);
    rememberKnownTerminalId(known, "terminal-old");
    rememberKnownTerminalId(known, "terminal-newest");

    expect(known.size).toBe(KNOWN_TERMINAL_IDS_LIMIT);
    expect(known.has("terminal-old")).toBe(true);
    expect(known.has("terminal-0")).toBe(false);
  });
});
