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

export async function acquireAcpCliConnection(options: AcpCliPoolOptions): Promise<AcpCliPooled> {
  const existing = pools.get(options.poolKey);
  if (existing) {
    existing.ref += 1;
    return existing.pooled;
  }

  const proc = spawn(options.spawn.command, options.spawn.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: options.spawn.env ?? { ...process.env },
    cwd: options.spawn.cwd,
    detached: process.platform !== "win32",
  });

  proc.on("error", (err) => {
    console.error(`${options.logPrefix} process error for poolKey=${options.poolKey}:`, err);
    const entry = pools.get(options.poolKey);
    if (entry) {
      entry.pooled.dispose();
      pools.delete(options.poolKey);
    }
  });

  const terminals = new Map<string, AcpHostTermState>();
  const bridge: AcpHostBridge = {
    onPermission: null,
    onSessionUpdate: null,
    getRootPath: () => "",
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
          if (!t.exited) t.proc.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
      terminals.clear();
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
    },
  };

  proc.stderr?.on("data", () => {
    // stderr — optional log
  });

  pools.set(options.poolKey, { ref: 1, pooled });
  return pooled;
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
