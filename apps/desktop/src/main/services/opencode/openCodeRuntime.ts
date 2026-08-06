import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import {
  createOpencodeClient,
  type Config as OpenCodeConfig,
  type Event,
  type FilePartInput,
  type OpencodeClient,
  type TextPartInput,
} from "@opencode-ai/sdk";
import {
  createOpencodeClient as createOpenCodeV2Client,
  type OpencodeClient as OpenCodeV2Client,
} from "@opencode-ai/sdk/v2/client";
import {
  decodeOpenCodeRegistryId,
  ensureOpenCodeBaseURL,
  getLocalProviderDefaultEndpoint,
  type LocalProviderFamily,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import type {
  AiCustomProviderConfig,
  AiLocalProviderConfigs,
  EffectiveProjectConfig,
  OpenCodeRuntimeSnapshot,
  ProjectConfigFile,
} from "../../../shared/types";
import { orchestrationLeadOpenCodeToolSelection } from "../../../shared/orchestrationRuntimePolicy";
import { stableStringify } from "../shared/utils";
import { resolveOpenCodeBinaryPath } from "./openCodeBinaryManager";
import type { PermissionMode } from "../ai/tools/universalTools";
import type { Logger } from "../logging/logger";
import {
  acquireDedicatedOpenCodeServer,
  acquireSharedOpenCodeServer,
  getOpenCodeRuntimeDiagnostics,
  type OpenCodeServerLease,
  type OpenCodeServerOwnerKind,
  type OpenCodeServerShutdownReason,
} from "./openCodeServerManager";

export type OpenCodeAgentProfile = "ade-plan" | "ade-edit" | "ade-full-auto" | "ade-helper";

const ADE_PLAN_TOOL_SELECTION: Record<string, boolean> = {
  // ADE planning uses coordinator tools such as spawn_worker. The native
  // `task` subagent tool is intentionally allowed so OpenCode child sessions
  // surface in the desktop / TUI subagents panes.
  codesearch: false,
  code_search: false,
  filesearch: false,
  file_search: false,
  websearch: false,
  web_search: false,
  skill: false,
  skills: false,
};

export type OpenCodeSessionHandle = {
  client: OpencodeClient;
  v2Client: OpenCodeV2Client;
  server: {
    url: string;
    close(): Promise<void>;
  };
  lease: OpenCodeServerLease;
  sessionId: string;
  initialTitle: string | null;
  directory: string;
  toolSelection: Record<string, boolean> | null;
  close(reason?: OpenCodeServerShutdownReason): Promise<void>;
  touch(): void;
  setBusy(busy: boolean): void;
  setEvictionHandler(handler: ((reason: OpenCodeServerShutdownReason) => void) | null): void;
};

export type OpenCodeQuestionInfo = {
  question: string;
  header: string;
  options: Array<{ label: string; description?: string }>;
  multiple?: boolean;
  custom?: boolean;
};

export type OpenCodeRuntimeEvent = Event | {
  type: "question.asked";
  properties: {
    id: string;
    sessionID: string;
    questions: OpenCodeQuestionInfo[];
    tool?: { messageID: string; callID: string };
  };
} | {
  type: "question.replied";
  properties: {
    sessionID: string;
    requestID: string;
    answers: string[][];
  };
} | {
  type: "question.rejected";
  properties: {
    sessionID: string;
    requestID: string;
  };
} | {
  type: "permission.asked";
  properties: {
    id: string;
    sessionID: string;
    permission: string;
    patterns?: string[];
    metadata?: Record<string, unknown>;
    tool?: { messageID: string; callID: string };
  };
};

export type OpenCodePromptFile = {
  path: string;
  mime: string;
  filename?: string;
};

export type DiscoveredLocalModelEntry = {
  provider: LocalProviderFamily;
  modelId: string;
  /** Whether the model is actively loaded/running. Only loaded models are injected into OpenCode config. */
  loaded?: boolean;
};

type BuildOpenCodeConfigArgs = {
  projectConfig: ProjectConfigFile | EffectiveProjectConfig;
  /** Dynamically discovered models from local provider endpoints (e.g. LM Studio /v1/models). */
  discoveredLocalModels?: DiscoveredLocalModelEntry[];
  mcp?: OpenCodeConfig["mcp"];
};

type StartOpenCodeSessionArgs = BuildOpenCodeConfigArgs & {
  directory: string;
  title?: string | null;
  sessionId?: string;
  ownerKind?: OpenCodeServerOwnerKind;
  ownerId?: string | null;
  ownerKey?: string | null;
  leaseKind?: "shared" | "dedicated";
  logger?: Logger | null;
};

type RunOpenCodePromptArgs = BuildOpenCodeConfigArgs & {
  directory: string;
  title?: string | null;
  modelDescriptor: ModelDescriptor;
  prompt: string;
  system?: string;
  files?: OpenCodePromptFile[];
  agent?: OpenCodeAgentProfile;
  signal?: AbortSignal;
};

function trimToUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeProviderModelId(descriptor: ModelDescriptor): string {
  const candidate = descriptor.providerModelId.trim();
  const providerPrefix = `${descriptor.family}/`;
  if (candidate.toLowerCase().startsWith(providerPrefix)) {
    const stripped = candidate.slice(providerPrefix.length).trim();
    return stripped || candidate;
  }
  return candidate;
}

export function resolveOpenCodeModelSelection(descriptor: ModelDescriptor): {
  providerID: string;
  modelID: string;
} {
  const opPid = descriptor.openCodeProviderId?.trim();
  const opMid = descriptor.openCodeModelId?.trim();
  if (opPid && opMid) {
    return { providerID: opPid, modelID: opMid };
  }
  if (descriptor.providerRoute === "opencode" || descriptor.openCodeProviderId) {
    const decoded = decodeOpenCodeRegistryId(descriptor.id);
    if (decoded) {
      return { providerID: decoded.openCodeProviderId, modelID: decoded.openCodeModelId };
    }
  }
  return {
    providerID: descriptor.family,
    modelID: normalizeProviderModelId(descriptor),
  };
}

function buildPermissionConfig(
  permissionMode: PermissionMode,
): {
  edit: "allow" | "ask" | "deny";
  bash: "allow" | "ask" | "deny";
  webfetch: "allow" | "ask" | "deny";
  doom_loop: "allow" | "ask" | "deny";
  external_directory: "allow" | "ask" | "deny";
  question: "allow" | "ask" | "deny";
} {
  if (permissionMode === "full-auto") {
    return {
      edit: "allow",
      bash: "allow",
      webfetch: "allow",
      doom_loop: "allow",
      external_directory: "ask",
      question: "allow",
    };
  }

  if (permissionMode === "plan") {
    return {
      edit: "deny",
      bash: "ask",
      webfetch: "allow",
      doom_loop: "ask",
      external_directory: "deny",
      question: "allow",
    };
  }

  return {
    edit: "ask",
    bash: "ask",
    webfetch: "allow",
    doom_loop: "ask",
    external_directory: "ask",
    question: "allow",
  };
}

function fingerprintOpenCodeConfig(config: OpenCodeConfig): string {
  return stableStringify(config);
}

export function buildSharedOpenCodeServerKey(config: OpenCodeConfig): string {
  return `shared:${fingerprintOpenCodeConfig(config)}`;
}

export function buildOpenCodeMergedConfig(args: BuildOpenCodeConfigArgs): OpenCodeConfig {
  return buildOpenCodeConfig(args);
}

type OpenCodeProviderMap = NonNullable<OpenCodeConfig["provider"]>;
type OpenCodeProviderEntry = OpenCodeProviderMap[string];
type OpenCodeModelsMap = NonNullable<OpenCodeProviderEntry["models"]>;
type OpenCodeModelEntry = OpenCodeModelsMap[string];

/**
 * Provider ids OpenCode ships with in its built-in models.dev catalog. A custom
 * model slug (`providerId/modelId`) whose provider is not otherwise present in
 * the generated config may still be materialised as a bare provider block for
 * these — OpenCode already knows their npm package + base URL, so an empty
 * `models` entry is enough to surface the model in `provider.list()`. Slugs for
 * providers outside this set (and not user-configured) are dropped, since a
 * bare block would leave OpenCode unable to load the provider. Keep this list in
 * sync with OpenCode's catalog as new mainstream providers are added.
 */
const KNOWN_OPENCODE_CATALOG_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "openai",
  "anthropic",
  "google",
  "google-vertex",
  "google-vertex-anthropic",
  "azure",
  "amazon-bedrock",
  "openrouter",
  "groq",
  "mistral",
  "deepseek",
  "xai",
  "togetherai",
  "fireworks-ai",
  "cerebras",
  "cohere",
  "perplexity",
  "deepinfra",
  "github-copilot",
  "github-models",
  "huggingface",
  "moonshotai",
  "zhipuai",
  "opencode",
  "ollama",
  "lmstudio",
]);

