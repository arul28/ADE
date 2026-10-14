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
import { addSentryBreadcrumb, captureError } from "../../shared/sentry/capture";
import { parseCodedErrorMessage } from "../../shared/codedError";
import { isExpectedFailure, isExpectedOutcome } from "../../shared/sentry/expectedFailure";
import { forwardLogToSentry } from "../../shared/sentry/logBridge";

const SLOW_CALL_BREADCRUMB_MS = 250;

type PatchedIpcMain = typeof ipcMain & { __adeSentryWrapped?: boolean };

/**
 * `labelFor` names a call more precisely than its channel when it can (the
 * brain's action channel carries every action); it returns the channel
 * otherwise. Supplied by the caller so this wrapper knows no channel.
 */
export function installIpcErrorCapture(labelFor: (channel: string, args: readonly unknown[]) => string): void {
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
          addSentryBreadcrumb("ipc", labelFor(channel, args), { durationMs, ok: true });
        }
        return result;
      } catch (error) {
        const label = labelFor(channel, args);
        const durationMs = Date.now() - startedAt;
        if (isExpectedOutcome(error)) {
          // An answer ("Lane not found", "Can't reach …"): a Sentry Log, not an issue.
          forwardLogToSentry("warn", `ipc.expected.${label}`, {
            message: error instanceof Error ? error.message : String(error),
            durationMs,
          });
          throw error;
        }
        addSentryBreadcrumb("ipc", label, { durationMs, ok: false }, "error");
        if (!isExpectedFailure(error)) {
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
