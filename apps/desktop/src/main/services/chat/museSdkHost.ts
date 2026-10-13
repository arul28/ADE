/**
 * One `muse serve` host, driven over the Muse Session Protocol (MSP).
 *
 * ADE uses `@muse-code/sdk` for the parts that are easy to get wrong — spawning
 * the host, the `initialize` handshake, NDJSON framing, command-id minting and
 * retry — and nothing above the raw `Connection`. The SDK's `MuseClient` facade
 * claims the connection's single notification handler and only surfaces turns,
 * items and approvals; ADE also needs token usage, context pressure, goals,
 * todos, subagents and the rest of the view stream, so it routes notifications
 * itself, by `sessionId`, the same way the Codex app-server runtime does.
 *
 * Contributor mode is never offered: every host is started with
 * `--contributor-mode off`, because `muse serve` does not honour the saved
 * setting (muse-code-sdk issue, 1.4.6+).
 */
import {
  MspError,
  ProtocolError,
  spawnMspConnection,
  type Connection,
  type SpawnedMspConnection,
} from "@muse-code/sdk";
import type {
  CapabilityName,
  InitializeResult,
} from "@muse-code/sdk/dist/src/msp.js";
import type { Logger } from "../logging/logger";

export type MuseNotification = {
  method: string;
  params: Record<string, unknown>;
};

export type MuseHostExit = {
  /** Why the host ended, in ADE words. */
  kind: "clean" | "crash" | "config" | "auth" | "unknown";
  code: number | null;
  signal: string | null;
  stderrTail: string[];
};

export type MuseHostStartOptions = {
  /** Absolute path of the pinned `muse` binary. */
  musePath: string;
  cwd: string;
  /** Full child environment (it REPLACES the parent's). */
  env: NodeJS.ProcessEnv;
  /** Extra `muse serve` flags after the fixed ones (provider, model, sandbox posture, `-c` settings). */
  serveArgs?: string[];
  clientVersion: string;
  logger?: Pick<Logger, "info" | "warn" | "debug"> | null;
  /**
   * Capabilities to ask for beyond the chat set. Settings asks for Muse's own
   * computer-use setup (`computerUseSetup`, `computerUseHostSetup`); a chat
   * host does not.
   */
  extraCapabilities?: CapabilityName[];
};

export type MuseHost = {
  readonly initializeResult: InitializeResult;
  readonly grantedCapabilities: ReadonlySet<CapabilityName>;
  readonly alive: boolean;
  /** A read-only request (no `commandId`). */
  request<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** A state-changing command; the SDK mints the `commandId` and retries retryable refusals. */
  command<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>,
    options?: { commandId?: string },
  ): Promise<T>;
  /** Mint a command id without sending (for `turn/start`, whose turn id derives from it). */
  mintCommandId(): string;
  /** Notifications for one MSP session. Returns an unsubscribe. */
  subscribe(sessionId: string, handler: (notification: MuseNotification) => void): () => void;
  /** Notifications that carry no `sessionId` (usage, plugin and skill catalog changes). */
  onHostNotification(handler: (notification: MuseNotification) => void): () => void;
  onExit(handler: (exit: MuseHostExit) => void): () => void;
  stderrTail(): string[];
  close(): Promise<void>;
};

/** `clientInfo.name` must match `^[a-z0-9_]+$` (MSP SS1.4.1). */
const MUSE_CLIENT_NAME = "ade";

/**
 * What ADE asks the host for. `sessionMcp` lets ADE attach its own MCP servers
 * to each session; `userShell` backs the composer's `!cmd`. Unknown names are
 * simply not granted, so asking for all of them is safe on older hosts.
 */
const REQUESTED_CAPABILITIES: CapabilityName[] = [
  "sessionMcp",
  "userShell",
  "feedback",
  "sessionListStream",
];

const STDERR_TAIL_LIMIT = 40;

export function museServeBaseArgs(): string[] {
  return ["serve", "--contributor-mode", "off"];
}

function classifyExitKind(stderrTail: readonly string[], code: number | null): MuseHostExit["kind"] {
  if (code === 0) return "clean";
  const text = stderrTail.join("\n").toLowerCase();
  if (/(not logged in|no credential|unauthori[sz]ed|401|login required|api key)/.test(text)) return "auth";
  if (/(invalid configuration|config error|unknown setting|refuse)/.test(text)) return "config";
  return code === null ? "unknown" : "crash";
}

