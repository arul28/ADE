import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, type ConnectConfig } from "ssh2";
import type {
  RemoteRuntimeSshHostKeyIdentity,
  RemoteRuntimeSshHostKeyTrustStatus,
  RemoteRuntimeTarget,
  RemoteRuntimeTargetRoute,
  RemoteRuntimeTrustSshHostKeyResult,
} from "../../../shared/types/remoteRuntime";
import type { RuntimeRpcTransport } from "./runtimeRpcClient";
import { routeKey } from "./routeUtils";

export type SshExecResult = {
  stdout: string;
  stderr: string;
  code: number | null;
};

const MAX_SSH_EXEC_OUTPUT_BYTES = 8 * 1024 * 1024;

type OpenSshHostConfig = {
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  userKnownHostsFile?: string;
};

export type BuildSshConfigOptions = {
  env?: NodeJS.ProcessEnv;
  sshConfigPath?: string | null;
  knownHostsPath?: string | null;
  homeDir?: string;
  usernameOverride?: string;
};

export type ConnectedSshRoute = RemoteRuntimeTargetRoute;

type KnownHostEntry = {
  marker: string | null;
  hosts: string;
  keyType: string;
  keyBase64: string;
};

type ResolvedSshEndpoint = {
  host: string;
  port: number;
  username: string;
  homeDir: string;
  knownHostsPath: string | null;
  hostAliases: string[];
};

export type ScannedSshHostKey = {
  targetId: string;
  host: string;
  port: number;
  route: ConnectedSshRoute;
  key: Buffer;
  keyType: string;
  fingerprintSha256: string;
  knownHostsPath: string | null;
};

type SshHostKeyTrustOptions = BuildSshConfigOptions & {
  scanHostKey?: (
    target: RemoteRuntimeTarget,
    options: BuildSshConfigOptions,
  ) => Promise<ScannedSshHostKey>;
};

const DEFAULT_IDENTITY_FILES = [
  "id_ed25519",
  "id_ecdsa",
  "id_ecdsa_sk",
  "id_rsa",
];

function stripInlineComment(line: string): string {
  const hashIndex = line.indexOf("#");
  return hashIndex >= 0 ? line.slice(0, hashIndex).trim() : line.trim();
}

function splitSshConfigLine(line: string): [string, string] | null {
  const trimmedLine = stripInlineComment(line);
  if (!trimmedLine) return null;
  const match = /^([A-Za-z][A-Za-z0-9]+)\s+(.*)$/.exec(trimmedLine);
  if (!match) return null;
  return [match[1]!.toLowerCase(), match[2]!.trim().replace(/^"|"$/g, "")];
}

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function hostPatternsMatch(patterns: string, host: string): boolean {
  const entries = patterns.split(/\s+/).filter(Boolean);
  if (entries.length === 0) return false;
  let matched = false;
  for (const entry of entries) {
    const negated = entry.startsWith("!");
    const pattern = negated ? entry.slice(1) : entry;
    if (!pattern) continue;
    if (!patternToRegExp(pattern).test(host)) continue;
    if (negated) return false;
    matched = true;
  }
  return matched;
}

function expandSshPath(value: string, args: { host: string; username: string; port: number; homeDir?: string }): string {
  const expanded = value
    .replace(/%h/g, args.host)
    .replace(/%r/g, args.username)
    .replace(/%p/g, String(args.port));
  const homeDir = args.homeDir ?? os.homedir();
  if (expanded === "~") return homeDir;
  if (expanded.startsWith("~/")) return path.join(homeDir, expanded.slice(2));
  return expanded;
}

function firstReadableDefaultIdentity(homeDir: string): string | null {
  for (const fileName of DEFAULT_IDENTITY_FILES) {
    const candidate = path.join(homeDir, ".ssh", fileName);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next OpenSSH default identity path.
    }
  }
  return null;
}

