import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export type DiscoveredClaudeSlashCommand = {
  name: string;
  description: string;
  argumentHint?: string;
};

export type ResolvedClaudeSlashCommandInvocation = {
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

const MAX_LEGACY_COMMAND_DEPTH = 10;

function readFrontmatter(markdown: string): Record<string, unknown> {
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

function firstMarkdownParagraph(markdown: string): string {
  const body = stripFrontmatter(markdown);
  const paragraph = body
    .split(/\r?\n\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return paragraph?.split(/\r?\n/)[0]?.trim() ?? "";
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}

function normalizeSlashCommandName(value: string): string | null {
  const name = value.trim().replace(/\.md$/i, "").replace(/[^A-Za-z0-9_:-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return name.length ? `/${name}` : null;
}

function maybeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function maybeArgumentHint(value: unknown): string | undefined {
  const stringValue = maybeString(value);
  if (stringValue) return stringValue;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const parts = value
    .map((item) => String(item ?? "").trim())
    .filter((item) => item.length > 0);
  return parts.length ? `[${parts.join("] [")}]` : undefined;
}

function discoverLegacyCommands(commandsDir: string): DiscoveredClaudeSlashCommand[] {
  const commands: DiscoveredClaudeSlashCommand[] = [];
  if (!fs.existsSync(commandsDir)) return commands;

  const visit = (dir: string, depth = 0): void => {
    if (depth > MAX_LEGACY_COMMAND_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const relative = path.relative(commandsDir, entryPath).replace(/\.md$/i, "");
      const commandPath = relative.split(path.sep).filter(Boolean).join(":");
      const name = normalizeSlashCommandName(commandPath);
      if (!name) continue;
      let content = "";
      try {
        content = fs.readFileSync(entryPath, "utf8");
      } catch {
        continue;
      }
      const frontmatter = readFrontmatter(content) as CommandFrontmatter;
      commands.push({
        name,
        description: maybeString(frontmatter.description) ?? firstMarkdownParagraph(content),
        argumentHint: maybeArgumentHint(frontmatter["argument-hint"]) ?? maybeArgumentHint(frontmatter.argumentHint),
      });
    }
  };

  visit(commandsDir);
  return commands;
}

function resolveLegacyCommandFile(commandsDir: string, commandName: string): string | null {
  if (!fs.existsSync(commandsDir)) return null;
  const commandPathParts = commandName.replace(/^\//, "").split(":").filter(Boolean);
  if (!commandPathParts.length) return null;
  const candidate = path.join(commandsDir, ...commandPathParts) + ".md";
  const relative = path.relative(commandsDir, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  if (fs.existsSync(candidate)) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // fall through to slow-path scan
    }
  }
  // Slow path: discovery normalizes filenames (lowercase + slugified), so a
  // file like `My Command.md` is exposed as `/my-command` but the literal
  // path above won't find it. Walk the directory and match by normalized
  // name so non-canonical filenames still resolve.
  const targetName = commandName.toLowerCase();
  let match: string | null = null;
  const visit = (dir: string, prefix: string[], depth: number): void => {
    if (match || depth > MAX_LEGACY_COMMAND_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (match) return;
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath, [...prefix, entry.name], depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const commandPath = [...prefix, entry.name].join(":");
      const normalized = normalizeSlashCommandName(commandPath);
      if (normalized && normalized.toLowerCase() === targetName) {
        match = entryPath;
        return;
      }
    }
  };
  visit(commandsDir, [], 0);
  return match;
}

function discoverSkills(skillsDir: string): DiscoveredClaudeSlashCommand[] {
  const commands: DiscoveredClaudeSlashCommand[] = [];
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
    if (frontmatter["user-invocable"] === false || frontmatter.userInvocable === false) continue;
    const name = normalizeSlashCommandName(maybeString(frontmatter.name) ?? entry.name);
    if (!name) continue;
    commands.push({
      name,
      description: maybeString(frontmatter.description) ?? firstMarkdownParagraph(content),
      argumentHint: maybeArgumentHint(frontmatter["argument-hint"]) ?? maybeArgumentHint(frontmatter.argumentHint),
    });
  }

  return commands;
}

export function discoverClaudeSlashCommands(cwd: string): DiscoveredClaudeSlashCommand[] {
  const roots = [
    path.join(os.homedir(), ".claude"),
    path.join(cwd, ".claude"),
  ];
  const byName = new Map<string, DiscoveredClaudeSlashCommand>();

  for (const root of roots) {
    const discovered = [
      ...discoverLegacyCommands(path.join(root, "commands")),
      ...discoverSkills(path.join(root, "skills")),
    ];
    for (const command of discovered) {
      byName.set(command.name, command);
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveClaudeSlashCommandInvocation(
  cwd: string,
  input: string,
): ResolvedClaudeSlashCommandInvocation | null {
  const trimmed = input.trim();
  const match = trimmed.match(/^(\/[A-Za-z0-9][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)*)(?:\s+([\s\S]*))?$/);
  if (!match) return null;

  const name = match[1]?.toLowerCase();
  if (!name) return null;
  const argumentsText = match[2]?.trim() ?? "";
  const roots = [
    path.join(os.homedir(), ".claude"),
    path.join(cwd, ".claude"),
  ];

  let commandFile: string | null = null;
  for (const root of roots) {
    commandFile = resolveLegacyCommandFile(path.join(root, "commands"), name) ?? commandFile;
  }
  if (!commandFile) return null;

  try {
    const content = fs.readFileSync(commandFile, "utf8");
    const body = stripFrontmatter(content).trim();
    if (!body.length) return null;
    const hasPlaceholder = /\$ARGUMENTS/.test(body);
    const promptText = hasPlaceholder
      ? body.replace(/\$ARGUMENTS/g, argumentsText)
      : argumentsText.length
        ? `${body}\n\nArguments: ${argumentsText}`
        : body;
    return {
      name,
      argumentsText,
      promptText,
    };
  } catch {
    return null;
  }
}
