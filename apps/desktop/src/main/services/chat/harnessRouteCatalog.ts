/**
 * Every model a harness could draw on outside its own sign-in, and the live
 * check behind the Test button.
 *
 * Sources are the machine's OpenCode sign-ins (OpenCode Go, Zen, and anything
 * signed in inside OpenCode) and its stored API keys. Model lists come from
 * what ADE already knows — a key's own declared models, OpenCode's cached
 * inventory for the same provider, then the static registry — so listing never
 * spends a request. Routes are computed in the renderer from the pure
 * `resolveHarnessRoute`, which is why each source ships its endpoints and each
 * model its probe verdict rather than a pre-decided route.
 */

import { randomUUID } from "node:crypto";

import {
  canonicalSourceProvider,
  endpointsForSource,
  harnessRouteSourceKey,
  HARNESS_ROUTE_PROTOCOLS,
  isOpenCodeHouseSource,
  KNOWN_SOURCE_ENDPOINTS,
  modelProtocols,
  resolveHarnessRoute,
  ROUTE_PROTOCOLS,
  type HarnessRouteCatalog,
  type HarnessRouteModel,
  type HarnessRouteSource,
  type HarnessRouteTestResult,
  type RouteEndpoints,
  type RouteProtocol,
} from "../../../shared/harnessRoutes";
import { isHarnessPresetBody, openCodeSourceLabel, type HarnessPresetBody } from "../../../shared/harnessPresets";
import { MODEL_REGISTRY, type ProviderFamily } from "../../../shared/modelRegistry";
import { getApiCredentialKey, listApiCredentials } from "../ai/apiKeyStore";
import {
  readOpenCodeLaunchSecret,
  readOpenCodeSignedInProviderIds,
} from "../opencode/openCodeCredentials";
import { listPersistedOpenCodeProviderModels } from "../opencode/openCodeInventory";
import { resolveMachineAdeDir } from "../../../../../ade-cli/src/services/projects/machineLayout";
import { readRouteProbe, recordRouteProbe } from "./harnessRouteProbes";
import { OPENCODE_SESSION_HEADER } from "./harnessRouteLaunch";

/** Key-store providers whose keys never route: they sign their own tool in. */
const NON_ROUTABLE_KEY_PROVIDERS = new Set(["cursor", "devin", "factory", "droid", "copilot", "github-copilot"]);

const REGISTRY_FAMILY_FOR_PROVIDER: Record<string, ProviderFamily> = {
  anthropic: "anthropic",
  openai: "openai",
  deepseek: "deepseek",
  xai: "xai",
  moonshotai: "moonshot",
  mistral: "mistral",
  groq: "groq",
  google: "google",
  openrouter: "openrouter",
  together: "together",
};

function modelsForProvider(
  providerId: string,
  adeHome: string,
  declared?: readonly string[],
): HarnessRouteModel[] {
  const provider = canonicalSourceProvider(providerId);
  const withProbe = (model: HarnessRouteModel): HarnessRouteModel => {
    const probe = readRouteProbe(adeHome, provider, model.id);
    return probe ? { ...model, probe } : model;
  };
  if (declared && declared.length > 0) {
    return declared.map((id) => withProbe({ id, label: id }));
  }
  const fromOpenCode = listPersistedOpenCodeProviderModels(provider);
  if (fromOpenCode.length > 0) {
    return fromOpenCode
      .filter((descriptor) => descriptor.openCodeModelId && !descriptor.deprecated)
      .map((descriptor) => withProbe({
        id: descriptor.openCodeModelId!,
        label: descriptor.displayName,
        ...(descriptor.contextWindow ? { contextWindow: descriptor.contextWindow } : {}),
        ...(descriptor.maxOutputTokens ? { maxOutputTokens: descriptor.maxOutputTokens } : {}),
        ...(descriptor.reasoningTiers?.length ? { reasoningTiers: [...descriptor.reasoningTiers] } : {}),
      }));
  }
  const family = REGISTRY_FAMILY_FOR_PROVIDER[provider];
  if (!family) return [];
  return MODEL_REGISTRY
    .filter((model) => model.family === family && !model.deprecated)
    .map((model) => withProbe({
      id: model.providerModelId || model.shortId || model.id,
      label: model.displayName,
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
      ...(model.reasoningTiers?.length ? { reasoningTiers: [...model.reasoningTiers] } : {}),
    }));
}

