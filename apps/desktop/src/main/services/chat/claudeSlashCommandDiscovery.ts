import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentSkillRootCandidates } from "../../../shared/agentSkillRoots";
import { isPathInside, pathKey } from "../shared/pathCompare";
import {
  ancestorConfigRoots,
  discoverMarkdownCommandFiles,
  discoverMarkdownCommandFilesAsync,
  discoverSkillCommands,
  discoverSkillCommandsAsync,
  parseSlashCommandInput,
  resolveMarkdownCommandFile,
  resolveMarkdownSlashCommandFromFile,
  resolveSkillCommandFile,
  slashCommandKey,
  slashCommandNameOrder,
  type DiscoveredMarkdownSlashCommand,
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
const discoveryCache = new Map<string, { at: number; stamp: number; value: DiscoveredClaudeSlashCommand[] }>();
/** Asynchronous walks still running, by key, so concurrent asks share one walk. */
const discoveryInFlight = new Map<string, Promise<DiscoveredClaudeSlashCommand[]>>();
/** Bumped on invalidation, so a walk that started before it does not refill the cache. */
let discoveryGeneration = 0;
/**
 * Counts every memo write. An entry's `stamp` is the count at its write, so a walk
 * can tell whether its folder was written after the walk began.
 */
let discoveryWrites = 0;

function storeDiscovery(key: string, value: DiscoveredClaudeSlashCommand[]): void {
  discoveryWrites += 1;
  discoveryCache.set(key, { at: Date.now(), stamp: discoveryWrites, value });
}

/**
 * Drop the memo. Only the tests use this — nothing in the app writes a command
 * file, so there is no production caller that has to beat the TTL.
 */
export function invalidateClaudeSlashCommandCache(): void {
  discoveryCache.clear();
  discoveryInFlight.clear();
  discoveryGeneration += 1;
  for (const cache of listingCaches) cache.clear();
}

/** Memos of things built from a discovery result; dropped with it. */
const listingCaches = new Set<Map<string, unknown>>();

/**
 * A memo, on discovery's own TTL, for a listing built from a discovery
 * result: a listing that is rebuilt on every turn would otherwise stat the
 * disk again each time, for a result that cannot be newer than the discovery
 * it was built from. `invalidateClaudeSlashCommandCache` clears it too.
 */
export function createSlashCommandListingCache<V>(): (key: string, build: () => V) => V {
  const cache = new Map<string, { at: number; value: V }>();
  listingCaches.add(cache);
  return (key, build) => {
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && now - cached.at < DISCOVERY_TTL_MS) return cached.value;
    for (const [entryKey, entry] of cache) {
      if (now - entry.at >= DISCOVERY_TTL_MS) cache.delete(entryKey);
    }
    const value = build();
    cache.set(key, { at: Date.now(), value });
    return value;
  };
}

/** Drops the entries whose TTL has run out; the walk that misses is the slow path, so sweep there. */
function sweepExpiredDiscovery(now: number): void {
  for (const [entryKey, entry] of discoveryCache) {
    if (now - entry.at >= DISCOVERY_TTL_MS) discoveryCache.delete(entryKey);
  }
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
  // process lifetime.
  sweepExpiredDiscovery(now);
  const value = discoverClaudeSlashCommandsUncached(cwd);
  storeDiscovery(key, value);
  // Callers mutate the array (filter/map chains are fine, but nothing stops a
  // sort in place), so never hand out the cached instance itself.
  return value.slice();
}

/**
 * The same list as `discoverClaudeSlashCommands`, from a walk that yields to the
 * event loop between folders and files. `chat.getSlashCommands` uses this: a
 * synchronous walk on a miss stalls every other RPC the brain is serving for as
 * long as it runs. It shares the memo, the TTL and the key with the synchronous
 * call, and a second ask while a walk is running waits for that walk.
 */
export async function discoverClaudeSlashCommandsAsync(cwd: string): Promise<DiscoveredClaudeSlashCommand[]> {
  const key = pathKey(cwd);
  const cached = discoveryCache.get(key);
  if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.value.slice();
  let walk = discoveryInFlight.get(key);
  if (!walk) {
    const generation = discoveryGeneration;
    const startedStamp = discoveryWrites;
    sweepExpiredDiscovery(Date.now());
    const started: Promise<DiscoveredClaudeSlashCommand[]> = discoverClaudeSlashCommandsUncachedAsync(cwd)
      .then((value) => {
        // A walk can finish after a newer listing for this folder was stored (a
        // sync walk, say), and its own listing may be the older one. Keep the newer entry.
        const stored = discoveryCache.get(key);
        const storedSinceStart = stored !== undefined && stored.stamp > startedStamp;
        if (generation === discoveryGeneration && !storedSinceStart) storeDiscovery(key, value);
        return value;
      })
      .finally(() => {
        if (discoveryInFlight.get(key) === started) discoveryInFlight.delete(key);
      });
    discoveryInFlight.set(key, started);
    walk = started;
  }
  return (await walk).slice();
}

