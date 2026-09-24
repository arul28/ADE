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
      for (const listener of listeners) {
        try { listener(key); } catch { /* a listener's failure is its own */ }
      }
    });
    return client;
  };

  return {
    async readPermissions() {
      return readDriverPermissions(await ensureClient().readPermissions());
    },
    async listWindowsForPid(pid) {
      return readDriverWindows(await ensureClient().listWindowsForPid(pid));
    },
    async start(args) {
      await ensureClient().startWindowRecording(args);
    },
    async stop(key) {
      const reply = await ensureClient().stopRecordingByKey(key, { timeoutMs: STOP_TIMEOUT_MS });
      const filePath = typeof reply?.filePath === "string" ? reply.filePath : "";
      return { filePath, ...readLengths(reply ?? {}) };
    },
    onInterrupted(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      listeners.clear();
      unsubscribe?.();
      unsubscribe = null;
      client?.dispose();
      client = null;
    },
  };
}
