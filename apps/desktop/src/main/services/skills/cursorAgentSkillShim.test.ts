import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cursorSdkSettingSources } from "../chat/cursorSdkPolicy";
import {
  cursorAgentSkillShimRoot,
  cursorAgentSkillShimSkillsDir,
  cursorLoadsProjectSkills,
  prepareCursorAgentSkillShim,
  resolveCursorAgentSkillDirs,
} from "./cursorAgentSkillShim";

function writeSkill(root: string, name: string, body: string): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), body);
}

/** The setting sources a normal chat and a strict-MCP orchestration lead get. */
const NORMAL_SOURCES = cursorSdkSettingSources({ strictMcpConfig: false });
const LEAD_SOURCES = cursorSdkSettingSources({ strictMcpConfig: true });

describe("prepareCursorAgentSkillShim", () => {
  let tmp: string;
  let bundled: string;
  let shimRoot: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cursor-skill-shim-"));
    bundled = path.join(tmp, "resources", "agent-skills");
    shimRoot = path.join(tmp, "ade-home", "agent-skill-shims", "cursor");
    fs.mkdirSync(bundled, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("materializes the layout Cursor scans: <root>/.agents/skills/<name>/SKILL.md", () => {
    writeSkill(bundled, "ade-browser", "---\nname: ade-browser\n---\nbody\n");
    writeSkill(bundled, "ade-search", "---\nname: ade-search\n---\nbody\n");
    // Packaging metadata is not a skill and must not land in the shim.
    fs.mkdirSync(path.join(bundled, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(bundled, ".claude-plugin", "plugin.json"), "{}");
    // A directory with no SKILL.md would be a root Cursor silently skips.
    fs.mkdirSync(path.join(bundled, "not-a-skill"), { recursive: true });

    const outcome = prepareCursorAgentSkillShim({ skillRoots: [bundled], shimRoot });

    expect(outcome).toMatchObject({ ok: true, root: shimRoot, refreshed: true });
    expect(outcome.ok && outcome.skillNames).toEqual(["ade-browser", "ade-search"]);
    const skillsDir = cursorAgentSkillShimSkillsDir(shimRoot);
    expect(skillsDir).toBe(path.join(shimRoot, ".agents", "skills"));
    expect(fs.readFileSync(path.join(skillsDir, "ade-browser", "SKILL.md"), "utf8"))
      .toContain("name: ade-browser");
    expect(fs.readdirSync(skillsDir).sort()).toEqual(["ade-browser", "ade-search"]);
    // The stamp must sit outside the skills directory or Cursor parses it as a skill.
    expect(fs.existsSync(path.join(shimRoot, ".ade-cursor-skill-shim.json"))).toBe(true);
  });

  it("copies nested skill files rather than linking them", () => {
    writeSkill(bundled, "ade-quality", "---\nname: ade-quality\n---\nbody\n");
    fs.mkdirSync(path.join(bundled, "ade-quality", "references"), { recursive: true });
    fs.writeFileSync(path.join(bundled, "ade-quality", "references", "notes.md"), "notes");

    prepareCursorAgentSkillShim({ skillRoots: [bundled], shimRoot });

    const copied = path.join(cursorAgentSkillShimSkillsDir(shimRoot), "ade-quality", "references", "notes.md");
    expect(fs.lstatSync(copied).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(copied, "utf8")).toBe("notes");
  });

  it("leaves an unchanged shim alone and refreshes it when the bundle changes", () => {
    writeSkill(bundled, "ade-browser", "v1\n");

    const first = prepareCursorAgentSkillShim({ skillRoots: [bundled], shimRoot });
    expect(first).toMatchObject({ ok: true, refreshed: true });

    const copied = path.join(cursorAgentSkillShimSkillsDir(shimRoot), "ade-browser", "SKILL.md");
    // A rewrite replaces the file, so the birth/modified pair is the tell.
    const firstStat = fs.statSync(copied);

    const second = prepareCursorAgentSkillShim({ skillRoots: [bundled], shimRoot });
    expect(second).toMatchObject({ ok: true, refreshed: false });
    expect(fs.statSync(copied).mtimeMs).toBe(firstStat.mtimeMs);
    expect(fs.readFileSync(copied, "utf8")).toBe("v1\n");

    writeSkill(bundled, "ade-browser", "v2\n");
    const third = prepareCursorAgentSkillShim({ skillRoots: [bundled], shimRoot });
    expect(third).toMatchObject({ ok: true, refreshed: true });
    expect(fs.readFileSync(copied, "utf8")).toBe("v2\n");
  });

  it("re-materializes when the stamp survives but the tree was deleted", () => {
    writeSkill(bundled, "ade-browser", "v1\n");
    prepareCursorAgentSkillShim({ skillRoots: [bundled], shimRoot });
    fs.rmSync(cursorAgentSkillShimSkillsDir(shimRoot), { recursive: true, force: true });

    const outcome = prepareCursorAgentSkillShim({ skillRoots: [bundled], shimRoot });

    expect(outcome).toMatchObject({ ok: true, refreshed: true });
    expect(fs.existsSync(path.join(cursorAgentSkillShimSkillsDir(shimRoot), "ade-browser", "SKILL.md"))).toBe(true);
  });

  it("drops a skill that a removed bundle entry left behind", () => {
    writeSkill(bundled, "ade-browser", "v1\n");
    writeSkill(bundled, "ade-search", "v1\n");
    prepareCursorAgentSkillShim({ skillRoots: [bundled], shimRoot });

    fs.rmSync(path.join(bundled, "ade-search"), { recursive: true, force: true });
    const outcome = prepareCursorAgentSkillShim({ skillRoots: [bundled], shimRoot });

    expect(outcome.ok && outcome.skillNames).toEqual(["ade-browser"]);
    expect(fs.readdirSync(cursorAgentSkillShimSkillsDir(shimRoot))).toEqual(["ade-browser"]);
  });

  it("lets the first root win a duplicate skill name", () => {
    const secondRoot = path.join(tmp, "user-skills");
    fs.mkdirSync(secondRoot, { recursive: true });
    writeSkill(bundled, "ade-browser", "bundled\n");
    writeSkill(secondRoot, "ade-browser", "user\n");

    prepareCursorAgentSkillShim({ skillRoots: [bundled, secondRoot], shimRoot });

    expect(fs.readFileSync(
      path.join(cursorAgentSkillShimSkillsDir(shimRoot), "ade-browser", "SKILL.md"),
      "utf8",
    )).toBe("bundled\n");
  });

  it("reports a reason instead of throwing when the shim cannot be written", () => {
    writeSkill(bundled, "ade-browser", "v1\n");
    // A file where the shim root belongs: every mkdir/copy under it fails.
    fs.mkdirSync(path.dirname(shimRoot), { recursive: true });
    fs.writeFileSync(shimRoot, "not a directory");

    const outcome = prepareCursorAgentSkillShim({ skillRoots: [bundled], shimRoot });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason.length).toBeGreaterThan(0);
  });
});

describe("cursorAgentSkillShimRoot", () => {
  it("is ADE-owned, never a provider-global skill home", () => {
    const root = cursorAgentSkillShimRoot({
      env: { ADE_HOME: path.join("/tmp", "ade-home") } as NodeJS.ProcessEnv,
      laneWorktreePath: "/repo/.ade/worktrees/lane-1",
    });
    expect(path.dirname(root)).toBe(
      path.join("/tmp", "ade-home", "agent-skill-shims", "cursor"),
    );
    expect(path.basename(root)).toMatch(/^[0-9a-f]{16}$/);
    expect(root).not.toContain(path.join(".cursor", "skills"));
  });

  it("keys per lane so two chats cannot rebuild one tree", () => {
    const env = { ADE_HOME: path.join("/tmp", "ade-home") } as NodeJS.ProcessEnv;
    const laneA = cursorAgentSkillShimRoot({ env, laneWorktreePath: "/repo/.ade/worktrees/lane-a" });
    const laneB = cursorAgentSkillShimRoot({ env, laneWorktreePath: "/repo/.ade/worktrees/lane-b" });
    const laneAAgain = cursorAgentSkillShimRoot({ env, laneWorktreePath: "/repo/.ade/worktrees/lane-a" });
    expect(laneA).not.toBe(laneB);
    expect(laneA).toBe(laneAAgain);
  });

  it("falls back to <home>/.ade", () => {
    const root = cursorAgentSkillShimRoot({
      env: {} as NodeJS.ProcessEnv,
      laneWorktreePath: "/repo/.ade/worktrees/lane-1",
    });
    expect(path.dirname(root)).toBe(
      path.join(os.homedir(), ".ade", "agent-skill-shims", "cursor"),
    );
  });
});

describe("cursorLoadsProjectSkills", () => {
  it("tracks the SDK's includeProjectExtensibility derivation", () => {
    expect(cursorLoadsProjectSkills(NORMAL_SOURCES)).toBe(true);
    expect(cursorLoadsProjectSkills(LEAD_SOURCES)).toBe(false);
    expect(cursorLoadsProjectSkills(["project", "user"])).toBe(true);
  });
});

describe("resolveCursorAgentSkillDirs", () => {
  let tmp: string;
  let bundled: string;
  let shimRoot: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cursor-skill-dirs-"));
    bundled = path.join(tmp, "resources", "agent-skills");
    shimRoot = path.join(tmp, "ade-home", "agent-skill-shims", "cursor");
    fs.mkdirSync(bundled, { recursive: true });
    writeSkill(bundled, "ade-browser", "v1\n");
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("passes the shim root as the extra Cursor workspace dir", () => {
    const decision = resolveCursorAgentSkillDirs({
      personalSession: false,
      settingSources: NORMAL_SOURCES,
      skillRoots: [bundled],
      shimRoot,
    });

    expect(decision.delivered).toBe(true);
    expect(decision.dirs).toEqual([shimRoot]);
    expect(decision.skillCount).toBe(1);
    expect(decision.rootCount).toBe(1);
    expect(decision.reason).toBeUndefined();
  });

  it("gives a personal session nothing", () => {
    const decision = resolveCursorAgentSkillDirs({
      personalSession: true,
      settingSources: NORMAL_SOURCES,
      skillRoots: [bundled],
      shimRoot,
    });

    expect(decision).toMatchObject({ delivered: false, dirs: [], reason: "personal_session" });
    expect(fs.existsSync(shimRoot)).toBe(false);
  });

  it("skips orchestration leads, which run without the project setting source", () => {
    const decision = resolveCursorAgentSkillDirs({
      personalSession: false,
      settingSources: LEAD_SOURCES,
      skillRoots: [bundled],
      shimRoot,
    });

    expect(decision).toMatchObject({
      delivered: false,
      dirs: [],
      reason: "project_setting_source_disabled",
    });
    expect(fs.existsSync(shimRoot)).toBe(false);
  });

  it("reports no roots rather than making an empty shim", () => {
    const decision = resolveCursorAgentSkillDirs({
      personalSession: false,
      settingSources: NORMAL_SOURCES,
      skillRoots: [],
      shimRoot,
    });

    expect(decision).toMatchObject({ delivered: false, dirs: [], reason: "no_existing_roots" });
  });

  it("degrades to no dirs when materialization fails", () => {
    fs.mkdirSync(path.dirname(shimRoot), { recursive: true });
    fs.writeFileSync(shimRoot, "not a directory");

    const decision = resolveCursorAgentSkillDirs({
      personalSession: false,
      settingSources: NORMAL_SOURCES,
      skillRoots: [bundled],
      shimRoot,
    });

    expect(decision.delivered).toBe(false);
    expect(decision.dirs).toEqual([]);
    expect(decision.reason).toBeTruthy();
    expect(decision.reason).not.toBe("no_existing_roots");
  });
});
