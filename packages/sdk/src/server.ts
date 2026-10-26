import { ADE_CLIENT_EVENTS, type AdeClientEvent } from "./clientEvents.js";
import type { AdeChatClient } from "./client.js";
import type { ThreadOpenOptions, ThreadResumeOptions } from "./clientOptions.js";
import type { AdeThread, EditLastOptions, HistoryPageOptions, SendOptions, SetModelOptions, SteerOptions, ThreadRespondOptions, ThreadUpdate, ThreadUpdateOptions } from "./thread.js";
import type { SignInHandle, SignInStatus } from "./accounts.js";
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
  /**
   * Enable account, credential and preset management over this bridge. Off
   * unless the host opts in: a browser that can sign accounts in or store keys
   * acts as the end user. A callback decides per socket and method.
   */
  allowAccountManagement?: boolean | ((socket: AdeServerSocket, method: string, params: Record<string, unknown>) => boolean | Promise<boolean>);
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
type SocketSignIn = {
  handle: SignInHandle;
  readonly status: SignInStatus;
  stop: Unsubscribe;
  result: Promise<{ account?: unknown; error?: unknown }>;
};

const KEYED_METHODS = new Set([
  "threads.open", "threads.get", "threads.delete", "threads.archive", "threads.unarchive",
  "thread.export", "thread.update", "thread.retry", "thread.editLast", "thread.history",
  "thread.historyPage", "thread.send", "thread.steer", "thread.interrupt", "thread.setModel",
  "thread.approve", "thread.pendingApprovals", "thread.usage", "thread.updateMcpServers", "thread.refreshMcpHeaders",
  "thread.respond", "thread.queue.list", "thread.queue.cancel", "thread.queue.edit", "thread.queue.move",
  "thread.queue.dispatch", "thread.queue.cancelDispatched", "thread.queue.restore", "thread.stopTask",
  "thread.slashCommands", "thread.recover", "thread.resolveUnprocessed", "thread.usageLimit.resumeNow",
  "thread.usageLimit.continueOnAlternate", "thread.switchAccount",
]);

function isAccountMethod(method: string): boolean {
  return method.startsWith("accounts.") || method.startsWith("credentials.") || method.startsWith("presets.");
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new AdeError("invalid_option", label + " must be a non-empty string.");
  return value;
}

