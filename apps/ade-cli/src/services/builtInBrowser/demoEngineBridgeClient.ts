import { randomUUID } from "node:crypto";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";
import type {
  DemoAnalysis,
  DemoEngine,
  DemoRenderRequest,
  DemoRenderResult,
} from "../../../../desktop/src/shared/demoVideo/demoContract";
import { isDemoEngineInputPath } from "../../../../desktop/src/main/services/demoVideo/demoMp4Source";
import { createDesktopBridgeConnection } from "./desktopBridgeConnection";

/**
 * The desktop app's Chromium demo engine as the runtime daemon reaches it.
 *
 * The engine needs a hidden Electron renderer (WebCodecs), so it lives in the
 * desktop. The daemon talks to it over the desktop bridge socket with the
 * bridge token, like the App Control recorder. Methods are
 * `demo_engine.<analyze|render|cancel>`; each job carries an id so an abort
 * here cancels it there. The desktop cancels a closed connection's jobs.
 *
 * Progress is not relayed: `onProgress` is not called over the bridge.
 */

export const DEMO_ENGINE_BRIDGE_PREFIX = "demo_engine.";
export const DEMO_ENGINE_BRIDGE_METHODS = ["analyze", "render", "cancel"] as const;
export type DemoEngineBridgeMethod = (typeof DEMO_ENGINE_BRIDGE_METHODS)[number];

export function isDemoEngineBridgeMethod(name: string): name is DemoEngineBridgeMethod {
  return (DEMO_ENGINE_BRIDGE_METHODS as readonly string[]).includes(name);
}

/** Above the engine's own 30-minute cap, so the desktop's clearer error arrives first. */
const JOB_TIMEOUT_MS = 35 * 60_000;
const CANCEL_TIMEOUT_MS = 5_000;

export function createDemoEngineBridgeClient(args: {
  socketPath: string;
  logger: Logger;
}): DemoEngine & { dispose(): void } {
  const { logger } = args;
  const NO_DESKTOP = "Rendering this demo needs the ADE desktop app on this machine, and none is attached.";
  const connection = createDesktopBridgeConnection({
    socketPath: args.socketPath,
    unavailableMessage: NO_DESKTOP,
    closedMessage: "The demo engine bridge was disposed.",
  });

  const call = <T,>(method: DemoEngineBridgeMethod, params: Record<string, unknown>, timeoutMs: number): Promise<T> =>
    connection.request<T>(`${DEMO_ENGINE_BRIDGE_PREFIX}${method}`, params, timeoutMs);

  /** Runs one job; an abort cancels it on the desktop and rejects here at once. */
  const runJob = <T,>(method: "analyze" | "render", params: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
    if (signal?.aborted) return Promise.reject(new Error("The demo render was cancelled."));
    const jobId = randomUUID();
    const job = call<T>(method, { ...params, jobId }, JOB_TIMEOUT_MS);
    if (!signal) return job;
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        void call("cancel", { jobId }, CANCEL_TIMEOUT_MS).catch((error: unknown) => {
          logger.debug("demo_engine_bridge.cancel_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
        reject(new Error("The demo render was cancelled."));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      job.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  };

  return {
    id: "chromium",
    // The desktop's engine reads an `.aderaw` capture or an H.264 MP4.
    canRead: isDemoEngineInputPath,
    analyze: (inputPath, options = {}) =>
      runJob<DemoAnalysis>("analyze", { input: inputPath }, options.signal),
    render: (request: DemoRenderRequest, options = {}) =>
      runJob<DemoRenderResult>("render", { request }, options.signal),
    dispose() {
      connection.close();
    },
  };
}
