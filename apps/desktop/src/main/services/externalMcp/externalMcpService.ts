import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Logger } from "../logging/logger";
import type {
  CtoIdentity,
  ExternalMcpAccessPolicy,
  ExternalMcpConnectionState,
  ExternalMcpMissionSelection,
  ExternalMcpResolvedServerConfig,
  ExternalMcpServerConfig,
  ExternalMcpServerSnapshot,
  ExternalMcpToolManifest,
  ExternalMcpToolSafety,
  ExternalMcpUsageEvent,
} from "../../../shared/types";
import { nowIso, stableStringify, writeTextAtomic } from "../shared/utils";
import type { WorkerAgentService } from "../cto/workerAgentService";
import type { createCtoStateService } from "../cto/ctoStateService";
import type { createMissionService } from "../missions/missionService";
import type { MissionBudgetService } from "../orchestrator/missionBudgetService";
import type { createWorkerBudgetService } from "../cto/workerBudgetService";

const DEFAULT_HEALTH_CHECK_INTERVAL_SEC = 30;
const MAX_RECONNECT_BACKOFF_MS = 60_000;
const MIN_RECONNECT_BACKOFF_MS = 2_000;
const CONFIG_RELOAD_DEBOUNCE_MS = 2_000;
const USAGE_EVENT_CAPACITY = 1_000;

const ENV_TOKEN = /\$\{env:([A-Z0-9_]+)\}/gi;
const BARE_ENV_TOKEN = /\$\{([A-Z0-9_]+)\}/g;

type ExternalMcpSessionIdentity = {
  callerId: string;
  role: "cto" | "orchestrator" | "agent" | "external" | "evaluator";
  missionId: string | null;
  runId: string | null;
  stepId: string | null;
  attemptId: string | null;
  ownerId: string | null;
};

type ExternalMcpServiceArgs = {
  projectRoot: string;
  adeDir: string;
  logger?: Logger | null;
  workerAgentService?: WorkerAgentService | null;
  ctoStateService?: ReturnType<typeof createCtoStateService> | null;
  missionService?: ReturnType<typeof createMissionService> | null;
  workerBudgetService?: ReturnType<typeof createWorkerBudgetService> | null;
  missionBudgetService?: MissionBudgetService | null;
};

type ClientTransport = StdioClientTransport | StreamableHTTPClientTransport;

type RuntimeServerState = {
  rawConfig: ExternalMcpServerConfig;
  resolvedConfig: ExternalMcpResolvedServerConfig;
  state: ExternalMcpConnectionState;
  client: Client | null;
  transport: ClientTransport | null;
  toolMap: Map<string, ExternalMcpToolManifest>;
  lastConnectedAt: string | null;
  lastHealthCheckAt: string | null;
  consecutivePingFailures: number;
  lastError: string | null;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  healthTimer: ReturnType<typeof setInterval> | null;
  signature: string;
  autoStart: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringMap(value: unknown, resolveEnv = false): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue !== "string") continue;
    const trimmed = rawValue.trim();
    if (!trimmed.length) continue;
    out[key] = resolveEnv ? resolveEnvTokens(trimmed) : trimmed;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((entry) => String(entry ?? "").trim())
    .filter((entry) => entry.length > 0);
  return out.length > 0 ? out : undefined;
}

function parseDurationSeconds(value: unknown, fallback = DEFAULT_HEALTH_CHECK_INTERVAL_SEC): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(5, Math.floor(value));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    const match = /^(\d+)\s*(ms|s|m|h)?$/i.exec(trimmed);
    if (match) {
      const amount = Number(match[1]);
      const unit = (match[2] ?? "s").toLowerCase();
      if (unit === "ms") return Math.max(5, Math.ceil(amount / 1000));
      if (unit === "m") return Math.max(5, amount * 60);
      if (unit === "h") return Math.max(5, amount * 3600);
      return Math.max(5, amount);
    }
  }
  return fallback;
}

function resolveEnvTokens(value: string): string {
  const replace = (input: string, pattern: RegExp, withPrefix: boolean): string =>
    input.replace(pattern, (_full, envName: string) => {
      const resolved = process.env[envName];
      if (typeof resolved !== "string" || resolved.length === 0) {
        const token = withPrefix ? `env:${envName}` : envName;
        throw new Error(`Missing required environment variable '${token}'.`);
      }
      return resolved;
    });

  return replace(replace(value, ENV_TOKEN, true), BARE_ENV_TOKEN, false);
}

