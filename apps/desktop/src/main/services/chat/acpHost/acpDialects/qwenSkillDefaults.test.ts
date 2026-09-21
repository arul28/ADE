/**
 * ADE's bundled skills reaching Qwen through Qwen's OWN `skills.directories`
 * discovery.
 *
 * The contract these tests hold:
 *
 *   1. the spawn plan names an ADE-owned file through
 *      `QWEN_CODE_SYSTEM_DEFAULTS_PATH`;
 *   2. that file carries the roots under `skills.directories`;
 *   3. a root that is not on disk never reaches it;
 *   4. a personal chat gets nothing at all;
 *   5. nothing is ever written under the user's `~/.qwen`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { qwenDialect } from "./qwen";
import {
  buildQwenAdeSkillDefaults,
  ensureQwenAdeSkillDefaultsFile,
  qwenAdeSkillDefaultsPath,
  qwenNativeSystemDefaultsPath,
  QWEN_SYSTEM_DEFAULTS_PATH_ENV,
  QWEN_SYSTEM_SETTINGS_PATH_ENV,
} from "./qwenSkillDefaults";
import { ADE_AGENT_SKILLS_DIRS_ENV, joinAdeAgentSkillRoots } from "../../../../../shared/agentSkillRoots";

let tempRoot = "";
let projectRoot = "";
let laneWorktreePath = "";
let userHome = "";
let qwenConfigHome = "";

/** A bundled-skill root in ADE's real `<root>/<skill-name>/SKILL.md` shape. */
function makeSkillRoot(name: string, skillName: string): string {
  const root = path.join(tempRoot, name);
  fs.mkdirSync(path.join(root, skillName), { recursive: true });
  fs.writeFileSync(path.join(root, skillName, "SKILL.md"), `# ${skillName}\n`, "utf8");
  return root;
}

function skillEnv(roots: readonly string[]): NodeJS.ProcessEnv {
  return {
    [ADE_AGENT_SKILLS_DIRS_ENV]: joinAdeAgentSkillRoots(roots),
    // The user's real qwen home, so a test that writes there would be caught.
    QWEN_HOME: qwenConfigHome,
    HOME: userHome,
  };
}

