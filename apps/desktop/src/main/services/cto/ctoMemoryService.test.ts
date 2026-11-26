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

describe("ctoMemoryService learning: rules, skills, Learned rows and Undo", () => {
  const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");

  it("reports one turn's rule, note and skill changes, and Undo puts each back and refuses it again", () => {
    const { service, ctoDir } = createFixture();
    service.remember({ note: "Deploys go through the release lane" });
    service.beginLearningTurn();

    expect(service.addRule({ rule: "Ask before landing a PR", why: "merges to main deploy at once" }).ok).toBe(true);
    expect(service.remember({ note: "Deploys go through the release lane on Thursdays", replaces: "release lane" }).ok).toBe(true);
    expect(service.saveSkill({ name: "Release Desktop", description: "Ship a desktop release", body: "1. Bump\n2. Tag" }).ok).toBe(true);

    const learned = service.finishLearningTurn({ sessionId: "cto-1", turnId: "t-1" });
    expect(learned?.changes.map(({ area, op, text, previous }) => ({ area, op, text, previous }))).toEqual([
      { area: "rules", op: "added", text: "Ask before landing a PR — merges to main deploy at once.", previous: undefined },
      { area: "skill", op: "added", text: "release-desktop", previous: undefined },
      {
        area: "project_notes",
        op: "changed",
        text: "Deploys go through the release lane on Thursdays",
        previous: "Deploys go through the release lane",
      },
    ]);
    // A turn that changed nothing draws no row.
    service.beginLearningTurn();
    expect(service.finishLearningTurn({})).toBeNull();

    const byArea = (area: string) => learned!.changes.find((change) => change.area === area)!;
    for (const area of ["rules", "skill", "project_notes"]) {
      const outcome = service.undoLearned({ learnId: learned!.learnId, changeId: byArea(area).id });
      expect(outcome.ok && outcome.payload.changes.find((change) => change.id === byArea(area).id)?.undone).toBe(true);
    }
    expect(read(path.join(ctoDir, "RULES.md")).trim()).toBe("");
    expect(fs.existsSync(path.join(ctoDir, "skills", "release-desktop"))).toBe(false);
    expect(read(path.join(ctoDir, "MEMORY.md"))).toBe("- Deploys go through the release lane\n");

    // The CTO is refused each undone change, worded close or exactly.
    expect(service.addRule({ rule: "Always ask before landing a PR", why: "main deploys" })).toMatchObject({ ok: false });
    expect(service.saveSkill({ name: "release-desktop", description: "x", body: "y" })).toMatchObject({ ok: false });
    expect(service.remember({ note: "Deploys go through the release lane on Thursdays", replaces: "release lane" }))
      .toMatchObject({ ok: false });
    // Unless the person asks for it again.
    expect(service.addRule({ rule: "Ask before landing a PR", why: "merges deploy", personAskedAgain: true }).ok).toBe(true);
    // The undone list is in the CTO's context, so it knows before it tries.
    const context = service.buildMemoryContextSections().map((section) => `${section.title}\n${section.body}`).join("\n");
    expect(context).toContain("Undone by the person");
    expect(context).toContain("Skill added: release-desktop");
  });

  it("restores a removed rule and an edited skill from the turn's baseline", () => {
    const { service, ctoDir } = createFixture();
    service.writeNotes("rules", "# Mine\n- Keep PRs small — reviews stay fast.\n");
    service.saveSkill({ name: "triage", description: "Triage a bug", body: "1. Reproduce" });
    const skillBefore = read(path.join(ctoDir, "skills", "triage", "SKILL.md"));

    service.beginLearningTurn();
    expect(service.removeRule({ rule: "Keep PRs small" }).ok).toBe(true);
    service.saveSkill({ name: "triage", description: "Triage a bug", body: "1. Guess" });
    const learned = service.finishLearningTurn({})!;
    expect(learned.changes.map(({ area, op }) => `${area}:${op}`)).toEqual(["rules:removed", "skill:changed"]);

    for (const change of learned.changes) service.undoLearned({ learnId: learned.learnId, changeId: change.id });
    expect(read(path.join(ctoDir, "RULES.md"))).toContain("- Keep PRs small — reviews stay fast.");
    expect(read(path.join(ctoDir, "RULES.md"))).toContain("# Mine");
    expect(read(path.join(ctoDir, "skills", "triage", "SKILL.md"))).toBe(skillBefore);
    // The CTO may not remove the rule the person kept.
    expect(service.removeRule({ rule: "Keep PRs small" })).toMatchObject({ ok: false });
    // A second Undo of the same change is a no-op, not a second restore.
    expect(service.undoLearned({ learnId: learned.learnId, changeId: learned.changes[0]!.id }).ok).toBe(true);
    expect(read(path.join(ctoDir, "RULES.md")).match(/Keep PRs small/g)).toHaveLength(1);

    // A skill the person edited after the turn keeps their edit: Undo refuses instead of deleting it.
    service.beginLearningTurn();
    service.saveSkill({ name: "hotfix", description: "Ship a hotfix", body: "1. Branch from main" });
    const added = service.finishLearningTurn({})!;
    service.writeSkillText({ name: "hotfix", text: "1. Branch from main\n2. Announce it" });
    expect(service.undoLearned({ learnId: added.learnId, changeId: added.changes[0]!.id })).toMatchObject({ ok: false });
    expect(read(path.join(ctoDir, "skills", "hotfix", "SKILL.md"))).toContain("2. Announce it");

    // A note line the CTO changed and the person then edited again: Undo refuses and keeps their wording.
    service.remember({ note: "Staging lives at staging.acme.dev" });
    service.beginLearningTurn();
    service.remember({ note: "Staging lives at stage.acme.dev", replaces: "Staging lives" });
    const renamed = service.finishLearningTurn({})!;
    service.writeNotes("project", "- Staging lives at stage2.acme.dev\n");
    expect(service.undoLearned({ learnId: renamed.learnId, changeId: renamed.changes[0]!.id })).toMatchObject({ ok: false });
    expect(read(path.join(ctoDir, "MEMORY.md"))).toBe("- Staging lives at stage2.acme.dev\n");
  });

  it("never reports the person's own edits during a turn as learned, and forgives what they write back", () => {
    const { service } = createFixture();
    service.beginLearningTurn();
    service.writeNotes("rules", "- Use pnpm — the lockfile is pnpm's.\n");
    service.writeNotes("project", "- The API lives in apps/api\n");
    service.writeSkillText({ name: "deploy", text: "1. Push to main" });
    expect(service.finishLearningTurn({})).toBeNull();

    service.beginLearningTurn();
    service.addRule({ rule: "Run the linter before review", why: "CI fails on lint" });
    const learned = service.finishLearningTurn({})!;
    service.undoLearned({ learnId: learned.learnId, changeId: learned.changes[0]!.id });
    expect(service.addRule({ rule: "Run the linter before review", why: "CI fails on lint" })).toMatchObject({ ok: false });
    // The person writes it back themselves: the CTO may manage it again.
    service.writeNotes("rules", "- Use pnpm — the lockfile is pnpm's.\n- Run the linter before review — CI fails on lint.\n");
    expect(service.removeRule({ rule: "Run the linter" }).ok).toBe(true);

    // Notes about the person are shared across projects: a line another project's CTO
    // writes during this turn is not this turn's to show or undo; the line this CTO writes is.
    const { root, adeDir } = createFixture();
    const here = createCtoMemoryService({ adeDir, userNotesDir: path.join(root, "home-cto") });
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cto-memory-other-"));
    fs.mkdirSync(path.join(otherRoot, ".ade"), { recursive: true });
    const elsewhere = createCtoMemoryService({ adeDir: path.join(otherRoot, ".ade"), userNotesDir: path.join(root, "home-cto") });
    here.beginLearningTurn();
    expect(elsewhere.remember({ note: "Prefers short PR descriptions", scope: "user" }).ok).toBe(true);
    expect(here.finishLearningTurn({})).toBeNull();
    here.beginLearningTurn();
    elsewhere.remember({ note: "Works in UTC", scope: "user" });
    expect(here.remember({ note: "Reviews on Wednesdays", scope: "user" }).ok).toBe(true);
    expect(here.finishLearningTurn({})?.changes.map(({ area, text }) => `${area}:${text}`)).toEqual([
      "user_notes:Reviews on Wednesdays",
    ]);
  });

  it("still reports a turn a brain restart cut short", () => {
    const { service, adeDir, root } = createFixture();
    service.beginLearningTurn();
    service.addRule({ rule: "Ship on Thursdays", why: "the team reviews on Wednesday" });
    // A new brain opens the same project before the turn ended.
    const restarted = createCtoMemoryService({ adeDir, userNotesDir: path.join(root, "home-cto") });
    restarted.beginLearningTurn();
    const learned = restarted.finishLearningTurn({});
    expect(learned?.changes.map(({ area, op }) => `${area}:${op}`)).toEqual(["rules:added"]);
    // The baseline is gone once used: the next turn starts fresh.
    restarted.beginLearningTurn();
    expect(restarted.finishLearningTurn({})).toBeNull();
  });

  it("refuses a near-copy of a rule and sharpens it in place with replaces", () => {
    const { service, ctoDir } = createFixture();
    service.addRule({ rule: "Run iOS tests on the iPhone 17 simulator", why: "older ones lack iOS 26" });
    expect(service.addRule({ rule: "Run the iOS tests on an iPhone 17 simulator", why: "runtime" })).toMatchObject({
      ok: false,
      candidates: ["Run iOS tests on the iPhone 17 simulator — older ones lack iOS 26."],
    });
    expect(service.addRule({ rule: "Never skip tests", why: "" })).toMatchObject({ ok: false });
    expect(service.addRule({
      rule: "Run iOS tests on the iPhone 17 Pro simulator",
      why: "older ones lack iOS 26",
      replaces: "iPhone 17 simulator",
    })).toMatchObject({ ok: true, replaced: "Run iOS tests on the iPhone 17 simulator — older ones lack iOS 26." });
    expect(read(path.join(ctoDir, "RULES.md"))).toBe("- Run iOS tests on the iPhone 17 Pro simulator — older ones lack iOS 26.\n");
    // A rule that already carries its "— why" says the reason once.
    expect(service.addRule({ rule: "Run the linter first — CI fails on lint", why: "CI fails on lint" }))
      .toMatchObject({ ok: true, rule: "Run the linter first — CI fails on lint." });
  });
});
