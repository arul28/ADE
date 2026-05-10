import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, type ConnectConfig } from "ssh2";
import type { RemoteRuntimeTarget } from "../../../shared/types/remoteRuntime";
import type { RuntimeRpcTransport } from "./runtimeRpcClient";

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
};

type BuildSshConfigOptions = {
  env?: NodeJS.ProcessEnv;
  sshConfigPath?: string | null;
  homeDir?: string;
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

function expandSshPath(value: string, args: { host: string; username: string; port: number }): string {
  const expanded = value
    .replace(/%h/g, args.host)
    .replace(/%r/g, args.username)
    .replace(/%p/g, String(args.port));
  if (expanded === "~") return os.homedir();
  if (expanded.startsWith("~/")) return path.join(os.homedir(), expanded.slice(2));
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
    }
  }
  return result;
}

function readOpenSshHostConfig(target: RemoteRuntimeTarget, options: BuildSshConfigOptions): OpenSshHostConfig {
  const configPath = options.sshConfigPath === undefined
    ? path.join(os.homedir(), ".ssh", "config")
    : options.sshConfigPath;
  if (!configPath) return {};
  try {
    return parseOpenSshHostConfig(fs.readFileSync(configPath, "utf8"), target.hostname);
  } catch {
    return {};
  }
}

export function buildSshConfig(target: RemoteRuntimeTarget, options: BuildSshConfigOptions = {}): ConnectConfig {
  const hostConfig = readOpenSshHostConfig(target, options);
  const host = hostConfig.hostName ?? target.hostname;
  const port = target.port && target.port > 0 ? target.port : hostConfig.port ?? 22;
  const username = target.sshUser?.trim() || hostConfig.user || os.userInfo().username;
  const homeDir = options.homeDir ?? os.homedir();
  const config: ConnectConfig = {
    host,
    port,
    username,
    readyTimeout: 20_000,
  };
  const identityFile = target.sshKeyPath
    ?? (hostConfig.identityFile ? expandSshPath(hostConfig.identityFile, { host, username, port }) : null)
    ?? firstReadableDefaultIdentity(homeDir);
  if (identityFile) {
    config.privateKey = fs.readFileSync(identityFile);
  }
  const env = options.env ?? process.env;
  if (env.SSH_AUTH_SOCK) {
    config.agent = env.SSH_AUTH_SOCK;
  }
  return config;
}

export function connectSsh(target: RemoteRuntimeTarget): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.once("ready", () => resolve(client));
    client.once("error", reject);
    client.connect(buildSshConfig(target));
  });
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
