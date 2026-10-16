import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ADE_AGENT_SKILLS_DIRS_ENV,
  ADE_BUNDLED_AGENT_SKILLS_DIR_ENV,
  getAdeAgentSkillRootsForPrompt,
  joinAdeAgentSkillRoots,
  splitAdeAgentSkillRoots,
} from "../../../shared/agentSkillRoots";
import { adeHomeDir } from "./cursorAgentSkillShim";

export type RuntimeAgentSkill = {
  name?: string;
  description?: string;
};

export type CodexSkillsListResponse = {
  skills?: RuntimeAgentSkill[];
  data?: Array<{ cwd?: string; skills?: RuntimeAgentSkill[] }>;
};

export function agentSkillRootExists(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

export function existingAgentSkillRoots(env: NodeJS.ProcessEnv): string[] {
  return splitAdeAgentSkillRoots(env[ADE_AGENT_SKILLS_DIRS_ENV]).filter(agentSkillRootExists);
}

/**
 * The prompt- and env-facing bundled skill roots, filtered against the disk.
 *
 * Every Node-side caller uses this instead of the shared helper. The shared
 * helper cannot stat, because the renderer bundles it, so a caller that skips
 * this wrapper advertises roots that may not exist.
 */
export function adePromptAgentSkillRoots(options: {
  env?: NodeJS.ProcessEnv;
  resourcesPath?: string | null;
  cwd?: string | null;
} = {}): string[] {
  return getAdeAgentSkillRootsForPrompt({ ...options, exists: agentSkillRootExists });
}

/**
 * `<adeHome>/agent-skill-shims/filtered`: the filtered mirrors' parent.
 *
 * Under the user's ADE home, never the shared temp dir: a mirror is loaded as
 * a Claude plugin (hooks included), so a predictable path another local user
 * could pre-create would hand them code execution in every chat.
 */
export function filteredAgentSkillMirrorParent(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(adeHomeDir(env), "agent-skill-shims", "filtered");
}

/**
 * Creates `dir` owner-only, or proves an existing one is a real directory this
 * user owns, and tightens it to 0700. Throws otherwise. Windows has no POSIX
 * owner or mode here; the ADE home under the user profile is already private.
 */
function ensurePrivateMirrorParent(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Skill mirror parent is not a directory: ${dir}`);
  }
  if (process.platform === "win32") return;
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Skill mirror parent is owned by another user: ${dir}`);
  }
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

/** Mirror path per (canonical root, withheld set), so one process copies a root once. */
const filteredSkillRootMirrors = new Map<string, string>();

/**
 * The same skill roots with some skills withheld.
 *
 * A skill root is a directory of `<name>/SKILL.md` folders, and every provider
 * discovers whole roots — none of them takes a per-skill deny list. So a root
 * that holds a withheld skill is replaced by a private mirror that holds
 * everything else, `.claude-plugin/plugin.json` included, so the mirror is
 * still a valid Claude plugin. A root with nothing to withhold is returned as
 * is. The mirror is rebuilt once per process (the bundled catalog changes only
 * with ADE itself) and lives under the user's ADE home (owner-only), outside
 * any chat's cwd.
 *
 * A root that cannot be read or copied is returned unfiltered rather than
 * dropped: an extra skill the agent may not need costs less than no skills.
 */
export function withoutAgentSkills(
  roots: readonly string[],
  withheld: readonly string[],
  mirrorParent: string = filteredAgentSkillMirrorParent(),
): string[] {
  if (!withheld.length) return [...roots];
  const withheldSet = new Set(withheld);
  const withheldKey = [...withheldSet].sort().join(",");
  return roots.map((root) => {
    let staging: string | null = null;
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      if (!entries.some((entry) => withheldSet.has(entry.name))) return root;
      const canonical = fs.realpathSync(root);
      const key = `${canonical}\0${withheldKey}`;
      const cached = filteredSkillRootMirrors.get(key);
      if (cached && agentSkillRootExists(cached)) return cached;
      const mirror = path.join(mirrorParent, createHash("sha256").update(key).digest("hex").slice(0, 16));
      staging = `${mirror}.${process.pid}.${Date.now()}.tmp`;
      ensurePrivateMirrorParent(mirrorParent);
      fs.cpSync(canonical, staging, {
        recursive: true,
        filter: (source) => !withheldSet.has(path.relative(canonical, source).split(path.sep)[0] ?? ""),
      });
      fs.rmSync(mirror, { recursive: true, force: true });
      fs.renameSync(staging, mirror);
      staging = null;
      filteredSkillRootMirrors.set(key, mirror);
      return mirror;
    } catch {
      if (staging) {
        try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      return root;
    }
  });
}

