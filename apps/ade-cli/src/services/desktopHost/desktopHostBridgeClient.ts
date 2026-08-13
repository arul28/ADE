import fs from "node:fs";

import { JsonRpcClient } from "../../tuiClient/jsonRpcClient";
import {
  PluginSdkError,
  PLUGIN_CLIPBOARD_TEXT_MAX_BYTES,
  type PluginFilePickerOptions,
} from "../../../../desktop/src/shared/plugins/sdk";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import { BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM } from "../builtInBrowser/desktopBridgeMethods";
import {
  decodeDesktopHostError,
  DESKTOP_CLIPBOARD_READ_METHOD,
  DESKTOP_CLIPBOARD_WRITE_METHOD,
  DESKTOP_NOTIFY_METHOD,
  DESKTOP_PICK_FILE_METHOD,
  DESKTOP_PICK_FILE_TIMEOUT_MS,
  type DesktopClipboardReadResponse,
  type DesktopNotifyResponse,
  type DesktopPickFileResponse,
} from "./desktopHostBridge";

/**
 * The daemon's half of the plugin SDK's Electron-only verbs.
 *
 * A plugin child asks the daemon's plugin host, the host asks this, and this
 * asks the desktop over the side-channel socket. Same shape as
 * `desktopAudioBridgeClient` — including CONNECTION PER CALL. A cached socket
 * buys nothing here: these are one-off interactions minutes apart, and a socket
 * the desktop closed while idle would fail the first call the user's plugin
 * actually made.
 */

const CONNECT_TIMEOUT_MS = 3_000;

export type DesktopHostBridge = {
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  pickFile(options: PluginFilePickerOptions): Promise<string>;
  notify(input: { title: string; body?: string; requesterLabel: string }): Promise<boolean>;
};

/**
 * Every way of discovering there is no desktop says the same sentence: no
 * credential, no socket file, a refused connection. They are one fact to the
 * plugin, and naming the fix is more use to it than naming which check caught it.
 */
function noDesktopAttached(): PluginSdkError {
  return new PluginSdkError(
    "desktop_unavailable",
    "ADE Desktop is not running on this machine.",
  );
}

function connectTimeout(): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(
      () => reject(new PluginSdkError("desktop_unavailable", "ADE Desktop did not answer in time.")),
      CONNECT_TIMEOUT_MS,
    ).unref?.();
  });
}

/**
 * Turn whatever came back into something the plugin can branch on.
 *
 * A refusal the desktop named keeps its code — a cancelled picker stays
 * cancelled. Anything else is the hop itself failing (the socket dropped, the
 * desktop quit mid-call) and reads as `desktop_unavailable`: from the plugin's
 * side the desktop is not there either way, and inventing a more specific code
 * would be a guess about a process that is no longer around to ask.
 */
function asBridgeError(error: unknown): PluginSdkError {
  if (error instanceof PluginSdkError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const decoded = decodeDesktopHostError(message);
  if (decoded) return new PluginSdkError(decoded.code, decoded.message);
  const errno = (error as NodeJS.ErrnoException | null)?.code;
  if (errno === "ENOENT" || errno === "ECONNREFUSED") return noDesktopAttached();
  return new PluginSdkError("desktop_unavailable", `ADE Desktop could not answer: ${message}`);
}

export function createDesktopHostBridge(args: {
  socketPath: string;
  getAuthToken: () => string | null;
  logger: Logger;
}): DesktopHostBridge {
  const { socketPath, logger } = args;
  const isNamedPipe = socketPath.startsWith("\\\\");

  const call = async (
    method: string,
    params: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<unknown> => {
    const authToken = args.getAuthToken()?.trim() ?? "";
    // The daemon holds this credential only while a desktop has handed it over,
    // so an absent one means nothing that owns these APIs is attached.
    if (!authToken) throw noDesktopAttached();
    if (!isNamedPipe && !fs.existsSync(socketPath)) throw noDesktopAttached();

    let client: JsonRpcClient | null = null;
    try {
      client = await Promise.race([JsonRpcClient.connect(socketPath), connectTimeout()]);
      return await client.request(
        method,
        { ...params, [BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM]: authToken },
        options?.timeoutMs != null ? { timeoutMs: options.timeoutMs } : undefined,
      );
    } catch (error) {
      const bridgeError = asBridgeError(error);
      logger.warn("desktop_host_bridge.call_failed", {
        method,
        code: bridgeError.code,
        message: bridgeError.message,
      });
      throw bridgeError;
    } finally {
      // Closing rejects anything still pending on this socket, so a call that
      // already settled can never leave the daemon holding a request the
      // desktop will not answer.
      client?.close();
    }
  };

  return {
    async readClipboard() {
      const result = await call(DESKTOP_CLIPBOARD_READ_METHOD, {});
      const text = (result as Partial<DesktopClipboardReadResponse> | null)?.text;
      // An empty clipboard is a legitimate answer, so a missing field reads as
      // "" rather than an error: a plugin should get "there was nothing to
      // read", not a failure it has to explain to the user.
      return typeof text === "string" ? text : "";
    },

    async writeClipboard(text) {
      await call(DESKTOP_CLIPBOARD_WRITE_METHOD, { text });
    },

    async pickFile(options) {
      const result = await call(
        DESKTOP_PICK_FILE_METHOD,
        {
          ...(options.title ? { title: options.title } : {}),
          ...(options.defaultPath ? { defaultPath: options.defaultPath } : {}),
          ...(options.directory ? { directory: true } : {}),
          ...(options.filters ? { filters: options.filters } : {}),
        },
        // The user may leave a picker open; the bridge's ordinary budget would
        // expire a dialog they were still looking at.
        { timeoutMs: DESKTOP_PICK_FILE_TIMEOUT_MS },
      );
      const filePath = (result as Partial<DesktopPickFileResponse> | null)?.filePath;
      if (typeof filePath !== "string" || !filePath) {
        throw new PluginSdkError("desktop_unavailable", "ADE Desktop answered without a path.");
      }
      return filePath;
    },

    async notify({ title, body, requesterLabel }) {
      const result = await call(DESKTOP_NOTIFY_METHOD, {
        title,
        ...(body ? { body } : {}),
        requesterLabel,
      });
      return (result as Partial<DesktopNotifyResponse> | null)?.shown === true;
    },
  };
}

export { PLUGIN_CLIPBOARD_TEXT_MAX_BYTES };
