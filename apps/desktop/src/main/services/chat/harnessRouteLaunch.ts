/**
 * Turning "this harness, this source, this model" into a process environment.
 *
 * `shared/harnessRoutes.ts` decides WHICH route a pairing takes (direct to the
 * source's endpoint, or translated through ADE's proxy). This module carries it
 * out: it resolves the source's secret on this machine, and writes the one
 * environment/config shape each harness reads an endpoint from.
 *
 * Rules that shape it:
 *
 * - **A key never reaches the wrong vendor.** A route is built from the
 *   source's own endpoint table; when none is known the launch is refused with a
 *   reason. The old key path handed Claude Code `ANTHROPIC_AUTH_TOKEN=<a
 *   DeepSeek key>` with no base URL, which sent the key to api.anthropic.com.
 * - **Secrets stay in main.** The OpenCode token and stored keys are read here
 *   and only written into a child environment or ADE's private proxy config.
 * - **Every model tier is pinned.** Claude Code calls a "small fast" Haiku
 *   model for titles and background work. On another vendor that model does not
 *   exist, so every tier (and the subagent default) is pointed at the route's
 *   model unless the preset pins a subagent model itself.
 * - **OpenCode Go needs a session header.** Its gateway rejects requests with
 *   no `x-opencode-session`, so every harness that can set a header gets one,
 *   and harnesses that cannot are routed through the proxy, which adds it.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";

import type { HarnessPresetBody, HarnessPresetSource } from "../../../shared/harnessPresets";
import {
  anthropicBaseWithV1,
  canonicalSourceProvider,
  endpointsForSource,
  isOpenCodeHouseSource,
  KNOWN_SOURCE_ENDPOINTS,
  resolveHarnessRoute,
  stripTrailingV1,
  type HarnessRoute,
  type RouteEndpoints,
  type RouteProtocol,
} from "../../../shared/harnessRoutes";
import { isSafeIdentifier } from "../../../shared/safeIdentifier";
import type { ApiCredentialSummary } from "../../../shared/types/apiCredentials";
import { getApiCredentialKey, getApiCredentialSummary } from "../ai/apiKeyStore";
import {
  readOpenCodeLaunchSecret,
  type OpenCodeLaunchSecret,
} from "../opencode/openCodeCredentials";
import { findPersistedOpenCodeModelDescriptor } from "../opencode/openCodeInventory";
import { getModelData } from "../ai/modelsDevService";
import {
  ensurePrivateDirectory,
  writePrivateFile,
  type PrivateFileSecurityOptions,
} from "../../../../../ade-cli/src/lib/trustedWindowsTools";
import {
  ADE_UPSTREAM_PREFIX,
  upsertCliProxyApiUpstream,
} from "../../../../../ade-cli/src/services/proxy/cliProxyApiUpstreams";
import {
  defaultReadProxyEndpoint,
  type ProxyEndpointParts,
  type ProxySubscriptionConnectionUnavailable,
} from "./harnessPresetProxyConnection";
import { readRouteProbe } from "./harnessRouteProbes";

/** Header OpenCode Go routes and caches by. */
export const OPENCODE_SESSION_HEADER = "x-opencode-session";
/** Env var a harness reads the per-launch session id from (Codex, Grok). */
export const ROUTE_SESSION_ENV = "ADE_ROUTE_SESSION_ID";
/** Env var a routed launch's bearer token lives in (Codex, Grok). */
export const ROUTE_KEY_ENV = "ADE_PRESET_API_KEY";

export type RouteLaunchResult =
  | {
      status: "ready";
      env: Record<string, string>;
      /** The model id the harness must request. Differs from the preset's only for a Grok route. */
      model: string;
      route: HarnessRoute;
      codexConfigHome?: string;
      notes?: string[];
    }
  | { status: "unsupported"; unsupported: string };

export type RouteLaunchDeps = {
  adeHome: string;
  writeConfig?: boolean;
  security?: PrivateFileSecurityOptions;
  getCredentialSummary?: (provider: string, credentialId: string) => ApiCredentialSummary | null;
  getCredentialKey?: (provider: string, credentialId: string) => string | null;
  readOpenCodeSecret?: (providerId: string) => OpenCodeLaunchSecret | null;
  readProxyEndpoint?: () => ProxyEndpointParts | ProxySubscriptionConnectionUnavailable | null;
  now?: () => number;
  /** Stable per-conversation id for OpenCode's session header. */
  sessionId?: string;
};

type ResolvedSource = {
  sourceProvider: string;
  label: string;
  endpoints: RouteEndpoints;
  token: string;
  /** OpenCode's house gateway, which needs the session header. */
  needsSessionHeader: boolean;
};