function discoverClaudeSlashCommandsUncached(cwd: string): DiscoveredClaudeSlashCommand[] {
  return mergeClaudeSlashCommands(
    claudeRootsByPrecedence(cwd).map((root) => discoverMarkdownCommandFiles(path.join(root, "commands"))),
    skillRootsByPrecedence(cwd).map((root) => discoverSkillCommands(root)),
  );
}

async function discoverClaudeSlashCommandsUncachedAsync(cwd: string): Promise<DiscoveredClaudeSlashCommand[]> {
  const commandLists: DiscoveredMarkdownSlashCommand[][] = [];
  for (const root of claudeRootsByPrecedence(cwd)) {
    commandLists.push(await discoverMarkdownCommandFilesAsync(path.join(root, "commands")));
  }
  const skillLists: DiscoveredMarkdownSlashCommand[][] = [];
  for (const root of skillRootsByPrecedence(cwd)) {
    skillLists.push(await discoverSkillCommandsAsync(root));
  }
  return mergeClaudeSlashCommands(commandLists, skillLists);
}

/** Command files outrank skills, and within each kind the first root in precedence order wins a name. */
function mergeClaudeSlashCommands(
  commandLists: readonly (readonly DiscoveredMarkdownSlashCommand[])[],
  skillLists: readonly (readonly DiscoveredMarkdownSlashCommand[])[],
): DiscoveredClaudeSlashCommand[] {
  const byName = new Map<string, DiscoveredClaudeSlashCommand>();
  const add = (list: readonly DiscoveredMarkdownSlashCommand[], source: DiscoveredClaudeSlashCommand["source"]): void => {
    for (const command of list) {
      const key = slashCommandKey(command.name);
      if (!byName.has(key)) {
        byName.set(key, { ...command, source });
      }
    }
  };
  for (const list of commandLists) add(list, "command");
  for (const list of skillLists) add(list, "skill");

  return [...byName.values()].sort((a, b) => {
    if (a.source !== b.source) return a.source === "command" ? -1 : 1;
    return slashCommandNameOrder.compare(a.name, b.name);
  });
}

/** The command and skill roots a harness reads for itself, so ADE lists nothing under them. */
export type NativeSlashCommandRoots = { commandRoots: readonly string[]; skillRoots: readonly string[] };

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
): NativeSlashCommandRoots {
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

function realPathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/** Skill roots hold one folder per skill; a few hundred is already far past any real collection. */
const MAX_SKILL_DIRS_PER_ROOT = 500;

/**
 * The real folders behind the entries of Claude's own skill roots that are
 * links. An entry that is a plain folder is already matched by its path.
 */
function realSkillDirsUnder(skillRoots: readonly string[]): Set<string> {
  const dirs = new Set<string>();
  for (const root of skillRoots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.slice(0, MAX_SKILL_DIRS_PER_ROOT)) {
      if (!entry.isSymbolicLink()) continue;
      const real = realPathOrNull(path.join(root, entry.name));
      if (real) dirs.add(pathKey(real));
    }
  }
  return dirs;
}

export type SlashCommandInjectionPlan = {
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
  options: {
    cwd: string;
    pluginRoots?: readonly string[];
    home?: string;
    /**
     * The bundled ADE skills plugin, and every root that holds another copy of
     * those skills (ADE's own repo keeps their source in
     * `apps/desktop/resources/agent-skills`). A copy is a different folder, so
     * the path match misses it and the model saw each ADE skill twice: once as
     * `ade:<name>` and once by path.
     */
    bundledSkills?: { pluginRoots: readonly string[]; copyRoots: readonly string[] };
  },
): SlashCommandInjectionPlan {
  const plan = planSlashCommandInjection(commands, claudeNativeSlashCommandRoots(
    options.cwd,
    options.pluginRoots ?? [],
    options.home ?? os.homedir(),
  ));
  const copyRoots = options.bundledSkills?.copyRoots ?? [];
  if (!copyRoots.length) return plan;
  const bundledNames = bundledSkillNames(options.bundledSkills?.pluginRoots ?? []);
  if (!bundledNames.size) return plan;
  // Matched by folder name, and only inside ADE's own skill roots: a user
  // skill that shares a name with an ADE skill is a different skill and stays.
  // The plugin's copy is the one to keep, because it matches the installed
  // `ade` CLI the agent runs; a repo copy can describe unreleased commands.
  const isCopy = (entry: DiscoveredClaudeSlashCommand) =>
    bundledNames.has(path.basename(path.dirname(entry.filePath)))
    && copyRoots.some((root) => isPathInside(entry.filePath, root));
  const skills = plan.skills.filter((entry) => !isCopy(entry));
  return { ...plan, skills, nativeCount: plan.nativeCount + plan.skills.length - skills.length };
}