function normalizeAccessPolicy(policy: unknown, allowAllDefault: boolean): ExternalMcpAccessPolicy {
  const source = isRecord(policy) ? policy : {};
  return {
    allowAll: typeof source.allowAll === "boolean" ? source.allowAll : allowAllDefault,
    allowedServers: asStringArray(source.allowedServers) ?? [],
    blockedServers: asStringArray(source.blockedServers) ?? [],
  };
}

function normalizeMissionSelection(value: unknown): ExternalMcpMissionSelection | undefined {
  if (!isRecord(value)) return undefined;
  const enabled = typeof value.enabled === "boolean" ? value.enabled : undefined;
  const selectedServers = asStringArray(value.selectedServers);
  const selectedTools = asStringArray(value.selectedTools);
  if (enabled == null && !selectedServers?.length && !selectedTools?.length) return undefined;
  return {
    ...(enabled != null ? { enabled } : {}),
    ...(selectedServers?.length ? { selectedServers } : {}),
    ...(selectedTools?.length ? { selectedTools } : {}),
  };
}

function classifyToolSafety(tool: {
  name: string;
  description?: string;
  annotations?: Record<string, unknown>;
}): ExternalMcpToolSafety {
  const annotations = isRecord(tool.annotations) ? tool.annotations : {};
  if (annotations.destructiveHint === true) return "write";
  if (annotations.readOnlyHint === true) return "read";
  const text = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
  if (/(create|update|delete|write|send|post|put|patch|commit|push|publish|archive|remove|edit|merge|deploy|execute)/.test(text)) {
    return "write";
  }
  if (/(read|list|get|search|find|query|fetch|show|lookup|inspect)/.test(text)) {
    return "read";
  }
  return "unknown";
}

function resolveCostCents(config: ExternalMcpServerConfig, toolName: string): { costCents: number; estimated: boolean } {
  const perTool = config.costHints?.perToolCostCents ?? {};
  const exact = Number(perTool[toolName]);
  if (Number.isFinite(exact) && exact >= 0) {
    return { costCents: Math.floor(exact), estimated: false };
  }
  const fallback = Number(config.costHints?.defaultCostCents ?? 0);
  return {
    costCents: Number.isFinite(fallback) && fallback > 0 ? Math.floor(fallback) : 0,
    estimated: true,
  };
}

function sortSnapshots(entries: ExternalMcpServerSnapshot[]): ExternalMcpServerSnapshot[] {
  return [...entries].sort((a, b) => a.config.name.localeCompare(b.config.name));
}

function sortTools(entries: ExternalMcpToolManifest[]): ExternalMcpToolManifest[] {
  return [...entries].sort((a, b) => a.namespacedName.localeCompare(b.namespacedName));
}

function normalizeServerConfig(raw: unknown): ExternalMcpServerConfig | null {
  if (!isRecord(raw)) return null;
  const name = asTrimmedString(raw.name);
  if (!name.length) return null;
  const transportRaw = asTrimmedString(raw.transport).toLowerCase();
  const transport =
    transportRaw === "stdio" || transportRaw === "http" || transportRaw === "sse"
      ? transportRaw
      : (asTrimmedString(raw.command).length ? "stdio" : "http");
  const base: ExternalMcpServerConfig = {
    name,
    transport,
    ...(typeof raw.autoStart === "boolean" ? { autoStart: raw.autoStart } : {}),
    healthCheckIntervalSec: parseDurationSeconds(
      raw.healthCheckIntervalSec ?? raw.healthCheckInterval ?? raw.healthIntervalSec,
      DEFAULT_HEALTH_CHECK_INTERVAL_SEC,
    ),
  };

  if (transport === "stdio") {
    const command = asTrimmedString(raw.command);
    if (!command.length) throw new Error(`externalMcp.${name} requires a command for stdio transport.`);
    return {
      ...base,
      command,
      ...(asStringArray(raw.args) ? { args: asStringArray(raw.args) } : {}),
      ...(asStringMap(raw.env) ? { env: asStringMap(raw.env) } : {}),
      ...(asTrimmedString(raw.cwd) ? { cwd: asTrimmedString(raw.cwd) } : {}),
      ...(normalizePermissionConfig(raw.permissions) ? { permissions: normalizePermissionConfig(raw.permissions) } : {}),
      ...(normalizeCostHints(raw.costHints) ? { costHints: normalizeCostHints(raw.costHints) } : {}),
    };
  }

  const url = asTrimmedString(raw.url);
  if (!url.length) throw new Error(`externalMcp.${name} requires a url for http/sse transport.`);
  return {
    ...base,
    url,
    ...(asStringMap(raw.headers) ? { headers: asStringMap(raw.headers) } : {}),
    ...(normalizePermissionConfig(raw.permissions) ? { permissions: normalizePermissionConfig(raw.permissions) } : {}),
    ...(normalizeCostHints(raw.costHints) ? { costHints: normalizeCostHints(raw.costHints) } : {}),
  };
}