function buildProviderConfig(
  projectConfig: ProjectConfigFile | EffectiveProjectConfig,
  discoveredLocalModels?: DiscoveredLocalModelEntry[],
): OpenCodeConfig["provider"] | undefined {
  const ai = projectConfig.ai ?? {};
  const apiKeys = ai.apiKeys ?? {};
  const localProviders = ai.localProviders ?? {};
  const provider: OpenCodeProviderMap = {};

  const addApiProvider = (
    id: string,
    key: string | null | undefined,
    options?: Record<string, unknown>,
  ): void => {
    const apiKey = trimToUndefined(key);
    if (!apiKey) return;
    provider[id] = {
      options: {
        apiKey,
        ...(options ?? {}),
      },
    };
  };

  // Resolve a stored API key for a specific provider id. Defaults to a no-op so
  // the config still builds when the key store is unavailable (e.g. unit tests).
  let resolveStoredApiKey: (id: string) => string | null = () => null;

  // Merge keys from the encrypted local store first (lower priority).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const store = require("../ai/apiKeyStore") as {
      getAllApiKeys: () => Record<string, string>;
      getApiKey: (id: string) => string | null;
    };
    for (const [providerId, key] of Object.entries(store.getAllApiKeys())) {
      addApiProvider(providerId.trim().toLowerCase(), key);
    }
    resolveStoredApiKey = (id: string) => store.getApiKey(id);
  } catch {
    // Key store may not be available (e.g. unit tests).
  }

  // Pass ALL project-config API keys to OpenCode (higher priority — overwrites store keys).
  for (const [providerId, key] of Object.entries(apiKeys)) {
    addApiProvider(providerId, key);
  }

  // Build a lookup of discovered models per local provider family so we can
  // inject them into the OpenCode provider config.  Without explicit `models`
  // entries OpenCode rejects any model ID it doesn't already know about from
  // its built-in registry or global config.
  const discoveredByFamily = new Map<LocalProviderFamily, DiscoveredLocalModelEntry[]>();
  if (discoveredLocalModels) {
    for (const entry of discoveredLocalModels) {
      const list = discoveredByFamily.get(entry.provider) ?? [];
      list.push(entry);
      discoveredByFamily.set(entry.provider, list);
    }
  }

  const addLocalProvider = (
    family: LocalProviderFamily,
    settings: AiLocalProviderConfigs[LocalProviderFamily] | undefined,
  ): void => {
    if (settings?.enabled === false) return;
    const models: Record<string, { name: string }> = {};
    const discovered = discoveredByFamily.get(family)?.filter((e) => e.loaded !== false);
    if (discovered) {
      for (const { modelId } of discovered) {
        models[modelId] = { name: modelId };
      }
    }
    const rawEndpoint = trimToUndefined(settings?.endpoint) ?? getLocalProviderDefaultEndpoint(family);
    provider[family] = {
      npm: "@ai-sdk/openai-compatible",
      options: {
        baseURL: ensureOpenCodeBaseURL(rawEndpoint),
      },
      ...(Object.keys(models).length > 0 ? { models } : {}),
    };
  };

  addLocalProvider("ollama", localProviders.ollama);
  addLocalProvider("lmstudio", localProviders.lmstudio);

  // User-defined custom providers: emit a full OpenCode provider block each.
  addCustomProviders(provider, ai.customProviders, resolveStoredApiKey);

  // Custom model slugs (`providerId/modelId`): surface extra models on providers
  // OpenCode already knows about so its `provider.list()` includes them.
  mergeCustomModelSlugs(provider, ai.customModelSlugs);

  return Object.keys(provider).length > 0 ? provider : undefined;
}

