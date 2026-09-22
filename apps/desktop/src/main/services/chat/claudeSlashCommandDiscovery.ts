import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentSkillRootCandidates } from "../../../shared/agentSkillRoots";
import { isPathInside, pathKey } from "../shared/pathCompare";
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
  /** False when the skill declares `disable-model-invocation`; see the base type. */
  modelInvocable: boolean;
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

/**
 * The command and skill roots Claude Code finds without ADE's help.
 *
 * Verified against the shipped `claude` binary: its discovery loop walks up
 * from the project directory joining `(dir, ".claude", "skills")`, and also
 * reads `~/.claude/skills`. It does NOT read `.agents/skills`, `.codex/skills`,
 * `.cursor/skills`, or `.ade/skills` — those are the roots ADE must inject.
 *
 * Skills that ADE registers as a local plugin are native too, under a
 * `plugin:skill` name, so listing them again presents one skill under two
 * names and invites the model to believe there are two.
 */
export function claudeNativeSlashCommandRoots(
  cwd: string,
  pluginRoots: readonly string[] = [],
  home: string = os.homedir(),
): { commandRoots: string[]; skillRoots: string[] } {
  // Deliberately only the session directory and the home directory, not ADE's
  // full ancestor walk. Claude Code stops walking at ITS project root, and
  // reproducing that boundary here would mean reproducing its git logic. Under-
  // filtering leaves a duplicate; over-filtering hides a skill the model then
  // never learns exists, so the conservative direction is the correct one.
  const configRoots = [path.resolve(cwd, ".claude"), path.resolve(home, ".claude")];
  return {
    commandRoots: configRoots.map((root) => path.join(root, "commands")),
    skillRoots: [
      ...configRoots.map((root) => path.join(root, "skills")),
      ...pluginRoots.map((root) => path.resolve(root)),
    ],
  };
}

export type ClaudeSlashCommandInjectionPlan = {
  commands: DiscoveredClaudeSlashCommand[];
  skills: DiscoveredClaudeSlashCommand[];
  nativeCount: number;
};

/**
 * Drops everything Claude Code already lists for itself.
 *
 * Before this filter, 52 of the 83 entries ADE injected on a developer machine
 * were verbatim repeats of Claude's own listing, including all 12 bundled ADE
 * skills, which appeared once as `ade:<name>` from the plugin and again by
 * path. The listing is the largest single block ADE adds to the system prompt,
 * so the repeat was also the largest avoidable cost in it.
 */
export function planClaudeSlashCommandInjection(
  commands: readonly DiscoveredClaudeSlashCommand[],
  options: { cwd: string; pluginRoots?: readonly string[]; home?: string },
): ClaudeSlashCommandInjectionPlan {
  const native = claudeNativeSlashCommandRoots(
    options.cwd,
    options.pluginRoots ?? [],
    options.home ?? os.homedir(),
  );
  const isNative = (entry: DiscoveredClaudeSlashCommand): boolean => {
    const roots = entry.source === "command" ? native.commandRoots : native.skillRoots;
    return roots.some((root) => isPathInside(entry.filePath, root));
  };

  const plan: ClaudeSlashCommandInjectionPlan = { commands: [], skills: [], nativeCount: 0 };
  for (const entry of commands) {
    if (isNative(entry)) {
      plan.nativeCount += 1;
      continue;
    }
    (entry.source === "command" ? plan.commands : plan.skills).push(entry);
  }
  return plan;
}

/**
 * Per-entry description cap for the injected listing.
 *
 * Matches the Claude Agent SDK's own `skillListingMaxDescChars` default, so an
 * ADE-injected entry cannot be more verbose than the same entry in Claude's
 * native listing.
 */
export const CLAUDE_SKILL_LISTING_MAX_DESC_CHARS = 1536;

/**
 * Total byte budget for the injected listing.
 *
 * ADE's listing had no budget at all, so one user's skill collection decided
 * how much of every session's system prompt it consumed. Both Claude Code (1%
 * of the context window) and Codex (2%, hard-capped) enforce one and degrade in
 * stages. ADE's listing is supplementary — Claude still has its own — so the
 * budget is deliberately modest, and what does not fit is reported rather than
 * dropped in silence.
 */
export const CLAUDE_SKILL_LISTING_BUDGET_BYTES = 16 * 1024;

export function formatClaudeSlashCommandEntry(entry: DiscoveredClaudeSlashCommand): string {
  const description = entry.description.trim();
  const clipped = description.length > CLAUDE_SKILL_LISTING_MAX_DESC_CHARS
    ? `${description.slice(0, CLAUDE_SKILL_LISTING_MAX_DESC_CHARS - 1).trimEnd()}…`
    : description;
  const head = clipped.length ? `- ${entry.name} — ${clipped}` : `- ${entry.name}`;
  return `${head}\n  file: ${entry.filePath}`;
}

/**
 * Renders entries newest-budget-first, returning what did not fit so the caller
 * can say so in the prompt instead of hiding it.
 */
export function renderClaudeSlashCommandEntries(
  entries: readonly DiscoveredClaudeSlashCommand[],
  budgetBytes: number = CLAUDE_SKILL_LISTING_BUDGET_BYTES,
): { lines: string[]; omitted: number } {
  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const entry of entries) {
    const rendered = formatClaudeSlashCommandEntry(entry);
    const cost = Buffer.byteLength(rendered, "utf8") + 1;
    if (lines.length && used + cost > budgetBytes) {
      omitted += 1;
      continue;
    }
    lines.push(rendered);
    used += cost;
  }
  return { lines, omitted };
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
