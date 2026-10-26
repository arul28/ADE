/** The renderer's SDK remote client, plus DataDesk-only config and reconnect state. */

import { createAdeRemoteClient, type AdeRemoteClient } from "@ade-dev/sdk/server";
import type { SdkLikeChatClient, SdkProviderStatus, Unsubscribe } from "@ade-dev/chat-ui";

export type AppConfig = {
  mcpUrl: string;
  threadKey: string;
  defaultModelId: string | null;
  defaults: Record<string, unknown>;
};

export type BridgeClient = SdkLikeChatClient & {
  config(): Promise<AppConfig>;
  doctor(): Promise<Record<string, unknown>>;
  readonly connected: boolean;
  onConnectionChange(cb: (connected: boolean) => void): Unsubscribe;
};

export function createBridgeClient(url: string): BridgeClient {
  let remote: AdeRemoteClient | null = null;
  let connected = false;
  const connectionListeners = new Set<(connected: boolean) => void>();
  const providerListeners = new Set<(statuses: Record<string, SdkProviderStatus>) => void>();
  const clientListeners = new Set<(listener: (payload: unknown) => void) => void>();
  const providerStops = new Map<(statuses: Record<string, SdkProviderStatus>) => void, Unsubscribe>();
  const clientStops = new Map<(listener: (payload: unknown) => void) => void, Unsubscribe>();

  const setConnected = (next: boolean) => {
    if (connected === next) return;
    connected = next;
    for (const listener of [...connectionListeners]) listener(next);
  };
  const requireRemote = () => {
    if (!remote) throw new Error("The DataDesk host is reconnecting.");
    return remote;
  };
  const bindListeners = (client: AdeRemoteClient) => {
    for (const listener of providerListeners) providerStops.set(listener, client.providers.onChange(listener));
    for (const listener of clientListeners) clientStops.set(listener, client.on("restart", listener));
  };

  function connect() {
    const next = new WebSocket(url);
    const client = createAdeRemoteClient(next);
    remote = client;
    bindListeners(client);
    next.addEventListener("open", () => setConnected(true));
    next.addEventListener("close", () => {
      for (const stop of providerStops.values()) stop();
      for (const stop of clientStops.values()) stop();
      providerStops.clear();
      clientStops.clear();
      client.dispose();
      if (remote === client) remote = null;
      setConnected(false);
      // Vite restarts and host restarts are normal in development.
      setTimeout(connect, 1000);
    });
  }
  connect();

  return {
    get connected() { return connected; },
    onConnectionChange(listener) {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
    config: () => requireRemote().call<AppConfig>("app.config"),
    doctor: () => requireRemote().doctor() as Promise<Record<string, unknown>>,
    providers: {
      status: async () => await requireRemote().providers.status(),
      refresh: async () => await requireRemote().providers.refresh(),
      onChange(listener) {
        providerListeners.add(listener);
        const stop = remote?.providers.onChange(listener);
        if (stop) providerStops.set(listener, stop);
        return () => {
          providerListeners.delete(listener);
          providerStops.get(listener)?.();
          providerStops.delete(listener);
        };
      },
    },
    models: { list: () => requireRemote().models.list() },
    threads: {
      open: async (key, options) => {
        const client = requireRemote();
        const thread = await client.threads.open(key, options);
        return {
          ...thread,
          setModel: (modelId: string) => client.call("datadesk.thread.setModel", { key, modelId }),
        };
      },
    },
    on(_event, listener) {
      const callback = listener as (payload: unknown) => void;
      clientListeners.add(callback);
      const stop = remote?.on("restart", callback);
      if (stop) clientStops.set(callback, stop);
      return () => {
        clientListeners.delete(callback);
        clientStops.get(callback)?.();
        clientStops.delete(callback);
      };
    },
  };
}
