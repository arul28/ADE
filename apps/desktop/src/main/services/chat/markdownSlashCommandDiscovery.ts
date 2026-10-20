import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export type DiscoveredMarkdownSlashCommand = {
  name: string;
  description: string;
  argumentHint?: string;
  filePath: string;
  /**
   * Whether the model may invoke this command/skill on its own. A skill opts
   * out with `disable-model-invocation: true`; command files and agent files
   * default to true. Consumers that inject skills into a system prompt must
   * skip rows where this is false.
   */
  modelInvocable: boolean;
};

export type ResolvedMarkdownSlashCommandInvocation = {
  name: string;
  promptText: string;
  argumentsText: string;
};

type CommandFrontmatter = {
  description?: unknown;
  "argument-hint"?: unknown;
  argumentHint?: unknown;
};

type SkillFrontmatter = CommandFrontmatter & {
  name?: unknown;
  "user-invocable"?: unknown;
  userInvocable?: unknown;
  "disable-model-invocation"?: unknown;
  disableModelInvocation?: unknown;
};

type AgentFrontmatter = CommandFrontmatter & {
  name?: unknown;
};

/**
 * A copy of `value` that owns its characters.
 *
 * Frontmatter values and first paragraphs are slices of the whole file, and V8
 * keeps a slice's parent string alive. The brain caches these records, so a
 * one-line description held the full SKILL.md: about 2 MB of file text pinned
 * per cached folder to keep 88 KB of names and descriptions.
 */
function ownString<T extends string | undefined>(value: T): T {
  return (value === undefined ? value : Buffer.from(value, "utf8").toString("utf8")) as T;
}

function ownedCommand(command: DiscoveredMarkdownSlashCommand): DiscoveredMarkdownSlashCommand {
  return {
    ...command,
    name: ownString(command.name),
    description: ownString(command.description),
    argumentHint: ownString(command.argumentHint),
  };
}

export const DEFAULT_MARKDOWN_COMMAND_DEPTH = 10;
export const SLASH_COMMAND_INPUT_PATTERN =
  /^(\/[A-Za-z0-9][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)*)(?:\s+([\s\S]*))?$/;

function parseFrontmatterObject(source: string): Record<string, unknown> | null {
  try {
    const parsed = parseYaml(source);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

const FRONTMATTER_TOP_LEVEL_KEY = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*)|[ \t]*)$/;

/**
 * Claude Code reads frontmatter that strict YAML rejects, and files in the wild
 * rely on it: `description: Deploy helper: runs the flow` (a second `: `),
 * `argument-hint: [system] [--source <path>]` (a `[` that is not a list), and a
 * plain description that runs on over unindented lines. One such key used to
 * make the whole block parse to nothing, so the file lost its name, description
 * and `user-invocable` / `disable-model-invocation` flags with it.
 *
 * The repair works per top-level key: a key whose own text parses is kept
 * verbatim, and a key that does not is re-emitted as one quoted string, joining
 * its continuation lines. Block values (`|`, `>`) and keys with indented
 * children are never rewritten, so a genuinely malformed structure still fails.
 */
