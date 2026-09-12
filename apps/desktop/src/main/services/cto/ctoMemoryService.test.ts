import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCtoMemoryService, formatMemoryTagSuffix, parseMemoryTags } from "./ctoMemoryService";

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cto-memory-"));
  const adeDir = path.join(root, ".ade");
  fs.mkdirSync(adeDir, { recursive: true });
  const ctoDir = path.join(adeDir, "cto");
  const service = createCtoMemoryService({ adeDir });
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

describe("ctoMemoryService", () => {
  it("appends facts under a Facts section and ignores exact duplicates", () => {
    const { service, ctoDir } = createFixture();

    expect(service.appendMemoryFact("Prefer sentence case in UI copy.")).toEqual({
      saved: true,
      fact: "Prefer sentence case in UI copy.",
    });
    expect(service.appendMemoryFact("Ship one push per review cycle.").saved).toBe(true);
    // Exact duplicate (after whitespace normalization) is a no-op.
    expect(service.appendMemoryFact("Prefer sentence case in UI copy.").saved).toBe(false);

    const memory = fs.readFileSync(path.join(ctoDir, "MEMORY.md"), "utf8");
    expect(memory).toContain("## Facts");
    expect(memory).toContain("- Prefer sentence case in UI copy.");
    expect(memory).toContain("- Ship one push per review cycle.");
    // Only one copy of the duplicated fact.
    expect(memory.match(/Prefer sentence case in UI copy\./g)?.length).toBe(1);
  });

  it("caps MEMORY.md by archiving the oldest facts, never destroying them", () => {
    const { service, ctoDir } = createFixture();
    // Each fact is ~1.2KB; 100 of them blows past the 64KB cap.
    const filler = "x".repeat(1200);
    let sawEviction = false;
    for (let i = 0; i < 100; i += 1) {
      const result = service.appendMemoryFact(`fact-${i} ${filler}`);
      if (result.evictedCount) sawEviction = true;
    }
    const memory = fs.readFileSync(path.join(ctoDir, "MEMORY.md"), "utf8");
    expect(Buffer.byteLength(memory, "utf8")).toBeLessThanOrEqual(64 * 1024 + 200);
    // The newest fact survives; the oldest moved out of the injected file...
    expect(memory).toContain("fact-99");
    expect(memory).not.toContain("fact-0 ");
    // ...but is preserved in the append-only archive, reported to the caller,
    // and still reachable through search.
    expect(sawEviction).toBe(true);
    const archive = fs.readFileSync(path.join(ctoDir, "memory-archive.md"), "utf8");
    expect(archive).toContain("fact-0 ");
    const rows = service.searchMemory("fact-0 ", { limit: 5 });
    expect(rows.some((row) => row.file === "memory-archive.md")).toBe(true);
  });

  it("writes thread-state atomically with a reason header", () => {
    const { service, ctoDir } = createFixture();
    service.writeThreadState("Current goal: ship CTO memory.", "provider_reset");
    const threadState = fs.readFileSync(path.join(ctoDir, "thread-state.md"), "utf8");
    expect(threadState).toContain("Current goal: ship CTO memory.");
    expect(threadState).toMatch(/_Updated .+ \(provider_reset\)_/);
    // Empty writes are ignored (never clobber a real summary with "").
    service.writeThreadState("", "compaction");
    expect(fs.readFileSync(path.join(ctoDir, "thread-state.md"), "utf8")).toContain("ship CTO memory");
  });

  it("appends daily entries under a dated header", () => {
    const { service, ctoDir } = createFixture();
    service.appendDailyEntry("09:00 — do a thing → did the thing");
    service.appendDailyEntry("09:05 — do another → done");
    const stamp = new Date().toISOString().slice(0, 10);
    // The local-date file name may differ from the UTC slice near midnight;
    // resolve the single daily file that was written instead.
    const dailyDir = path.join(ctoDir, "daily");
    const files = fs.readdirSync(dailyDir).filter((name) => name.endsWith(".md"));
    expect(files.length).toBe(1);
    const content = fs.readFileSync(path.join(dailyDir, files[0]), "utf8");
    expect(content).toMatch(/^# \d{4}-\d{2}-\d{2}/);
    expect(content).toContain("do a thing");
    expect(content).toContain("do another");
    void stamp;
  });

  it("scrubs secret-shaped content on every write path", () => {
    const { service, ctoDir } = createFixture();
    service.appendMemoryFact("Linear key is sk-abcdefghijklmnop1234 for the relay.");
    service.writeThreadState("Deploy uses ghp_ABCDEFGHIJKLMNOPQRSTUVWX token.", "compaction");
    service.appendTurnJournal({ user: "store api_key=deadbeefdeadbeefdeadbeef", outcome: "done" });

    const memory = fs.readFileSync(path.join(ctoDir, "MEMORY.md"), "utf8");
    const threadState = fs.readFileSync(path.join(ctoDir, "thread-state.md"), "utf8");
    const dailyDir = path.join(ctoDir, "daily");
    const daily = fs.readFileSync(
      path.join(dailyDir, fs.readdirSync(dailyDir).find((name) => name.endsWith(".md"))!),
      "utf8",
    );
    expect(memory).not.toContain("sk-abcdefghijklmnop1234");
    expect(memory).toContain("[REDACTED]");
    expect(threadState).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(daily).not.toContain("deadbeefdeadbeefdeadbeef");
    // Non-secret content survives around the redactions.
    expect(memory).toContain("for the relay");
  });

  it("owns the turn-journal line format with per-part caps", () => {
    const { service, ctoDir } = createFixture();
    const longUser = `ask   about ${"u".repeat(300)}`;
    const longOutcome = `did\nthe\nthing ${"o".repeat(300)}`;
    service.appendTurnJournal({ user: longUser, outcome: longOutcome }, new Date(2026, 6, 4, 9, 5));
    // Blank turns are ignored entirely.
    service.appendTurnJournal({ user: "   ", outcome: "\n" });

    const dailyDir = path.join(ctoDir, "daily");
    const files = fs.readdirSync(dailyDir).filter((name) => name.endsWith(".md"));
    expect(files).toEqual(["2026-07-04.md"]);
    const content = fs.readFileSync(path.join(dailyDir, files[0]), "utf8");
    const line = content.split("\n").find((row) => row.includes("09:05"));
    expect(line).toBeTruthy();
    // `HH:MM — user → outcome`, whitespace collapsed, both parts clipped with ellipses.
    expect(line).toMatch(/^09:05 — ask about u+… → did the thing o+…$/);
    const [userPart, outcomePart] = line!.slice("09:05 — ".length).split(" → ");
    expect(userPart.length).toBeLessThanOrEqual(160);
    expect(outcomePart.length).toBeLessThanOrEqual(200);
    // Only the one real entry was journaled (header + one line).
    expect(content.trim().split("\n").filter((row) => row.includes("—")).length).toBe(1);
  });

  it("searches memory, thread-state, and daily logs case-insensitively", () => {
    const { service } = createFixture();
    service.appendMemoryFact("Release flow tags only after CI passes.");
    service.writeThreadState("Investigating the RELEASE regression.", "compaction");
    service.appendDailyEntry("10:00 — release checklist → started");

    const rows = service.searchMemory("release", { limit: 10 });
    const files = new Set(rows.map((row) => row.file));
    expect(files.has("MEMORY.md")).toBe(true);
    expect(files.has("thread-state.md")).toBe(true);
    expect(files.has("daily")).toBe(true);
    for (const row of rows) {
      expect(row.snippet.toLowerCase()).toContain("release");
      expect(row.line).toBeGreaterThan(0);
    }
    expect(service.searchMemory("release", { limit: 1 }).length).toBe(1);
  });

  it("produces a snapshot with the exact iOS contract shape", () => {
    const { service } = createFixture();
    // No files yet → empty snapshot with null updatedAt.
    const empty = service.getSnapshot();
    expect(empty).toEqual({
      memory: "",
      threadState: "",
      dailyLog: "",
      dailyLogDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      updatedAt: null,
    });

    service.appendMemoryFact("A durable fact.");
    service.writeThreadState("A rolling summary.", "compaction");
    service.appendDailyEntry("11:00 — a turn → an outcome");

    const snapshot = service.getSnapshot();
    expect(snapshot.memory).toContain("A durable fact.");
    expect(snapshot.threadState).toContain("A rolling summary.");
    expect(snapshot.dailyLog).toContain("a turn");
    expect(typeof snapshot.updatedAt).toBe("string");
    expect(Object.keys(snapshot).sort()).toEqual(
      ["dailyLog", "dailyLogDate", "memory", "threadState", "updatedAt"],
    );
  });

  it("truncates injected copies without touching the on-disk files", () => {
    const { service, ctoDir } = createFixture();
    const big = "y".repeat(20000);
    service.writeMemory(`# CTO Durable Memory\n\n## Facts\n\n- ${big}`);
    service.writeThreadState("z".repeat(20000), "compaction");

    const sections = service.buildMemoryContextSections();
    const memorySection = sections.find((s) => s.title.includes("MEMORY.md"));
    const threadSection = sections.find((s) => s.title === "Thread state");
    expect(memorySection).toBeDefined();
    expect(threadSection).toBeDefined();
    // Injected copies are capped (4000 / 3000 chars respectively) even though
    // the on-disk copies are much larger. The caps came down from 8000/4000
    // when the live state block joined the same reconstruction context.
    expect(memorySection!.body.length).toBeLessThan(4500);
    expect(threadSection!.body.length).toBeLessThan(3500);
    expect(fs.readFileSync(path.join(ctoDir, "MEMORY.md"), "utf8").length).toBeGreaterThan(19000);
    expect(fs.readFileSync(path.join(ctoDir, "thread-state.md"), "utf8").length).toBeGreaterThan(19000);
  });

  /* ── Tagged facts ── */

  it("appends a tag suffix and keeps untagged facts valid", () => {
    const { service, ctoDir } = createFixture();

    const tagged = service.appendMemoryFact("Windows runner is the build long pole.", {
      lane: "lane-7",
      pr: 1229,
      path: "apps/desktop",
      topic: "ci speed",
    });
    expect(tagged.saved).toBe(true);
    expect(tagged.fact).toBe(
      "Windows runner is the build long pole. [lane:lane-7 pr:1229 path:apps/desktop topic:ci-speed]",
    );

    // A fact saved without tags is stored exactly as before — no empty suffix.
    const untagged = service.appendMemoryFact("Prefer sentence case in UI copy.");
    expect(untagged.fact).toBe("Prefer sentence case in UI copy.");

    const memory = fs.readFileSync(path.join(ctoDir, "MEMORY.md"), "utf8");
    expect(memory).toContain("- Prefer sentence case in UI copy.\n");
    expect(memory).not.toContain("Prefer sentence case in UI copy. [");
  });

  it("parses a tag suffix back out and ignores unknown keys", () => {
    expect(parseMemoryTags("- something [lane:lane-7 pr:1229]")).toEqual({ lane: "lane-7", pr: "1229" });
    expect(parseMemoryTags("- something [topic:sync]")).toEqual({ topic: "sync" });
    // Not a tag block: no recognized key, so the line is simply untagged.
    expect(parseMemoryTags("- fix the [TODO] marker")).toEqual({});
    expect(parseMemoryTags("- plain fact with no tags")).toEqual({});
  });

  it("drops empty tag values rather than writing a blank suffix", () => {
    expect(formatMemoryTagSuffix({ lane: "", topic: null })).toBe("");
    expect(formatMemoryTagSuffix({})).toBe("");
    expect(formatMemoryTagSuffix(null)).toBe("");
  });

  it("returns tag matches before substring matches, and still finds untagged facts", () => {
    const { service } = createFixture();
    // A fact that only MENTIONS the word, written first so file order alone
    // would put it ahead of the tagged one.
    service.appendMemoryFact("The sync rewrite is scheduled for next quarter.");
    service.appendMemoryFact("Never filter a column from an inbound changeset.", { topic: "sync" });

    const rows = service.searchMemory("sync");
    expect(rows).toHaveLength(2);
    // Tag hit first.
    expect(rows[0].snippet).toContain("Never filter a column");
    // The untagged fact still matches by substring, exactly as before.
    expect(rows[1].snippet).toContain("The sync rewrite is scheduled");
  });

  it("hard-filters by tag when tags are supplied, including with an empty query", () => {
    const { service } = createFixture();
    service.appendMemoryFact("Lane seven owns the installer.", { lane: "lane-7" });
    service.appendMemoryFact("Lane eight owns the relay.", { lane: "lane-8" });
    service.appendMemoryFact("An untagged standing preference.");

    const rows = service.searchMemory("", { tags: { lane: "lane-7" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].snippet).toContain("Lane seven owns the installer.");

    // An untagged fact cannot satisfy a lane-scoped query — it never claimed
    // to be about that lane.
    expect(service.searchMemory("untagged", { tags: { lane: "lane-7" } })).toHaveLength(0);
    // ...but it is still reachable by a plain substring search.
    expect(service.searchMemory("untagged")).toHaveLength(1);
  });

  /* ── Worker lane context ── */

  it("builds a lane-scoped context section from lane-tagged facts and thread state", () => {
    const { service } = createFixture();
    service.appendMemoryFact("Installer signing needs a GUI Always-Allow.", { lane: "lane-7" });
    service.appendMemoryFact("Relay worker lacks the register route.", { lane: "lane-8" });
    service.appendMemoryFact("An untagged standing preference.");
    service.writeThreadState("Currently landing the installer work.", "test");

    const section = service.buildLaneMemoryContextSection("lane-7");
    expect(section).not.toBeNull();
    expect(section!.body).toContain("Installer signing needs a GUI Always-Allow.");
    expect(section!.body).toContain("Currently landing the installer work.");
    // Another lane's facts, and untagged facts, are not this worker's context.
    expect(section!.body).not.toContain("Relay worker lacks the register route.");
    expect(section!.body).not.toContain("An untagged standing preference.");
  });

  it("returns no lane section when there is nothing lane-scoped to say", () => {
    const { service } = createFixture();
    service.appendMemoryFact("An untagged standing preference.");
    expect(service.buildLaneMemoryContextSection("lane-7")).toBeNull();
  });

  /* ── Discoveries ── */

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
    expect(service.readMemory()).toBe("");
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
