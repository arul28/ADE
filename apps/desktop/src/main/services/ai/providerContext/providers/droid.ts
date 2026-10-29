/** Droid: AGENTS.md and CLAUDE.md files, skills, custom droids, MCP servers. */

import path from "node:path";

import type { ProviderContextItem } from "../../../../../shared/types/providerContext";
import type { AdeChatContextPreview } from "../../../chat/adeChatContextPreview";
import { providerMcpConfigSources } from "../../../mcp/mcpProviderConfigScan";
import { factoryConfigHome } from "../../../shared/providerConfigHomes";
import { dirsTopDown, type Ctx } from "../fsScan";
import {
  adeThenConfigMcpItems,
  agentItems,
  folderLabel,
  instructionFile,
  skillItems,
  type ProviderItems,
} from "../items";

export async function droidItems(ctx: Ctx, preview: AdeChatContextPreview | null): Promise<ProviderItems> {
  const factory = factoryConfigHome({ env: ctx.env, homeDir: ctx.home });
  const items: ProviderContextItem[] = [];
  for (const dir of dirsTopDown(ctx.cwd, ctx.gitRoot)) {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const found = await instructionFile(ctx, path.join(dir, name), { label: `${folderLabel(ctx, dir)} ${name}` });
      if (found) items.push(found.item);
    }
  }
  const seenSkills = new Set<string>();
  const projectDirs = [...new Set([ctx.cwd, ctx.gitRoot].filter((dir): dir is string => Boolean(dir)))];
  items.push(...await skillItems(ctx, [
    ...projectDirs.flatMap((dir) => [".factory", ".agents", ".agent"].map((sub) => ({ dir: path.join(dir, sub, "skills"), label: `Project ${sub} skills` }))),
    { dir: path.join(factory, "skills"), label: "User .factory skills" },
    { dir: path.join(ctx.home, ".agents", "skills"), label: "User .agents skills" },
    { dir: path.join(ctx.home, ".agent", "skills"), label: "User .agent skills" },
  ], { seen: seenSkills }));
  items.push(...await agentItems(ctx, [
    { dir: path.join(ctx.cwd, ".factory", "droids"), label: "Project droids" },
    { dir: path.join(factory, "droids"), label: "User droids" },
  ]));
  // `.factory/mcp.json` in the folder and every folder above it, then the user's.
  items.push(...await adeThenConfigMcpItems(ctx, preview, providerMcpConfigSources("droid", { cwd: ctx.cwd, env: ctx.env, homeDir: ctx.home })));
  return { items, adeSkillsNative: false };
}
