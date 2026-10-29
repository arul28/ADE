/** Kimi Code: AGENTS.md files under one 32 KB budget, skills, MCP servers. */

import path from "node:path";

import type { ProviderContextItem } from "../../../../../shared/types/providerContext";
import type { AdeChatContextPreview } from "../../../chat/adeChatContextPreview";
import { providerMcpConfigSources } from "../../../mcp/mcpProviderConfigScan";
import { kimiCodeConfigHome } from "../../../shared/providerConfigHomes";
import { dirsTopDown, type Ctx } from "../fsScan";
import {
  adeThenConfigMcpItems,
  applyByteBudget,
  folderLabel,
  instructionFile,
  skillItems,
  type LoadedFile,
  type ProviderItems,
} from "../items";

/** Kimi's documented AGENTS.md budget. */
const KIMI_AGENTS_MAX_BYTES = 32 * 1024;

export async function kimiItems(ctx: Ctx, preview: AdeChatContextPreview | null): Promise<ProviderItems> {
  const home = kimiCodeConfigHome({ env: ctx.env, homeDir: ctx.home });
  const items: ProviderContextItem[] = [];
  // Root to cwd, deeper files first under one 32 KiB budget.
  const docs: LoadedFile[] = [];
  for (const dir of dirsTopDown(ctx.cwd, ctx.gitRoot)) {
    for (const rel of ["AGENTS.md", path.join(".kimi", "AGENTS.md")]) {
      const found = await instructionFile(ctx, path.join(dir, rel), { label: `${folderLabel(ctx, dir)} ${rel}` });
      if (found) docs.push(found);
    }
  }
  const cut = "Cut to fit Kimi's 32 KB AGENTS.md budget.";
  items.push(...applyByteBudget(docs, KIMI_AGENTS_MAX_BYTES, { fillFrom: "end", cut, dropped: cut }));
  const seenSkills = new Set<string>();
  items.push(...await skillItems(ctx, [
    { dir: path.join(ctx.cwd, ".agents", "skills"), label: "Project .agents skills" },
    { dir: path.join(home, "skills"), label: "User skills" },
    { dir: path.join(ctx.home, ".agents", "skills"), label: "User .agents skills" },
  ], { seen: seenSkills }));
  items.push(...await adeThenConfigMcpItems(ctx, preview, providerMcpConfigSources("kimi", { cwd: ctx.cwd, env: ctx.env, homeDir: ctx.home })));
  return { items, adeSkillsNative: false };
}
