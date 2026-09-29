/**
 * How a model from one source reaches a harness.
 *
 * Every harness speaks exactly one or a few wire protocols, and every source a
 * user pays for answers on one or a few endpoints. A pairing works when they
 * share a protocol (a **direct** route: point the harness at the source's own
 * endpoint), or when ADE's local proxy can translate between them (a **proxy**
 * route). Anything else is **impossible**, and the reason is stated rather than
 * the pairing silently falling back to the harness's own sign-in.
 *
 * Protocol support is per model, not per provider: OpenCode Go serves DeepSeek
 * on its Anthropic endpoint but GLM only on its OpenAI chat endpoint, and GPT
 * only on Responses (measured 2026-09-29; see `OPENCODE_GO_MODEL_PROTOCOLS`).
 * So the route for a model uses, in order: a live probe result, the measured
 * seed table, the catalog's declared package, and finally every protocol the
 * source serves.
 *
 * Pure: no IPC, no fs, no React. Main resolves launches from it; the renderer
 * lists reachable models from it.
 */

import { encodeOpenCodeRegistryId } from "./modelRegistry";
import { isOpenCodeHouseProvider } from "./opencodeProviders";
import {
  HARNESS_PRESET_BODIES,
  type HarnessPresetBody,
  type HarnessPresetSource,
} from "./harnessPresets";

export const ROUTE_PROTOCOLS = ["anthropic", "openai-chat", "openai-responses"] as const;
export type RouteProtocol = (typeof ROUTE_PROTOCOLS)[number];

export function isRouteProtocol(value: unknown): value is RouteProtocol {
  return typeof value === "string" && (ROUTE_PROTOCOLS as readonly string[]).includes(value);
}

/**
 * The protocols each harness can be pointed at, in preference order.
 *
 * Empty means the harness takes no outside endpoint at all: Cursor signs in
 * from a single-slot store, Pi reads its own models.json, and the Copilot and
 * Kimi CLIs have no verified base-URL hook.
 */
export const HARNESS_ROUTE_PROTOCOLS: Record<HarnessPresetBody, readonly RouteProtocol[]> = {
  claude: ["anthropic"],
  codex: ["openai-responses"],
  opencode: ["anthropic", "openai-chat", "openai-responses"],
  droid: ["anthropic", "openai-chat"],
  qwen: ["openai-chat"],
  grok: ["anthropic", "openai-responses", "openai-chat"],
  kimi: [],
  copilot: [],
  cursor: [],
  pi: [],
};

const NO_ROUTE_REASONS: Partial<Record<HarnessPresetBody, string>> = {
  cursor: "Cursor signs in with one key at a time from its own store, so it only runs on its own sign-in.",
  pi: "Pi reads its endpoints from its own models.json, so it only runs on its own providers.",
  copilot: "The Copilot CLI signs in through GitHub itself, so it only runs on its own sign-in.",
  kimi: "The Kimi CLI reads its own config home, so it only runs on its own sign-in.",
};

/** Harnesses that can run a model from another source at all. */
export function harnessAcceptsRoutes(harness: HarnessPresetBody): boolean {
  return HARNESS_ROUTE_PROTOCOLS[harness].length > 0;
}

export function harnessRouteBlockedReason(harness: HarnessPresetBody): string | null {
  return harnessAcceptsRoutes(harness) ? null : NO_ROUTE_REASONS[harness] ?? "This harness only runs on its own sign-in.";
}

export const ROUTABLE_HARNESSES: readonly HarnessPresetBody[] = HARNESS_PRESET_BODIES.filter(harnessAcceptsRoutes);

/**
 * A source's endpoints by protocol.
 *
 * Spelling convention, fixed so no caller guesses: an `anthropic` endpoint is
 * the API root WITHOUT `/v1` (what `ANTHROPIC_BASE_URL` takes); the OpenAI
 * endpoints INCLUDE `/v1` (what an OpenAI SDK `baseURL` takes).
 */
export type RouteEndpoints = Partial<Record<RouteProtocol, string>>;

