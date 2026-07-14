import fs from "node:fs";
import path from "node:path";
import { JsonRpcClient } from "../../tuiClient/jsonRpcClient";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import {
  BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM,
  isRuntimeValidatedBuiltInBrowserPersonalScope,
  isBuiltInBrowserDesktopBridgeMethod,
  type BuiltInBrowserDesktopBridgeClient,
} from "./desktopBridgeMethods";

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

function isClosedSocketError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:socket (?:is )?closed|socket hang up|EPIPE|ECONNRESET|ERR_STREAM_DESTROYED)/i.test(message);
}

export function createBuiltInBrowserDesktopBridgeClient(args: {
  socketPath: string;
  getAuthToken: () => string | null;
  projectRoot?: string | null;
  logger: Logger;
}): BuiltInBrowserDesktopBridgeClient {
  const { socketPath, logger } = args;
  const projectRoot = args.projectRoot?.trim() || null;
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
          c.onClose(() => {
            if (client === c) client = null;
          });
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

  const withRuntimeScope = (params: unknown): unknown => {
    const record = params && typeof params === "object" && !Array.isArray(params)
      ? params as Record<string, unknown>
      : {};
    if (isRuntimeValidatedBuiltInBrowserPersonalScope(params)) {
      return {
        ...record,
        projectRoot: undefined,
        tabCollection: "personal",
      };
    }
    return {
      ...record,
      projectRoot: projectRoot ?? undefined,
      tabCollection: undefined,
    };
  };

  const authenticatedParams = (params: unknown): Record<string, unknown> => {
    const bridgeAuthToken = args.getAuthToken()?.trim() ?? "";
    if (!bridgeAuthToken) {
      throw new Error("Desktop browser bridge authentication is unavailable. Restart ADE Desktop and try again.");
    }
    const scoped = withRuntimeScope(params);
    return {
      ...(scoped && typeof scoped === "object" && !Array.isArray(scoped)
        ? scoped as Record<string, unknown>
        : {}),
      [BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM]: bridgeAuthToken,
    };
  };

  async function callBridge(method: string, params?: unknown, retried = false): Promise<unknown> {
    const requestParams = authenticatedParams(params);
    const c = await ensureClient();
    try {
      return await raceWithTimeout(
        c.request(`built_in_browser.${method}`, requestParams),
        REQUEST_TIMEOUT_MS,
        `Desktop browser bridge call ${method} timed out after ${REQUEST_TIMEOUT_MS}ms.`,
      );
    } catch (error) {
      // Drop the connection on any error so the next call reconnects.
      drop(error);
      if (!retried && isClosedSocketError(error)) {
        return await callBridge(method, params, true);
      }
      throw error;
    }
  }

  const bridge = {
    dispose: () => {
      disposed = true;
      drop();
    },
  };

  return new Proxy(bridge, {
    get(target, property, receiver) {
      if (typeof property === "string" && isBuiltInBrowserDesktopBridgeMethod(property)) {
        return (params?: unknown) => callBridge(property, params);
      }
      return Reflect.get(target, property, receiver);
    },
  }) as BuiltInBrowserDesktopBridgeClient;
}

export async function verifyBuiltInBrowserDesktopBridgeAuth(args: {
  socketPath: string;
  authToken: string;
}): Promise<boolean> {
  const authToken = args.authToken.trim();
  if (!authToken) return false;
  let client: JsonRpcClient | null = null;
  try {
    client = await raceWithTimeout(
      JsonRpcClient.connect(args.socketPath),
      CONNECT_TIMEOUT_MS,
      "Timed out validating desktop browser bridge authentication.",
    );
    const result = await raceWithTimeout(
      client.request("built_in_browser.authenticate", {
        [BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM]: authToken,
      }),
      CONNECT_TIMEOUT_MS,
      "Timed out validating desktop browser bridge authentication.",
    );
    return Boolean(
      result
      && typeof result === "object"
      && (result as { authenticated?: unknown }).authenticated === true
    );
  } catch {
    return false;
  } finally {
    client?.close();
  }
}