function normalizePermissionConfig(value: unknown): ExternalMcpServerConfig["permissions"] | undefined {
  if (!isRecord(value)) return undefined;
  const allowedTools = asStringArray(value.allowedTools);
  const blockedTools = asStringArray(value.blockedTools);
  if (!allowedTools?.length && !blockedTools?.length) return undefined;
  return {
    ...(allowedTools?.length ? { allowedTools } : {}),
    ...(blockedTools?.length ? { blockedTools } : {}),
  };
}

function normalizeCostHints(value: unknown): ExternalMcpServerConfig["costHints"] | undefined {
  if (!isRecord(value)) return undefined;
  const defaultCostCents = Number(value.defaultCostCents);
  const perToolCostCents = isRecord(value.perToolCostCents)
    ? Object.fromEntries(
        Object.entries(value.perToolCostCents)
          .map(([key, rawValue]) => [key, Number(rawValue)] as const)
          .filter(([, rawValue]) => Number.isFinite(rawValue) && rawValue >= 0)
          .map(([key, rawValue]) => [key, Math.floor(rawValue)] as const),
      )
    : undefined;
  if (!Number.isFinite(defaultCostCents) && !perToolCostCents) return undefined;
  return {
    ...(Number.isFinite(defaultCostCents) ? { defaultCostCents: Math.floor(defaultCostCents) } : {}),
    ...(perToolCostCents && Object.keys(perToolCostCents).length > 0 ? { perToolCostCents } : {}),
  };
}

function resolveRuntimeConfig(config: ExternalMcpServerConfig): ExternalMcpResolvedServerConfig {
  if (config.transport === "stdio") {
    return {
      ...config,
      transport: "stdio",
      env: config.env ? Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, resolveEnvTokens(value)])) : undefined,
    };
  }

  return {
    ...config,
    transport: "http",
    headers: config.headers ? Object.fromEntries(Object.entries(config.headers).map(([key, value]) => [key, resolveEnvTokens(value)])) : undefined,
    url: config.url ? resolveEnvTokens(config.url) : config.url,
  };
}

function toSignature(config: ExternalMcpResolvedServerConfig): string {
  return stableStringify({
    name: config.name,
    transport: config.transport,
    command: config.command,
    args: config.args,
    env: config.env,
    cwd: config.cwd,
    url: config.url,
    headers: config.headers,
    healthCheckIntervalSec: config.healthCheckIntervalSec,
  });
}

function toManifest(serverName: string, tool: {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  title?: string;
}): ExternalMcpToolManifest {
  const annotations = isRecord(tool.annotations) ? tool.annotations : {};
  return {
    serverName,
    name: tool.name,
    namespacedName: `ext.${serverName}.${tool.name}`,
    description: tool.description,
    inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : { type: "object", properties: {} },
    ...(isRecord(tool.outputSchema) ? { outputSchema: tool.outputSchema } : {}),
    safety: classifyToolSafety(tool),
    enabled: true,
    ...(tool.title ? { title: tool.title } : {}),
    ...(annotations.readOnlyHint === true ? { readOnlyHint: true } : {}),
    ...(annotations.destructiveHint === true ? { destructiveHint: true } : {}),
  };
}