const OPENCODE_GO_ROOT = "https://opencode.ai/inference/go";
const OPENCODE_ZEN_ROOT = "https://opencode.ai/inference";

/**
 * Endpoints for the providers ADE knows by id. Keyed by the provider id both
 * the API-key store and OpenCode use (`moonshotai`, not `moonshot`).
 */
export const KNOWN_SOURCE_ENDPOINTS: Readonly<Record<string, RouteEndpoints>> = {
  anthropic: { anthropic: "https://api.anthropic.com" },
  openai: { "openai-chat": "https://api.openai.com/v1", "openai-responses": "https://api.openai.com/v1" },
  deepseek: { anthropic: "https://api.deepseek.com/anthropic", "openai-chat": "https://api.deepseek.com/v1" },
  openrouter: {
    anthropic: "https://openrouter.ai/api",
    "openai-chat": "https://openrouter.ai/api/v1",
    "openai-responses": "https://openrouter.ai/api/v1",
  },
  moonshotai: { anthropic: "https://api.moonshot.ai/anthropic", "openai-chat": "https://api.moonshot.ai/v1" },
  zhipuai: { anthropic: "https://open.bigmodel.cn/api/anthropic", "openai-chat": "https://open.bigmodel.cn/api/paas/v4" },
  xai: { "openai-chat": "https://api.x.ai/v1", "openai-responses": "https://api.x.ai/v1" },
  groq: { "openai-chat": "https://api.groq.com/openai/v1" },
  mistral: { "openai-chat": "https://api.mistral.ai/v1" },
  together: { "openai-chat": "https://api.together.xyz/v1" },
  togetherai: { "openai-chat": "https://api.together.xyz/v1" },
  google: { "openai-chat": "https://generativelanguage.googleapis.com/v1beta/openai" },
  "opencode-go": {
    anthropic: `${OPENCODE_GO_ROOT}/anthropic`,
    "openai-chat": `${OPENCODE_GO_ROOT}/openai/v1`,
    "openai-responses": `${OPENCODE_GO_ROOT}/openai/v1`,
  },
  opencode: {
    anthropic: `${OPENCODE_ZEN_ROOT}/anthropic`,
    "openai-chat": `${OPENCODE_ZEN_ROOT}/openai/v1`,
    "openai-responses": `${OPENCODE_ZEN_ROOT}/openai/v1`,
  },
};

/** Key-store provider aliases that name the same endpoints. */
const SOURCE_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  moonshot: "moonshotai",
  "kimi-for-coding": "moonshotai",
  grok: "xai",
  gemini: "google",
  zhipu: "zhipuai",
};

export function canonicalSourceProvider(provider: string): string {
  const id = provider.trim().toLowerCase();
  return SOURCE_PROVIDER_ALIASES[id] ?? id;
}

/** OpenCode's own services, whose traffic needs a stable session header. */
export function isOpenCodeHouseSource(provider: string): boolean {
  return isOpenCodeHouseProvider(canonicalSourceProvider(provider));
}

/**
 * Endpoints for a source.
 *
 * A key that carries its own base URL is a custom endpoint and answers on the
 * protocol it declares (OpenAI chat unless it says otherwise) — the known
 * table is only for first-class providers with no URL of their own.
 */
export function endpointsForSource(args: {
  provider: string;
  baseUrl?: string | null;
  protocol?: string | null;
}): RouteEndpoints {
  const baseUrl = args.baseUrl?.trim().replace(/\/+$/, "");
  if (baseUrl) {
    if (args.protocol === "anthropic") return { anthropic: stripTrailingV1(baseUrl) };
    if (args.protocol === "openai-responses") return { "openai-responses": baseUrl };
    if (args.protocol === "openai-compatible" || args.protocol === "openai-chat") return { "openai-chat": baseUrl };
    // No declared protocol: the endpoint is offered on every protocol, which
    // is how custom endpoints behaved before routing existed (Claude Code
    // took one as Anthropic-shaped, Codex as Responses). A Test records what
    // it really answers on, and the route follows the verdict.
    return {
      anthropic: stripTrailingV1(baseUrl),
      "openai-chat": baseUrl,
      "openai-responses": baseUrl,
    };
  }
  return KNOWN_SOURCE_ENDPOINTS[canonicalSourceProvider(args.provider)] ?? {};
}

