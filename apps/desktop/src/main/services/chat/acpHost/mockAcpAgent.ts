/**
 * A scripted in-process ACP agent, for tests.
 *
 * The mock is a fake `ChildProcessWithoutNullStreams`. It reads NDJSON frames
 * from its stdin, and it writes NDJSON frames to its stdout. So the connection
 * under test exercises its real framing, its real request correlation, and its
 * real notification routing. Only the operating system process is replaced.
 *
 * This is the seed of the `run | degrade` conformance harness in the spec. A
 * behavior is scripted with `on(method, handler)`. A method with no handler
 * answers `-32601`, which is exactly what a real agent that lacks the method
 * does. So a "gracefully absent" test needs no extra setup: leave the method
 * unscripted and assert the host degrades instead of hanging.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  ACP_PROTOCOL_VERSION,
  ACP_RPC_METHOD_NOT_FOUND,
  type AcpAgentCapabilities,
  type AcpAuthMethod,
  type AcpSessionNotification,
  type AcpSessionUpdate,
} from "./acpProtocolTypes";

export type MockAcpHandlerResult =
  | { result: unknown }
  | { error: { code: number; message: string; data?: unknown } };

export type MockAcpHandler = (
  params: unknown,
  context: MockAcpAgent,
) => MockAcpHandlerResult | Promise<MockAcpHandlerResult>;

export type MockAcpAgentOptions = {
  agentCapabilities?: AcpAgentCapabilities;
  authMethods?: AcpAuthMethod[];
  /** Emit a banner line on stdout before the first frame, like some real CLIs. */
  bannerLine?: string;
  /** Text to write to stderr at start. */
  stderrLine?: string;
};

export type MockAcpAgent = {
  /** Pass this to `createAcpConnection({ spawnOverride })`. */
  child: ChildProcessWithoutNullStreams;
  /** Register a request handler. Replaces any earlier one. */
  on(method: string, handler: MockAcpHandler): void;
  /** Drop a handler, so the method answers -32601 again. */
  off(method: string): void;
  /** Every request frame the agent received, in order. */
  readonly received: Array<{ method: string; params: unknown; isNotification: boolean }>;
  /** Methods received, in order. Convenience for assertions. */
  methodsReceived(): string[];
  /** Send a `session/update` notification. */
  emitUpdate(sessionId: string, update: AcpSessionUpdate): void;
  /** Send any notification. */
  emitNotification(method: string, params: unknown): void;
  /** Send an agent-to-client request and resolve with the client's answer. */
  callClient<TResult = unknown>(method: string, params: unknown): Promise<TResult>;
  /** Write raw text to stdout. Used for malformed-frame tests. */
  writeRaw(text: string): void;
  /** End the process with a code. */
  exit(code: number): void;
  /** Resolves after the agent has seen a request for `method`. */
  waitForMethod(method: string, timeoutMs?: number): Promise<unknown>;
};

class MockChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number | null = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  kill(signal?: NodeJS.Signals | number): boolean {
    if (this.exitCode !== null) return false;
    this.killed = true;
    this.signalCode = (typeof signal === "string" ? signal : "SIGTERM") as NodeJS.Signals;
    queueMicrotask(() => {
      if (this.exitCode !== null) return;
      this.exitCode = null;
      this.emit("exit", null, this.signalCode);
    });
    return true;
  }
}

