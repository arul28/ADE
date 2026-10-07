import fs from "node:fs";
import { JsonRpcClient, JsonRpcResponseError } from "../../tuiClient/jsonRpcClient";

/**
 * One lazily opened connection from the runtime daemon to the desktop bridge
 * socket, shared by the clients that reach desktop-only engines through it (the
 * App Control recorder, the demo engine, the scene previewer).
 *
 * Every call carries the bridge token. The socket is opened on the first call,
 * with a connect deadline, and reopened after it closes. A transport failure
 * drops the socket so the next call reconnects; an error ANSWER does not,
 * because the desktop ties work (a recording, a demo job) to the connection
 * that started it and cancels it when that connection closes.
 */

const CONNECT_TIMEOUT_MS = 3_000;

export type DesktopBridgeConnection = {
  /** Call `method`. Rejects with `unavailableMessage` when no desktop is attached. */
  request<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T>;
  /** Close the socket and refuse later calls. */
  close(): void;
};

export function createDesktopBridgeConnection(args: {
  socketPath: string;
  /** Why a call cannot run: no desktop app attached on this machine. */
  unavailableMessage: string;
  /** The error a call made after `close()` rejects with. */
  closedMessage: string;
}): DesktopBridgeConnection {
  const { socketPath } = args;
  const isNamedPipe = socketPath.startsWith("\\\\");
  let client: JsonRpcClient | null = null;
  let connecting: Promise<JsonRpcClient> | null = null;
  let closed = false;

  const ensureClient = async (): Promise<JsonRpcClient> => {
    if (client) return client;
    if (closed) throw new Error(args.closedMessage);
    if (!connecting) {
      connecting = (async () => {
        if (!isNamedPipe && !fs.existsSync(socketPath)) throw new Error(args.unavailableMessage);
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
          const next = await Promise.race([
            JsonRpcClient.connect(socketPath),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Timed out connecting to the ADE desktop app.")), CONNECT_TIMEOUT_MS);
            }),
          ]);
          next.onClose(() => {
            if (client === next) client = null;
          });
          client = next;
          return next;
        } finally {
          if (timer) clearTimeout(timer);
        }
      })().finally(() => {
        connecting = null;
      });
    }
    return await connecting;
  };

  return {
    async request<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
      if (closed) throw new Error(args.closedMessage);
      const c = await ensureClient();
      try {
        return await c.request<T>(method, params, { timeoutMs });
      } catch (error) {
        // A call's own failure is an answer; only a transport failure drops the socket.
        if (client === c && !(error instanceof JsonRpcResponseError)) {
          client = null;
          try { c.close(); } catch { /* ignore */ }
        }
        throw error;
      }
    },
    close() {
      closed = true;
      const c = client;
      client = null;
      if (c) {
        try { c.close(); } catch { /* ignore */ }
      }
    },
  };
}