/** The whole catalog. Cheap: disk caches only, no network. */
export function listHarnessRouteCatalog(deps: { adeHome?: string } = {}): HarnessRouteCatalog {
  const adeHome = deps.adeHome ?? resolveMachineAdeDir();
  const sources: HarnessRouteSource[] = [];

  for (const providerId of readOpenCodeSignedInProviderIds()) {
    const endpoints = KNOWN_SOURCE_ENDPOINTS[canonicalSourceProvider(providerId)] ?? {};
    if (Object.keys(endpoints).length === 0) continue;
    const source = { kind: "opencode" as const, providerId };
    const models = modelsForProvider(providerId, adeHome);
    if (models.length === 0) continue;
    sources.push({
      key: harnessRouteSourceKey(source),
      source,
      label: openCodeSourceLabel(providerId),
      detail: "via your OpenCode sign-in",
      logoProvider: providerId,
      endpoints,
      models,
    });
  }

  let credentials: ReturnType<typeof listApiCredentials> = [];
  try {
    credentials = listApiCredentials();
  } catch {
    credentials = [];
  }
  for (const credential of credentials) {
    const provider = credential.provider.trim().toLowerCase();
    if (NON_ROUTABLE_KEY_PROVIDERS.has(provider)) continue;
    const endpoints = endpointsForSource({
      provider,
      baseUrl: credential.baseUrl,
      protocol: credential.protocol,
    });
    if (Object.keys(endpoints).length === 0) continue;
    const models = modelsForProvider(provider, adeHome, credential.models);
    if (models.length === 0 && !credential.baseUrl) continue;
    const source = {
      kind: "key" as const,
      provider: credential.provider,
      credentialId: credential.credentialId,
      label: credential.label?.trim() || credential.provider,
    };
    sources.push({
      key: harnessRouteSourceKey(source),
      source,
      label: credential.label?.trim() && credential.label.trim() !== credential.provider
        ? credential.label.trim()
        : providerDisplayName(provider),
      detail: credential.maskedTail ? `API key ••••${credential.maskedTail}` : "API key",
      logoProvider: provider,
      endpoints,
      models,
    });
  }

  return { sources, proxyAvailable: true };
}

function providerDisplayName(provider: string): string {
  const names: Record<string, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    deepseek: "DeepSeek",
    openrouter: "OpenRouter",
    moonshotai: "Moonshot",
    xai: "xAI",
    groq: "Groq",
    mistral: "Mistral",
    together: "Together AI",
    google: "Google AI",
    zhipuai: "Zhipu",
  };
  return names[canonicalSourceProvider(provider)] ?? provider;
}

// ---------------------------------------------------------------------------
// The live check
// ---------------------------------------------------------------------------

const PROTOCOL_UNSUPPORTED = /does not support this protocol|unsupported (protocol|endpoint)|not supported on this endpoint/i;

type Fetch = typeof fetch;