function repairPlainScalarFrontmatter(source: string): string | null {
  const entries: { key: string; value: string; lines: string[] }[] = [];
  const preamble: string[] = [];
  const seenKeys = new Set<string>();
  for (const line of source.split(/\r?\n/)) {
    const keyMatch = FRONTMATTER_TOP_LEVEL_KEY.exec(line);
    // A key seen before is prose inside the previous value (agent files embed
    // `user:` / `assistant:` example dialogue in an unquoted description).
    if (keyMatch && !seenKeys.has(keyMatch[1]!)) {
      seenKeys.add(keyMatch[1]!);
      entries.push({ key: keyMatch[1]!, value: keyMatch[2] ?? "", lines: [line] });
    } else if (entries.length) {
      entries[entries.length - 1]!.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (!entries.length) return null;
  let repaired = false;
  const out = [...preamble];
  for (const entry of entries) {
    const text = entry.lines.join("\n");
    const value = entry.value.trim();
    const continuation = entry.lines.slice(1);
    const hasIndentedChildren = continuation.some((line) => /^\s+\S/.test(line));
    // Verbatim only when the text parses to exactly this one key: a folded
    // repeat of an earlier key (`user:` in example dialogue) would otherwise
    // bring the duplicate straight back.
    const own = parseFrontmatterObject(text);
    if (
      (own !== null && Object.keys(own).length === 1 && entry.key in own)
      || !value
      || /^[|>]/.test(value)
      || hasIndentedChildren
    ) {
      out.push(text);
      continue;
    }
    const joined = [value, ...continuation.map((line) => line.trim())]
      .join("\n")
      .replace(/\s+$/, "");
    out.push(`${entry.key}: ${JSON.stringify(joined)}`);
    repaired = true;
  }
  return repaired ? out.join("\n") : null;
}

export function readFrontmatter(markdown: string): Record<string, unknown> {
  if (!markdown.startsWith("---")) return {};
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  const source = match[1] ?? "";
  const strict = parseFrontmatterObject(source);
  if (strict) return strict;
  const repaired = repairPlainScalarFrontmatter(source);
  return (repaired !== null ? parseFrontmatterObject(repaired) : null) ?? {};
}

export function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}

export function firstMarkdownParagraph(markdown: string): string {
  const paragraph = stripFrontmatter(markdown)
    .split(/\r?\n\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return paragraph?.split(/\r?\n/)[0]?.trim() ?? "";
}

export function normalizeSlashCommandName(
  value: string,
  options: { lowercase?: boolean } = {},
): string | null {
  let name = value
    .trim()
    .replace(/\.md$/i, "")
    .replace(/[^A-Za-z0-9_:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (options.lowercase) name = name.toLowerCase();
  return name.length ? `/${name}` : null;
}

/**
 * The order slash-command lists are sorted in. `localeCompare` with these options
 * builds a collator on every comparison. Measured on a 2,816-command tree: ~9 ms for
 * the merge in the order discovery returns it, ~91 ms for the same names shuffled.
 * One shared collator orders them the same way: under 0.5 ms and ~2 ms.
 */
export const slashCommandNameOrder = new Intl.Collator(undefined, { sensitivity: "base" });

export function slashCommandKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Merges command lists for `chat.getSlashCommands`: a later group's entry replaces
 * an earlier one with the same key, and the result is sorted by name. The sort runs
 * on the brain's event loop, so it uses the shared collator, not `localeCompare`.
 */
export function mergeSlashCommands<T extends { name: string }>(groups: readonly (readonly T[])[]): T[] {
  const merged = new Map<string, T>();
  for (const group of groups) {
    for (const command of group) {
      merged.set(slashCommandKey(command.name), command);
    }
  }
  return [...merged.values()].sort((a, b) => slashCommandNameOrder.compare(a.name, b.name));
}

export function maybeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * A lenient read of a frontmatter boolean.
 *
 * The `yaml` package parses YAML 1.2 core, where only `true`/`false` are
 * booleans — `no`, `off`, and `0` stay strings/numbers. A skill written with
 * `user-invocable: no` (the YAML 1.1 spelling, which other harnesses accept)
 * therefore stayed invocable and was advertised to the model. Treat every
 * conventional spelling as a boolean and leave anything unrecognized
 * undefined so the caller can pick its own default.
 */
export function frontmatterFlag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "true":
    case "yes":
    case "on":
    case "1":
      return true;
    case "false":
    case "no":
    case "off":
    case "0":
      return false;
    default:
      return undefined;
  }
}

export function maybeArgumentHint(value: unknown): string | undefined {
  const stringValue = maybeString(value);
  if (stringValue) return stringValue;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const parts = value
    .map((item) => String(item ?? "").trim())
    .filter((item) => item.length > 0);
  return parts.length ? `[${parts.join("] [")}]` : undefined;
}

export function parseSlashCommandInput(input: string): { name: string; argumentsText: string } | null {
  const trimmed = input.trim();
  const match = trimmed.match(SLASH_COMMAND_INPUT_PATTERN);
  if (!match) return null;
  const name = match[1];
  if (!name) return null;
  return {
    name,
    argumentsText: match[2]?.trim() ?? "",
  };
}

export function expandSlashCommandBody(
  body: string,
  argumentsText: string,
  options: { argumentsLabel?: string } = {},
): string {
  const trimmedBody = body.trim();
  if (!trimmedBody.length) return "";
  if (/\$ARGUMENTS/.test(trimmedBody)) {
    return trimmedBody.replace(/\$ARGUMENTS/g, argumentsText);
  }
  if (!argumentsText.length) return trimmedBody;
  const label = options.argumentsLabel ?? "Arguments";
  return `${trimmedBody}\n\n${label}: ${argumentsText}`;
}

export function visitMarkdownFiles(
  root: string,
  visit: (entryPath: string, relativeNoExt: string) => void,
  maxDepth = DEFAULT_MARKDOWN_COMMAND_DEPTH,
): void {
  if (!fs.existsSync(root)) return;
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const relativeNoExt = path.relative(root, entryPath).replace(/\.md$/i, "");
      visit(entryPath, relativeNoExt);
    }
  };
  walk(root, 0);
}