/** `https://openrouter.ai/api/v1` → `https://openrouter.ai/api`. */
export function stripTrailingV1(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -3).replace(/\/+$/, "") : trimmed;
}

/** An Anthropic root with `/v1` appended, for clients that want the versioned base. */
export function anthropicBaseWithV1(root: string): string {
  const trimmed = root.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}


// ---------------------------------------------------------------------------
// Per-model protocol knowledge
// ---------------------------------------------------------------------------

/**
 * OpenCode Go, measured against the live gateway on 2026-09-29 with a
 * one-token request per model and protocol. The gateway answers "Model does not
 * support this protocol" before inference, so these are exact. A live probe
 * (the Test button) overrides a row, and a model missing here falls back to its
 * catalog package.
 */
export const OPENCODE_GO_MODEL_PROTOCOLS: Readonly<Record<string, readonly RouteProtocol[]>> = {
  "deepseek-v4.1-flash": ["anthropic", "openai-chat", "openai-responses"],
  "deepseek-v4-flash": ["anthropic", "openai-chat", "openai-responses"],
  "deepseek-v4-flash-vision-exp": ["anthropic", "openai-chat", "openai-responses"],
  "deepseek-v4-pro": ["anthropic", "openai-chat", "openai-responses"],
  "kimi-k3": ["anthropic", "openai-chat"],
  "qwen3.7-plus": ["anthropic", "openai-chat"],
  "qwen3.8-flash": ["anthropic", "openai-chat"],
  "qwen3.8-max": ["anthropic", "openai-chat"],
  "minimax-m3": ["anthropic", "openai-chat"],
  "minimax-m2.7": ["anthropic"],
  "space-bunny-free": ["anthropic", "openai-chat"],
  "glm-5.2": ["openai-chat"],
  "glm-5.3": ["openai-chat"],
  "glm-5.3-flash": ["openai-chat"],
  "hy3": ["openai-chat"],
  "hy4-preview": ["openai-chat"],
  "kimi-k2.7-code": ["openai-chat"],
  "longcat-2.0": ["openai-chat"],
  "longcat-2.5-preview-free": ["openai-chat"],
  "mimo-v2.5": ["openai-chat"],
  "mimo-v2.5-pro": ["openai-chat"],
  "mimo-v2.6-flash": ["openai-chat"],
  "mimo-v2.6-pro": ["openai-chat"],
  "gpt-5.6-luna": ["openai-responses"],
  "gpt-6-luna": ["openai-responses"],
  "grok-4.6": ["openai-responses"],
  "grok-4.7": ["openai-responses"],
};

/**
 * Models a source only serves to one harness.
 *
 * OpenCode Zen's free tier answers "can only be used from within OpenCode" to
 * every other client, so offering it in Claude Code would be a combo that is
 * guaranteed to fail.
 */
export function modelOnlyRunsInOpenCode(sourceProvider: string, modelId: string): boolean {
  return canonicalSourceProvider(sourceProvider) === "opencode" && /-free$/i.test(modelId.trim());
}

/** A probe verdict for one (source, model), as persisted by main. */
export type RouteProbeVerdict = Partial<Record<RouteProtocol, boolean>>;

