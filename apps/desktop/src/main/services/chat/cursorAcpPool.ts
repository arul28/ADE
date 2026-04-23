import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type CreateTerminalRequest,
  type KillTerminalRequest,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type ReleaseTerminalRequest,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type TerminalOutputRequest,
  type TerminalOutputResponse,
  type WaitForTerminalExitRequest,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { hasNullByte, readFileWithinRootSecure, secureWriteTextAtomicWithinRoot } from "../shared/utils";
import { resolveCliSpawnInvocation, terminateProcessTree } from "../shared/processExecution";

export type CursorAcpBridge = {
  onPermission: ((req: RequestPermissionRequest) => Promise<RequestPermissionResponse>) | null;
  onSessionUpdate: ((n: SessionNotification) => void) | null;
  getRootPath: () => string;
  getDirtyFileText: ((absPath: string) => string | undefined | Promise<string | undefined>) | null;
  /** Fired after stdout/stderr appends — used to stream shell output into chat. */
  onTerminalOutputDelta: ((terminalId: string, acpSessionId: string) => void) | null;
  /** Flush debounced terminal streaming (e.g. on process exit). */
  flushTerminalOutput: ((terminalId: string, acpSessionId: string) => void) | null;
  onTerminalDisposed: ((terminalId: string) => void) | null;
};

type TermState = {
  proc: ChildProcessWithoutNullStreams;
  output: string;
  truncated: boolean;
  limit: number;
  cwd: string;
  command: string;
  exited: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  acpSessionId: string;
};

function mergeEnvVars(
  base: NodeJS.ProcessEnv,
  extra?: Array<{ name: string; value: string }>,
): NodeJS.ProcessEnv {
  const out = { ...base };
  if (!extra) return out;
  for (const { name, value } of extra) {
    if (name) out[name] = value;
  }
  return out;
}

function appendOutput(state: TermState, chunk: Buffer | string): void {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  state.output += text;
  const lim = state.limit > 0 ? state.limit : 512 * 1024;
  if (state.output.length > lim) {
    state.output = state.output.slice(state.output.length - lim);
    state.truncated = true;
  }
}

async function resolveDirtyText(
  bridge: CursorAcpBridge,
  filePath: string,
): Promise<string | undefined> {
  const raw = bridge.getDirtyFileText?.(filePath);
  const v = await Promise.resolve(raw);
  return typeof v === "string" ? v : undefined;
}

