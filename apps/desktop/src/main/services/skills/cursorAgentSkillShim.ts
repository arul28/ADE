import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathKey } from "../shared/pathCompare";

/**
 * Cursor's own agent-skill discovery, fed from an ADE-owned private directory.
 *
 * Cursor scans `<root>/.agents/skills/<name>/SKILL.md` for every workspace root
 * it is given (`LocalAgentOptions.dirs`, merged with `cwd`). ADE's bundled
 * skills live in the app's read-only resources, which is not a workspace root,
 * so they are copied into a private shim root that ADE then passes as an extra
 * `dirs` entry.
 *
 * Copies, not symlinks, on purpose:
 *   - Cursor's skill walker follows symlinks but then drops any skill whose
 *     `realpath` falls outside the allowed roots (the workspace roots
 *     themselves). A symlink into `/Applications/ADE.app/...` is discovered and
 *     then discarded unless the app's resources directory is ALSO handed over
 *     as a workspace root — which would widen Cursor's request-context
 *     workspace metadata and ADE's own path gates over the whole app bundle.
 *   - Symlink creation on Windows needs Developer Mode or SeCreateSymbolicLink.
 *     A copy behaves identically on every platform.
 *
 * The bundle is ~120 KB, so re-copying is cheap; it is still content-hashed so
 * an unchanged bundle does not rewrite the tree on every chat launch. The
 * hashing shape follows `legacySkillCleanupService.ts`, which is ADE's existing
 * precedent for "is this skill copy still the one we wrote?".
 *
 * This is NOT an install into a provider-global skill home (`~/.cursor/skills`
 * and friends). The shim root is ADE-owned and keyed per lane, so concurrent
 * chats cannot rebuild a tree another session is using; see
 * docs/features/agents/README.md, "Bundled skill distribution".
 */

/** Cursor's non-third-party project skill layout: `<root>/.agents/skills`. */
const SHIM_SKILLS_SEGMENTS = [".agents", "skills"] as const;
/**
 * Stamp lives at the shim root, never inside `.agents/skills` — Cursor reads
 * every child of the skills directory, so a manifest in there would be parsed
 * as a (broken) skill.
 */
const SHIM_STAMP_FILE = ".ade-cursor-skill-shim.json";
const SHIM_STAMP_VERSION = 2;

export type CursorAgentSkillShim = {
  /** Workspace root to pass in `LocalAgentOptions.dirs`. */
  root: string;
  /** Skill directory names materialized under `<root>/.agents/skills`. */
  skillNames: string[];
  /** True when this call rewrote the tree; false when the stamp still matched. */
  refreshed: boolean;
};

export type CursorAgentSkillShimOutcome =
  | ({ ok: true } & CursorAgentSkillShim)
  | { ok: false; reason: string };

type DiscoveredSkill = { name: string; dir: string };

type StampFile = { version?: number; hash?: string; names?: unknown };

export function adeHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ADE_HOME?.trim() || path.join(os.homedir(), ".ade");
}

/**
 * `<adeHome>/agent-skill-shims/cursor/<lane-key>`.
 *
 * Keyed per lane, not one shared root: two Cursor chats can be mid-launch at
 * once, and a rebuild does `rmSync(skillsDir, { recursive: true })` before it
 * re-copies. A shared root let one launch delete the tree another live session
 * had just been handed — on Windows an open handle makes that `rmSync` throw
 * `EPERM`, degrading a launch that should have worked. Same rule and same
 * `pathKey` input as `qwenAdeSkillDefaultsPath`.
 */
export function cursorAgentSkillShimRoot(args: {
  env?: NodeJS.ProcessEnv;
  laneWorktreePath: string;
}): string {
  const env = args.env ?? process.env;
  const key = crypto
    .createHash("sha256")
    .update(pathKey(path.resolve(args.laneWorktreePath)))
    .digest("hex")
    .slice(0, 16);
  return path.join(adeHomeDir(env), "agent-skill-shims", "cursor", key);
}

export function cursorAgentSkillShimSkillsDir(shimRoot: string): string {
  return path.join(shimRoot, ...SHIM_SKILLS_SEGMENTS);
}

/**
 * The skill directories Cursor can load, in catalog order, first name winning.
 *
 * A candidate must be a real directory holding a real `SKILL.md`; anything else
 * would materialize into a root Cursor silently skips.
 */
function discoverSkills(roots: readonly string[]): DiscoveredSkill[] {
  const byName = new Map<string, DiscoveredSkill>();
  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = entry.name;
      // `.claude-plugin` and other dotted siblings are packaging metadata, not
      // skills, and a dotted directory is pruned by Cursor's own scan anyway.
      if (name.startsWith(".")) continue;
      if (byName.has(name)) continue;
      const dir = path.join(root, name);
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
        if (!fs.statSync(path.join(dir, "SKILL.md")).isFile()) continue;
      } catch {
        continue;
      }
      byName.set(name, { name, dir });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function hashSkillDir(hash: crypto.Hash, dir: string, relative: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    hash.update(`unreadable\0${relative}\0`);
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    let stat: fs.Stats;
    try {
      // `statSync`, not `lstatSync`: the copy dereferences, so the hash has to
      // describe what lands in the shim, not the link that produced it.
      stat = fs.statSync(full);
    } catch {
      hash.update(`missing\0${childRelative}\0`);
      continue;
    }
    if (stat.isDirectory()) {
      hash.update(`dir\0${childRelative}\0`);
      hashSkillDir(hash, full, childRelative);
      continue;
    }
    if (!stat.isFile()) continue;
    hash.update(`file\0${childRelative}\0`);
    try {
      hash.update(fs.readFileSync(full));
    } catch {
      hash.update("unreadable");
    }
    hash.update("\0");
  }
}

