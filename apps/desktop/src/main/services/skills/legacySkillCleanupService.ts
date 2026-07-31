import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * ADE used to copy its bundled skills into every provider's user-global skill
 * directory. That leaked ADE-only capabilities into unrelated harnesses.
 *
 * This service is a conservative migration: remove legacy
 * copies only when their content is provably unchanged, then remove ADE's
 * manifest. Modified or otherwise unverifiable directories are preserved.
 */

const LEGACY_MANIFEST = ".ade-skills.json";

interface BundledSkill {
  name: string;
  dir: string;
}

interface LegacyManifest {
  hash: string;
  names: string[];
}

type SkillTreeEntry =
  | { kind: "directory"; relative: string }
  | { kind: "file"; relative: string; contents: Buffer };

export interface LegacySkillCleanupResult {
  targetsCleaned: string[];
  skillsRemoved: string[];
  skillsPreserved: string[];
}

export function defaultAdeSkillTargetDirs(home: string = os.homedir()): string[] {
  return [
    path.join(home, ".claude", "skills"),
    path.join(home, ".agents", "skills"),
    path.join(home, ".cursor", "skills"),
    path.join(home, ".factory", "skills"),
    path.join(home, ".config", "opencode", "skills"),
  ];
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function listBundledAdeSkills(bundledRoot: string): BundledSkill[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(bundledRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("ade-"))
    .map((entry) => ({ name: entry.name, dir: path.join(bundledRoot, entry.name) }))
    .filter((entry) => {
      try {
        return fs.lstatSync(path.join(entry.dir, "SKILL.md")).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function readSkillTree(dir: string): SkillTreeEntry[] | null {
  try {
    const rootStat = fs.lstatSync(dir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
  } catch {
    return null;
  }

  const tree: SkillTreeEntry[] = [];
  const stack: Array<{ dir: string; relative: string }> = [{ dir, relative: "" }];
  while (stack.length) {
    const current = stack.pop() as { dir: string; relative: string };
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return null;
    }
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index] as fs.Dirent;
      const relative = current.relative
        ? `${current.relative}/${entry.name}`
        : entry.name;
      const full = path.join(current.dir, entry.name);
      if (entry.isSymbolicLink()) return null;
      if (entry.isDirectory()) {
        tree.push({ kind: "directory", relative });
        stack.push({ dir: full, relative });
        continue;
      }
      if (!entry.isFile()) return null;
      try {
        tree.push({ kind: "file", relative, contents: fs.readFileSync(full) });
      } catch {
        return null;
      }
    }
  }
  return tree.some((entry) => entry.kind === "file") ? tree : null;
}

function hashSkills(skills: BundledSkill[]): string | null {
  const hash = crypto.createHash("sha256");
  for (const skill of skills) {
    const tree = readSkillTree(skill.dir);
    if (!tree) return null;
    hash.update(`skill\0${skill.name}\0`);
    for (const entry of tree.sort((a, b) => a.relative.localeCompare(b.relative))) {
      hash.update(`${entry.kind}\0${entry.relative}\0`);
      if (entry.kind === "file") hash.update(entry.contents);
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

function legacyManifestHash(skills: BundledSkill[]): string | null {
  const hash = crypto.createHash("sha256");
  for (const skill of skills) {
    const tree = readSkillTree(skill.dir);
    if (!tree) return null;
    hash.update(`\0skill:${skill.name}\0`);
    for (const entry of tree
      .filter((item): item is Extract<SkillTreeEntry, { kind: "file" }> => item.kind === "file")
      .sort((a, b) => a.relative.localeCompare(b.relative))) {
      hash.update(entry.relative);
      hash.update("\0");
      hash.update(entry.contents);
    }
  }
  return hash.digest("hex");
}

function readManifest(manifestPath: string): LegacyManifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as LegacyManifest;
    if (
      parsed
      && typeof parsed.hash === "string"
      && Array.isArray(parsed.names)
      && parsed.names.every((name) =>
        typeof name === "string" && /^ade-[a-z0-9][a-z0-9-]*$/.test(name)
      )
    ) {
      return parsed;
    }
  } catch {
    // A missing or malformed manifest is not authority to remove anything.
  }
  return null;
}

function directoryMatches(left: string, right: string): boolean {
  const leftHash = hashSkills([{ name: "skill", dir: left }]);
  const rightHash = hashSkills([{ name: "skill", dir: right }]);
  return leftHash != null && rightHash != null && leftHash === rightHash;
}

export function cleanupLegacyAdeSkills(opts: {
  bundledRoot: string;
  targetDirs?: string[];
}): LegacySkillCleanupResult {
  const result: LegacySkillCleanupResult = {
    targetsCleaned: [],
    skillsRemoved: [],
    skillsPreserved: [],
  };
  const bundledByName = new Map(listBundledAdeSkills(opts.bundledRoot).map((skill) => [skill.name, skill]));

  for (const target of opts.targetDirs ?? defaultAdeSkillTargetDirs()) {
    const manifestPath = path.join(target, LEGACY_MANIFEST);
    const manifest = readManifest(manifestPath);
    if (!manifest) continue;

    const installed = manifest.names
      .map((name) => ({ name, dir: path.join(target, name) }))
      .filter((skill) => fs.existsSync(skill.dir))
      .sort((a, b) => a.name.localeCompare(b.name));
    const installedHash = legacyManifestHash(installed);
    const wholeLegacySetUnchanged =
      installed.length === manifest.names.length
      && installedHash != null
      && installedHash === manifest.hash;

    for (const installedSkill of installed) {
      const bundled = bundledByName.get(installedSkill.name);
      if (wholeLegacySetUnchanged || (bundled && directoryMatches(installedSkill.dir, bundled.dir))) {
        fs.rmSync(installedSkill.dir, { recursive: true, force: true });
        result.skillsRemoved.push(installedSkill.dir);
      } else {
        result.skillsPreserved.push(installedSkill.dir);
      }
    }

    fs.rmSync(manifestPath, { force: true });
    result.targetsCleaned.push(target);
  }

  return result;
}

export function resolveBundledAgentSkillsRoot(candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (candidate && isDirectory(candidate)) return candidate;
  }
  return null;
}