function readDefaults(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

function directoriesOf(file: string): string[] {
  const parsed = readDefaults(file);
  const skills = parsed.skills as { directories?: unknown } | undefined;
  return Array.isArray(skills?.directories) ? (skills.directories as string[]) : [];
}

beforeEach(() => {
  tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-qwen-skills-")));
  projectRoot = path.join(tempRoot, "project");
  laneWorktreePath = path.join(projectRoot, ".ade", "worktrees", "lane-a");
  userHome = path.join(tempRoot, "home");
  qwenConfigHome = path.join(userHome, ".qwen");
  fs.mkdirSync(laneWorktreePath, { recursive: true });
  fs.mkdirSync(qwenConfigHome, { recursive: true });
  fs.writeFileSync(path.join(qwenConfigHome, "settings.json"), `{"theme":"user-choice"}\n`, "utf8");
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("qwen skill defaults file", () => {
  it("resolves the Windows system-defaults path through ProgramData, not a hardcoded drive", () => {
    // An administrator can relocate ProgramData to another volume; reading the
    // wrong base would silently drop the machine's own defaults tier.
    const relocated = qwenNativeSystemDefaultsPath({ ProgramData: "D:\\Corp\\ProgramData" }, "win32");
    expect(relocated).toContain("D:\\Corp\\ProgramData");
    expect(relocated).toMatch(/system-defaults\.json$/);
    // The conventional drive is only a fallback when the env var is absent.
    expect(qwenNativeSystemDefaultsPath({}, "win32")).toContain("C:\\ProgramData");
    // An explicit override still wins over any platform default.
    expect(qwenNativeSystemDefaultsPath(
      { [QWEN_SYSTEM_DEFAULTS_PATH_ENV]: "/custom/system.json" },
      "win32",
    )).toBe("/custom/system.json");
  });

  it("puts the existing roots under skills.directories in an ADE-owned file", () => {
    const bundled = makeSkillRoot("bundled-skills", "ship");
    const project = makeSkillRoot("project-skills", "quality");

    const result = ensureQwenAdeSkillDefaultsFile({
      projectRoot,
      laneWorktreePath,
      env: skillEnv([bundled, project]),
      personalSession: false,
    });

    expect(result.reason).toBeUndefined();
    expect(result.path).toBe(qwenAdeSkillDefaultsPath({ projectRoot, laneWorktreePath }));
    expect(result.roots).toEqual([bundled, project]);
    // ADE's own machine-local, gitignored area — not the lane worktree, not the
    // system temp dir, and not any provider's config home.
    expect(result.path).toContain(path.join(projectRoot, ".ade", "cache"));
    expect(directoriesOf(result.path!)).toEqual([bundled, project]);
    // Qwen scans one level deep, so the roots must be the parents of the skill
    // directories rather than the skill directories themselves.
    for (const root of directoriesOf(result.path!)) {
      const entries = fs.readdirSync(root);
      expect(entries.some((entry) => fs.existsSync(path.join(root, entry, "SKILL.md")))).toBe(true);
    }
  });

  it("excludes a root that is not on disk", () => {
    const real = makeSkillRoot("real-skills", "ship");
    const missing = path.join(tempRoot, "not-created");
    const file = path.join(tempRoot, "a-file-not-a-dir");
    fs.writeFileSync(file, "x", "utf8");

    const result = ensureQwenAdeSkillDefaultsFile({
      projectRoot,
      laneWorktreePath,
      env: skillEnv([missing, real, file]),
      personalSession: false,
    });

    expect(result.roots).toEqual([real]);
    expect(directoriesOf(result.path!)).toEqual([real]);
    expect(directoriesOf(result.path!)).not.toContain(missing);
    expect(directoriesOf(result.path!)).not.toContain(file);
  });

  it("writes nothing when every advertised root is missing", () => {
    const result = ensureQwenAdeSkillDefaultsFile({
      projectRoot,
      laneWorktreePath,
      env: skillEnv([path.join(tempRoot, "nope")]),
      personalSession: false,
    });

    expect(result).toEqual({ path: null, roots: [], reason: "no_existing_roots" });
    expect(fs.existsSync(qwenAdeSkillDefaultsPath({ projectRoot, laneWorktreePath }))).toBe(false);
  });

  it("gives a personal chat no ADE skills and writes no file", () => {
    const bundled = makeSkillRoot("bundled-skills", "ship");

    const result = ensureQwenAdeSkillDefaultsFile({
      projectRoot,
      laneWorktreePath,
      env: skillEnv([bundled]),
      personalSession: true,
    });

    expect(result).toEqual({ path: null, roots: [], reason: "personal_session" });
    expect(fs.existsSync(qwenAdeSkillDefaultsPath({ projectRoot, laneWorktreePath }))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, ".ade", "cache"))).toBe(false);
  });

  it("never writes under the user's qwen config home", () => {
    const bundled = makeSkillRoot("bundled-skills", "ship");
    const before = fs.readdirSync(qwenConfigHome);
    const settingsBefore = fs.readFileSync(path.join(qwenConfigHome, "settings.json"), "utf8");

    const result = ensureQwenAdeSkillDefaultsFile({
      projectRoot,
      laneWorktreePath,
      env: skillEnv([bundled]),
      personalSession: false,
    });

    expect(result.path).not.toBeNull();
    expect(result.path!.startsWith(qwenConfigHome)).toBe(false);
    expect(result.path!.startsWith(userHome)).toBe(false);
    expect(fs.readdirSync(qwenConfigHome)).toEqual(before);
    expect(fs.readFileSync(path.join(qwenConfigHome, "settings.json"), "utf8")).toBe(settingsBefore);
  });

  it("layers on the machine's own system-defaults instead of hiding it", () => {
    const bundled = makeSkillRoot("bundled-skills", "ship");
    const adminDefaults = path.join(tempRoot, "admin", "system-defaults.json");
    fs.mkdirSync(path.dirname(adminDefaults), { recursive: true });
    fs.writeFileSync(
      adminDefaults,
      JSON.stringify({
        skills: { directories: ["/opt/org-skills"], disabled: ["risky"] },
        telemetry: { enabled: false },
      }),
      "utf8",
    );

    const result = ensureQwenAdeSkillDefaultsFile({
      projectRoot,
      laneWorktreePath,
      env: { ...skillEnv([bundled]), [QWEN_SYSTEM_DEFAULTS_PATH_ENV]: adminDefaults },
      personalSession: false,
    });

    const parsed = readDefaults(result.path!);
    expect(directoriesOf(result.path!)).toEqual(["/opt/org-skills", bundled]);
    expect((parsed.skills as { disabled?: unknown }).disabled).toEqual(["risky"]);
    expect(parsed.telemetry).toEqual({ enabled: false });
  });

  it("does not read its own previous output back as the base", () => {
    const bundled = makeSkillRoot("bundled-skills", "ship");
    const target = qwenAdeSkillDefaultsPath({ projectRoot, laneWorktreePath });
    const env = { ...skillEnv([bundled]), [QWEN_SYSTEM_DEFAULTS_PATH_ENV]: target };

    ensureQwenAdeSkillDefaultsFile({ projectRoot, laneWorktreePath, env, personalSession: false });
    const result = ensureQwenAdeSkillDefaultsFile({
      projectRoot,
      laneWorktreePath,
      env,
      personalSession: false,
    });

    expect(directoriesOf(result.path!)).toEqual([bundled]);
  });

  it("derives the native defaults path from the system settings override", () => {
    const settingsPath = path.join(tempRoot, "admin", "settings.json");
    const adminDefaults = path.join(tempRoot, "admin", "system-defaults.json");
    fs.mkdirSync(path.dirname(adminDefaults), { recursive: true });
    fs.writeFileSync(adminDefaults, JSON.stringify({ skills: { directories: ["/opt/org"] } }), "utf8");
    const bundled = makeSkillRoot("bundled-skills", "ship");

    const result = ensureQwenAdeSkillDefaultsFile({
      projectRoot,
      laneWorktreePath,
      env: { ...skillEnv([bundled]), [QWEN_SYSTEM_SETTINGS_PATH_ENV]: settingsPath },
      personalSession: false,
    });

    expect(directoriesOf(result.path!)).toEqual(["/opt/org", bundled]);
  });

  it("keys the file per lane and survives a missing project root", () => {
    const otherLane = path.join(projectRoot, ".ade", "worktrees", "lane-b");
    expect(qwenAdeSkillDefaultsPath({ projectRoot, laneWorktreePath }))
      .not.toBe(qwenAdeSkillDefaultsPath({ projectRoot, laneWorktreePath: otherLane }));
    expect(ensureQwenAdeSkillDefaultsFile({
      projectRoot: null,
      laneWorktreePath,
      env: skillEnv([]),
      personalSession: false,
    })).toEqual({ path: null, roots: [], reason: "no_project_root" });
  });

  it("dedupes and drops blank entries when building the settings object", () => {
    expect(buildQwenAdeSkillDefaults({
      roots: ["/a/skills", "/a/skills", "  ", "/b/skills"],
      base: { skills: { directories: ["/a/skills"] } },
    })).toEqual({ skills: { directories: ["/a/skills", "/b/skills"] } });
  });
});

describe("qwen spawn plan", () => {
  it("names the ADE-owned defaults file through QWEN_CODE_SYSTEM_DEFAULTS_PATH", () => {
    const bundled = makeSkillRoot("bundled-skills", "ship");
    const result = ensureQwenAdeSkillDefaultsFile({
      projectRoot,
      laneWorktreePath,
      env: skillEnv([bundled]),
      personalSession: false,
    });

    const plan = qwenDialect.buildSpawnPlan({
      binaryPath: "/bin/qwen",
      cwd: laneWorktreePath,
      baseEnv: {},
      configHome: qwenConfigHome,
      adeSkillDefaultsPath: result.path,
    });

    expect(plan.env[QWEN_SYSTEM_DEFAULTS_PATH_ENV]).toBe(result.path);
    // The env var must name a file ADE owns, never the provider's config home.
    expect(plan.env[QWEN_SYSTEM_DEFAULTS_PATH_ENV]!.startsWith(qwenConfigHome)).toBe(false);
    expect(plan.env[QWEN_SYSTEM_DEFAULTS_PATH_ENV]).toContain(path.join(projectRoot, ".ade", "cache"));
    expect(fs.existsSync(plan.env[QWEN_SYSTEM_DEFAULTS_PATH_ENV]!)).toBe(true);
    expect(directoriesOf(plan.env[QWEN_SYSTEM_DEFAULTS_PATH_ENV]!)).toEqual([bundled]);
  });

  it("leaves the env var unset when there is nothing to deliver", () => {
    const personal = ensureQwenAdeSkillDefaultsFile({
      projectRoot,
      laneWorktreePath,
      env: skillEnv([makeSkillRoot("bundled-skills", "ship")]),
      personalSession: true,
    });

    const plan = qwenDialect.buildSpawnPlan({
      binaryPath: "/bin/qwen",
      cwd: laneWorktreePath,
      baseEnv: {},
      configHome: qwenConfigHome,
      adeSkillDefaultsPath: personal.path,
    });

    expect(plan.env[QWEN_SYSTEM_DEFAULTS_PATH_ENV]).toBeUndefined();
    expect(plan.env.QWEN_HOME).toBe(qwenConfigHome);
    expect(
      qwenDialect.buildSpawnPlan({ binaryPath: "/bin/qwen", cwd: laneWorktreePath, baseEnv: {} })
        .env[QWEN_SYSTEM_DEFAULTS_PATH_ENV],
    ).toBeUndefined();
  });

  it("keys the pool on the defaults path, so two settings files never share a process", () => {
    expect(qwenDialect.poolEnvKeys).toContain(QWEN_SYSTEM_DEFAULTS_PATH_ENV);
  });
});
