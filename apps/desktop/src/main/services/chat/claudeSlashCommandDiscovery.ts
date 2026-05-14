import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { getAdeAgentSkillRootCandidates } from "../../../shared/agentSkillRoots";

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
  const name = value.trim().replace(/\.md$/i, "").replace(/[^A-Za-z0-9_:-]+/g, "-").replace(/^-+|-+$/g, "");
  return name.length ? `/${name}` : null;
}

function slashCommandKey(value: string): string {
  return value.trim().toLowerCase();
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
      const parts = relative.split(path.sep).filter(Boolean);
      const commandName = parts.join(":");
      const name = normalizeSlashCommandName(commandName);
      if (!name) continue;
      let content = "";
      try {
        content = fs.readFileSync(entryPath, "utf8");
      } catch {
        continue;
      }
      const frontmatter = readFrontmatter(content) as CommandFrontmatter;
      const description = maybeString(frontmatter.description) ?? firstMarkdownParagraph(content);
      commands.push({
        name,
        description,
        argumentHint: maybeArgumentHint(frontmatter["argument-hint"]) ?? maybeArgumentHint(frontmatter.argumentHint),
        source: "command",
        filePath: entryPath,
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
  // file like `My Command.md` is exposed as `/My-Command` but the literal
  // path above won't find it. Unique basename lookup is accepted for older ADE
  // command references, but duplicate basenames must use their colon path.
  const targetName = slashCommandKey(commandName);
  const pathMatches: string[] = [];
  const baseMatches: string[] = [];
  const visit = (dir: string, prefix: string[], depth: number): void => {
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
        visit(entryPath, [...prefix, entry.name], depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const commandPath = [...prefix, entry.name].join(":");
      const normalizedPath = normalizeSlashCommandName(commandPath);
      const normalizedBase = normalizeSlashCommandName(entry.name);
      if (normalizedPath && slashCommandKey(normalizedPath) === targetName) pathMatches.push(entryPath);
      if (normalizedBase && slashCommandKey(normalizedBase) === targetName) baseMatches.push(entryPath);
    }
  };
  visit(commandsDir, [], 0);
  if (pathMatches.length > 0) return pathMatches[0] ?? null;
  return baseMatches.length === 1 ? baseMatches[0] ?? null : null;
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
      source: "skill",
      filePath: skillPath,
    });
  }

  return commands;
}

function ancestorClaudeRoots(cwd: string): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const home = path.resolve(os.homedir());
  let current = path.resolve(cwd);
  let depth = 0;
  while (depth < 25) {
    const candidate = path.join(current, ".claude");
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
  return roots;
}

function claudeRootsByPrecedence(cwd: string): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const home = path.resolve(os.homedir());
  const addRoot = (root: string): void => {
    if (seen.has(root)) return;
    seen.add(root);
    roots.push(root);
  };

  for (const root of ancestorClaudeRoots(cwd)) {
    addRoot(root);
  }
  addRoot(path.join(home, ".claude"));
  return roots;
}

function ancestorSkillRoots(cwd: string, dirName: ".agents" | ".ade"): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const home = path.resolve(os.homedir());
  let current = path.resolve(cwd);
  let depth = 0;
  while (depth < 25) {
    const candidate = path.join(current, dirName, "skills");
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
  return roots;
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

  for (const root of claudeRootsByPrecedence(cwd)) addRoot(path.join(root, "skills"));
  for (const root of ancestorSkillRoots(cwd, ".agents")) addRoot(root);
  for (const root of ancestorSkillRoots(cwd, ".ade")) addRoot(root);
  addRoot(path.join(os.homedir(), ".agents", "skills"));
  addRoot(path.join(os.homedir(), ".ade", "skills"));
  for (const root of getAdeAgentSkillRootCandidates({ dirname: __dirname, includeDeepSourceFallbacks: true })) addRoot(root);
  return roots;
}

export function discoverClaudeSlashCommands(cwd: string): DiscoveredClaudeSlashCommand[] {
  const claudeRoots = claudeRootsByPrecedence(cwd);
  const byName = new Map<string, DiscoveredClaudeSlashCommand>();

  for (const root of claudeRoots) {
    const discovered = discoverLegacyCommands(path.join(root, "commands"));
    for (const command of discovered) {
      const key = slashCommandKey(command.name);
      if (!byName.has(key)) byName.set(key, command);
    }
  }
  for (const root of skillRootsByPrecedence(cwd)) {
    const discovered = discoverSkills(root);
    for (const command of discovered) {
      const key = slashCommandKey(command.name);
      if (!byName.has(key)) byName.set(key, command);
    }
  }

  return [...byName.values()].sort((a, b) => {
    if (a.source !== b.source) return a.source === "command" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

function resolveSkillFile(skillsDir: string, commandName: string): string | null {
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
    const frontmatter = readFrontmatter(content) as { name?: unknown; "user-invocable"?: unknown; userInvocable?: unknown };
    if (frontmatter["user-invocable"] === false || frontmatter.userInvocable === false) continue;
    const declaredName = maybeString(frontmatter.name);
    const candidateNames = new Set<string>();
    const dirNormalized = normalizeSlashCommandName(entry.name);
    if (dirNormalized) candidateNames.add(dirNormalized.toLowerCase());
    if (declaredName) {
      const fmNormalized = normalizeSlashCommandName(declaredName);
      if (fmNormalized) candidateNames.add(fmNormalized.toLowerCase());
    }
    if (candidateNames.has(`/${target}`) || candidateNames.has(target)) {
      return skillPath;
    }
  }
  return null;
}

export function resolveClaudeSlashCommandInvocation(
  cwd: string,
  input: string,
): ResolvedClaudeSlashCommandInvocation | null {
  const trimmed = input.trim();
  const match = trimmed.match(/^(\/[A-Za-z0-9][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)*)(?:\s+([\s\S]*))?$/);
  if (!match) return null;

  const name = match[1];
  if (!name) return null;
  const argumentsText = match[2]?.trim() ?? "";
  const claudeRoots = claudeRootsByPrecedence(cwd);

  // Prefer command files; fall back to user-invocable skills (SKILL.md).
  let resolvedFile: string | null = null;
  for (const root of claudeRoots) {
    resolvedFile = resolveLegacyCommandFile(path.join(root, "commands"), name);
    if (resolvedFile) break;
  }
  if (!resolvedFile) {
    for (const root of skillRootsByPrecedence(cwd)) {
      resolvedFile = resolveSkillFile(root, name);
      if (resolvedFile) break;
    }
  }
  if (!resolvedFile) return null;

  try {
    const content = fs.readFileSync(resolvedFile, "utf8");
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