/**
 * The async twin of `visitMarkdownFiles`: the same files in the same order, but
 * the directories are listed with `fs.promises`, so the walk yields to the event
 * loop between them. Returns the list rather than visiting, so the caller can
 * read the files in batches (`eachReadFile`).
 */
async function listMarkdownFilesAsync(
  root: string,
  maxDepth: number,
): Promise<{ entryPath: string; relativeNoExt: string }[]> {
  const files: { entryPath: string; relativeNoExt: string }[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const relativeNoExt = path.relative(root, entryPath).replace(/\.md$/i, "");
      files.push({ entryPath, relativeNoExt });
    }
  };
  await walk(root, 0);
  return files;
}

/**
 * Files the async walk reads at once. One read at a time costs a threadpool round
 * trip per file, which made the walk several times slower than the synchronous
 * one; reading in batches overlaps those trips. Files are handled in order, a
 * batch at a time, so the work between two yields stays short.
 */
const ASYNC_READ_BATCH = 32;

/** Reads each file in batches and hands its text to `handle` in input order. A file that cannot be read is skipped. */
async function eachReadFile<T extends { entryPath: string }>(
  files: readonly T[],
  handle: (file: T, content: string) => void,
): Promise<void> {
  for (let start = 0; start < files.length; start += ASYNC_READ_BATCH) {
    const batch = files.slice(start, start + ASYNC_READ_BATCH);
    const texts = await Promise.all(
      batch.map((file) => fs.promises.readFile(file.entryPath, "utf8").catch(() => null)),
    );
    batch.forEach((file, index) => {
      const content = texts[index];
      if (content != null) handle(file, content);
    });
  }
}

function commandNameFromRelative(relativeNoExt: string, lowercaseNames: boolean): string | null {
  return normalizeSlashCommandName(
    relativeNoExt.split(path.sep).filter(Boolean).join(":"),
    { lowercase: lowercaseNames },
  );
}

// The record for one file is built here from its text, so the sync and async walks cannot drift apart.
function markdownCommandFromContent(
  name: string,
  entryPath: string,
  content: string,
  useFrontmatterDescription: boolean,
): DiscoveredMarkdownSlashCommand {
  const frontmatter = readFrontmatter(content) as CommandFrontmatter;
  const description = useFrontmatterDescription
    ? maybeString(frontmatter.description) ?? firstMarkdownParagraph(content)
    : firstMarkdownParagraph(content);
  return ownedCommand({
    name,
    description,
    argumentHint: maybeArgumentHint(frontmatter["argument-hint"]) ?? maybeArgumentHint(frontmatter.argumentHint),
    filePath: entryPath,
    modelInvocable: true,
  });
}

