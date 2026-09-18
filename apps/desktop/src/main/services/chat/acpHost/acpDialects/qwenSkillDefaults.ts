import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAdeLayout } from "../../../../../shared/adeLayout";
import { pathKey } from "../../../shared/pathCompare";
import { existingAgentSkillRoots } from "../../../skills/agentSkillRuntimeService";

/**
 * ADE's bundled agent skills, delivered to Qwen Code through Qwen's OWN
 * discovery instead of a path mentioned in prose.
 *
 * Verified against the installed `@qwen-code/qwen-code` 0.22.3 bundle:
 *
 * - `skills.directories` is a real settings key. Its schema entry
 *   (`chunk-ZEYFMJQA.js`) reads "Additional directories to scan for skills
 *   (SKILL.md files). Entries should be absolute paths or ~-prefixed ... Each
 *   directory is scanned one level deep for subdirectories containing a
 *   SKILL.md file", with `mergeStrategy: "union"` and `requiresRestart: true`.
 *   ADE's bundled layout is already `<root>/<skill-name>/SKILL.md`.
 * - The value reaches the agent as `config.customSkillDirs`
 *   (`chunk-DJPASAUV.js`) and is appended to the **user**-level skill base dirs
 *   in `SkillManager.getSkillsBaseDirs` (`chunk-PZ66FRIC.js`). Because the
 *   append happens after the defaults, a bundled skill can never displace a
 *   same-named skill the user already has.
 * - `getSystemDefaultsPath()` (`chunk-IDS7MSUP.js`) returns
 *   `process.env["QWEN_CODE_SYSTEM_DEFAULTS_PATH"]` when set, so ADE can supply
 *   settings WITHOUT writing the user's `~/.qwen`. The union merge means ADE's
 *   entries add to the user's `skills.directories` rather than replacing them,
 *   and the system-defaults tier is the LOWEST precedence, so nothing else ADE
 *   puts in that file could outrank a choice the user made.
 *
 * THE RULE (docs/features/agents/README.md): ADE never writes into a provider's
 * own config home, and never installs bundled skills into a user-global skill
 * directory. `QWEN_HOME` for a normal launch resolves to the user's `~/.qwen`
 * (see `providerConfigHomes.ts`), so the file ADE writes lives under ADE's own
 * machine-local `.ade/cache`, exactly like the OpenCode instruction file.
 * The lane worktree is the user's repository — an ADE-authored JSON file in
 * their `git status` is not something a launch should do — and the system temp
 * directory is world-writable on Linux, where a stable path derived from public
 * inputs can be pre-created as a symlink and turn an ADE launch into a write
 * through that link.
 */

/** Qwen reads its system-defaults settings file from this path when set. */
export const QWEN_SYSTEM_DEFAULTS_PATH_ENV = "QWEN_CODE_SYSTEM_DEFAULTS_PATH";

/** Qwen's system *settings* override; its directory is where defaults default to. */
export const QWEN_SYSTEM_SETTINGS_PATH_ENV = "QWEN_CODE_SYSTEM_SETTINGS_PATH";

const DEFAULTS_DIR_NAME = "qwen-skill-defaults";

