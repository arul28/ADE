import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createConnection, createServer } from "node:net";
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
  decodeOpenCodeRegistryId,
  ensureOpenCodeBaseURL,
  getLocalProviderDefaultEndpoint,
  type LocalProviderFamily,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import type {
  AiLocalProviderConfigs,
  EffectiveProjectConfig,
  OpenCodeDynamicMcpDiagnostics,
  OpenCodeRuntimeSnapshot,
  ProjectConfigFile,
} from "../../../shared/types";
import { stableStringify } from "../shared/utils";
import { resolveOpenCodeBinaryPath } from "./openCodeBinaryManager";
import type { PermissionMode } from "../ai/tools/universalTools";
import type { AdeMcpLaunch } from "../runtime/adeMcpLaunch";
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
  server: {
    url: string;
    close(): Promise<void>;
  };
  lease: OpenCodeServerLease;
  sessionId: string;
  directory: string;
  toolSelection: Record<string, boolean> | null;
  close(reason?: OpenCodeServerShutdownReason): Promise<void>;
  touch(): void;
  setBusy(busy: boolean): void;
  setEvictionHandler(handler: ((reason: OpenCodeServerShutdownReason) => void) | null): void;
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
  ownerKind?: OpenCodeServerOwnerKind;
  ownerId?: string | null;
  ownerKey?: string | null;
  leaseKind?: "shared" | "dedicated";
  dynamicMcpLaunch?: AdeMcpLaunch;
  logger?: Logger | null;
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

function fingerprintOpenCodeConfig(config: OpenCodeConfig): string {
  return stableStringify(config);
}

export function buildSharedOpenCodeServerKey(config: OpenCodeConfig): string {
  return `shared:${fingerprintOpenCodeConfig(config)}`;
}

