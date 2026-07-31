import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupLegacyAdeSkills } from "./legacySkillCleanupService";

function writeSkill(root: string, name: string, body: string): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), body);
}

function writeLegacyManifest(target: string, names: string[], hash = "legacy-hash"): void {
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, ".ade-skills.json"), JSON.stringify({ version: "1", hash, names }));
}

describe("cleanupLegacyAdeSkills", () => {
  let tmp: string;
  let bundled: string;
  let target: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ade-skill-cleanup-"));
    bundled = path.join(tmp, "bundled");
    target = path.join(tmp, "home", ".claude", "skills");
    fs.mkdirSync(bundled, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("removes an ADE-recorded global copy that still matches the bundle", () => {
    writeSkill(bundled, "ade-browser", "# browser");
    writeSkill(target, "ade-browser", "# browser");
    writeLegacyManifest(target, ["ade-browser"]);

    const result = cleanupLegacyAdeSkills({ bundledRoot: bundled, targetDirs: [target] });

    expect(result.skillsRemoved).toEqual([path.join(target, "ade-browser")]);
    expect(result.skillsPreserved).toEqual([]);
    expect(fs.existsSync(path.join(target, "ade-browser"))).toBe(false);
    expect(fs.existsSync(path.join(target, ".ade-skills.json"))).toBe(false);
  });

  it("preserves a user-modified ADE copy while retiring the legacy manifest", () => {
    writeSkill(bundled, "ade-browser", "# current bundle");
    writeSkill(target, "ade-browser", "# user modified");
    writeLegacyManifest(target, ["ade-browser"]);

    const result = cleanupLegacyAdeSkills({ bundledRoot: bundled, targetDirs: [target] });

    expect(result.skillsRemoved).toEqual([]);
    expect(result.skillsPreserved).toEqual([path.join(target, "ade-browser")]);
    expect(fs.readFileSync(path.join(target, "ade-browser", "SKILL.md"), "utf8")).toBe("# user modified");
    expect(fs.existsSync(path.join(target, ".ade-skills.json"))).toBe(false);
  });

  it("ignores directories without a valid ADE manifest", () => {
    writeSkill(target, "ade-browser", "# user owned");
    fs.writeFileSync(path.join(target, ".ade-skills.json"), JSON.stringify({
      hash: "legacy",
      names: ["not-ade"],
    }));

    const result = cleanupLegacyAdeSkills({ bundledRoot: bundled, targetDirs: [target] });

    expect(result.targetsCleaned).toEqual([]);
    expect(fs.existsSync(path.join(target, "ade-browser", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(target, ".ade-skills.json"))).toBe(true);
  });

  it("rejects manifest names that could escape the provider skill directory", () => {
    writeLegacyManifest(target, ["ade-../../outside"]);
    const outside = path.join(tmp, "home", "outside");
    fs.mkdirSync(outside, { recursive: true });

    const result = cleanupLegacyAdeSkills({ bundledRoot: bundled, targetDirs: [target] });

    expect(result.targetsCleaned).toEqual([]);
    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.existsSync(path.join(target, ".ade-skills.json"))).toBe(true);
  });

  it("cleans each legacy provider directory independently", () => {
    writeSkill(bundled, "ade-browser", "# browser");
    const target2 = path.join(tmp, "home", ".agents", "skills");
    for (const dir of [target, target2]) {
      writeSkill(dir, "ade-browser", "# browser");
      writeLegacyManifest(dir, ["ade-browser"]);
    }

    const result = cleanupLegacyAdeSkills({
      bundledRoot: bundled,
      targetDirs: [target, target2],
    });

    expect(result.targetsCleaned).toEqual([target, target2]);
    expect(fs.existsSync(path.join(target, "ade-browser"))).toBe(false);
    expect(fs.existsSync(path.join(target2, "ade-browser"))).toBe(false);
  });
});
