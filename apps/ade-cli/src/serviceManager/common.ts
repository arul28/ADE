import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { SpawnSyncOptions } from "node:child_process";

export type ServiceManagerResult = {
  ok: boolean;
  serviceName: string;
  action: "install" | "uninstall";
  path: string | null;
  message: string;
};

export type ServiceManagerStatusResult = {
  ok: boolean;
  serviceName: string;
  action: "status";
  installed: boolean | null;
  running: boolean | null;
  path: string | null;
  message: string;
};

export type AdeServiceCommand = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

function resolveRuntimeServiceName(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ADE_RUNTIME_SERVICE_NAME?.trim();
  if (explicit) return explicit;
  const channel = env.ADE_PACKAGE_CHANNEL?.trim().toLowerCase();
  if (channel === "alpha") return "com.ade.runtime.alpha";
  if (channel === "beta") return "com.ade.runtime.beta";
  return "com.ade.runtime";
}

export const ADE_RUNTIME_SERVICE_NAME = resolveRuntimeServiceName();

export type ServiceManagerProcessResult = {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
};

export type ServiceManagerSpawnSync = (
  command: string,
  args: string[],
  options?: SpawnSyncOptions,
) => ServiceManagerProcessResult;

const RUNTIME_ENV_PASSTHROUGH = [
  "NODE_PATH",
  "ADE_HOME",
  "ADE_PACKAGE_CHANNEL",
  "ADE_DESKTOP_APP_NAME",
  "ADE_RUNTIME_SERVICE_NAME",
  "ADE_DEFAULT_ROLE",
] as const;

function runtimeEnvironment(): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  if (process.versions.electron) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  for (const key of RUNTIME_ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value?.trim()) {
      env[key] = value;
    }
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function fileSha256(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function resolveCliPackageRoot(entryPath: string): string | null {
  const seen = new Set<string>();
  const starts = entryPath ? [path.dirname(entryPath)] : [process.cwd()];
  for (const start of starts) {
    if (!start) continue;
    let cursor = path.resolve(start);
    while (!seen.has(cursor)) {
      seen.add(cursor);
      const packageJson = path.join(cursor, "package.json");
      const srcCli = path.join(cursor, "src", "cli.ts");
      if (fs.existsSync(packageJson) && fs.existsSync(srcCli)) {
        return cursor;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  return null;
}

function resolveCliDistPath(entryPath: string): string | null {
  const packageRoot = resolveCliPackageRoot(entryPath);
  if (!packageRoot) return null;
  const distPath = path.join(packageRoot, "dist", "cli.cjs");
  return fs.existsSync(distPath) ? distPath : null;
}

export function resolveAdeServiceCommandBuildHash(command: AdeServiceCommand): string | null {
  const firstArg = command.args[0] ? path.resolve(command.args[0]) : "";
  const isNodeServeFallback =
    command.command === process.execPath
    && command.args.length === 1
    && command.args[0] === "serve";
  if (isNodeServeFallback) {
    const entry = typeof process.argv[1] === "string" && process.argv[1].trim()
      ? path.resolve(process.argv[1])
      : "";
    const distPath = resolveCliDistPath(entry);
    return distPath ? fileSha256(distPath) : null;
  }
  if (command.command === process.execPath && firstArg && fs.existsSync(firstArg)) {
    return fileSha256(firstArg);
  }
  if (command.command !== process.execPath && fs.existsSync(command.command)) {
    return fileSha256(path.resolve(command.command));
  }
  return null;
}

function withRuntimeBuildHash(command: AdeServiceCommand): AdeServiceCommand {
  const buildHash = resolveAdeServiceCommandBuildHash(command);
  if (!buildHash) return command;
  return {
    ...command,
    env: {
      ...(command.env ?? {}),
      ADE_RUNTIME_BUILD_HASH: buildHash,
    },
  };
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function cmdQuote(value: string): string {
  if (value.includes("\"")) {
    throw new Error("Windows service command arguments cannot contain double quotes.");
  }
  let quoted = "\"";
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    quoted += "\\".repeat(backslashes);
    quoted += char;
    backslashes = 0;
  }
  quoted += "\\".repeat(backslashes * 2);
  quoted += "\"";
  return quoted;
}

export function resolveAdeServeCommand(): AdeServiceCommand {
  const entry = typeof process.argv[1] === "string" && process.argv[1].trim()
    ? path.resolve(process.argv[1])
    : "";
  const isNodeScript = /\.(?:cjs|mjs|js|ts)$/i.test(entry) && fs.existsSync(entry);
  if (isNodeScript) {
    return withRuntimeBuildHash({
      command: process.execPath,
      args: [entry, "serve"],
      env: runtimeEnvironment(),
    });
  }
  if (entry && fs.existsSync(entry)) {
    return withRuntimeBuildHash({
      command: entry,
      args: ["serve"],
      env: runtimeEnvironment(),
    });
  }
  return withRuntimeBuildHash({
    command: process.execPath,
    args: ["serve"],
    env: runtimeEnvironment(),
  });
}

export function renderCommand(command: AdeServiceCommand): string {
  return [command.command, ...command.args].map(shellQuote).join(" ");
}

export function renderWindowsCommand(command: AdeServiceCommand): string {
  return [command.command, ...command.args].map(cmdQuote).join(" ");
}

function streamToText(value: string | Buffer | null | undefined): string {
  if (typeof value === "string") return value.trim();
  if (Buffer.isBuffer(value)) return value.toString("utf8").trim();
  return "";
}

export function serviceManagerResultText(result: ServiceManagerProcessResult): string {
  return streamToText(result.stderr) || streamToText(result.stdout);
}