function markdownAgentFromContent(
  relativeNoExt: string,
  entryPath: string,
  content: string,
  lowercaseNames: boolean,
): DiscoveredMarkdownSlashCommand | null {
  const frontmatter = readFrontmatter(content) as AgentFrontmatter;
  const name = normalizeSlashCommandName(
    maybeString(frontmatter.name) ?? path.basename(relativeNoExt),
    { lowercase: lowercaseNames },
  );
  if (!name) return null;
  return ownedCommand({
    name,
    description: maybeString(frontmatter.description) ?? firstMarkdownParagraph(content),
    argumentHint: maybeArgumentHint(frontmatter["argument-hint"]) ?? maybeArgumentHint(frontmatter.argumentHint),
    filePath: entryPath,
    modelInvocable: true,
  });
}

export function discoverMarkdownCommandFiles(
  commandsDir: string,
  options: {
    maxDepth?: number;
    lowercaseNames?: boolean;
    useFrontmatterDescription?: boolean;
  } = {},
): DiscoveredMarkdownSlashCommand[] {
  const {
    maxDepth = DEFAULT_MARKDOWN_COMMAND_DEPTH,
    lowercaseNames = false,
    useFrontmatterDescription = true,
  } = options;
  const commands: DiscoveredMarkdownSlashCommand[] = [];
  visitMarkdownFiles(commandsDir, (entryPath, relativeNoExt) => {
    const name = commandNameFromRelative(relativeNoExt, lowercaseNames);
    if (!name) return;
    let content = "";
    try {
      content = fs.readFileSync(entryPath, "utf8");
    } catch {
      return;
    }
    commands.push(markdownCommandFromContent(name, entryPath, content, useFrontmatterDescription));
  }, maxDepth);
  return commands;
}

/** The async twin of `discoverMarkdownCommandFiles`: same files, records and order. */
export async function discoverMarkdownCommandFilesAsync(
  commandsDir: string,
  options: {
    maxDepth?: number;
    lowercaseNames?: boolean;
    useFrontmatterDescription?: boolean;
  } = {},
): Promise<DiscoveredMarkdownSlashCommand[]> {
  const {
    maxDepth = DEFAULT_MARKDOWN_COMMAND_DEPTH,
    lowercaseNames = false,
    useFrontmatterDescription = true,
  } = options;
  const commands: DiscoveredMarkdownSlashCommand[] = [];
  const named = (await listMarkdownFilesAsync(commandsDir, maxDepth)).flatMap((file) => {
    const name = commandNameFromRelative(file.relativeNoExt, lowercaseNames);
    return name ? [{ ...file, name }] : [];
  });
  await eachReadFile(named, (file, content) => {
    commands.push(markdownCommandFromContent(file.name, file.entryPath, content, useFrontmatterDescription));
  });
  return commands;
}

export function discoverMarkdownAgentFiles(
  agentsDir: string,
  options: { maxDepth?: number; lowercaseNames?: boolean } = {},
): DiscoveredMarkdownSlashCommand[] {
  const { maxDepth = DEFAULT_MARKDOWN_COMMAND_DEPTH, lowercaseNames = false } = options;
  const commands: DiscoveredMarkdownSlashCommand[] = [];
  visitMarkdownFiles(agentsDir, (entryPath, relativeNoExt) => {
    let content = "";
    try {
      content = fs.readFileSync(entryPath, "utf8");
    } catch {
      return;
    }
    const command = markdownAgentFromContent(relativeNoExt, entryPath, content, lowercaseNames);
    if (command) commands.push(command);
  }, maxDepth);
  return commands;
}