function addCustomProviders(
  provider: OpenCodeProviderMap,
  customProviders: AiCustomProviderConfig[] | undefined,
  resolveStoredApiKey: (id: string) => string | null,
): void {
  if (!customProviders?.length) return;
  for (const entry of customProviders) {
    const id = entry?.id?.trim();
    const baseURL = entry?.baseURL?.trim();
    const models = (entry?.models ?? [])
      .map((model) => model?.trim())
      .filter((model): model is string => Boolean(model));
    if (!id || !baseURL || models.length === 0) {
      console.warn("opencode.custom_provider_skipped", {
        id: entry?.id,
        reason: !id ? "missing-id" : !baseURL ? "missing-baseURL" : "no-models",
      });
      continue;
    }
    const modelsMap: OpenCodeModelsMap = {};
    for (const modelId of models) {
      modelsMap[modelId] = {} as OpenCodeModelEntry;
    }
    const apiKey = trimToUndefined(resolveStoredApiKey(id));
    const existing = provider[id];
    provider[id] = {
      ...(existing ?? {}),
      npm: entry.npm ?? "@ai-sdk/openai-compatible",
      name: trimToUndefined(entry.name) ?? id,
      options: {
        ...(existing?.options ?? {}),
        baseURL,
        ...(apiKey ? { apiKey } : {}),
      },
      models: {
        ...(existing?.models ?? {}),
        ...modelsMap,
      },
    };
  }
}

