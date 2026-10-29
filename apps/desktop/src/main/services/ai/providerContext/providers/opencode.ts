/** OpenCode: AGENTS.md (or Claude Code's files), config `instructions`, MCP servers and plugins, skills, agents. */

import path from "node:path";

import type { ProviderContextItem } from "../../../../../shared/types/providerContext";
import type { AdeChatContextPreview } from "../../../chat/adeChatContextPreview";
import { claudeConfigHome, openCodeConfigDir } from "../../../shared/providerConfigHomes";
import { dirsTopDown, displayPath, readJsonCapped, type Ctx } from "../fsScan";
import {
  adeMcpItems,
  agentItems,
  envFlag,
  instructionFile,
  item,
  mcpItems,
  ownerFor,
  skillItems,
  type ProviderItems,
} from "../items";

export async function openCodeItems(ctx: Ctx, preview: AdeChatContextPreview | null): Promise<ProviderItems> {
  const items: ProviderContextItem[] = [];
  const homes = { env: ctx.env, homeDir: ctx.home };
  const configDir = openCodeConfigDir(homes);
  const claudeCompat = !envFlag(ctx.env, "OPENCODE_DISABLE_CLAUDE_CODE");
  const claudePrompt = claudeCompat && !envFlag(ctx.env, "OPENCODE_DISABLE_CLAUDE_CODE_PROMPT");
  const claudeSkills = claudeCompat && !envFlag(ctx.env, "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS");

  // Project: the first AGENTS.md walking up from the cwd, else CLAUDE.md.
  const projectDirs = dirsTopDown(ctx.cwd, ctx.gitRoot).reverse();
  let projectDoc: ProviderContextItem | null = null;
  for (const name of ["AGENTS.md", ...(claudePrompt ? ["CLAUDE.md"] : [])]) {
    for (const dir of projectDirs) {
      const found = await instructionFile(ctx, path.join(dir, name), { label: `Project ${name}` });
      if (found) {
        projectDoc = found.item;
        break;
      }
    }
    if (projectDoc) break;
  }
  if (projectDoc) items.push(projectDoc);
  const globalDoc = await instructionFile(ctx, path.join(configDir, "AGENTS.md"), { label: "Global AGENTS.md" })
    ?? (claudePrompt ? await instructionFile(ctx, path.join(claudeConfigHome(homes), "CLAUDE.md"), { label: "Global CLAUDE.md (Claude Code's)" }) : null);
  if (globalDoc) items.push(globalDoc.item);

  // Config documents: user, then project. `instructions`, `mcp` and `plugin` come from them.
  const configFiles = [
    path.join(configDir, "opencode.json"),
    path.join(configDir, "opencode.jsonc"),
    ...dirsTopDown(ctx.cwd, ctx.gitRoot).flatMap((dir) => [
      path.join(dir, "opencode.json"),
      path.join(dir, "opencode.jsonc"),
      path.join(dir, ".opencode", "opencode.json"),
      path.join(dir, ".opencode", "opencode.jsonc"),
    ]),
  ];
  const seenMcp = new Set<string>();
  items.push(...adeMcpItems(ctx, preview?.mcpServers ?? [], seenMcp));
  const plugins: ProviderContextItem[] = [];
  for (const file of configFiles) {
    const config = await readJsonCapped(ctx, file);
    if (!config) continue;
    for (const entry of Array.isArray(config.instructions) ? config.instructions : []) {
      if (typeof entry !== "string") continue;
      if (/^https?:/i.test(entry) || /[*?[]/.test(entry)) {
        items.push(item(ctx, {
          owner: ownerFor(ctx, file),
          kind: "instructions",
          label: `Instructions: ${/^https?:/i.test(entry) ? "a web address" : entry}`,
          setIn: displayPath(ctx.home, file),
          path: path.resolve(file),
          tokens: null,
          timing: "every-request",
          detail: "A pattern or web address in `instructions`; its size is known only when OpenCode loads it.",
        }));
        continue;
      }
      const target = entry.startsWith("~/") ? path.join(ctx.home, entry.slice(2)) : path.resolve(path.dirname(file), entry);
      const found = await instructionFile(ctx, target, { label: `Instructions: ${path.basename(target)}` });
      if (found) items.push(found.item);
    }
    items.push(...await mcpItems(ctx, [{ file, format: "json", key: "mcp", scope: ownerFor(ctx, file) === "project" ? "project" : "user" }], { seen: seenMcp }));
    for (const entry of Array.isArray(config.plugin) ? config.plugin : []) {
      if (typeof entry !== "string") continue;
      plugins.push(item(ctx, {
        owner: ownerFor(ctx, file),
        kind: "plugin",
        label: `Plugin: ${entry.replace(/^.*\//, "")}`,
        setIn: displayPath(ctx.home, file),
        path: path.resolve(file),
        tokens: null,
        timing: "every-request",
        detail: "A plugin runs code that can add tools or change the prompt; its effect is not known here.",
      }));
    }
  }
  items.push(...plugins);

  const seenSkills = new Set<string>();
  const projectSkillRoots = projectDirs.flatMap((dir) => [
    { dir: path.join(dir, ".opencode", "skills"), label: "Project skills" },
    ...(claudeSkills ? [{ dir: path.join(dir, ".claude", "skills"), label: "Project .claude skills" }] : []),
    { dir: path.join(dir, ".agents", "skills"), label: "Project .agents skills" },
  ]);
  items.push(...await skillItems(ctx, [
    ...projectSkillRoots,
    { dir: path.join(configDir, "skills"), label: "User skills" },
    ...(claudeSkills ? [{ dir: path.join(claudeConfigHome(homes), "skills"), label: "User .claude skills" }] : []),
    { dir: path.join(ctx.home, ".agents", "skills"), label: "User .agents skills" },
  ], { seen: seenSkills, detail: "Names and descriptions shown to the skill tool; each body loads when used." }));

  items.push(...await agentItems(ctx, [
    { dir: path.join(ctx.cwd, ".opencode", "agents"), label: "Project agents" },
    { dir: path.join(configDir, "agents"), label: "User agents" },
  ]));
  return { items, adeSkillsNative: true };
}
