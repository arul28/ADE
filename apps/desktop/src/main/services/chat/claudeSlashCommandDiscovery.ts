import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentSkillRootCandidates } from "../../../shared/agentSkillRoots";
import { pathKey } from "../shared/pathCompare";
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

/**
 * Discovery walks every `commands` and skill root above `cwd` and reads each
 * markdown file. Measured on a real project: 2,760 files, 22.7MB, 579-1119ms
 * per call — and it is called several times per turn (dispatchable commands,
 * the palette list, project commands) with no caching at all. On Windows that
 * lands on the single-threaded runtime that also owns the sync socket, so it
 * delays phone-originated messages, not just the local UI.
 *
 * A short TTL rather than mtime checking: detecting a change means walking the
 * tree, which is the expensive part. The window is small enough that a command
 * file someone just edited shows up on the next turn.
 */
const DISCOVERY_TTL_MS = 5_000;
const discoveryCache = new Map<string, { at: number; value: DiscoveredClaudeSlashCommand[] }>();

/**
 * Drop the memo. Only the tests use this — nothing in the app writes a command
 * file, so there is no production caller that has to beat the TTL.
 */
export function invalidateClaudeSlashCommandCache(): void {
  discoveryCache.clear();
}

export function discoverClaudeSlashCommands(cwd: string): DiscoveredClaudeSlashCommand[] {
  // Keyed on `pathKey`, not the raw cwd: `C:\proj` and `c:\proj` are the same
  // project, and keying on the spelling gives each of them its own entry and
  // its own full walk — the miss this memo exists to prevent.
  const key = pathKey(cwd);
  const now = Date.now();
  const cached = discoveryCache.get(key);
  if (cached && now - cached.at < DISCOVERY_TTL_MS) return cached.value.slice();
  // Nothing else ever removes an entry, so every cwd asked about once would
  // hold a full command list (22.7MB of files' worth of metadata) for the
  // process lifetime. A miss is already the slow path; sweep there.
  for (const [entryKey, entry] of discoveryCache) {
    if (now - entry.at >= DISCOVERY_TTL_MS) discoveryCache.delete(entryKey);
  }
  const value = discoverClaudeSlashCommandsUncached(cwd);
  discoveryCache.set(key, { at: Date.now(), value });
  // Callers mutate the array (filter/map chains are fine, but nothing stops a
  // sort in place), so never hand out the cached instance itself.
  return value.slice();
}

function discoverClaudeSlashCommandsUncached(cwd: string): DiscoveredClaudeSlashCommand[] {
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
