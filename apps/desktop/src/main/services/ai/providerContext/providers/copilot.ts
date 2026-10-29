/** Copilot: instruction files and folders, skills, agents, MCP servers. */

import path from "node:path";

import type { ProviderContextItem } from "../../../../../shared/types/providerContext";
import type { AdeChatContextPreview } from "../../../chat/adeChatContextPreview";
import { copilotConfigHome } from "../../../shared/providerConfigHomes";
import { dirsTopDown, type Ctx } from "../fsScan";
import {
  adeThenConfigMcpItems,
  agentItems,
  instructionFile,
  ruleItems,
  skillItems,
  type ProviderItems,
} from "../items";

export async function copilotItems(ctx: Ctx, preview: AdeChatContextPreview | null): Promise<ProviderItems> {
  const home = copilotConfigHome({ env: ctx.env, homeDir: ctx.home });
  const items: ProviderContextItem[] = [];
  const global = await instructionFile(ctx, path.join(home, "copilot-instructions.md"), { label: "Global copilot-instructions.md" });
  if (global) items.push(global.item);
  const applyTo = (fm: Record<string, unknown>) => {
    const value = fm.applyTo;
    return value != null && !(typeof value === "string" && value.trim() === "**");
  };
  const extraDirs = (ctx.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS ?? "").split(path.delimiter).map((dir) => dir.trim()).filter(Boolean);
  items.push(...await ruleItems(ctx, [
    { dir: path.join(home, "instructions"), label: "Global instructions" },
    ...extraDirs.map((dir) => ({ dir, label: "Extra instructions" })),
  ], [".instructions.md"], applyTo));

  const root = ctx.gitRoot ?? ctx.cwd;
  for (const dir of [...new Set([root, ctx.cwd])]) {
    for (const rel of [path.join(".github", "copilot-instructions.md"), "AGENTS.md", "CLAUDE.md"]) {
      const found = await instructionFile(ctx, path.join(dir, rel), { label: `${dir === root ? "Repository" : "Folder"} ${rel}` });
      if (found) items.push(found.item);
    }
  }
  items.push(...await ruleItems(ctx, [
    { dir: path.join(root, ".github", "instructions"), label: "Repository instructions" },
    { dir: path.join(root, ".claude", "rules"), label: "Repository .claude rules" },
  ], [".md"], (fm) => applyTo(fm) || fm.paths != null));

  const seenSkills = new Set<string>();
  items.push(...await skillItems(ctx, [
    { dir: path.join(ctx.cwd, ".github", "skills"), label: "Project .github skills" },
    { dir: path.join(ctx.cwd, ".agents", "skills"), label: "Project .agents skills" },
    { dir: path.join(ctx.cwd, ".claude", "skills"), label: "Project .claude skills" },
    ...dirsTopDown(ctx.cwd, ctx.gitRoot).reverse().slice(1).map((dir) => ({ dir: path.join(dir, ".github", "skills"), label: "Parent .github skills" })),
    { dir: path.join(home, "skills"), label: "User Copilot skills" },
    { dir: path.join(ctx.home, ".agents", "skills"), label: "User .agents skills" },
  ], { seen: seenSkills }));

  items.push(...await agentItems(ctx, [
    { dir: path.join(root, ".github", "agents"), label: "Repository agents" },
    { dir: path.join(home, "agents"), label: "User agents" },
  ]));

  items.push(...await adeThenConfigMcpItems(ctx, preview, [
    { file: path.join(root, ".mcp.json"), format: "json", key: "mcpServers", scope: "project" },
    { file: path.join(home, "mcp-config.json"), format: "json", key: "mcpServers", scope: "user" },
  ]));
  return { items, adeSkillsNative: true };
}