/** The async twin of `discoverMarkdownAgentFiles`: same files, records and order. */
export async function discoverMarkdownAgentFilesAsync(
  agentsDir: string,
  options: { maxDepth?: number; lowercaseNames?: boolean } = {},
): Promise<DiscoveredMarkdownSlashCommand[]> {
  const { maxDepth = DEFAULT_MARKDOWN_COMMAND_DEPTH, lowercaseNames = false } = options;
  const commands: DiscoveredMarkdownSlashCommand[] = [];
  await eachReadFile(await listMarkdownFilesAsync(agentsDir, maxDepth), (file, content) => {
    const command = markdownAgentFromContent(file.relativeNoExt, file.entryPath, content, lowercaseNames);
    if (command) commands.push(command);
  });
  return commands;
}

export function resolveMarkdownCommandFile(
  commandsDir: string,
  commandName: string,
  options: {
    maxDepth?: number;
    lowercaseNames?: boolean;
    matchBasename?: boolean;
    uniqueBasenameFallback?: boolean;
  } = {},
): string | null {
  const {
    maxDepth = DEFAULT_MARKDOWN_COMMAND_DEPTH,
    lowercaseNames = false,
    matchBasename = true,
    uniqueBasenameFallback = true,
  } = options;
  if (!fs.existsSync(commandsDir)) return null;
  const normalizedCommandName = lowercaseNames ? commandName.toLowerCase() : commandName;
  const commandPathParts = normalizedCommandName.replace(/^\//, "").split(":").filter(Boolean);
  if (!commandPathParts.length) return null;
  const candidate = path.join(commandsDir, ...commandPathParts) + ".md";
  const relative = path.relative(commandsDir, candidate);
  if (!relative.startsWith("..") && !path.isAbsolute(relative) && fs.existsSync(candidate)) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // fall through to normalized lookup
    }
  }

  const targetName = slashCommandKey(normalizedCommandName);
  const pathMatches: string[] = [];
  const baseMatches: string[] = [];
  visitMarkdownFiles(commandsDir, (entryPath, relativeNoExt) => {
    const normalizedPath = commandNameFromRelative(relativeNoExt, lowercaseNames);
    const normalizedBase = normalizeSlashCommandName(path.basename(relativeNoExt), { lowercase: lowercaseNames });
    if (normalizedPath && slashCommandKey(normalizedPath) === targetName) pathMatches.push(entryPath);
    if (matchBasename && normalizedBase && slashCommandKey(normalizedBase) === targetName) {
      baseMatches.push(entryPath);
    }
  }, maxDepth);
  if (pathMatches.length > 0) return pathMatches[0] ?? null;
  if (matchBasename && uniqueBasenameFallback && baseMatches.length === 1) {
    return baseMatches[0] ?? null;
  }
  return null;
}

// The record for one skill folder's SKILL.md, or null when the skill is filtered out or has no usable name.
function skillCommandFromContent(
  dirName: string,
  skillPath: string,
  content: string,
  options: { respectUserInvocable: boolean; lowercaseNames: boolean },
): DiscoveredMarkdownSlashCommand | null {
  const frontmatter = readFrontmatter(content) as SkillFrontmatter;
  if (
    options.respectUserInvocable
    && (frontmatterFlag(frontmatter["user-invocable"]) === false
      || frontmatterFlag(frontmatter.userInvocable) === false)
  ) {
    return null;
  }
  const name = normalizeSlashCommandName(maybeString(frontmatter.name) ?? dirName, { lowercase: options.lowercaseNames });
  if (!name) return null;
  const disableModelInvocation = frontmatterFlag(frontmatter["disable-model-invocation"]) === true
    || frontmatterFlag(frontmatter.disableModelInvocation) === true;
  return ownedCommand({
    name,
    description: maybeString(frontmatter.description) ?? firstMarkdownParagraph(content),
    argumentHint: maybeArgumentHint(frontmatter["argument-hint"]) ?? maybeArgumentHint(frontmatter.argumentHint),
    filePath: skillPath,
    modelInvocable: !disableModelInvocation,
  });
}

