import fs from "node:fs";
import path from "node:path";
import { JsonRpcClient } from "../../tuiClient/jsonRpcClient";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";

/**
 * Proxy `built_in_browser` service used by the runtime daemon.
 *
 * The real `BuiltInBrowserService` lives in the desktop's Electron main
 * process because it owns the browser pane's `WebContentsView`. The runtime
 * daemon runs under `ELECTRON_RUN_AS_NODE=1` and has no Electron APIs, so it
 * cannot construct the service itself. Instead the desktop hosts a
 * side-channel JSON-RPC socket at `<adeHome>/sock/desktop-bridge.sock`
 * (see `MachineAdeLayout.desktopBridgeSocketPath`) and the daemon proxies
 * `built_in_browser.<method>` calls through this client.
 *
 * The connection is lazy. If no desktop is running, the first call surfaces
 * a clear error ("Desktop browser bridge not running…") and the daemon stays
 * functional for every other domain. Reconnection on next call is automatic
 * when the desktop comes back.
 */

const REQUEST_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 3_000;

async function raceWithTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export type BuiltInBrowserDesktopBridgeClient = {
  getStatus: (args?: unknown) => Promise<unknown>;
  showPanel: (args?: unknown) => Promise<unknown>;
  setBounds: (args: unknown) => Promise<unknown>;
  navigate: (args: unknown) => Promise<unknown>;
  createTab: (args?: unknown) => Promise<unknown>;
  switchTab: (args: unknown) => Promise<unknown>;
  closeTab: (args: unknown) => Promise<unknown>;
  reload: () => Promise<unknown>;
  goBack: () => Promise<unknown>;
  goForward: () => Promise<unknown>;
  stop: () => Promise<unknown>;
  startInspect: () => Promise<unknown>;
  stopInspect: () => Promise<unknown>;
  captureScreenshot: () => Promise<unknown>;
  selectPoint: (args: unknown) => Promise<unknown>;
  selectCurrent: () => Promise<unknown>;
  clearSelection: () => Promise<unknown>;
  dispose: () => void;
};

export function createBuiltInBrowserDesktopBridgeClient(args: {
  socketPath: string;
  logger: Logger;
}): BuiltInBrowserDesktopBridgeClient {
  const { socketPath, logger } = args;
  let client: JsonRpcClient | null = null;
  let connecting: Promise<JsonRpcClient> | null = null;
  let disposed = false;

  const isNamedPipe = socketPath.startsWith("\\\\");
  const socketDescription = path.basename(socketPath) || socketPath;

  async function connect(): Promise<JsonRpcClient> {
    if (disposed) throw new Error("Desktop browser bridge client has been disposed.");
    if (!isNamedPipe && !fs.existsSync(socketPath)) {
      throw new Error(
        `Desktop browser bridge not running at ${socketPath}. Open ADE Desktop with a project to enable \`ade browser\` commands.`,
      );
    }
    return await raceWithTimeout(
      JsonRpcClient.connect(socketPath),
      CONNECT_TIMEOUT_MS,
      `Timed out connecting to desktop browser bridge at ${socketDescription}.`,
    );
  }

  async function ensureClient(): Promise<JsonRpcClient> {
    if (disposed) throw new Error("Desktop browser bridge client has been disposed.");
    if (client) return client;
    if (!connecting) {
      connecting = connect()
        .then((c) => {
          if (disposed) {
            try {
              c.close();
            } catch {
              // ignore
            }
            throw new Error("Desktop browser bridge client has been disposed.");
          }
          client = c;
          return c;
        })
        .finally(() => {
          connecting = null;
        });
    }
    return await connecting;
  }

  function drop(reason?: unknown): void {
    if (client) {
      try {
        client.close();
      } catch {
        // ignore
      }
      client = null;
    }
    if (reason) {
      logger.warn("built_in_browser_bridge.connection_dropped", {
        socketPath,
        reason: reason instanceof Error ? reason.message : String(reason),
      });
    }
  }

  async function callBridge(method: string, params?: unknown): Promise<unknown> {
    const c = await ensureClient();
    try {
      return await raceWithTimeout(
        c.request(`built_in_browser.${method}`, params),
        REQUEST_TIMEOUT_MS,
        `Desktop browser bridge call ${method} timed out after ${REQUEST_TIMEOUT_MS}ms.`,
      );
    } catch (error) {
      // Drop the connection on any error so the next call reconnects.
      drop(error);
      throw error;
    }
  }

  return {
    getStatus: (args) => callBridge("getStatus", args),
    showPanel: (args) => callBridge("showPanel", args),
    setBounds: (args) => callBridge("setBounds", args),
    navigate: (args) => callBridge("navigate", args),
    createTab: (args) => callBridge("createTab", args),
    switchTab: (args) => callBridge("switchTab", args),
    closeTab: (args) => callBridge("closeTab", args),
    reload: () => callBridge("reload"),
    goBack: () => callBridge("goBack"),
    goForward: () => callBridge("goForward"),
    stop: () => callBridge("stop"),
    startInspect: () => callBridge("startInspect"),
    stopInspect: () => callBridge("stopInspect"),
    captureScreenshot: () => callBridge("captureScreenshot"),
    selectPoint: (args) => callBridge("selectPoint", args),
    selectCurrent: () => callBridge("selectCurrent"),
    clearSelection: () => callBridge("clearSelection"),
    dispose: () => {
      disposed = true;
      drop();
    },
  };
}
