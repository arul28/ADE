import fs from "node:fs";
import path from "node:path";

import {
  readCliProxyApiConfig,
  writeCliProxyApiConfig,
  type CliProxyApiConfig,
} from "./cliProxyApiConfig";
import type { PrivateFileSecurityOptions } from "../../lib/trustedWindowsTools";

/**
 * Upstreams ADE adds to its local CLIProxyAPI for routes that need translation.
 *
 * A harness that cannot speak a model's protocol directly (Claude Code on an
 * OpenAI-chat-only model, Codex on an Anthropic-only one) is pointed at the
 * proxy instead. The proxy needs to know the real endpoint and key, and that
 * lives here: one entry per source, named `ade-…`, written into the proxy's
 * own config file. CLIProxyAPI watches that file and reloads it live, so an
 * upsert takes effect without a restart.
 *
 * Only entries marked with `ade-id` (or, for OpenAI-compatible entries, a
 * `name` starting with {@link ADE_UPSTREAM_PREFIX}) are ADE's; anything else in
 * those sections is left exactly as found.
 *
 * WHY no routing prefix: ADE runs the proxy with `force-model-prefix`, under
 * which an unprefixed request only reaches credentials that have no prefix. A
 * routed chat asks for the model by its real id (`glm-5.3`) — Codex alone
 * re-sends `session.model` from twenty places — so ADE's entries are left
 * unprefixed and a model id is owned by exactly one ADE entry at a time.
 */

export const ADE_UPSTREAM_PREFIX = "ade-";

export type ProxyUpstreamProtocol = "anthropic" | "openai-chat" | "openai-responses";

export type ProxyUpstream = {
  /** Stable id naming the source (`ade-opencode-go`). Not a routing prefix. */
  id: string;
  protocol: ProxyUpstreamProtocol;
  /** Anthropic: API root without `/v1`. OpenAI: base including `/v1`. */
  baseUrl: string;
  apiKey: string;
  /**
   * Static or pass-through headers. A value starting with `$` copies that
   * header from the client's request, which is how a harness's per-session
   * `x-opencode-session` reaches OpenCode Go through the proxy.
   */
  headers?: Record<string, string>;
  models: Array<{ name: string; contextWindow?: number }>;
};

const SECTION_FOR_PROTOCOL: Record<ProxyUpstreamProtocol, "openai-compatibility" | "claude-api-key" | "codex-api-key"> = {
  "openai-chat": "openai-compatibility",
  anthropic: "claude-api-key",
  "openai-responses": "codex-api-key",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function entryId(entry: unknown): string | null {
  if (!isRecord(entry)) return null;
  const id = typeof entry["ade-id"] === "string" ? entry["ade-id"] : typeof entry.name === "string" ? entry.name : null;
  return id && id.startsWith(ADE_UPSTREAM_PREFIX) ? id : null;
}

function existingModelNames(entry: unknown): string[] {
  if (!isRecord(entry) || !Array.isArray(entry.models)) return [];
  return entry.models
    .map((model) => (isRecord(model) && typeof model.name === "string" ? model.name : null))
    .filter((name): name is string => Boolean(name));
}

function renderModels(upstream: ProxyUpstream, keepNames: readonly string[]): Array<Record<string, unknown>> {
  const byName = new Map<string, { name: string; contextWindow?: number }>();
  for (const name of keepNames) byName.set(name, { name });
  for (const model of upstream.models) byName.set(model.name, model);
  return [...byName.values()].map((model) => ({
    name: model.name,
    alias: model.name,
    ...(model.contextWindow && model.contextWindow > 0 ? { "max-context-length": model.contextWindow } : {}),
  }));
}

function renderEntry(upstream: ProxyUpstream, keepNames: readonly string[]): Record<string, unknown> {
  const headers = upstream.headers && Object.keys(upstream.headers).length ? { headers: upstream.headers } : {};
  const models = renderModels(upstream, keepNames);
  if (upstream.protocol === "openai-chat") {
    return {
      name: upstream.id,
      "ade-id": upstream.id,
      "base-url": upstream.baseUrl,
      ...headers,
      "api-key-entries": [{ "api-key": upstream.apiKey }],
      models,
    };
  }
  return {
    "ade-id": upstream.id,
    "api-key": upstream.apiKey,
    "base-url": upstream.baseUrl,
    ...headers,
    models,
  };
}

/**
 * Add or refresh one ADE upstream in the proxy config at `configPath`.
 *
 * Models accumulate: a second launch on another model of the same source adds
 * that model rather than replacing the first, so two chats on one source can
 * run side by side. The key is always rewritten, which is how a rotated
 * OpenCode token reaches the proxy. Returns false when the proxy has never
 * written its config (it has not started yet) — the caller treats that as
 * "proxy not ready".
 */
export function upsertCliProxyApiUpstream(
  configPath: string,
  upstream: ProxyUpstream,
  security: PrivateFileSecurityOptions = {},
): boolean {
  if (!fs.existsSync(configPath)) return false;
  const config: CliProxyApiConfig = readCliProxyApiConfig(configPath);
  const section = SECTION_FOR_PROTOCOL[upstream.protocol];
  const entries = Array.isArray(config[section]) ? [...(config[section] as unknown[])] : [];
  const index = entries.findIndex((entry) => entryId(entry) === upstream.id);
  const keep = index >= 0 ? existingModelNames(entries[index]) : [];
  const next = renderEntry(upstream, keep);
  if (index >= 0) {
    if (JSON.stringify(entries[index]) === JSON.stringify(next)) return true;
    entries[index] = next;
  } else {
    entries.push(next);
  }
  config[section] = entries;
  // One source lives in exactly one section — a source whose protocol changed
  // (a probe corrected it) must not leave a stale twin elsewhere — and one
  // unprefixed model id belongs to exactly one ADE entry, or the proxy would
  // round-robin a model's requests across two different vendors.
  const claimed = new Set(upstream.models.map((model) => model.name));
  for (const other of Object.values(SECTION_FOR_PROTOCOL)) {
    if (!Array.isArray(config[other])) continue;
    config[other] = (config[other] as unknown[])
      .filter((entry) => other === section || entryId(entry) !== upstream.id)
      .map((entry) => {
        const id = entryId(entry);
        if (!id || id === upstream.id || !isRecord(entry) || !Array.isArray(entry.models)) return entry;
        const models = entry.models.filter((model) => !(isRecord(model) && claimed.has(String(model.name))));
        return models.length === entry.models.length ? entry : { ...entry, models };
      });
  }
  writeCliProxyApiConfig(configPath, config, security);
  return true;
}

/** Drop ADE upstreams whose id is not in `keepIds` (a removed key or sign-out). */
export function pruneCliProxyApiUpstreams(
  configPath: string,
  keepIds: ReadonlySet<string>,
  security: PrivateFileSecurityOptions = {},
): void {
  if (!fs.existsSync(configPath)) return;
  const config = readCliProxyApiConfig(configPath);
  let changed = false;
  for (const section of Object.values(SECTION_FOR_PROTOCOL)) {
    const entries = config[section];
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((entry) => {
      const id = entryId(entry);
      return id === null || keepIds.has(id);
    });
    if (kept.length !== entries.length) {
      config[section] = kept;
      changed = true;
    }
  }
  if (changed) writeCliProxyApiConfig(configPath, config, security);
}

export function cliProxyApiConfigPath(adeHome: string): string {
  return path.join(adeHome, "proxy", "config.yaml");
}
