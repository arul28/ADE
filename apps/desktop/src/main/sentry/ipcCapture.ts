/**
 * Every failed `ipcMain.handle` call, reported once.
 *
 * A handler that throws reaches the renderer as "Error invoking remote method
 * '<channel>'", and in a packaged build left no trace anywhere else: the IPC
 * trace logger only runs in dev and perf builds. This wraps `ipcMain.handle`
 * before any handler registers (the ones in `main.ts` register before
 * `registerIpc` installs its own wrapper), so each failure becomes one Sentry
 * issue per channel (per runtime action for the brain's action channel) and
 * error type. Slow calls leave a breadcrumb for whatever fails next.
 */
import { ipcMain } from "electron";
import { IPC } from "../../shared/ipc";
import { addSentryBreadcrumb, captureError } from "../../shared/sentry/capture";
import { isUnsupportedAdeActionError, parseCodedErrorMessage } from "../../shared/codedError";
import { readRuntimeActionRequest } from "../services/ipc/ipcTimeouts";

const SLOW_CALL_BREADCRUMB_MS = 250;

type PatchedIpcMain = typeof ipcMain & { __adeSentryWrapped?: boolean };

export function installIpcErrorCapture(): void {
  const target = ipcMain as PatchedIpcMain;
  if (target.__adeSentryWrapped) return;
  target.__adeSentryWrapped = true;
  const originalHandle = ipcMain.handle.bind(ipcMain);
  target.handle = ((channel: string, listener: Parameters<typeof ipcMain.handle>[1]) =>
    originalHandle(channel, async (event, ...args) => {
      const startedAt = Date.now();
      try {
        const result = await listener(event, ...args);
        const durationMs = Date.now() - startedAt;
        if (durationMs >= SLOW_CALL_BREADCRUMB_MS) {
          addSentryBreadcrumb("ipc", channelLabel(channel, args), { durationMs, ok: true });
        }
        return result;
      } catch (error) {
        const label = channelLabel(channel, args);
        const durationMs = Date.now() - startedAt;
        addSentryBreadcrumb("ipc", label, { durationMs, ok: false }, "error");
        // A peer that does not know an action is a version skew, reported by
        // the remote-machine path; it is not a bug in this handler.
        if (!isUnsupportedAdeActionError(error)) {
          const errorName = error instanceof Error ? error.name : "unknown";
          const code = parseCodedErrorMessage(error).code ?? null;
          captureError(error, {
            tags: {
              "ipc.channel": channel,
              ...(label !== channel ? { "runtime.action": label } : {}),
              ...(code ? { "error.code": code } : {}),
            },
            extra: { durationMs },
            fingerprint: ["ipc", label, code ?? errorName],
          });
        }
        throw error;
      }
    })) as typeof ipcMain.handle;
}

/** `localRuntime.callAction` carries every brain action; name the action instead. */
function channelLabel(channel: string, args: readonly unknown[]): string {
  if (channel !== IPC.localRuntimeCallAction) return channel;
  const request = readRuntimeActionRequest(args);
  if (!request) return channel;
  return request.action ? `${request.domain}.${request.action}` : request.domain;
}
