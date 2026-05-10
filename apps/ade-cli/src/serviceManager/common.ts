import fs from "node:fs";
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

export const ADE_RUNTIME_SERVICE_NAME = "com.ade.runtime";

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

function runtimeEnvironment(): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  if (process.versions.electron) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  if (process.env.NODE_PATH?.trim()) {
    env.NODE_PATH = process.env.NODE_PATH;
  }
  if (process.env.ADE_HOME?.trim()) {
    env.ADE_HOME = process.env.ADE_HOME;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function resolveAdeServeCommand(): AdeServiceCommand {
  const entry = typeof process.argv[1] === "string" && process.argv[1].trim()
    ? path.resolve(process.argv[1])
    : "";
  const isNodeScript = /\.(?:cjs|mjs|js|ts)$/i.test(entry) && fs.existsSync(entry);
  if (isNodeScript) {
    return {
      command: process.execPath,
      args: [entry, "serve"],
      env: runtimeEnvironment(),
    };
  }
  return {
    command: process.execPath,
    args: ["serve"],
    env: runtimeEnvironment(),
  };
}

export function renderCommand(command: AdeServiceCommand): string {
  return [command.command, ...command.args].map(shellQuote).join(" ");
}

export function serviceManagerResultText(result: ServiceManagerProcessResult): string {
  const stdout = typeof result.stdout === "string"
    ? result.stdout.trim()
    : Buffer.isBuffer(result.stdout)
      ? result.stdout.toString("utf8").trim()
      : "";
  const stderr = typeof result.stderr === "string"
    ? result.stderr.trim()
    : Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8").trim()
      : "";
  return stderr || stdout;
}
