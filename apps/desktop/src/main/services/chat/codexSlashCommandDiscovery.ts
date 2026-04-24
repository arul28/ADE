import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type DiscoveredCodexSlashCommand = {
  name: string;
  description: string;
  argumentHint?: string;
};

export type ResolvedCodexSlashCommandInvocation = {
  name: string;
  promptText: string;
  argumentsText: string;
};

const MAX_PROMPT_DEPTH = 10;

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}

function firstMarkdownParagraph(markdown: string): string {
  const body = stripFrontmatter(markdown);
  const paragraph = body
    .split(/\r?\n\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return paragraph?.split(/\r?\n/)[0]?.trim() ?? "";
}

function normalizeSlashCommandName(value: string): string | null {
  const name = value.trim().replace(/\.md$/i, "").replace(/[^A-Za-z0-9_:-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return name.length ? `/${name}` : null;
}

function discoverPromptCommands(promptsDir: string): DiscoveredCodexSlashCommand[] {
  const commands: DiscoveredCodexSlashCommand[] = [];
  if (!fs.existsSync(promptsDir)) return commands;

  const visit = (dir: string, depth = 0): void => {
    if (depth > MAX_PROMPT_DEPTH) return;
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
      const relative = path.relative(promptsDir, entryPath).replace(/\.md$/i, "");
      const commandPath = relative.split(path.sep).filter(Boolean).join(":");
      const name = normalizeSlashCommandName(commandPath);
      if (!name) continue;
      let content = "";
      try {
        content = fs.readFileSync(entryPath, "utf8");
      } catch {
        continue;
      }
      commands.push({
        name,
        description: firstMarkdownParagraph(content),
      });
    }
  };

  visit(promptsDir);
  return commands;
}

function resolvePromptFile(promptsDir: string, commandName: string): string | null {
  if (!fs.existsSync(promptsDir)) return null;
  const commandPathParts = commandName.replace(/^\//, "").split(":").filter(Boolean);
  if (!commandPathParts.length) return null;
  const candidate = path.join(promptsDir, ...commandPathParts) + ".md";
  const relative = path.relative(promptsDir, candidate);
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
  // file like `My Prompt.md` is exposed as `/my-prompt`. Walk the directory
  // and match by normalized name so non-canonical filenames still resolve.
  const targetName = commandName.toLowerCase();
  let match: string | null = null;
  const visit = (dir: string, prefix: string[], depth: number): void => {
    if (match || depth > MAX_PROMPT_DEPTH) return;
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
  visit(promptsDir, [], 0);
  return match;
}

function codexPromptRoots(cwd: string): string[] {
  return [
    path.join(os.homedir(), ".codex", "prompts"),
    path.join(cwd, ".codex", "prompts"),
  ];
}

export function discoverCodexSlashCommands(cwd: string): DiscoveredCodexSlashCommand[] {
  const byName = new Map<string, DiscoveredCodexSlashCommand>();
  for (const root of codexPromptRoots(cwd)) {
    for (const command of discoverPromptCommands(root)) {
      byName.set(command.name, command);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveCodexSlashCommandInvocation(
  cwd: string,
  input: string,
): ResolvedCodexSlashCommandInvocation | null {
  const trimmed = input.trim();
  const match = trimmed.match(/^(\/[A-Za-z0-9][A-Za-z0-9_-]*(?::[A-Za-z0-9][A-Za-z0-9_-]*)*)(?:\s+([\s\S]*))?$/);
  if (!match) return null;

  const name = match[1]?.toLowerCase();
  if (!name) return null;
  const argumentsText = match[2]?.trim() ?? "";

  let promptFile: string | null = null;
  for (const root of codexPromptRoots(cwd)) {
    promptFile = resolvePromptFile(root, name) ?? promptFile;
  }
  if (!promptFile) return null;

  try {
    const body = stripFrontmatter(fs.readFileSync(promptFile, "utf8")).trim();
    if (!body.length) return null;
    const promptText = body.includes("$ARGUMENTS")
      ? body.replace(/\$ARGUMENTS/g, argumentsText)
      : argumentsText.length
        ? `${body}\n\n${argumentsText}`
        : body;
    return { name, argumentsText, promptText };
  } catch {
    return null;
  }
}