function normalizeKnownHostName(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.endsWith(".") && !trimmed.includes("]:")) {
    return trimmed.slice(0, -1);
  }
  return trimmed;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function knownHostCandidates(hostAliases: string[], port: number): string[] {
  return uniqueStrings(hostAliases.flatMap((hostAlias) => {
    const host = normalizeKnownHostName(hostAlias);
    if (!host) return [];
    const bracketed = host.startsWith("[") ? host : `[${host}]:${port}`;
    // OpenSSH only writes a bare-host entry for the default port 22; for a
    // non-standard port it requires a bracketed `[host]:port` match. Do not
    // fall back to the bare host on non-22 ports, or a key trusted for port 22
    // would be accepted for a different port on the same host.
    return port === 22 ? [host, bracketed] : [bracketed];
  }));
}

function knownHostWritePattern(host: string, port: number): string | null {
  const normalized = normalizeKnownHostName(host);
  if (!normalized) return null;
  if (port === 22) return normalized;
  return normalized.startsWith("[") ? normalized : `[${normalized}]:${port}`;
}

function parseKnownHostLine(line: string): KnownHostEntry | null {
  const trimmed = stripInlineComment(line);
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/).filter(Boolean);
  let marker: string | null = null;
  if (parts[0]?.startsWith("@")) {
    marker = parts.shift() ?? null;
  }
  if (parts.length < 3) return null;
  return {
    marker,
    hosts: parts[0]!,
    keyType: parts[1]!,
    keyBase64: parts[2]!,
  };
}

function readKnownHostEntries(knownHostsPath: string | null): KnownHostEntry[] {
  if (!knownHostsPath) return [];
  try {
    return fs.readFileSync(knownHostsPath, "utf8")
      .split(/\r?\n/)
      .map(parseKnownHostLine)
      .filter((entry): entry is KnownHostEntry => entry != null);
  } catch {
    return [];
  }
}