function hashSkills(skills: readonly DiscoveredSkill[]): string {
  const hash = crypto.createHash("sha256");
  hash.update(`v${SHIM_STAMP_VERSION}\0`);
  for (const skill of skills) {
    hash.update(`skill\0${skill.name}\0`);
    hashSkillDir(hash, skill.dir, "");
  }
  return hash.digest("hex");
}

function readStamp(stampPath: string): StampFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(stampPath, "utf8")) as StampFile;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stampMatches(stamp: StampFile | null, hash: string, skills: readonly DiscoveredSkill[], skillsDir: string): boolean {
  if (!stamp || stamp.version !== SHIM_STAMP_VERSION || stamp.hash !== hash) return false;
  const names = Array.isArray(stamp.names) ? stamp.names : null;
  if (!names || names.length !== skills.length) return false;
  for (const skill of skills) {
    if (!names.includes(skill.name)) return false;
    // A matching stamp over a tree someone deleted underneath us is not a
    // reason to hand Cursor an empty root.
    try {
      if (!fs.statSync(path.join(skillsDir, skill.name, "SKILL.md")).isFile()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Materialize the bundled skills into the shim root and return the root to pass
 * as an extra Cursor workspace dir.
 *
 * Never throws: a shim ADE cannot write is a degraded chat launch, not a failed
 * one. The caller logs `reason` and falls back to the env var plus prompt
 * pointer it shipped before this existed.
 */
export function prepareCursorAgentSkillShim(args: {
  skillRoots: readonly string[];
  shimRoot: string;
}): CursorAgentSkillShimOutcome {
  try {
    const skills = discoverSkills(args.skillRoots);
    if (!skills.length) return { ok: false, reason: "no_bundled_skills" };

    const skillsDir = cursorAgentSkillShimSkillsDir(args.shimRoot);
    const stampPath = path.join(args.shimRoot, SHIM_STAMP_FILE);
    const hash = hashSkills(skills);
    const skillNames = skills.map((skill) => skill.name);

    if (stampMatches(readStamp(stampPath), hash, skills, skillsDir)) {
      return { ok: true, root: args.shimRoot, skillNames, refreshed: false };
    }

    // The stamp is written last, so an interrupted rebuild leaves a stale or
    // absent stamp and the next launch redoes the copy rather than advertising
    // a half-written tree.
    fs.rmSync(stampPath, { force: true });
    fs.rmSync(skillsDir, { recursive: true, force: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    for (const skill of skills) {
      fs.cpSync(skill.dir, path.join(skillsDir, skill.name), {
        recursive: true,
        // Resolve links at copy time: Cursor drops any skill whose realpath
        // escapes the roots it was given, and Windows cannot recreate them.
        dereference: true,
      });
    }
    fs.writeFileSync(
      stampPath,
      `${JSON.stringify({ version: SHIM_STAMP_VERSION, hash, names: skillNames }, null, 2)}\n`,
    );
    return { ok: true, root: args.shimRoot, skillNames, refreshed: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export type CursorAgentSkillDirsDecision = {
  /** Value for `LocalAgentOptions.dirs`. Empty when nothing is delivered. */
  dirs: string[];
  delivered: boolean;
  /** Count of ADE skill roots considered, for `agent_chat.skill_delivery`. */
  rootCount: number;
  skillCount: number;
  refreshed: boolean;
  reason?: string;
};

/**
 * Whether Cursor will actually load project-layer extensibility for a session.
 *
 * `LocalAgentOptions.dirs` only reaches the skill walker when the SDK resolves
 * `includeProjectExtensibility` true, and it derives that from
 * `local.settingSources` containing `project` (or `all`). Orchestration leads
 * run on `["user","team","mdm"]` (`cursorSdkSettingSources`), so handing them
 * `dirs` would materialize a shim that Cursor then ignores.
 */
export function cursorLoadsProjectSkills(settingSources: readonly string[]): boolean {
  return settingSources.includes("all") || settingSources.includes("project");
}

/**
 * The full decision for one Cursor chat launch: who gets ADE's bundled skills
 * through Cursor's native discovery, and what `dirs` to pass.
 *
 * Never throws. Every "no" carries a `reason` so a chat that silently loses its
 * skills is visible in `agent_chat.skill_delivery` instead of being inferred
 * from transcripts.
 */
export function resolveCursorAgentSkillDirs(args: {
  personalSession: boolean;
  settingSources: readonly string[];
  skillRoots: readonly string[];
  shimRoot: string;
}): CursorAgentSkillDirsDecision {
  const base = { dirs: [] as string[], delivered: false, rootCount: args.skillRoots.length, skillCount: 0, refreshed: false };
  // A personal chat has no project, lane, or repository identity; ADE's skills
  // are all project work tools. Same rule Codex runs (`agentSkillRoots`).
  if (args.personalSession) return { ...base, reason: "personal_session" };
  if (!cursorLoadsProjectSkills(args.settingSources)) {
    return { ...base, reason: "project_setting_source_disabled" };
  }
  if (!args.skillRoots.length) return { ...base, reason: "no_existing_roots" };

  const outcome = prepareCursorAgentSkillShim({ skillRoots: args.skillRoots, shimRoot: args.shimRoot });
  if (!outcome.ok) return { ...base, reason: outcome.reason };
  return {
    dirs: [outcome.root],
    delivered: true,
    rootCount: args.skillRoots.length,
    skillCount: outcome.skillNames.length,
    refreshed: outcome.refreshed,
  };
}
