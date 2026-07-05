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
  const service = createCtoMemoryService({ adeDir });
  return { root, adeDir, ctoDir, service };
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

  it("caps MEMORY.md by dropping the oldest facts", () => {
    const { service, ctoDir } = createFixture();
    // Each fact is ~1.2KB; 100 of them blows past the 64KB cap.
    const filler = "x".repeat(1200);
    for (let i = 0; i < 100; i += 1) {
      service.appendMemoryFact(`fact-${i} ${filler}`);
    }
    const memory = fs.readFileSync(path.join(ctoDir, "MEMORY.md"), "utf8");
    expect(Buffer.byteLength(memory, "utf8")).toBeLessThanOrEqual(64 * 1024 + 200);
    // The newest fact survives; the oldest is dropped.
    expect(memory).toContain("fact-99");
    expect(memory).not.toContain("fact-0 ");
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
    // Injected copies are capped (8000 / 4000 chars respectively) even though
    // the on-disk copies are much larger.
    expect(memorySection!.body.length).toBeLessThan(8500);
    expect(threadSection!.body.length).toBeLessThan(4500);
    expect(fs.readFileSync(path.join(ctoDir, "MEMORY.md"), "utf8").length).toBeGreaterThan(19000);
    expect(fs.readFileSync(path.join(ctoDir, "thread-state.md"), "utf8").length).toBeGreaterThan(19000);
  });
});
