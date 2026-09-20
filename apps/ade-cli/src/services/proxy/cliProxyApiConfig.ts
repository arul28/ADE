import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { writeFileAtomic } from "../../../../desktop/src/main/services/state/durableFile";
import {
  ensurePrivateDirectory,
  securePrivatePath,
  type PrivateFileSecurityOptions,
} from "../../lib/trustedWindowsTools";
import type { CliProxyApiRelease, CliProxyApiReleaseAsset } from "./cliProxyApiRelease";

const PROXY_HOST = "127.0.0.1" as const;

export type CliProxyApiConfig = {
  host: typeof PROXY_HOST;
  port: number;
  "api-keys": string[];
  "remote-management": {
    "allow-remote": false;
    "secret-key": string;
  };
  "auth-dir": string;
  "force-model-prefix": true;
  "claude-code": {
    "disable-cloaking-model-list": false;
  };
  routing: {
    strategy: "round-robin";
    "session-affinity": false;
  };
  "request-retry": 0;
  "quota-exceeded": {
    "switch-project": false;
  };
};

export type CliProxyApiState = {
  port: number;
  version: string;
  pid: number | null;
  startedAt: number;
  healthyAt: number | null;
};

export type CliProxyApiSupervisorPaths = {
  proxyDir: string;
  binDir: string;
  versionDir: string;
  binaryPath: string;
  configPath: string;
  statePath: string;
  managementKeyPath: string;
  authDir: string;
};

export type CliProxyApiConfigSummary = {
  config: CliProxyApiConfig;
  apiKey: string;
  managementKey: string;
  port: number;
};