export function modelProtocols(args: {
  sourceProvider: string;
  modelId: string;
  endpoints: RouteEndpoints;
  probe?: RouteProbeVerdict | null;
}): RouteProtocol[] {
  const served = ROUTE_PROTOCOLS.filter((protocol) => Boolean(args.endpoints[protocol]));
  const probe = args.probe ?? null;
  if (probe && Object.keys(probe).length > 0) {
    // A probe answers only for the protocols it tried: a confirmed one is in,
    // a refused one is out, and an untried one keeps whatever the seed says.
    // (A Claude test of Go DeepSeek confirms Anthropic and must not take the
    // Responses route away from Codex.)
    const untested = served.filter((protocol) => probe[protocol] === undefined);
    const fromSeed = untested.length
      ? modelProtocols({ ...args, probe: null, endpoints: pick(args.endpoints, untested) })
      : [];
    return served.filter((protocol) => probe[protocol] === true || fromSeed.includes(protocol));
  }
  const provider = canonicalSourceProvider(args.sourceProvider);
  if (isOpenCodeHouseProvider(provider)) {
    // Zen serves the same model families through the same gateway, so Go's
    // measured table is the best answer for a Zen model of the same id.
    const seeded = OPENCODE_GO_MODEL_PROTOCOLS[args.modelId.trim()];
    if (seeded) return served.filter((protocol) => seeded.includes(protocol));
    // Zen's Claude and Gemini models are Anthropic- and OpenAI-shaped by name.
    if (provider === "opencode" && /^claude-/i.test(args.modelId)) return served.filter((p) => p === "anthropic");
    if (provider === "opencode" && /^(gpt-|grok-|muse-)/i.test(args.modelId)) return served.filter((p) => p === "openai-responses");
  }
  return served;
}

function pick(endpoints: RouteEndpoints, protocols: readonly RouteProtocol[]): RouteEndpoints {
  const out: RouteEndpoints = {};
  for (const protocol of protocols) {
    if (endpoints[protocol]) out[protocol] = endpoints[protocol];
  }
  return out;
}

// ---------------------------------------------------------------------------
// The route decision
// ---------------------------------------------------------------------------

export type HarnessRoute =
  | { kind: "native" }
  | { kind: "direct"; protocol: RouteProtocol; baseUrl: string }
  | { kind: "proxy"; harnessProtocol: RouteProtocol; upstreamProtocol: RouteProtocol; upstreamBaseUrl: string }
  | { kind: "impossible"; reason: string };

/**
 * The route for one harness + source + model.
 *
 * `native` is a harness's own account (Claude account in Claude Code): no
 * endpoint is involved at all. Direct beats proxy whenever a protocol is
 * shared, because a translated request can lose fidelity (thinking blocks,
 * cache hints) and the proxy is one more process that has to be running.
 */
export function resolveHarnessRoute(args: {
  harness: HarnessPresetBody;
  source: HarnessPresetSource;
  modelId: string;
  /** Required for `key`/`opencode` sources: where the source answers. */
  endpoints?: RouteEndpoints;
  probe?: RouteProbeVerdict | null;
}): HarnessRoute {
  const { harness, source } = args;
  if (source.kind === "account") {
    return source.provider === harness
      ? { kind: "native" }
      : {
        kind: "impossible",
        reason: `A ${source.provider === "claude" ? "Claude" : "Codex"} account signs in its own harness; borrow it as a subscription to use it elsewhere.`,
      };
  }
  if (source.kind === "opencode" && harness === "opencode") {
    // OpenCode already holds this sign-in; the model is one of its own.
    return { kind: "native" };
  }
  const blocked = harnessRouteBlockedReason(harness);
  if (blocked) return { kind: "impossible", reason: blocked };
  if (source.kind === "subscription") {
    // Subscriptions only exist inside the proxy; the harness talks to the proxy
    // in its own protocol and the proxy holds the login.
    return {
      kind: "proxy",
      harnessProtocol: HARNESS_ROUTE_PROTOCOLS[harness][0]!,
      upstreamProtocol: source.provider === "claude" ? "anthropic" : "openai-responses",
      upstreamBaseUrl: "",
    };
  }
  const sourceProvider = source.kind === "key" ? source.provider : source.providerId;
  if (modelOnlyRunsInOpenCode(sourceProvider, args.modelId) && harness !== "opencode") {
    return { kind: "impossible", reason: "OpenCode's free models only run inside OpenCode." };
  }
  const endpoints = args.endpoints ?? {};
  const protocols = modelProtocols({
    sourceProvider,
    modelId: args.modelId,
    endpoints,
    probe: args.probe,
  });
  if (protocols.length === 0) {
    return {
      kind: "impossible",
      reason: Object.keys(endpoints).length === 0
        ? "ADE does not know an endpoint for this provider. Add the key with its endpoint URL."
        : "This model did not answer on any protocol ADE can route.",
    };
  }
  for (const protocol of HARNESS_ROUTE_PROTOCOLS[harness]) {
    if (protocols.includes(protocol)) {
      return { kind: "direct", protocol, baseUrl: endpoints[protocol]! };
    }
  }
  // The proxy translates any client protocol to any upstream protocol, so the
  // harness uses its preferred one and the model keeps its own.
  const upstreamProtocol = PROXY_UPSTREAM_PREFERENCE.find((protocol) => protocols.includes(protocol))!;
  return {
    kind: "proxy",
    harnessProtocol: HARNESS_ROUTE_PROTOCOLS[harness][0]!,
    upstreamProtocol,
    upstreamBaseUrl: endpoints[upstreamProtocol]!,
  };
}

