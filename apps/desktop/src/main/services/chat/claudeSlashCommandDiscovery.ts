import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentSkillRootCandidates } from "../../../shared/agentSkillRoots";
import {
  ancestorConfigRoots,
  discoverMarkdownCommandFiles,
  discoverSkillCommands,
  parseSlashCommandInput,
  resolveMarkdownCommandFile,
  resolveMarkdownSlashCommandFromFile,
  resolveSkillCommandFile,
  slashCommandKey,
} from "./markdownSlashCommandDiscovery";

export type DiscoveredClaudeSlashCommand = {
  name: string;
  description: string;
  argumentHint?: string;
  source: "command" | "skill";
  filePath: string;
};

export type ResolvedClaudeSlashCommandInvocation = {
  name: string;
  promptText: string;
  argumentsText: string;
};

const moduleDir =
  typeof __dirname === "string"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

function claudeRootsByPrecedence(cwd: string): string[] {
  return ancestorConfigRoots(cwd, ".claude");
}

function skillRootsByPrecedence(cwd: string): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const addRoot = (root: string): void => {
    const resolved = path.resolve(root);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    roots.push(resolved);
  };

  for (const root of getAgentSkillRootCandidates({
    cwd,
    dirname: moduleDir,
    home: os.homedir(),
    includeDeepSourceFallbacks: true,
  })) addRoot(root);
  return roots;
}

export function discoverClaudeSlashCommands(cwd: string): DiscoveredClaudeSlashCommand[] {
  const byName = new Map<string, DiscoveredClaudeSlashCommand>();

  for (const root of claudeRootsByPrecedence(cwd)) {
    for (const command of discoverMarkdownCommandFiles(path.join(root, "commands"))) {
      const key = slashCommandKey(command.name);
      if (!byName.has(key)) {
        byName.set(key, { ...command, source: "command" });
      }
    }
  }
  for (const root of skillRootsByPrecedence(cwd)) {
    for (const command of discoverSkillCommands(root)) {
      const key = slashCommandKey(command.name);
      if (!byName.has(key)) {
        byName.set(key, { ...command, source: "skill" });
      }
    }
  }

  return [...byName.values()].sort((a, b) => {
    if (a.source !== b.source) return a.source === "command" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

export function resolveClaudeSlashCommandInvocation(
  cwd: string,
  input: string,
): ResolvedClaudeSlashCommandInvocation | null {
  const parsed = parseSlashCommandInput(input);
  if (!parsed) return null;
  const { name, argumentsText } = parsed;

  let resolvedFile: string | null = null;
  for (const root of claudeRootsByPrecedence(cwd)) {
    resolvedFile = resolveMarkdownCommandFile(path.join(root, "commands"), name);
    if (resolvedFile) break;
  }
  if (!resolvedFile) {
    for (const root of skillRootsByPrecedence(cwd)) {
      resolvedFile = resolveSkillCommandFile(root, name);
      if (resolvedFile) break;
    }
  }
  if (!resolvedFile) return null;

  return resolveMarkdownSlashCommandFromFile(resolvedFile, name, argumentsText);
}
