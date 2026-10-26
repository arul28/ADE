import { AdeError, readAdeErrorCode } from "./errors.js";
import type { AdeClientEvent, AdeClientEventMap } from "./clientEvents.js";
import type { AdeThread, EditLastOptions, HistoryPageOptions, SendOptions, SetModelOptions, SetModelResult, SteerOptions, ThreadEventChannel, ThreadInterruptOptions, ThreadModelSelection, ThreadRespondOptions, ThreadUpdate, ThreadUpdateOptions } from "./thread.js";
import type { AccountManagement, SignInStatus } from "./accounts.js";
import type { ProviderCapabilities } from "./types.js";
import { createPolledSignIn, type PolledSignInResult } from "./polledSignIn.js";
import type { ApprovalDecision, ApprovalRequest } from "./approvals.js";
import { STATUS_EVENT_TYPES, USAGE_EVENT_TYPES, type AgentChatEventEnvelope, type DoctorReport, type McpCapabilityReport, type ModelCatalogEntry, type ProviderStatus, type ThreadHistoryPage, type ThreadSummary, type Unsubscribe } from "./types.js";
import { envelopeDedupeKey, mergeHistoryWithBuffer, type AdeIpcErrorPayload } from "./electron/protocol.js";
import type { InstructionsCapability, PermissionCapability, SettingSourcesCapability } from "./hostConfig.js";
import type { ThreadUsage } from "./usage.js";

type MessageListener = (message: unknown) => void;
type CloseListener = () => void;

/** A browser WebSocket, Node ws socket, or a small adapter around either. */
export type AdeRemoteTransport = {
  send(data: string): unknown;
  readyState?: number;
  OPEN?: number;
  on?(event: "message" | "close" | "open", listener: (...args: any[]) => void): unknown;
  off?(event: "message" | "close" | "open", listener: (...args: any[]) => void): unknown;
  removeListener?(event: "message" | "close" | "open", listener: (...args: any[]) => void): unknown;
  addEventListener?(event: "message" | "close" | "open", listener: (event: any) => void): unknown;
  removeEventListener?(event: "message" | "close" | "open", listener: (event: any) => void): unknown;
};

export type AdeRemoteClientOptions = {
  /** Optional WebSocket constructor for runtimes without a global WebSocket. */
  WebSocket?: new (url: string) => AdeRemoteTransport;
};

export type AdeRemoteThread = Omit<AdeThread, "usage"> & {
  readonly title: string | null;
  readonly model: ThreadModelSelection | null;
  readonly mcpCapability: McpCapabilityReport | null;
  readonly instructionsCapability: InstructionsCapability | null;
  readonly settingSourcesCapability: SettingSourcesCapability | null;
  readonly permissionCapability: PermissionCapability | null;
  historyPage(options?: HistoryPageOptions): Promise<ThreadHistoryPage>;
  /** Usage read across the socket; unlike a local AdeThread, this is asynchronous. */
  usage(): Promise<ThreadUsage>;
};

export type AdeRemoteClient = {
  /** Request a host-defined method registered through `createAdeServer({ methods })`. */
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  providers: {
    status(): Promise<Record<string, ProviderStatus>>;
    refresh(): Promise<Record<string, ProviderStatus>>;
    onChange(listener: (statuses: Record<string, ProviderStatus>) => void): Unsubscribe;
    capabilities(provider: string): Promise<ProviderCapabilities>;
  };
  /** Refused by the server unless its host passed `allowAccountManagement`. */
  accounts: AccountManagement["accounts"];
  /** Refused by the server unless its host passed `allowAccountManagement`. */
  credentials: AccountManagement["credentials"];
  /** Refused by the server unless its host passed `allowAccountManagement`. */
  presets: AccountManagement["presets"];
  models: { list(): Promise<ModelCatalogEntry[]> };
  threads: {
    open(key: string, options?: Record<string, unknown>): Promise<AdeRemoteThread>;
    list(): Promise<ThreadSummary[]>;
    get(key: string): Promise<ThreadSummary | null>;
    delete(key: string): Promise<void>;
    archive(key: string): Promise<void>;
    unarchive(key: string): Promise<void>;
  };
  doctor(): Promise<DoctorReport>;
  exportThread(key: string): Promise<string>;
  on<E extends AdeClientEvent>(event: E, listener: (payload: AdeClientEventMap[E]) => void): Unsubscribe;
  dispose(): void;
};

