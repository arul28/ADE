/**
 * Every failed `ipcMain.handle` call, reported once.
 *
 * A handler that throws reaches the renderer as "Error invoking remote method
 * '<channel>'", and in a packaged build left no trace anywhere else: the IPC
 * trace logger only runs in dev and perf builds. This wraps `ipcMain.handle`
 * before any handler registers (the ones in `main.ts` register before
 * `registerIpc` installs its own wrapper), so each failure becomes one Sentry
 * issue per channel and error type (for the brain's action channels, per
 * error and normalized message, with the action as a tag). Slow calls leave a
 * breadcrumb for whatever fails next.
 */
import { app, ipcMain, powerMonitor } from "electron";
import { addSentryBreadcrumb, captureError } from "../../shared/sentry/capture";
import { parseCodedErrorMessage } from "../../shared/codedError";
import { isExpectedFailure, isExpectedOutcome } from "../../shared/sentry/expectedFailure";
import { runtimeActionFingerprint } from "../../shared/sentry/grouping";
import { forwardLogToSentry } from "../../shared/sentry/logBridge";
import { runInCapturedIpcCall } from "./ipcCallScope";

const SLOW_CALL_BREADCRUMB_MS = 250;

type PatchedIpcMain = typeof ipcMain & { __adeSentryWrapped?: boolean };

const IPC_TIMEOUT_MESSAGE = /^IPC handler for '[^']+' timed out after (\d+)ms\b/;

/**
 * When the machine last woke from sleep. `powerMonitor` only works once the
 * app is ready, and this wrapper installs before that, so the listener is
 * added by the first call made after ready.
 */
let lastResumeAt = 0;
let watchingResume = false;

function watchResume(): void {
  if (watchingResume || !app.isReady()) return;
  watchingResume = true;
  powerMonitor.on("resume", () => {
    lastResumeAt = Date.now();
  });
}

/** Asleep this long during one call means the call straddled a sleep. */
const SLEPT_DURING_CALL_MS = 5_000;

/**
 * A timeout whose call straddled a sleep: nothing hung, the machine was off.
 *
 * Two signals, because the `resume` event alone misses most of them: on wake,
 * the overdue timer fires before `resume` is delivered, and a dark wake
 * (Power Nap) emits no `resume` at all. Timers and `performance.now()` run on
 * the monotonic clock, which stops while macOS sleeps; the wall clock does
 * not. A gap between the two is time spent asleep (Sentry saw 30s timeouts
 * reported 5 to 55 minutes after the call began). Where the monotonic clock
 * counts sleep, the gap stays 0 and only the `resume` check applies.
 */
function sleptThroughTimeout(error: unknown, startedAt: number, startedMono: number): boolean {
  const limitMs = Number(IPC_TIMEOUT_MESSAGE.exec(error instanceof Error ? error.message : "")?.[1]);
  if (!(limitMs > 0)) return false;
  if (lastResumeAt >= startedAt + limitMs) return true;
  const asleepMs = (Date.now() - startedAt) - (performance.now() - startedMono);
  return asleepMs >= SLEPT_DURING_CALL_MS;
}

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
      const startedMono = performance.now();
      watchResume();
      try {
        const result = await runInCapturedIpcCall(() => listener(event, ...args));
        const durationMs = Date.now() - startedAt;
        if (durationMs >= SLOW_CALL_BREADCRUMB_MS) {
          addSentryBreadcrumb("ipc", labelFor(channel, args), { durationMs, ok: true });
        }
        return result;
      } catch (error) {
        const label = labelFor(channel, args);
        const durationMs = Date.now() - startedAt;
        if (isExpectedOutcome(error) || sleptThroughTimeout(error, startedAt, startedMono)) {
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
            // A runtime action's failure is rebuilt from the brain's reply and
            // has no stack of its own: group it by what failed, not by which
            // action hit it, or one fault is an issue per screen that asked.
            fingerprint: label !== channel ? runtimeActionFingerprint(error) : ["ipc", label, code ?? errorName],
          });
        }
        throw error;
      }
    })) as typeof ipcMain.handle;
}
