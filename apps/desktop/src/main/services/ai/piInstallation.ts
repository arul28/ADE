import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PI_SDK_MIN_NODE } from "../chat/piSdkProtocol";
import { acquirePiSdkConnection, releasePiSdkConnection } from "../chat/piSdkPool";
import {
  createDynamicPiModelDescriptor,
  decodePiRegistryId,
  encodePiRegistryId,
} from "../../../shared/modelRegistry";
import { resolveExecutableFromKnownLocations } from "./cliExecutableResolver";

export { PI_SDK_MIN_NODE } from "../chat/piSdkProtocol";
export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent" as const;

export type PiInstallation = {
  cliPath: string | null;
  packageRoot: string | null;
  packageEntry: string | null;
  version: string | null;
  nodeVersion: string;
  sdkAvailable: boolean;
  cliAvailable: boolean;
  agentDir: string;
  settingsPath: string;
  authPath: string;
  modelsPath: string;
  modelsStorePath: string;
  blocker: string | null;
};

export type PiProviderAuthSource =
  | "stored"
  | "runtime"
  | "environment"
  | "fallback"
  | "models_json_key"
  | "models_json_command"
  | null;

export type PiProfileProvider = {
  id: string;
  name: string;
  modelCount: number;
  availableModelCount: number;
  configured: boolean;
  authType: "api-key" | "oauth" | "local" | "unknown" | null;
  authMethods: Array<"api-key" | "oauth" | "local">;
  authSource?: PiProviderAuthSource;
  authLabel?: string | null;
  subscription?: boolean;
  loginLabel?: string | null;
  authExpiresAt?: number | null;
};

export type PiProfileInventory = {
  installed: boolean;
  sdkAvailable: boolean;
  cliAvailable: boolean;
  cliPath: string | null;
  packageRoot: string | null;
  version: string | null;
  agentDir: string;
  settingsPath: string;
  authPath: string;
  modelsPath: string;
  modelsStorePath: string;
  blocker: string | null;
  providers: PiProfileProvider[];
  availableModelIds: string[];
  stale: boolean;
  authFileDetected: boolean;
  modelsFileDetected: boolean;
  settingsFileDetected: boolean;
  error?: string | null;
};

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

function homeDir(env: NodeJS.ProcessEnv): string {
  return nonEmpty(env.USERPROFILE) ?? nonEmpty(env.HOME) ?? os.homedir();
}

function packageRootFrom(start: string): string | null {
  let current = path.resolve(start);
  try {
    if (fs.statSync(current).isFile()) current = path.dirname(current);
  } catch {
    current = path.dirname(current);
  }
  for (;;) {
    const packageJson = path.join(current, "package.json");
    if (fs.existsSync(packageJson)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(packageJson, "utf8")) as Record<string, unknown>;
        if (parsed.name === PI_PACKAGE_NAME) return current;
      } catch {
        // Keep walking. A broken package.json should not hide another install.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function packageLocationFromRoot(root: string | null): { root: string | null; entry: string | null; version: string | null } {
  if (!root) return { root: null, entry: null, version: null };
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as Record<string, unknown>;
    const exportsRoot = packageJson.exports as Record<string, unknown> | undefined;
    const dotExport = exportsRoot?.["."] as Record<string, unknown> | undefined;
    const entryValue = dotExport?.import ?? packageJson.module ?? packageJson.main ?? "dist/index.js";
    const entry = typeof entryValue === "string" ? path.resolve(root, entryValue) : null;
    return {
      root,
      entry: entry && fs.existsSync(entry) ? entry : null,
      version: nonEmpty(packageJson.version),
    };
  } catch {
    return { root, entry: null, version: null };
  }
}

function candidatePackageRoots(env: NodeJS.ProcessEnv, cliPath: string | null): string[] {
  const home = homeDir(env);
  const roots = [
    nonEmpty(env.ADE_PI_PACKAGE_ROOT),
    nonEmpty(env.PI_CODING_AGENT_PACKAGE_ROOT),
    cliPath,
    path.join(home, ".pi", "agent", "node_modules", PI_PACKAGE_NAME),
    path.join(home, ".npm-global", "lib", "node_modules", PI_PACKAGE_NAME),
    path.join(home, ".local", "lib", "node_modules", PI_PACKAGE_NAME),
    path.join(home, ".volta", "tools", "image", "packages", "node", "lib", "node_modules", PI_PACKAGE_NAME),
    ...(process.platform === "win32" ? [
      path.join(nonEmpty(env.APPDATA) ?? path.join(home, "AppData", "Roaming"), "npm", "node_modules", PI_PACKAGE_NAME),
      path.join(nonEmpty(env.LOCALAPPDATA) ?? path.join(home, "AppData", "Local"), "npm", "node_modules", PI_PACKAGE_NAME),
      path.join(home, "AppData", "Roaming", "npm", "node_modules", PI_PACKAGE_NAME),
      path.join(home, "AppData", "Local", "npm", "node_modules", PI_PACKAGE_NAME),
    ] : []),
    path.join("/opt", "homebrew", "lib", "node_modules", PI_PACKAGE_NAME),
    path.join("/usr", "local", "lib", "node_modules", PI_PACKAGE_NAME),
    path.join("/usr", "lib", "node_modules", PI_PACKAGE_NAME),
  ];
  return roots.filter((value): value is string => Boolean(value)).map((value) => {
    try {
      return fs.realpathSync(value);
    } catch {
      return value;
    }
  });
}

