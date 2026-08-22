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
  getLocalProviderDefaultEndpoint,
  decodeOpenCodeRegistryId,
  ensureOpenCodeBaseURL,
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
  /** Lead servers inherit no user config, so ADE must supply what they need. */
  isolatedConfig?: boolean;
};

type StartOpenCodeSessionArgs = BuildOpenCodeConfigArgs & {
  directory: string;
  title?: string | null;
  sessionId?: string;
  ownerKind?: OpenCodeServerOwnerKind;
  ownerId?: string | null;
  ownerKey?: string | null;
  leaseKind?: "shared" | "dedicated";
  /** Isolate user/project config for an orchestrator lead only. */
  isolatedConfig?: boolean;
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

type OpenCodePermissionAction = "allow" | "ask" | "deny";

/**
 * The permission keys ADE sets. The OpenCode SDK's own type declares only five
 * of these and absorbs the rest through an index signature, so a typo would
 * compile and silently fail to apply — `websearch` vs `web_search` is a pair
 * this codebase has already been bitten by.
 */
type OpenCodePermissionKey =
  | "edit"
  | "bash"
  | "webfetch"
  | "doom_loop"
  | "external_directory"
  | "question"
  | "read"
  | "task"
  | "websearch"
  | "skill";

type OpenCodePermissionConfig = Partial<Record<OpenCodePermissionKey, OpenCodePermissionAction>>;

function buildPermissionConfig(
  permissionMode: PermissionMode,
): OpenCodePermissionConfig {
  if (permissionMode === "full-auto") {
    return {
      edit: "allow",
      bash: "allow",
      webfetch: "allow",
      doom_loop: "allow",
      // Every key OpenCode does not gate resolves to "allow" from its base "*"
      // rule, but `read` is not one of them: the base ruleset asks before
      // reading *.env / *.env.*, so full access still prompted. Full access
      // means no prompts.
      read: "allow",
      task: "allow",
      // external_directory stays "ask". That boundary is ADE's lane worktree,
      // not a permission tier the user picked — the same reason the system
      // prompt confines edits to the lane.
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
      // Plan denies `edit`, so it must deny `task` too. A spawned subagent runs
      // under its own ruleset — OpenCode's `general` is merge(base, todowrite
      // deny), i.e. edit ALLOWED — so leaving `task` open let plan mode write
      // files indirectly through a child session. Plan has to mean plan.
      task: "deny",
      external_directory: "deny",
      question: "allow",
      // Replaces the deprecated agent-level `tools` map. OpenCode desugars that
      // map into exactly these permission entries, and an explicit `permission`
      // block wins over it, so stating them directly is the supported spelling.
      websearch: "deny",
      skill: "deny",
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
  isolatedConfig?: boolean,
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
    const endpoint = trimToUndefined(settings?.endpoint);
    const discoveredModelCount = Object.keys(models).length;
    // Say nothing about a provider the user never set up. This config is merged
    // last and per key, so an ADE-invented baseURL would overwrite the endpoint
    // in the user's own opencode.json — repointing a configured remote host back
    // at localhost. Only an endpoint the user actually typed, or models ADE
    // discovered, justify naming the provider at all.
    if (!endpoint && !discoveredModelCount) return;
    // ollama is not in OpenCode's provider catalog, so nothing else can supply
    // its address, and naming models without one leaves them unrunnable. But
    // OPENCODE_CONFIG_CONTENT merges last, so an ADE default would replace a
    // remote endpoint in the user's own opencode.json — which ADE cannot read.
    // Only an isolated lead is safe to fill in: it inherits no user config, so
    // there is nothing to clobber and nothing else to supply the address.
    const resolvedEndpoint = endpoint
      ?? (isolatedConfig && family === "ollama" && discoveredModelCount
        ? getLocalProviderDefaultEndpoint(family)
        : undefined);
    provider[family] = {
      // lmstudio ships in OpenCode's provider catalog with its own npm package
      // and baseURL; ollama does not, so only ollama needs one stated here.
      ...(family === "ollama" ? { npm: "@ai-sdk/openai-compatible" } : {}),
      ...(resolvedEndpoint ? { options: { baseURL: ensureOpenCodeBaseURL(resolvedEndpoint) } } : {}),
      ...(discoveredModelCount > 0 ? { models } : {}),
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
  const provider = buildProviderConfig(args.projectConfig, args.discoveredLocalModels, args.isolatedConfig);
  const helperPermission = {
    edit: "deny",
    bash: "deny",
    webfetch: "deny",
    doom_loop: "deny",
    external_directory: "deny",
    question: "deny",
  } as const satisfies OpenCodePermissionConfig;

  // OPENCODE_CONFIG_CONTENT is merged last, so anything named here outranks the
  // user's opencode.json and only managed/MDM config beats it. `share` and
  // `snapshot` are therefore omitted: neither has ADE UI, and forcing
  // snapshot:false silently disabled OpenCode's own /undo and /revert, whose
  // documented default is true. `autoupdate` moved to OPENCODE_DISABLE_AUTOUPDATE
  // in the server env — ADE does pin the binary, but that does not need the
  // highest-precedence config slot.
  // See services/shared/providerConfigHomes.ts for the rule this follows.
  return {
    ...(provider ? { provider } : {}),
    ...(args.mcp ? { mcp: args.mcp } : {}),
    agent: {
      // hidden: these are ADE's own modes, not agents the user should see in
      // their Tab-cycle or @-autocomplete. Without a `mode` they would default
      // to "all" and show up in the picker.
      "ade-plan": {
        permission: buildPermissionConfig("plan"),
        hidden: true,
      },
      "ade-edit": {
        permission: buildPermissionConfig("edit"),
        hidden: true,
      },
      "ade-full-auto": {
        permission: buildPermissionConfig("full-auto"),
        hidden: true,
      },
      "ade-helper": {
        permission: helperPermission,
        // `steps`; `maxSteps` is the deprecated spelling.
        steps: 1,
        hidden: true,
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
  files?: OpenCodePromptFile[];
}): Array<TextPartInput | FilePartInput> {
  const parts: Array<TextPartInput | FilePartInput> = [];
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

/**
 * True only when an OpenCode server call failed with a confirmed
 * "session does not exist" (HTTP 404 / `NotFoundError`). Anything else — a
 * transport blip, timeout, HTML version-mismatch guard, auth hiccup — must NOT
 * be treated as a missing session: the caller would silently start a fresh,
 * empty session and strand the user's thread (t3code's #3604 silent context
 * loss). Walks a bounded chain of `cause`/`body`/`error`/`data` properties so
 * SDK wrapper shapes stay covered; any explicit non-404 status seals the walk.
 */
export function isOpenCodeNotFoundError(error: unknown): boolean {
  const visit = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== "object" || depth > 6) return false;
    const record = value as Record<string, unknown>;
    // A concrete non-404 status anywhere in this subtree seals it: the server
    // answered and the answer was not "missing".
    let sawStatus = false;
    for (const key of ["status", "statusCode"] as const) {
      const candidate = record[key];
      if (typeof candidate === "number" && Number.isFinite(candidate)) {
        if (candidate !== 404) return false;
        sawStatus = true;
      }
    }
    if (record.name === "NotFoundError") return true;
    for (const key of ["cause", "body", "error", "data"] as const) {
      const nested = record[key];
      if (nested === undefined || nested === null || Array.isArray(nested)) continue;
      if (visit(nested, depth + 1)) return true;
    }
    return sawStatus;
  };
  return visit(error, 0);
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
        isolatedConfig: args.isolatedConfig,
        logger: args.logger,
      })
    : await acquireDedicatedOpenCodeServer({
        ownerKey: ownerKey ?? `dedicated:${ownerKind}:${randomUUID()}`,
        config,
        ownerKind,
        ownerId: args.ownerId,
        isolatedConfig: args.isolatedConfig,
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
    } catch (error) {
      // Only a confirmed "session missing" may fall through to creation. Any
      // other failure (transport, timeout, server restart mid-request) must
      // surface — silently starting an empty session would strand the thread.
      if (!isOpenCodeNotFoundError(error)) {
        lease.close("error");
        throw error instanceof Error ? error : new Error(String(error));
      }
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
        // First-class system prompt on the wire. Never inject it as a
        // synthetic/ignored text part: OpenCode drops `ignored` parts from
        // model context entirely, so the prompt would silently never reach
        // the model.
        ...(args.system?.trim() ? { system: args.system.trim() } : {}),
        ...(toolSelection ? { tools: toolSelection } : {}),
        parts: buildOpenCodePromptParts({
          prompt: args.prompt,
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
