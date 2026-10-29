/**
 * The providers that do not document what else they load: Grok, Devin and
 * Antigravity list only the MCP servers their own config files name, and Muse
 * lists its skills and plugins only inside a running session.
 */

import type { AdeChatContextPreview } from "../../../chat/adeChatContextPreview";
import { providerMcpConfigSources } from "../../../mcp/mcpProviderConfigScan";
import type { Ctx } from "../fsScan";
import { adeMcpItems, adeThenConfigMcpItems, type ProviderItems } from "../items";

/** ADE's MCP servers and the ones `provider`'s config files name. */
export function configMcpOnlyItems(provider: "grok" | "devin" | "antigravity") {
  return async (ctx: Ctx, preview: AdeChatContextPreview | null): Promise<ProviderItems> => ({
    items: await adeThenConfigMcpItems(ctx, preview, providerMcpConfigSources(provider, { cwd: ctx.cwd, env: ctx.env, homeDir: ctx.home })),
    adeSkillsNative: false,
  });
}

/** Muse: ADE's MCP servers only. */
export async function museItems(ctx: Ctx, preview: AdeChatContextPreview | null): Promise<ProviderItems> {
  return { items: adeMcpItems(ctx, preview?.mcpServers ?? [], new Set()), adeSkillsNative: false };
}