function nodeVersionAtLeast(actual: string, minimum = PI_SDK_MIN_NODE): boolean {
  const parse = (value: string): [number, number, number] => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
  };
  const a = parse(actual);
  const b = parse(minimum);
  return a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2])));
}

function safeJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Resolve the user's Pi installation without importing or installing Pi. */
export function resolvePiInstallation(env: NodeJS.ProcessEnv = process.env): PiInstallation {
  const cli = resolveExecutableFromKnownLocations("pi", env)?.path ?? null;
  let location: { root: string | null; entry: string | null; version: string | null } = {
    root: null,
    entry: null,
    version: null,
  };
  for (const candidate of candidatePackageRoots(env, cli)) {
    const root = packageRootFrom(candidate) ?? (fs.existsSync(path.join(candidate, "package.json")) ? candidate : null);
    const next = packageLocationFromRoot(root);
    if (next.root && next.entry) {
      location = next;
      break;
    }
  }
  const agentDir = path.resolve(nonEmpty(env.PI_CODING_AGENT_DIR) ?? path.join(homeDir(env), ".pi", "agent"));
  const nodeVersion = process.versions.node;
  const sdkAvailable = Boolean(location.root && location.entry && nodeVersionAtLeast(nodeVersion));
  let blocker: string | null = null;
  if (!location.root || !location.entry) {
    blocker = cli
      ? "Pi CLI was found, but its SDK package could not be located. Set ADE_PI_PACKAGE_ROOT to the installed @earendil-works/pi-coding-agent directory."
      : "Pi is not installed. Install @earendil-works/pi-coding-agent or add the Pi CLI to PATH.";
  } else if (!nodeVersionAtLeast(nodeVersion)) {
    blocker = `Pi SDK requires Node >= ${PI_SDK_MIN_NODE}; ADE is running Node ${nodeVersion}. Pi CLI remains available.`;
  }
  return {
    cliPath: cli,
    packageRoot: location.root,
    packageEntry: location.entry,
    version: location.version,
    nodeVersion,
    sdkAvailable,
    cliAvailable: Boolean(cli),
    agentDir,
    settingsPath: path.join(agentDir, "settings.json"),
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
    modelsStorePath: path.join(agentDir, "models-store.json"),
    blocker,
  };
}

function authSummary(value: unknown): { type: PiProfileProvider["authType"]; expiresAt?: number | null } {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!record) return { type: null };
  const type = nonEmpty(record.type)?.toLowerCase();
  const expires = typeof record.expires === "number" ? record.expires : null;
  if (type === "oauth" || type === "token") return { type: "oauth", expiresAt: expires };
  if (type === "api-key" || type === "apikey" || type === "api_key") return { type: "api-key", expiresAt: expires };
  if (record.apiKey != null || record.api_key != null) return { type: "api-key", expiresAt: expires };
  if (Object.keys(record).some((key) => /key|token|access|refresh/i.test(key))) return { type: "oauth", expiresAt: expires };
  return { type: "unknown", expiresAt: expires };
}

