import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export type DiscoveredMarkdownSlashCommand = {
  name: string;
  description: string;
  argumentHint?: string;
  filePath: string;
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
};

type AgentFrontmatter = CommandFrontmatter & {
  name?: unknown;
};

export const DEFAULT_MARKDOWN_COMMAND_DEPTH = 10;
export const SLASH_COMMAND_INPUT_PATTERN =
  /^(\/[A-Za-z0-9][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)*)(?:\s+([\s\S]*))?$/;

export function readFrontmatter(markdown: string): Record<string, unknown> {
  if (!markdown.startsWith("---")) return {};
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  try {
    const parsed = parseYaml(match[1] ?? "");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
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

export function slashCommandKey(value: string): string {
  return value.trim().toLowerCase();
}

export function maybeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
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

function commandNameFromRelative(relativeNoExt: string, lowercaseNames: boolean): string | null {
  return normalizeSlashCommandName(
    relativeNoExt.split(path.sep).filter(Boolean).join(":"),
    { lowercase: lowercaseNames },
  );
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
    const frontmatter = readFrontmatter(content) as CommandFrontmatter;
    const description = useFrontmatterDescription
      ? maybeString(frontmatter.description) ?? firstMarkdownParagraph(content)
      : firstMarkdownParagraph(content);
    commands.push({
      name,
      description,
      argumentHint: maybeArgumentHint(frontmatter["argument-hint"]) ?? maybeArgumentHint(frontmatter.argumentHint),
      filePath: entryPath,
    });
  }, maxDepth);
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
    const frontmatter = readFrontmatter(content) as AgentFrontmatter;
    const name = normalizeSlashCommandName(
      maybeString(frontmatter.name) ?? path.basename(relativeNoExt),
      { lowercase: lowercaseNames },
    );
    if (!name) return;
    commands.push({
      name,
      description: maybeString(frontmatter.description) ?? firstMarkdownParagraph(content),
      argumentHint: maybeArgumentHint(frontmatter["argument-hint"]) ?? maybeArgumentHint(frontmatter.argumentHint),
      filePath: entryPath,
    });
  }, maxDepth);
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
    const frontmatter = readFrontmatter(content) as SkillFrontmatter;
    if (
      respectUserInvocable
      && (frontmatter["user-invocable"] === false || frontmatter.userInvocable === false)
    ) {
      continue;
    }
    const name = normalizeSlashCommandName(maybeString(frontmatter.name) ?? entry.name, { lowercase: lowercaseNames });
    if (!name) continue;
    commands.push({
      name,
      description: maybeString(frontmatter.description) ?? firstMarkdownParagraph(content),
      argumentHint: maybeArgumentHint(frontmatter["argument-hint"]) ?? maybeArgumentHint(frontmatter.argumentHint),
      filePath: skillPath,
    });
  }

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
    if (frontmatter["user-invocable"] === false || frontmatter.userInvocable === false) continue;
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