/** Upstream protocols the proxy speaks, best first (chat translates most faithfully). */
const PROXY_UPSTREAM_PREFERENCE: readonly RouteProtocol[] = ["openai-chat", "anthropic", "openai-responses"];


// ---------------------------------------------------------------------------
// Ad-hoc routes: a picker choice that is not a saved preset
// ---------------------------------------------------------------------------

/**
 * An ad-hoc route travels as a preset id: `route.<base64url(json)>`.
 *
 * WHY a preset id rather than a new field: `presetId` already rides every
 * launch surface — chat create, the session row, CLI resume metadata, the PTY
 * runtime launch, remote sync — and every one of them validates it as a safe
 * identifier. base64url's alphabet (`A-Z a-z 0-9 - _`) passes that check, so an
 * ad-hoc choice gets resume, remote launch and sync for free. The payload holds
 * ids only (harness, source reference, model); a secret can never be in it.
 */
export const ROUTE_PRESET_ID_PREFIX = "route.";

export type HarnessRouteSpec = {
  harness: HarnessPresetBody;
  source: HarnessPresetSource;
  model: string;
  reasoningEffort?: string;
};

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** Only the reference fields of a source, so nothing else can ride along. */
function sourceReference(source: HarnessPresetSource): HarnessPresetSource {
  if (source.kind === "account") return { kind: "account", provider: source.provider, instanceId: source.instanceId };
  if (source.kind === "key") {
    return { kind: "key", provider: source.provider, credentialId: source.credentialId, label: source.label };
  }
  if (source.kind === "opencode") return { kind: "opencode", providerId: source.providerId };
  return { kind: "subscription", provider: source.provider };
}

export function encodeRoutePresetId(spec: HarnessRouteSpec): string {
  const payload = {
    h: spec.harness,
    s: sourceReference(spec.source),
    m: spec.model.trim(),
    ...(spec.reasoningEffort?.trim() ? { e: spec.reasoningEffort.trim() } : {}),
  };
  return `${ROUTE_PRESET_ID_PREFIX}${base64UrlEncode(JSON.stringify(payload))}`;
}

export function isRoutePresetId(presetId: string | null | undefined): boolean {
  return typeof presetId === "string" && presetId.startsWith(ROUTE_PRESET_ID_PREFIX);
}

export function decodeRoutePresetId(presetId: string | null | undefined): HarnessRouteSpec | null {
  if (!isRoutePresetId(presetId)) return null;
  const json = base64UrlDecode(presetId!.slice(ROUTE_PRESET_ID_PREFIX.length));
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const harness = record.h;
  const model = typeof record.m === "string" ? record.m.trim() : "";
  if (!HARNESS_PRESET_BODIES.includes(harness as HarnessPresetBody) || !model) return null;
  const source = parseSourceReference(record.s);
  if (!source) return null;
  return {
    harness: harness as HarnessPresetBody,
    source,
    model,
    ...(typeof record.e === "string" && record.e.trim() ? { reasoningEffort: record.e.trim() } : {}),
  };
}

