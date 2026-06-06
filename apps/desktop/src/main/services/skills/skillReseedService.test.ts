import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reseedAdeSkills } from "./skillReseedService";

function writeSkill(root: string, name: string, body: string): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), body);
}

describe("reseedAdeSkills", () => {
  let tmp: string;
  let bundled: string;
  let target: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ade-reseed-"));
    bundled = path.join(tmp, "bundled");
    target = path.join(tmp, "home", ".claude", "skills");
    fs.mkdirSync(bundled, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("copies only ade-* bundled skills into the target and writes a manifest", () => {
    writeSkill(bundled, "ade-browser", "# browser");
    writeSkill(bundled, "ade-proof-artifacts", "# proof");
    writeSkill(bundled, "not-an-ade-skill", "# ignored"); // missing ade- prefix → skipped

    const result = reseedAdeSkills({ bundledRoot: bundled, targetDirs: [target], version: "1" });

    expect(result.skillNames).toEqual(["ade-browser", "ade-proof-artifacts"]);
    expect(result.targetsWritten).toEqual([target]);
    expect(fs.existsSync(path.join(target, "ade-browser", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(target, "ade-proof-artifacts", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(target, "not-an-ade-skill"))).toBe(false);
    expect(fs.existsSync(path.join(target, ".ade-skills.json"))).toBe(true);
  });

  it("is a no-op on the second run when nothing changed (self-healing, cheap)", () => {
    writeSkill(bundled, "ade-browser", "# browser");
    reseedAdeSkills({ bundledRoot: bundled, targetDirs: [target], version: "1" });

    const second = reseedAdeSkills({ bundledRoot: bundled, targetDirs: [target], version: "1" });
    expect(second.targetsWritten).toEqual([]);
    expect(second.targetsUpToDate).toEqual([target]);
  });

  it("never clobbers or prunes a user's own (non-managed) skills", () => {
    writeSkill(bundled, "ade-browser", "# browser");
    reseedAdeSkills({ bundledRoot: bundled, targetDirs: [target], version: "1" });
    writeSkill(target, "my-own-skill", "# mine"); // user-authored, not ADE-managed

    // bundle changes → re-seed runs again
    writeSkill(bundled, "ade-linear", "# linear");
    reseedAdeSkills({ bundledRoot: bundled, targetDirs: [target], version: "1" });

    expect(fs.existsSync(path.join(target, "my-own-skill", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(target, "ade-linear", "SKILL.md"))).toBe(true);
  });

  it("materializes real files when the bundle ships a skill as a symlink (dereference)", () => {
    // Some bundle layouts (e.g. a plugin) ship skill dirs as symlinks. The seeded
    // copy must be real files in the user's home, never a link back into the bundle.
    const realSkill = path.join(tmp, "real", "ade-linked");
    fs.mkdirSync(realSkill, { recursive: true });
    fs.writeFileSync(path.join(realSkill, "SKILL.md"), "# linked");
    fs.symlinkSync(realSkill, path.join(bundled, "ade-linked"), "dir");

    reseedAdeSkills({ bundledRoot: bundled, targetDirs: [target], version: "1" });

    const dest = path.join(target, "ade-linked");
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.join(dest, "SKILL.md")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(dest, "SKILL.md"), "utf8")).toBe("# linked");
  });

  it("seeds every target dir independently when given multiple targets", () => {
    writeSkill(bundled, "ade-browser", "# browser");
    const target1 = path.join(tmp, "home", ".claude", "skills");
    const target2 = path.join(tmp, "home", ".agents", "skills");

    const result = reseedAdeSkills({
      bundledRoot: bundled,
      targetDirs: [target1, target2],
      version: "1",
    });

    expect(result.targetsWritten).toEqual([target1, target2]);
    expect(fs.existsSync(path.join(target1, "ade-browser", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(target2, "ade-browser", "SKILL.md"))).toBe(true);
  });

  it("prunes ADE-managed skills that are no longer bundled, on a content change", () => {
    writeSkill(bundled, "ade-old", "# old");
    reseedAdeSkills({ bundledRoot: bundled, targetDirs: [target], version: "1" });
    expect(fs.existsSync(path.join(target, "ade-old"))).toBe(true);

    fs.rmSync(path.join(bundled, "ade-old"), { recursive: true, force: true });
    writeSkill(bundled, "ade-new", "# new");
    reseedAdeSkills({ bundledRoot: bundled, targetDirs: [target], version: "1" });

    expect(fs.existsSync(path.join(target, "ade-old"))).toBe(false);
    expect(fs.existsSync(path.join(target, "ade-new", "SKILL.md"))).toBe(true);
  });
});
