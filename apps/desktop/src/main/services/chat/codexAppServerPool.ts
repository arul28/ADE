import type { ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

/**
 * One `codex app-server` process serving many Codex chats.
 *
 * The app-server protocol is multi-thread: every thread notification and
 * server request carries its `threadId`. Chats whose process would be launched
 * identically (same Codex build, account, env apart from the chat's own
 * identity, notification opt-outs) share one process here, and each chat
 * keeps its own per-thread state in its own `CodexRuntime`. A chat's identity
 * (`ADE_CHAT_SESSION_ID`, lane, parent, ...) travels with its thread as
 * `shell_environment_policy.set`, so the agent's shell commands still see it.
 *
 * Measured on Codex 0.162.1 (2026-10-20): each extra app-server process costs
 * ~90 MB footprint plus a code-mode host; an extra thread in a shared process
 * costs ~10 MB.
 *
 * The host is transport only. It allocates request ids, routes responses to
 * the request's owner, routes thread-scoped lines to the chat that owns the
 * thread, broadcasts process-wide notifications, and fans process exit out to
 * every attached chat. The process exits when its last chat detaches.
 */

export type CodexAppServerLine = {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

export type CodexAppServerClient = {
  /** Whose lines these are, for logs. */
  readonly label: string;
  /** True for this client's own thread and for subagent threads it registered. */
  ownsThread(threadId: string): boolean;
  /** True while this client has no thread yet (its thread/start is in flight). */
  awaitingThread(): boolean;
  /** A notification or server request for this client. */
  deliver(line: CodexAppServerLine): void;
  onProcessError(error: Error): void;
  onProcessExit(code: number | null, signal: NodeJS.Signals | null): void;
};

export type CodexAppServerHost = {
  readonly process: ChildProcessWithoutNullStreams;
  readonly reader: readline.Interface;
  /** Null for a process that serves exactly one runtime and is never shared. */
  readonly key: string | null;
  nextRequestId(): number;
  /** Routes the response to request `id` back to `owner`'s handler. */
  expectResponse(id: number, owner: CodexAppServerClient, onResponse: (line: CodexAppServerLine) => void): void;
  forgetResponse(id: number): void;
  write(line: CodexAppServerLine): boolean;
  /** A request owned by the host itself, not by any chat (initialize, a detaching chat's unsubscribe). */
  request<T = unknown>(method: string, params: unknown, timeoutMs: number): Promise<T>;
  /** `initialize` + `initialized`, once per process; later chats reuse the first answer. */
  initialize<T = unknown>(params: unknown, timeoutMs: number): Promise<T>;
  /**
   * Resolves true once Codex reports `thread/closed` for the thread (it has
   * unloaded it and released its writer lock), false after `timeoutMs`.
   * Register before the request that unloads it.
   */
  waitForThreadClosed(threadId: string, timeoutMs: number): Promise<boolean>;
  attach(client: CodexAppServerClient): void;
  /**
   * Removes the client; the process is stopped when it was the last one.
   * Lines for `releasedThreadIds` are dropped from then on (until a chat owns
   * the thread again), so a late line of the leaving chat never reaches
   * another one. Returns how many clients remain.
   */
  detach(client: CodexAppServerClient, releasedThreadIds?: readonly string[]): number;
  clientCount(): number;
  /** True once the process has exited or failed to start. */
  isGone(): boolean;
  /** Stops the process now; every attached chat hears the exit. */
  kill(): void;
};

export type CodexAppServerPool = {
  /** A shared host for `key`, or a new process. `key: null` always starts a private process. */
  acquire(args: { key: string | null; spawn: () => ChildProcessWithoutNullStreams }): CodexAppServerHost;
  /** Live shared processes, for logs. */
  size(): number;
};

/** Process-wide notifications a later chat would have seen at its own process's startup. */
const REPLAYED_STARTUP_METHODS = new Set(["configWarning", "deprecationNotice"]);
const REPLAYED_STARTUP_MAX = 16;
/** How long a line for a thread nobody owns yet waits for its chat's thread/start to return. */
const UNCLAIMED_THREAD_LINE_TTL_MS = 10_000;
const UNCLAIMED_THREAD_LINE_MAX = 500;
const ORPHANED_THREAD_UNSUBSCRIBE_TIMEOUT_MS = 10_000;

export function createCodexAppServerPool(args: {
  /** Stops the process tree (SIGTERM, then SIGKILL); returns the escalation timer. */
  terminate: (process: ChildProcessWithoutNullStreams, previousTimer: NodeJS.Timeout | null) => NodeJS.Timeout | null;
  threadIdOf: (params: unknown) => string | undefined;
  parseLine: (raw: string) => CodexAppServerLine | null;
  onStderr: (text: string, clients: readonly CodexAppServerClient[]) => void;
  logger?: { debug?: (event: string, data: Record<string, unknown>) => void; warn: (event: string, data: Record<string, unknown>) => void };
}): CodexAppServerPool {
  const shared = new Map<string, CodexAppServerHost>();

  const createHost = (key: string | null, proc: ChildProcessWithoutNullStreams): CodexAppServerHost => {
    const reader = readline.createInterface({ input: proc.stdout });
    const clients: CodexAppServerClient[] = [];
    type ResponseRoute = { owner: CodexAppServerClient | null; onResponse: (line: CodexAppServerLine) => void };
    const responseRoutes = new Map<string, ResponseRoute>();
    const replayed: CodexAppServerLine[] = [];
    const releasedThreadIds = new Set<string>();
    const closeWaiters = new Map<string, Set<(closed: boolean) => void>>();
    const settleCloseWaiters = (threadId: string | null, closed: boolean) => {
      for (const [id, waiters] of [...closeWaiters]) {
        if (threadId != null && id !== threadId) continue;
        closeWaiters.delete(id);
        for (const waiter of waiters) waiter(closed);
      }
    };
    let unclaimed: Array<{ threadId: string; line: CodexAppServerLine; at: number }> = [];
    let unclaimedFlushTimer: NodeJS.Timeout | null = null;
    let requestCounter = 1;
    let killTimer: NodeJS.Timeout | null = null;
    let gone = false;
    let initializePromise: Promise<unknown> | null = null;

    const forgetShared = () => {
      if (key != null && shared.get(key) === host) shared.delete(key);
    };

    const write = (line: CodexAppServerLine): boolean => {
      if (gone || !proc.stdin.writable) return false;
      proc.stdin.write(`${JSON.stringify(line)}\n`);
      return true;
    };

    const ownerOf = (threadId: string): CodexAppServerClient | null =>
      clients.find((client) => client.ownsThread(threadId)) ?? null;

    const refuseServerRequest = (line: CodexAppServerLine, threadId: string | null) => {
      if (line.id == null) return;
      write({ id: line.id, error: { code: -32001, message: "No ADE chat owns this Codex thread." } });
      args.logger?.warn("agent_chat.codex_shared_unowned_server_request", { method: line.method ?? null, threadId });
    };

    const dropUnowned = (threadId: string, line: CodexAppServerLine) => {
      if (line.id != null) {
        refuseServerRequest(line, threadId);
        return;
      }
      args.logger?.debug?.("agent_chat.codex_shared_unowned_thread_line", { method: line.method ?? null, threadId });
    };

    /** Delivers held lines whose thread has an owner now, in arrival order; drops expired ones. */
    const flushUnclaimed = (onlyThreadId?: string) => {
      if (!unclaimed.length) return;
      const now = Date.now();
      const anyAwaiting = clients.some((client) => client.awaitingThread());
      const keep: typeof unclaimed = [];
      for (const entry of unclaimed) {
        if (onlyThreadId && entry.threadId !== onlyThreadId) {
          keep.push(entry);
          continue;
        }
        const owner = ownerOf(entry.threadId);
        if (owner) owner.deliver(entry.line);
        else if (anyAwaiting && now - entry.at < UNCLAIMED_THREAD_LINE_TTL_MS) keep.push(entry);
        else dropUnowned(entry.threadId, entry.line);
      }
      unclaimed = keep;
      if (unclaimed.length) scheduleUnclaimedFlush();
    };

    const scheduleUnclaimedFlush = () => {
      if (unclaimedFlushTimer) return;
      unclaimedFlushTimer = setTimeout(() => {
        unclaimedFlushTimer = null;
        flushUnclaimed();
      }, 50);
      unclaimedFlushTimer.unref?.();
    };

    const routeThreadLine = (threadId: string, line: CodexAppServerLine) => {
      if (line.method === "thread/closed") settleCloseWaiters(threadId, true);
      if (unclaimed.some((entry) => entry.threadId === threadId)) flushUnclaimed(threadId);
      const owner = ownerOf(threadId);
      if (owner) {
        releasedThreadIds.delete(threadId);
        owner.deliver(line);
        return;
      }
      if (releasedThreadIds.has(threadId)) {
        if (line.method === "thread/closed") releasedThreadIds.delete(threadId);
        dropUnowned(threadId, line);
        return;
      }
      // A process with one chat behaves exactly as an unshared one: the chat's
      // own handler decides what a foreign thread's line means.
      if (clients.length === 1) {
        clients[0]!.deliver(line);
        return;
      }
      // A thread/start answers after the new thread's first notifications;
      // hold them until the chat that started it records the thread id.
      if (clients.some((client) => client.awaitingThread()) && unclaimed.length < UNCLAIMED_THREAD_LINE_MAX) {
        unclaimed.push({ threadId, line, at: Date.now() });
        scheduleUnclaimedFlush();
        return;
      }
      dropUnowned(threadId, line);
    };

    reader.on("line", (raw) => {
      const line = args.parseLine(raw);
      if (!line) return;
      if (line.method == null) {
        if (line.id == null) return;
        const key = String(line.id);
        const route = responseRoutes.get(key);
        if (!route) return;
        responseRoutes.delete(key);
        route.onResponse(line);
        // The caller records its thread id once its thread/start resolves.
        if (unclaimed.length) setImmediate(() => flushUnclaimed());
        return;
      }
      const threadId = args.threadIdOf(line.params);
      if (threadId) {
        routeThreadLine(threadId, line);
        return;
      }
      if (line.id != null) {
        // Server requests without a thread (auth token refresh, attestation):
        // every chat on this process shares the account, so any one answers.
        const first = clients[0];
        if (first) first.deliver(line);
        else refuseServerRequest(line, null);
        return;
      }
      if (REPLAYED_STARTUP_METHODS.has(line.method) && replayed.length < REPLAYED_STARTUP_MAX) replayed.push(line);
      for (const client of [...clients]) client.deliver(line);
    });

    // A write racing the process's exit fails with EPIPE; without a listener
    // that error would be thrown in the brain. The exit handler settles the chats.
    proc.stdin.on("error", (error) => {
      args.logger?.warn("agent_chat.codex_shared_stdin_error", {
        pid: proc.pid ?? null,
        chats: clients.length,
        error: error.message,
      });
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text.length) args.onStderr(text, clients);
    });

    const settleHostRequests = (message: string) => {
      for (const [id, route] of [...responseRoutes]) {
        if (route.owner) continue;
        responseRoutes.delete(id);
        route.onResponse({ id, error: { message } });
      }
    };

    proc.on("error", (error) => {
      gone = true;
      forgetShared();
      settleHostRequests(`Codex app-server failed to start: ${error.message}`);
      for (const client of [...clients]) client.onProcessError(error);
    });

    proc.on("exit", (code, signal) => {
      gone = true;
      forgetShared();
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (unclaimedFlushTimer) {
        clearTimeout(unclaimedFlushTimer);
        unclaimedFlushTimer = null;
      }
      unclaimed = [];
      // A process that is gone holds no thread.
      settleCloseWaiters(null, true);
      settleHostRequests(`Codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`);
      for (const client of [...clients]) client.onProcessExit(code, signal);
    });

    const request = <T,>(method: string, params: unknown, timeoutMs: number): Promise<T> => {
      const id = requestCounter++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          responseRoutes.delete(String(id));
          reject(new Error(`Codex request '${method}' timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
        timer.unref?.();
        responseRoutes.set(String(id), {
          owner: null,
          onResponse: (line) => {
            clearTimeout(timer);
            if (line.error) reject(new Error(line.error.message || "Codex request failed."));
            else resolve(line.result as T);
          },
        });
        if (!write({ id, method, ...(params !== undefined ? { params } : {}) })) {
          clearTimeout(timer);
          responseRoutes.delete(String(id));
          reject(new Error("Codex app-server stdin is not writable."));
        }
      });
    };

    const host: CodexAppServerHost = {
      process: proc,
      reader,
      key,
      nextRequestId: () => requestCounter++,
      expectResponse: (id, owner, onResponse) => {
        responseRoutes.set(String(id), { owner, onResponse });
      },
      forgetResponse: (id) => {
        responseRoutes.delete(String(id));
      },
      write,
      request,
      initialize: <T,>(params: unknown, timeoutMs: number): Promise<T> => {
        if (!initializePromise) {
          initializePromise = request("initialize", params, timeoutMs).then((result) => {
            write({ method: "initialized" });
            return result;
          });
          // A process that cannot initialize serves nobody.
          initializePromise.catch(() => host.kill());
        }
        return initializePromise as Promise<T>;
      },
      waitForThreadClosed: (threadId, timeoutMs) => new Promise<boolean>((resolve) => {
        if (gone) {
          resolve(true);
          return;
        }
        const timer = setTimeout(() => {
          closeWaiters.get(threadId)?.delete(finish);
          resolve(false);
        }, timeoutMs);
        timer.unref?.();
        function finish(closed: boolean) {
          clearTimeout(timer);
          resolve(closed);
        }
        const waiters = closeWaiters.get(threadId) ?? new Set<(closed: boolean) => void>();
        waiters.add(finish);
        closeWaiters.set(threadId, waiters);
      }),
      attach: (client) => {
        if (clients.includes(client)) return;
        clients.push(client);
        for (const line of replayed) client.deliver(line);
      },
      detach: (client, released = []) => {
        const index = clients.indexOf(client);
        if (index >= 0) clients.splice(index, 1);
        for (const threadId of released) releasedThreadIds.add(threadId);
        if (clients.length === 0) {
          for (const [id, route] of [...responseRoutes]) {
            if (route.owner === client) responseRoutes.delete(id);
          }
          host.kill();
          return 0;
        }
        // A request the chat left in flight still runs here. One that loaded
        // a thread (thread/start, resume, fork) subscribed this connection to
        // it, and nobody else will unsubscribe it.
        for (const route of responseRoutes.values()) {
          if (route.owner !== client) continue;
          route.owner = null;
          route.onResponse = (line) => {
            const thread = line.result && typeof line.result === "object"
              ? (line.result as { thread?: { id?: unknown } }).thread
              : undefined;
            if (typeof thread?.id !== "string" || !thread.id) return;
            releasedThreadIds.add(thread.id);
            request("thread/unsubscribe", { threadId: thread.id }, ORPHANED_THREAD_UNSUBSCRIBE_TIMEOUT_MS).catch((error: unknown) => {
              args.logger?.warn("agent_chat.codex_shared_orphan_unsubscribe_failed", {
                threadId: thread.id,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          };
        }
        return clients.length;
      },
      clientCount: () => clients.length,
      isGone: () => gone,
      kill: () => {
        forgetShared();
        if (gone) return;
        try { reader.close(); } catch { /* ignore */ }
        killTimer = args.terminate(proc, killTimer);
      },
    };
    return host;
  };

  return {
    acquire: ({ key, spawn }) => {
      if (key != null) {
        const existing = shared.get(key);
        if (existing && existing.process.exitCode == null && existing.process.stdin.writable) return existing;
        if (existing) shared.delete(key);
      }
      const host = createHost(key, spawn());
      if (key != null) shared.set(key, host);
      return host;
    },
    size: () => shared.size,
  };
}