function parseSourceReference(value: unknown): HarnessPresetSource | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const str = (field: unknown) => (typeof field === "string" && field.trim() ? field.trim() : null);
  if (raw.kind === "account" && (raw.provider === "claude" || raw.provider === "codex") && str(raw.instanceId)) {
    return { kind: "account", provider: raw.provider, instanceId: str(raw.instanceId)! };
  }
  if (raw.kind === "key" && str(raw.provider) && str(raw.credentialId)) {
    return {
      kind: "key",
      provider: str(raw.provider)!,
      credentialId: str(raw.credentialId)!,
      label: str(raw.label) ?? str(raw.provider)!,
    };
  }
  if (raw.kind === "opencode" && str(raw.providerId)) {
    return { kind: "opencode", providerId: str(raw.providerId)! };
  }
  if (raw.kind === "subscription" && (raw.provider === "claude" || raw.provider === "codex")) {
    return { kind: "subscription", provider: raw.provider };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export function routeKindLabel(route: HarnessRoute): string | null {
  if (route.kind === "proxy") return "via ADE proxy";
  return null;
}

// ---------------------------------------------------------------------------
// What main reports to the renderer: every source a harness could draw on
// ---------------------------------------------------------------------------

/** One model a routable source serves. Secret-free. */
export type HarnessRouteModel = {
  id: string;
  label: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Thinking tiers the model offers, when known. */
  reasoningTiers?: string[];
  /** A live check's verdict, when one has run. */
  probe?: RouteProbeVerdict;
};

/** One source (an OpenCode sign-in or a stored key) and the models it serves. */
export type HarnessRouteSource = {
  /** Stable key for grouping: `opencode:<id>` or `key:<provider>:<credentialId>`. */
  key: string;
  source: Extract<HarnessPresetSource, { kind: "key" } | { kind: "opencode" }>;
  label: string;
  /** Short second line: "via OpenCode sign-in", "API key ••••1234". */
  detail: string;
  /** Provider id for the row's logo. */
  logoProvider: string;
  endpoints: RouteEndpoints;
  models: HarnessRouteModel[];
};

export type HarnessRouteCatalog = {
  sources: HarnessRouteSource[];
  /** Set only when the caller asked about one harness (the CLI's text view). */
  harness?: HarnessPresetBody;
  /** Whether ADE's proxy binary can run on this host (it downloads on first use). */
  proxyAvailable: boolean;
};

export function harnessRouteSourceKey(source: HarnessRouteSource["source"]): string {
  return source.kind === "opencode"
    ? `opencode:${source.providerId}`
    : `key:${source.provider}:${source.credentialId}`;
}

/** The route for one listed model in one harness. */
export function routeForListedModel(
  harness: HarnessPresetBody,
  source: HarnessRouteSource,
  model: HarnessRouteModel,
): HarnessRoute {
  return resolveHarnessRoute({
    harness,
    source: source.source,
    modelId: model.id,
    endpoints: source.endpoints,
    probe: model.probe ?? null,
  });
}

export type HarnessRouteTestResult = {
  ok: boolean;
  /** The protocol the check used. */
  protocol: RouteProtocol | null;
  latencyMs: number | null;
  /** How the harness will reach the model after this check. */
  route: HarnessRoute["kind"] | null;
  error?: string;
};

/**
 * The model id a launch passes for a harness + source + model. One rule, used
 * by main and the renderer: OpenCode running one of its own sign-ins names the
 * model by OpenCode's registry id (`opencode/<provider>/<model>`); every other
 * pairing passes the source's own id unchanged.
 */
export function launchModelIdFor(harness: HarnessPresetBody, source: HarnessPresetSource, model: string): string {
  const id = model.trim();
  if (harness === "opencode" && source.kind === "opencode" && !id.startsWith("opencode/")) {
    return encodeOpenCodeRegistryId(source.providerId, id);
  }
  return id;
}
