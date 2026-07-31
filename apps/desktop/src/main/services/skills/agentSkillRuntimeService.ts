import fs from "node:fs";
import path from "node:path";
import {
  ADE_AGENT_SKILLS_DIRS_ENV,
  splitAdeAgentSkillRoots,
} from "../../../shared/agentSkillRoots";

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

export function claudeAgentSkillPluginRoots(env: NodeJS.ProcessEnv): string[] {
  return existingAgentSkillRoots(env).filter((root) =>
    fs.existsSync(path.join(root, ".claude-plugin", "plugin.json"))
  );
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
