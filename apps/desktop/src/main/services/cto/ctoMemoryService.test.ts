import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCtoMemoryService } from "./ctoMemoryService";

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cto-memory-"));
  const adeDir = path.join(root, ".ade");
  fs.mkdirSync(adeDir, { recursive: true });
  const ctoDir = path.join(adeDir, "cto");
  const service = createCtoMemoryService({ adeDir, userNotesDir: path.join(root, "home-cto") });
  return { root, adeDir, ctoDir, service };
}

/**
 * Drain the discovery queue the way production does: repeated reads with NO
 * `maxChars` override. A test that only drains under a budget the real caller
 * never passes proves nothing about the real caller.
 */
function drainDiscoveries(
  service: ReturnType<typeof createCtoMemoryService>,
  maxPasses = 1000,
): string[] {
  const seen: string[] = [];
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const batch = service.readNewDiscoveries();
    if (!batch.lines.length) return seen;
    seen.push(...batch.lines);
  }
  throw new Error(`discovery drain did not settle within ${maxPasses} passes`);
}

describe("ctoMemoryService discoveries", () => {
  it("records discoveries append-only and hands each one out exactly once", () => {
    const { service, ctoDir } = createFixture();

    expect(service.readNewDiscoveries().lines).toEqual([]);

    expect(service.recordDiscovery("Vitest localStorage suites need Node 22.", { topic: "testing" }).saved).toBe(true);
    expect(service.recordDiscovery("The relay drops cross-host redirects.").saved).toBe(true);

    const first = service.readNewDiscoveries();
    expect(first.lines).toHaveLength(2);
    expect(first.text).toContain("Vitest localStorage suites need Node 22. [topic:testing]");

    // The cursor advanced: a second read sees nothing until something new lands.
    expect(service.readNewDiscoveries().lines).toEqual([]);
    service.recordDiscovery("Third finding.");
    const second = service.readNewDiscoveries();
    expect(second.lines).toHaveLength(1);
    expect(second.text).toContain("Third finding.");

    // Discoveries never enter durable memory on their own — MEMORY.md was
    // never even created.
    expect(service.readNotes("project")).toBe("");
    expect(fs.existsSync(path.join(ctoDir, "MEMORY.md"))).toBe(false);
  });

  it("never advances the cursor past a discovery the default budget could not hand out", () => {
    const { service } = createFixture();
    // Ten workers filing between two child reports. Each entry is ~300 chars
    // plus an ISO timestamp, so four of them already blow the 1200-char
    // default — the budget the ONLY production caller uses.
    const body = "z".repeat(280);
    for (let i = 0; i < 10; i += 1) service.recordDiscovery(`finding-${i} ${body}`);

    const first = service.readNewDiscoveries();
    // The budget clipped the batch...
    expect(first.lines.length).toBeGreaterThan(0);
    expect(first.lines.length).toBeLessThan(10);
    expect(first.text.length).toBeLessThanOrEqual(1200);
    // ...but oldest-first, and nothing it withheld was destroyed.
    expect(first.lines[0]).toContain("finding-0");
    expect(first.text).not.toContain("(older content truncated)");

    const rest = drainDiscoveries(service);
    const all = [...first.lines, ...rest];
    expect(all).toHaveLength(10);
    expect(new Set(all).size).toBe(10);
    for (let i = 0; i < 10; i += 1) expect(all[i]).toContain(`finding-${i}`);
    expect(service.readNewDiscoveries().lines).toEqual([]);
  });

  it("hands out a single oversized discovery rather than wedging on it", () => {
    const { service, ctoDir } = createFixture();
    // Legacy/hand-edited content can hold a line longer than the whole budget.
    // Standing still on it would stall the queue forever.
    fs.mkdirSync(ctoDir, { recursive: true });
    fs.writeFileSync(
      path.join(ctoDir, "discoveries.md"),
      `- ${"w".repeat(4000)}\n- after the giant\n`,
      "utf8",
    );

    const first = service.readNewDiscoveries();
    expect(first.lines).toHaveLength(1);
    expect(first.text).toContain("(older content truncated)");
    expect(service.readNewDiscoveries().lines).toEqual(["- after the giant"]);
  });

  it("caps discoveries.md, archives what it evicts, and keeps the cursor honest", () => {
    const { service, ctoDir } = createFixture();
    const discoveriesPath = path.join(ctoDir, "discoveries.md");
    const archivePath = path.join(ctoDir, "discoveries-archive.md");

    // A worker stuck in a retry loop: one discovery per turn, forever. Each is
    // clipped to DISCOVERY_FACT_MAX_CHARS, so ~350 of them clear the 128 KB cap.
    const body = "x".repeat(380);
    for (let i = 0; i < 20; i += 1) service.recordDiscovery(`early-${i} ${body}`);
    // Drain them so the cursor sits well inside the region about to be evicted.
    // 380-byte entries against the default budget means several reads, which is
    // exactly the drain the production caller performs.
    expect(drainDiscoveries(service).length).toBe(20);
    for (let i = 0; i < 380; i += 1) service.recordDiscovery(`late-${i} ${body}`);

    const size = fs.statSync(discoveriesPath).size;
    expect(size).toBeLessThanOrEqual(128 * 1024);

    // The oldest entries were demoted, not destroyed.
    const archive = fs.readFileSync(archivePath, "utf8");
    expect(archive).toContain("# Worker discoveries archive (evicted from discoveries.md)");
    expect(archive).toContain("early-0");
    expect(fs.readFileSync(discoveriesPath, "utf8")).not.toContain("early-0");

    // Eviction rewound the cursor by what it removed, so the reader still
    // reaches every surviving discovery — including the newest — and stops.
    const drained = drainDiscoveries(service);
    expect(drained.length).toBeGreaterThan(0);
    expect(new Set(drained).size).toBe(drained.length);
    expect(drained[drained.length - 1]).toContain("late-379");
    expect(service.readNewDiscoveries().lines).toEqual([]);
  });

  it("drains a backlog larger than one read window without skipping anything", () => {
    const { service } = createFixture();
    // DISCOVERY_READ_MAX_BYTES is 64 KB; ~200 x 400-byte entries overflow it.
    const body = "y".repeat(380);
    for (let i = 0; i < 200; i += 1) service.recordDiscovery(`entry-${i} ${body}`);

    // No `maxChars`: the default budget is the only one production ever uses.
    const seen = drainDiscoveries(service);
    // More than one window was needed, and every entry came out exactly once.
    expect(seen.length).toBe(200);
    expect(new Set(seen).size).toBe(200);
    expect(seen[0]).toContain("entry-0");
    expect(seen[seen.length - 1]).toContain("entry-199");
  });

  it("re-reads from the start when the discovery log is replaced under the cursor", () => {
    const { service, ctoDir } = createFixture();
    service.recordDiscovery("A long first finding that makes the file bigger than its replacement.");
    service.readNewDiscoveries();

    // A truncated/replaced file must not leave the cursor pointing past EOF.
    fs.writeFileSync(path.join(ctoDir, "discoveries.md"), "- short\n", "utf8");
    expect(service.readNewDiscoveries().lines).toEqual(["- short"]);
  });
});
