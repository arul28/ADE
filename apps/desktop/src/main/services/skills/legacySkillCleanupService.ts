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
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && entry.name.startsWith("ade-"))
    .map((entry) => ({ name: entry.name, dir: path.join(bundledRoot, entry.name) }))
    .filter((entry) => fs.existsSync(path.join(entry.dir, "SKILL.md")))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out.sort();
}

function hashSkills(skills: BundledSkill[]): string {
  const hash = crypto.createHash("sha256");
  for (const skill of skills) {
    hash.update(`\0skill:${skill.name}\0`);
    for (const file of walkFiles(skill.dir)) {
      hash.update(path.relative(skill.dir, file).split(path.sep).join("/"));
      hash.update("\0");
      try {
        hash.update(fs.readFileSync(file));
      } catch {
        hash.update("\u0001unreadable\u0001");
      }
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
  if (!isDirectory(left) || !isDirectory(right)) return false;
  return hashSkills([{ name: "skill", dir: left }]) === hashSkills([{ name: "skill", dir: right }]);
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
      .filter((skill) => isDirectory(skill.dir))
      .sort((a, b) => a.name.localeCompare(b.name));
    const wholeLegacySetUnchanged =
      installed.length === manifest.names.length && hashSkills(installed) === manifest.hash;

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
