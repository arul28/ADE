/** Pi: APPEND_SYSTEM.md, context files by Pi's loader, and Pi's own MCP config. */

import path from "node:path";

import type { ProviderContextItem } from "../../../../../shared/types/providerContext";
import { isPathInside, pathsEqual } from "../../../shared/pathCompare";
import { piAgentDir } from "../../../shared/providerConfigHomes";
import { allAncestorsTopDown, exists, type Ctx } from "../fsScan";
import { firstInstructionFile, folderLabel, instructionFile, mcpItems, type ProviderItems } from "../items";

export async function piItems(ctx: Ctx): Promise<ProviderItems> {
  const agentDir = piAgentDir({ env: ctx.env, homeDir: ctx.home });
  const items: ProviderContextItem[] = [];
  const names = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
  const append = await instructionFile(ctx, path.join(agentDir, "APPEND_SYSTEM.md"), {
    label: "APPEND_SYSTEM.md",
    kind: "system-prompt",
    detail: "Added to the system prompt. ADE runs Pi untrusted, so a project's own file is not read.",
  });
  if (append) items.push(append.item);
  const global = await firstInstructionFile(ctx, agentDir, names, (name) => `Global ${name}`);
  if (global) items.push(global.item);
  // A linked worktree nested inside its main checkout shadows the main
  // checkout's file of the same name (Pi's `findShadowedContextFile`).
  const nested = ctx.gitRoot && ctx.mainRoot && !pathsEqual(ctx.gitRoot, ctx.mainRoot)
    && isPathInside(ctx.gitRoot, ctx.mainRoot);
  let shadowed: string | null = null;
  if (nested) {
    for (const name of names) {
      if (await exists(path.join(ctx.gitRoot!, name))) {
        shadowed = path.join(ctx.mainRoot!, name);
        break;
      }
    }
  }
  for (const dir of allAncestorsTopDown(ctx.cwd)) {
    if (pathsEqual(dir, agentDir)) continue;
    const found = await firstInstructionFile(ctx, dir, names, (name) => `${folderLabel(ctx, dir)} ${name}`);
    if (found && !(shadowed && pathsEqual(found.item.path, shadowed))) items.push(found.item);
  }
  items.push(...await mcpItems(ctx, [{ file: path.join(agentDir, "mcp.json"), format: "json", key: "mcpServers", scope: "user" }], {
    detail: "Pi's own MCP config: used only when MCP is on for Pi chats in ADE. Its tools arrive when it connects.",
  }));
  return { items, adeSkillsNative: true };
}
