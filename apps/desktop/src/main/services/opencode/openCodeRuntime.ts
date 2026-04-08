import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import {
  createOpencodeClient,
  createOpencodeServer,
  type Config as OpenCodeConfig,
  type Event,
  type FilePartInput,
  type OpencodeClient,
  type TextPartInput,
} from "@opencode-ai/sdk";
import {
  decodeOpenCodeRegistryId,
  ensureOpenCodeBaseURL,
  getLocalProviderDefaultEndpoint,
  type LocalProviderFamily,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import type { AiLocalProviderConfigs, EffectiveProjectConfig, ProjectConfigFile } from "../../../shared/types";
import { resolveOpenCodeBinaryPath } from "./openCodeBinaryManager";
import type { PermissionMode } from "../ai/tools/universalTools";
import type { AdeMcpLaunch } from "../runtime/adeMcpLaunch";

export type OpenCodeAgentProfile = "ade-plan" | "ade-edit" | "ade-full-auto" | "ade-helper";

export type OpenCodeSessionHandle = {
  client: OpencodeClient;
  server: {
    url: string;
    close(): void;
  };
  sessionId: string;
  directory: string;
  close(): void;
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
  mcpLaunch?: AdeMcpLaunch;
  projectConfig: ProjectConfigFile | EffectiveProjectConfig;
  /** Dynamically discovered models from local provider endpoints (e.g. LM Studio /v1/models). */
  discoveredLocalModels?: DiscoveredLocalModelEntry[];
};

type StartOpenCodeSessionArgs = BuildOpenCodeConfigArgs & {
  directory: string;
  title: string;
  sessionId?: string;
};

type RunOpenCodePromptArgs = BuildOpenCodeConfigArgs & {
  directory: string;
  title: string;
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
} {
  if (permissionMode === "full-auto") {
    return {
      edit: "allow",
      bash: "allow",
      webfetch: "allow",
      doom_loop: "allow",
      external_directory: "ask",
    };
  }

  if (permissionMode === "plan") {
    return {
      edit: "deny",
      bash: "ask",
      webfetch: "allow",
      doom_loop: "ask",
      external_directory: "deny",
    };
  }

  return {
    edit: "ask",
    bash: "ask",
    webfetch: "allow",
    doom_loop: "ask",
    external_directory: "ask",
  };
}

export function buildOpenCodeMergedConfig(args: BuildOpenCodeConfigArgs): OpenCodeConfig {
  return buildOpenCodeConfig(args);
}

function buildProviderConfig(
  projectConfig: ProjectConfigFile | EffectiveProjectConfig,
  discoveredLocalModels?: DiscoveredLocalModelEntry[],
): OpenCodeConfig["provider"] | undefined {
  const ai = projectConfig.ai ?? {};
  const apiKeys = ai.apiKeys ?? {};
  const localProviders = ai.localProviders ?? {};
  const provider: NonNullable<OpenCodeConfig["provider"]> = {};

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

  // Pass ALL stored API keys to OpenCode — supports any of its 100+ providers dynamically.
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

  return Object.keys(provider).length > 0 ? provider : undefined;
}

export function buildOpenCodeConfig(args: BuildOpenCodeConfigArgs): OpenCodeConfig {
  const provider = buildProviderConfig(args.projectConfig, args.discoveredLocalModels);
  const helperPermission = {
    edit: "deny",
    bash: "deny",
    webfetch: "deny",
    doom_loop: "deny",
    external_directory: "deny",
  } as const;

  return {
    share: "disabled",
    autoupdate: false,
    snapshot: false,
    ...(provider ? { provider } : {}),
    agent: {
      "ade-plan": {
        permission: buildPermissionConfig("plan"),
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
    ...(args.mcpLaunch
      ? {
          mcp: {
            ade: {
              type: "local",
              command: [args.mcpLaunch.command, ...args.mcpLaunch.cmdArgs],
              environment: args.mcpLaunch.env,
            },
          },
        }
      : {}),
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

function isPortConflict(error: unknown): boolean {
  if (error && typeof error === "object") {
    if ("code" in error && error.code === "EADDRINUSE") return true;
    if (error instanceof Error) {
      return error.message.includes("EADDRINUSE") || error.message.includes("address already in use");
    }
  }
  return false;
}

const PORT_RETRY_ATTEMPTS = 3;

export async function createOpencodeServerWithRetry(
  config: OpenCodeConfig,
): Promise<{ port: number; server: Awaited<ReturnType<typeof createOpencodeServer>> }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < PORT_RETRY_ATTEMPTS; attempt++) {
    const port = await findAvailablePort();
    try {
      const server = await createOpencodeServer({ port, config });
      return { port, server };
    } catch (error) {
      lastError = error;
      if (!isPortConflict(error)) throw error;
    }
  }
  throw lastError;
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

export async function startOpenCodeSession(
  args: StartOpenCodeSessionArgs,
): Promise<OpenCodeSessionHandle> {
  ensureOpenCodeAvailable();
  const { server } = await createOpencodeServerWithRetry(buildOpenCodeConfig(args));
  const client = createOpencodeClient({
    baseUrl: server.url,
    directory: args.directory,
  });
  const resolvedSessionId = trimToUndefined(args.sessionId);

  if (resolvedSessionId) {
    try {
      await client.session.get({
        path: { id: resolvedSessionId },
        query: { directory: args.directory },
      });
      return {
        client,
        server,
        sessionId: resolvedSessionId,
        directory: args.directory,
        close() {
          server.close();
        },
      };
    } catch {
      // Fall through to session creation when the persisted session no longer exists.
    }
  }

  const created = await client.session.create({
    query: { directory: args.directory },
    body: { title: args.title },
  });

  if (!created.data) {
    server.close();
    throw new Error("OpenCode session.create returned no session payload.");
  }

  return {
    client,
    server,
    sessionId: created.data.id,
    directory: args.directory,
    close() {
      server.close();
    },
  };
}

export async function openCodeEventStream(args: {
  client: OpencodeClient;
  directory: string;
  signal?: AbortSignal;
}): Promise<AsyncGenerator<Event>> {
  const result = await args.client.event.subscribe({
    query: { directory: args.directory },
    signal: args.signal,
  });
  return result.stream;
}

export async function runOpenCodeTextPrompt(
  args: RunOpenCodePromptArgs,
): Promise<{ text: string; inputTokens: number | null; outputTokens: number | null }> {
  const handle = await startOpenCodeSession({
    directory: args.directory,
    title: args.title,
    mcpLaunch: args.mcpLaunch,
    projectConfig: args.projectConfig,
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

    await handle.client.session.promptAsync({
      path: { id: handle.sessionId },
      query: { directory: handle.directory },
      body: {
        agent: args.agent ?? "ade-helper",
        model,
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
    handle.close();
  }
}