function createCursorAcpClient(bridge: CursorAcpBridge, terminals: Map<string, TermState>): Client {
  return {
    async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      const handler = bridge.onPermission;
      if (!handler) {
        return { outcome: { outcome: "cancelled" } };
      }
      return handler(params);
    },

    async sessionUpdate(params: SessionNotification): Promise<void> {
      bridge.onSessionUpdate?.(params);
    },

    async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
      const p = params.path.trim();
      if (!path.isAbsolute(p)) {
        throw new Error("ACP read_text_file requires an absolute path.");
      }
      const root = bridge.getRootPath();
      let buf: Buffer;
      try {
        buf = readFileWithinRootSecure(root, p);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err?.code === "ENOENT") {
          const dirty = await resolveDirtyText(bridge, p);
          if (dirty !== undefined) return { content: applyLineLimit(dirty, params.line, params.limit) };
        }
        throw e;
      }
      if (hasNullByte(buf)) {
        throw new Error("Binary files cannot be read as text.");
      }
      let text = buf.toString("utf8");
      const dirty = await resolveDirtyText(bridge, p);
      if (dirty !== undefined) text = dirty;
      return { content: applyLineLimit(text, params.line, params.limit) };
    },

    async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
      const p = params.path.trim();
      if (!path.isAbsolute(p)) {
        throw new Error("ACP write_text_file requires an absolute path.");
      }
      const root = bridge.getRootPath();
      secureWriteTextAtomicWithinRoot(root, p, params.content);
      return {};
    },

    async createTerminal(params: CreateTerminalRequest): Promise<{ terminalId: string }> {
      const cwd = (params.cwd && params.cwd.trim()) || bridge.getRootPath();
      const termId = randomUUID();
      const limit = typeof params.outputByteLimit === "number" && params.outputByteLimit > 0
        ? params.outputByteLimit
        : 512 * 1024;
      const env = mergeEnvVars(process.env, params.env ?? undefined);
      const invocation = resolveCliSpawnInvocation(params.command, params.args ?? [], env);
      const proc = spawn(invocation.command, invocation.args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });
      proc.on("error", (err) => {
        console.error(`[CursorAcpPool] terminal process error for termId=${termId}:`, err);
        const t = terminals.get(termId);
        if (t && !t.exited) {
          t.exited = true;
          t.exitCode = -1;
          bridge.flushTerminalOutput?.(termId, params.sessionId);
        }
      });
      const state: TermState = {
        proc,
        output: "",
        truncated: false,
        limit,
        cwd,
        command: `${params.command} ${(params.args ?? []).join(" ")}`.trim(),
        exited: false,
        exitCode: null,
        exitSignal: null,
        acpSessionId: params.sessionId,
      };
      proc.stdout?.on("data", (d) => {
        appendOutput(state, d);
        bridge.onTerminalOutputDelta?.(termId, state.acpSessionId);
      });
      proc.stderr?.on("data", (d) => {
        appendOutput(state, d);
        bridge.onTerminalOutputDelta?.(termId, state.acpSessionId);
      });
      proc.on("close", (code, signal) => {
        state.exited = true;
        state.exitCode = code;
        state.exitSignal = signal;
        bridge.flushTerminalOutput?.(termId, state.acpSessionId);
      });
      terminals.set(termId, state);
      return { terminalId: termId };
    },

    async terminalOutput(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
      const t = terminals.get(params.terminalId);
      if (!t) {
        return { output: "", truncated: false };
      }
      return {
        output: t.output,
        truncated: t.truncated,
        ...(t.exited ? { exitStatus: { exitCode: t.exitCode, signal: t.exitSignal } } : {}),
      };
    },

    async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
      const t = terminals.get(params.terminalId);
      if (!t) {
        return { exitCode: -1, signal: null };
      }
      if (!t.exited) {
        await new Promise<void>((resolve) => {
          const done = () => resolve();
          t.proc.once("close", done);
        });
      }
      return { exitCode: t.exitCode ?? -1, signal: t.exitSignal };
    },

    async killTerminal(params: KillTerminalRequest): Promise<void> {
      const t = terminals.get(params.terminalId);
      if (t && !t.exited) {
        terminateProcessTree(t.proc, "SIGTERM");
      }
    },

    async releaseTerminal(params: ReleaseTerminalRequest): Promise<void> {
      const t = terminals.get(params.terminalId);
      if (t) {
        if (!t.exited) terminateProcessTree(t.proc, "SIGKILL");
        const id = params.terminalId;
        terminals.delete(id);
        bridge.onTerminalDisposed?.(id);
      }
    },
  };
}

function applyLineLimit(text: string, line?: number | null, limit?: number | null): string {
  const lines = text.split(/\r?\n/);
  const start = typeof line === "number" && line > 0 ? line - 1 : 0;
  const max = typeof limit === "number" && limit > 0 ? limit : lines.length;
  return lines.slice(start, start + max).join("\n");
}

export type CursorTerminalWorkLogBinding = {
  itemId: string;
  turnId: string;
  command: string;
  cwd: string;
};

export type CursorAcpPooled = {
  connection: ClientSideConnection;
  bridge: CursorAcpBridge;
  terminals: Map<string, TermState>;
  /** Maps ACP terminal id → work chat command row identity for streaming output */
  terminalWorkLogBindings: Map<string, CursorTerminalWorkLogBinding>;
  terminalOutputTimers: Map<string, ReturnType<typeof setTimeout>>;
  dispose: () => void;
};