export function discoverSkillCommands(
  skillsDir: string,
  options: { respectUserInvocable?: boolean; lowercaseNames?: boolean } = {},
): DiscoveredMarkdownSlashCommand[] {
  const { respectUserInvocable = true, lowercaseNames = false } = options;
  const commands: DiscoveredMarkdownSlashCommand[] = [];
  if (!fs.existsSync(skillsDir)) return commands;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return commands;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillPath)) continue;
    let content = "";
    try {
      content = fs.readFileSync(skillPath, "utf8");
    } catch {
      continue;
    }
    const command = skillCommandFromContent(entry.name, skillPath, content, { respectUserInvocable, lowercaseNames });
    if (command) commands.push(command);
  }

  return commands;
}

/**
 * The async twin of `discoverSkillCommands`: same folders, records and order.
 * A missing SKILL.md is the same outcome as an unreadable one, so the read's
 * error is the only check.
 */
export async function discoverSkillCommandsAsync(
  skillsDir: string,
  options: { respectUserInvocable?: boolean; lowercaseNames?: boolean } = {},
): Promise<DiscoveredMarkdownSlashCommand[]> {
  const { respectUserInvocable = true, lowercaseNames = false } = options;
  const commands: DiscoveredMarkdownSlashCommand[] = [];

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return commands;
  }

  const skills = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
      return { dirName: entry.name, skillPath, entryPath: skillPath };
    });
  await eachReadFile(skills, (skill, content) => {
    const command = skillCommandFromContent(skill.dirName, skill.skillPath, content, { respectUserInvocable, lowercaseNames });
    if (command) commands.push(command);
  });

  return commands;
}

export function resolveSkillCommandFile(skillsDir: string, commandName: string): string | null {
  if (!fs.existsSync(skillsDir)) return null;
  const target = commandName.replace(/^\//, "").toLowerCase();
  if (!target.length) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillPath)) continue;
    let content = "";
    try {
      content = fs.readFileSync(skillPath, "utf8");
    } catch {
      continue;
    }
    const frontmatter = readFrontmatter(content) as SkillFrontmatter;
    if (frontmatterFlag(frontmatter["user-invocable"]) === false
      || frontmatterFlag(frontmatter.userInvocable) === false) continue;
    const declaredName = maybeString(frontmatter.name);
    const candidateNames = new Set<string>();
    const dirNormalized = normalizeSlashCommandName(entry.name);
    if (dirNormalized) candidateNames.add(dirNormalized.toLowerCase());
    if (declaredName) {
      const fmNormalized = normalizeSlashCommandName(declaredName);
      if (fmNormalized) candidateNames.add(fmNormalized.toLowerCase());
    }
    if (candidateNames.has(`/${target}`)) {
      return skillPath;
    }
  }
  return null;
}

export function resolveMarkdownSlashCommandFromFile(
  filePath: string,
  name: string,
  argumentsText: string,
  options: { argumentsLabel?: string } = {},
): ResolvedMarkdownSlashCommandInvocation | null {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const body = stripFrontmatter(content).trim();
    if (!body.length) return null;
    const promptText = expandSlashCommandBody(body, argumentsText, options);
    return {
      name,
      argumentsText,
      promptText,
    };
  } catch {
    return null;
  }
}

export function ancestorConfigRoots(
  cwd: string,
  configDirName: string,
  options: { includeHome?: boolean; homeSubpath?: string } = {},
): string[] {
  const { includeHome = true, homeSubpath = configDirName } = options;
  const roots: string[] = [];
  const seen = new Set<string>();
  const home = path.resolve(os.homedir());
  let current = path.resolve(cwd);
  let depth = 0;
  while (depth < 25) {
    const candidate = path.join(current, configDirName);
    if (!seen.has(candidate)) {
      seen.add(candidate);
      roots.push(candidate);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    if (current === home) break;
    current = parent;
    depth += 1;
  }
  if (includeHome) {
    const homeRoot = path.join(home, ...homeSubpath.split("/").filter(Boolean));
    if (!seen.has(homeRoot)) roots.push(homeRoot);
  }
  return roots;
}