export function createMockAcpAgent(options: MockAcpAgentOptions = {}): MockAcpAgent {
  const child = new MockChildProcess();
  const handlers = new Map<string, MockAcpHandler>();
  const received: Array<{ method: string; params: unknown; isNotification: boolean }> = [];
  const methodWaiters = new Map<string, Array<(params: unknown) => void>>();
  const clientCalls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextClientCallId = 1_000;

  const write = (frame: Record<string, unknown>) => {
    child.stdout.write(`${JSON.stringify(frame)}\n`);
  };

  const agent: MockAcpAgent = {
    child: child as unknown as ChildProcessWithoutNullStreams,
    on: (method, handler) => {
      handlers.set(method, handler);
    },
    off: (method) => {
      handlers.delete(method);
    },
    received,
    methodsReceived: () => received.map((entry) => entry.method),
    emitUpdate: (sessionId, update) => {
      const params: AcpSessionNotification = { sessionId, update };
      write({ jsonrpc: "2.0", method: "session/update", params });
    },
    emitNotification: (method, params) => {
      write({ jsonrpc: "2.0", method, params });
    },
    callClient: <TResult = unknown>(method: string, params: unknown) =>
      new Promise<TResult>((resolve, reject) => {
        const id = nextClientCallId++;
        clientCalls.set(id, { resolve: (value) => resolve(value as TResult), reject });
        write({ jsonrpc: "2.0", id, method, params });
      }),
    writeRaw: (text) => {
      child.stdout.write(text);
    },
    exit: (code) => {
      if (child.exitCode !== null) return;
      child.exitCode = code;
      child.emit("exit", code, null);
    },
    waitForMethod: (method, timeoutMs = 2_000) =>
      new Promise((resolve, reject) => {
        const already = received.find((entry) => entry.method === method);
        if (already) {
          resolve(already.params);
          return;
        }
        const waiters = methodWaiters.get(method) ?? [];
        waiters.push(resolve);
        methodWaiters.set(method, waiters);
        const timer = setTimeout(() => {
          reject(new Error(`mock agent never received ${method} within ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      }),
  };

  // Default handlers. `initialize` must always work, or nothing else can run.
  handlers.set("initialize", () => ({
    result: {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: options.agentCapabilities ?? {
        loadSession: true,
        promptCapabilities: { image: true },
        mcpCapabilities: { http: true, sse: true },
        sessionCapabilities: { resume: {}, close: {}, list: {} },
      },
      ...(options.authMethods ? { authMethods: options.authMethods } : {}),
      agentInfo: { name: "mock-acp-agent", version: "0.0.0" },
    },
  }));

  let buffer = "";
  child.stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (!line.length) continue;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      const id = frame.id as number | string | undefined;
      const method = typeof frame.method === "string" ? frame.method : null;

      if (!method && id !== undefined) {
        // A response to an agent-to-client request.
        const waiter = clientCalls.get(id as number);
        if (!waiter) continue;
        clientCalls.delete(id as number);
        const error = frame.error as { message?: string } | undefined;
        if (error) waiter.reject(new Error(error.message ?? "client error"));
        else waiter.resolve(frame.result);
        continue;
      }
      if (!method) continue;

      received.push({ method, params: frame.params, isNotification: id === undefined });
      const waiters = methodWaiters.get(method);
      if (waiters?.length) {
        methodWaiters.delete(method);
        for (const waiter of waiters) waiter(frame.params);
      }

      if (id === undefined) continue; // Notification. No answer.

      const handler = handlers.get(method);
      if (!handler) {
        write({
          jsonrpc: "2.0",
          id,
          error: { code: ACP_RPC_METHOD_NOT_FOUND, message: `mock agent has no ${method}` },
        });
        continue;
      }
      void (async () => {
        try {
          const outcome = await handler(frame.params, agent);
          if ("error" in outcome) write({ jsonrpc: "2.0", id, error: outcome.error });
          else write({ jsonrpc: "2.0", id, result: outcome.result });
        } catch (error) {
          write({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
          });
        }
      })();
    }
  });

  if (options.bannerLine) child.stdout.write(`${options.bannerLine}\n`);
  if (options.stderrLine) child.stderr.write(`${options.stderrLine}\n`);

  return agent;
}

/**
 * A `session/new` handler that answers with a fixed id.
 *
 * Most tests want this. Pass `configOptions` or `modes` when the test is about
 * session configuration.
 */
export function respondWithSession(
  sessionId: string,
  extra: Record<string, unknown> = {},
): MockAcpHandler {
  return () => ({ result: { sessionId, ...extra } });
}
