/** Qwen Code: QWEN.md (or the configured context file names), skills, MCP servers in settings.json. */

import path from "node:path";

import type { ProviderContextItem } from "../../../../../shared/types/providerContext";
import type { AdeChatContextPreview } from "../../../chat/adeChatContextPreview";
import { isRecord, providerMcpConfigSources } from "../../../mcp/mcpProviderConfigScan";
import { qwenConfigHome } from "../../../shared/providerConfigHomes";
import { dirsTopDown, readJsonCapped, type Ctx } from "../fsScan";
import {
  adeThenConfigMcpItems,
  folderLabel,
  instructionFile,
  skillItems,
  type ProviderItems,
} from "../items";

export async function qwenItems(ctx: Ctx, preview: AdeChatContextPreview | null): Promise<ProviderItems> {
  const home = qwenConfigHome({ env: ctx.env, homeDir: ctx.home });
  const items: ProviderContextItem[] = [];
  const userSettings = await readJsonCapped(ctx, path.join(home, "settings.json"));
  const projectSettings = await readJsonCapped(ctx, path.join(ctx.cwd, ".qwen", "settings.json"));
  const contextNames = (() => {
    for (const settings of [projectSettings, userSettings]) {
      const value = isRecord(settings?.context) ? settings.context.fileName : undefined;
      if (typeof value === "string" && value.trim()) return [value.trim()];
      if (Array.isArray(value)) {
        const names = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
        if (names.length) return names;
      }
    }
    return ["QWEN.md"];
  })();
  for (const name of contextNames) {
    const global = await instructionFile(ctx, path.join(home, name), { label: `Global ${name}` });
    if (global) items.push(global.item);
    for (const dir of dirsTopDown(ctx.cwd, ctx.gitRoot)) {
      const found = await instructionFile(ctx, path.join(dir, name), { label: `${folderLabel(ctx, dir)} ${name}` });
      if (found) items.push(found.item);
    }
  }
  const disabled = new Set<string>();
  for (const settings of [userSettings, projectSettings]) {
    const list = isRecord(settings?.skills) ? settings.skills.disabled : undefined;
    if (Array.isArray(list)) for (const name of list) if (typeof name === "string") disabled.add(name.toLowerCase());
  }
  const seenSkills = new Set<string>(disabled);
  items.push(...await skillItems(ctx, [
    { dir: path.join(ctx.cwd, ".qwen", "skills"), label: "Project skills" },
    { dir: path.join(ctx.cwd, ".agents", "skills"), label: "Project .agents skills" },
    { dir: path.join(home, "skills"), label: "User skills" },
    { dir: path.join(ctx.home, ".agents", "skills"), label: "User .agents skills" },
  ], { seen: seenSkills }));
  items.push(...await adeThenConfigMcpItems(ctx, preview, providerMcpConfigSources("qwen", { cwd: ctx.cwd, env: ctx.env, homeDir: ctx.home })));
  return { items, adeSkillsNative: true };
}