export function describeMuseError(error: unknown): string {
  if (error instanceof MspError) {
    const reason = typeof error.data?.reason === "string" ? ` (${error.data.reason})` : "";
    return `${error.message}${reason}`;
  }
  if (error instanceof ProtocolError) return `Muse sent a reply ADE could not read: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

export function isMuseErrorKind(error: unknown, ...kinds: string[]): boolean {
  return error instanceof MspError && kinds.includes(String(error.kind));
}

export async function startMuseHost(options: MuseHostStartOptions): Promise<MuseHost> {
  const stderr: string[] = [];
  const pushStderr = (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line.trim()) continue;
      stderr.push(line);
      if (stderr.length > STDERR_TAIL_LIMIT) stderr.shift();
    }
  };
  const handshake = spawnMspConnection({
    command: options.musePath,
    args: [...museServeBaseArgs(), ...(options.serveArgs ?? [])],
    cwd: options.cwd,
    env: options.env,
    onStderr: pushStderr,
  });

  const sessionHandlers = new Map<string, Set<(n: MuseNotification) => void>>();
  const hostHandlers = new Set<(n: MuseNotification) => void>();
  const exitHandlers = new Set<(exit: MuseHostExit) => void>();
  let alive = true;
  let closing = false;

  const route = (raw: { method: string; params?: unknown }) => {
    const params = (raw.params && typeof raw.params === "object" ? raw.params : {}) as Record<string, unknown>;
    const notification: MuseNotification = { method: raw.method, params };
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
    if (!sessionId) {
      for (const handler of hostHandlers) handler(notification);
      return;
    }
    const handlers = sessionHandlers.get(sessionId);
    if (!handlers?.size) return;
    for (const handler of handlers) handler(notification);
  };
  handshake.onNotification((n) => route(n as { method: string; params?: unknown }));
  // Approvals and questions arrive as view notifications, and Muse re-issues
  // the still-open ones as server-to-client requests right after a
  // `session/resume` (tdd SS5.6). Those are folded into the same session
  // stream as the notification they mirror; the reply is only a presentation
  // receipt, the decision still travels as `approval/decide` /
  // `userInput/answer`. With nobody subscribed yet the request is refused,
  // which keeps it pending for the next subscribe (ADE also pulls
  // `approval/listPending` once it subscribes). Anything else is refused so
  // the host never waits.
  handshake.onServerRequest(async (request) => {
    const raw = request as { method?: string; params?: unknown };
    const method = raw.method ?? "unknown";
    const mirrored = method === "approval/request"
      ? "approval/requested"
      : method === "userInput/request"
        ? "userInput/requested"
        : null;
    const params = (raw.params && typeof raw.params === "object" ? raw.params : {}) as Record<string, unknown>;
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
    if (mirrored && sessionId && sessionHandlers.get(sessionId)?.size) {
      route({ method: mirrored, params });
      return {};
    }
    options.logger?.warn("agent_chat.muse_unexpected_server_request", { method });
    throw new Error(mirrored
      ? "No ADE chat is attached to this Muse session yet."
      : "ADE does not serve MSP server-to-client requests.");
  });
  handshake.onProtocolError((error) => {
    options.logger?.warn("agent_chat.muse_protocol_error", { message: error.message });
  });

  let spawned: SpawnedMspConnection;
  try {
    spawned = await handshake.initialize({
      clientInfo: { name: MUSE_CLIENT_NAME, version: options.clientVersion },
      capabilities: {
        requestedCapabilities: [...new Set([...REQUESTED_CAPABILITIES, ...(options.extraCapabilities ?? [])])],
        userInputDialogs: true,
      },
    });
  } catch (error) {
    await handshake.close().catch(() => undefined);
    const detail = stderr.slice(-8).join("\n");
    const base = describeMuseError(error);
    throw new Error(detail ? `${base}\n${detail}` : base);
  }
  const connection: Connection = spawned.connection;
  if (spawned.fingerprintWarning) {
    options.logger?.warn("agent_chat.muse_schema_fingerprint_mismatch", {
      pinned: spawned.fingerprintWarning.pinned,
      served: spawned.fingerprintWarning.served,
    });
  }

  void spawned.exited.then((exit) => {
    alive = false;
    const kind = closing ? "clean" : classifyExitKind(stderr, exit.code);
    const payload: MuseHostExit = {
      kind,
      code: exit.code,
      signal: exit.signal ?? null,
      stderrTail: stderr.slice(),
    };
    options.logger?.info("agent_chat.muse_host_exit", {
      kind,
      code: exit.code,
      signal: exit.signal ?? null,
    });
    for (const handler of exitHandlers) handler(payload);
  });

  const granted = new Set<CapabilityName>(spawned.initializeResult.grantedCapabilities ?? []);

  return {
    initializeResult: spawned.initializeResult,
    grantedCapabilities: granted,
    get alive() {
      return alive;
    },
    async request<T>(method: string, params: Record<string, unknown> = {}) {
      return await connection.request(method, params) as T;
    },
    async command<T>(method: string, params: Record<string, unknown>, options?: { commandId?: string }) {
      // The connection stamps `commandId` itself; a caller that needs a known
      // id (turn/start, whose turn id derives from it) passes it here.
      return await connection.command(method, params, options?.commandId ? { commandId: options.commandId } : undefined) as T;
    },
    mintCommandId: () => connection.mintCommandId(),
    subscribe(sessionId, handler) {
      let set = sessionHandlers.get(sessionId);
      if (!set) {
        set = new Set();
        sessionHandlers.set(sessionId, set);
      }
      set.add(handler);
      return () => {
        const current = sessionHandlers.get(sessionId);
        current?.delete(handler);
        if (current && current.size === 0) sessionHandlers.delete(sessionId);
      };
    },
    onHostNotification(handler) {
      hostHandlers.add(handler);
      return () => hostHandlers.delete(handler);
    },
    onExit(handler) {
      exitHandlers.add(handler);
      return () => exitHandlers.delete(handler);
    },
    stderrTail: () => stderr.slice(),
    async close() {
      if (closing) return;
      closing = true;
      await spawned.close().catch(() => undefined);
      alive = false;
    },
  };
}