export type CursorAcpLaunchSettings = {
  mode: "plan" | "ask" | null;
  sandbox: "enabled" | "disabled";
  force: boolean;
};

const pool = new Map<string, { ref: number; pooled: CursorAcpPooled }>();

export async function acquireCursorAcpConnection(args: {
  poolKey: string;
  agentPath: string;
  workspacePath: string;
  modelSdkId: string;
  launchSettings: CursorAcpLaunchSettings;
  appVersion: string;
}): Promise<CursorAcpPooled> {
  const existing = pool.get(args.poolKey);
  if (existing) {
    existing.ref += 1;
    return existing.pooled;
  }

  const spawnArgs = [
    "acp",
    "--workspace",
    args.workspacePath,
    "--model",
    args.modelSdkId,
    "--sandbox",
    args.launchSettings.sandbox,
  ];
  if (args.launchSettings.mode) {
    spawnArgs.push("--mode", args.launchSettings.mode);
  }
  if (args.launchSettings.force) {
    spawnArgs.push("--force");
  }
  const apiKey = process.env.CURSOR_API_KEY?.trim() || process.env.CURSOR_AUTH_TOKEN?.trim();
  if (apiKey) {
    spawnArgs.push("--api-key", apiKey);
  }

  const env = { ...process.env };
  const invocation = resolveCliSpawnInvocation(args.agentPath, spawnArgs, env);
  const proc = spawn(invocation.command, invocation.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env,
    cwd: args.workspacePath,
    detached: process.platform !== "win32",
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });

  proc.on("error", (err) => {
    console.error(`[CursorAcpPool] agent process error for poolKey=${args.poolKey}:`, err);
    const entry = pool.get(args.poolKey);
    if (entry) {
      entry.pooled.dispose();
      pool.delete(args.poolKey);
    }
  });

  const terminals = new Map<string, TermState>();
  const bridge: CursorAcpBridge = {
    onPermission: null,
    onSessionUpdate: null,
    getRootPath: () => "",
    getDirtyFileText: null,
    onTerminalOutputDelta: null,
    flushTerminalOutput: null,
    onTerminalDisposed: null,
  };

  const client = createCursorAcpClient(bridge, terminals);
  const input = Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>;
  const output = Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(input, output);
  const connection = new ClientSideConnection(() => client, stream);

  const init = await connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientInfo: { name: "ade", title: "ADE", version: args.appVersion },
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
  });

  const authMethods = init.authMethods ?? [];
  const needsCursorLogin = authMethods.some((m) => "id" in m && m.id === "cursor_login");
  if (needsCursorLogin && !apiKey) {
    await connection.authenticate({ methodId: "cursor_login" }).catch(() => {
      // Interactive login may fail headless — user should run `agent login`
    });
  }

  const terminalWorkLogBindings = new Map<string, CursorTerminalWorkLogBinding>();
  const terminalOutputTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const pooled: CursorAcpPooled = {
    connection,
    bridge,
    terminals,
    terminalWorkLogBindings,
    terminalOutputTimers,
    dispose: () => {
      for (const termId of terminals.keys()) {
        bridge.onTerminalDisposed?.(termId);
      }
      for (const t of terminals.values()) {
        if (!t.exited) terminateProcessTree(t.proc, "SIGKILL");
      }
      terminals.clear();
      terminateProcessTree(proc, "SIGTERM");
    },
  };

  proc.stderr?.on("data", () => {
    // stderr noise — optional log
  });

  pool.set(args.poolKey, { ref: 1, pooled });
  return pooled;
}

export function releaseCursorAcpConnection(poolKey: string): void {
  const entry = pool.get(poolKey);
  if (!entry) return;
  entry.ref -= 1;
  if (entry.ref <= 0) {
    entry.pooled.dispose();
    pool.delete(poolKey);
  }
}