type PendingCall = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
type BufferedEvent = { envelope: AgentChatEventEnvelope; deliveredToTranscript: boolean };
type RemoteThreadState = {
  key: string;
  id: string;
  title: string | null;
  model: ThreadModelSelection | null;
  mcpCapability: McpCapabilityReport | null;
  instructionsCapability: InstructionsCapability | null;
  settingSourcesCapability: SettingSourcesCapability | null;
  permissionCapability: PermissionCapability | null;
  listeners: Map<ThreadEventChannel, Set<(envelope: AgentChatEventEnvelope) => void>>;
  buffers: Set<BufferedEvent[]>;
  seenSequences: Set<string>;
};

const USAGE = new Set<string>(USAGE_EVENT_TYPES);
const STATUS = new Set<string>(STATUS_EVENT_TYPES);

function parseIncoming(raw: unknown): unknown {
  let value = raw;
  if (value && typeof value === "object" && "data" in value) value = (value as { data: unknown }).data;
  if (typeof value === "string") return JSON.parse(value);
  if (value instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(value));
  return JSON.parse(String(value));
}

function bind(
  transport: AdeRemoteTransport,
  event: "message" | "close" | "open",
  listener: (...args: any[]) => void,
): () => void {
  if (typeof transport.addEventListener === "function") {
    transport.addEventListener(event, listener);
    return () => transport.removeEventListener?.(event, listener);
  }
  if (typeof transport.on === "function") {
    transport.on(event, listener);
    return () => {
      if (typeof transport.off === "function") transport.off(event, listener);
      else transport.removeListener?.(event, listener);
    };
  }
  throw new AdeError("invalid_option", "The remote transport must support message and close listeners.");
}

function remoteError(payload: unknown): Error {
  const value = payload && typeof payload === "object" ? (payload as Partial<AdeIpcErrorPayload>) : {};
  const code = readAdeErrorCode(value.code) ?? "rpc_error";
  return new AdeError(code, typeof value.message === "string" ? value.message : "The ADE server returned an error.");
}

