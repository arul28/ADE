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
  isBuiltInBrowserDesktopBridgeMethod,
} from "../../../../../ade-cli/src/services/builtInBrowser/desktopBridgeMethods";
import {
  encodeDesktopAudioCaptureError,
  DESKTOP_AUDIO_BRIDGE_METHOD,
  DESKTOP_AUDIO_REQUESTER_LABEL_MAX_CHARS,
  type DesktopAudioCaptureRequest,
  type DesktopAudioCaptureResponse,
} from "../../../../../ade-cli/src/services/audio/desktopAudioBridge";
import {
  encodeDesktopHostError,
  isDesktopHostBridgeMethod,
  DESKTOP_CLIPBOARD_READ_METHOD,
  DESKTOP_CLIPBOARD_WRITE_METHOD,
  DESKTOP_NOTIFY_METHOD,
  DESKTOP_NOTIFY_REQUESTER_LABEL_MAX_CHARS,
  DESKTOP_PICK_FILE_METHOD,
  type DesktopHostBridgeMethod,
  type DesktopNotifyResponse,
  type DesktopPickFileResponse,
} from "../../../../../ade-cli/src/services/desktopHost/desktopHostBridge";
import {
  isPluginAudioCaptureErrorCode,
  PLUGIN_CLIPBOARD_TEXT_MAX_BYTES,
  PLUGIN_FILE_PICKER_EXTENSIONS_MAX,
  PLUGIN_FILE_PICKER_FILTERS_MAX,
  PLUGIN_NOTIFICATION_BODY_MAX_CHARS,
  PLUGIN_NOTIFICATION_TITLE_MAX_CHARS,
  type PluginAudioCaptureErrorCode,
  type PluginHostCapabilityErrorCode,
} from "../../../shared/plugins/sdk";
import type { Logger } from "../logging/logger";
import { resolveBuiltInBrowserActorCapability } from "./builtInBrowserActorCapabilities";
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
  /**
   * Record a clip on a daemon caller's behalf, if this desktop can.
   *
   * Optional so the bridge still starts on a build wired without audio; absent
   * reads as "this desktop has no microphone to lend", which is a refusal the
   * calling plugin can act on rather than a socket that never answers.
   */
  captureAudioClip?: (input: DesktopAudioCaptureRequest) => Promise<DesktopAudioCaptureResponse>;
  /**
   * The Electron-only plugin SDK verbs, if this desktop can serve them.
   *
   * Optional for the same reason `captureAudioClip` is: a bridge started
   * without them answers `desktop_unavailable`, which is a refusal the calling
   * plugin can act on, rather than a socket that accepts a method it cannot
   * perform. They arrive as one bag because they share a lifetime — a desktop
   * either has an Electron main process or it does not.
   */
  hostCapabilities?: {
    readClipboard: () => string;
    writeClipboard: (text: string) => void;
    /** Resolves null when the user dismissed the picker. */
    pickFile: (input: {
      title?: string;
      defaultPath?: string;
      directory?: boolean;
      filters?: { name: string; extensions: string[] }[];
    }) => Promise<string | null>;
    /** Resolves false when this OS has no notification centre to show it in. */
    notify: (input: { title: string; body?: string; requesterLabel?: string }) => boolean;
  };
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

  /**
   * Serve one capture for the daemon's plugin host.
   *
   * No actor capability here, unlike every browser method below: a plugin child
   * has no chat session to be issued one from, and the consent this call needs
   * is not a token — it is the pill the user is looking at while it records.
   * The bridge token is the whole gate, and it is the same one that lets a
   * caller drive the browser.
   *
   * Concurrency is NOT re-checked here. The broker already refuses a second
   * capture (`audio_capture_busy`) because it owns the one microphone and the
   * one pill; a gate here as well could only disagree with it.
   */
  async function handleAudioCapture(rawParams: Record<string, unknown>): Promise<unknown> {
    if (!args.captureAudioClip) {
      throw audioCaptureRefusal("audio_capture_mic_unavailable", "This copy of ADE cannot record audio.");
    }
    const maxDurationMs = typeof rawParams.maxDurationMs === "number"
      && Number.isFinite(rawParams.maxDurationMs)
      && rawParams.maxDurationMs > 0
      ? Math.trunc(rawParams.maxDurationMs)
      : undefined;
    const requesterLabel = normalizedString(rawParams.requesterLabel)
      ?.slice(0, DESKTOP_AUDIO_REQUESTER_LABEL_MAX_CHARS)
      .trim();
    try {
      return await args.captureAudioClip({
        ...(maxDurationMs != null ? { maxDurationMs } : {}),
        ...(requesterLabel ? { requesterLabel } : {}),
      });
    } catch (error) {
      // The recorder's own vocabulary is what the plugin branches on, so a code
      // it named survives; anything else is this process failing and says so.
      const code = (error as { code?: unknown } | null)?.code;
      const message = error instanceof Error ? error.message : String(error);
      throw audioCaptureRefusal(
        isPluginAudioCaptureErrorCode(code) ? code : "audio_capture_failed",
        message || "The recording failed.",
      );
    }
  }

  /**
   * Serve one Electron-only SDK verb for the daemon's plugin host.
   *
   * No actor capability here, matching `handleAudioCapture`: a plugin child has
   * no chat session one could be issued from, and the bridge token is the whole
   * gate. What consent each verb rests on differs, and is worth naming:
   * `dialogs.pickFile` puts a native dialog in front of the user, so the dialog
   * IS the consent and a dismissal is a refusal; `notifications.post` is
   * attributed in the notification itself and rate-limited before it reaches
   * this socket; `clipboard.*` rests on install-time trust alone, which is the
   * same trust that already lets the plugin's un-sandboxed child read any file
   * the user can.
   *
   * Every ceiling is re-applied here rather than trusted from the daemon. The
   * caller is a separate process, and a bound that only exists on the far side
   * of an IPC hop is a bound on well-behaved callers.
   */
  async function handleHostCapability(
    method: DesktopHostBridgeMethod,
    rawParams: Record<string, unknown>,
  ): Promise<unknown> {
    const capabilities = args.hostCapabilities;
    if (!capabilities) {
      throw hostCapabilityRefusal(
        "desktop_unavailable",
        "This copy of ADE cannot serve desktop capabilities.",
      );
    }
    switch (method) {
      case DESKTOP_CLIPBOARD_READ_METHOD: {
        const text = capabilities.readClipboard();
        // Truncated rather than refused: the user's clipboard is not the
        // plugin's doing, and failing a read because somebody copied a large
        // file would be a mystery to both of them.
        return { text: clampUtf8(text ?? "", PLUGIN_CLIPBOARD_TEXT_MAX_BYTES) };
      }
      case DESKTOP_CLIPBOARD_WRITE_METHOD: {
        const text = typeof rawParams.text === "string" ? rawParams.text : "";
        if (Buffer.byteLength(text, "utf8") > PLUGIN_CLIPBOARD_TEXT_MAX_BYTES) {
          throw new JsonRpcError(
            JsonRpcErrorCode.invalidParams,
            `Clipboard text is larger than ${PLUGIN_CLIPBOARD_TEXT_MAX_BYTES} bytes.`,
          );
        }
        capabilities.writeClipboard(text);
        return { ok: true };
      }
      case DESKTOP_PICK_FILE_METHOD: {
        const filePath = await capabilities.pickFile({
          ...(normalizedString(rawParams.title) ? { title: normalizedString(rawParams.title)! } : {}),
          ...(normalizedString(rawParams.defaultPath)
            ? { defaultPath: normalizedString(rawParams.defaultPath)! }
            : {}),
          ...(rawParams.directory === true ? { directory: true } : {}),
          ...(readPickerFilters(rawParams.filters) ? { filters: readPickerFilters(rawParams.filters)! } : {}),
        });
        if (!filePath) {
          throw hostCapabilityRefusal("dialog_cancelled", "The picker was dismissed.");
        }
        return { filePath } satisfies DesktopPickFileResponse;
      }
      case DESKTOP_NOTIFY_METHOD: {
        const title = normalizedString(rawParams.title);
        if (!title) {
          throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "A notification needs a title.");
        }
        const body = normalizedString(rawParams.body);
        const requesterLabel = normalizedString(rawParams.requesterLabel)
          ?.slice(0, DESKTOP_NOTIFY_REQUESTER_LABEL_MAX_CHARS)
          .trim();
        const shown = capabilities.notify({
          title: title.slice(0, PLUGIN_NOTIFICATION_TITLE_MAX_CHARS),
          ...(body ? { body: body.slice(0, PLUGIN_NOTIFICATION_BODY_MAX_CHARS) } : {}),
          ...(requesterLabel ? { requesterLabel } : {}),
        });
        return { shown } satisfies DesktopNotifyResponse;
      }
    }
  }

  async function handleRequest(request: JsonRpcRequest): Promise<unknown> {
    const method = request.method ?? "";
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
    delete rawParams[BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM];
    if (method === DESKTOP_AUDIO_BRIDGE_METHOD) return await handleAudioCapture(rawParams);
    // Below the auth check on purpose: every non-browser method the bridge
    // serves is still a method only an authenticated daemon may reach.
    if (isDesktopHostBridgeMethod(method)) return await handleHostCapability(method, rawParams);
    if (!method.startsWith("built_in_browser.")) {
      throw new JsonRpcError(
        JsonRpcErrorCode.methodNotFound,
        `Unsupported method '${method}'. Desktop bridge only handles built_in_browser.*, ${DESKTOP_AUDIO_BRIDGE_METHOD} and the desktop host capabilities.`,
      );
    }
    const name = method.slice("built_in_browser.".length);
    if (name === "authenticate") {
      return { authenticated: true };
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
    const chatSessionId = normalizedString(rawParams.chatSessionId);
    const actorToken = normalizedString(rawParams[BUILT_IN_BROWSER_ACTOR_CAPABILITY_PARAM]);
    delete rawParams[BUILT_IN_BROWSER_ACTOR_CAPABILITY_PARAM];
    // Validate in the issuing Electron process so opaque capabilities remain
    // revocable without sharing the in-memory registry or its authority with
    // the runtime daemon (which runs in a separate process).
    const actor = resolveBuiltInBrowserActorCapability(actorToken);
    if (!chatSessionId || !actor || actor.chatSessionId !== chatSessionId) {
      throw new JsonRpcError(
        JsonRpcErrorCode.policyDenied,
        "Built-in browser automation requires an issuer-validated chat capability.",
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

/**
 * A refused capture, addressed to the plugin rather than to the bridge.
 *
 * The code rides in the message because that is the only part of a JSON-RPC
 * error that survives `JsonRpcClient`, which rebuilds a rejection from
 * `error.message` alone — see `encodeDesktopAudioCaptureError`. The daemon
 * decodes it back into the code the plugin branches on.
 */
function audioCaptureRefusal(code: PluginAudioCaptureErrorCode, message: string): JsonRpcError {
  return new JsonRpcError(
    JsonRpcErrorCode.internalError,
    encodeDesktopAudioCaptureError(code, message),
  );
}

/**
 * A refused host capability, addressed to the plugin rather than to the bridge.
 *
 * Same encoding as `audioCaptureRefusal` and for the same reason: the code
 * rides in the message because that is the only part of a JSON-RPC error that
 * survives `JsonRpcClient`, which rebuilds a rejection from `error.message`
 * alone.
 */
function hostCapabilityRefusal(code: PluginHostCapabilityErrorCode, message: string): JsonRpcError {
  return new JsonRpcError(JsonRpcErrorCode.internalError, encodeDesktopHostError(code, message));
}

/**
 * Cut a string to a BYTE ceiling without splitting a character in half.
 *
 * `slice` counts UTF-16 units, so a limit applied that way lets a string of
 * emoji through at up to four times the intended size. Cutting the encoded
 * buffer instead can land mid-sequence, which `toString` turns into a
 * replacement character — harmless, and better than a wrong ceiling.
 */
function clampUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  return buffer.subarray(0, maxBytes).toString("utf8");
}

/**
 * Read a file picker's filter list, or nothing.
 *
 * Bounded in both dimensions: the list is rendered as a dropdown in an OS
 * dialog, and a plugin that sent a thousand filters would produce a menu the
 * user cannot use. Malformed entries are dropped rather than refused — a filter
 * is a convenience on a dialog the user is about to see either way.
 */
function readPickerFilters(value: unknown): { name: string; extensions: string[] }[] | null {
  if (!Array.isArray(value)) return null;
  const filters = value
    .slice(0, PLUGIN_FILE_PICKER_FILTERS_MAX)
    .flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const name = normalizedString(entry.name);
      if (!name || !Array.isArray(entry.extensions)) return [];
      // Electron wants extensions WITHOUT a leading dot, but the manifest's
      // `file-viewer` contribution uses the identically-named field WITH one.
      // An author who copies the dotted spelling here would get `*..mp4` in the
      // Windows dialog — a filter matching nothing, with no way out of it.
      const extensions = entry.extensions
        .filter((extension): extension is string => typeof extension === "string" && extension.length > 0)
        .map((extension) => extension.replace(/^\.+/, ""))
        .filter((extension) => extension.length > 0)
        .slice(0, PLUGIN_FILE_PICKER_EXTENSIONS_MAX);
      return extensions.length > 0 ? [{ name, extensions }] : [];
    });
  return filters.length > 0 ? filters : null;
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