const TERMINAL_SIGN_IN_STATES = new Set(["succeeded", "failed", "cancelled", "expired"]);

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
    // Sign-ins this connection started. A browser that goes away cannot finish
    // one, so its sign-ins are cancelled with it rather than left running.
    const signIns = new Map<string, SocketSignIn>();
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
      for (const login of signIns.values()) {
        login.stop();
        void login.handle.cancel().catch(() => {});
      }
      signIns.clear();
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
      "thread.interrupt": async ({ key, options: interruptOptions }) => {
        const raw = asParams(interruptOptions);
        await requireThread(key).interrupt({
          ...(raw.queue === "keep" || raw.queue === "drop" ? { queue: raw.queue } : {}),
          ...(typeof raw.mode === "string" ? { mode: raw.mode } : {}),
        } as Parameters<AdeThread["interrupt"]>[0]);
        return null;
      },
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
      "thread.respond": async ({ key, requestId, response }) => {
        await requireThread(key).respond(requireText(requestId, "requestId"), asParams(response) as ThreadRespondOptions);
        return null;
      },
      "thread.queue.list": async ({ key }) => await requireThread(key).queue.list(),
      "thread.queue.cancel": async ({ key, id }) => { await requireThread(key).queue.cancel(requireText(id, "id")); return null; },
      "thread.queue.edit": async ({ key, id, text }) => { await requireThread(key).queue.edit(requireText(id, "id"), String(text ?? "")); return null; },
      "thread.queue.move": async ({ key, id, index }) => {
        if (typeof index !== "number" || !Number.isInteger(index)) throw new AdeError("invalid_option", "index must be an integer.");
        await requireThread(key).queue.move(requireText(id, "id"), index);
        return null;
      },
      "thread.queue.dispatch": async ({ key, id }) => { await requireThread(key).queue.dispatch(requireText(id, "id")); return null; },
      "thread.queue.cancelDispatched": async ({ key, id }) => { await requireThread(key).queue.cancelDispatched(requireText(id, "id")); return null; },
      "thread.queue.restore": async ({ key }) => { await requireThread(key).queue.restore(); return null; },
      "thread.stopTask": async ({ key, taskId }) => { await requireThread(key).stopTask(requireText(taskId, "taskId")); return null; },
      "thread.slashCommands": async ({ key }) => await requireThread(key).slashCommands(),
      "thread.recover": async ({ key, options: recoverOptions }) =>
        await requireThread(key).recover(asParams(recoverOptions) as Parameters<AdeThread["recover"]>[0]),
      "thread.resolveUnprocessed": async ({ key, args }) =>
        await requireThread(key).resolveUnprocessed(asParams(args) as Parameters<AdeThread["resolveUnprocessed"]>[0]),
      "thread.usageLimit.resumeNow": async ({ key }) => await requireThread(key).usageLimit.resumeNow(),
      "thread.usageLimit.continueOnAlternate": async ({ key }) => await requireThread(key).usageLimit.continueOnAlternate(),
      "thread.switchAccount": async ({ key, instanceId }) => await requireThread(key).switchAccount(requireText(instanceId, "instanceId")),
      "providers.capabilities": async ({ provider }) => await client.providers.capabilities(requireText(provider, "provider")),
      "accounts.list": async ({ provider }) => await client.accounts.list(typeof provider === "string" ? provider : undefined),
      "accounts.add": async ({ provider, options: addOptions }) =>
        await client.accounts.add(requireText(provider, "provider"), asParams(addOptions) as { label?: string }),
      "accounts.remove": async ({ id }) => await client.accounts.remove(requireText(id, "id")),
      "accounts.rename": async ({ id, label }) => await client.accounts.rename(requireText(id, "id"), requireText(label, "label")),
      "accounts.setDefault": async ({ id }) => await client.accounts.setDefault(requireText(id, "id")),
      "accounts.signOut": async ({ id }) => await client.accounts.signOut(requireText(id, "id")),
      "accounts.refresh": async () => await client.accounts.refresh(),
      "accounts.signIn": async ({ id, options: signInOptions }) => {
        const handle = await client.accounts.signIn(requireText(id, "id"), asParams(signInOptions) as { deviceAuth?: boolean });
        let status = {} as SignInStatus;
        const stop = handle.on("update", (next) => { status = next; });
        if (!status.loginId) {
          stop();
          await handle.cancel().catch(() => {});
          throw new AdeError("protocol_error", "The sign-in did not provide its initial status.");
        }
        signIns.set(status.loginId, {
          handle,
          get status() { return status; },
          stop,
          result: handle.done.then((account) => ({ account }), (error) => ({ error: serializeAdeError(error) })),
        });
        return { loginId: status.loginId, status };
      },
      "accounts.signInStatus": async ({ loginId }) => {
        const id = requireText(loginId, "loginId");
        const login = signIns.get(id);
        if (!login) throw new AdeError("invalid_option", "Sign-in " + id + " was not found.");
        const terminal = TERMINAL_SIGN_IN_STATES.has(login.status.state);
        const result = terminal ? await login.result : {};
        if (terminal) {
          login.stop();
          signIns.delete(id);
        }
        return { status: login.status, ...result };
      },
      "accounts.signInSubmitCode": async ({ loginId, code }) => {
        const login = signIns.get(requireText(loginId, "loginId"));
        if (!login) throw new AdeError("invalid_option", "This sign-in is no longer active.");
        await login.handle.submitCode(requireText(code, "code"));
        return null;
      },
      "accounts.signInCancel": async ({ loginId }) => {
        const id = requireText(loginId, "loginId");
        const login = signIns.get(id);
        if (!login) return null;
        await login.handle.cancel();
        login.stop();
        signIns.delete(id);
        return null;
      },
      "credentials.list": async ({ provider }) => await client.credentials.list(typeof provider === "string" ? provider : undefined),
      "credentials.add": async ({ credential }) =>
        await client.credentials.add(asParams(credential) as Parameters<AdeChatClient["credentials"]["add"]>[0]),
      "credentials.remove": async ({ id, provider }) =>
        await client.credentials.remove(requireText(id, "id"), typeof provider === "string" ? provider : undefined),
      "credentials.verify": async ({ provider }) => await client.credentials.verify(requireText(provider, "provider")),
      "presets.list": async () => await client.presets.list(),
      "presets.add": async ({ preset }) => await client.presets.add(asParams(preset) as Parameters<AdeChatClient["presets"]["add"]>[0]),
      "presets.update": async ({ id, patch }) =>
        await client.presets.update(requireText(id, "id"), asParams(patch) as Parameters<AdeChatClient["presets"]["update"]>[1]),
      "presets.remove": async ({ id }) => await client.presets.remove(requireText(id, "id")),
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
        if (isAccountMethod(request.method)) {
          const gate = options.allowAccountManagement;
          const allowed = typeof gate === "function" ? await gate(socket, request.method, params) : gate === true;
          if (!allowed) throw new AdeError("unauthorized", "The host has not enabled account management over this bridge.");
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
