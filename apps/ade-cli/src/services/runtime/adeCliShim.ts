import { createHash } from "node:crypto";
import path from "node:path";
import { isAdeRuntimeNamedPipePath } from "../../../../desktop/src/shared/adeRuntimeIpc";
import { packagedCliNodeModulePaths, shellQuote } from "../../serviceManager/common";

export { packagedCliNodeModulePaths };

/**
 * Which brain an agent's `ade` should reach when its env names none.
 *
 * Two brains can run on one machine (the installed ADE and ADE Alpha, or a
 * lane's dev brain next to either). Some agent hosts strip ADE_HOME and the
 * socket variables from the env (the Cursor SDK worker does, on purpose), and
 * with nothing left the CLI falls back to `~/.ade`, which is the stable brain.
 * The `ade` shim a brain writes carries these two values as defaults so the
 * agent still reaches the brain that launched it.
 */
export type AdeCliShimBrain = {
  /** The socket or pipe the brain that wrote the shim serves. */
  socketPath: string | null;
  /** That brain's ADE_HOME, when it was started with one. */
  adeHome: string | null;
};

/**
 * Record the socket `ade serve` actually listens on.
 *
 * A brain started by the CLI already has ADE_RUNTIME_SOCKET_PATH set to it. A
 * brain started by launchd or the Windows supervisor has only ADE_HOME, so
 * without this its children could not tell which socket is theirs. The served
 * socket wins over an inherited value: it is the one this brain answers on.
 */
export function publishServedRuntimeSocket(
  socketPath: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const trimmed = socketPath.trim();
  if (trimmed) env.ADE_RUNTIME_SOCKET_PATH = trimmed;
}

function isAddressable(value: string): boolean {
  return value.startsWith("tcp://") || isAdeRuntimeNamedPipePath(value) || path.isAbsolute(value);
}

/**
 * The brain this process would hand its agents: its own socket and ADE_HOME.
 * A relative value would resolve against the agent's cwd, not this process's,
 * so it is left out rather than guessed.
 */
export function resolveAdeCliShimBrain(env: NodeJS.ProcessEnv = process.env): AdeCliShimBrain {
  const socketPath = env.ADE_RUNTIME_SOCKET_PATH?.trim() || "";
  const adeHome = env.ADE_HOME?.trim() || "";
  return {
    socketPath: socketPath && isAddressable(socketPath) ? socketPath : null,
    adeHome: adeHome && path.isAbsolute(adeHome) ? adeHome : null,
  };
}

/** A batch file reads `%` as a variable, so a literal one is doubled. */
function cmdBatchLiteral(value: string): string {
  return value.replace(/%/g, "%%");
}

/** A value a shim can carry as-is: no newline, NUL, or (for cmd) quote. */
function shimSafe(value: string | null, platform: NodeJS.Platform): value is string {
  if (!value || /[\r\n\0]/.test(value)) return false;
  return platform !== "win32" || !value.includes("\"");
}

/**
 * The `ade` shim an agent runs. It names the brain that wrote it: when the
 * caller's env picks no brain (no ADE_HOME and no ADE_RUNTIME_SOCKET_PATH),
 * it defaults both to this brain's. A caller that set either keeps its choice,
 * and `--socket <path>` still wins because the CLI reads it before the env.
 */
export function renderAdeCliShim(args: {
  entryPath: string;
  execPath: string;
  brain: AdeCliShimBrain;
  platform?: NodeJS.Platform;
  /** Module dirs put in front of the caller's NODE_PATH (see `packagedCliNodeModulePaths`). */
  nodeModulePaths?: readonly string[];
}): string {
  const platform = args.platform ?? process.platform;
  const nodeModulePaths = (args.nodeModulePaths ?? []).filter((entry) => shimSafe(entry, platform));
  // A JS entry runs under the runtime that wrote the shim; anything else runs as is.
  const isJsEntry = /\.(?:cjs|mjs|js)$/i.test(args.entryPath);
  const defaults = [
    ["ADE_HOME", args.brain.adeHome],
    ["ADE_RUNTIME_SOCKET_PATH", args.brain.socketPath],
  ].filter((entry): entry is [string, string] => shimSafe(entry[1], platform));
  if (platform === "win32") {
    const lines = ["@echo off", "setlocal"];
    if (defaults.length) {
      lines.push(
        "if defined ADE_HOME goto ade_run",
        "if defined ADE_RUNTIME_SOCKET_PATH goto ade_run",
        ...defaults.map(([name, value]) => `set "${name}=${cmdBatchLiteral(value)}"`),
        ":ade_run",
      );
    }
    if (isJsEntry) {
      if (nodeModulePaths.length) {
        // An unset NODE_PATH expands to nothing in a batch file; Node skips
        // the empty entry the trailing `;` leaves.
        lines.push(`set "NODE_PATH=${cmdBatchLiteral(nodeModulePaths.join(";"))};%NODE_PATH%"`);
      }
      lines.push(
        "set ELECTRON_RUN_AS_NODE=1",
        `"${cmdBatchLiteral(args.execPath)}" "${cmdBatchLiteral(args.entryPath)}" %*`,
      );
    } else {
      lines.push(`"${cmdBatchLiteral(args.entryPath)}" %*`);
    }
    return `${lines.join("\r\n")}\r\n`;
  }
  const lines = ["#!/bin/sh"];
  if (defaults.length) {
    lines.push(
      'if [ -z "${ADE_HOME:-}" ] && [ -z "${ADE_RUNTIME_SOCKET_PATH:-}" ]; then',
      ...defaults.map(([name, value]) => `  ${name}=${shellQuote(value)}; export ${name}`),
      "fi",
    );
  }
  if (isJsEntry && nodeModulePaths.length) {
    lines.push(`NODE_PATH=${shellQuote(nodeModulePaths.join(":"))}\${NODE_PATH:+:$NODE_PATH}; export NODE_PATH`);
  }
  lines.push(isJsEntry
    ? `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(args.execPath)} ${shellQuote(args.entryPath)} "$@"`
    : `exec ${shellQuote(args.entryPath)} "$@"`);
  return `${lines.join("\n")}\n`;
}

/**
 * One shim directory per (CLI, runtime, brain). Two brains that share a CLI
 * entry, such as a lane's dev brain and the installed one, get separate shims
 * and never overwrite each other's defaults.
 */
export function adeCliShimDirName(entryPath: string, execPath: string, brain: AdeCliShimBrain): string {
  return createHash("sha256")
    .update([entryPath, execPath, brain.socketPath ?? "", brain.adeHome ?? ""].join("\0"))
    .digest("hex")
    .slice(0, 16);
}
