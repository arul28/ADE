import { ADE_CLIENT_EVENTS, type AdeClientEvent } from "./clientEvents.js";
import type { AdeChatClient } from "./client.js";
import type { ThreadOpenOptions, ThreadResumeOptions } from "./clientOptions.js";
import type { AdeThread, EditLastOptions, HistoryPageOptions, SendOptions, SetModelOptions, SteerOptions, ThreadUpdate, ThreadUpdateOptions } from "./thread.js";
import { AdeError } from "./errors.js";
import type { ApprovalDecision } from "./approvals.js";
import { serializeAdeError } from "./electron/protocol.js";
import type { McpServerConfig, ProviderStatus, ThreadSummary, Unsubscribe } from "./types.js";
import { validateThreadBudget, type ThreadBudget } from "./usage.js";
import { createAdeRemoteClient, type AdeRemoteClient, type AdeRemoteClientOptions, type AdeRemoteTransport, type AdeRemoteThread } from "./remoteClient.js";

export type AdeServerSocket = AdeRemoteTransport;
export type AdeServerContext = { socket: AdeServerSocket };

export type CreateAdeServerOptions = {
  client: AdeChatClient;
  /** Called before every RPC, including custom and unknown methods. */
  authorize?: (socket: AdeServerSocket, method: string, params: Record<string, unknown>) => boolean | Promise<boolean>;
  /** Restrict thread keys at every keyed call and filter list results. */
  allowThreadKey?: (key: string, method: string, params: Record<string, unknown>, socket: AdeServerSocket) => boolean | Promise<boolean>;
  /** Resolve create/resume settings in the trusted host process. */
  openOptions?: (
    key: string,
    rendererOptions: Record<string, unknown> | undefined,
    context: { exists: boolean; summary: ThreadSummary | null },
  ) => ThreadOpenOptions | ThreadResumeOptions | undefined | Promise<ThreadOpenOptions | ThreadResumeOptions | undefined>;
  /** Extra host-owned RPC methods. They share the same authorization gate. */
  methods?: Record<string, (params: Record<string, unknown>, context: AdeServerContext) => unknown | Promise<unknown>>;
  logger?: (line: string) => void;
};

export type AdeServer = {
  /** Attach a host-accepted WebSocket to the bridge. No WebSocket package is loaded by the SDK. */
  handleConnection(socket: AdeServerSocket): Unsubscribe;
  /** Release every listener and connection; the host retains ownership of its client and sockets. */
  close(): void;
};

type SocketThread = { thread: AdeThread; stop: Unsubscribe };

const KEYED_METHODS = new Set([
  "threads.open", "threads.get", "threads.delete", "threads.archive", "threads.unarchive",
  "thread.export", "thread.update", "thread.retry", "thread.editLast", "thread.history",
  "thread.historyPage", "thread.send", "thread.steer", "thread.interrupt", "thread.setModel",
  "thread.approve", "thread.pendingApprovals", "thread.usage", "thread.updateMcpServers", "thread.refreshMcpHeaders",
]);

