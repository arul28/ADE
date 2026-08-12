import fs from "node:fs";
import path from "node:path";
import {
  ADE_AGENT_SKILLS_DIRS_ENV,
  ADE_BUNDLED_AGENT_SKILLS_DIR_ENV,
  splitAdeAgentSkillRoots,
} from "../../../shared/agentSkillRoots";
import { listPluginAgentSkillRoots } from "../plugins/pluginInstallService";

export type RuntimeAgentSkill = {
  name?: string;
  description?: string;
};

export type CodexSkillsListResponse = {
  skills?: RuntimeAgentSkill[];
  data?: Array<{ cwd?: string; skills?: RuntimeAgentSkill[] }>;
};

export function existingAgentSkillRoots(env: NodeJS.ProcessEnv): string[] {
  return splitAdeAgentSkillRoots(env[ADE_AGENT_SKILLS_DIRS_ENV]).filter((root) => {
    try {
      return fs.statSync(root).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * Claude does not read `ADE_AGENT_SKILLS_DIRS`. It loads skills through
 * `--plugin-dir` / the SDK's `plugins` option, so a catalogue root only reaches
 * Claude if it is handed over as a Claude plugin — which is why the bundled root
 * carries a `.claude-plugin/plugin.json` marker.
 *
 * A plugin directory can also carry hooks, commands and agents, so WHICH roots
 * are eligible is a trust decision, not a convenience. Two are:
 *
 * - ADE's own bundled root, named by `ADE_BUNDLED_AGENT_SKILLS_DIR` and shipped
 *   inside the signed app.
 * - The skill roots of plugins the user has INSTALLED and enabled, which the
 *   registry answers for ({@link listPluginAgentSkillRoots}). An installed
 *   plugin may already ship an `entry` ADE runs in a child process, so this
 *   grants nothing the install did not.
 *
 * What is deliberately NOT eligible is the rest of `ADE_AGENT_SKILLS_DIRS`: it
 * contains cwd-derived roots, so honouring a marker found there would let a
 * cloned repository hand Claude its own hooks by adding a file.
 */
export function claudeAgentSkillPluginRoots(
  env: NodeJS.ProcessEnv,
  /** Injected by tests; production reads the plugin registry. */
  options: { pluginSkillRoots?: readonly string[] } = {},
): string[] {
  const envRoots = existingAgentSkillRoots(env).flatMap((root) => {
    try {
      return [fs.realpathSync(root)];
    } catch {
      return [];
    }
  });
  const isCatalogRoot = (canonical: string): boolean => envRoots.includes(canonical);

  const roots: string[] = [];
  const trustedRoot = env[ADE_BUNDLED_AGENT_SKILLS_DIR_ENV]?.trim();
  if (trustedRoot) {
    const canonical = canonicalClaudePluginRoot(trustedRoot);
    if (canonical && isCatalogRoot(canonical)) roots.push(canonical);
  }

  const pluginSkillRoots = options.pluginSkillRoots ?? listPluginAgentSkillRoots({ env });
  for (const root of pluginSkillRoots) {
    const canonical = canonicalClaudePluginRoot(root);
    // The env check is what keeps an installed-but-disabled plugin out: the
    // launcher only writes enabled plugins' roots into the env in the first
    // place, and a root missing from it never became part of this session.
    if (!canonical || !isCatalogRoot(canonical) || roots.includes(canonical)) continue;
    roots.push(canonical);
  }
  return roots;
}

/** A directory that exists and declares itself a Claude plugin, resolved. */
function canonicalClaudePluginRoot(root: string): string | null {
  try {
    const canonical = fs.realpathSync(root);
    if (!fs.statSync(canonical).isDirectory()) return null;
    if (!fs.statSync(path.join(canonical, ".claude-plugin", "plugin.json")).isFile()) return null;
    return canonical;
  } catch {
    return null;
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
