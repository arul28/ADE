/** Claude Code: CLAUDE.md files and their imports, rules, memory, output style, skills, agents, plugins, MCP servers. */

import path from "node:path";

import type { ProviderContextItem } from "../../../../../shared/types/providerContext";
import type { AdeChatContextPreview } from "../../../chat/adeChatContextPreview";
import { isRecord, type McpConfigSource } from "../../../mcp/mcpProviderConfigScan";
import { pathsEqual } from "../../../shared/pathCompare";
import { claudeConfigHome, claudeManagedInstructionsFile } from "../../../shared/providerConfigHomes";
import { allAncestorsTopDown, dirsTopDown, exists, located, readJsonCapped, type Ctx } from "../fsScan";
import {
  adeThenConfigMcpItems,
  agentItems,
  envFlag,
  instructionFile,
  item,
  ruleItems,
  skillItems,
  sumTokens,
  type ProviderItems,
} from "../items";

const MAX_IMPORT_DEPTH = 5;
/** Claude loads the first 200 lines of MEMORY.md at start. */
const CLAUDE_MEMORY_LINES = 200;

// ---------------------------------------------------------------------------
// CLAUDE.md imports
// ---------------------------------------------------------------------------

/** `@path` imports outside code: the forms Claude Code documents. */
function claudeImportTargets(markdown: string): string[] {
  const withoutCode = markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]*`/g, "");
  const targets: string[] = [];
  for (const match of withoutCode.matchAll(/(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[\w.\-/]+[\w\-/])/g)) {
    const target = match[1]!;
    // An email address or a decorator is not an import.
    if (!target.includes("/") && !target.includes(".")) continue;
    targets.push(target);
  }
  return [...new Set(targets)];
}

async function claudeImports(ctx: Ctx, file: string, text: string, depth: number, seen: Set<string>): Promise<ProviderContextItem[]> {
  if (depth > MAX_IMPORT_DEPTH) return [];
  const children: ProviderContextItem[] = [];
  for (const target of claudeImportTargets(text)) {
    const resolved = target.startsWith("~/")
      ? path.join(ctx.home, target.slice(2))
      : path.resolve(path.dirname(file), target);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const found = await instructionFile(ctx, resolved, { label: `Import: ${path.basename(resolved)}`, detail: "Imported with @ from the file above." });
    if (!found) continue;
    const nested = await claudeImports(ctx, resolved, found.text, depth + 1, seen);
    children.push(nested.length
      ? { ...found.item, tokens: (found.item.tokens ?? 0) + sumTokens(nested), children: nested }
      : found.item);
  }
  return children;
}

async function claudeInstructionFile(ctx: Ctx, file: string, label: string, seen: Set<string>): Promise<ProviderContextItem | null> {
  const resolved = path.resolve(file);
  if (seen.has(resolved)) return null;
  seen.add(resolved);
  const found = await instructionFile(ctx, resolved, { label });
  if (!found) return null;
  const imports = await claudeImports(ctx, resolved, found.text, 1, seen);
  if (!imports.length) return found.item;
  return {
    ...found.item,
    tokens: (found.item.tokens ?? 0) + sumTokens(imports),
    detail: `Includes ${imports.length} imported file${imports.length === 1 ? "" : "s"}.`,
    children: imports,
  };
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export async function claudeItems(ctx: Ctx, preview: AdeChatContextPreview | null): Promise<ProviderItems> {
  const configDir = claudeConfigHome({ env: ctx.env, homeDir: ctx.home });
  const items: ProviderContextItem[] = [];
  const seenFiles = new Set<string>();

  // CLAUDE.md: managed policy, user, then every ancestor down to the cwd.
  const managed = claudeManagedInstructionsFile({ env: ctx.env });
  const managedItem = await claudeInstructionFile(ctx, managed, "Managed CLAUDE.md", seenFiles);
  if (managedItem) items.push({ ...managedItem, owner: "user" });
  const userItem = await claudeInstructionFile(ctx, path.join(configDir, "CLAUDE.md"), "User CLAUDE.md", seenFiles);
  if (userItem) items.push(userItem);
  for (const dir of allAncestorsTopDown(ctx.cwd)) {
    if (pathsEqual(dir, ctx.home)) continue;
    const where = dir === ctx.cwd ? "Project" : `Parent folder ${path.basename(dir)}`;
    for (const [rel, label] of [
      ["CLAUDE.md", `${where} CLAUDE.md`],
      [path.join(".claude", "CLAUDE.md"), `${where} .claude/CLAUDE.md`],
      ["CLAUDE.local.md", `${where} CLAUDE.local.md`],
    ] as const) {
      const found = await claudeInstructionFile(ctx, path.join(dir, rel), label, seenFiles);
      if (found) items.push(found);
    }
  }

  // Rules: user, then the project's.
  const ruleDirs = [
    { dir: path.join(configDir, "rules"), label: "User rules" },
    ...dirsTopDown(ctx.cwd, ctx.gitRoot).map((dir) => ({ dir: path.join(dir, ".claude", "rules"), label: "Project rules" })),
  ];
  items.push(...await ruleItems(ctx, ruleDirs, [".md"], (fm) => fm.paths != null || fm.globs != null));

  // Settings, merged user < project < local, for the few keys that decide what loads.
  const settingsFiles = [
    path.join(configDir, "settings.json"),
    ...(ctx.gitRoot ? [path.join(ctx.gitRoot, ".claude", "settings.json"), path.join(ctx.gitRoot, ".claude", "settings.local.json")] : []),
  ];
  const enabledPlugins = new Map<string, boolean>();
  let autoMemory = true;
  let outputStyle: string | null = null;
  for (const file of settingsFiles) {
    const settings = await readJsonCapped(ctx, file);
    if (!settings) continue;
    if (isRecord(settings.enabledPlugins)) {
      for (const [key, value] of Object.entries(settings.enabledPlugins)) enabledPlugins.set(key, value === true);
    }
    if (settings.autoMemoryEnabled === false) autoMemory = false;
    if (settings.autoMemoryEnabled === true) autoMemory = true;
    if (typeof settings.outputStyle === "string") outputStyle = settings.outputStyle;
  }
  if (envFlag(ctx.env, "CLAUDE_CODE_DISABLE_AUTO_MEMORY")) autoMemory = false;

  // Auto memory: the first 200 lines of the project's MEMORY.md.
  if (autoMemory) {
    const slug = (dir: string) => path.resolve(dir).replace(/[^A-Za-z0-9]/g, "-");
    const candidates = [...new Set([ctx.mainRoot, ctx.gitRoot, ctx.cwd].filter((dir): dir is string => Boolean(dir)))];
    for (const dir of candidates) {
      const found = await instructionFile(ctx, path.join(configDir, "projects", slug(dir), "memory", "MEMORY.md"), {
        label: "Auto memory (MEMORY.md)",
        kind: "memory",
        owner: "user",
        maxLines: CLAUDE_MEMORY_LINES,
        detail: "Claude's own notes for this project. Other memory files are read only when needed.",
      });
      if (found) {
        items.push(found.item);
        break;
      }
    }
  }

  // Output style, when the user picked one other than the default.
  if (outputStyle && outputStyle.toLowerCase() !== "default") {
    for (const dir of [path.join(ctx.cwd, ".claude", "output-styles"), path.join(configDir, "output-styles")]) {
      const found = await instructionFile(ctx, path.join(dir, `${outputStyle}.md`), {
        label: `Output style: ${outputStyle}`,
        kind: "system-prompt",
        detail: "Changes Claude Code's own prompt; ADE can override it per chat.",
      });
      if (found) {
        items.push(found.item);
        break;
      }
    }
  }

  // Skills Claude reads itself: the user's and each project folder's `.claude/skills`.
  const seenSkills = new Set<string>();
  items.push(...await skillItems(ctx, [
    ...dirsTopDown(ctx.cwd, ctx.gitRoot).reverse().map((dir) => ({ dir: path.join(dir, ".claude", "skills"), label: "Project skills" })),
    { dir: path.join(configDir, "skills"), label: "User skills" },
  ], { seen: seenSkills }));

  // Custom agents.
  items.push(...await agentItems(ctx, [
    { dir: path.join(ctx.cwd, ".claude", "agents"), label: "Project agents" },
    { dir: path.join(configDir, "agents"), label: "User agents" },
  ]));

  // Plugins the settings enable, with the skills, agents and commands each one lists.
  const installed = await readJsonCapped(ctx, path.join(configDir, "plugins", "installed_plugins.json"));
  const installedTable = isRecord(installed?.plugins) ? installed.plugins : {};
  for (const [key, enabled] of enabledPlugins) {
    if (!enabled) continue;
    const records = installedTable[key];
    const list = Array.isArray(records) ? records.filter(isRecord) : isRecord(records) ? [records] : [];
    const record = list.find((entry) => entry.scope === "user") ?? list[list.length - 1];
    const installPath = typeof record?.installPath === "string" ? record.installPath : null;
    const children: ProviderContextItem[] = [];
    if (installPath) {
      const pluginName = key.split("@")[0] ?? key;
      for (const skillItem of await skillItems(ctx, [{ dir: path.join(installPath, "skills"), label: "Skills", owner: "user" }])) {
        children.push(...(skillItem.children ?? []).map((child) => ({ ...child, label: `${pluginName}:${child.label}` })));
      }
      for (const agentItem of await agentItems(ctx, [{ dir: path.join(installPath, "agents"), label: "Agents" }])) {
        children.push(...(agentItem.children ?? []).map((child) => ({ ...child, owner: "user" as const })));
      }
      for (const commandItem of await agentItems(ctx, [{ dir: path.join(installPath, "commands"), label: "Commands" }])) {
        children.push(...(commandItem.children ?? []).map((child) => ({ ...child, owner: "user" as const, kind: "other" as const })));
      }
      if (await exists(path.join(installPath, ".mcp.json"))) {
        children.push(item(ctx, {
          owner: "user",
          kind: "mcp-server",
          label: "Plugin MCP servers",
          ...located(ctx, path.join(installPath, ".mcp.json")),
          tokens: null,
          timing: "every-request",
          detail: "Tools arrive when the servers connect.",
        }));
      }
    }
    items.push(item(ctx, {
      owner: "user",
      kind: "plugin",
      label: `Plugin: ${key}`,
      ...(installPath ? located(ctx, installPath) : { setIn: "settings.json › enabledPlugins" }),
      tokens: children.some((child) => child.tokens != null) ? sumTokens(children) : null,
      timing: "every-request",
      detail: installPath ? "Its skills, agents and commands are listed by name and description." : "Enabled, but not installed on this computer.",
      children,
    }));
  }

  // MCP servers: the launch's config home, the machine login's (an ADE account
  // home is handed those too), and the project's `.mcp.json`.
  const projectKeys = [...new Set([ctx.cwd, ctx.gitRoot, ctx.mainRoot].filter((dir): dir is string => Boolean(dir)))];
  const claudeJsonFiles = [...new Set([
    ctx.env.CLAUDE_CONFIG_DIR?.trim() ? path.join(configDir, ".claude.json") : path.join(ctx.home, ".claude.json"),
    path.join(ctx.home, ".claude.json"),
  ])];
  const mcpSources: McpConfigSource[] = [];
  for (const file of claudeJsonFiles) {
    for (const projectKey of projectKeys) mcpSources.push({ file, format: "json", key: "mcpServers", scope: "local", projectKey });
    mcpSources.push({ file, format: "json", key: "mcpServers", scope: "user" });
  }
  mcpSources.push({ file: path.join(ctx.gitRoot ?? ctx.cwd, ".mcp.json"), format: "json", key: "mcpServers", scope: "project" });
  items.push(...await adeThenConfigMcpItems(ctx, preview, mcpSources));

  return { items, adeSkillsNative: true };
}
