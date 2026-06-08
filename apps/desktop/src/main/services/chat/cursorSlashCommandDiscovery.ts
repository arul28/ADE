import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentSkillRootCandidates } from "../../../shared/agentSkillRoots";
import {
  ancestorConfigRoots,
  discoverMarkdownAgentFiles,
  discoverMarkdownCommandFiles,
  discoverSkillCommands,
  parseSlashCommandInput,
  resolveMarkdownCommandFile,
  resolveMarkdownSlashCommandFromFile,
  slashCommandKey,
} from "./markdownSlashCommandDiscovery";

export type DiscoveredCursorSlashCommand = {
  name: string;
  description: string;
  argumentHint?: string;
  source: "command" | "skill" | "subagent";
  filePath?: string;
};

export type ResolvedCursorSlashCommandInvocation = {
  name: string;
  promptText: string;
  argumentsText: string;
};

// Built-in Cursor subagents and skills are listed for autocomplete but are
// handled natively by the Cursor SDK at send time. Only `.cursor/commands`
// markdown files are expanded into prompt text before dispatch.
const CURSOR_BUILT_IN_SUBAGENT_COMMANDS: DiscoveredCursorSlashCommand[] = [
  {
    name: "/explore",
    description: "Use Cursor's built-in codebase exploration subagent.",
    source: "subagent",
  },
  {
    name: "/bash",
    description: "Use Cursor's built-in shell command subagent.",
    source: "subagent",
  },
  {
    name: "/browser",
    description: "Use Cursor's built-in browser automation subagent.",
    source: "subagent",
  },
];
const moduleDir =
  typeof __dirname === "string"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

function cursorRootsByPrecedence(cwd: string): string[] {
  return ancestorConfigRoots(cwd, ".cursor");
}

function cursorSkillRootsByPrecedence(cwd: string): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const root of getAgentSkillRootCandidates({
    cwd,
    dirname: moduleDir,
    home: os.homedir(),
    includeDeepSourceFallbacks: true,
  })) {
    const resolved = path.resolve(root);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    roots.push(resolved);
  }
  return roots;
}

function sourceRank(source: DiscoveredCursorSlashCommand["source"]): number {
  switch (source) {
    case "command": return 0;
    case "subagent": return 1;
    case "skill": return 2;
  }
}

export function discoverCursorSlashCommands(cwd: string): DiscoveredCursorSlashCommand[] {
  const byName = new Map<string, DiscoveredCursorSlashCommand>();
  function add(command: DiscoveredCursorSlashCommand): void {
    const key = slashCommandKey(command.name);
    if (!byName.has(key)) byName.set(key, command);
  }

  for (const root of cursorRootsByPrecedence(cwd)) {
    for (const command of discoverMarkdownCommandFiles(path.join(root, "commands"))) {
      add({ ...command, source: "command" });
    }
    for (const command of discoverMarkdownAgentFiles(path.join(root, "agents"))) {
      add({ ...command, source: "subagent" });
    }
  }
  for (const command of CURSOR_BUILT_IN_SUBAGENT_COMMANDS) add(command);
  for (const root of cursorSkillRootsByPrecedence(cwd)) {
    for (const command of discoverSkillCommands(root)) {
      add({ ...command, source: "skill" });
    }
  }

  return [...byName.values()].sort((a, b) => {
    const rankDiff = sourceRank(a.source) - sourceRank(b.source);
    if (rankDiff !== 0) return rankDiff;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

export function resolveCursorSlashCommandInvocation(
  cwd: string,
  input: string,
): ResolvedCursorSlashCommandInvocation | null {
  const parsed = parseSlashCommandInput(input);
  if (!parsed) return null;
  const { name, argumentsText } = parsed;

  let resolvedFile: string | null = null;
  for (const root of cursorRootsByPrecedence(cwd)) {
    resolvedFile = resolveMarkdownCommandFile(path.join(root, "commands"), name, {
      uniqueBasenameFallback: false,
    });
    if (resolvedFile) break;
  }
  if (!resolvedFile) return null;

  return resolveMarkdownSlashCommandFromFile(resolvedFile, name, argumentsText);
}