function mergeCustomModelSlugs(
  provider: OpenCodeProviderMap,
  customModelSlugs: string[] | undefined,
): void {
  if (!customModelSlugs?.length) return;
  for (const raw of customModelSlugs) {
    const slug = raw?.trim();
    if (!slug) continue;
    const slashIndex = slug.indexOf("/");
    if (slashIndex <= 0 || slashIndex >= slug.length - 1) {
      console.warn("opencode.custom_model_slug_skipped", { slug: raw, reason: "malformed" });
      continue;
    }
    const providerId = slug.slice(0, slashIndex).trim();
    const modelId = slug.slice(slashIndex + 1).trim();
    if (!providerId || !modelId) {
      console.warn("opencode.custom_model_slug_skipped", { slug: raw, reason: "malformed" });
      continue;
    }
    const existing = provider[providerId];
    if (existing) {
      provider[providerId] = {
        ...existing,
        models: {
          ...(existing.models ?? {}),
          [modelId]: existing.models?.[modelId] ?? ({} as OpenCodeModelEntry),
        },
      };
      continue;
    }
    if (KNOWN_OPENCODE_CATALOG_PROVIDER_IDS.has(providerId.toLowerCase())) {
      provider[providerId] = {
        models: { [modelId]: {} as OpenCodeModelEntry },
      };
      continue;
    }
    console.warn("opencode.custom_model_slug_skipped", { slug: raw, reason: "unknown-provider" });
  }
}

export function buildOpenCodeConfig(args: BuildOpenCodeConfigArgs): OpenCodeConfig {
  const provider = buildProviderConfig(args.projectConfig, args.discoveredLocalModels);
  const helperPermission = {
    edit: "deny",
    bash: "deny",
    webfetch: "deny",
    doom_loop: "deny",
    external_directory: "deny",
    question: "deny",
  } as const;

  return {
    share: "disabled",
    autoupdate: false,
    snapshot: false,
    ...(provider ? { provider } : {}),
    ...(args.mcp ? { mcp: args.mcp } : {}),
    agent: {
      "ade-plan": {
        permission: buildPermissionConfig("plan"),
        tools: ADE_PLAN_TOOL_SELECTION,
      },
      "ade-edit": {
        permission: buildPermissionConfig("edit"),
      },
      "ade-full-auto": {
        permission: buildPermissionConfig("full-auto"),
      },
      "ade-helper": {
        permission: helperPermission,
        maxSteps: 1,
      },
    },
  };
}

async function findAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate an OpenCode port.")));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

export async function allocateOpenCodeEphemeralPort(): Promise<number> {
  return await findAvailablePort();
}

export function resolveOpenCodeExecutablePath(): string | null {
  return resolveOpenCodeBinaryPath();
}

/** Future: attach to `opencode serve` via `createOpencodeClient({ baseUrl, headers })` when users configure a remote URL + password (see OpenCode server auth docs). */

