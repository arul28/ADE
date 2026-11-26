import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCtoMemoryArchive } from "./ctoMemoryArchive";
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

describe("ctoMemoryService archive", () => {
  /** A note whose content words are its own, so no two read as near-duplicates. */
  const uniqueNote = (label: string, words = 24) =>
    `${label} ${Array.from({ length: words }, (_, k) => `${label}w${k}`).join(" ")}`;

  /** Fills the project notes up to the cap, one clock second per write. */
  function fillNotes(service: ReturnType<typeof createCtoMemoryService>, start: Date): string[] {
    const notes: string[] = [];
    for (let i = 0; ; i += 1) {
      vi.setSystemTime(new Date(start.getTime() + i * 1000));
      const note = uniqueNote(`n${i}`);
      const bytes = Buffer.byteLength(`${[...notes, note].map((line) => `- ${line}`).join("\n")}\n`, "utf8");
      if (bytes > 4096) return notes;
      expect(service.remember({ note })).toMatchObject({ ok: true, saved: true });
      notes.push(note);
    }
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("moves the least recently used notes out when full, keeps the new one, and recalls one back", () => {
    vi.useFakeTimers();
    const { service } = createFixture();
    const start = new Date("2026-11-01T09:00:00.000Z");
    const notes = fillNotes(service, start);
    expect(notes.length).toBeGreaterThan(5);

    // Saying the oldest note again makes it the warmest.
    vi.setSystemTime(new Date(start.getTime() + 500_000));
    expect(service.remember({ note: notes[0]! })).toMatchObject({ ok: true, saved: false });

    vi.setSystemTime(new Date(start.getTime() + 600_000));
    // The same size as n1, so moving exactly one note out makes room.
    const fresh = uniqueNote("f1");
    const result = service.remember({ note: fresh });
    if (!result.ok || !result.saved) throw new Error(`expected a save, got ${JSON.stringify(result)}`);
    expect(result.archived).toEqual([notes[1]]);
    expect(result.bytes).toBeLessThanOrEqual(4096);

    const pinned = service.readNotes("project");
    expect(pinned).toContain(notes[0]);
    expect(pinned).toContain(fresh);
    expect(pinned).not.toContain(notes[1]);

    const found = service.searchArchive({ query: "n1w3" });
    expect(found.mode).toBe("keyword");
    expect(found.entries).toHaveLength(1);
    expect(found.entries[0]).toMatchObject({ kind: "note", scope: "project", reason: "cold", text: notes[1] });

    // Recall pins it again; the notes are still full, so the next coldest leaves.
    vi.setSystemTime(new Date(start.getTime() + 700_000));
    const recalled = service.recallArchived({ id: found.entries[0]!.id });
    if (!recalled.ok || !recalled.saved) throw new Error(`expected a recall, got ${JSON.stringify(recalled)}`);
    expect(recalled.archived).toEqual([notes[2]]);
    expect(service.readNotes("project")).toContain(notes[1]);
    expect(service.searchArchive({ query: "n1w3" }).entries).toEqual([]);
    expect(service.searchArchive({ kinds: ["note"] }).entries.map((entry) => entry.text)).toEqual([notes[2]]);

    // The person's editor, full: the coldest lines already there move out, and
    // the lines just typed stay wherever they sit, even at the top.
    vi.setSystemTime(new Date(start.getTime() + 800_000));
    const typed = [uniqueNote("t1"), uniqueNote("t2")];
    const current = service.readNotes("project");
    const saved = service.writeNotes("project", `- ${typed[0]}\n${current}- ${typed[1]}\n`);
    expect(saved.archived).toEqual([notes[3], notes[4]]);
    const edited = service.readNotes("project");
    expect(Buffer.byteLength(edited, "utf8")).toBeLessThanOrEqual(4096);
    expect(edited.startsWith(`- ${typed[0]}`)).toBe(true);
    expect(edited).toContain(typed[1]);
    expect(edited).not.toContain(notes[3]);
    expect(service.searchArchive({ query: "n3w5" }).entries[0]).toMatchObject({ kind: "note", reason: "cold" });

    // New lines that alone pass the cap can't be made to fit: refused, nothing moves.
    const tooMuch = Array.from({ length: 40 }, (_, k) => `- ${uniqueNote(`big${k}`)}`).join("\n");
    expect(() => service.writeNotes("project", `${edited}${tooMuch}\n`)).toThrow(/Notes are full/);
    expect(service.readNotes("project")).toBe(edited);
  });

  it("refuses a full write, as before, when there is no archive to move notes into", () => {
    vi.useFakeTimers();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cto-memory-"));
    const service = createCtoMemoryService({ adeDir: path.join(root, ".ade"), userNotesDir: path.join(root, "home-cto"), archive: null });
    const notes = fillNotes(service, new Date("2026-11-01T09:00:00.000Z"));
    const before = service.readNotes("project");

    const result = service.remember({ note: uniqueNote("overflow") });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("Notes are full");
    expect(() => service.writeNotes("project", `${before}- ${uniqueNote("typed")}\n`)).toThrow(/Notes are full/);
    expect(service.readNotes("project")).toBe(before);
    expect(notes.every((note) => before.includes(note))).toBe(true);
    expect(service.searchArchive().available).toBe(false);
  });

  it("changes no note when the archive can't keep the line that leaves", () => {
    vi.useFakeTimers();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cto-memory-"));
    const adeDir = path.join(root, ".ade");
    // The archive opens, but every write fails (a full disk, a lock that never clears).
    const real = createCtoMemoryArchive({ dir: path.join(adeDir, "cto") });
    let failing = true;
    const archive: typeof real = {
      ...real,
      add: (record) => (failing ? null : real.add(record)),
      addMany: (records) => (failing ? null : real.addMany(records)),
    };
    const service = createCtoMemoryService({ adeDir, userNotesDir: path.join(root, "home-cto"), archive });
    fillNotes(service, new Date("2026-11-01T09:00:00.000Z"));
    const before = service.readNotes("project");
    const firstNote = before.split("\n")[0]!.slice(2);

    const forgot = service.forget({ note: firstNote });
    const replaced = service.remember({ note: uniqueNote("swap"), replaces: firstNote });
    const overflow = service.remember({ note: uniqueNote("overflow") });
    for (const result of [forgot, replaced, overflow]) {
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toMatch(/Couldn't save to the archive/);
    }
    expect(() => service.writeNotes("project", `${before}- ${uniqueNote("typed")}\n`)).toThrow(/Couldn't save to the archive/);
    expect(service.readNotes("project")).toBe(before);

    // A story version written while the archive failed is kept by the next
    // write, once the archive works again.
    const story = (summary: string, coveredThrough: string) => ({
      v: 1 as const, summary, coveredThrough, startsAt: "2026-11-01T00:00:00.000Z", updatedAt: coveredThrough, model: "helper",
    });
    failing = false;
    service.writeStory(story("## Where things stand\nThe first version.", "2026-11-02T00:00:00.000Z"));
    failing = true;
    service.writeStory(story("## Where things stand\nThe version the archive missed.", "2026-11-03T00:00:00.000Z"));
    failing = false;
    service.writeStory(story("## Where things stand\nThe third version.", "2026-11-04T00:00:00.000Z"));
    expect(service.searchArchive({ kinds: ["story"] }).entries.map((entry) => entry.text)).toEqual(expect.arrayContaining([
      "## Where things stand\nThe first version.",
      "## Where things stand\nThe version the archive missed.",
      "## Where things stand\nThe third version.",
    ]));
    real.close();
  });

  it("keeps every story version, replaced and forgotten notes, drained discoveries and fold facts, and imports older files once", () => {
    const { root, adeDir, ctoDir, service } = createFixture();
    // Written before the archive existed: imported on first use.
    fs.writeFileSync(
      path.join(ctoDir, "discoveries-archive.md"),
      "# Worker discoveries archive (evicted from discoveries.md)\n\n- 2026-10-01T08:00:00.000Z The staging DB resets on Sundays [topic:infra]\n",
    );

    const story = (summary: string, coveredThrough: string) => ({
      v: 1 as const, summary, coveredThrough, startsAt: "2026-11-01T00:00:00.000Z", updatedAt: coveredThrough, model: "helper",
    });
    service.writeStory(story("## Where things stand\nThe login race fix is in review.", "2026-11-02T00:00:00.000Z"));
    service.writeStory(story("## Where things stand\nThe login race fix merged as PR 482.", "2026-11-03T00:00:00.000Z"));

    service.remember({ note: "Deploys go through the release lane" });
    service.remember({ note: "Deploys go through the main branch now", replaces: "release lane" });
    service.remember({ note: "Staging is on the Mac Studio" });
    service.forget({ note: "Mac Studio" });

    service.recordDiscovery("Vitest localStorage suites need Node 22", { topic: "testing" });
    expect(service.readNewDiscoveries().lines).toHaveLength(1);

    expect(service.recordStoryFacts([
      { kind: "decision", text: "The person chose squash merges for release PRs.", sourceAt: "2026-11-02T10:00:00.000Z", sourceLabel: "Person", sourceSessionId: "cto-1" },
      { kind: "fact", text: "PR #2492 is on branch cto-reactions.", sourceAt: "2026-11-02T10:05:00.000Z", sourceLabel: "Tool result (createPrFromLane)", sourceSessionId: "cto-1" },
    ])).toBe(2);

    const page = service.searchArchive({ limit: 100 });
    const byKind = (kind: string) => page.entries.filter((entry) => entry.kind === kind).map((entry) => entry.text);
    expect(byKind("story")).toEqual([
      "## Where things stand\nThe login race fix merged as PR 482.",
      "## Where things stand\nThe login race fix is in review.",
    ]);
    expect(page.entries.filter((entry) => entry.kind === "note").map((entry) => [entry.text, entry.reason])).toEqual(
      expect.arrayContaining([
        ["Deploys go through the release lane", "replaced"],
        ["Staging is on the Mac Studio", "forgotten"],
      ]),
    );
    expect(byKind("discovery")).toEqual(expect.arrayContaining([
      "Vitest localStorage suites need Node 22 [topic:testing]",
      "The staging DB resets on Sundays [topic:infra]",
    ]));
    expect(page.counts).toMatchObject({ story: 2, note: 2, discovery: 2, fact: 1, decision: 1 });

    const branch = service.searchArchive({ query: "cto-reactions" });
    expect(branch.entries).toHaveLength(1);
    expect(branch.entries[0]).toMatchObject({ kind: "fact", sourceLabel: "Tool result (createPrFromLane)", sourceAt: "2026-11-02T10:05:00.000Z" });
    expect(service.recallArchived({ id: page.entries.find((entry) => entry.kind === "story")!.id }).ok).toBe(false);

    // Another service on the same folder (the next boot) reads the same rows and imports nothing twice.
    service.close();
    const again = createCtoMemoryService({ adeDir, userNotesDir: path.join(root, "home-cto") });
    expect(again.searchArchive({ limit: 100 }).entries).toHaveLength(page.entries.length);
  });
});
