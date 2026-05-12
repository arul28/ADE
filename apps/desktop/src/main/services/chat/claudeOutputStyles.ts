import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentChatClaudeOutputStyle, AgentChatClaudePlugin } from "../../../shared/types/chat";
import { writeTextAtomic } from "../shared/utils";

const MAX_ANCESTOR_DEPTH = 25;
const MAX_PLUGIN_DEPTH = 6;

export const CLAUDE_BUILT_IN_OUTPUT_STYLES: AgentChatClaudeOutputStyle[] = [
  {
    name: "Default",
    source: "builtin",
    description: "Claude Code's default software engineering style.",
  },
  {
    name: "Proactive",
    source: "builtin",
    description: "Claude executes immediately, makes reasonable assumptions, and prefers action over planning.",
  },
  {
    name: "Explanatory",
    source: "builtin",
    description: "Claude includes educational insights while helping with software engineering tasks.",
  },
  {
    name: "Learning",
    source: "builtin",
    description: "Claude collaborates in a learn-by-doing mode and may leave TODO(human) markers.",
  },
];

type OutputStyleFrontmatter = {
  name?: unknown;
  description?: unknown;
};

type ClaudePluginManifest = {
  name?: unknown;
  description?: unknown;
  version?: unknown;
};

type ClaudeSettingsLocal = Record<string, unknown> & {
  outputStyle?: unknown;
};

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

function maybeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function styleKey(value: string): string {
  return value.trim().toLowerCase();
}

function styleNameFromFile(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath)).replace(/[-_]+/g, " ").trim();
  return base.replace(/\b\w/g, (char) => char.toUpperCase());
}

function realpathOrResolve(targetPath: string): string {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function ancestorClaudeRoots(cwd: string): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const home = path.resolve(os.homedir());
  let current = path.resolve(cwd);
  let depth = 0;

  while (depth < MAX_ANCESTOR_DEPTH) {
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

  for (const root of ancestorClaudeRoots(cwd)) addRoot(root);
  addRoot(path.join(home, ".claude"));
  return roots;
}

function discoverOutputStyleFiles(
  dir: string,
  source: AgentChatClaudeOutputStyle["source"],
  pluginPath?: string,
): AgentChatClaudeOutputStyle[] {
  if (!fs.existsSync(dir)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const styles: AgentChatClaudeOutputStyle[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(dir, entry.name);
    let content = "";
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const frontmatter = readFrontmatter(content) as OutputStyleFrontmatter;
    const name = maybeString(frontmatter.name) ?? styleNameFromFile(filePath);
    if (!name.length) continue;
    styles.push({
      name,
      source,
      filePath,
      ...(pluginPath ? { pluginPath } : {}),
      ...(maybeString(frontmatter.description) ? { description: maybeString(frontmatter.description) } : {}),
    });
  }
  return styles;
}

function discoverPluginRoots(pluginsDir: string): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const visit = (dir: string, depth: number): void => {
    if (depth > MAX_PLUGIN_DEPTH || !fs.existsSync(dir)) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    if (fs.existsSync(path.join(dir, ".claude-plugin", "plugin.json"))) {
      const root = realpathOrResolve(dir);
      if (!seen.has(root)) {
        seen.add(root);
        roots.push(root);
      }
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      visit(path.join(dir, entry.name), depth + 1);
    }
  };

  visit(pluginsDir, 0);
  return roots;
}

export function discoverClaudePluginPaths(cwd: string): string[] {
  const roots = claudeRootsByPrecedence(cwd);
  const pluginPaths: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const pluginRoot of discoverPluginRoots(path.join(root, "plugins"))) {
      const resolved = realpathOrResolve(pluginRoot);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      pluginPaths.push(resolved);
    }
  }
  return pluginPaths;
}

export function discoverClaudePlugins(cwd: string): AgentChatClaudePlugin[] {
  return discoverClaudePluginPaths(cwd).map((pluginPath) => {
    const manifestPath = path.join(pluginPath, ".claude-plugin", "plugin.json");
    let manifest: ClaudePluginManifest = {};
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ClaudePluginManifest;
    } catch {
      manifest = {};
    }
    return {
      name: maybeString(manifest.name) ?? path.basename(pluginPath),
      path: pluginPath,
      source: "local",
      ...(maybeString(manifest.description) ? { description: maybeString(manifest.description) } : {}),
      ...(maybeString(manifest.version) ? { version: maybeString(manifest.version) } : {}),
    };
  });
}

export function discoverClaudeOutputStyles(cwd: string): AgentChatClaudeOutputStyle[] {
  const byName = new Map<string, AgentChatClaudeOutputStyle>();
  const add = (style: AgentChatClaudeOutputStyle): void => {
    const key = styleKey(style.name);
    if (!key || byName.has(key)) return;
    byName.set(key, style);
  };

  for (const style of CLAUDE_BUILT_IN_OUTPUT_STYLES) add(style);

  const roots = claudeRootsByPrecedence(cwd);
  const homeClaudeRoot = path.resolve(os.homedir(), ".claude");
  const cwdClaudeRoot = path.resolve(cwd, ".claude");
  for (const root of roots) {
    const resolvedRoot = path.resolve(root);
    const source = resolvedRoot === cwdClaudeRoot ? "project" : resolvedRoot === homeClaudeRoot ? "user" : "project";
    for (const style of discoverOutputStyleFiles(path.join(root, "output-styles"), source)) add(style);
  }

  for (const pluginRoot of discoverClaudePluginPaths(cwd)) {
    for (const style of discoverOutputStyleFiles(path.join(pluginRoot, "output-styles"), "plugin", pluginRoot)) {
      add(style);
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

export function resolveClaudeOutputStyle(cwd: string, requestedName: string): AgentChatClaudeOutputStyle | null {
  const requestedKey = styleKey(requestedName);
  if (!requestedKey) return null;
  return discoverClaudeOutputStyles(cwd).find((style) => styleKey(style.name) === requestedKey) ?? null;
}

export function claudeSettingsLocalPath(cwd: string): string {
  return path.join(cwd, ".claude", "settings.local.json");
}

export function readClaudeSettingsLocal(cwd: string): ClaudeSettingsLocal {
  const settingsPath = claudeSettingsLocalPath(cwd);
  try {
    const raw = fs.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as ClaudeSettingsLocal
      : {};
  } catch {
    return {};
  }
}

export function readClaudeOutputStyleSelection(cwd: string): string {
  return maybeString(readClaudeSettingsLocal(cwd).outputStyle) ?? "Default";
}

export function writeClaudeOutputStyleSelection(cwd: string, outputStyle: string): string {
  const settingsPath = claudeSettingsLocalPath(cwd);
  const nextSettings: ClaudeSettingsLocal = {
    ...readClaudeSettingsLocal(cwd),
    outputStyle,
  };
  writeTextAtomic(settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`);
  return settingsPath;
}
