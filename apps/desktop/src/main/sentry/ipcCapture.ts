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
import { app, BrowserWindow, ipcMain, powerMonitor } from "electron";
import { addSentryBreadcrumb, captureError } from "../../shared/sentry/capture";
import { parseCodedErrorMessage } from "../../shared/codedError";
import { isExpectedFailure, isExpectedOutcome } from "../../shared/sentry/expectedFailure";
import { runtimeActionFingerprint } from "../../shared/sentry/grouping";
import { IPC } from "../../shared/ipc";
import { forwardLogToSentry } from "../../shared/sentry/logBridge";
import { runInCapturedIpcCall } from "./ipcCallScope";

const SLOW_CALL_BREADCRUMB_MS = 250;

type PatchedIpcMain = typeof ipcMain & { __adeSentryWrapped?: boolean };

const IPC_TIMEOUT_MESSAGE = /^IPC handler for '[^']+' timed out after (\d+)ms\b/;

/**
 * When the machine last went to sleep and last woke. `powerMonitor` only
 * works once the app is ready, and this wrapper installs before that, so the
 * listeners are added by the first call made after ready.
 */
let lastSuspendAt = 0;
let lastResumeAt = 0;
let watchingResume = false;

function watchPowerEvents(): void {
  if (watchingResume || !app.isReady()) return;
  watchingResume = true;
  powerMonitor.on("suspend", () => {
    lastSuspendAt = Date.now();
  });
  powerMonitor.on("resume", () => {
    lastResumeAt = Date.now();
  });
}

/** Asleep this long during one call means the call straddled a sleep. */
const SLEPT_DURING_CALL_MS = 5_000;

/** The deadline an IPC timeout names, or null when the error is not one. */
function ipcTimeoutLimitMs(error: unknown): number | null {
  const limitMs = Number(IPC_TIMEOUT_MESSAGE.exec(error instanceof Error ? error.message : "")?.[1]);
  return limitMs > 0 ? limitMs : null;
}

/**
 * A timeout whose call straddled a sleep: nothing hung, the machine was off.
 *
 * Three signals, because the `resume` event alone misses most of them: on
 * wake, the overdue timer fires before `resume` is delivered, and a dark wake
 * (Power Nap) emits no `resume` at all. `suspend` comes before the sleep, so
 * it is already known when the timer fires (Sentry saw 10-minute timeouts
 * fire 3 to 11 minutes late with no `resume` yet). Timers and
 * `performance.now()` run on the monotonic clock, which stops while macOS
 * sleeps; the wall clock does not. A gap between the two is time spent asleep
 * (Sentry saw 30s timeouts reported 5 to 55 minutes after the call began).
 * Where the monotonic clock counts sleep, the gap stays 0 and only the event
 * checks apply.
 */
function sleptThroughTimeout(error: unknown, startedAt: number, startedMono: number): boolean {
  const limitMs = ipcTimeoutLimitMs(error);
  if (limitMs == null) return false;
  if (lastResumeAt >= startedAt + limitMs) return true;
  if (lastSuspendAt >= startedAt) return true;
  const asleepMs = (Date.now() - startedAt) - (performance.now() - startedMono);
  return asleepMs >= SLEPT_DURING_CALL_MS;
}

/**
 * What a reported timeout needs to tell a hang from a machine that was not
 * running ADE: how late the timer fired (a timer fires late only when the
 * process did not run, or its main thread was blocked), the sleep signals,
 * and whether anyone was looking at ADE (macOS throttles a hidden app).
 */
function timeoutDiagnostics(limitMs: number, startedAt: number, startedMono: number): Record<string, unknown> {
  const now = Date.now();
  const elapsedMs = now - startedAt;
  let systemIdleSec: number | null = null;
  let windowVisible: boolean | null = null;
  try {
    systemIdleSec = powerMonitor.getSystemIdleTime();
    windowVisible = BrowserWindow.getAllWindows().some((window) => window.isVisible() && !window.isMinimized());
  } catch {
    // Diagnostics only.
  }
  return {
    limitMs,
    lateMs: elapsedMs - limitMs,
    monotonicGapMs: Math.round(elapsedMs - (performance.now() - startedMono)),
    sinceSuspendSec: lastSuspendAt ? Math.round((now - lastSuspendAt) / 1000) : null,
    sinceResumeSec: lastResumeAt ? Math.round((now - lastResumeAt) / 1000) : null,
    systemIdleSec,
    windowVisible,
  };
}

/**
 * Calls that wait on one thing (a stream's connection, the brain) time out
 * together: 4 or 5 in the same second. The first is the report; the rest are
 * Sentry Logs, so one stall costs one event.
 */
const TIMEOUT_BURST_MS = 10_000;
const lastTimeoutReportAt = new Map<string, number>();

function isTimeoutBurstRepeat(label: string, now: number): boolean {
  const last = lastTimeoutReportAt.get(label);
  // `now >= last`: a clock set back must not hold every later timeout as a repeat.
  if (last != null && now >= last && now - last < TIMEOUT_BURST_MS) return true;
  lastTimeoutReportAt.set(label, now);
  return false;
}

/** The channels that carry every brain action; `labelFor` names the action. */
const RUNTIME_ACTION_CHANNELS: ReadonlySet<string> = new Set([IPC.localRuntimeCallAction, IPC.remoteRuntimeCallAction]);

/**
 * `labelFor` names a call more precisely than its channel when it can (the
 * brain's action channels carry every action); it returns the channel
 * otherwise. Supplied by the caller, which knows how each channel's args
 * name the call.
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
      watchPowerEvents();
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
        const timeoutLimitMs = ipcTimeoutLimitMs(error);
        if (timeoutLimitMs != null && isTimeoutBurstRepeat(label, Date.now())) {
          forwardLogToSentry("warn", `ipc.timeout_repeat.${label}`, { durationMs });
          throw error;
        }
        if (!isExpectedFailure(error)) {
          const errorName = error instanceof Error ? error.name : "unknown";
          const code = parseCodedErrorMessage(error).code ?? null;
          const runtimeAction = RUNTIME_ACTION_CHANNELS.has(channel);
          captureError(error, {
            tags: {
              "ipc.channel": channel,
              ...(runtimeAction ? { "runtime.action": label } : {}),
              ...(code ? { "error.code": code } : {}),
            },
            extra: {
              durationMs,
              ...(timeoutLimitMs != null ? timeoutDiagnostics(timeoutLimitMs, startedAt, startedMono) : {}),
            },
            // A runtime action's failure is rebuilt from the brain's reply and
            // has no stack of its own: group it by what failed, not by which
            // action hit it, or one fault is an issue per screen that asked.
            fingerprint: runtimeAction ? runtimeActionFingerprint(error, label) : ["ipc", label, code ?? errorName],
          });
        }
        throw error;
      }
    })) as typeof ipcMain.handle;
}