/**
 * An agent environment whose skill-root variables name {@link withoutAgentSkills}
 * mirrors, so every launch path that reads them (Claude's plugin root, Codex,
 * Cursor, OpenCode, Qwen, Pi, `ade skill list`) sees the same reduced catalog.
 */
export function withoutAgentSkillsEnv(
  env: NodeJS.ProcessEnv,
  withheld: readonly string[],
): NodeJS.ProcessEnv {
  const roots = splitAdeAgentSkillRoots(env[ADE_AGENT_SKILLS_DIRS_ENV]);
  const bundled = env[ADE_BUNDLED_AGENT_SKILLS_DIR_ENV]?.trim();
  if (!roots.length && !bundled) return env;
  const next: NodeJS.ProcessEnv = { ...env };
  if (roots.length) next[ADE_AGENT_SKILLS_DIRS_ENV] = joinAdeAgentSkillRoots(withoutAgentSkills(roots, withheld));
  if (bundled) next[ADE_BUNDLED_AGENT_SKILLS_DIR_ENV] = withoutAgentSkills([bundled], withheld)[0];
  return next;
}

export function claudeAgentSkillPluginRoots(env: NodeJS.ProcessEnv): string[] {
  const trustedRoot = env[ADE_BUNDLED_AGENT_SKILLS_DIR_ENV]?.trim();
  if (!trustedRoot) return [];

  try {
    const canonicalTrustedRoot = fs.realpathSync(trustedRoot);
    if (!fs.statSync(canonicalTrustedRoot).isDirectory()) return [];
    if (!fs.statSync(path.join(canonicalTrustedRoot, ".claude-plugin", "plugin.json")).isFile()) {
      return [];
    }

    const isCatalogRoot = existingAgentSkillRoots(env).some((root) => {
      try {
        return fs.realpathSync(root) === canonicalTrustedRoot;
      } catch {
        return false;
      }
    });
    return isCatalogRoot ? [canonicalTrustedRoot] : [];
  } catch {
    return [];
  }
}

export function codexSkillsListParams(cwd: string, extraUserRoots: readonly string[]) {
  return {
    cwds: [cwd],
    forceReload: true,
    ...(extraUserRoots.length
      ? { perCwdExtraUserRoots: [{ cwd, extraUserRoots }] }
      : {}),
  };
}

export function codexSkillsForCwd(
  response: CodexSkillsListResponse,
  cwd: string,
): RuntimeAgentSkill[] {
  if (!Array.isArray(response.data)) {
    return Array.isArray(response.skills) ? response.skills : [];
  }
  const matchingEntry = response.data.find((entry) => entry.cwd === cwd);
  const legacySingleEntry = response.data.length === 1 && response.data[0]?.cwd == null
    ? response.data[0]
    : undefined;
  const skills = matchingEntry?.skills ?? legacySingleEntry?.skills;
  return Array.isArray(skills) ? skills : [];
}

export function agentSkillSlashCommands(
  skills: readonly RuntimeAgentSkill[],
): Array<{ name: string; description: string }> {
  return skills
    .filter((skill): skill is { name: string; description?: string } =>
      typeof skill?.name === "string" && skill.name.length > 0
    )
    .map((skill) => ({
      name: skill.name.startsWith("/") ? skill.name : `/${skill.name}`,
      description: skill.description ?? "",
    }));
}
