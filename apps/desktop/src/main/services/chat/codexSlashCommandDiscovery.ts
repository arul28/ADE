import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverMarkdownCommandFiles,
  parseSlashCommandInput,
  resolveMarkdownCommandFile,
  stripFrontmatter,
} from "./markdownSlashCommandDiscovery";

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

function codexHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = typeof env.CODEX_HOME === "string" ? env.CODEX_HOME.trim() : "";
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".codex");
}

function samePath(left: string, right: string): boolean {
  // Windows paths are case-insensitive, and `path.resolve(cwd)` and
  // `os.homedir()` routinely disagree on drive-letter case. A case-sensitive
  // compare would miss the home-directory stop and keep walking to the depth
  // cap, inventing `C:\Users\.codex` and `C:\.codex` prompt roots.
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function codexPromptRoots(cwd: string): string[] {
  // Codex resolves its user-level prompt directory under CODEX_HOME, which its
  // own installers set and which is commonly relocated off the roaming profile
  // on Windows. Only the per-project `.codex/prompts` walk is cwd-relative.
  const roots: string[] = [path.join(codexHomeDir(), "prompts")];
  const seen = new Set<string>(roots);
  const home = os.homedir();
  let current = path.resolve(cwd);
  let depth = 0;
  while (depth < 25) {
    const candidate = path.join(current, ".codex", "prompts");
    if (!seen.has(candidate)) {
      seen.add(candidate);
      roots.push(candidate);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    if (samePath(current, home)) break;
    current = parent;
    depth += 1;
  }
  return roots;
}

export function discoverCodexSlashCommands(cwd: string): DiscoveredCodexSlashCommand[] {
  const byName = new Map<string, DiscoveredCodexSlashCommand>();
  for (const root of codexPromptRoots(cwd)) {
    for (const command of discoverMarkdownCommandFiles(root, {
      lowercaseNames: true,
      useFrontmatterDescription: false,
    })) {
      byName.set(command.name, {
        name: command.name,
        description: command.description,
        argumentHint: command.argumentHint,
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function resolveCodexSlashCommandInvocation(
  cwd: string,
  input: string,
): ResolvedCodexSlashCommandInvocation | null {
  const parsed = parseSlashCommandInput(input);
  if (!parsed) return null;
  const name = parsed.name.toLowerCase();
  const { argumentsText } = parsed;

  let promptFile: string | null = null;
  for (const root of codexPromptRoots(cwd)) {
    promptFile = resolveMarkdownCommandFile(root, name, {
      lowercaseNames: true,
      matchBasename: false,
      uniqueBasenameFallback: false,
    }) ?? promptFile;
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
