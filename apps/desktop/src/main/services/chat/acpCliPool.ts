import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type InitializeResponse,
} from "@agentclientprotocol/sdk";
import type { AcpHostBridge, AcpHostTermState } from "./acpHostClient";
import { createAcpHostClient } from "./acpHostClient";
import {
  destroyChildProcessStreams,
  signalChildProcessTree,
  terminateChildProcessTree,
} from "../shared/utils";

export type AcpCliSpawnSpec = {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
};

export type AcpCliPoolOptions = {
  poolKey: string;
  logPrefix: string;
  spawn: AcpCliSpawnSpec;
  appVersion: string;
  afterInitialize?: (args: {
    connection: ClientSideConnection;
    initResult: InitializeResponse;
  }) => Promise<void>;
};

export type AcpCliPooled = {
  connection: ClientSideConnection;
  bridge: AcpHostBridge;
  terminals: Map<string, AcpHostTermState>;
  dispose: () => void;
};

const pools = new Map<string, { ref: number; pooled: AcpCliPooled }>();
/** In-flight initialization per pool key — concurrent acquires share one spawn + handshake. */
const pendingInit = new Map<string, Promise<void>>();
const pendingInitProcesses = new Map<string, ChildProcessWithoutNullStreams>();
let poolEpoch = 0;

const STDERR_LOG_MAX = 8_192;
const ACP_CLI_ACQUIRE_MAX_ATTEMPTS = 12;
const ACP_CLI_ACQUIRE_RETRY_BACKOFF_MS = 25;

function killProcQuiet(proc: ChildProcessWithoutNullStreams | null): void {
  if (!proc) return;
  try {
    signalChildProcessTree(proc, "SIGKILL");
  } catch {
    // ignore
  }
  destroyChildProcessStreams(proc);
}

function evictPoolEntry(poolKey: string, reason: string, err?: unknown): void {
  const entry = pools.get(poolKey);
  if (!entry) return;
  console.error(
    `${reason} for poolKey=${poolKey}:`,
    err instanceof Error ? err.message : err ?? "",
  );
  try {
    entry.pooled.dispose();
  } catch {
    // ignore
  }
  pools.delete(poolKey);
}