/** The secret and endpoints behind a key or OpenCode source, on this machine. */
function resolveSource(
  source: Extract<HarnessPresetSource, { kind: "key" } | { kind: "opencode" }>,
  deps: RouteLaunchDeps,
): ResolvedSource | { unsupported: string } {
  if (source.kind === "key") {
    const provider = source.provider.trim();
    const credentialId = source.credentialId.trim();
    if (!isSafeIdentifier(provider) || !isSafeIdentifier(credentialId)) {
      return { unsupported: "This preset uses an unsafe credential id; use only letters, digits, dot, underscore, and dash." };
    }
    const credential = (deps.getCredentialSummary ?? getApiCredentialSummary)(provider, credentialId);
    if (!credential) return { unsupported: "The API key this preset uses is not on this machine." };
    const token = (deps.getCredentialKey ?? getApiCredentialKey)(provider, credentialId)?.trim();
    if (!token) return { unsupported: "The API key this preset uses could not be read from this machine's key store." };
    return {
      sourceProvider: provider,
      label: credential.label?.trim() || provider,
      endpoints: endpointsForSource({ provider, baseUrl: credential.baseUrl, protocol: credential.protocol }),
      token,
      needsSessionHeader: isOpenCodeHouseSource(provider),
    };
  }
  const providerId = source.providerId.trim();
  if (!isSafeIdentifier(providerId)) {
    return { unsupported: "This preset names an unsafe OpenCode provider id." };
  }
  const secret = (deps.readOpenCodeSecret ?? readOpenCodeLaunchSecret)(providerId);
  if (!secret) {
    return {
      unsupported: `${openCodeName(providerId)} is not signed in to OpenCode on this machine. Sign in under Providers › OpenCode.`,
    };
  }
  const now = deps.now?.() ?? Date.now();
  if (secret.expiresAt !== null && secret.expiresAt <= now) {
    return {
      unsupported: `The ${openCodeName(providerId)} sign-in expired. Open an OpenCode chat once so OpenCode refreshes it, or sign in again under Providers › OpenCode.`,
    };
  }
  return {
    sourceProvider: providerId,
    label: openCodeName(providerId),
    endpoints: KNOWN_SOURCE_ENDPOINTS[canonicalSourceProvider(providerId)] ?? {},
    token: secret.token,
    needsSessionHeader: isOpenCodeHouseSource(providerId),
  };
}

function openCodeName(providerId: string): string {
  if (providerId === "opencode-go") return "OpenCode Go";
  if (providerId === "opencode") return "OpenCode Zen";
  return providerId;
}

export type RouteModelLimits = { contextWindow?: number; maxOutputTokens?: number };

/** Context and output limits for a routed model, from whatever ADE has cached. */
export function lookupRouteModelLimits(sourceProvider: string, modelId: string): RouteModelLimits {
  const provider = canonicalSourceProvider(sourceProvider);
  const fromOpenCode = findPersistedOpenCodeModelDescriptor(provider, modelId);
  if (fromOpenCode?.contextWindow || fromOpenCode?.maxOutputTokens) {
    return {
      ...(fromOpenCode.contextWindow ? { contextWindow: fromOpenCode.contextWindow } : {}),
      ...(fromOpenCode.maxOutputTokens ? { maxOutputTokens: fromOpenCode.maxOutputTokens } : {}),
    };
  }
  try {
    const data = getModelData(`${provider}/${modelId}`);
    if (data) {
      return {
        ...(data.contextWindow ? { contextWindow: data.contextWindow } : {}),
        ...(data.maxOutputTokens ? { maxOutputTokens: data.maxOutputTokens } : {}),
      };
    }
  } catch {
    // models.dev not initialized in this process — limits are a nicety.
  }
  return {};
}

/** Harnesses that can attach a per-launch header to every model request. */
const HEADER_CAPABLE: ReadonlySet<HarnessPresetBody> = new Set(["claude", "codex", "grok"]);

/**
 * Where one routed launch goes, after the proxy decision.
 *
 * The proxy entry is written here too: its id names the source, so every
 * launch on that source refreshes the key (an OpenCode token rotates) and adds
 * its model. Returns `unsupported` when the proxy is not running — the async
 * prepare step starts it before a launch; a caller that skipped it gets a
 * reason instead of a request to a dead port.
 */
