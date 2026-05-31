import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  JsonRpcError,
  JsonRpcErrorCode,
  startJsonRpcServer,
  type JsonRpcRequest,
  type JsonRpcServerErrorContext,
  type JsonRpcTransport,
} from "../../../../../ade-cli/src/jsonrpc";
import type { Logger } from "../logging/logger";
import type { BuiltInBrowserService } from "./builtInBrowserService";

/**
 * Side-channel JSON-RPC server that exposes the desktop's
 * `BuiltInBrowserService` to the runtime daemon. The daemon proxies
 * `ade browser …` CLI calls through this socket because it cannot host
 * `BuiltInBrowserService` itself (Electron-only APIs).
 *
 * Methods are addressed as `built_in_browser.<allowlistedName>`. Anything
 * outside the allowlist returns `methodNotFound` so a daemon bug or
 * out-of-date desktop doesn't accidentally expose private internals.
 */

const ALLOWED_METHODS = new Set([
  "getStatus",
  "claim",
  "showPanel",
  "setBounds",
  "navigate",
  "createTab",
  "switchTab",
  "closeTab",
  "reload",
  "goBack",
  "goForward",
  "stop",
  "startInspect",
  "stopInspect",
  "captureScreenshot",
  "selectPoint",
  "selectCurrent",
  "clearSelection",
]);

export type BuiltInBrowserDesktopBridgeServer = {
  socketPath: string;
  dispose: () => void;
};

export function startBuiltInBrowserDesktopBridgeServer(args: {
  socketPath: string;
  service: BuiltInBrowserService;
  logger: Logger;
  umask?: (mask?: number) => number;
}): BuiltInBrowserDesktopBridgeServer {
  const { socketPath, service, logger } = args;
  const isNamedPipe = socketPath.startsWith("\\\\");

  if (!isNamedPipe) {
    const socketDir = path.dirname(socketPath);
    try {
      fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(socketDir, 0o700);
    } catch (error) {
      logger.warn("built_in_browser_bridge.sockdir_create_failed", {
        socketPath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // ignore — only succeeds if a stale socket file exists
    }
  }

  const activeServerHandles = new Set<() => void>();
  const activeSockets = new Set<net.Socket>();

  const server = net.createServer((conn) => {
    activeSockets.add(conn);
    const transport: JsonRpcTransport = {
      onData(callback) {
        conn.on("data", callback);
      },
      write(data) {
        conn.write(data);
      },
      close() {
        if (!conn.destroyed) conn.destroy();
      },
    };
    const stop = startJsonRpcServer(handleRequest, transport, {
      nonFatal: true,
      onError(error: unknown, context: JsonRpcServerErrorContext) {
        logger.warn("built_in_browser_bridge.contained_rpc_error", {
          context,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    });
    activeServerHandles.add(stop);
    conn.on("close", () => {
      activeSockets.delete(conn);
      activeServerHandles.delete(stop);
      stop();
    });
    conn.on("error", () => {
      // ignore per-connection errors; they are surfaced via the JSON-RPC frame.
    });
  });

  let restoreSocketUmask: (() => void) | null = null;
  if (!isNamedPipe && process.platform !== "win32") {
    const setUmask = args.umask ?? process.umask.bind(process);
    try {
      const previousUmask = setUmask(0o177);
      let restored = false;
      restoreSocketUmask = () => {
        if (restored) return;
        restored = true;
        setUmask(previousUmask);
      };
    } catch (error) {
      logger.warn("built_in_browser_bridge.sock_umask_failed", {
        socketPath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  server.on("error", (error) => {
    restoreSocketUmask?.();
    logger.error("built_in_browser_bridge.server_error", {
      socketPath,
      reason: error instanceof Error ? error.message : String(error),
    });
  });

  try {
    server.listen(socketPath, () => {
      restoreSocketUmask?.();
      if (!isNamedPipe) {
        try {
          fs.chmodSync(socketPath, 0o600);
        } catch (error) {
          logger.warn("built_in_browser_bridge.sock_chmod_failed", {
            socketPath,
            reason: error instanceof Error ? error.message : String(error),
          });
          try {
            server.close();
          } catch {
            // ignore close failures after chmod failure
          }
          return;
        }
      }
      logger.info("built_in_browser_bridge.listening", { socketPath });
    });
  } catch (error) {
    restoreSocketUmask?.();
    throw error;
  }

  async function handleRequest(request: JsonRpcRequest): Promise<unknown> {
    const method = request.method ?? "";
    if (!method.startsWith("built_in_browser.")) {
      throw new JsonRpcError(
        JsonRpcErrorCode.methodNotFound,
        `Unsupported method '${method}'. Desktop bridge only handles built_in_browser.*`,
      );
    }
    const name = method.slice("built_in_browser.".length);
    if (!ALLOWED_METHODS.has(name)) {
      throw new JsonRpcError(
        JsonRpcErrorCode.methodNotFound,
        `Action 'built_in_browser.${name}' is not exposed by the desktop bridge.`,
      );
    }
    const callable = (service as unknown as Record<string, unknown>)[name];
    if (typeof callable !== "function") {
      throw new JsonRpcError(
        JsonRpcErrorCode.methodNotFound,
        `Desktop bridge cannot dispatch built_in_browser.${name}.`,
      );
    }
    const params = request.params;
    try {
      // The real service methods accept either an args object or no args at all.
      if (params === undefined) {
        return await (callable as () => Promise<unknown>).call(service);
      }
      return await (callable as (input: unknown) => Promise<unknown>).call(service, params);
    } catch (error) {
      if (error instanceof JsonRpcError) throw error;
      throw new JsonRpcError(
        JsonRpcErrorCode.internalError,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return {
    socketPath,
    dispose: () => {
      for (const stop of activeServerHandles) {
        try {
          stop();
        } catch {
          // ignore
        }
      }
      activeServerHandles.clear();
      for (const sock of activeSockets) {
        try {
          sock.destroy();
        } catch {
          // ignore
        }
      }
      activeSockets.clear();
      try {
        server.close();
      } catch {
        // ignore
      }
      if (!isNamedPipe) {
        try {
          fs.unlinkSync(socketPath);
        } catch {
          // ignore
        }
      }
    },
  };
}
