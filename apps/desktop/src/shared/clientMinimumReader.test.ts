import { describe, expect, it } from "vitest";
import { createClientMinimumReader } from "./clientMinimumReader";
import { CLIENT_MINIMUM_FRESH_MS, desktopUpdateRequirement } from "./clientUpdateGate";

// The gate must fail open: a computer that cannot reach the account server,
// or whose last answer is old, is never blocked by it.
const ANSWER = { desktop: { stable: "1.2.131", beta: null }, ios: {}, links: {}, updatedAt: "2026-11-18T00:00:00Z" };
const LATEST = { stable: "1.2.131", beta: null };

function harness(bodies: Array<unknown | Error>) {
  let now = 1_000_000;
  const reader = createClientMinimumReader({
    nowMs: () => now,
    fetchBody: async () => {
      const next = bodies.shift();
      if (next instanceof Error || next === undefined) throw next ?? new Error("offline");
      return next;
    },
  });
  const blocks = () => desktopUpdateRequirement({ currentVersion: "1.2.130", minimum: reader.current(), latest: LATEST }).required;
  return { reader, blocks, advance: (ms: number) => { now += ms; } };
}

describe("createClientMinimumReader", () => {
  it("keeps a fresh answer through failed or unreadable reads, and opens once it is stale", async () => {
    const { reader, blocks, advance } = harness([ANSWER, "<html>", new Error("offline")]);
    await reader.refresh();
    expect(blocks()).toBe(true);
    advance(CLIENT_MINIMUM_FRESH_MS - 1);
    await reader.refresh();
    expect(blocks()).toBe(true);
    advance(2);
    await reader.refresh();
    expect(blocks()).toBe(false);
    // Stale without a read at all: the answer alone decides nothing.
    expect(reader.current()).toBeNull();
  });

  it("a later answer replaces the earlier one", async () => {
    const { reader, blocks } = harness([ANSWER, { ...ANSWER, desktop: { stable: null, beta: null } }]);
    await reader.refresh();
    expect(blocks()).toBe(true);
    await reader.refresh();
    expect(blocks()).toBe(false);
  });
});
