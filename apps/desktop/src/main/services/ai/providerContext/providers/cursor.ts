/** Cursor: project rules, AGENTS.md, skills, MCP servers; user and team rules live in Cursor's settings. */

import path from "node:path";

import type { ProviderContextItem } from "../../../../../shared/types/providerContext";
import type { AdeChatContextPreview } from "../../../chat/adeChatContextPreview";
import { frontmatterFlag } from "../../../chat/markdownSlashCommandDiscovery";
import type { Ctx } from "../fsScan";
import {
  adeThenConfigMcpItems,
  instructionFile,
  item,
  ruleItems,
  skillItems,
  type ProviderItems,
} from "../items";

export async function cursorItems(ctx: Ctx, preview: AdeChatContextPreview | null): Promise<ProviderItems> {
  const items: ProviderContextItem[] = [];
  const root = ctx.gitRoot ?? ctx.cwd;
  items.push(...await ruleItems(ctx, [...new Set([root, ctx.cwd])].map((dir) => ({
    dir: path.join(dir, ".cursor", "rules"),
    label: "Project rules",
  })), [".mdc", ".md"], (fm) => frontmatterFlag(fm.alwaysApply) !== true));
  for (const dir of [...new Set([root, ctx.cwd])]) {
    const found = await instructionFile(ctx, path.join(dir, "AGENTS.md"), { label: `${dir === root ? "Project" : "Folder"} AGENTS.md` });
    if (found) items.push(found.item);
  }
  const seenSkills = new Set<string>();
  items.push(...await skillItems(ctx, [
    { dir: path.join(ctx.cwd, ".cursor", "skills"), label: "Project .cursor skills" },
    { dir: path.join(ctx.cwd, ".agents", "skills"), label: "Project .agents skills" },
    { dir: path.join(ctx.home, ".cursor", "skills"), label: "User skills" },
  ], { seen: seenSkills }));
  items.push(...await adeThenConfigMcpItems(ctx, preview, [
    { file: path.join(root, ".cursor", "mcp.json"), format: "json", key: "mcpServers", scope: "project" },
    { file: path.join(ctx.home, ".cursor", "mcp.json"), format: "json", key: "mcpServers", scope: "user" },
  ]));
  items.push(item(ctx, {
    owner: "user",
    kind: "rule",
    label: "User and team rules",
    setIn: "Cursor Settings › Rules",
    tokens: null,
    timing: "every-request",
    detail: "Kept in Cursor's own settings and account, so they cannot be read here.",
  }));
  return { items, adeSkillsNative: true };
}
