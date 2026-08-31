/**
 * The renderer's half of the host bridge.
 *
 * `createBridgeClient` returns an object that satisfies `SdkLikeChatClient`
 * from `@ade-dev/chat-ui` — the same interface the real `@ade-dev/sdk` client
 * satisfies — while every call is a WebSocket round trip to the host process.
 * `adaptSdkClient()` cannot tell the difference, which is the whole point:
 * the SDK's client surface survives a process boundary without a special
 * "remote" mode on either side.
 */

import type {
  SdkFileRef,
  SdkLikeChatClient,
  SdkLikeThread,
  SdkModelCatalogEntry,
  SdkProviderStatus,
  Unsubscribe,
} from "@ade-dev/chat-ui";
import type { AgentChatEventEnvelope } from "@ade-dev/chat-ui";

export type AppConfig = {
  mcpUrl: string;
  threadKey: string;
  /** The model DataDesk selects on first paint; the picker can change it. */
  defaultModelId: string | null;
  defaults: Record<string, unknown>;
};

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export type BridgeClient = SdkLikeChatClient & {
  config(): Promise<AppConfig>;
  doctor(): Promise<Record<string, unknown>>;
  readonly connected: boolean;
  onConnectionChange(cb: (connected: boolean) => void): Unsubscribe;
};

export function createBridgeClient(url: string): BridgeClient {
  let socket: WebSocket | null = null;
  let connected = false;
  let nextId = 1;

  const pending = new Map<number, Pending>();
  const eventListeners = new Map<string, Set<(envelope: AgentChatEventEnvelope) => void>>();
  const providerListeners = new Set<(statuses: Record<string, SdkProviderStatus>) => void>();
  const connectionListeners = new Set<(connected: boolean) => void>();
  // Calls made before the socket opens are queued rather than rejected: the UI
  // mounts and asks for providers immediately, and failing that first render
  // would show "no providers" for a connection that is about to succeed.
  const queue: string[] = [];

  const setConnected = (next: boolean) => {
    if (connected === next) return;
    connected = next;
    for (const listener of [...connectionListeners]) listener(next);
  };

  function connect() {
    socket = new WebSocket(url);
    socket.addEventListener("open", () => {
      setConnected(true);
      for (const payload of queue.splice(0)) socket?.send(payload);
    });
    socket.addEventListener("close", () => {
      setConnected(false);
      for (const entry of pending.values()) entry.reject(new Error("The DataDesk host disconnected."));
      pending.clear();
      // Vite restarts and host restarts are normal in development.
      setTimeout(connect, 1000);
    });
    socket.addEventListener("message", (message) => {
      const payload = JSON.parse(String(message.data));
      if (payload.push === "event") {
        for (const listener of eventListeners.get(payload.key) ?? []) listener(payload.envelope);
        return;
      }
      if (payload.push === "providers") {
        for (const listener of [...providerListeners]) listener(payload.statuses);
        return;
      }
      const entry = pending.get(payload.id);
      if (!entry) return;
      pending.delete(payload.id);
      if (payload.ok) entry.resolve(payload.result);
      else entry.reject(new Error(payload.error ?? "The host returned an error."));
    });
  }
  connect();

  function call<T>(method: string, params?: unknown): Promise<T> {
    const id = nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(payload);
      else queue.push(payload);
    });
  }

  function makeThread(key: string, id: string): SdkLikeThread {
    return {
      id,
      key,
      async send(text: string, opts?: { attachments?: SdkFileRef[] }) {
        await call("thread.send", { key, text, attachments: opts?.attachments });
      },
      async steer(text: string) {
        await call("thread.steer", { key, text });
      },
      async interrupt() {
        await call("thread.interrupt", { key });
      },
      // Present, so `adaptSdkClient` reports `canSetModel` and the composer's
      // model picker is live rather than disabled with a "cannot switch"
      // reason. `@ade-dev/chat-ui` keeps the picker disabled while a turn streams,
      // which is what keeps DataDesk off the SDK's mid-turn refusal — the demo
      // never passes `{ force: true }`, so a switch never truncates an answer.
      setModel(modelId: string) {
        return call<{ modelId: string; provider: string; model: string }>("thread.setModel", {
          key,
          modelId,
        });
      },
      history() {
        return call<AgentChatEventEnvelope[]>("thread.history", { key });
      },
      on(_channel, cb) {
        // The host pushes one raw envelope stream per thread; the channel split
        // (`event` / `status` / `usage`) is applied by `adaptSdkClient` on top,
        // so the bridge stays a dumb pipe and there is one place that decides
        // what an envelope means.
        let set = eventListeners.get(key);
        if (!set) {
          set = new Set();
          eventListeners.set(key, set);
        }
        set.add(cb);
        return () => set?.delete(cb);
      },
    };
  }

  return {
    get connected() {
      return connected;
    },
    onConnectionChange(cb) {
      connectionListeners.add(cb);
      return () => connectionListeners.delete(cb);
    },
    config: () => call<AppConfig>("app.config"),
    doctor: () => call<Record<string, unknown>>("doctor"),
    providers: {
      status: () => call<Record<string, SdkProviderStatus>>("providers.status"),
      onChange: (cb) => {
        providerListeners.add(cb);
        return () => providerListeners.delete(cb);
      },
    },
    models: {
      list: () => call<SdkModelCatalogEntry[]>("models.list"),
    },
    threads: {
      open: async (key, opts) => {
        const opened = await call<{ id: string; key: string }>("threads.open", { key, opts });
        return makeThread(opened.key, opened.id);
      },
    },
  };
}
