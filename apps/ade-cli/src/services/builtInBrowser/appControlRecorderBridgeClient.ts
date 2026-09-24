import fs from "node:fs";
import { JsonRpcClient } from "../../tuiClient/jsonRpcClient";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import type { AppControlScreencastFrame } from "../../../../desktop/src/shared/types/appControl";
import type {
  AppControlRecordingFinish,
  AppControlScreencastRecorderBackend,
} from "../../../../desktop/src/main/services/appControl/appControlRecording";
import { BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM } from "./desktopBridgeMethods";

/**
 * The App Control screencast recorder (Windows and Linux) as the runtime
 * daemon reaches it.
 *
 * The encoder needs a hidden Electron renderer, so it lives in the desktop.
 * The daemon talks to it over the same desktop bridge socket and with the same
 * bridge token as the built-in browser. Methods are
 * `app_control_recorder.<start|pushFrame|stop|cancel>`.
 *
 * Frames: at most one `pushFrame` is in flight per recording. A frame that
 * arrives meanwhile replaces the waiting one, so a slow bridge drops frames
 * instead of building a backlog (the host does the same inside the renderer).
 */

export const APP_CONTROL_RECORDER_BRIDGE_PREFIX = "app_control_recorder.";
export const APP_CONTROL_RECORDER_BRIDGE_METHODS = ["start", "pushFrame", "stop", "cancel"] as const;
export type AppControlRecorderBridgeMethod = (typeof APP_CONTROL_RECORDER_BRIDGE_METHODS)[number];

export function isAppControlRecorderBridgeMethod(name: string): name is AppControlRecorderBridgeMethod {
  return (APP_CONTROL_RECORDER_BRIDGE_METHODS as readonly string[]).includes(name);
}

const CONNECT_TIMEOUT_MS = 3_000;
const CALL_TIMEOUT_MS = 30_000;
/** Stop finalises the file in the renderer and drains the last chunks. */
const STOP_TIMEOUT_MS = 60_000;

export function createAppControlRecorderBridgeClient(args: {
  socketPath: string;
  getAuthToken: () => string | null;
  logger: Logger;
}): AppControlScreencastRecorderBackend & { dispose(): void } {
  const { socketPath, logger } = args;
  const isNamedPipe = socketPath.startsWith("\\\\");
  let client: JsonRpcClient | null = null;
  let connecting: Promise<JsonRpcClient> | null = null;
  let disposed = false;
  const framesInFlight = new Set<string>();
  const pendingFrames = new Map<string, AppControlScreencastFrame>();

  const ensureClient = async (): Promise<JsonRpcClient> => {
    if (disposed) throw new Error("The App Control recorder bridge was disposed.");
    if (client) return client;
    if (!connecting) {
      connecting = (async () => {
        if (!isNamedPipe && !fs.existsSync(socketPath)) {
          throw new Error("App Control recording needs the ADE desktop app on this machine, and none is attached.");
        }
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

  const call = async <T,>(method: AppControlRecorderBridgeMethod, params: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<T> => {
    const token = args.getAuthToken()?.trim();
    if (!token) throw new Error("App Control recording needs the ADE desktop app on this machine, and none is attached.");
    const c = await ensureClient();
    try {
      return await c.request<T>(
        `${APP_CONTROL_RECORDER_BRIDGE_PREFIX}${method}`,
        { ...params, [BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM]: token },
        { timeoutMs },
      );
    } catch (error) {
      if (client === c) {
        client = null;
        try { c.close(); } catch { /* ignore */ }
      }
      throw error;
    }
  };

  const sendFrame = (key: string, frame: AppControlScreencastFrame): void => {
    framesInFlight.add(key);
    void call("pushFrame", { key, frame })
      .catch((error: unknown) => {
        logger.debug("app_control.recorder_bridge.frame_failed", {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        framesInFlight.delete(key);
        const next = pendingFrames.get(key);
        if (next && !disposed) {
          pendingFrames.delete(key);
          sendFrame(key, next);
        }
      });
  };

  return {
    async start(startArgs) {
      return await call<{ filePath: string }>("start", startArgs);
    },
    pushFrame(key, frame) {
      if (disposed || !frame.data) return;
      if (framesInFlight.has(key)) {
        pendingFrames.set(key, frame);
        return;
      }
      sendFrame(key, frame);
    },
    async stop(key) {
      pendingFrames.delete(key);
      return await call<AppControlRecordingFinish>("stop", { key }, STOP_TIMEOUT_MS);
    },
    cancel(key) {
      pendingFrames.delete(key);
      void call("cancel", { key }).catch(() => {});
    },
    dispose() {
      disposed = true;
      pendingFrames.clear();
      if (client) {
        try { client.close(); } catch { /* ignore */ }
        client = null;
      }
    },
  };
}
