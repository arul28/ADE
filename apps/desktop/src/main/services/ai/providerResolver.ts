// ---------------------------------------------------------------------------
// Provider Resolver — maps model descriptors + auth to AI SDK instances
// ---------------------------------------------------------------------------

import type { LanguageModel } from "ai";
import {
  getModelById,
  resolveModelAlias,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import type { DetectedAuth } from "./authDetector";
import { resolveClaudeCodeExecutable } from "./claudeCodeExecutable";
import { resolveCodexExecutable } from "./codexExecutable";
import { wrapWithMiddleware, type WrapMiddlewareOpts } from "./middleware";
import { resolveViaAdeProviderRegistry } from "./adeProviderRegistry";
export { buildProviderOptions } from "./providerOptions";

// ---------------------------------------------------------------------------
// Lazy provider loaders — avoids importing unused SDK packages at startup.
// Optional packages may not have type declarations installed, so we use a
// generic dynamic-import helper that returns `any` for the module namespace.
// The try/catch ensures a clear error message when the package is missing.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tryImport(pkg: string): Promise<any> {
  // Use an opaque dynamic import to prevent bundlers (esbuild/tsup) from resolving
  // the package at bundle time. Optional provider packages may not be installed.
  try {
    return await (new Function("p", "return import(p)")(pkg) as Promise<unknown>);
  } catch {
    throw new Error(`Package ${pkg} is not installed. Run: npm install ${pkg}`);
  }
}

async function loadClaudeCodeProvider() {
  const mod = await import("ai-sdk-provider-claude-code");
  return mod.createClaudeCode;
}

async function loadCodexCliProvider() {
  const mod = await import("ai-sdk-provider-codex-cli");
  const moduleRecord = mod as Record<string, unknown>;
  const factory = moduleRecord.createCodexCli ?? moduleRecord.createCodexCLI;
  if (typeof factory !== "function") {
    throw new Error("ai-sdk-provider-codex-cli is installed but does not export createCodexCli/createCodexCLI.");
  }
  return factory as (opts?: { defaultSettings?: Record<string, unknown> }) => (model: string) => unknown;
}

async function loadAnthropicProvider() {
  const mod = await tryImport("@ai-sdk/anthropic");
  return mod.createAnthropic as (opts: { apiKey: string }) => (model: string) => unknown;
}

async function loadOpenAIProvider() {
  const mod = await tryImport("@ai-sdk/openai");
  return mod.createOpenAI as (opts: { apiKey: string }) => (model: string) => unknown;
}

async function loadGoogleProvider() {
  const mod = await tryImport("@ai-sdk/google");
  return mod.createGoogleGenerativeAI as (opts: { apiKey: string }) => (model: string) => unknown;
}

async function loadOpenAICompatibleProvider() {
  const mod = await tryImport("@ai-sdk/openai-compatible");
  return mod.createOpenAICompatible as (opts: { name: string; baseURL: string; apiKey?: string }) => (model: string) => unknown;
}

async function loadMistralProvider() {
  const mod = await tryImport("@ai-sdk/mistral");
  return mod.createMistral as (opts: { apiKey: string }) => (model: string) => unknown;
}

async function loadXaiProvider() {
  const mod = await tryImport("@ai-sdk/xai");
  return mod.createXai as (opts: { apiKey: string }) => (model: string) => unknown;
}

async function loadOpenRouterProvider() {
  const mod = await tryImport("@openrouter/ai-sdk-provider");
  return mod.createOpenRouter as (opts: { apiKey: string }) => (model: string) => unknown;
}

// ---------------------------------------------------------------------------
// Auth matching
// ---------------------------------------------------------------------------

function findApiKey(auth: DetectedAuth[], provider: string): string | undefined {
  for (const a of auth) {
    if (a.type === "api-key" && a.provider === provider) return a.key;
  }
  return undefined;
}

function findOpenRouterKey(auth: DetectedAuth[]): string | undefined {
  for (const a of auth) {
    if (a.type === "openrouter") return a.key;
  }
  return undefined;
}

function findLocalEndpoint(auth: DetectedAuth[], provider: string): string | undefined {
  for (const a of auth) {
    if (a.type === "local" && a.provider === provider) return a.endpoint;
  }
  return undefined;
}

function hasCliSubscription(auth: DetectedAuth[], cli: string): boolean {
  return auth.some((a) => a.type === "cli-subscription" && a.cli === cli);
}

// ---------------------------------------------------------------------------
// Base URL map for OpenAI-compatible providers
// ---------------------------------------------------------------------------

const COMPATIBLE_BASE_URLS: Record<string, string> = {
  deepseek: "https://api.deepseek.com/v1",
  groq: "https://api.groq.com/openai/v1",
  together: "https://api.together.xyz/v1",
};

const DEFAULT_LOCAL_ENDPOINTS: Record<"ollama" | "lmstudio" | "vllm", string> = {
  ollama: "http://localhost:11434",
  lmstudio: "http://localhost:1234",
  vllm: "http://localhost:8000",
};

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

