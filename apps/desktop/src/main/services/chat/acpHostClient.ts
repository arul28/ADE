import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
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
  type Client,
} from "@agentclientprotocol/sdk";
import {
  hasNullByte,
  readFileWithinRootSecure,
  resolvePathWithinRoot,
  secureWriteTextAtomicWithinRoot,
} from "../shared/utils";

/** Bridge hooks for an ACP host (Cursor agent, Droid exec, etc.). */
export type AcpHostBridge = {
  onPermission: ((req: RequestPermissionRequest) => Promise<RequestPermissionResponse>) | null;
  onSessionUpdate: ((n: SessionNotification) => void) | null;
  getRootPath: () => string;
  getDirtyFileText: ((absPath: string) => string | undefined | Promise<string | undefined>) | null;
  onTerminalOutputDelta: ((terminalId: string, acpSessionId: string) => void) | null;
  flushTerminalOutput: ((terminalId: string, acpSessionId: string) => void) | null;
  onTerminalDisposed: ((terminalId: string) => void) | null;
};

export type AcpHostTermState = {
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

function appendOutput(state: AcpHostTermState, chunk: Buffer | string): void {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  state.output += text;
  const lim = state.limit > 0 ? state.limit : 512 * 1024;
  if (state.output.length > lim) {
    state.output = state.output.slice(state.output.length - lim);
    state.truncated = true;
  }
}

function applyLineLimit(text: string, line?: number | null, limit?: number | null): string {
  const lines = text.split(/\r?\n/);
  const start = typeof line === "number" && line > 0 ? line - 1 : 0;
  const max = typeof limit === "number" && limit > 0 ? limit : lines.length;
  return lines.slice(start, start + max).join("\n");
}

async function resolveDirtyText(
  bridge: AcpHostBridge,
  filePath: string,
): Promise<string | undefined> {
  const raw = bridge.getDirtyFileText?.(filePath);
  const v = await Promise.resolve(raw);
  return typeof v === "string" ? v : undefined;
}

export type CreateAcpHostClientOptions = {
  /** Log prefix, e.g. `[CursorAcpPool]` */
  logPrefix: string;
};

const WAIT_FOR_TERMINAL_EXIT_MAX_MS = 5 * 60_000;

/**
 * ACP `Client` implementation shared by Cursor (`agent acp`) and Factory Droid (`droid exec --output-format acp`).
 */
export function createAcpHostClient(
  bridge: AcpHostBridge,
  terminals: Map<string, AcpHostTermState>,
  options: CreateAcpHostClientOptions,
): Client {
  const { logPrefix } = options;
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
      const root = bridge.getRootPath();
      const requested = (params.cwd && params.cwd.trim()) || root;
      let cwd = root;
      try {
        cwd = resolvePathWithinRoot(root, requested, { allowMissing: true });
      } catch (e) {
        console.warn(`${logPrefix} terminal cwd rejected (outside lane root), using root:`, e);
      }
      const termId = randomUUID();
      const limit = typeof params.outputByteLimit === "number" && params.outputByteLimit > 0
        ? params.outputByteLimit
        : 512 * 1024;
      const proc = spawn(params.command, params.args ?? [], {
        cwd,
        env: mergeEnvVars(process.env, params.env ?? undefined),
        shell: process.platform === "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      proc.on("error", (err) => {
        console.error(`${logPrefix} terminal process error for termId=${termId}:`, err);
        const t = terminals.get(termId);
        if (t && !t.exited) {
          t.exited = true;
          t.exitCode = -1;
          bridge.flushTerminalOutput?.(termId, params.sessionId);
        }
      });
      const state: AcpHostTermState = {
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
        await Promise.race([
          new Promise<void>((resolve) => {
            t.proc.once("close", resolve);
          }),
          new Promise<void>((resolve) => {
            setTimeout(() => {
              try {
                if (!t.exited) t.proc.kill("SIGKILL");
              } catch {
                // ignore
              }
              console.warn(
                `${logPrefix} waitForTerminalExit exceeded ${WAIT_FOR_TERMINAL_EXIT_MAX_MS}ms; sent SIGKILL`,
              );
              resolve();
            }, WAIT_FOR_TERMINAL_EXIT_MAX_MS);
          }),
        ]);
        if (!t.exited) {
          await new Promise<void>((resolve) => {
            const tmo = setTimeout(resolve, 15_000);
            t.proc.once("close", () => {
              clearTimeout(tmo);
              resolve();
            });
          });
        }
      }
      return { exitCode: t.exitCode ?? -1, signal: t.exitSignal };
    },

    async killTerminal(params: KillTerminalRequest): Promise<void> {
      const t = terminals.get(params.terminalId);
      if (t && !t.exited) {
        try {
          t.proc.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
    },

    async releaseTerminal(params: ReleaseTerminalRequest): Promise<void> {
      const t = terminals.get(params.terminalId);
      if (t) {
        try {
          if (!t.exited) t.proc.kill("SIGKILL");
        } catch {
          // ignore
        }
        const id = params.terminalId;
        terminals.delete(id);
        bridge.onTerminalDisposed?.(id);
      }
    },
  };
}