function ensureOpenCodeAvailable(): void {
  if (!resolveOpenCodeExecutablePath()) {
    throw new Error(
      "OpenCode CLI is not available. Neither a user-installed nor a bundled binary could be found.",
    );
  }
}

export function mapPermissionModeToOpenCodeAgent(mode: PermissionMode): OpenCodeAgentProfile {
  if (mode === "plan") return "ade-plan";
  if (mode === "full-auto") return "ade-full-auto";
  return "ade-edit";
}

export function buildOpenCodePromptParts(args: {
  prompt: string;
  system?: string;
  files?: OpenCodePromptFile[];
}): Array<TextPartInput | FilePartInput> {
  const parts: Array<TextPartInput | FilePartInput> = [];
  if (args.system?.trim()) {
    parts.push({
      type: "text",
      text: args.system.trim(),
      synthetic: true,
      ignored: true,
    });
  }
  parts.push({
    type: "text",
    text: args.prompt,
  });
  for (const file of args.files ?? []) {
    parts.push({
      type: "file",
      mime: file.mime,
      filename: file.filename,
      url: pathToFileURL(file.path).toString(),
    });
  }
  return parts;
}

function createOpenCodeSessionHandle(args: {
  client: OpencodeClient;
  v2Client: OpenCodeV2Client;
  lease: OpenCodeServerLease;
  sessionId: string;
  initialTitle?: string | null;
  directory: string;
  toolSelection: Record<string, boolean> | null;
}): OpenCodeSessionHandle {
  return {
    client: args.client,
    v2Client: args.v2Client,
    server: {
      url: args.lease.url,
      async close() {
        args.lease.close("handle_close");
      },
    },
    lease: args.lease,
    sessionId: args.sessionId,
    initialTitle: trimToUndefined(args.initialTitle) ?? null,
    directory: args.directory,
    toolSelection: args.toolSelection,
    async close(reason = "handle_close") {
      args.lease.close(reason);
    },
    touch() {
      args.lease.touch();
    },
    setBusy(busy: boolean) {
      args.lease.setBusy(busy);
    },
    setEvictionHandler(handler) {
      args.lease.setEvictionHandler(handler);
    },
  };
}

async function startOpenCodeSessionInternal(
  args: StartOpenCodeSessionArgs,
): Promise<OpenCodeSessionHandle> {
  const config = buildOpenCodeConfig(args);
  const ownerKind = args.ownerKind ?? "oneshot";
  const leaseKind = args.leaseKind ?? "dedicated";
  const ownerKey = args.ownerKey?.trim()
    || (leaseKind === "dedicated"
      ? `${ownerKind}:${args.ownerId?.trim() || args.sessionId?.trim() || `${args.directory}:${args.title}:${randomUUID()}`}`
      : null);
  const lease = leaseKind === "shared"
    ? await acquireSharedOpenCodeServer({
        config,
        key: buildSharedOpenCodeServerKey(config),
        ownerKind,
        ownerId: args.ownerId,
        logger: args.logger,
      })
    : await acquireDedicatedOpenCodeServer({
        ownerKey: ownerKey ?? `dedicated:${ownerKind}:${randomUUID()}`,
        config,
        ownerKind,
        ownerId: args.ownerId,
        logger: args.logger,
      });
  const client = createOpencodeClient({
    baseUrl: lease.url,
    directory: args.directory,
  });
  const v2Client = createOpenCodeV2Client({
    baseUrl: lease.url,
    directory: args.directory,
  });
  const resolvedSessionId = trimToUndefined(args.sessionId);

  if (resolvedSessionId) {
    try {
      const existing = await client.session.get({
        path: { id: resolvedSessionId },
        query: { directory: args.directory },
        throwOnError: true,
      });
      return createOpenCodeSessionHandle({
        client,
        v2Client,
        lease,
        sessionId: resolvedSessionId,
        initialTitle: existing.data?.title,
        directory: args.directory,
        toolSelection: null,
      });
    } catch {
      // Fall through to session creation when the persisted session no longer exists.
    }
  }

  const created = await client.session.create({
    query: { directory: args.directory },
    body: trimToUndefined(args.title) ? { title: trimToUndefined(args.title) } : {},
    throwOnError: true,
  });

  if (!created.data) {
    lease.close("error");
    throw new Error("OpenCode session.create returned no session payload.");
  }

  return createOpenCodeSessionHandle({
    client,
    v2Client,
    lease,
    sessionId: created.data.id,
    initialTitle: created.data.title,
    directory: args.directory,
    toolSelection: null,
  });
}

