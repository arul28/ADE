/** Codex: AGENTS.md files under `project_doc_max_bytes`, skills, MCP servers in config.toml. */

import path from "node:path";

import type { ProviderContextItem } from "../../../../../shared/types/providerContext";
import type { AdeChatContextPreview } from "../../../chat/adeChatContextPreview";
import type { McpConfigSource } from "../../../mcp/mcpProviderConfigScan";
import { codexConfigHome } from "../../../shared/providerConfigHomes";
import { dirsTopDown, MAX_CONFIG_BYTES, readTextCapped, type Ctx } from "../fsScan";
import {
  adeThenConfigMcpItems,
  applyByteBudget,
  firstInstructionFile,
  folderLabel,
  skillItems,
  type LoadedFile,
  type ProviderItems,
} from "../items";

/** Codex's default `project_doc_max_bytes`. */
const CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024;

function parseTomlTopLevel(text: string): { maxBytes: number | null; fallbacks: string[] } {
  const top = text.split(/^\s*\[/m)[0] ?? "";
  const max = top.match(/^\s*project_doc_max_bytes\s*=\s*(\d+)/m)?.[1];
  const fallbacks = top.match(/^\s*project_doc_fallback_filenames\s*=\s*\[([^\]]*)\]/m)?.[1];
  return {
    maxBytes: max ? Number(max) : null,
    fallbacks: fallbacks ? [...fallbacks.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]!) : [],
  };
}

function codexProjectTrusted(text: string, dirs: readonly string[]): boolean {
  for (const dir of dirs) {
    const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const section = text.match(new RegExp(`^\\s*\\[projects\\.["']${escaped}["']\\]\\s*$([\\s\\S]*?)(?=^\\s*\\[|$(?![\\s\\S]))`, "m"))?.[1];
    if (section && /^\s*trust_level\s*=\s*["']trusted["']/m.test(section)) return true;
  }
  return false;
}

export async function codexItems(ctx: Ctx, preview: AdeChatContextPreview | null): Promise<ProviderItems> {
  const home = codexConfigHome({ env: ctx.env, homeDir: ctx.home });
  const items: ProviderContextItem[] = [];
  const configText = (await readTextCapped(ctx, path.join(home, "config.toml"), MAX_CONFIG_BYTES))?.text ?? "";
  const { maxBytes, fallbacks } = parseTomlTopLevel(configText);
  const cap = maxBytes ?? CODEX_PROJECT_DOC_MAX_BYTES;

  const globalDoc = await firstInstructionFile(ctx, home, ["AGENTS.override.md", "AGENTS.md"], (name) => `Global ${name}`);
  if (globalDoc) items.push(globalDoc.item);

  // Project docs, root to cwd, one per folder, under one shared byte cap.
  if (cap > 0) {
    const docs: LoadedFile[] = [];
    for (const dir of dirsTopDown(ctx.cwd, ctx.gitRoot)) {
      const found = await firstInstructionFile(ctx, dir, ["AGENTS.override.md", "AGENTS.md", ...fallbacks],
        (name) => `${folderLabel(ctx, dir)} ${name}`);
      if (found) docs.push(found);
    }
    items.push(...applyByteBudget(docs, cap, {
      fillFrom: "start",
      cut: `Cut at project_doc_max_bytes (${cap} bytes).`,
      dropped: `Not loaded: project_doc_max_bytes (${cap} bytes) is already used up.`,
    }));
  }

  const seenSkills = new Set<string>();
  items.push(...await skillItems(ctx, [
    ...dirsTopDown(ctx.cwd, ctx.gitRoot).reverse().map((dir) => ({ dir: path.join(dir, ".agents", "skills"), label: "Project skills" })),
    { dir: path.join(ctx.home, ".agents", "skills"), label: "User skills" },
    { dir: path.join(home, "skills"), label: "Codex skills" },
  ], { seen: seenSkills, detail: "Names and descriptions; Codex shortens them when the list is long." }));

  const projectDirs = [ctx.cwd, ctx.gitRoot, ctx.mainRoot].filter((dir): dir is string => Boolean(dir));
  const sources: McpConfigSource[] = [];
  if (codexProjectTrusted(configText, projectDirs)) {
    for (const dir of dirsTopDown(ctx.cwd, ctx.gitRoot).reverse()) {
      sources.push({ file: path.join(dir, ".codex", "config.toml"), format: "toml", key: "mcp_servers", scope: "project" });
    }
  }
  sources.push({ file: path.join(home, "config.toml"), format: "toml", key: "mcp_servers", scope: "user" });
  items.push(...await adeThenConfigMcpItems(ctx, preview, sources));
  return { items, adeSkillsNative: true };
}
