/**
 * macOS window recording for App Control, through `ade-desktop-driver`.
 *
 * App Control runs its own helper process rather than borrowing Mac Desktop's.
 * The helper is spawned on the first recording only, speaks the same NDJSON
 * protocol, and dies with this runtime. Keeping it separate means Mac Desktop's
 * display reconciliation and its `recording-changed` events never see an App
 * Control recording, and App Control needs nothing from the Mac Desktop
 * service's construction order.
 */

import type { Logger } from "../logging/logger";
import { resolveMacDesktopDriverBinary } from "../native/nativeHelperPaths";
import {
  createMacDesktopDriverClient,
  type MacDesktopDriverClient,
} from "../macDesktop/macDesktopDriverClient";
import { readLengths } from "../macDesktop/macDesktopRecording";
import {
  readDriverPermissions,
  readDriverWindows,
  type AppControlWindowRecorder,
} from "./appControlRecording";

/** `record.stop` can take the helper's whole finalize budget plus a slow reply. */
const STOP_TIMEOUT_MS = 30_000;

export function createAppControlWindowRecorder(deps: {
  logger: Logger;
  platform?: NodeJS.Platform;
  /** Test seam. Defaults to a client for the bundled helper. */
  createClient?: (() => MacDesktopDriverClient) | null;
}): AppControlWindowRecorder | null {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") return null;
  let client: MacDesktopDriverClient | null = null;
  let unsubscribe: (() => void) | null = null;
  const listeners = new Set<(key: string) => void>();
  /** Window recordings the helper is running, by key: the helper must stay for them. */
  const recordingKeys = new Set<string>();
  /** Calls that are using the helper now. */
  let callsInFlight = 0;
  const withClient = async <T>(run: (current: MacDesktopDriverClient) => Promise<T>): Promise<T> => {
    callsInFlight += 1;
    try {
      return await run(ensureClient());
    } finally {
      callsInFlight -= 1;
    }
  };

  const ensureClient = (): MacDesktopDriverClient => {
    if (client) return client;
    client = deps.createClient
      ? deps.createClient()
      : createMacDesktopDriverClient({
        logger: deps.logger,
        platform,
        resolveExecutablePath: () => resolveMacDesktopDriverBinary({ platform, logger: deps.logger }),
      });
    unsubscribe = client.onEvent((event) => {
      if (event.event !== "recording-interrupted") return;
      const key = typeof event.laneId === "string" ? event.laneId : "";
      if (!key) return;
      recordingKeys.delete(key);
      for (const listener of listeners) {
        try { listener(key); } catch { /* a listener's failure is its own */ }
      }
    });
    return client;
  };

  return {
    async readPermissions() {
      return readDriverPermissions(await withClient((current) => current.readPermissions()));
    },
    async listWindowsForPid(pid) {
      return readDriverWindows(await withClient((current) => current.listWindowsForPid(pid)));
    },
    async start(args) {
      // Counted before the call: a release while the start is in flight would
      // take the recording's helper with it.
      recordingKeys.add(args.key);
      try {
        await withClient((current) => current.startWindowRecording(args));
      } catch (error) {
        recordingKeys.delete(args.key);
        throw error;
      }
    },
    async stop(key) {
      try {
        const reply = await withClient((current) => current.stopRecordingByKey(key, { timeoutMs: STOP_TIMEOUT_MS }));
        const filePath = typeof reply?.filePath === "string" ? reply.filePath : "";
        return { filePath, ...readLengths(reply ?? {}) };
      } finally {
        recordingKeys.delete(key);
      }
    },
    onInterrupted(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    releaseIdle() {
      if (!client || recordingKeys.size > 0 || callsInFlight > 0) return false;
      // The interruption listeners stay: they belong to App Control, and the
      // next client is subscribed to them again in `ensureClient`.
      unsubscribe?.();
      unsubscribe = null;
      client.dispose();
      client = null;
      deps.logger.info("app_control.window_recorder_released_idle", {});
      return true;
    },
    dispose() {
      recordingKeys.clear();
      listeners.clear();
      unsubscribe?.();
      unsubscribe = null;
      client?.dispose();
      client = null;
    },
  };
}