function sanitizeDynamicMcpNamePart(value: string | null | undefined, fallback: string): string {
  const normalized = (value?.trim() ?? "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized.slice(0, 48) : fallback;
}

function fingerprintAdeMcpLaunch(launch: AdeMcpLaunch): string {
  return createHash("sha1")
    .update(stableStringify({
      command: launch.command,
      cmdArgs: launch.cmdArgs,
      env: launch.env,
    }))
    .digest("hex")
    .slice(0, 10);
}

function buildDynamicAdeMcpServerName(args: {
  ownerKind: OpenCodeServerOwnerKind;
  ownerId?: string | null;
  ownerKey?: string | null;
  sessionId?: string;
  launch: AdeMcpLaunch;
}): string {
  const identity = sanitizeDynamicMcpNamePart(
    args.ownerId ?? args.ownerKey ?? args.sessionId,
    "session",
  );
  return `ade_session_${sanitizeDynamicMcpNamePart(args.ownerKind, "owner")}_${identity}_${fingerprintAdeMcpLaunch(args.launch)}`;
}

type OpenCodeMcpStatus = {
  status?: string;
  error?: string;
};

type OpenCodeMcpStatusMap = Record<string, OpenCodeMcpStatus>;

function readDynamicMcpStatus(
  payload: Record<string, unknown> | null,
  serverName: string,
): OpenCodeMcpStatus | null {
  if (!payload || typeof payload !== "object") return null;
  const entry = payload[serverName];
  if (!entry || typeof entry !== "object") return null;
  return entry as OpenCodeMcpStatus;
}

function buildFallbackToolSelection(allowedServerNames: Iterable<string>): Record<string, boolean> | null {
  const toolSelection: Record<string, boolean> = {};
  let hasSelection = false;

  for (const serverNameRaw of allowedServerNames) {
    const serverName = serverNameRaw.trim();
    if (!serverName) continue;
    if (serverName.startsWith("ade_session_")) {
      toolSelection["ade_session_*"] = false;
      hasSelection = true;
    }
    toolSelection[`${serverName}_*`] = true;
    hasSelection = true;
  }

  return hasSelection ? toolSelection : null;
}

function extractAllowedServerNamesFromToolSelection(
  toolSelection: Record<string, boolean> | null,
): string[] {
  if (!toolSelection) return [];
  return Object.entries(toolSelection)
    .filter(([, enabled]) => enabled)
    .map(([pattern]) => pattern.trim())
    .filter((pattern) => pattern.endsWith("_*"))
    .map((pattern) => pattern.slice(0, -2))
    .filter((serverName) => serverName.length > 0);
}

function buildScopedMcpToolSelection(args: {
  statuses: OpenCodeMcpStatusMap;
  allowedServerNames: Iterable<string>;
}): Record<string, boolean> | null {
  const allowed = new Set(
    Array.from(args.allowedServerNames)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
  const toolSelection = buildFallbackToolSelection(allowed) ?? {};
  let hasSelection = Object.keys(toolSelection).length > 0;

  for (const serverNameRaw of Object.keys(args.statuses)) {
    const serverName = serverNameRaw.trim();
    if (!serverName) continue;
    toolSelection[`${serverName}_*`] = allowed.has(serverName);
    hasSelection = true;
  }

  return hasSelection ? toolSelection : null;
}

async function resolveScopedMcpToolSelection(args: {
  baseUrl: string;
  directory: string;
  allowedServerNames: Iterable<string>;
}): Promise<Record<string, boolean> | null> {
  const fallback = buildFallbackToolSelection(args.allowedServerNames);
  try {
    const payload = await callOpenCodeServer<OpenCodeMcpStatusMap>({
      baseUrl: args.baseUrl,
      directory: args.directory,
      path: "/mcp",
    });
    if (!payload || typeof payload !== "object") return fallback;
    return buildScopedMcpToolSelection({
      statuses: payload,
      allowedServerNames: args.allowedServerNames,
    }) ?? fallback;
  } catch {
    return fallback;
  }
}

const DYNAMIC_ADE_MCP_REGISTRATION_ATTEMPTS = 3;
const DYNAMIC_ADE_MCP_REGISTRATION_RETRY_DELAY_MS = 150;
const DYNAMIC_ADE_MCP_SOCKET_READY_TIMEOUT_MS = 1_500;
const DYNAMIC_ADE_MCP_SOCKET_READY_RETRY_DELAY_MS = 75;
const dynamicMcpDiagnostics: OpenCodeDynamicMcpDiagnostics = {
  registrationAttempts: 0,
  successfulRegistrations: 0,
  retryCount: 0,
  fallbackCount: 0,
  lastFallbackAt: null,
  lastFallbackOwnerKind: null,
  lastFallbackOwnerId: null,
  lastFallbackError: null,
};

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAdeMcpSocketReady(socketPath: string): Promise<void> {
  const normalizedPath = socketPath.trim();
  if (!normalizedPath.length) return;
  const deadline = Date.now() + DYNAMIC_ADE_MCP_SOCKET_READY_TIMEOUT_MS;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    if (fs.existsSync(normalizedPath)) {
      try {
        await new Promise<void>((resolve, reject) => {
          const socket = createConnection(normalizedPath);
          const cleanup = (): void => {
            socket.off("connect", handleConnect);
            socket.off("error", handleError);
          };
          const handleConnect = () => {
            cleanup();
            socket.end();
            socket.destroy();
            resolve();
          };
          const handleError = (error: Error) => {
            cleanup();
            socket.destroy();
            reject(error);
          };
          socket.once("connect", handleConnect);
          socket.once("error", handleError);
        });
        return;
      } catch (error) {
        lastError = error;
      }
    }
    await wait(DYNAMIC_ADE_MCP_SOCKET_READY_RETRY_DELAY_MS);
  }

  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`ADE MCP socket not ready at ${normalizedPath}${detail}`);
}

async function callOpenCodeServer<T>(args: {
  baseUrl: string;
  directory: string;
  path: string;
  method?: "GET" | "POST";
  body?: unknown;
}): Promise<T | null> {
  const url = new URL(args.path, args.baseUrl);
  if (args.directory.trim().length > 0) {
    url.searchParams.set("directory", args.directory);
  }
  const response = await fetch(url, {
    method: args.method ?? "GET",
    headers: args.body === undefined ? undefined : {
      "content-type": "application/json",
    },
    body: args.body === undefined ? undefined : JSON.stringify(args.body),
  });
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new Error(
      `OpenCode server request ${args.method ?? "GET"} ${args.path} failed (${response.status})${detail ? `: ${detail}` : ""}.`,
    );
  }
  if (response.status === 204) return null;
  const text = (await response.text()).trim();
  if (!text.length) return null;
  return JSON.parse(text) as T;
}