export async function startOpenCodeSession(
  args: StartOpenCodeSessionArgs,
): Promise<OpenCodeSessionHandle> {
  ensureOpenCodeAvailable();
  return await startOpenCodeSessionInternal(args);
}

export function getOpenCodeRuntimeSnapshot(): OpenCodeRuntimeSnapshot {
  return {
    ...getOpenCodeRuntimeDiagnostics(),
  };
}

export function __resetOpenCodeRuntimeDiagnosticsForTests(): void {
  // Preserved for older tests; OpenCode no longer tracks per-session ADE tool registration.
}

export async function openCodeEventStream(args: {
  client: OpencodeClient;
  directory: string;
  signal?: AbortSignal;
}): Promise<AsyncGenerator<OpenCodeRuntimeEvent>> {
  const result = await args.client.event.subscribe({
    query: { directory: args.directory },
    signal: args.signal,
  });
  return result.stream as AsyncGenerator<OpenCodeRuntimeEvent>;
}

/**
 * Resolves the `tools` map ADE sends with every OpenCode prompt.
 *
 * OpenCode has no server-side role model: whatever it exposes, the model may
 * call. `session.prompt`'s `tools` map is the only lever, so an orchestrator
 * lead gets every write/shell tool explicitly switched off here. Every other
 * session keeps OpenCode's defaults (`null` — field omitted entirely).
 */
export async function refreshOpenCodeSessionToolSelection(
  handle: OpenCodeSessionHandle,
  options?: { orchestrationLead?: boolean },
): Promise<Record<string, boolean> | null> {
  handle.toolSelection = options?.orchestrationLead
    ? orchestrationLeadOpenCodeToolSelection()
    : null;
  return handle.toolSelection;
}

export async function runOpenCodeTextPrompt(
  args: RunOpenCodePromptArgs,
): Promise<{ text: string; inputTokens: number | null; outputTokens: number | null }> {
  const handle = await startOpenCodeSession({
    directory: args.directory,
    title: args.title,
    projectConfig: args.projectConfig,
    leaseKind: "shared",
    ownerKind: "oneshot",
  });

  const model = resolveOpenCodeModelSelection(args.modelDescriptor);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(args.signal?.reason);
  args.signal?.addEventListener("abort", forwardAbort, { once: true });

  try {
    const stream = await openCodeEventStream({
      client: handle.client,
      directory: handle.directory,
      signal: controller.signal,
    });
    const toolSelection = await refreshOpenCodeSessionToolSelection(handle);

    await handle.client.session.promptAsync({
      path: { id: handle.sessionId },
      query: { directory: handle.directory },
      throwOnError: true,
      body: {
        agent: args.agent ?? "ade-helper",
        model,
        ...(toolSelection ? { tools: toolSelection } : {}),
        parts: buildOpenCodePromptParts({
          prompt: args.prompt,
          system: args.system,
          files: args.files,
        }),
      },
    });

    let text = "";
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    for await (const event of stream) {
      if (event.type === "message.part.updated") {
        const { part, delta } = event.properties;
        if (part.sessionID !== handle.sessionId) continue;
        if (part.type === "text" || part.type === "reasoning") {
          text += typeof delta === "string" ? delta : part.text;
        }
        if (part.type === "step-finish") {
          inputTokens = part.tokens.input;
          outputTokens = part.tokens.output;
        }
        continue;
      }

      if (event.type === "session.error" && event.properties.sessionID === handle.sessionId) {
        const message = event.properties.error?.data?.message ?? "OpenCode prompt failed.";
        throw new Error(String(message));
      }

      if (event.type === "session.idle" && event.properties.sessionID === handle.sessionId) {
        break;
      }
    }

    return { text: text.trim(), inputTokens, outputTokens };
  } finally {
    args.signal?.removeEventListener("abort", forwardAbort);
    await handle.close("handle_close");
  }
}