/** Build a browser-safe client proxy for a createAdeServer WebSocket connection. */
export function createAdeRemoteClient(transportOrUrl: AdeRemoteTransport | string, options: AdeRemoteClientOptions = {}): AdeRemoteClient {
  let transport: AdeRemoteTransport;
  if (typeof transportOrUrl === "string") {
    const globalWebSocket = (globalThis as typeof globalThis & { WebSocket?: AdeRemoteClientOptions["WebSocket"] }).WebSocket;
    const WebSocketConstructor = options.WebSocket ?? globalWebSocket;
    if (!WebSocketConstructor) {
      throw new AdeError("invalid_option", "createAdeRemoteClient(url) needs a global WebSocket or the WebSocket option.");
    }
    transport = new WebSocketConstructor(transportOrUrl);
  } else {
    transport = transportOrUrl;
  }
  if (!transport || typeof transport.send !== "function") {
    throw new AdeError("invalid_option", "createAdeRemoteClient needs a WebSocket-compatible transport.");
  }
  let nextId = 1;
  let closed = false;
  let disposed = false;
  const pending = new Map<number, PendingCall>();
  const queued: string[] = [];
  const threads = new Map<string, RemoteThreadState>();
  const preOpenEvents = new Map<string, AgentChatEventEnvelope[]>();
  const providerListeners = new Set<(statuses: Record<string, ProviderStatus>) => void>();
  const clientListeners = new Map<string, Set<(payload: unknown) => void>>();

  const isOpen = () => transport.readyState === undefined || transport.readyState === (transport.OPEN ?? 1);
  const sendRaw = (payload: string) => {
    if (closed || disposed) throw new AdeError("transport_closed", "The ADE server connection is closed.");
    if (!isOpen()) {
      queued.push(payload);
      return;
    }
    transport.send(payload);
  };
  const flush = () => {
    if (!isOpen() || closed || disposed) return;
    for (const payload of queued.splice(0)) transport.send(payload);
  };
  const rejectPending = (error: Error) => {
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    pending.clear();
  };

  const call = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (closed || disposed) return Promise.reject(new AdeError("transport_closed", "The ADE server connection is closed."));
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new AdeError("rpc_timeout", "The ADE server did not answer " + method + " before the request timed out."));
      }, 30_000);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        sendRaw(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };

  const dispatchThreadEvent = (state: RemoteThreadState, envelope: AgentChatEventEnvelope) => {
    if (typeof envelope.sequence === "number") {
      const key = envelopeDedupeKey(envelope);
      if (state.seenSequences.has(key)) return;
      state.seenSequences.add(key);
      if (state.seenSequences.size > 20_000) state.seenSequences.delete(state.seenSequences.values().next().value!);
    }
    const type = envelope.event?.type;
    let deliveredToTranscript = false;
    for (const [channel, listeners] of state.listeners) {
      if (channel === "usage" && !USAGE.has(type)) continue;
      if (channel === "status" && !STATUS.has(type)) continue;
      if (channel === "event" && listeners.size) deliveredToTranscript = true;
      for (const listener of [...listeners]) listener(envelope);
    }
    for (const buffer of state.buffers) buffer.push({ envelope, deliveredToTranscript });
  };

  const handleIncoming = (raw: unknown) => {
    let message: any;
    try {
      message = parseIncoming(raw);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    if (message.push === "event" && typeof message.key === "string" && message.envelope) {
      const state = threads.get(message.key);
      if (state) dispatchThreadEvent(state, message.envelope as AgentChatEventEnvelope);
      else {
        const buffer = preOpenEvents.get(message.key) ?? [];
        buffer.push(message.envelope as AgentChatEventEnvelope);
        if (buffer.length > 5_000) buffer.shift();
        preOpenEvents.set(message.key, buffer);
      }
      return;
    }
    if (message.push === "providers" && message.statuses && typeof message.statuses === "object") {
      for (const listener of [...providerListeners]) listener(message.statuses as Record<string, ProviderStatus>);
      return;
    }
    if (message.push === "client" && typeof message.event === "string") {
      for (const listener of [...(clientListeners.get(message.event) ?? [])]) listener(message.payload);
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok === true) entry.resolve(message.result);
    else entry.reject(remoteError(message.error));
  };

  const detach = [
    bind(transport, "message", (...args) => handleIncoming(args[0])),
    bind(transport, "close", () => {
      closed = true;
      rejectPending(new AdeError("transport_closed", "The ADE server closed the WebSocket connection."));
    }),
  ];
  if (transport.addEventListener || transport.on) {
    try { detach.push(bind(transport, "open", flush)); } catch { /* already-open structural transports need no open listener */ }
  }
  flush();

  const openThread = async (key: string, options?: Record<string, unknown>): Promise<AdeRemoteThread> => {
    const existing = threads.get(key);
    if (existing) return makeThread(existing);
    const snapshot = await call<RemoteThreadState>("threads.open", { key, options: options ?? {} });
    const state: RemoteThreadState = {
      ...snapshot,
      key,
      listeners: new Map(),
      buffers: new Set(),
      seenSequences: new Set(),
    };
    threads.set(key, state);
    for (const envelope of preOpenEvents.get(key) ?? []) dispatchThreadEvent(state, envelope);
    preOpenEvents.delete(key);
    return makeThread(state);
  };

  function makeThread(state: RemoteThreadState): AdeRemoteThread {
    const addListener = (channel: ThreadEventChannel, listener: (envelope: AgentChatEventEnvelope) => void): Unsubscribe => {
      let listeners = state.listeners.get(channel);
      if (!listeners) state.listeners.set(channel, listeners = new Set());
      listeners.add(listener);
      return () => listeners?.delete(listener);
    };
    const readHistory = async (opts?: { limit?: number }): Promise<AgentChatEventEnvelope[]> => {
      const buffer: BufferedEvent[] = [];
      state.buffers.add(buffer);
      try {
        const history = await call<AgentChatEventEnvelope[]>("thread.history", { key: state.key, options: opts ?? {} });
        const missed = buffer.filter((entry) => !entry.deliveredToTranscript).map((entry) => entry.envelope);
        return mergeHistoryWithBuffer(Array.isArray(history) ? history : [], missed);
      } finally {
        state.buffers.delete(buffer);
      }
    };
    const readHistoryPage = async (opts?: HistoryPageOptions): Promise<ThreadHistoryPage> => {
      const buffer: BufferedEvent[] = [];
      state.buffers.add(buffer);
      try {
        const page = await call<ThreadHistoryPage>("thread.historyPage", { key: state.key, options: opts ?? {} });
        const missed = buffer.filter((entry) => !entry.deliveredToTranscript).map((entry) => entry.envelope);
        return { ...page, events: mergeHistoryWithBuffer(Array.isArray(page?.events) ? page.events : [], missed) };
      } finally {
        state.buffers.delete(buffer);
      }
    };
    return {
      id: state.id,
      key: state.key,
      title: state.title,
      model: state.model,
      mcpCapability: state.mcpCapability,
      instructionsCapability: state.instructionsCapability,
      settingSourcesCapability: state.settingSourcesCapability,
      permissionCapability: state.permissionCapability,
      send: async (text: string, options?: SendOptions) => { await call("thread.send", { key: state.key, text, options: options ?? {} }); },
      steer: async (text: string, options?: SteerOptions) => { await call("thread.steer", { key: state.key, text, options: options ?? {} }); },
      interrupt: async (options?: ThreadInterruptOptions) => { await call("thread.interrupt", { key: state.key, options: options ?? {} }); },
      respond: async (requestId: string, response: ThreadRespondOptions) => {
        await call("thread.respond", { key: state.key, requestId, response });
      },
      queue: {
        list: () => call("thread.queue.list", { key: state.key }),
        cancel: async (id) => { await call("thread.queue.cancel", { key: state.key, id }); },
        edit: async (id, text) => { await call("thread.queue.edit", { key: state.key, id, text }); },
        move: async (id, index) => { await call("thread.queue.move", { key: state.key, id, index }); },
        dispatch: async (id) => { await call("thread.queue.dispatch", { key: state.key, id }); },
        cancelDispatched: async (id) => { await call("thread.queue.cancelDispatched", { key: state.key, id }); },
        restore: async () => { await call("thread.queue.restore", { key: state.key }); },
      },
      stopTask: async (taskId: string) => { await call("thread.stopTask", { key: state.key, taskId }); },
      slashCommands: () => call("thread.slashCommands", { key: state.key }),
      recover: (options) => call("thread.recover", { key: state.key, options: options ?? {} }),
      resolveUnprocessed: (args) => call("thread.resolveUnprocessed", { key: state.key, args }),
      usageLimit: {
        resumeNow: () => call("thread.usageLimit.resumeNow", { key: state.key }),
        continueOnAlternate: () => call("thread.usageLimit.continueOnAlternate", { key: state.key }),
      },
      switchAccount: (instanceId: string) => call("thread.switchAccount", { key: state.key, instanceId }),
      setModel: async (modelId: string, options?: SetModelOptions) => {
        const result = await call<SetModelResult>("thread.setModel", { key: state.key, modelId, options: options ?? {} });
        state.model = result;
        return result;
      },
      update: async (patch: ThreadUpdate, options?: ThreadUpdateOptions) =>
        await call("thread.update", { key: state.key, patch, options: options ?? {} }),
      retry: async () => await call("thread.retry", { key: state.key }),
      editLast: async (text: string, options?: EditLastOptions) => await call("thread.editLast", { key: state.key, text, options: options ?? {} }),
      history: readHistory,
      historyPage: readHistoryPage,
      approve: async (itemId: string, decision: ApprovalDecision, responseText?: string) =>
        await call("thread.approve", { key: state.key, itemId, decision, responseText }),
      pendingApprovals: async () => await call<ApprovalRequest[]>("thread.pendingApprovals", { key: state.key }),
      usage: () => call<ThreadUsage>("thread.usage", { key: state.key }),
      updateMcpServers: async (servers) => await call("thread.updateMcpServers", { key: state.key, servers }),
      refreshMcpHeaders: async () => await call("thread.refreshMcpHeaders", { key: state.key }),
      on: addListener,
    };
  }

  return {
    call,
    providers: {
      status: () => call<Record<string, ProviderStatus>>("providers.status"),
      refresh: () => call<Record<string, ProviderStatus>>("providers.refresh"),
      onChange: (listener) => { providerListeners.add(listener); return () => providerListeners.delete(listener); },
      capabilities: (provider) => call<ProviderCapabilities>("providers.capabilities", { provider }),
    },
    accounts: {
      list: (provider) => call("accounts.list", { provider }),
      add: (provider, options) => call("accounts.add", { provider, options: options ?? {} }),
      remove: (id) => call("accounts.remove", { id }),
      rename: (id, label) => call("accounts.rename", { id, label }),
      setDefault: (id) => call("accounts.setDefault", { id }),
      signOut: (id) => call("accounts.signOut", { id }),
      refresh: () => call("accounts.refresh"),
      signIn: async (id, options) => {
        const started = await call<{ loginId: string; status: SignInStatus }>("accounts.signIn", { id, options: options ?? {} });
        return createPolledSignIn<AdeIpcErrorPayload>(started, {
          status: (loginId) => call<PolledSignInResult<AdeIpcErrorPayload>>("accounts.signInStatus", { loginId }),
          submitCode: async (loginId, code) => { await call("accounts.signInSubmitCode", { loginId, code }); },
          cancel: async (loginId) => { await call("accounts.signInCancel", { loginId }); },
          toError: remoteError,
        });
      },
    },
    credentials: {
      list: (provider) => call("credentials.list", { provider }),
      add: (input) => call("credentials.add", { credential: input }),
      remove: (id, provider) => call("credentials.remove", { id, provider }),
      verify: (provider) => call("credentials.verify", { provider }),
    },
    presets: {
      list: () => call("presets.list"),
      add: (input) => call("presets.add", { preset: input }),
      update: (id, patch) => call("presets.update", { id, patch }),
      remove: (id) => call("presets.remove", { id }),
    },
    models: { list: () => call<ModelCatalogEntry[]>("models.list") },
    threads: {
      open: openThread,
      list: () => call<ThreadSummary[]>("threads.list"),
      get: (key) => call<ThreadSummary | null>("threads.get", { key }),
      delete: async (key) => { await call("threads.delete", { key }); threads.delete(key); preOpenEvents.delete(key); },
      archive: async (key) => { await call("threads.archive", { key }); },
      unarchive: async (key) => { await call("threads.unarchive", { key }); },
    },
    doctor: () => call<DoctorReport>("doctor"),
    exportThread: (key) => call<string>("thread.export", { key }),
    on: (event, listener) => {
      let listeners = clientListeners.get(event);
      if (!listeners) clientListeners.set(event, listeners = new Set());
      const callback = listener as (payload: unknown) => void;
      listeners.add(callback);
      return () => listeners?.delete(callback);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      rejectPending(new AdeError("disposed", "The remote ADE client was disposed."));
      for (const remove of detach) remove();
      providerListeners.clear();
      clientListeners.clear();
      threads.clear();
      preOpenEvents.clear();
    },
  };
}
