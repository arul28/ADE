#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

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
  const defaultSocketPath = process.platform === "win32"
    ? path.join(os.tmpdir(), "ade-runtime-dev.sock")
    : "/tmp/ade-runtime-dev.sock";
  let socketPath = process.env.ADE_DEV_RUNTIME_SOCKET_PATH?.trim()
    || process.env.ADE_RUNTIME_SOCKET_PATH?.trim()
    || process.env.ADE_RPC_SOCKET_PATH?.trim()
    || defaultSocketPath;

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

  return socketPath.startsWith("tcp://") ? socketPath : path.resolve(socketPath);
}

function connectSocket(socketPath) {
  if (socketPath.startsWith("tcp://")) {
    const parsed = new URL(socketPath);
    return net.createConnection({ host: parsed.hostname, port: Number(parsed.port) });
  }
  return net.createConnection(socketPath);
}

async function stopRuntime(socketPath) {
  await new Promise((resolve, reject) => {
    const socket = connectSocket(socketPath);
    let buffer = "";
    let nextId = 1;
    const pending = new Map();
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`Timed out waiting for ADE dev runtime at ${socketPath} to exit.`));
    }, 5000);

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };

    const request = (method, params) => {
      const id = nextId;
      nextId += 1;
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`, "utf8");
      return new Promise((requestResolve, requestReject) => {
        pending.set(id, { resolve: requestResolve, reject: requestReject });
      });
    };

    socket.once("connect", () => {
      void (async () => {
        await request("ade/initialize", {
          protocolVersion: "2025-06-18",
          clientInfo: { name: "ade-dev-runtime-stop", version: "dev" },
          identity: {
            callerId: `ade-dev-runtime-stop:${process.pid}`,
            role: "external",
            computerUsePolicy: {
              mode: "auto",
              allowLocalFallback: false,
              retainArtifacts: true,
            },
          },
        });
        await request("exit");
        finish();
      })().catch(finish);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const lineEnd = buffer.indexOf("\n");
        if (lineEnd === -1) return;
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);
        if (!line) continue;
        try {
          const response = JSON.parse(line);
          if (!response || typeof response !== "object" || !("id" in response)) continue;
          const entry = pending.get(response.id);
          if (!entry) continue;
          pending.delete(response.id);
          if (response.error) {
            entry.reject(new Error(response.error.message || "ADE dev runtime rejected request."));
          } else {
            entry.resolve(response.result);
          }
        } catch {
          finish(new Error(`ADE dev runtime returned invalid JSON-RPC response: ${line}`));
          return;
        }
      }
    });
    socket.once("close", () => finish());
    socket.once("error", (error) => {
      if (error && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) {
        finish();
        return;
      }
      finish(error);
    });
  });
}

async function main() {
  const socketPath = parseArgs(process.argv.slice(2));
  await stopRuntime(socketPath);
  if (!socketPath.startsWith("tcp://")) {
    try { fs.unlinkSync(socketPath); } catch {}
  }
  process.stdout.write(`[ade] stopped dev runtime at ${socketPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`[ade] failed to stop dev runtime: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
