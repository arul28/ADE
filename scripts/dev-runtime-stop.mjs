#!/usr/bin/env node

import fs from "node:fs";
import {
  canConnectToSocket,
  resolveDevSocketPath,
  shutdownRuntime,
} from "./dev-shared.mjs";

function usage() {
  return [
    "Usage: npm stop dev [-- options]",
    "",
    "Stops the isolated ADE dev runtime daemon by sending JSON-RPC exit to its socket.",
    "",
    "Options:",
    "  --socket <path>      Runtime socket. Defaults to ADE_DEV_RUNTIME_SOCKET_PATH or /tmp/ade-runtime-dev.sock.",
    "  -h, --help           Show this help.",
  ].join("\n");
}

function parseArgs(argv) {
  let socketPath = process.env.ADE_DEV_RUNTIME_SOCKET_PATH?.trim()
    || process.env.ADE_RUNTIME_SOCKET_PATH?.trim()
    || process.env.ADE_RPC_SOCKET_PATH?.trim()
    || null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "dev" || arg === "runtime") {
      continue;
    }
    if (arg === "--socket") {
      const value = argv[i + 1];
      if (!value) throw new Error("--socket requires a path.");
      socketPath = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--socket=")) {
      socketPath = arg.slice("--socket=".length);
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return resolveDevSocketPath(socketPath);
}

async function main() {
  const socketPath = parseArgs(process.argv.slice(2));
  if (await canConnectToSocket(socketPath)) {
    await shutdownRuntime(socketPath);
  }
  if (!socketPath.startsWith("tcp://")) {
    try { fs.unlinkSync(socketPath); } catch {}
  }
  process.stdout.write(`[ade] stopped dev runtime at ${socketPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`[ade] failed to stop dev runtime: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