function hashedKnownHostPatternMatches(pattern: string, candidate: string): boolean {
  const parts = pattern.split("|");
  if (parts.length !== 4 || parts[1] !== "1") return false;
  try {
    const salt = Buffer.from(parts[2]!, "base64");
    const expected = Buffer.from(parts[3]!, "base64");
    const actual = createHmac("sha1", salt).update(candidate).digest();
    return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function knownHostPatternMatches(pattern: string, candidate: string): boolean {
  if (pattern.startsWith("|1|")) {
    return hashedKnownHostPatternMatches(pattern, candidate);
  }
  return patternToRegExp(normalizeKnownHostName(pattern)).test(candidate);
}

function knownHostEntryMatchesCandidates(entry: KnownHostEntry, candidates: string[]): boolean {
  let matched = false;
  for (const rawPattern of entry.hosts.split(",").filter(Boolean)) {
    const negated = rawPattern.startsWith("!");
    const pattern = negated ? rawPattern.slice(1) : rawPattern;
    if (!pattern) continue;
    const patternMatched = candidates.some((candidate) =>
      knownHostPatternMatches(pattern, candidate),
    );
    if (!patternMatched) continue;
    if (negated) return false;
    matched = true;
  }
  return matched;
}

function knownHostEntryKeyMatches(entry: KnownHostEntry, key: Buffer): boolean {
  try {
    return Buffer.from(entry.keyBase64, "base64").equals(key);
  } catch {
    return false;
  }
}

function knownHostsAllowKey(entries: KnownHostEntry[], candidates: string[], key: Buffer): boolean {
  let matched = false;
  for (const entry of entries) {
    if (!knownHostEntryMatchesCandidates(entry, candidates)) continue;
    if (entry.marker === "@cert-authority") continue;
    if (!knownHostEntryKeyMatches(entry, key)) continue;
    if (entry.marker === "@revoked") return false;
    matched = true;
  }
  return matched;
}

function knownHostsHaveEntry(entries: KnownHostEntry[], candidates: string[]): boolean {
  return entries.some(
    (entry) =>
      entry.marker !== "@cert-authority" &&
      entry.marker !== "@revoked" &&
      knownHostEntryMatchesCandidates(entry, candidates),
  );
}

function knownHostsTrustState(
  entries: KnownHostEntry[],
  candidates: string[],
  key: Buffer,
): "trusted" | "changed" | "unknown" {
  if (knownHostsAllowKey(entries, candidates, key)) return "trusted";
  if (knownHostsHaveEntry(entries, candidates)) return "changed";
  return "unknown";
}

function sshHostKeyType(key: Buffer): string {
  if (key.byteLength < 4) return "ssh-unknown";
  try {
    const length = key.readUInt32BE(0);
    if (length <= 0 || length > 128 || 4 + length > key.byteLength) {
      return "ssh-unknown";
    }
    const value = key.subarray(4, 4 + length).toString("utf8");
    return /^[A-Za-z0-9._@+-]+$/.test(value) ? value : "ssh-unknown";
  } catch {
    return "ssh-unknown";
  }
}

function sshHostKeyFingerprintSha256(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/g, "")}`;
}

export function parseOpenSshHostConfig(configText: string, hostAlias: string): OpenSshHostConfig {
  const result: OpenSshHostConfig = {};
  let active = false;
  for (const line of configText.split(/\r?\n/)) {
    const parsed = splitSshConfigLine(line);
    if (!parsed) continue;
    const [keyword, value] = parsed;
    if (keyword === "host") {
      active = hostPatternsMatch(value, hostAlias);
      continue;
    }
    if (!active) continue;
    if (keyword === "hostname" && !result.hostName) {
      result.hostName = value;
    } else if (keyword === "user" && !result.user) {
      result.user = value;
    } else if (keyword === "port" && result.port == null) {
      const port = Number.parseInt(value, 10);
      if (Number.isFinite(port) && port > 0) result.port = port;
    } else if (keyword === "identityfile" && !result.identityFile) {
      result.identityFile = value;
    } else if (keyword === "userknownhostsfile" && !result.userKnownHostsFile) {
      const knownHostsFile = value.split(/\s+/).filter(Boolean)[0];
      if (knownHostsFile) result.userKnownHostsFile = knownHostsFile;
    }
  }
  return result;
}

function readOpenSshHostConfig(target: RemoteRuntimeTarget, options: BuildSshConfigOptions): OpenSshHostConfig {
  const configPath = options.sshConfigPath === undefined
    ? path.join(options.homeDir ?? os.homedir(), ".ssh", "config")
    : options.sshConfigPath;
  if (!configPath) return {};
  try {
    return parseOpenSshHostConfig(fs.readFileSync(configPath, "utf8"), target.hostname);
  } catch {
    return {};
  }
}

function resolveKnownHostsPath(
  options: BuildSshConfigOptions,
  homeDir: string,
  hostConfig: OpenSshHostConfig,
  args: { host: string; username: string; port: number },
): string | null {
  if (options.knownHostsPath !== undefined) return options.knownHostsPath;
  if (hostConfig.userKnownHostsFile) {
    return expandSshPath(hostConfig.userKnownHostsFile, { ...args, homeDir });
  }
  return path.join(homeDir, ".ssh", "known_hosts");
}

function resolveSshEndpoint(target: RemoteRuntimeTarget, options: BuildSshConfigOptions): ResolvedSshEndpoint {
  const hostConfig = readOpenSshHostConfig(target, options);
  const host = hostConfig.hostName ?? target.hostname;
  const port = target.port && target.port > 0 ? target.port : hostConfig.port ?? 22;
  const username = (options.usernameOverride ?? target.sshUser?.trim()) || hostConfig.user || os.userInfo().username;
  const homeDir = options.homeDir ?? os.homedir();
  return {
    host,
    port,
    username,
    homeDir,
    knownHostsPath: resolveKnownHostsPath(options, homeDir, hostConfig, {
      host,
      username,
      port,
    }),
    hostAliases: uniqueStrings([target.hostname, host]),
  };
}

export function hasKnownSshHostKeyForTarget(
  target: RemoteRuntimeTarget,
  options: BuildSshConfigOptions = {},
): boolean {
  const endpoint = resolveSshEndpoint(target, options);
  const entries = readKnownHostEntries(endpoint.knownHostsPath);
  return knownHostsHaveEntry(
    entries,
    knownHostCandidates(endpoint.hostAliases, endpoint.port),
  );
}

function remoteHostKeyIdentityFromScan(
  scan: ScannedSshHostKey,
): RemoteRuntimeSshHostKeyIdentity {
  return {
    targetId: scan.targetId,
    host: scan.host,
    port: scan.port,
    route: scan.route,
    keyType: scan.keyType,
    fingerprintSha256: scan.fingerprintSha256,
    knownHostsPath: scan.knownHostsPath,
  };
}

function knownHostWritePatternsForTarget(
  target: RemoteRuntimeTarget,
  options: BuildSshConfigOptions = {},
): string[] {
  return uniqueStrings(
    buildSshRouteCandidates(target).flatMap((route) => {
      const routeTarget = targetForRoute(target, route);
      const endpoint = resolveSshEndpoint(routeTarget, options);
      return [
        knownHostWritePattern(routeTarget.hostname, endpoint.port),
        knownHostWritePattern(endpoint.host, endpoint.port),
      ];
    }),
  );
}

function appendKnownSshHostKeyForTarget(
  target: RemoteRuntimeTarget,
  scan: ScannedSshHostKey,
  options: BuildSshConfigOptions = {},
): void {
  const knownHostsPath = scan.knownHostsPath;
  if (!knownHostsPath) {
    throw new Error("ADE could not resolve an SSH known_hosts file for this machine.");
  }
  const entries = readKnownHostEntries(knownHostsPath);
  const patterns = knownHostWritePatternsForTarget(target, options);
  const candidates = uniqueStrings([
    ...patterns,
    ...knownHostCandidates([target.hostname, scan.host], scan.port),
  ]);
  const trustState = knownHostsTrustState(entries, candidates, scan.key);
  if (trustState === "trusted") return;
  if (trustState === "changed") {
    throw new Error(
      "This machine already has a different SSH host key saved. " +
        "Remove the old known_hosts entry only if the machine was intentionally replaced.",
    );
  }

  if (patterns.length === 0) {
    throw new Error("ADE could not resolve SSH hostnames to trust for this machine.");
  }

  fs.mkdirSync(path.dirname(knownHostsPath), { recursive: true, mode: 0o700 });
  const line = `${patterns.join(",")} ${scan.keyType} ${scan.key.toString("base64")}\n`;
  fs.appendFileSync(knownHostsPath, line, { mode: 0o600 });
}

export async function scanSshHostKeyForTarget(
  target: RemoteRuntimeTarget,
  options: BuildSshConfigOptions = {},
): Promise<ScannedSshHostKey> {
  let lastError: unknown = null;
  for (const route of buildSshRouteCandidates(target)) {
    const routeTarget = targetForRoute(target, route);
    const endpoint = resolveSshEndpoint(routeTarget, options);
    let scannedKey: Buffer | null = null;
    const config = buildSshConfig(routeTarget, {
      ...options,
      usernameOverride:
        routeTarget.sshUser?.trim() || endpoint.username || os.userInfo().username,
    });
    config.hostVerifier = (key: Buffer) => {
      scannedKey = Buffer.from(key);
      return false;
    };

    try {
      const client = await connectSshWithConfig(config);
      try {
        client.end();
      } catch {}
    } catch (error) {
      lastError = error;
      if (scannedKey) {
        return {
          targetId: target.id,
          host: endpoint.host,
          port: endpoint.port,
          route,
          key: scannedKey,
          keyType: sshHostKeyType(scannedKey),
          fingerprintSha256: sshHostKeyFingerprintSha256(scannedKey),
          knownHostsPath: endpoint.knownHostsPath,
        };
      }
      continue;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("ADE could not read the SSH host key for this machine.");
}

export async function getSshHostKeyTrustForTarget(
  target: RemoteRuntimeTarget,
  options: SshHostKeyTrustOptions = {},
): Promise<RemoteRuntimeSshHostKeyTrustStatus> {
  // Always scan the live host key. A stored known_hosts entry only proves that
  // *some* key was saved; if the machine now presents a different key we must
  // report "changed" (not "trusted") so the UI can surface the mismatch before
  // an SSH connect fails host verification.
  const { scanHostKey, ...buildOptions } = options;
  const scan = await (scanHostKey ?? scanSshHostKeyForTarget)(target, buildOptions);
  const scanEntries = readKnownHostEntries(scan.knownHostsPath);
  const scanCandidates = knownHostCandidates([target.hostname, scan.host], scan.port);
  const trustState = knownHostsTrustState(scanEntries, scanCandidates, scan.key);
  return {
    state: trustState === "trusted" ? "trusted" : trustState === "changed" ? "changed" : "needs_trust",
    ...remoteHostKeyIdentityFromScan(scan),
  };
}

export async function trustSshHostKeyForTarget(
  target: RemoteRuntimeTarget,
  expectedFingerprintSha256: string,
  options: SshHostKeyTrustOptions = {},
): Promise<RemoteRuntimeTrustSshHostKeyResult> {
  const { scanHostKey, ...buildOptions } = options;
  const scan = await (scanHostKey ?? scanSshHostKeyForTarget)(target, buildOptions);
  if (scan.fingerprintSha256 !== expectedFingerprintSha256) {
    throw new Error("The SSH host key changed before ADE could trust this machine. Try connecting again.");
  }
  appendKnownSshHostKeyForTarget(target, scan, buildOptions);
  return {
    trusted: true,
    identity: remoteHostKeyIdentityFromScan(scan),
  };
}

export function buildSshConfig(target: RemoteRuntimeTarget, options: BuildSshConfigOptions = {}): ConnectConfig {
  const hostConfig = readOpenSshHostConfig(target, options);
  const endpoint = resolveSshEndpoint(target, options);
  const config: ConnectConfig = {
    host: endpoint.host,
    port: endpoint.port,
    username: endpoint.username,
    readyTimeout: 20_000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
  };
  const identityFile = target.sshKeyPath
    ?? (hostConfig.identityFile ? expandSshPath(hostConfig.identityFile, {
      host: endpoint.host,
      username: endpoint.username,
      port: endpoint.port,
      homeDir: endpoint.homeDir,
    }) : null)
    ?? firstReadableDefaultIdentity(endpoint.homeDir);
  if (identityFile) {
    config.privateKey = fs.readFileSync(identityFile);
  }
  const knownHostEntries = readKnownHostEntries(endpoint.knownHostsPath);
  const candidates = knownHostCandidates(endpoint.hostAliases, endpoint.port);
  config.hostVerifier = (key: Buffer) => knownHostsAllowKey(knownHostEntries, candidates, key);
  const env = options.env ?? process.env;
  if (env.SSH_AUTH_SOCK) {
    config.agent = env.SSH_AUTH_SOCK;
  }
  return config;
}

function uniqueUsernames(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const username = value?.trim();
    if (!username || seen.has(username)) continue;
    seen.add(username);
    result.push(username);
  }
  return result;
}


function normalizeTargetRoute(
  value: unknown,
): RemoteRuntimeTargetRoute | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const hostname =
    typeof record.hostname === "string" ? record.hostname.trim() : "";
  if (!hostname) return null;
  const port =
    typeof record.port === "number" && Number.isFinite(record.port)
      ? Math.max(1, Math.min(65_535, Math.floor(record.port)))
      : null;
  return {
    hostname,
    port,
    source:
      record.source === "bonjour" || record.source === "tailscale"
        ? record.source
        : "manual",
    lastSucceededAt:
      typeof record.lastSucceededAt === "number" &&
      Number.isFinite(record.lastSucceededAt)
        ? record.lastSucceededAt
        : null,
  };
}

export function buildSshRouteCandidates(
  target: RemoteRuntimeTarget,
): RemoteRuntimeTargetRoute[] {
  const primary: RemoteRuntimeTargetRoute = {
    hostname: target.hostname,
    port: target.port,
    source: "manual",
    lastSucceededAt: null,
  };
  const routes: RemoteRuntimeTargetRoute[] = [primary];
  for (const route of target.routes ?? []) {
    const normalized = normalizeTargetRoute(route);
    if (normalized) routes.push(normalized);
  }

  const unique: RemoteRuntimeTargetRoute[] = [];
  const seen = new Set<string>();
  for (const route of routes) {
    const key = routeKey(route);
    if (seen.has(key)) {
      const existing = unique.find((entry) => routeKey(entry) === key);
      if (existing) {
        if (existing.source === "manual" && route.source !== "manual") {
          existing.source = route.source;
        }
        if (
          route.lastSucceededAt != null &&
          (existing.lastSucceededAt == null ||
            route.lastSucceededAt > existing.lastSucceededAt)
        ) {
          existing.lastSucceededAt = route.lastSucceededAt;
        }
      }
      continue;
    }
    seen.add(key);
    unique.push(route);
  }

  const hasLastSuccess = unique.some((route) => route.lastSucceededAt != null);
  if (!hasLastSuccess) return unique;
  return unique.sort(
    (a, b) => (b.lastSucceededAt ?? 0) - (a.lastSucceededAt ?? 0),
  );
}

function targetForRoute(
  target: RemoteRuntimeTarget,
  route: RemoteRuntimeTargetRoute,
): RemoteRuntimeTarget {
  return {
    ...target,
    hostname: route.hostname,
    port: route.port ?? target.port,
  };
}

export function buildSshUsernameCandidates(target: RemoteRuntimeTarget, options: BuildSshConfigOptions = {}): string[] {
  const hostConfig = readOpenSshHostConfig(target, options);
  const explicitUser = target.sshUser?.trim() || hostConfig.user;
  const localUser = os.userInfo().username;
  if (explicitUser) return [explicitUser];
  return uniqueUsernames([localUser, "admin"]);
}

export function buildSshConfigCandidates(target: RemoteRuntimeTarget, options: BuildSshConfigOptions = {}): ConnectConfig[] {
  return buildSshConnectionCandidates(target, options).map(
    (candidate) => candidate.config,
  );
}

function isSshAuthenticationFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { level?: unknown; message?: unknown };
  return candidate.level === "client-authentication" ||
    (typeof candidate.message === "string" && /authentication/i.test(candidate.message));
}

function connectSshWithConfig(config: ConnectConfig): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const normalizeError = (error: unknown, fallback: string): Error =>
      error instanceof Error ? error : new Error(String(error ?? fallback));
    const cleanupConnectListeners = (options: { keepErrorListener?: boolean } = {}): void => {
      client.off("ready", onReady);
      if (!options.keepErrorListener) {
        client.off("error", onError);
      }
      client.off("close", onClose);
      client.off("end", onEnd);
    };
    const fail = (error: unknown, fallback: string): void => {
      if (settled) return;
      settled = true;
      // ssh2 may emit a late socket error after close/end during a failed
      // connect attempt. Keep onError attached as a sink so the late error is
      // contained after the promise has already rejected.
      cleanupConnectListeners({ keepErrorListener: true });
      reject(normalizeError(error, fallback));
    };
    const onReady = (): void => {
      if (settled) return;
      settled = true;
      cleanupConnectListeners();
      // ssh2 can surface transport resets after ready and before the remote
      // pool attaches its lifecycle listener. Keep a durable listener so those
      // errors remain contained instead of becoming process-level exceptions.
      client.on("error", () => {});
      resolve(client);
    };
    const onError = (error: Error): void => {
      fail(error, "SSH connection failed.");
    };
    const onClose = (): void => {
      fail(null, "SSH connection closed before it became ready.");
    };
    const onEnd = (): void => {
      fail(null, "SSH connection ended before it became ready.");
    };
    client.once("ready", onReady);
    client.on("error", onError);
    client.once("close", onClose);
    client.once("end", onEnd);
    try {
      client.connect(config);
    } catch (error) {
      fail(error, "SSH connection failed.");
    }
  });
}

function buildSshConnectionCandidates(
  target: RemoteRuntimeTarget,
  options: BuildSshConfigOptions = {},
): Array<{ config: ConnectConfig; route: ConnectedSshRoute }> {
  return buildSshRouteCandidates(target).flatMap((route) => {
    const routeTarget = targetForRoute(target, route);
    return buildSshUsernameCandidates(routeTarget, options).map((username) => ({
      config: buildSshConfig(routeTarget, {
        ...options,
        usernameOverride: username,
      }),
      route,
    }));
  });
}

export async function connectSshWithRoute(
  target: RemoteRuntimeTarget,
): Promise<{ client: Client; route: ConnectedSshRoute }> {
  const configs = buildSshConnectionCandidates(target);
  let lastError: unknown = null;
  for (let index = 0; index < configs.length; index += 1) {
    const candidate = configs[index]!;
    try {
      const client = await connectSshWithConfig(candidate.config);
      return { client, route: candidate.route };
    } catch (error) {
      lastError = error;
      if (index >= configs.length - 1) break;
      if (!isSshAuthenticationFailure(error)) {
        while (
          index + 1 < configs.length &&
          routeKey(configs[index + 1]!.route) === routeKey(candidate.route)
        ) {
          index += 1;
        }
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "SSH connection failed."));
}

export async function connectSsh(target: RemoteRuntimeTarget): Promise<Client> {
  return (await connectSshWithRoute(target)).client;
}

export function execSsh(client: Client, command: string): Promise<SshExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let code: number | null = null;
      stream.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > MAX_SSH_EXEC_OUTPUT_BYTES) {
          reject(new Error(`SSH command stdout exceeded ${MAX_SSH_EXEC_OUTPUT_BYTES} bytes.`));
          stream.close();
          return;
        }
        stdout += chunk.toString("utf8");
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > MAX_SSH_EXEC_OUTPUT_BYTES) {
          reject(new Error(`SSH command stderr exceeded ${MAX_SSH_EXEC_OUTPUT_BYTES} bytes.`));
          stream.close();
          return;
        }
        stderr += chunk.toString("utf8");
      });
      stream.on("exit", (exitCode: number | null) => {
        code = exitCode;
      });
      stream.on("close", () => resolve({ stdout, stderr, code }));
      stream.on("error", reject);
    });
  });
}

export function openSshRuntimeTransport(client: Client, command = "~/.ade/bin/ade rpc --stdio"): Promise<RuntimeRpcTransport> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      let closed = false;
      let streamError: Error | null = null;
      const closeCallbacks = new Set<() => void>();
      const errorCallbacks = new Set<(error: Error) => void>();

      stream.once("error", (streamErrorValue: Error) => {
        streamError = streamErrorValue;
        for (const callback of errorCallbacks) {
          callback(streamErrorValue);
        }
        errorCallbacks.clear();
      });
      stream.once("close", () => {
        closed = true;
        for (const callback of closeCallbacks) {
          callback();
        }
        closeCallbacks.clear();
        errorCallbacks.clear();
      });

      resolve({
        onData(callback) {
          stream.on("data", (chunk: Buffer) => callback(Buffer.from(chunk)));
        },
        onError(callback) {
          const currentError = streamError;
          if (currentError) {
            queueMicrotask(() => callback(currentError));
            return;
          }
          errorCallbacks.add(callback);
        },
        onClose(callback) {
          if (closed) {
            queueMicrotask(callback);
            return;
          }
          closeCallbacks.add(callback);
        },
        write(data) {
          stream.write(data);
        },
        close() {
          stream.end();
        },
      });
    });
  });
}