const cachedBundledSkillNames = createSlashCommandListingCache<Set<string>>();

/** Skill folder names under the bundled plugin roots, on discovery's own TTL. */
function bundledSkillNames(pluginRoots: readonly string[]): Set<string> {
  if (!pluginRoots.length) return new Set();
  return cachedBundledSkillNames(pluginRoots.map((root) => pathKey(root)).join("\n"), () => {
    const names = new Set<string>();
    for (const root of pluginRoots) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries.slice(0, MAX_SKILL_DIRS_PER_ROOT)) {
        if (entry.name.startsWith(".")) continue;
        if (fs.existsSync(path.join(root, entry.name, "SKILL.md"))) names.add(entry.name);
      }
    }
    return names;
  });
}

/** Drops everything under the roots a harness already reads for itself. */
export function planSlashCommandInjection(
  commands: readonly DiscoveredClaudeSlashCommand[],
  native: NativeSlashCommandRoots,
): SlashCommandInjectionPlan {
  // A skill Claude reaches through a link counts as native too. A common setup
  // keeps the real skill in `~/.agents/skills` and links it into
  // `~/.claude/skills`, so Claude lists it under the link while ADE finds the
  // same folder under the root Claude does not read, and the skill appeared
  // twice. Matched on the folder's real path only: two different skills that
  // share a name are both kept, because hiding one Claude does not have is the
  // worse mistake.
  const linkedSkillDirs = realSkillDirsUnder(native.skillRoots);
  const isNative = (entry: DiscoveredClaudeSlashCommand): boolean => {
    const roots = entry.source === "command" ? native.commandRoots : native.skillRoots;
    if (roots.some((root) => isPathInside(entry.filePath, root))) return true;
    if (entry.source !== "skill" || !linkedSkillDirs.size) return false;
    const real = realPathOrNull(path.dirname(entry.filePath));
    return real !== null && linkedSkillDirs.has(pathKey(real));
  };

  const plan: SlashCommandInjectionPlan = { commands: [], skills: [], nativeCount: 0 };
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

/** One line of a skill listing and the file it names, for the context preview. */
export type SkillListingEntry = { name: string; text: string; source: string };

export function skillListingEntry(entry: DiscoveredClaudeSlashCommand, text: string): SkillListingEntry {
  // A command's name carries its `/`; the list shows the bare name.
  return { name: entry.name.replace(/^\//, ""), text, source: entry.filePath };
}

export function formatClaudeSlashCommandEntry(entry: DiscoveredClaudeSlashCommand): string {
  const description = entry.description.trim();
  const clipped = description.length > CLAUDE_SKILL_LISTING_MAX_DESC_CHARS
    ? `${description.slice(0, CLAUDE_SKILL_LISTING_MAX_DESC_CHARS - 1).trimEnd()}…`
    : description;
  const head = clipped.length ? `- ${entry.name} — ${clipped}` : `- ${entry.name}`;
  return `${head}\n  file: ${entry.filePath}`;
}

/**
 * Renders entries in order until the budget is spent, counting what did not
 * fit. The first entry always goes in: a list of nothing helps nobody.
 * `kept[i]` is the entry `lines[i]` was rendered from.
 */
export function renderWithinBudget<T>(
  entries: readonly T[],
  format: (entry: T) => string,
  budgetBytes: number,
): { lines: string[]; kept: T[]; omitted: number } {
  const lines: string[] = [];
  const kept: T[] = [];
  let used = 0;
  let omitted = 0;
  for (const entry of entries) {
    const rendered = format(entry);
    const cost = Buffer.byteLength(rendered, "utf8") + 1;
    if (lines.length && used + cost > budgetBytes) {
      omitted += 1;
      continue;
    }
    lines.push(rendered);
    kept.push(entry);
    used += cost;
  }
  return { lines, kept, omitted };
}

/**
 * Renders entries newest-budget-first, returning what did not fit so the caller
 * can say so in the prompt instead of hiding it.
 */
export function renderClaudeSlashCommandEntries(
  entries: readonly DiscoveredClaudeSlashCommand[],
  budgetBytes: number = CLAUDE_SKILL_LISTING_BUDGET_BYTES,
): { lines: string[]; kept: DiscoveredClaudeSlashCommand[]; omitted: number } {
  return renderWithinBudget(entries, formatClaudeSlashCommandEntry, budgetBytes);
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
