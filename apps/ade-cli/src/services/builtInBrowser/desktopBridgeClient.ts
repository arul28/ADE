import fs from "node:fs";
import path from "node:path";
import { JsonRpcClient } from "../../tuiClient/jsonRpcClient";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import type { BrowserActorCapabilityIssuer } from "../../../../desktop/src/main/services/builtInBrowser/builtInBrowserActorCapabilities";
import {
  BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM,
  isBuiltInBrowserActorCapabilityMethod,
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
 * The connection is lazy. If no desktop is running, the first call throws
 * `DesktopBridgeUnavailableError` and the daemon stays functional for every
 * other domain. Reconnection on next call is automatic when the desktop comes
 * back. `remoteBrowserForwarder` catches that one error class for the three
 * "put this URL on a screen" methods and hands them to a desktop that has this
 * machine's lane pinned instead.
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

/**
 * No desktop is listening on this machine's bridge socket.
 *
 * Distinguished from every other bridge failure because it is the one case with
 * a working alternative: a desktop pinned to this machine from somewhere else
 * can open the URL in ITS browser over a port-forward, so `ade browser open`
 * forwards instead of failing (see `remoteBrowserForwarder`).
 */
export class DesktopBridgeUnavailableError extends Error {
  readonly socketPath: string;

  constructor(socketPath: string, message: string) {
    super(message);
    this.name = "DesktopBridgeUnavailableError";
    this.socketPath = socketPath;
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
      throw new DesktopBridgeUnavailableError(
        socketPath,
        `No ADE Desktop browser is attached to this machine (bridge socket ${socketPath} is not listening). The built-in browser runs inside ADE Desktop, so browser actions need a desktop attached here. \`ade browser open <url>\` is the exception: it forwards the URL to a desktop that has this lane pinned, which reaches this machine's localhost ports over a tunnel.`,
      );
    }
    try {
      return await raceWithTimeout(
        JsonRpcClient.connect(socketPath),
        CONNECT_TIMEOUT_MS,
        `Timed out connecting to desktop browser bridge at ${socketDescription}.`,
      );
    } catch (error) {
      // A stale socket file (desktop crashed) refuses the connection rather
      // than being absent, so it is the same "no desktop here" condition.
      throw new DesktopBridgeUnavailableError(
        socketPath,
        `Could not reach an ADE Desktop browser on this machine (${socketDescription}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
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
    return {
      ...record,
      projectRoot: projectRoot ?? undefined,
      tabCollection: undefined,
    };
  };

  const authenticatedParams = (
    params: unknown,
    opts: { applyRuntimeScope: boolean },
  ): Record<string, unknown> => {
    const bridgeAuthToken = args.getAuthToken()?.trim() ?? "";
    if (!bridgeAuthToken) {
      throw new Error("Desktop browser bridge authentication is unavailable. Restart ADE Desktop and try again.");
    }
    // Capability issuance carries the scope of the chat being launched, which
    // may be a personal (project-less) chat or a lane in another project. It
    // must not be rewritten to the daemon's own project root.
    const scoped = opts.applyRuntimeScope ? withRuntimeScope(params) : params;
    return {
      ...(scoped && typeof scoped === "object" && !Array.isArray(scoped)
        ? scoped as Record<string, unknown>
        : {}),
      [BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM]: bridgeAuthToken,
    };
  };

  async function callBridge(method: string, params?: unknown, retried = false): Promise<unknown> {
    const requestParams = authenticatedParams(params, {
      applyRuntimeScope: !isBuiltInBrowserActorCapabilityMethod(method),
    });
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
      if (
        typeof property === "string"
        && (isBuiltInBrowserDesktopBridgeMethod(property)
          || isBuiltInBrowserActorCapabilityMethod(property))
      ) {
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

/**
 * Daemon-side issuer for per-chat browser actor capabilities.
 *
 * The capability registry lives in Electron main — the only process that can
 * validate a token — so the runtime daemon has the desktop mint and revoke
 * them over the authenticated bridge instead of writing to a registry nothing
 * downstream can read. With no bridge (headless machine, chat-only runtime)
 * `issue` resolves to `null` and the caller omits `ADE_BROWSER_ACTOR_TOKEN`.
 */
export function createBridgeBrowserActorCapabilityIssuer(args: {
  getBridge: () => BuiltInBrowserDesktopBridgeClient | null;
}): BrowserActorCapabilityIssuer {
  return {
    issue: async (capability) => {
      const bridge = args.getBridge();
      if (!bridge) return null;
      const result = await bridge.issueActorCapability({
        chatSessionId: capability.chatSessionId,
        laneId: capability.laneId,
        projectRoot: capability.projectRoot,
        tabCollection: capability.tabCollection,
      });
      return result?.token?.trim() || null;
    },
    revoke: async (chatSessionId) => {
      const bridge = args.getBridge();
      if (!bridge) return;
      await bridge.revokeActorCapability({ chatSessionId });
    },
  };
}