export function pathsFor(
  adeHome: string,
  release: CliProxyApiRelease,
  asset: CliProxyApiReleaseAsset,
): CliProxyApiSupervisorPaths {
  const proxyDir = path.join(adeHome, "proxy");
  const binDir = path.join(proxyDir, "bin");
  const versionDir = path.join(binDir, release.version);
  return {
    proxyDir,
    binDir,
    versionDir,
    binaryPath: path.join(versionDir, asset.binaryName),
    configPath: path.join(proxyDir, "config.yaml"),
    statePath: path.join(proxyDir, "state.json"),
    managementKeyPath: path.join(proxyDir, ".management-key"),
    authDir: path.join(proxyDir, "auth"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid CLIProxyAPI config: ${field} must be a non-empty string`);
  }
  return value;
}

function requirePort(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("Invalid CLIProxyAPI config: port must be an integer between 1 and 65535");
  }
  return value;
}

function requireBoolean(value: unknown, field: string, expected: boolean): void {
  if (value !== expected) {
    throw new Error(`Invalid CLIProxyAPI config: ${field} must be ${String(expected)}`);
  }
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`Invalid CLIProxyAPI config: ${field} must contain at least one non-empty string`);
  }
  return [...value];
}

export function createCliProxyApiConfig(args: {
  port: number;
  apiKey: string;
  managementKey: string;
  authDir: string;
}): CliProxyApiConfig {
  return {
    host: PROXY_HOST,
    port: args.port,
    "api-keys": [args.apiKey],
    "remote-management": {
      "allow-remote": false,
      "secret-key": args.managementKey,
    },
    "auth-dir": args.authDir,
    "force-model-prefix": true,
    "claude-code": {
      "disable-cloaking-model-list": false,
    },
    routing: {
      strategy: "round-robin",
      "session-affinity": false,
    },
    "request-retry": 0,
    "quota-exceeded": {
      "switch-project": false,
    },
  };
}

export function renderCliProxyApiConfig(config: CliProxyApiConfig): string {
  return `${stringifyYaml(config)}\n`;
}

export function writeCliProxyApiConfig(
  configPath: string,
  config: CliProxyApiConfig,
  security: PrivateFileSecurityOptions = {},
): void {
  const platform = security.platform ?? process.platform;
  ensurePrivateDirectory(path.dirname(configPath), { ...security, platform });
  writeFileAtomic(configPath, renderCliProxyApiConfig(config), { mode: 0o600 });
  securePrivatePath(configPath, security);
}

export function readCliProxyApiConfig(configPath: string): CliProxyApiConfig {
  const parsed = parseYaml(fs.readFileSync(configPath, "utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Invalid CLIProxyAPI config: expected a YAML object");
  }

  const remoteManagement = parsed["remote-management"];
  const claudeCode = parsed["claude-code"];
  const routing = parsed.routing;
  const quotaExceeded = parsed["quota-exceeded"];
  const apiKeys = requireStringArray(parsed["api-keys"], "api-keys");
  if (!isRecord(remoteManagement) || !isRecord(routing) || !isRecord(quotaExceeded)) {
    throw new Error("Invalid CLIProxyAPI config: missing required nested values");
  }

  const config: CliProxyApiConfig = {
    host: requireString(parsed.host, "host") as typeof PROXY_HOST,
    port: requirePort(parsed.port),
    "api-keys": apiKeys,
    "remote-management": {
      "allow-remote": remoteManagement["allow-remote"] as false,
      "secret-key": requireString(remoteManagement["secret-key"], "remote-management.secret-key"),
    },
    "auth-dir": requireString(parsed["auth-dir"], "auth-dir"),
    "force-model-prefix": parsed["force-model-prefix"] as true,
    "claude-code": {
      "disable-cloaking-model-list": isRecord(claudeCode)
        ? claudeCode["disable-cloaking-model-list"] as false
        : false,
    },
    routing: {
      strategy: routing.strategy as "round-robin",
      "session-affinity": routing["session-affinity"] as false,
    },
    "request-retry": parsed["request-retry"] as 0,
    "quota-exceeded": {
      "switch-project": quotaExceeded["switch-project"] as false,
    },
  };

  if (config.host !== PROXY_HOST) {
    throw new Error(`Invalid CLIProxyAPI config: host must be ${PROXY_HOST}`);
  }
  requireBoolean(config["remote-management"]["allow-remote"], "remote-management.allow-remote", false);
  requireBoolean(config["force-model-prefix"], "force-model-prefix", true);
  requireBoolean(
    config["claude-code"]["disable-cloaking-model-list"],
    "claude-code.disable-cloaking-model-list",
    false,
  );
  if (config.routing.strategy !== "round-robin") {
    throw new Error("Invalid CLIProxyAPI config: routing.strategy must be round-robin");
  }
  requireBoolean(config.routing["session-affinity"], "routing.session-affinity", false);
  if (config["request-retry"] !== 0) {
    throw new Error("Invalid CLIProxyAPI config: request-retry must be 0");
  }
  requireBoolean(config["quota-exceeded"]["switch-project"], "quota-exceeded.switch-project", false);
  return config;
}

export function configSummary(configPath: string): CliProxyApiConfigSummary {
  const config = readCliProxyApiConfig(configPath);
  return {
    config,
    apiKey: config["api-keys"][0]!,
    managementKey: config["remote-management"]["secret-key"],
    port: config.port,
  };
}

function isValidPid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function readCliProxyApiState(statePath: string): CliProxyApiState | null {
  if (!fs.existsSync(statePath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const pid = parsed.pid === null ? null : isValidPid(parsed.pid) ? parsed.pid : undefined;
  const startedAt = typeof parsed.startedAt === "number" && Number.isFinite(parsed.startedAt) && parsed.startedAt > 0
    ? parsed.startedAt
    : undefined;
  const healthyAt = parsed.healthyAt === null
    ? null
    : typeof parsed.healthyAt === "number" && Number.isFinite(parsed.healthyAt) && parsed.healthyAt > 0
      ? parsed.healthyAt
      : undefined;
  if (
    !Number.isInteger(parsed.port)
    || (parsed.port as number) < 1
    || (parsed.port as number) > 65_535
    || typeof parsed.version !== "string"
    || parsed.version.length === 0
    || pid === undefined
    || startedAt === undefined
    || healthyAt === undefined
  ) return null;
  return {
    port: parsed.port as number,
    version: parsed.version,
    pid,
    startedAt,
    healthyAt,
  };
}

export function writeCliProxyApiState(
  statePath: string,
  state: CliProxyApiState,
  security: PrivateFileSecurityOptions = {},
): void {
  const platform = security.platform ?? process.platform;
  ensurePrivateDirectory(path.dirname(statePath), { ...security, platform });
  writeFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  securePrivatePath(statePath, security);
}