function asParams(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringify(value: unknown): string {
  try { return JSON.stringify(value); } catch { return "null"; }
}

function safeSend(socket: AdeServerSocket, value: unknown): void {
  try { socket.send(stringify(value)); } catch { /* A close event owns cleanup. */ }
}

function listen(socket: AdeServerSocket, event: "message" | "close", listener: (...args: any[]) => void): Unsubscribe {
  if (typeof socket.addEventListener === "function") {
    socket.addEventListener(event, listener);
    return () => socket.removeEventListener?.(event, listener);
  }
  if (typeof socket.on === "function") {
    socket.on(event, listener);
    return () => {
      if (typeof socket.off === "function") socket.off(event, listener);
      else socket.removeListener?.(event, listener);
    };
  }
  throw new AdeError("invalid_option", "createAdeServer needs a WebSocket-compatible socket.");
}

function parseMessage(raw: unknown): unknown {
  let value = raw;
  if (value && typeof value === "object" && "data" in value) value = (value as { data: unknown }).data;
  return JSON.parse(typeof value === "string" ? value : String(value));
}

function rendererOpenOptions(options: Record<string, unknown> | undefined, exists: boolean): ThreadOpenOptions | ThreadResumeOptions {
  if (exists) return {};
  const input = options ?? {};
  return {
    ...(typeof input.provider === "string" ? { provider: input.provider } : {}),
    ...(typeof input.model === "string" ? { model: input.model } : {}),
    ...(typeof input.title === "string" ? { title: input.title } : {}),
    ...(typeof input.reasoningEffort === "string" ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.budget !== undefined ? { budget: validateThreadBudget(input.budget as ThreadBudget) } : {}),
  } as ThreadOpenOptions;
}

/** Serve the SDK chat client over a host-supplied ws-compatible transport. */
export function createAdeServer(options: CreateAdeServerOptions): AdeServer {
  const { client } = options;
  const sockets = new Set<AdeServerSocket>();
  const cleanups = new Map<AdeServerSocket, Unsubscribe>();
  let closed = false;

  const attach = (socket: AdeServerSocket): Unsubscribe => {
    if (closed) throw new AdeError("disposed", "This ADE server bridge has been closed.");
    const threads = new Map<string, SocketThread>();
    const opening = new Map<string, Promise<AdeThread>>();
    const requestIds = new Set<string | number>();
    let disconnected = false;
    const send = (message: unknown) => { if (!disconnected) safeSend(socket, message); };
    const cleanup = () => {
      if (disconnected) return;
      disconnected = true;
      sockets.delete(socket);
      cleanups.delete(socket);
      stopProvider();
      for (const stop of stopClientEvents) stop();
      for (const entry of threads.values()) entry.stop();
      threads.clear();
      opening.clear();
      detachMessage();
      detachClose();
    };

    const stopProvider = client.providers.onChange((statuses) => send({ push: "providers", statuses }));
    const stopClientEvents: Unsubscribe[] = ADE_CLIENT_EVENTS.map((event) =>
      client.on(event, (payload) => send({ push: "client", event, payload })),
    );

    const ensureThread = async (key: string, rendererOptions?: Record<string, unknown>): Promise<AdeThread> => {
      const existing = threads.get(key)?.thread;
      if (existing) return existing;
      const pending = opening.get(key);
      if (pending) return pending;
      const started = (async () => {
        const summary = await client.threads.get(key);
        const context = { exists: Boolean(summary), summary };
        const resolvedOptions = options.openOptions
          ? await options.openOptions(key, rendererOptions, context)
          : rendererOpenOptions(rendererOptions, context.exists);
        const thread = await client.threads.open(key, resolvedOptions as ThreadResumeOptions);
        const stop = thread.on("event", (envelope) => send({ push: "event", key, envelope }));
        threads.set(key, { thread, stop });
        return thread;
      })().finally(() => opening.delete(key));
      opening.set(key, started);
      return started;
    };

    const requireThread = (key: unknown): AdeThread => {
      if (typeof key !== "string" || !threads.has(key)) {
        throw new AdeError("thread_not_found", "Open the thread through this connection before calling it.");
      }
      return threads.get(key)!.thread;
    };

    const handlers: Record<string, (params: Record<string, unknown>) => unknown | Promise<unknown>> = {
      "providers.status": () => client.providers.status(),
      "providers.refresh": () => client.providers.refresh(),
      "models.list": () => client.models.list(),
      "doctor": () => client.doctor(),
      "threads.open": async ({ key, options: rendererOptions }) => {
        if (typeof key !== "string" || !key.trim()) throw new AdeError("invalid_option", "threads.open needs a non-empty key.");
        const thread = await ensureThread(key, asParams(rendererOptions));
        return {
          id: thread.id,
          key: thread.key,
          title: thread.title,
          model: thread.model,
          mcpCapability: thread.mcpCapability,
          instructionsCapability: thread.instructionsCapability,
          settingSourcesCapability: thread.settingSourcesCapability,
          permissionCapability: thread.permissionCapability,
        };
      },
      "threads.list": async () => {
        const rows = await client.threads.list();
        if (!options.allowThreadKey) return rows;
        const allowed = await Promise.all(rows.map(async (row) =>
          row.key && await options.allowThreadKey!(row.key, "threads.list", { key: row.key }, socket),
        ));
        return rows.filter((_row, index) => allowed[index]);
      },
      "threads.get": async ({ key }) => await client.threads.get(String(key ?? "")),
      "threads.delete": async ({ key }) => { await client.threads.delete(String(key ?? "")); threads.get(String(key))?.stop(); threads.delete(String(key)); return null; },
      "threads.archive": async ({ key }) => { await client.threads.archive(String(key ?? "")); return null; },
      "threads.unarchive": async ({ key }) => { await client.threads.unarchive(String(key ?? "")); return null; },
      "thread.export": ({ key }) => client.exportThread(String(key ?? "")),
      "thread.send": async ({ key, text, options: sendOptions }) => { await requireThread(key).send(String(text ?? ""), asParams(sendOptions) as SendOptions); return null; },
      "thread.steer": async ({ key, text, options: steerOptions }) => { await requireThread(key).steer(String(text ?? ""), asParams(steerOptions) as SteerOptions); return null; },
      "thread.interrupt": async ({ key }) => { await requireThread(key).interrupt(); return null; },
      "thread.setModel": async ({ key, modelId, options: modelOptions }) => await requireThread(key).setModel(String(modelId ?? ""), asParams(modelOptions) as SetModelOptions),
      "thread.update": async ({ key, patch, options: updateOptions }) => await requireThread(key).update(asParams(patch) as ThreadUpdate, asParams(updateOptions) as ThreadUpdateOptions),
      "thread.retry": async ({ key }) => await requireThread(key).retry(),
      "thread.editLast": async ({ key, text, options: editOptions }) => await requireThread(key).editLast(String(text ?? ""), asParams(editOptions) as EditLastOptions),
      "thread.history": async ({ key, options: historyOptions }) => await requireThread(key).history(asParams(historyOptions) as { limit?: number }),
      "thread.historyPage": async ({ key, options: historyOptions }) => await requireThread(key).historyPage(asParams(historyOptions) as HistoryPageOptions),
      "thread.approve": async ({ key, itemId, decision, responseText }) =>
        await requireThread(key).approve(String(itemId ?? ""), decision as ApprovalDecision, typeof responseText === "string" ? responseText : undefined),
      "thread.pendingApprovals": async ({ key }) => await requireThread(key).pendingApprovals(),
      "thread.usage": ({ key }) => requireThread(key).usage(),
      "thread.updateMcpServers": async ({ key, servers }) =>
        await requireThread(key).updateMcpServers(asParams(servers) as unknown as Record<string, McpServerConfig>),
      "thread.refreshMcpHeaders": async ({ key }) => await requireThread(key).refreshMcpHeaders(),
    };

    const dispatch = async (raw: unknown) => {
      let request: any;
      try { request = parseMessage(raw); } catch { return; }
      if (!request || (typeof request.id !== "string" && typeof request.id !== "number") || typeof request.method !== "string") return;
      const id = request.id as string | number;
      if (requestIds.has(id)) {
        send({ id, ok: false, error: serializeAdeError(new AdeError("protocol_error", "Duplicate request id.")) });
        return;
      }
      requestIds.add(id);
      const params = asParams(request.params);
      try {
        if (options.authorize && !(await options.authorize(socket, request.method, params))) {
          throw new AdeError("unauthorized", "The host refused " + request.method + ".");
        }
        if (KEYED_METHODS.has(request.method)) {
          const key = params.key;
          if (typeof key !== "string") throw new AdeError("invalid_option", request.method + " needs a thread key.");
          if (options.allowThreadKey && !(await options.allowThreadKey(key, request.method, params, socket))) {
            throw new AdeError("unauthorized", "The host refused thread key " + key + ".");
          }
        }
        const customHandler = options.methods?.[request.method];
        const handler = handlers[request.method] ?? (customHandler
          ? (value: Record<string, unknown>) => customHandler(value, { socket })
          : undefined);
        if (!handler) throw new AdeError("unsupported", "The ADE server does not expose " + request.method + ".");
        const result = await handler(params);
        send({ id, ok: true, result: result === undefined ? null : result });
      } catch (error) {
        options.logger?.("ade sdk server: " + request.method + " failed: " + (error instanceof Error ? error.message : String(error)));
        send({ id, ok: false, error: serializeAdeError(error) });
      } finally {
        requestIds.delete(id);
      }
    };

    const detachMessage = listen(socket, "message", (raw) => { void dispatch(raw); });
    const detachClose = listen(socket, "close", cleanup);
    sockets.add(socket);
    const remove = () => cleanup();
    cleanups.set(socket, remove);
    return remove;
  };

  return {
    handleConnection: attach,
    close: () => {
      if (closed) return;
      closed = true;
      for (const cleanup of [...cleanups.values()]) cleanup();
      sockets.clear();
      cleanups.clear();
    },
  };
}

export { createAdeRemoteClient, type AdeRemoteClient, type AdeRemoteClientOptions, type AdeRemoteThread, type AdeRemoteTransport };