/** Read only provider/model metadata. Secret values are never returned. */
export function readPiProfileInventory(installation = resolvePiInstallation()): PiProfileInventory {
  const auth = safeJson<Record<string, unknown>>(installation.authPath) ?? {};
  const models = safeJson<Record<string, unknown>>(installation.modelsPath) ?? {};
  const settingsFileDetected = fs.existsSync(installation.settingsPath);
  const authFileDetected = fs.existsSync(installation.authPath);
  const modelsFileDetected = fs.existsSync(installation.modelsPath);
  const modelProviders = models.providers && typeof models.providers === "object" && !Array.isArray(models.providers)
    ? models.providers as Record<string, unknown>
    : {};
  const ids = new Set<string>();
  const providers = new Map<string, PiProfileProvider>();
  for (const [providerId, raw] of Object.entries(modelProviders)) {
    const provider = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const list = Array.isArray(provider.models) ? provider.models : [];
    for (const model of list) {
      const id = nonEmpty((model as Record<string, unknown> | null)?.id);
      if (id) ids.add(encodePiRegistryId("default", providerId, id));
    }
    const authInfo = authSummary(auth[providerId]);
    const authType = authInfo.type
      ?? (provider.apiKey ? "api-key" as const : provider.baseUrl ? "local" as const : null);
    providers.set(providerId, {
      id: providerId,
      name: nonEmpty(provider.name) ?? providerId,
      modelCount: list.length,
      availableModelCount: 0,
      configured: Boolean(auth[providerId]) || Boolean(provider.apiKey) || Boolean(provider.baseUrl),
      authType,
      authMethods: authType === "api-key" || authType === "oauth" || authType === "local" ? [authType] : [],
      ...(provider.apiKey ? { authSource: "models_json_key" as const } : {}),
      ...(authInfo.expiresAt !== undefined ? { authExpiresAt: authInfo.expiresAt } : {}),
    });
  }
  for (const [providerId, value] of Object.entries(auth)) {
    if (providers.has(providerId)) continue;
    const authInfo = authSummary(value);
    providers.set(providerId, {
      id: providerId,
      name: providerId,
      modelCount: 0,
      availableModelCount: 0,
      configured: true,
      authType: authInfo.type,
      authMethods: authInfo.type === "api-key" || authInfo.type === "oauth" || authInfo.type === "local" ? [authInfo.type] : [],
      authSource: "stored",
      ...(authInfo.expiresAt !== undefined ? { authExpiresAt: authInfo.expiresAt } : {}),
    });
  }
  return {
    installed: Boolean(installation.packageRoot || installation.cliPath),
    sdkAvailable: installation.sdkAvailable,
    cliAvailable: installation.cliAvailable,
    cliPath: installation.cliPath,
    packageRoot: installation.packageRoot,
    version: installation.version,
    agentDir: installation.agentDir,
    settingsPath: installation.settingsPath,
    authPath: installation.authPath,
    modelsPath: installation.modelsPath,
    modelsStorePath: installation.modelsStorePath,
    blocker: installation.blocker,
    providers: [...providers.values()].sort((a, b) => a.name.localeCompare(b.name)),
    availableModelIds: [...ids].sort(),
    stale: false,
    authFileDetected,
    modelsFileDetected,
    settingsFileDetected,
  };
}

function providerAuthSourcePath(
  source: PiProviderAuthSource | undefined,
  installation: PiInstallation,
): string | undefined {
  if (source === "stored") return installation.authPath;
  if (source === "models_json_key" || source === "models_json_command") return installation.modelsPath;
  return undefined;
}

function runtimeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function runtimeAuthType(
  value: Record<string, unknown> | null,
  fallback: PiProfileProvider | undefined,
): "api-key" | "oauth" | "local" | null {
  const type = nonEmpty(value?.type)?.toLowerCase();
  if (type === "oauth" || type === "token") return "oauth";
  if (type === "api_key" || type === "api-key" || type === "apikey") return "api-key";
  return fallback?.authType === "unknown" ? null : fallback?.authType ?? null;
}

function runtimeAuthSource(
  value: Record<string, unknown> | null,
  fallback: PiProfileProvider | undefined,
): PiProviderAuthSource {
  const source = nonEmpty(value?.source);
  if (source === "stored" || source === "runtime" || source === "environment"
    || source === "fallback" || source === "models_json_key" || source === "models_json_command") {
    return source;
  }
  return fallback?.authSource ?? null;
}

function runtimeConfigured(value: Record<string, unknown> | null): boolean {
  return value?.configured === true || value?.authenticated === true || value?.isAuthenticated === true;
}

/** Build one canonical set of picker descriptors from the Pi inventory. */
export function piModelDescriptorsFromInventory(inventory: PiProfileInventory) {
  const providersById = new Map(inventory.providers.map((provider) => [provider.id, provider] as const));
  return inventory.availableModelIds.flatMap((modelId) => {
    const decoded = decodePiRegistryId(modelId);
    if (!decoded) return [];
    const provider = providersById.get(decoded.providerId);
    return [createDynamicPiModelDescriptor(decoded.providerId, decoded.modelId, {
      profileId: decoded.profileId,
      displayName: `${provider?.name ?? decoded.providerId} / ${decoded.modelId}`,
      ...(provider?.authMethods.length ? { authTypes: provider.authMethods } : {}),
      color: "#F97316",
    })];
  });
}

