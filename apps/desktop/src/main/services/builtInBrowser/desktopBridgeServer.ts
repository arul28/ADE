import fs from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  JsonRpcError,
  JsonRpcErrorCode,
  startJsonRpcServer,
  type JsonRpcRequest,
  type JsonRpcServerErrorContext,
  type JsonRpcTransport,
} from "../../../../../ade-cli/src/jsonrpc";
import {
  BUILT_IN_BROWSER_ACTOR_CAPABILITY_PARAM,
  BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM,
  BUILT_IN_BROWSER_ISSUE_ACTOR_CAPABILITY_METHOD,
  BUILT_IN_BROWSER_REVOKE_ACTOR_CAPABILITY_METHOD,
  isBuiltInBrowserDesktopBridgeMethod,
} from "../../../../../ade-cli/src/services/builtInBrowser/desktopBridgeMethods";
import type { Logger } from "../logging/logger";
import {
  issueBuiltInBrowserActorCapability,
  resolveBuiltInBrowserActorCapability,
  revokeBuiltInBrowserActorCapability,
} from "./builtInBrowserActorCapabilities";
import type { BuiltInBrowserService } from "./builtInBrowserService";
import { localIpcListenOptions } from "../../../../../ade-cli/src/services/runtime/localIpcListenOptions";

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

export type BuiltInBrowserDesktopBridgeServer = {
  socketPath: string;
  authToken: string;
  dispose: () => void;
};

export function startBuiltInBrowserDesktopBridgeServer(args: {
  socketPath: string;
  service: BuiltInBrowserService;
  logger: Logger;
}): BuiltInBrowserDesktopBridgeServer {
  const { socketPath, service, logger } = args;
  const isNamedPipe = socketPath.startsWith("\\\\");
  const bridgeAuthToken = randomBytes(32).toString("base64url");

  if (!isNamedPipe) {
    const socketDir = path.dirname(socketPath);
    try {
      const existed = fs.existsSync(socketDir);
      fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
      if (!isSystemTempDir(socketDir) || !existed) {
        fs.chmodSync(socketDir, 0o700);
      }
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

  server.on("error", (error) => {
    logger.error("built_in_browser_bridge.server_error", {
      socketPath,
      reason: error instanceof Error ? error.message : String(error),
    });
  });

  try {
    server.listen(localIpcListenOptions(socketPath), () => {
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
    const rawParams = isRecord(request.params) ? { ...request.params } : {};
    const providedBridgeAuth = typeof rawParams[BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM] === "string"
      ? rawParams[BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM].trim()
      : "";
    if (!safeTokenEquals(providedBridgeAuth, bridgeAuthToken)) {
      throw new JsonRpcError(
        JsonRpcErrorCode.policyDenied,
        "Built-in browser bridge authentication failed.",
      );
    }
    if (name === "authenticate") {
      return { authenticated: true };
    }
    // Capability lifecycle. Electron owns the registry, so the runtime daemon
    // asks for the per-chat token here rather than minting one in its own
    // process (where nothing could ever validate it). Bridge auth is the only
    // gate: the caller is the runtime that already decides which lane, project
    // and chat an agent belongs to. No actor capability is required — this is
    // where they come from.
    if (name === BUILT_IN_BROWSER_ISSUE_ACTOR_CAPABILITY_METHOD) {
      const requestedChatSessionId = normalizedString(rawParams.chatSessionId);
      if (!requestedChatSessionId) {
        throw new JsonRpcError(
          JsonRpcErrorCode.invalidParams,
          "Browser actor capabilities require a chat session id.",
        );
      }
      const tabCollection = rawParams.tabCollection === "personal" ? "personal" : null;
      const token = issueBuiltInBrowserActorCapability({
        chatSessionId: requestedChatSessionId,
        laneId: normalizedString(rawParams.laneId),
        projectRoot: tabCollection === "personal"
          ? null
          : normalizedString(rawParams.projectRoot),
        tabCollection,
      });
      return { token };
    }
    if (name === BUILT_IN_BROWSER_REVOKE_ACTOR_CAPABILITY_METHOD) {
      const requestedChatSessionId = normalizedString(rawParams.chatSessionId);
      if (!requestedChatSessionId) {
        throw new JsonRpcError(
          JsonRpcErrorCode.invalidParams,
          "Browser actor capabilities require a chat session id.",
        );
      }
      revokeBuiltInBrowserActorCapability(requestedChatSessionId);
      return { revoked: true };
    }
    if (
      name === "getProfileDiagnostics"
      || name === "listPermissions"
      || name === "clearPermissions"
    ) {
      throw new JsonRpcError(
        JsonRpcErrorCode.policyDenied,
        `Action 'built_in_browser.${name}' is only available to the trusted ADE renderer.`,
      );
    }
    if (!isBuiltInBrowserDesktopBridgeMethod(name)) {
      throw new JsonRpcError(
        JsonRpcErrorCode.methodNotFound,
        `Action 'built_in_browser.${name}' is not exposed by the desktop bridge.`,
      );
    }
    delete rawParams[BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM];
    const chatSessionId = normalizedString(rawParams.chatSessionId);
    const actorToken = normalizedString(rawParams[BUILT_IN_BROWSER_ACTOR_CAPABILITY_PARAM]);
    delete rawParams[BUILT_IN_BROWSER_ACTOR_CAPABILITY_PARAM];
    // Validate in the issuing Electron process so opaque capabilities remain
    // revocable without sharing the in-memory registry or its authority with
    // the runtime daemon (which runs in a separate process).
    const actor = resolveBuiltInBrowserActorCapability(actorToken);
    if (!actorToken || !chatSessionId) {
      throw new JsonRpcError(
        JsonRpcErrorCode.policyDenied,
        "Built-in browser automation needs a chat capability, and this caller has none. `ade browser` only works from a chat or terminal that ADE launched — open ADE Desktop with this project and start the chat from there.",
      );
    }
    if (!actor) {
      throw new JsonRpcError(
        JsonRpcErrorCode.policyDenied,
        "This chat's browser capability is no longer valid — it was revoked when the chat ended, or ADE Desktop restarted after issuing it. Relaunch this chat from ADE Desktop.",
      );
    }
    if (actor.chatSessionId !== chatSessionId) {
      throw new JsonRpcError(
        JsonRpcErrorCode.policyDenied,
        "This browser capability belongs to a different chat session than the one making the call. Relaunch this chat from ADE Desktop.",
      );
    }
    const params = {
      ...rawParams,
      chatSessionId: actor.chatSessionId,
      laneId: actor.laneId ?? undefined,
      ...(actor.projectRoot
        ? { projectRoot: actor.projectRoot, tabCollection: undefined }
        : { projectRoot: undefined, tabCollection: actor.tabCollection }),
      force: false,
    };
    const callable = (service as unknown as Record<string, unknown>)[name];
    if (typeof callable !== "function") {
      throw new JsonRpcError(
        JsonRpcErrorCode.methodNotFound,
        `Desktop bridge cannot dispatch built_in_browser.${name}.`,
      );
    }
    try {
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
    authToken: bridgeAuthToken,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeTokenEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isSystemTempDir(dirPath: string): boolean {
  const normalized = path.resolve(dirPath);
  return normalized === path.resolve(os.tmpdir())
    || normalized === "/tmp"
    || normalized === "/private/tmp";
}
