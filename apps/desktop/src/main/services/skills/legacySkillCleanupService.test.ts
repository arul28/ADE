import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function legacyManifestHash(name: string, body: string): string {
  return crypto.createHash("sha256")
    .update(`\0skill:${name}\0`)
    .update("SKILL.md")
    .update("\0")
    .update(body)
    .digest("hex");
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
    vi.restoreAllMocks();
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

  it("removes an unchanged legacy copy after the bundled version has advanced", () => {
    writeSkill(bundled, "ade-browser", "# current bundle");
    writeSkill(target, "ade-browser", "# prior bundle");
    writeLegacyManifest(
      target,
      ["ade-browser"],
      legacyManifestHash("ade-browser", "# prior bundle"),
    );

    const result = cleanupLegacyAdeSkills({ bundledRoot: bundled, targetDirs: [target] });

    expect(result.skillsRemoved).toEqual([path.join(target, "ade-browser")]);
    expect(result.skillsPreserved).toEqual([]);
    expect(fs.existsSync(path.join(target, "ade-browser"))).toBe(false);
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

  it("preserves a skill whose removal fails and continues cleaning later skills and providers", () => {
    writeSkill(bundled, "ade-app-control", "# app");
    writeSkill(bundled, "ade-browser", "# browser");
    const target2 = path.join(tmp, "home", ".agents", "skills");
    for (const dir of [target, target2]) {
      writeSkill(dir, "ade-app-control", "# app");
      writeSkill(dir, "ade-browser", "# browser");
      writeLegacyManifest(dir, ["ade-app-control", "ade-browser"]);
    }
    const failedSkill = path.join(target, "ade-app-control");
    const originalRmSync = fs.rmSync.bind(fs);
    vi.spyOn(fs, "rmSync").mockImplementation((pathToRemove, options) => {
      if (pathToRemove === failedSkill) throw new Error("permission denied");
      originalRmSync(pathToRemove, options);
    });

    const result = cleanupLegacyAdeSkills({
      bundledRoot: bundled,
      targetDirs: [target, target2],
    });

    expect(result.skillsPreserved).toEqual([failedSkill]);
    expect(result.skillsRemoved).toEqual([
      path.join(target, "ade-browser"),
      path.join(target2, "ade-app-control"),
      path.join(target2, "ade-browser"),
    ]);
    expect(result.targetsCleaned).toEqual([target2]);
    expect(fs.existsSync(failedSkill)).toBe(true);
    expect(fs.existsSync(path.join(target, ".ade-skills.json"))).toBe(true);
    expect(fs.existsSync(path.join(target, "ade-browser"))).toBe(false);
    expect(fs.existsSync(path.join(target2, "ade-app-control"))).toBe(false);
  });

  it("leaves a failed manifest uncleaned and continues cleaning later providers", () => {
    writeSkill(bundled, "ade-browser", "# browser");
    const target2 = path.join(tmp, "home", ".agents", "skills");
    for (const dir of [target, target2]) {
      writeSkill(dir, "ade-browser", "# browser");
      writeLegacyManifest(dir, ["ade-browser"]);
    }
    const failedManifest = path.join(target, ".ade-skills.json");
    const originalRmSync = fs.rmSync.bind(fs);
    vi.spyOn(fs, "rmSync").mockImplementation((pathToRemove, options) => {
      if (pathToRemove === failedManifest) throw new Error("permission denied");
      originalRmSync(pathToRemove, options);
    });

    const result = cleanupLegacyAdeSkills({
      bundledRoot: bundled,
      targetDirs: [target, target2],
    });

    expect(result.skillsRemoved).toEqual([
      path.join(target, "ade-browser"),
      path.join(target2, "ade-browser"),
    ]);
    expect(result.targetsCleaned).toEqual([target2]);
    expect(fs.existsSync(failedManifest)).toBe(true);
    expect(fs.existsSync(path.join(target2, ".ade-skills.json"))).toBe(false);
  });

  it.each([
    ["empty directory", (skillDir: string) => fs.mkdirSync(skillDir, { recursive: true })],
    ["symbolic link", (skillDir: string) => {
      const userOwned = path.join(tmp, "user-owned");
      fs.mkdirSync(userOwned, { recursive: true });
      fs.writeFileSync(path.join(userOwned, "SKILL.md"), "# user owned");
      fs.mkdirSync(path.dirname(skillDir), { recursive: true });
      fs.symlinkSync(userOwned, skillDir, "dir");
    }],
    ["unsupported filesystem entry", (skillDir: string) => {
      fs.mkdirSync(skillDir, { recursive: true });
      execFileSync("mkfifo", [path.join(skillDir, "pipe")]);
    }],
  ])("preserves a recorded %s and retires only the manifest", (_label, arrange) => {
    writeSkill(bundled, "ade-browser", "# browser");
    const installed = path.join(target, "ade-browser");
    arrange(installed);
    writeLegacyManifest(target, ["ade-browser"]);

    const result = cleanupLegacyAdeSkills({ bundledRoot: bundled, targetDirs: [target] });

    expect(result.skillsRemoved).toEqual([]);
    expect(result.skillsPreserved).toEqual([installed]);
    expect(fs.existsSync(installed)).toBe(true);
    expect(fs.existsSync(path.join(target, ".ade-skills.json"))).toBe(false);
  });

  it("preserves an unreadable recorded directory", () => {
    writeSkill(bundled, "ade-browser", "# browser");
    writeSkill(target, "ade-browser", "# browser");
    const installed = path.join(target, "ade-browser");
    writeLegacyManifest(target, ["ade-browser"]);
    fs.chmodSync(installed, 0o000);

    const result = cleanupLegacyAdeSkills({ bundledRoot: bundled, targetDirs: [target] });

    fs.chmodSync(installed, 0o700);
    expect(result.skillsRemoved).toEqual([]);
    expect(result.skillsPreserved).toEqual([installed]);
    expect(fs.existsSync(installed)).toBe(true);
    expect(fs.existsSync(path.join(target, ".ade-skills.json"))).toBe(false);
  });
});
