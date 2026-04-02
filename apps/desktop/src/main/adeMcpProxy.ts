import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Buffer } from "node:buffer";
import { resolveAdeLayout } from "../shared/adeLayout";
import {
  asTrimmed,
  hasProxyIdentity,
  injectIdentityIntoInitializePayload,
  takeNextInboundMessage,
  type ProxyIdentity,
} from "./adeMcpProxyUtils";

process.env.ADE_STDIO_TRANSPORT ??= "1";

type RuntimeRoots = {
  projectRoot: string;
  workspaceRoot: string;
};

function resolveCliArg(flag: string): string | null {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (value !== flag) continue;
    const next = args[i + 1];
    if (next?.trim()) return path.resolve(next.trim());
  }
  return null;
}

function hasFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag);
}

function resolveRoot(envKey: string, flag: string, fallback: string): string {
  const fromEnv = process.env[envKey]?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return resolveCliArg(flag) ?? fallback;
}

function resolveRuntimeRoots(): RuntimeRoots {
  const projectRoot = resolveRoot("ADE_PROJECT_ROOT", "--project-root", process.cwd());
  const workspaceRoot = resolveRoot("ADE_WORKSPACE_ROOT", "--workspace-root", projectRoot);
  return { projectRoot, workspaceRoot };
}

function asBoolFlag(value: string | undefined): boolean | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "1" ? true : trimmed === "0" ? false : null;
}

function resolveProxyIdentityFromEnv(): ProxyIdentity {
  const computerUseMode = asTrimmed(process.env.ADE_COMPUTER_USE_MODE);
  const allowLocalFallback = asBoolFlag(process.env.ADE_COMPUTER_USE_ALLOW_LOCAL_FALLBACK);
  const retainArtifacts = asBoolFlag(process.env.ADE_COMPUTER_USE_RETAIN_ARTIFACTS);
  const preferredBackend = asTrimmed(process.env.ADE_COMPUTER_USE_PREFERRED_BACKEND);
  const hasComputerUsePolicy =
    computerUseMode
    || typeof allowLocalFallback === "boolean"
    || typeof retainArtifacts === "boolean"
    || preferredBackend;
  return {
    chatSessionId: asTrimmed(process.env.ADE_CHAT_SESSION_ID),
    missionId: asTrimmed(process.env.ADE_MISSION_ID),
    runId: asTrimmed(process.env.ADE_RUN_ID),
    stepId: asTrimmed(process.env.ADE_STEP_ID),
    attemptId: asTrimmed(process.env.ADE_ATTEMPT_ID),
    ownerId: asTrimmed(process.env.ADE_OWNER_ID),
    role: asTrimmed(process.env.ADE_DEFAULT_ROLE),
    computerUsePolicy: hasComputerUsePolicy
      ? {
          mode: computerUseMode,
          allowLocalFallback,
          retainArtifacts,
          preferredBackend,
        }
      : null,
  };
}

function relayProxyInputWithIdentity(socket: net.Socket): void {
  const identity = resolveProxyIdentityFromEnv();
  if (!hasProxyIdentity(identity)) {
    process.stdin.pipe(socket);
    process.stdin.on("end", () => {
      socket.end();
    });
    return;
  }

  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  process.stdin.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    while (true) {
      const parsed = takeNextInboundMessage(pending);
      if (!parsed) break;
      pending = parsed.rest;
      const payloadText = injectIdentityIntoInitializePayload(parsed.payloadText, identity);
      if (payloadText === parsed.payloadText) {
        socket.write(parsed.raw);
        continue;
      }
      if (parsed.transport === "jsonl") {
        socket.write(`${payloadText}\n`);
        continue;
      }
      const framed = `Content-Length: ${Buffer.byteLength(payloadText, "utf8")}\r\n\r\n${payloadText}`;
      socket.write(framed);
    }
  });
  process.stdin.on("end", () => {
    if (pending.length > 0) {
      socket.write(pending);
      pending = Buffer.alloc(0);
    }
    socket.end();
  });
}

async function main(): Promise<void> {
  const roots = resolveRuntimeRoots();
  const socketPath = process.env.ADE_MCP_SOCKET_PATH?.trim() || resolveAdeLayout(roots.projectRoot).socketPath;

  if (hasFlag("--probe")) {
    process.stdout.write(JSON.stringify({
      ok: true,
      mode: "bundled_proxy",
      projectRoot: roots.projectRoot,
      workspaceRoot: roots.workspaceRoot,
      socketPath,
      socketExists: fs.existsSync(socketPath),
    }));
    process.exit(0);
  }

  const socket = net.createConnection(socketPath);
  let connected = false;

  socket.on("error", (err) => {
    const prefix = connected ? "[ade-mcp-proxy]" : "[ade-mcp-proxy] Failed to connect";
    process.stderr.write(`${prefix}: ${err.message}\n`);
    process.exit(1);
  });

  socket.on("connect", () => {
    connected = true;
    process.stdin.resume();
    relayProxyInputWithIdentity(socket);
    socket.pipe(process.stdout);
  });

  socket.on("close", () => {
    process.exit(connected ? 0 : 1);
  });
}

void main().catch((error) => {
  process.stderr.write(`[ade-mcp-proxy] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
