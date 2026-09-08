/**
 * Codex 0.153.4 `plugin/list` (`PluginListResponse`: marketplaces → PluginSummary).
 * Settings shows installed / enabled plugins only — no marketplace, no toggle.
 * https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/codex-rs/app-server-protocol/schema/json/v2/PluginListResponse.json
 */

import type { AgentChatCodexPlugin, AgentChatCodexPluginOrigin } from "./types/chat";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function pluginOrigin(
  source: unknown,
  marketplaceName: string | null,
  installPolicy: string | null,
): AgentChatCodexPluginOrigin {
  const sourceType = isRecord(source) ? stringField(source.type)?.toLowerCase() : null;
  if (sourceType === "remote") return "remote";
  const market = (marketplaceName ?? "").toLowerCase();
  if (
    market.includes("bundled")
    || market === "openai"
    || installPolicy === "INSTALLED_BY_DEFAULT"
  ) {
    return "bundled";
  }
  return "local";
}

function parsePluginSummary(
  value: unknown,
  marketplaceName: string | null,
): AgentChatCodexPlugin | null {
  if (!isRecord(value)) return null;
  const name = stringField(value.name) ?? stringField(value.pluginName);
  const id = stringField(value.id) ?? name;
  if (!name || !id) return null;
  const installed = value.installed !== false;
  const enabled = value.enabled === true;
  if (!installed && !enabled) return null;
  const origin = pluginOrigin(
    value.source,
    marketplaceName,
    stringField(value.installPolicy) ?? stringField(value.install_policy),
  );
  if (origin === "remote" && !installed) return null;
  return {
    id,
    name,
    enabled,
    installed,
    origin,
    ...(marketplaceName ? { marketplaceName } : {}),
  };
}

function collectFromMarketplaces(marketplaces: unknown): AgentChatCodexPlugin[] {
  if (!Array.isArray(marketplaces)) return [];
  const plugins: AgentChatCodexPlugin[] = [];
  const seen = new Set<string>();
  for (const marketplace of marketplaces) {
    if (!isRecord(marketplace)) continue;
    const marketplaceName = stringField(marketplace.name);
    const entries = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
    for (const entry of entries) {
      const plugin = parsePluginSummary(entry, marketplaceName);
      if (!plugin || seen.has(plugin.id)) continue;
      seen.add(plugin.id);
      plugins.push(plugin);
    }
  }
  return plugins;
}

export function parseCodexPluginList(payload: unknown): AgentChatCodexPlugin[] {
  if (!isRecord(payload)) return [];
  const fromMarketplaces = collectFromMarketplaces(payload.marketplaces);
  if (fromMarketplaces.length) return fromMarketplaces;
  const direct = Array.isArray(payload.plugins) ? payload.plugins : [];
  const plugins: AgentChatCodexPlugin[] = [];
  const seen = new Set<string>();
  for (const entry of direct) {
    const plugin = parsePluginSummary(entry, stringField(isRecord(entry) ? entry.marketplaceName : null));
    if (!plugin || seen.has(plugin.id)) continue;
    seen.add(plugin.id);
    plugins.push(plugin);
  }
  return plugins;
}