async function pingProtocol(args: {
  protocol: RouteProtocol;
  baseUrl: string;
  token: string;
  model: string;
  sessionHeader: string | null;
  fetchImpl: Fetch;
  timeoutMs: number;
}): Promise<{ ok: boolean; status: number | null; error?: string; latencyMs: number }> {
  const { protocol, baseUrl, token, model } = args;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    "user-agent": "ade-harness-test/1.0",
  };
  if (args.sessionHeader) headers[OPENCODE_SESSION_HEADER] = args.sessionHeader;
  let url: string;
  let body: Record<string, unknown>;
  if (protocol === "anthropic") {
    url = `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/messages`;
    headers["anthropic-version"] = "2023-06-01";
    body = { model, max_tokens: 8, messages: [{ role: "user", content: "Reply with OK." }] };
  } else if (protocol === "openai-chat") {
    url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
    body = { model, max_tokens: 8, messages: [{ role: "user", content: "Reply with OK." }] };
  } else {
    url = `${baseUrl.replace(/\/+$/, "")}/responses`;
    body = { model, max_output_tokens: 16, input: "Reply with OK." };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  const started = Date.now();
  try {
    const response = await args.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (response.ok) {
      // Drain so the connection is released; the content is irrelevant.
      await response.text().catch(() => "");
      return { ok: true, status: response.status, latencyMs };
    }
    const text = await response.text().catch(() => "");
    return { ok: false, status: response.status, error: summarizeError(text, response.status), latencyMs };
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: controller.signal.aborted ? "The endpoint did not answer in time." : (error instanceof Error ? error.message : String(error)),
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

function summarizeError(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = parsed.error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Not JSON.
  }
  const trimmed = body.trim().slice(0, 200);
  return trimmed ? `HTTP ${status}: ${trimmed}` : `HTTP ${status}`;
}

/**
 * Send one tiny request for a (harness, source, model) and remember what the
 * endpoint said. Tries the protocols the harness can speak first (a direct
 * route), then the rest (a proxy route). A "does not support this protocol"
 * answer is recorded as a definitive no, so the next launch routes around it.
 */
export async function testHarnessRoute(
  args: {
    harness: string;
    source: HarnessRouteSource["source"];
    model: string;
  },
  deps: { adeHome?: string; fetchImpl?: Fetch; timeoutMs?: number } = {},
): Promise<HarnessRouteTestResult> {
  const adeHome = deps.adeHome ?? resolveMachineAdeDir();
  if (!isHarnessPresetBody(args.harness)) {
    return { ok: false, protocol: null, latencyMs: null, route: null, error: "Unknown harness." };
  }
  const harness: HarnessPresetBody = args.harness;
  const model = args.model.trim();
  if (!model) return { ok: false, protocol: null, latencyMs: null, route: null, error: "Choose a model." };

  let sourceProvider: string;
  let endpoints: RouteEndpoints;
  let token: string | null;
  if (args.source.kind === "opencode") {
    sourceProvider = args.source.providerId;
    endpoints = KNOWN_SOURCE_ENDPOINTS[canonicalSourceProvider(sourceProvider)] ?? {};
    const secret = readOpenCodeLaunchSecret(sourceProvider);
    token = secret && (secret.expiresAt === null || secret.expiresAt > Date.now()) ? secret.token : null;
    if (!token) {
      return { ok: false, protocol: null, latencyMs: null, route: null, error: "Not signed in to this provider in OpenCode, or the sign-in expired." };
    }
  } else {
    sourceProvider = args.source.provider;
    const credential = listApiCredentials(args.source.provider)
      .find((entry) => entry.credentialId === (args.source as { credentialId: string }).credentialId);
    endpoints = endpointsForSource({
      provider: sourceProvider,
      baseUrl: credential?.baseUrl,
      protocol: credential?.protocol,
    });
    token = getApiCredentialKey(args.source.provider, args.source.credentialId)?.trim() || null;
    if (!token) return { ok: false, protocol: null, latencyMs: null, route: null, error: "That API key is not on this machine." };
  }

  const served = modelProtocols({ sourceProvider, modelId: model, endpoints, probe: null });
  const harnessFirst = [
    ...HARNESS_ROUTE_PROTOCOLS[harness].filter((protocol) => served.includes(protocol)),
    ...ROUTE_PROTOCOLS.filter((protocol) => served.includes(protocol) && !HARNESS_ROUTE_PROTOCOLS[harness].includes(protocol)),
    // A protocol the seed/catalog ruled out is still worth one try when
    // nothing else answered — the seed can be out of date.
    ...ROUTE_PROTOCOLS.filter((protocol) => Boolean(endpoints[protocol]) && !served.includes(protocol)),
  ];
  const sessionHeader = isOpenCodeHouseSource(sourceProvider) ? `ade-test-${randomUUID()}` : null;
  let lastError = "This provider has no endpoint ADE can test.";
  for (const protocol of harnessFirst) {
    const result = await pingProtocol({
      protocol,
      baseUrl: endpoints[protocol]!,
      token,
      model,
      sessionHeader,
      fetchImpl: deps.fetchImpl ?? fetch,
      timeoutMs: deps.timeoutMs ?? 30_000,
    });
    if (result.ok) {
      recordRouteProbe(adeHome, sourceProvider, model, protocol, true);
      const route = resolveHarnessRoute({
        harness,
        source: args.source,
        modelId: model,
        endpoints,
        probe: readRouteProbe(adeHome, sourceProvider, model),
      });
      return { ok: route.kind !== "impossible", protocol, latencyMs: result.latencyMs, route: route.kind, ...(route.kind === "impossible" ? { error: route.reason } : {}) };
    }
    lastError = result.error ?? lastError;
    if (result.error && PROTOCOL_UNSUPPORTED.test(result.error)) {
      recordRouteProbe(adeHome, sourceProvider, model, protocol, false);
      continue;
    }
    // Auth, balance, rate limit, network: the protocol question is unanswered
    // and the next protocol would fail the same way.
    return { ok: false, protocol, latencyMs: result.latencyMs, route: null, error: lastError };
  }
  return { ok: false, protocol: null, latencyMs: null, route: null, error: lastError };
}

// ---------------------------------------------------------------------------
// The terminal launcher: `eval "$(ade harness env <preset>)" && claude`
// ---------------------------------------------------------------------------

export type HarnessLaunchShell = "zsh" | "bash" | "pwsh";

export type HarnessLaunchEnvResult = {
  harness: HarnessPresetBody;
  model: string;
  /** Shell lines that export the environment. Contains secrets — print, never persist. */
  script: string;
  /** The command to run after the exports, e.g. `claude --model deepseek-v4.1-flash`. */
  command: string;
};

function shellQuote(value: string, shell: HarnessLaunchShell): string {
  if (shell === "pwsh") return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const HARNESS_BINARIES: Partial<Record<HarnessPresetBody, { bin: string; modelFlag: string }>> = {
  claude: { bin: "claude", modelFlag: "--model" },
  codex: { bin: "codex", modelFlag: "-m" },
  grok: { bin: "grok", modelFlag: "-m" },
  qwen: { bin: "qwen", modelFlag: "-m" },
  droid: { bin: "droid", modelFlag: "-m" },
  opencode: { bin: "opencode", modelFlag: "-m" },
};

export function buildHarnessLaunchEnv(
  args: { presetId: string; shell?: HarnessLaunchShell },
  resolve: (presetId: string) => import("./harnessPresetLaunch").HarnessPresetLaunchResult | null,
): HarnessLaunchEnvResult {
  const shell = args.shell ?? "zsh";
  const result = resolve(args.presetId);
  if (!result) throw new Error("That custom provider does not exist on this account.");
  if (result.status === "unsupported") throw new Error(result.unsupported);
  const harness = result.provider;
  const lines = Object.entries(result.env).map(([key, value]) => (shell === "pwsh"
    ? `$env:${key} = ${shellQuote(value, shell)}`
    : `export ${key}=${shellQuote(value, shell)}`));
  const binary = HARNESS_BINARIES[harness];
  const model = result.model.trim();
  const effort = result.reasoningEffort?.trim();
  const command = binary
    ? [
      binary.bin,
      ...(model ? [binary.modelFlag, model] : []),
      ...(harness === "claude" && effort ? ["--effort", effort] : []),
    ].join(" ")
    : harness;
  return { harness, model, script: `${lines.join("\n")}\n`, command };
}

/**
 * Whether a key or OpenCode source can back a launch on this machine. The
 * machine inventory uses it so a Custom provider built on a stored key or an
 * OpenCode sign-in reads as usable here, not only account-sourced ones.
 */
export function isPresetSourceAvailableLocally(source: { kind: string } & Record<string, unknown>): boolean {
  try {
    if (source.kind === "opencode" && typeof source.providerId === "string") {
      return readOpenCodeSignedInProviderIds().includes(source.providerId);
    }
    if (source.kind === "key" && typeof source.provider === "string" && typeof source.credentialId === "string") {
      return listApiCredentials(source.provider).some((entry) => entry.credentialId === source.credentialId);
    }
  } catch {
    return false;
  }
  return false;
}