export async function acquireAcpCliConnection(options: AcpCliPoolOptions): Promise<AcpCliPooled> {
  const key = options.poolKey;
  const initEpoch = poolEpoch;

  for (let attempt = 0; attempt < ACP_CLI_ACQUIRE_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, ACP_CLI_ACQUIRE_RETRY_BACKOFF_MS));
    }

    const existing = pools.get(key);
    if (existing) {
      existing.ref += 1;
      return existing.pooled;
    }

    let initOwner = false;
    let init = pendingInit.get(key);
    if (!init) {
      initOwner = true;
      init = (async () => {
        let proc: ChildProcessWithoutNullStreams | null = null;
        const stderrChunks: Buffer[] = [];
        const appendStderr = (d: Buffer | string): void => {
          const buf = Buffer.isBuffer(d) ? d : Buffer.from(String(d), "utf8");
          stderrChunks.push(buf);
          let total = 0;
          for (const c of stderrChunks) total += c.length;
          while (total > STDERR_LOG_MAX && stderrChunks.length > 1) {
            total -= stderrChunks.shift()!.length;
          }
        };

        try {
          proc = spawn(options.spawn.command, options.spawn.args, {
            stdio: ["pipe", "pipe", "pipe"],
            env: options.spawn.env ?? { ...process.env },
            cwd: options.spawn.cwd,
            detached: process.platform !== "win32",
          });
          pendingInitProcesses.set(key, proc);

          let failureHandled = false;
          const onProcFailure = (label: string, err?: unknown) => {
            if (failureHandled) return;
            failureHandled = true;
            const tail = Buffer.concat(stderrChunks).toString("utf8").trim();
            if (tail) {
              console.error(`${options.logPrefix} ${label} stderr (tail) poolKey=${key}:`, tail);
            }
            killProcQuiet(proc);
            evictPoolEntry(key, `${options.logPrefix} ${label}`, err);
          };

          proc.once("error", (err) => {
            onProcFailure("process error", err);
          });
          proc.once("close", (code, signal) => {
            if (!pools.has(key)) return;
            onProcFailure(`process closed code=${code} signal=${signal}`);
          });

          proc.stderr?.on("data", appendStderr);

          const terminals = new Map<string, AcpHostTermState>();
          const bridge: AcpHostBridge = {
            onPermission: null,
            onSessionUpdate: null,
            getRootPath: () => options.spawn.cwd || "",
            getDirtyFileText: null,
            onTerminalOutputDelta: null,
            flushTerminalOutput: null,
            onTerminalDisposed: null,
          };

          const client = createAcpHostClient(bridge, terminals, { logPrefix: options.logPrefix });
          const toAgentStdin = Writable.toWeb(proc.stdin as Writable);
          const fromAgentStdout = Readable.toWeb(proc.stdout as Readable);
          const stream = ndJsonStream(
            toAgentStdin as unknown as WritableStream<Uint8Array>,
            fromAgentStdout as unknown as ReadableStream<Uint8Array>,
          );
          const connection = new ClientSideConnection(() => client, stream);

          const initResult = await connection.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientInfo: { name: "ade", title: "ADE", version: options.appVersion },
            clientCapabilities: {
              fs: { readTextFile: true, writeTextFile: true },
              terminal: true,
            },
          });

          if (options.afterInitialize) {
            await options.afterInitialize({ connection, initResult });
          }

          const pooled: AcpCliPooled = {
            connection,
            bridge,
            terminals,
            dispose: () => {
              for (const termId of terminals.keys()) {
                bridge.onTerminalDisposed?.(termId);
              }
              for (const t of terminals.values()) {
                try {
                  if (!t.exited) signalChildProcessTree(t.proc, "SIGKILL");
                } catch {
                  // ignore
                }
                destroyChildProcessStreams(t.proc);
              }
              terminals.clear();
              try {
                if (proc) {
                  terminateChildProcessTree(proc, null, 1_500);
                }
              } catch {
                // ignore
              }
            },
          };

          if (initEpoch !== poolEpoch) {
            throw new Error("acpCliPool shutdown during initialization");
          }
          pools.set(key, { ref: 1, pooled });
        } catch (err) {
          const tail = Buffer.concat(stderrChunks).toString("utf8").trim();
          if (tail) {
            console.error(`${options.logPrefix} init failed stderr (tail) poolKey=${key}:`, tail);
          }
          killProcQuiet(proc);
          evictPoolEntry(key, `${options.logPrefix} initialization failed`, err);
          throw err;
        } finally {
          pendingInitProcesses.delete(key);
        }
      })().finally(() => {
        pendingInit.delete(key);
      });
      pendingInit.set(key, init);
    }

    try {
      await init;
    } catch (err) {
      if (initOwner) throw err;
      continue;
    }

    const entry = pools.get(key);
    if (!entry) {
      continue;
    }
    if (!initOwner) {
      entry.ref += 1;
    }
    return entry.pooled;
  }

  throw new Error(
    `acpCliPool: exceeded ${ACP_CLI_ACQUIRE_MAX_ATTEMPTS} acquire attempts for poolKey=${key} (init or pool entry never became ready).`,
  );
}

export function releaseAcpCliConnection(poolKey: string): void {
  const entry = pools.get(poolKey);
  if (!entry) return;
  entry.ref -= 1;
  if (entry.ref <= 0) {
    entry.pooled.dispose();
    pools.delete(poolKey);
  }
}

/** True when the inner ACP pool still holds a live connection for this key (not evicted after process exit). */
export function hasActiveAcpCliPoolEntry(poolKey: string): boolean {
  return pools.has(poolKey);
}

export function shutdownAcpCliConnections(): void {
  poolEpoch += 1;
  for (const entry of pools.values()) {
    try {
      entry.pooled.dispose();
    } catch {
      // ignore
    }
  }
  pools.clear();
  for (const proc of pendingInitProcesses.values()) {
    killProcQuiet(proc);
  }
  pendingInitProcesses.clear();
  pendingInit.clear();
}