async function resolveAutoModelIdFromOpenAiCompatibleEndpoint(
  endpoint: string,
  providerName: string,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${normalizeBaseUrl(endpoint)}/v1/models`, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Failed to list models from ${providerName} (${response.status}).`);
    }
    const payload = await response.json() as { data?: Array<{ id?: unknown }> };
    const firstModelId = payload.data?.find((entry) => typeof entry?.id === "string" && entry.id.trim().length)?.id;
    if (!firstModelId || typeof firstModelId !== "string") {
      throw new Error(`${providerName} did not return any usable model IDs.`);
    }
    return firstModelId.trim();
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveOpenAiCompatibleModelId(
  sdkModelId: string,
  endpoint: string,
  providerName: string,
): Promise<string> {
  if (sdkModelId !== "auto") return sdkModelId;
  return resolveAutoModelIdFromOpenAiCompatibleEndpoint(endpoint, providerName);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ResolveModelOpts = {
  cwd?: string;
  /** Middleware options. Pass false to skip middleware entirely. */
  middleware?: WrapMiddlewareOpts | false;
  /** CLI provider-specific model settings (for MCP/server injection, etc). */
  cli?: {
    mcpServers?: Record<string, Record<string, unknown>>;
    claude?: Record<string, unknown>;
    codex?: Record<string, unknown>;
  };
};

function firstNonEmptyString(...candidates: unknown[]): string | undefined {
  for (const value of candidates) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

export function normalizeCliMcpServers(
  provider: "claude" | "codex",
  mcpServers?: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> | undefined {
  if (!mcpServers) return undefined;

  return Object.fromEntries(
    Object.entries(mcpServers).map(([name, server]) => {
      if (typeof server !== "object" || server === null) {
        return [name, server];
      }

      const record = server as Record<string, unknown>;
      const { type, transport, ...rest } = record;

      if (provider === "codex") {
        const resolvedTransport = firstNonEmptyString(transport, type) ?? "stdio";
        return [name, { ...rest, transport: resolvedTransport }];
      }

      const resolvedType = firstNonEmptyString(type, transport)
        ?? (typeof rest.command === "string" && rest.command.trim().length > 0 ? "stdio" : undefined);
      return [name, resolvedType ? { ...rest, type: resolvedType } : { ...rest }];
    }),
  );
}

function buildCliDefaultSettings(
  provider: "claude" | "codex",
  opts?: ResolveModelOpts,
  auth?: DetectedAuth[],
): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  const cwd = opts?.cwd?.trim() || process.cwd();
  settings.cwd = cwd;
  if (opts?.cli?.mcpServers) {
    settings.mcpServers = normalizeCliMcpServers(provider, opts.cli.mcpServers);
  }
  const providerOverrides = provider === "claude" ? opts?.cli?.claude : opts?.cli?.codex;
  if (providerOverrides && typeof providerOverrides === "object") {
    Object.assign(settings, providerOverrides);
  }
  if (provider === "claude" && settings.settingSources == null) {
    settings.settingSources = ["user", "project", "local"];
  }
  if (provider === "claude" && settings.systemPrompt == null) {
    settings.systemPrompt = { type: "preset", preset: "claude_code" };
  }
  if (provider === "claude" && settings.pathToClaudeCodeExecutable == null) {
    settings.pathToClaudeCodeExecutable = resolveClaudeCodeExecutable({ auth }).path;
  }
  if (provider === "codex" && settings.codexPath == null) {
    settings.codexPath = resolveCodexExecutable({ auth }).path;
  }
  return settings;
}

export async function resolveModel(
  modelId: string,
  auth: DetectedAuth[],
  opts?: ResolveModelOpts,
): Promise<LanguageModel> {
  const descriptor = getModelById(modelId) ?? resolveModelAlias(modelId);
  if (!descriptor) {
    throw new Error(`Unknown model: "${modelId}". Check the model registry for available models.`);
  }

  // CLI-wrapped providers
  let model: LanguageModel;
  if (descriptor.isCliWrapped) {
    model = await resolveCliWrapped(descriptor, auth, opts);
  } else {
    model = await resolveDirectProvider(descriptor, auth);
  }

  // Apply middleware stack (unless explicitly disabled)
  if (opts?.middleware !== false) {
    model = wrapWithMiddleware(model, descriptor, opts?.middleware || undefined);
  }

  return resolveViaAdeProviderRegistry(descriptor, model);
}

async function resolveCliWrapped(
  descriptor: ModelDescriptor,
  auth: DetectedAuth[],
  opts?: ResolveModelOpts,
): Promise<LanguageModel> {
  const cli = descriptor.cliCommand;

  if (cli === "claude") {
    if (!hasCliSubscription(auth, "claude")) {
      throw new Error(
        "Claude CLI is required for this model but was not detected. Install and authenticate Claude Code.",
      );
    }
    const createClaudeCode = await loadClaudeCodeProvider();
    const provider = createClaudeCode({
      defaultSettings: buildCliDefaultSettings("claude", opts, auth),
    });
    return provider(descriptor.sdkModelId) as LanguageModel;
  }

  if (cli === "codex") {
    if (!hasCliSubscription(auth, "codex")) {
      throw new Error(
        "Codex CLI is required for this model but was not detected. Install and authenticate Codex.",
      );
    }
    const createCodexCli = await loadCodexCliProvider();
    const provider = createCodexCli({
      defaultSettings: buildCliDefaultSettings("codex", opts, auth),
    });
    return provider(descriptor.sdkModelId) as LanguageModel;
  }

  throw new Error(`Unknown CLI command "${cli}" for model "${descriptor.id}".`);
}

async function resolveDirectProvider(
  descriptor: ModelDescriptor,
  auth: DetectedAuth[],
): Promise<LanguageModel> {
  const { sdkProvider, sdkModelId, family } = descriptor;

  switch (sdkProvider) {
    case "@ai-sdk/anthropic": {
      const apiKey = findApiKey(auth, "anthropic");
      if (!apiKey) throw new Error("Anthropic API key is required. Set ANTHROPIC_API_KEY or add it in settings.");
      const createAnthropic = await loadAnthropicProvider();
      return createAnthropic({ apiKey })(sdkModelId) as LanguageModel;
    }

    case "@ai-sdk/openai": {
      const apiKey = findApiKey(auth, "openai");
      if (!apiKey) throw new Error("OpenAI API key is required. Set OPENAI_API_KEY or add it in settings.");
      const createOpenAI = await loadOpenAIProvider();
      return createOpenAI({ apiKey })(sdkModelId) as LanguageModel;
    }

    case "@ai-sdk/google": {
      const apiKey = findApiKey(auth, "google");
      if (!apiKey) throw new Error("Google API key is required. Set GOOGLE_API_KEY or add it in settings.");
      const createGoogle = await loadGoogleProvider();
      return createGoogle({ apiKey })(sdkModelId) as LanguageModel;
    }

    case "@ai-sdk/mistral": {
      const apiKey = findApiKey(auth, "mistral");
      if (!apiKey) throw new Error("Mistral API key is required. Set MISTRAL_API_KEY or add it in settings.");
      const createMistral = await loadMistralProvider();
      return createMistral({ apiKey })(sdkModelId) as LanguageModel;
    }

    case "@ai-sdk/xai": {
      const apiKey = findApiKey(auth, "xai");
      if (!apiKey) throw new Error("xAI API key is required. Set XAI_API_KEY or add it in settings.");
      const createXai = await loadXaiProvider();
      return createXai({ apiKey })(sdkModelId) as LanguageModel;
    }

    case "@ai-sdk/deepseek": {
      const apiKey = findApiKey(auth, "deepseek");
      if (!apiKey) throw new Error("DeepSeek API key is required. Set DEEPSEEK_API_KEY or add it in settings.");
      const baseURL = COMPATIBLE_BASE_URLS.deepseek;
      const createCompatible = await loadOpenAICompatibleProvider();
      const provider = createCompatible({ name: "deepseek", baseURL, apiKey });
      return provider(sdkModelId) as LanguageModel;
    }

    case "@openrouter/ai-sdk-provider": {
      const apiKey = findOpenRouterKey(auth);
      if (!apiKey) throw new Error("OpenRouter API key is required. Set OPENROUTER_API_KEY or add it in settings.");
      const createOpenRouter = await loadOpenRouterProvider();
      return createOpenRouter({ apiKey })(sdkModelId) as LanguageModel;
    }

    case "@ai-sdk/openai-compatible": {
      // Local providers (ollama, lmstudio, vllm)
      if (family === "ollama" || family === "lmstudio" || family === "vllm") {
        const localProvider = family;
        const endpoint = findLocalEndpoint(auth, localProvider) ?? DEFAULT_LOCAL_ENDPOINTS[localProvider];
        const resolvedModelId = await resolveOpenAiCompatibleModelId(sdkModelId, endpoint, localProvider);
        const createCompatible = await loadOpenAICompatibleProvider();
        const provider = createCompatible({
          name: localProvider,
          baseURL: `${normalizeBaseUrl(endpoint)}/v1`,
        });
        return provider(resolvedModelId) as LanguageModel;
      }

      // Generic compatible provider via base URL
      const baseURL = COMPATIBLE_BASE_URLS[family];
      if (baseURL) {
        const apiKey = findApiKey(auth, family);
        if (!apiKey) {
          throw new Error(`API key required for ${family}. Check your settings or environment variables.`);
        }
        const createCompatible = await loadOpenAICompatibleProvider();
        const provider = createCompatible({ name: family, baseURL, apiKey });
        return provider(sdkModelId) as LanguageModel;
      }

      throw new Error(`No base URL configured for OpenAI-compatible provider "${family}".`);
    }

    default:
      throw new Error(`Unsupported SDK provider "${sdkProvider}" for model "${descriptor.id}".`);
  }
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

export function isModelCliWrapped(modelId: string): boolean {
  const descriptor = getModelById(modelId) ?? resolveModelAlias(modelId);
  return descriptor?.isCliWrapped ?? false;
}