async function ensureDynamicAdeMcpRegistration(args: {
  baseUrl: string;
  directory: string;
  ownerKind: OpenCodeServerOwnerKind;
  ownerId?: string | null;
  ownerKey?: string | null;
  sessionId?: string;
  launch: AdeMcpLaunch;
}): Promise<{
  serverName: string;
  disconnect(): Promise<void>;
}> {
  const serverName = buildDynamicAdeMcpServerName(args);
  dynamicMcpDiagnostics.registrationAttempts += 1;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < DYNAMIC_ADE_MCP_REGISTRATION_ATTEMPTS; attempt += 1) {
    try {
      await waitForAdeMcpSocketReady(args.launch.socketPath);
      let status = readDynamicMcpStatus(await callOpenCodeServer<Record<string, unknown>>({
        baseUrl: args.baseUrl,
        directory: args.directory,
        path: "/mcp",
      }), serverName);
      if (!status) {
        status = readDynamicMcpStatus(await callOpenCodeServer<Record<string, unknown>>({
          baseUrl: args.baseUrl,
          directory: args.directory,
          path: "/mcp",
          method: "POST",
          body: {
            name: serverName,
            config: {
              type: "local",
              command: [args.launch.command, ...args.launch.cmdArgs],
              environment: args.launch.env,
            },
          },
        }), serverName);
      }
      if (status?.status !== "connected") {
        await callOpenCodeServer({
          baseUrl: args.baseUrl,
          directory: args.directory,
          path: `/mcp/${encodeURIComponent(serverName)}/connect`,
          method: "POST",
        });
      }
      lastError = null;
      dynamicMcpDiagnostics.successfulRegistrations += 1;
      break;
    } catch (error) {
      lastError = error;
      if (attempt >= DYNAMIC_ADE_MCP_REGISTRATION_ATTEMPTS - 1) {
        throw error;
      }
      dynamicMcpDiagnostics.retryCount += 1;
      await wait(DYNAMIC_ADE_MCP_REGISTRATION_RETRY_DELAY_MS);
    }
  }
  if (lastError) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  let disconnected = false;
  return {
    serverName,
    async disconnect(): Promise<void> {
      if (disconnected) return;
      disconnected = true;
      await callOpenCodeServer({
        baseUrl: args.baseUrl,
        directory: args.directory,
        path: `/mcp/${encodeURIComponent(serverName)}/disconnect`,
        method: "POST",
      }).catch(() => {});
    },
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

  // Merge keys from the encrypted local store first (lower priority).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getAllApiKeys } = require("../ai/apiKeyStore") as { getAllApiKeys: () => Record<string, string> };
    for (const [providerId, key] of Object.entries(getAllApiKeys())) {
      addApiProvider(providerId.trim().toLowerCase(), key);
    }
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
  lease: OpenCodeServerLease;
  sessionId: string;
  directory: string;
  toolSelection: Record<string, boolean> | null;
  dynamicMcp?: Awaited<ReturnType<typeof ensureDynamicAdeMcpRegistration>> | null;
}): OpenCodeSessionHandle {
  return {
    client: args.client,
    server: {
      url: args.lease.url,
      async close() {
        try {
          await args.dynamicMcp?.disconnect();
        } catch {
          // best-effort — don't block lease release
        }
        args.lease.close("handle_close");
      },
    },
    lease: args.lease,
    sessionId: args.sessionId,
    directory: args.directory,
    toolSelection: args.toolSelection,
    async close(reason = "handle_close") {
      try {
        await args.dynamicMcp?.disconnect();
      } catch {
        // best-effort — don't block lease release
      }
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
  let dynamicMcp: Awaited<ReturnType<typeof ensureDynamicAdeMcpRegistration>> | null = null;
  try {
    if (args.dynamicMcpLaunch) {
      dynamicMcp = await ensureDynamicAdeMcpRegistration({
        baseUrl: lease.url,
        directory: args.directory,
        ownerKind,
        ownerId: args.ownerId,
        ownerKey,
        sessionId: args.sessionId,
        launch: args.dynamicMcpLaunch,
      });
    }
  } catch (error) {
    // Dynamic ADE MCP attachment can fail even when the underlying OpenCode
    // server is healthy. Release the shared lease without tearing the server
    // down so degraded retries can reuse the same process.
    lease.close("attach_failed");
    throw error;
  }

  const resolvedSessionId = trimToUndefined(args.sessionId);
  const scopedToolSelection = await resolveScopedMcpToolSelection({
    baseUrl: lease.url,
    directory: args.directory,
    allowedServerNames: dynamicMcp
      ? [dynamicMcp.serverName]
      : args.mcpLaunch
        ? ["ade"]
        : [],
  });

  if (resolvedSessionId) {
    try {
      await client.session.get({
        path: { id: resolvedSessionId },
        query: { directory: args.directory },
      });
      return createOpenCodeSessionHandle({
        client,
        lease,
        sessionId: resolvedSessionId,
        directory: args.directory,
        toolSelection: scopedToolSelection,
        dynamicMcp,
      });
    } catch {
      // Fall through to session creation when the persisted session no longer exists.
    }
  }

  const created = await client.session.create({
    query: { directory: args.directory },
    body: { title: args.title },
  });

  if (!created.data) {
    dynamicMcp?.disconnect().catch(() => {});
    lease.close("error");
    throw new Error("OpenCode session.create returned no session payload.");
  }

  return createOpenCodeSessionHandle({
    client,
    lease,
    sessionId: created.data.id,
    directory: args.directory,
    toolSelection: scopedToolSelection,
    dynamicMcp,
  });
}

export async function startOpenCodeSession(
  args: StartOpenCodeSessionArgs,
): Promise<OpenCodeSessionHandle> {
  ensureOpenCodeAvailable();
  if (args.dynamicMcpLaunch) {
    try {
      return await startOpenCodeSessionInternal({
        ...args,
        mcpLaunch: undefined,
      });
    } catch (error) {
      const ownerKind = args.ownerKind ?? "oneshot";
      const fallbackStrategy = ownerKind === "coordinator"
        ? "abort"
        : "shared_without_mcp";
      args.logger?.warn("opencode.dynamic_mcp_attach_failed", {
        ownerKind,
        ownerId: args.ownerId ?? null,
        sessionId: args.sessionId ?? null,
        error: error instanceof Error ? error.message : String(error),
        fallbackStrategy,
      });
      if (fallbackStrategy === "abort") {
        throw error;
      }
      dynamicMcpDiagnostics.fallbackCount += 1;
      dynamicMcpDiagnostics.lastFallbackAt = new Date().toISOString();
      dynamicMcpDiagnostics.lastFallbackOwnerKind = ownerKind;
      dynamicMcpDiagnostics.lastFallbackOwnerId = args.ownerId?.trim() || null;
      dynamicMcpDiagnostics.lastFallbackError = error instanceof Error ? error.message : String(error);
      return await startOpenCodeSessionInternal({
        ...args,
        dynamicMcpLaunch: undefined,
        mcpLaunch: undefined,
      });
    }
  }
  return await startOpenCodeSessionInternal(args);
}

export function getOpenCodeRuntimeSnapshot(): OpenCodeRuntimeSnapshot {
  return {
    ...getOpenCodeRuntimeDiagnostics(),
    dynamicMcp: { ...dynamicMcpDiagnostics },
  };
}

export function __resetOpenCodeRuntimeDiagnosticsForTests(): void {
  dynamicMcpDiagnostics.registrationAttempts = 0;
  dynamicMcpDiagnostics.successfulRegistrations = 0;
  dynamicMcpDiagnostics.retryCount = 0;
  dynamicMcpDiagnostics.fallbackCount = 0;
  dynamicMcpDiagnostics.lastFallbackAt = null;
  dynamicMcpDiagnostics.lastFallbackOwnerKind = null;
  dynamicMcpDiagnostics.lastFallbackOwnerId = null;
  dynamicMcpDiagnostics.lastFallbackError = null;
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

export async function refreshOpenCodeSessionToolSelection(
  handle: OpenCodeSessionHandle,
): Promise<Record<string, boolean> | null> {
  const refreshed = await resolveScopedMcpToolSelection({
    baseUrl: handle.lease.url,
    directory: handle.directory,
    allowedServerNames: extractAllowedServerNamesFromToolSelection(handle.toolSelection),
  });
  handle.toolSelection = refreshed;
  return refreshed;
}

export async function runOpenCodeTextPrompt(
  args: RunOpenCodePromptArgs,
): Promise<{ text: string; inputTokens: number | null; outputTokens: number | null }> {
  const handle = await startOpenCodeSession({
    directory: args.directory,
    title: args.title,
    mcpLaunch: args.mcpLaunch,
    projectConfig: args.projectConfig,
    leaseKind: args.mcpLaunch ? "dedicated" : "shared",
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