export async function probePiProfileInventory(
  installation = resolvePiInstallation(),
): Promise<PiProfileInventory> {
  const fallback = readPiProfileInventory(installation);
  if (!installation.sdkAvailable || !installation.packageRoot || !installation.packageEntry) return fallback;

  let acquired: Awaited<ReturnType<typeof acquirePiSdkConnection>> | null = null;
  const poolKey = `pi-inventory:${installation.agentDir}:${randomUUID()}`;
  try {
    // Inventory is deliberately served by the same isolated worker boundary
    // as chat. The Electron main process must never import user-installed Pi
    // code because package top-level code can execute arbitrary extensions.
    acquired = await acquirePiSdkConnection({
      poolKey,
      packageRoot: installation.packageRoot,
      packageEntry: installation.packageEntry,
      cwd: path.resolve(process.cwd()),
      agentDir: installation.agentDir,
      inventoryOnly: true,
      baseEnv: process.env,
    });
    const availableModels = acquired.pooled.ready?.availableModels ?? [];
    const availableCounts = new Map<string, number>();
    const availableModelIds = availableModels.flatMap((model) => {
      const record = runtimeRecord(model);
      const providerId = nonEmpty(record?.provider);
      const modelId = nonEmpty(record?.id);
      if (!providerId || !modelId) return [];
      availableCounts.set(providerId, (availableCounts.get(providerId) ?? 0) + 1);
      return [encodePiRegistryId("default", providerId, modelId)];
    });
    const runtimeAuth = await acquired.pooled.requestAuth().catch(() => []);
    const fallbackProvidersById = new Map(fallback.providers.map((provider) => [provider.id, provider] as const));
    const providersById = new Map<string, PiProfileProvider>();

    for (const item of Array.isArray(runtimeAuth) ? runtimeAuth : []) {
      const runtime = runtimeRecord(item);
      const providerId = nonEmpty(runtime?.id);
      if (!providerId) continue;
      const fallbackProvider = fallbackProvidersById.get(providerId);
      const authType = runtimeAuthType(runtime, fallbackProvider);
      const authMethods: Array<"api-key" | "oauth" | "local"> = fallbackProvider?.authMethods
        ?? (authType ? [authType] : []);
      providersById.set(providerId, {
        id: providerId,
        name: nonEmpty(runtime?.name) ?? fallbackProvider?.name ?? providerId,
        modelCount: Math.max(fallbackProvider?.modelCount ?? 0, availableCounts.get(providerId) ?? 0),
        availableModelCount: availableCounts.get(providerId) ?? 0,
        configured: Boolean(runtimeConfigured(runtime) || fallbackProvider?.configured || (availableCounts.get(providerId) ?? 0) > 0),
        authType,
        authMethods,
        authSource: runtimeAuthSource(runtime, fallbackProvider),
        authLabel: nonEmpty(runtime?.label) ?? fallbackProvider?.authLabel ?? null,
        subscription: fallbackProvider?.subscription === true,
        loginLabel: fallbackProvider?.loginLabel ?? null,
        authExpiresAt: fallbackProvider?.authExpiresAt ?? null,
      });
      fallbackProvidersById.delete(providerId);
    }

    for (const providerId of availableCounts.keys()) {
      if (providersById.has(providerId)) continue;
      const fallbackProvider = fallbackProvidersById.get(providerId);
      providersById.set(providerId, fallbackProvider ?? {
        id: providerId,
        name: providerId,
        modelCount: availableCounts.get(providerId) ?? 0,
        availableModelCount: availableCounts.get(providerId) ?? 0,
        configured: true,
        authType: null,
        authMethods: [],
      });
      fallbackProvidersById.delete(providerId);
    }

    for (const [providerId, fallbackProvider] of fallbackProvidersById.entries()) {
      providersById.set(providerId, fallbackProvider);
    }

    return {
      installed: true,
      sdkAvailable: installation.sdkAvailable,
      cliAvailable: installation.cliAvailable,
      cliPath: installation.cliPath,
      packageRoot: installation.packageRoot,
      version: installation.version,
      agentDir: installation.agentDir,
      settingsPath: installation.settingsPath,
      authPath: installation.authPath,
      modelsPath: installation.modelsPath,
      modelsStorePath: installation.modelsStorePath,
      blocker: installation.blocker,
      providers: [...providersById.values()].sort((a, b) => a.name.localeCompare(b.name)),
      availableModelIds: [...new Set(availableModelIds)].sort(),
      stale: false,
      authFileDetected: fallback.authFileDetected,
      modelsFileDetected: fallback.modelsFileDetected,
      settingsFileDetected: fallback.settingsFileDetected,
    };
  } catch (error) {
    return {
      ...fallback,
      stale: true,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (acquired) {
      releasePiSdkConnection(poolKey, acquired.generation);
      await acquired.pooled.waitForExit().catch(() => undefined);
    }
  }
}

export function providerPathForPiAuthSource(
  source: PiProviderAuthSource | undefined,
  installation: PiInstallation,
): string | undefined {
  return providerAuthSourcePath(source, installation);
}