export function createExternalMcpService(args: ExternalMcpServiceArgs) {
  const secretPath = path.join(args.adeDir, "local.secret.yaml");
  const runtimes = new Map<string, RuntimeServerState>();
  const usageEvents: ExternalMcpUsageEvent[] = [];
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;

  const pushUsageEvent = (event: ExternalMcpUsageEvent): void => {
    usageEvents.push(event);
    while (usageEvents.length > USAGE_EVENT_CAPACITY) {
      usageEvents.shift();
    }
  };

  const readSecretDocument = (): Record<string, unknown> => {
    if (!fs.existsSync(secretPath)) return {};
    const raw = fs.readFileSync(secretPath, "utf8");
    const parsed = YAML.parse(raw);
    return isRecord(parsed) ? parsed : {};
  };

  const writeSecretDocument = (doc: Record<string, unknown>): void => {
    writeTextAtomic(secretPath, YAML.stringify(doc, { indent: 2 }));
  };

  const readConfiguredServers = (): ExternalMcpServerConfig[] => {
    const doc = readSecretDocument();
    const entries = Array.isArray(doc.externalMcp) ? doc.externalMcp : [];
    const seen = new Set<string>();
    const out: ExternalMcpServerConfig[] = [];
    for (const entry of entries) {
      const normalized = normalizeServerConfig(entry);
      if (!normalized) continue;
      if (seen.has(normalized.name)) {
        throw new Error(`Duplicate external MCP server name '${normalized.name}'.`);
      }
      seen.add(normalized.name);
      out.push(normalized);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  };

  const getAgentAccessPolicy = (identity: ExternalMcpSessionIdentity): ExternalMcpAccessPolicy => {
    if (identity.role === "agent" && identity.ownerId) {
      const agent = args.workerAgentService?.getAgent(identity.ownerId, { includeDeleted: false }) ?? null;
      return normalizeAccessPolicy(agent?.externalMcpAccess, false);
    }
    const ctoIdentity = args.ctoStateService?.getIdentity?.() as CtoIdentity | undefined;
    return normalizeAccessPolicy(ctoIdentity?.externalMcpAccess, true);
  };

  const getMissionSelection = (missionId: string | null): ExternalMcpMissionSelection | undefined => {
    if (!missionId) return undefined;
    const rawMetadata = args.missionService?.getMetadata?.(missionId);
    const metadata = isRecord(rawMetadata) ? rawMetadata : null;
    const launch = metadata && isRecord(metadata.launch) ? metadata.launch : null;
    const permissionConfig = launch && isRecord(launch.permissionConfig) ? launch.permissionConfig : null;
    return normalizeMissionSelection(permissionConfig?.externalMcp);
  };

  const isServerAllowed = (serverName: string, identity: ExternalMcpSessionIdentity): boolean => {
    const access = getAgentAccessPolicy(identity);
    if (access.blockedServers.includes(serverName)) return false;
    if (!access.allowAll && !access.allowedServers.includes(serverName)) return false;
    const missionSelection = getMissionSelection(identity.missionId);
    if (missionSelection?.enabled === false) return false;
    if (missionSelection?.selectedServers?.length && !missionSelection.selectedServers.includes(serverName)) {
      return false;
    }
    return true;
  };

  const applyServerToolPermissions = (
    runtime: RuntimeServerState,
    tools: ExternalMcpToolManifest[],
  ): ExternalMcpToolManifest[] => {
    const allowed = runtime.rawConfig.permissions?.allowedTools ?? [];
    const blocked = runtime.rawConfig.permissions?.blockedTools ?? [];
    return tools.map((tool) => {
      if (blocked.includes(tool.name)) {
        return { ...tool, enabled: false, disabledReason: "Blocked by server permissions." };
      }
      if (allowed.length > 0 && !allowed.includes(tool.name)) {
        return { ...tool, enabled: false, disabledReason: "Not included in the server allowlist." };
      }
      return tool;
    });
  };

  const filterToolsForIdentity = (
    runtime: RuntimeServerState,
    tools: ExternalMcpToolManifest[],
    identity: ExternalMcpSessionIdentity,
  ): ExternalMcpToolManifest[] => {
    if (!isServerAllowed(runtime.resolvedConfig.name, identity)) return [];
    const missionSelection = getMissionSelection(identity.missionId);
    return tools.filter((tool) => {
      if (!tool.enabled) return false;
      if (missionSelection?.selectedTools?.length && !missionSelection.selectedTools.includes(tool.namespacedName)) {
        return false;
      }
      return true;
    });
  };

  const clearHealthTimer = (runtime: RuntimeServerState): void => {
    if (runtime.healthTimer) {
      clearInterval(runtime.healthTimer);
      runtime.healthTimer = null;
    }
  };

  const clearReconnectTimer = (runtime: RuntimeServerState): void => {
    if (runtime.reconnectTimer) {
      clearTimeout(runtime.reconnectTimer);
      runtime.reconnectTimer = null;
    }
  };

  const disconnectRuntime = async (runtime: RuntimeServerState): Promise<void> => {
    runtime.state = "draining";
    clearReconnectTimer(runtime);
    clearHealthTimer(runtime);
    const client = runtime.client;
    const transport = runtime.transport;
    runtime.client = null;
    runtime.transport = null;
    try {
      await client?.close();
    } catch {
      // Best effort
    }
    try {
      if (transport instanceof StreamableHTTPClientTransport) {
        await transport.terminateSession().catch(() => {});
      }
      await transport?.close();
    } catch {
      // Best effort
    }
    runtime.state = "disconnected";
  };

  const refreshTools = async (runtime: RuntimeServerState): Promise<void> => {
    if (!runtime.client) return;
    let cursor: string | undefined;
    const nextTools = new Map<string, ExternalMcpToolManifest>();
    do {
      const result = await runtime.client.listTools(cursor ? { cursor } : undefined);
      for (const tool of result.tools ?? []) {
        const manifest = toManifest(runtime.resolvedConfig.name, tool);
        nextTools.set(manifest.namespacedName, manifest);
      }
      cursor = typeof result.nextCursor === "string" && result.nextCursor.trim().length > 0
        ? result.nextCursor
        : undefined;
    } while (cursor);

    runtime.toolMap = new Map(
      applyServerToolPermissions(runtime, [...nextTools.values()]).map((tool) => [tool.namespacedName, tool] as const),
    );
  };

  const scheduleReconnect = (runtime: RuntimeServerState): void => {
    if (runtime.state === "draining") return;
    clearReconnectTimer(runtime);
    const delay = Math.min(
      MAX_RECONNECT_BACKOFF_MS,
      MIN_RECONNECT_BACKOFF_MS * Math.max(1, 2 ** Math.max(0, runtime.reconnectAttempt)),
    );
    runtime.state = "reconnecting";
    runtime.reconnectTimer = setTimeout(() => {
      runtime.reconnectTimer = null;
      void connectRuntime(runtime).catch(() => {});
    }, delay);
  };

  const startHealthChecks = (runtime: RuntimeServerState): void => {
    clearHealthTimer(runtime);
    runtime.healthTimer = setInterval(() => {
      void (async () => {
        if (!runtime.client) return;
        try {
          await runtime.client.ping();
          runtime.lastHealthCheckAt = nowIso();
          runtime.consecutivePingFailures = 0;
        } catch (error) {
          runtime.lastHealthCheckAt = nowIso();
          runtime.consecutivePingFailures += 1;
          runtime.lastError = error instanceof Error ? error.message : String(error);
          if (runtime.consecutivePingFailures >= 3) {
            await disconnectRuntime(runtime);
            scheduleReconnect(runtime);
          }
        }
      })();
    }, Math.max(5, runtime.resolvedConfig.healthCheckIntervalSec ?? DEFAULT_HEALTH_CHECK_INTERVAL_SEC) * 1000);
  };

  const buildTransport = (config: ExternalMcpResolvedServerConfig): ClientTransport => {
    if (config.transport === "stdio") {
      return new StdioClientTransport({
        command: config.command!,
        args: config.args ?? [],
        env: config.env,
        cwd: config.cwd,
        stderr: "pipe",
      });
    }

    const headers = config.headers ?? {};
    return new StreamableHTTPClientTransport(new URL(config.url!), {
      requestInit: {
        headers,
      },
    });
  };

  const connectRuntime = async (runtime: RuntimeServerState): Promise<void> => {
    clearReconnectTimer(runtime);
    clearHealthTimer(runtime);
    runtime.state = runtime.lastConnectedAt ? "reconnecting" : "connecting";
    try {
      const client = new Client(
        { name: "ade", version: "0.0.0" },
        {
          capabilities: {},
          listChanged: {
            tools: {
              onChanged: async (_error, _tools) => {
                try {
                  await refreshTools(runtime);
                } catch (error) {
                  runtime.lastError = error instanceof Error ? error.message : String(error);
                }
              },
            },
          },
        },
      );
      const transport = buildTransport(runtime.resolvedConfig);
      transport.onerror = (error) => {
        runtime.lastError = error instanceof Error ? error.message : String(error);
      };
      transport.onclose = () => {
        if (runtime.state === "draining" || runtime.state === "disconnected") return;
        runtime.lastError = runtime.lastError ?? "Connection closed.";
        void disconnectRuntime(runtime).finally(() => scheduleReconnect(runtime));
      };
      await client.connect(transport);
      runtime.client = client;
      runtime.transport = transport;
      runtime.state = "connected";
      runtime.lastConnectedAt = nowIso();
      runtime.lastError = null;
      runtime.reconnectAttempt = 0;
      runtime.consecutivePingFailures = 0;
      await refreshTools(runtime);
      startHealthChecks(runtime);
    } catch (error) {
      runtime.lastError = error instanceof Error ? error.message : String(error);
      runtime.state = "failed";
      runtime.reconnectAttempt += 1;
      scheduleReconnect(runtime);
      throw error;
    }
  };

  const createRuntimeState = (
    config: ExternalMcpServerConfig,
    existing?: RuntimeServerState | null,
  ): RuntimeServerState => {
    const resolvedConfig = resolveRuntimeConfig(config);
    const signature = toSignature(resolvedConfig);
    if (existing && existing.signature === signature) {
      existing.rawConfig = config;
      existing.resolvedConfig = resolvedConfig;
      existing.autoStart = config.autoStart !== false;
      return existing;
    }

    const runtime: RuntimeServerState = existing ?? {
      rawConfig: config,
      resolvedConfig,
      state: "disconnected",
      client: null,
      transport: null,
      toolMap: new Map(),
      lastConnectedAt: null,
      lastHealthCheckAt: null,
      consecutivePingFailures: 0,
      lastError: null,
      reconnectAttempt: 0,
      reconnectTimer: null,
      healthTimer: null,
      signature,
      autoStart: config.autoStart !== false,
    };

    runtime.rawConfig = config;
    runtime.resolvedConfig = resolvedConfig;
    runtime.signature = signature;
    runtime.autoStart = config.autoStart !== false;
    return runtime;
  };

  const getOrCreateRuntime = (config: ExternalMcpServerConfig): RuntimeServerState => {
    const runtime = createRuntimeState(config, runtimes.get(config.name));
    runtimes.set(config.name, runtime);
    return runtime;
  };

  const reconcileNow = async (): Promise<void> => {
    const configs = readConfiguredServers();
    const seen = new Set<string>();
    for (const config of configs) {
      seen.add(config.name);
      const existing = runtimes.get(config.name);
      const nextSignature = toSignature(resolveRuntimeConfig(config));
      const signatureChanged = existing ? existing.signature !== nextSignature : false;
      const runtime = getOrCreateRuntime(config);
      runtime.toolMap = new Map(
        applyServerToolPermissions(runtime, [...runtime.toolMap.values()]).map((tool) => [tool.namespacedName, tool] as const),
      );
      if (signatureChanged && runtime.client != null) {
        await disconnectRuntime(runtime);
      }
      if (runtime.autoStart && (!runtime.client || runtime.state !== "connected")) {
        try {
          await connectRuntime(runtime);
        } catch (error) {
          args.logger?.warn("external_mcp.connect_failed", {
            serverName: runtime.resolvedConfig.name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    for (const [name, runtime] of [...runtimes.entries()]) {
      if (seen.has(name)) continue;
      void disconnectRuntime(runtime).catch(() => {});
      runtimes.delete(name);
    }
  };

  const ensureRuntimeReady = async (serverName: string): Promise<RuntimeServerState> => {
    const runtime = runtimes.get(serverName);
    if (!runtime) throw new Error(`Unknown external MCP server '${serverName}'.`);
    if (runtime.client && runtime.state === "connected") return runtime;
    await connectRuntime(runtime);
    return runtime;
  };

  const recordBudgetUsage = async (
    identity: ExternalMcpSessionIdentity,
    serverName: string,
    toolName: string,
    safety: ExternalMcpToolSafety,
    costCents: number,
    estimated: boolean,
  ): Promise<void> => {
    const event: ExternalMcpUsageEvent = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      serverName,
      toolName,
      namespacedToolName: `ext.${serverName}.${toolName}`,
      safety,
      callerRole: identity.role,
      callerId: identity.callerId,
      missionId: identity.missionId,
      runId: identity.runId,
      stepId: identity.stepId,
      attemptId: identity.attemptId,
      ownerId: identity.ownerId,
      costCents,
      estimated,
      occurredAt: nowIso(),
    };
    pushUsageEvent(event);

    if (identity.ownerId && costCents > 0) {
      args.workerBudgetService?.recordCostEvent({
        agentId: identity.ownerId,
        runId: identity.runId,
        sessionId: identity.attemptId ?? identity.runId,
        provider: `external-mcp:${serverName}`,
        modelId: toolName,
        costCents,
        estimated,
        source: "manual",
      });
    }
  };

  const assertBudgetsAllowCall = async (identity: ExternalMcpSessionIdentity): Promise<void> => {
    if (identity.ownerId && args.workerBudgetService) {
      const snapshot = args.workerBudgetService.getBudgetSnapshot({});
      const worker = snapshot.workers.find((entry) => entry.agentId === identity.ownerId);
      if (worker && worker.remainingCents != null && worker.remainingCents <= 0) {
        throw new Error(`Worker budget exhausted for '${worker.name}'.`);
      }
    }

    if (identity.missionId && args.missionBudgetService) {
      const snapshot = await args.missionBudgetService.getMissionBudgetStatus({
        missionId: identity.missionId,
        ...(identity.runId ? { runId: identity.runId } : {}),
      });
      if (
        snapshot.hardCaps.apiKeyTriggered
        || snapshot.hardCaps.fiveHourTriggered
        || snapshot.hardCaps.weeklyTriggered
        || (snapshot.mission.remainingCostUsd != null && snapshot.mission.remainingCostUsd <= 0)
      ) {
        throw new Error("Mission budget is exhausted for external MCP calls.");
      }
    }
  };

  return {
    async start(): Promise<void> {
      await reconcileNow();
    },

    async dispose(): Promise<void> {
      if (reloadTimer) {
        clearTimeout(reloadTimer);
        reloadTimer = null;
      }
      await Promise.all([...runtimes.values()].map((runtime) => disconnectRuntime(runtime)));
      runtimes.clear();
    },

    reload(): void {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        void reconcileNow().catch((error) => {
          args.logger?.warn("external_mcp.reload_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, CONFIG_RELOAD_DEBOUNCE_MS);
    },

    async listToolsForIdentity(identity: ExternalMcpSessionIdentity): Promise<ExternalMcpToolManifest[]> {
      const allowedNames = [...runtimes.keys()].filter((serverName) => isServerAllowed(serverName, identity));
      for (const serverName of allowedNames) {
        try {
          await ensureRuntimeReady(serverName);
        } catch (error) {
          args.logger?.warn("external_mcp.list_tools_connect_failed", {
            serverName,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const allTools: ExternalMcpToolManifest[] = [];
      for (const runtime of runtimes.values()) {
        const filtered = filterToolsForIdentity(runtime, [...runtime.toolMap.values()], identity);
        allTools.push(...filtered);
      }
      return sortTools(allTools);
    },

    async callTool(
      identity: ExternalMcpSessionIdentity,
      namespacedToolName: string,
      toolArgs: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      await assertBudgetsAllowCall(identity);
      const runtime = [...runtimes.values()].find((entry) => entry.toolMap.has(namespacedToolName));
      if (!runtime) {
        throw new Error(`External MCP tool '${namespacedToolName}' is unavailable.`);
      }
      const manifest = runtime.toolMap.get(namespacedToolName)!;
      if (!isServerAllowed(runtime.resolvedConfig.name, identity)) {
        throw new Error(`External MCP server '${runtime.resolvedConfig.name}' is blocked for this identity.`);
      }
      const missionSelection = getMissionSelection(identity.missionId);
      if (missionSelection?.selectedTools?.length && !missionSelection.selectedTools.includes(namespacedToolName)) {
        throw new Error(`External MCP tool '${namespacedToolName}' is not approved for this mission.`);
      }
      if (!manifest.enabled) {
        throw new Error(manifest.disabledReason ?? `External MCP tool '${namespacedToolName}' is disabled.`);
      }

      const ready = await ensureRuntimeReady(runtime.resolvedConfig.name);
      const result = await ready.client!.callTool({
        name: manifest.name,
        arguments: toolArgs,
      });

      const { costCents, estimated } = resolveCostCents(ready.rawConfig, manifest.name);
      await recordBudgetUsage(identity, ready.resolvedConfig.name, manifest.name, manifest.safety, costCents, estimated);

      return {
        ok: result.isError !== true,
        serverName: ready.resolvedConfig.name,
        toolName: manifest.name,
        namespacedToolName,
        result,
      };
    },

    getSnapshots(): ExternalMcpServerSnapshot[] {
      return sortSnapshots(
        [...runtimes.values()].map((runtime) => ({
          config: runtime.resolvedConfig,
          state: runtime.state,
          toolCount: runtime.toolMap.size,
          tools: sortTools([...runtime.toolMap.values()]),
          lastConnectedAt: runtime.lastConnectedAt,
          lastHealthCheckAt: runtime.lastHealthCheckAt,
          consecutivePingFailures: runtime.consecutivePingFailures,
          lastError: runtime.lastError,
          autoStart: runtime.autoStart,
        })),
      );
    },

    getRawConfigs(): ExternalMcpServerConfig[] {
      return readConfiguredServers();
    },

    getUsageEvents(limit = 100): ExternalMcpUsageEvent[] {
      return usageEvents.slice(-Math.max(1, Math.min(limit, usageEvents.length))).reverse();
    },

    async connectServer(serverName: string): Promise<ExternalMcpServerSnapshot> {
      const runtime = await ensureRuntimeReady(serverName);
      return this.getSnapshots().find((entry) => entry.config.name === runtime.resolvedConfig.name)!;
    },

    async disconnectServer(serverName: string): Promise<ExternalMcpServerSnapshot | null> {
      const runtime = runtimes.get(serverName);
      if (!runtime) return null;
      await disconnectRuntime(runtime);
      return this.getSnapshots().find((entry) => entry.config.name === serverName) ?? null;
    },

    async testServer(config: ExternalMcpServerConfig): Promise<ExternalMcpServerSnapshot> {
      const normalized = normalizeServerConfig(config);
      if (!normalized) throw new Error("Invalid external MCP server config.");
      const existing = runtimes.get(normalized.name) ?? null;
      const nextSignature = toSignature(resolveRuntimeConfig(normalized));
      const reuseExisting = existing != null && existing.signature === nextSignature;
      const runtime = createRuntimeState(normalized, reuseExisting ? existing : null);
      try {
        await connectRuntime(runtime);
        return {
          config: runtime.resolvedConfig,
          state: runtime.state,
          toolCount: runtime.toolMap.size,
          tools: sortTools([...runtime.toolMap.values()]),
          lastConnectedAt: runtime.lastConnectedAt,
          lastHealthCheckAt: runtime.lastHealthCheckAt,
          consecutivePingFailures: runtime.consecutivePingFailures,
          lastError: runtime.lastError,
          autoStart: runtime.autoStart,
        };
      } finally {
        if (!reuseExisting) {
          clearReconnectTimer(runtime);
          clearHealthTimer(runtime);
          if (runtime.client || runtime.transport) {
            await disconnectRuntime(runtime).catch(() => {});
          }
        }
      }
    },

    saveServer(config: ExternalMcpServerConfig): ExternalMcpServerConfig[] {
      const normalized = normalizeServerConfig(config);
      if (!normalized) throw new Error("Invalid external MCP server config.");
      const doc = readSecretDocument();
      const current = Array.isArray(doc.externalMcp) ? doc.externalMcp : [];
      const next = current.filter((entry) => asTrimmedString(isRecord(entry) ? entry.name : "") !== normalized.name);
      next.push(normalized);
      doc.externalMcp = next.sort((a, b) => asTrimmedString(isRecord(a) ? a.name : "").localeCompare(asTrimmedString(isRecord(b) ? b.name : "")));
      writeSecretDocument(doc);
      this.reload();
      return readConfiguredServers();
    },

    removeServer(serverName: string): ExternalMcpServerConfig[] {
      const doc = readSecretDocument();
      const current = Array.isArray(doc.externalMcp) ? doc.externalMcp : [];
      doc.externalMcp = current.filter((entry) => asTrimmedString(isRecord(entry) ? entry.name : "") !== serverName);
      if (!Array.isArray(doc.externalMcp) || doc.externalMcp.length === 0) {
        delete doc.externalMcp;
      }
      writeSecretDocument(doc);
      this.reload();
      return readConfiguredServers();
    },
  };
}

export type ExternalMcpService = ReturnType<typeof createExternalMcpService>;