function proxyTarget(args: {
  harness: HarnessPresetBody;
  route: Extract<HarnessRoute, { kind: "proxy" }>;
  source: ResolvedSource;
  model: string;
  limits: RouteModelLimits;
  deps: RouteLaunchDeps;
}): { protocol: RouteProtocol; baseUrl: string; token: string } | { unsupported: string } {
  const readEndpoint = args.deps.readProxyEndpoint ?? defaultReadProxyEndpoint(args.deps.adeHome);
  const endpoint = readEndpoint();
  if (!endpoint) return { unsupported: "ADE's proxy has no connection key yet. Start the proxy and try again." };
  if ("reason" in endpoint) return { unsupported: "ADE's proxy is not running. It starts on demand; try the launch again." };
  const headerCapable = HEADER_CAPABLE.has(args.harness);
  const upstreamId = `${ADE_UPSTREAM_PREFIX}${safeSegment(args.source.sourceProvider)}${headerCapable ? "" : `-${args.harness}`}`;
  const headers: Record<string, string> = {};
  if (args.source.needsSessionHeader) {
    // A header-capable harness sends its own per-conversation id and the proxy
    // copies it; one that cannot gets a stable id of its own on a dedicated
    // entry, which Go accepts (it is a routing hint, not an identity).
    headers[OPENCODE_SESSION_HEADER] = headerCapable
      ? "$X-Opencode-Session"
      : `ade-${args.harness}-${args.deps.sessionId ?? randomUUID()}`;
  }
  if (args.deps.writeConfig !== false) {
    try {
      const written = upsertCliProxyApiUpstream(endpoint.configPath, {
        id: upstreamId,
        protocol: args.route.upstreamProtocol,
        baseUrl: args.route.upstreamBaseUrl,
        apiKey: args.source.token,
        headers,
        models: [{ name: args.model, ...(args.limits.contextWindow ? { contextWindow: args.limits.contextWindow } : {}) }],
      }, args.deps.security);
      if (!written) return { unsupported: "ADE's proxy has not written its config yet. Try the launch again." };
    } catch (error) {
      return {
        unsupported: `ADE could not configure its proxy for this model: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  const root = `http://127.0.0.1:${endpoint.port}`;
  return {
    protocol: args.route.harnessProtocol,
    baseUrl: args.route.harnessProtocol === "anthropic" ? root : `${root}/v1`,
    token: endpoint.apiKey,
  };
}

function safeSegment(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

/**
 * The whole per-harness endpoint table, in one place.
 *
 * `configHome` is ADE-owned and private to this preset (or ad-hoc route). ADE
 * writes Codex's, Grok's and Droid's config there and never into the user's own
 * `~/.codex`, `~/.grok` or `~/.factory`. Claude Code needs no file at all, so it
 * keeps the user's own config home — their plugins, skills and MCP servers stay
 * — and takes the endpoint from environment variables, which outrank the
 * user's sign-in.
 */
export function buildHarnessEndpointEnv(args: {
  harness: HarnessPresetBody;
  protocol: RouteProtocol;
  baseUrl: string;
  token: string;
  model: string;
  label: string;
  sessionHeader: string | null;
  limits: RouteModelLimits;
  subagentModel?: string;
  /** A first-party Anthropic endpoint, whose own model tiers exist. */
  firstPartyAnthropic?: boolean;
  configHome: string;
  writeConfig: boolean;
  security: PrivateFileSecurityOptions;
}): RouteLaunchResult | { status: "unsupported"; unsupported: string } {
  const { harness, protocol, baseUrl, token, model, limits } = args;
  switch (harness) {
    case "claude": {
      if (protocol !== "anthropic") break;
      const tierModel = model;
      const env: Record<string, string> = {
        ANTHROPIC_BASE_URL: stripTrailingV1(baseUrl),
        ANTHROPIC_AUTH_TOKEN: token,
        // Emptied, never inherited: a shell ANTHROPIC_API_KEY would otherwise
        // ride along as `x-api-key` to a different vendor, and OpenRouter
        // rejects a request that carries both.
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_MODEL: model,
      };
      if (!args.firstPartyAnthropic) {
        // Another vendor has no Haiku/Sonnet/Opus, so every tier Claude Code
        // reaches for (titles, background work, the default subagent) is the
        // route's model unless the preset pins a subagent model itself.
        env.ANTHROPIC_DEFAULT_OPUS_MODEL = tierModel;
        env.ANTHROPIC_DEFAULT_SONNET_MODEL = tierModel;
        env.ANTHROPIC_DEFAULT_HAIKU_MODEL = args.subagentModel ?? tierModel;
        env.ANTHROPIC_SMALL_FAST_MODEL = args.subagentModel ?? tierModel;
        if (!args.subagentModel) env.CLAUDE_CODE_SUBAGENT_MODEL = tierModel;
      }
      if (limits.contextWindow) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(limits.contextWindow);
      if (limits.maxOutputTokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(Math.min(limits.maxOutputTokens, 128_000));
      if (args.sessionHeader) env.ANTHROPIC_CUSTOM_HEADERS = `${OPENCODE_SESSION_HEADER}: ${args.sessionHeader}`;
      return { status: "ready", env, model, route: { kind: "direct", protocol, baseUrl } };
    }
    case "codex": {
      if (protocol !== "openai-responses") break;
      const env: Record<string, string> = { CODEX_HOME: args.configHome, [ROUTE_KEY_ENV]: token };
      if (args.sessionHeader) env[ROUTE_SESSION_ENV] = args.sessionHeader;
      if (args.writeConfig) {
        ensurePrivateDirectory(args.configHome, args.security);
        writePrivateFile(path.join(args.configHome, "config.toml"), codexRouteConfigToml({
          baseUrl,
          label: args.label,
          sessionHeader: Boolean(args.sessionHeader),
          limits,
        }), args.security);
      }
      return { status: "ready", env, model, route: { kind: "direct", protocol, baseUrl }, codexConfigHome: args.configHome };
    }
    case "grok": {
      const env: Record<string, string> = { GROK_HOME: args.configHome, [ROUTE_KEY_ENV]: token };
      if (args.sessionHeader) env[ROUTE_SESSION_ENV] = args.sessionHeader;
      if (args.writeConfig) {
        ensurePrivateDirectory(args.configHome, args.security);
        writePrivateFile(path.join(args.configHome, "config.toml"), grokRouteConfigToml({
          model,
          protocol,
          baseUrl,
          label: args.label,
          sessionHeader: Boolean(args.sessionHeader),
          limits,
        }), args.security);
      }
      return { status: "ready", env, model, route: { kind: "direct", protocol, baseUrl } };
    }
    case "qwen": {
      if (protocol !== "openai-chat") break;
      return {
        status: "ready",
        env: { OPENAI_API_KEY: token, OPENAI_BASE_URL: baseUrl, OPENAI_MODEL: model },
        model,
        route: { kind: "direct", protocol, baseUrl },
      };
    }
    case "droid": {
      if (protocol !== "anthropic" && protocol !== "openai-chat") break;
      if (args.writeConfig) {
        ensurePrivateDirectory(path.join(args.configHome, ".factory"), args.security);
        writePrivateFile(
          path.join(args.configHome, ".factory", "settings.json"),
          `${JSON.stringify({
            custom_models: [{
              model_display_name: model,
              model,
              base_url: protocol === "anthropic" ? stripTrailingV1(baseUrl) : baseUrl,
              api_key: token,
              provider: protocol === "anthropic" ? "anthropic" : "generic-chat-completion-api",
              max_tokens: Math.min(limits.maxOutputTokens ?? 32_000, 128_000),
            }],
          }, null, 2)}\n`,
          args.security,
        );
      }
      return {
        status: "ready",
        env: { FACTORY_HOME_OVERRIDE: args.configHome, FACTORY_API_KEY: token },
        model: `custom:${model}`,
        route: { kind: "direct", protocol, baseUrl },
      };
    }
    default:
      break;
  }
  return {
    status: "unsupported",
    unsupported: `${harness} cannot be pointed at a ${protocol} endpoint.`,
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function codexRouteConfigToml(args: {
  baseUrl: string;
  label: string;
  sessionHeader: boolean;
  limits: RouteModelLimits;
}): string {
  const lines = [
    "# Written by ADE for a routed launch. Edits here are overwritten on launch.",
    "# ADE never writes to ~/.codex/config.toml; CODEX_HOME points Codex here.",
    'model_provider = "ade"',
  ];
  if (args.limits.contextWindow) lines.push(`model_context_window = ${Math.floor(args.limits.contextWindow)}`);
  if (args.limits.maxOutputTokens) lines.push(`model_max_output_tokens = ${Math.floor(args.limits.maxOutputTokens)}`);
  lines.push(
    "",
    "[model_providers.ade]",
    `name = ${tomlString(args.label || "ADE")}`,
    `base_url = ${tomlString(args.baseUrl.replace(/\/+$/, ""))}`,
    'wire_api = "responses"',
    `env_key = ${tomlString(ROUTE_KEY_ENV)}`,
  );
  if (args.sessionHeader) {
    lines.push(`env_http_headers = { ${tomlString(OPENCODE_SESSION_HEADER)} = ${tomlString(ROUTE_SESSION_ENV)} }`);
  }
  lines.push("");
  return lines.join("\n");
}

const GROK_BACKENDS: Record<RouteProtocol, string> = {
  anthropic: "messages",
  "openai-chat": "chat_completions",
  "openai-responses": "responses",
};

export function grokRouteConfigToml(args: {
  model: string;
  protocol: RouteProtocol;
  baseUrl: string;
  label: string;
  sessionHeader: boolean;
  limits: RouteModelLimits;
}): string {
  const lines = [
    "# Written by ADE for a routed launch. Edits here are overwritten on launch.",
    "# ADE never writes to ~/.grok; GROK_HOME points Grok here.",
    "[models]",
    `default = ${tomlString(args.model)}`,
    "",
    `[model.${tomlString(args.model)}]`,
    `model = ${tomlString(args.model)}`,
    `base_url = ${tomlString(args.protocol === "anthropic" ? anthropicBaseWithV1(args.baseUrl) : args.baseUrl)}`,
    `api_backend = ${tomlString(GROK_BACKENDS[args.protocol])}`,
    `name = ${tomlString(`${args.model} (${args.label})`)}`,
    `env_key = ${tomlString(ROUTE_KEY_ENV)}`,
  ];
  if (args.sessionHeader) {
    lines.push(`env_http_headers = { ${tomlString(OPENCODE_SESSION_HEADER)} = ${tomlString(ROUTE_SESSION_ENV)} }`);
  }
  if (args.limits.contextWindow) lines.push(`context_window = ${Math.floor(args.limits.contextWindow)}`);
  if (args.limits.maxOutputTokens) lines.push(`max_completion_tokens = ${Math.floor(args.limits.maxOutputTokens)}`);
  lines.push("");
  return lines.join("\n");
}

/**
 * One routed launch: a key or OpenCode source, on any harness that takes an
 * endpoint. The caller owns the preset bookkeeping (subagent pins, notes);
 * this returns the environment and the model id the harness must request.
 */
export function buildRouteLaunch(args: {
  harness: HarnessPresetBody;
  source: Extract<HarnessPresetSource, { kind: "key" } | { kind: "opencode" }>;
  model: string;
  configHome: string;
  subagentModel?: string;
  deps: RouteLaunchDeps;
}): RouteLaunchResult {
  const { harness, deps } = args;
  const model = args.model.trim();
  const resolved = resolveSource(args.source, deps);
  if ("unsupported" in resolved) return { status: "unsupported", unsupported: resolved.unsupported };

  const route = resolveHarnessRoute({
    harness,
    source: args.source,
    modelId: model,
    endpoints: resolved.endpoints,
    catalogPackage: null,
    probe: readRouteProbe(deps.adeHome, resolved.sourceProvider, model),
  });
  if (route.kind === "impossible") return { status: "unsupported", unsupported: route.reason };
  if (route.kind === "native") return { status: "unsupported", unsupported: "This source signs its own harness in." };

  const limits = lookupRouteModelLimits(resolved.sourceProvider, model);
  const sessionId = deps.sessionId ?? randomUUID();
  const needsProxyForHeader = resolved.needsSessionHeader && !HEADER_CAPABLE.has(harness);
  let target: { protocol: RouteProtocol; baseUrl: string; token: string };
  let effectiveRoute: HarnessRoute = route;
  if (route.kind === "proxy" || needsProxyForHeader) {
    const proxyRoute: Extract<HarnessRoute, { kind: "proxy" }> = route.kind === "proxy"
      ? route
      : {
        kind: "proxy",
        harnessProtocol: route.protocol,
        upstreamProtocol: route.protocol,
        upstreamBaseUrl: route.baseUrl,
      };
    const viaProxy = proxyTarget({ harness, route: proxyRoute, source: resolved, model, limits, deps: { ...deps, sessionId } });
    if ("unsupported" in viaProxy) return { status: "unsupported", unsupported: viaProxy.unsupported };
    target = viaProxy;
    effectiveRoute = proxyRoute;
  } else {
    target = { protocol: route.protocol, baseUrl: route.baseUrl, token: resolved.token };
  }

  const security = deps.security ?? {};
  const built = buildHarnessEndpointEnv({
    harness,
    protocol: target.protocol,
    baseUrl: target.baseUrl,
    token: target.token,
    model,
    label: resolved.label,
    sessionHeader: resolved.needsSessionHeader ? `ade-${sessionId}` : null,
    limits,
    firstPartyAnthropic: canonicalSourceProvider(resolved.sourceProvider) === "anthropic"
      && effectiveRoute.kind === "direct",
    ...(args.subagentModel ? { subagentModel: args.subagentModel } : {}),
    configHome: args.configHome,
    writeConfig: deps.writeConfig !== false,
    security,
  });
  if (built.status === "unsupported") return built;
  return { ...built, route: effectiveRoute };
}