export type QwenSkillDefaultsResult = {
  /** The file ADE wrote, or null when nothing was delivered. */
  path: string | null;
  /** The skill roots that reached the file. Empty when nothing was delivered. */
  roots: string[];
  /** Why nothing was delivered. Absent on success. */
  reason?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Stable per-lane path, hashed rather than slugified.
 *
 * Worktree paths routinely contain characters that are legal in a path but
 * awkward in a filename. Keyed per lane so two lanes launching at once cannot
 * interleave writes to one file. `pathKey` supplies the hash input so the same
 * directory spelled with different case on Windows or macOS keys to one file
 * rather than two.
 */
export function qwenAdeSkillDefaultsPath(args: {
  projectRoot: string;
  laneWorktreePath: string;
}): string {
  const key = createHash("sha256")
    .update(pathKey(path.resolve(args.laneWorktreePath)))
    .digest("hex")
    .slice(0, 16);
  return path.join(
    resolveAdeLayout(path.resolve(args.projectRoot)).cacheDir,
    DEFAULTS_DIR_NAME,
    `ade-${key}.json`,
  );
}

/**
 * Where Qwen would have looked for system defaults had ADE not redirected it.
 *
 * Mirrors `getSystemDefaultsPath()` in the 0.22.3 bundle. ADE reads that file
 * and layers on top of it, because pointing the env var at an ADE file would
 * otherwise silently hide an administrator-installed one.
 */
export function qwenNativeSystemDefaultsPath(env: NodeJS.ProcessEnv): string {
  const override = env[QWEN_SYSTEM_DEFAULTS_PATH_ENV]?.trim();
  if (override) return override;
  const settingsOverride = env[QWEN_SYSTEM_SETTINGS_PATH_ENV]?.trim();
  if (settingsOverride) return path.join(path.dirname(settingsOverride), "system-defaults.json");
  if (os.platform() === "darwin") {
    return path.join("/Library", "Application Support", "QwenCode", "system-defaults.json");
  }
  if (os.platform() === "win32") {
    return path.join("C:\\ProgramData", "qwen-code", "system-defaults.json");
  }
  return path.join("/etc", "qwen-code", "system-defaults.json");
}

function readJsonObject(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The settings object ADE writes.
 *
 * `base` is whatever Qwen's own system-defaults file held, so redirecting the
 * env var adds ADE's roots instead of erasing an existing system tier.
 */
export function buildQwenAdeSkillDefaults(args: {
  roots: readonly string[];
  base?: Record<string, unknown>;
}): Record<string, unknown> {
  const base = args.base ?? {};
  const baseSkills = isRecord(base.skills) ? base.skills : {};
  const baseDirs = Array.isArray(baseSkills.directories)
    ? baseSkills.directories.filter((entry): entry is string => typeof entry === "string")
    : [];
  const directories: string[] = [];
  const seen = new Set<string>();
  for (const entry of [...baseDirs, ...args.roots]) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const key = pathKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    directories.push(trimmed);
  }
  return { ...base, skills: { ...baseSkills, directories } };
}

/**
 * Write the ADE-owned system-defaults file for a Qwen launch, and report what
 * happened so the caller can log one delivery line.
 *
 * A personal chat deliberately gets none — ADE capabilities are not part of
 * that surface. Roots are filtered against the disk by
 * `existingAgentSkillRoots`, because a directory that does not exist is a
 * directory Qwen would scan and silently find nothing in.
 *
 * Never throws. A failed write means the launch proceeds without ADE's skills,
 * which is strictly better than failing the launch outright; the reason travels
 * back so it is visible in the log rather than silent.
 */
export function ensureQwenAdeSkillDefaultsFile(args: {
  projectRoot: string | null | undefined;
  laneWorktreePath: string | null | undefined;
  env: NodeJS.ProcessEnv;
  personalSession: boolean;
}): QwenSkillDefaultsResult {
  if (args.personalSession) return { path: null, roots: [], reason: "personal_session" };
  const projectRoot = args.projectRoot?.trim();
  const laneWorktreePath = args.laneWorktreePath?.trim();
  if (!projectRoot || !laneWorktreePath) {
    return { path: null, roots: [], reason: "no_project_root" };
  }
  const roots = existingAgentSkillRoots(args.env);
  if (!roots.length) return { path: null, roots: [], reason: "no_existing_roots" };

  const target = qwenAdeSkillDefaultsPath({ projectRoot, laneWorktreePath });
  // A previous ADE launch may already have exported the env var into this
  // process's environment. Reading our own output back as the base would make
  // the merge depend on launch history instead of on the machine's real
  // configuration, so the self-reference is dropped.
  const nativeDefaults = qwenNativeSystemDefaultsPath(args.env);
  const base = pathKey(path.resolve(nativeDefaults)) === pathKey(target)
    ? {}
    : readJsonObject(nativeDefaults);

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      target,
      `${JSON.stringify(buildQwenAdeSkillDefaults({ roots, base }), null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return { path: target, roots };
  } catch (error) {
    return {
      path: null,
      roots,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
