import fs from "node:fs";

import {
  CLI_PROXY_API_UPSTREAM_SECTIONS,
  readCliProxyApiConfig,
  withCliProxyApiConfigLock,
  writeCliProxyApiConfig,
  type CliProxyApiConfig,
} from "./cliProxyApiConfig";
import type { PrivateFileSecurityOptions } from "../../lib/trustedWindowsTools";
import type { RouteProtocol } from "../../../../desktop/src/shared/harnessRoutes";

/**
 * Upstreams ADE adds to its local CLIProxyAPI for routes that need translation.
 *
 * A harness that cannot speak a model's protocol directly (Claude Code on an
 * OpenAI-chat-only model, Codex on an Anthropic-only one) is pointed at the
 * proxy instead. The proxy needs to know the real endpoint and key, and that
 * lives here: one entry per source (per credential for a key), named `ade-…`,
 * written into the proxy's own config file. CLIProxyAPI watches that file and
 * reloads it live, so an upsert takes effect without a restart.
 *
 * Each entry routes by its own prefix — the harness asks for
 * `ade-opencode-go/glm-5.3` — so two sources that serve the same model id can
 * run side by side without the proxy mixing their requests.
 *
 * Only entries marked `ade-id` are ADE's; anything else in those sections is
 * left exactly as found.
 */

export const ADE_UPSTREAM_PREFIX = "ade-";

/**
 * The upstream id for one source (`routeSourceKey`: `opencode-go`, or
 * `deepseek:default` for a key). One function, so the launch that writes an
 * entry and the key removal that drops it always agree on its name.
 */
export function adeUpstreamId(sourceKey: string): string {
  return `${ADE_UPSTREAM_PREFIX}${sourceKey.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`;
}

type UpstreamSection = (typeof CLI_PROXY_API_UPSTREAM_SECTIONS)[number];

export type ProxyUpstream = {
  /** Stable id naming the source; also the routing prefix. */
  id: string;
  protocol: RouteProtocol;
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

const SECTION_FOR_PROTOCOL: Record<RouteProtocol, UpstreamSection> = {
  "openai-chat": "openai-compatibility",
  anthropic: "claude-api-key",
  "openai-responses": "codex-api-key",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function entryId(entry: unknown): string | null {
  if (!isRecord(entry)) return null;
  const id = typeof entry["ade-id"] === "string" ? entry["ade-id"] : null;
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
      prefix: upstream.id,
      "base-url": upstream.baseUrl,
      ...headers,
      "api-key-entries": [{ "api-key": upstream.apiKey }],
      models,
    };
  }
  return {
    "ade-id": upstream.id,
    prefix: upstream.id,
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
  return withCliProxyApiConfigLock(configPath, () => {
    if (!fs.existsSync(configPath)) return false;
    const config: CliProxyApiConfig = readCliProxyApiConfig(configPath);
    const section = SECTION_FOR_PROTOCOL[upstream.protocol];
    const entries = Array.isArray(config[section]) ? [...(config[section] as unknown[])] : [];
    const index = entries.findIndex((entry) => entryId(entry) === upstream.id);
    const next = renderEntry(upstream, index >= 0 ? existingModelNames(entries[index]) : []);
    if (index >= 0 && JSON.stringify(entries[index]) === JSON.stringify(next)) return true;
    if (index >= 0) entries[index] = next;
    else entries.push(next);
    config[section] = entries;
    // One source lives in exactly one section: a source whose protocol changed
    // (a probe corrected it) must not leave a stale twin with the old key.
    for (const other of CLI_PROXY_API_UPSTREAM_SECTIONS) {
      if (other === section || !Array.isArray(config[other])) continue;
      config[other] = (config[other] as unknown[]).filter((entry) => entryId(entry) !== upstream.id);
    }
    writeCliProxyApiConfig(configPath, config, security);
    return true;
  });
}

/**
 * Harnesses that cannot send OpenCode's session header get their own entry,
 * `<id>+<harness>`, with a static one. `+` is a character `adeUpstreamId`
 * never produces, so a variant can never be mistaken for another source's id
 * (a credential named `default-droid` is `ade-openai-default-droid`).
 */
export const HEADERLESS_UPSTREAM_HARNESSES = ["droid", "qwen", "opencode"] as const;

export function adeUpstreamVariantId(id: string, harness: string): string {
  return `${id}+${harness}`;
}

/**
 * Drop the ADE upstreams of one source — `id` and its per-harness variants —
 * so a removed key's secret does not outlive it in the proxy's config.
 */
export function removeCliProxyApiUpstreams(
  configPath: string,
  id: string,
  security: PrivateFileSecurityOptions = {},
): void {
  withCliProxyApiConfigLock(configPath, () => {
    const ids = new Set([id, ...HEADERLESS_UPSTREAM_HARNESSES.map((harness) => adeUpstreamVariantId(id, harness))]);
    if (!fs.existsSync(configPath)) return;
    const config = readCliProxyApiConfig(configPath);
    let changed = false;
    for (const section of CLI_PROXY_API_UPSTREAM_SECTIONS) {
      const entries = config[section];
      if (!Array.isArray(entries)) continue;
      const kept = entries.filter((entry) => {
        const entryIdValue = entryId(entry);
        return !(entryIdValue && ids.has(entryIdValue));
      });
      if (kept.length !== entries.length) {
        config[section] = kept;
        changed = true;
      }
    }
    if (changed) writeCliProxyApiConfig(configPath, config, security);
  });
}
