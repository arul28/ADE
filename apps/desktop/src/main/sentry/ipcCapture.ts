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
import { addSentryBreadcrumb, captureError, captureProblem } from "../../shared/sentry/capture";
import { adeActionAccess, isBackgroundAdeWrite } from "../../shared/adeActionAccess";
import { expectedErrorKind } from "../../shared/expectedError";
import { parseCodedErrorMessage } from "../../shared/codedError";
import { isExpectedFailure, isExpectedOutcome } from "../../shared/sentry/expectedFailure";
import { runtimeActionFingerprint } from "../../shared/sentry/grouping";
import { IPC } from "../../shared/ipc";
import { forwardLogToSentry } from "../../shared/sentry/logBridge";
import { runInCapturedIpcCall } from "./ipcCallScope";
import { readBrainFrames } from "../../shared/runtimeActionReplyError";
import { IpcHandlerTimeoutError, ipcTimerFiredWhilePaused } from "./ipcHandlerTimeout";

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

/** An IPC timeout: its deadline, how late its timer fired, and the CPU spent meanwhile. */
type IpcTimeout = { limitMs: number; lateMs: number; cpuMs: number };

function readIpcTimeout(error: unknown, startedAt: number, startedCpu: NodeJS.CpuUsage): IpcTimeout | null {
  const limitMs = ipcTimeoutLimitMs(error);
  if (limitMs == null) return null;
  // The deadline's own view, from the moment its timer fired: the grace and
  // the wake that follow it are not counted (`shared/deadlineTimer.ts`).
  if (error instanceof IpcHandlerTimeoutError) {
    return { limitMs, lateMs: error.expiry.timerLateMs, cpuMs: error.expiry.cpuMs };
  }
  const used = process.cpuUsage(startedCpu);
  return {
    limitMs,
    lateMs: Date.now() - startedAt - limitMs,
    cpuMs: Math.round((used.user + used.system) / 1000),
  };
}

/**
 * A timeout whose call straddled a sleep or a pause: nothing hung, ADE was
 * not running.
 *
 * Four signals, because the power events miss most of them. On wake, the
 * overdue timer fires before `resume` is delivered, and a dark wake (Power
 * Nap) emits no `suspend` or `resume` at all; `suspend` comes before the
 * sleep, so it is already known when the timer fires when it comes at all.
 * Where the monotonic clock stops during sleep (Linux), the wall clock running
 * ahead of it is time asleep. On macOS it does not stop: libuv reads
 * `mach_continuous_time`, so timers and `performance.now()` count the sleep
 * and that gap stays 0. Sentry saw 30s timeouts there 15 s to 15 min late,
 * gap 0, no power event during the call, and the log silent from the call's
 * start to the moment every pending timer fired at once. The fourth signal
 * covers that and App Nap alike: the timer fired late while the process
 * spent almost no CPU, so it was not running, not busy.
 */
function sleptThroughTimeout(timeout: IpcTimeout | null, startedAt: number, startedMono: number): boolean {
  if (!timeout) return false;
  if (lastResumeAt >= startedAt + timeout.limitMs) return true;
  if (lastSuspendAt >= startedAt) return true;
  const asleepMs = (Date.now() - startedAt) - (performance.now() - startedMono);
  if (asleepMs >= SLEPT_DURING_CALL_MS) return true;
  return ipcTimerFiredWhilePaused(timeout.lateMs, timeout.cpuMs);
}

/**
 * What a reported timeout needs to tell a hang from a machine that was not
 * running ADE: how late the timer fired (a timer fires late only when the
 * process did not run, or its main thread was blocked), the sleep signals,
 * and whether anyone was looking at ADE (macOS throttles a hidden app).
 */
function timeoutDiagnostics(timeout: IpcTimeout, startedAt: number, startedMono: number): Record<string, unknown> {
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
    ...timeout,
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

/**
 * The same answer on the same call, again: an event pump re-asking a paired
 * machine that is offline gets "Can't reach …" on every retry. The first is
 * the Sentry Log; repeats within this window add nothing. Bounded, since
 * labels and messages are few and a full map just starts over.
 */
const EXPECTED_REPEAT_MS = 10 * 60_000;
const MAX_EXPECTED_REPEAT_KEYS = 200;
const lastExpectedLogAt = new Map<string, number>();

function isExpectedRepeat(label: string, message: string, now: number): boolean {
  const key = `${label}\u0000${message}`;
  const last = lastExpectedLogAt.get(key);
  if (last != null && now >= last && now - last < EXPECTED_REPEAT_MS) return true;
  if (lastExpectedLogAt.size >= MAX_EXPECTED_REPEAT_KEYS) lastExpectedLogAt.clear();
  lastExpectedLogAt.set(key, now);
  return false;
}

/**
 * An action a person asked for (a declared write the app does not send on its
 * own, `isBackgroundAdeWrite`) that keeps getting an expected answer. One
 * "Can't reach …" on a Settle is an answer and stays a Sentry Log; the same
 * answer {@link PERSON_REPEAT_THRESHOLD} times within an hour is a person
 * blocked, and the Sentry Logs nobody reads hid exactly that. It becomes one
 * warning issue per action and kind of failure: warning so it never triggers
 * the high-priority email, grouped so many people hitting it is one issue
 * with a user count, and at most once a day per process for each.
 *
 * Only brain actions are classified: their access is declared in
 * `ADE_ACTION_ACCESS`. The reads a screen polls are left out on purpose, and
 * so are the writes below.
 */
const PERSON_REPEAT_WINDOW_MS = 60 * 60_000;
const PERSON_REPEAT_THRESHOLD = 3;
const PERSON_REPORT_EVERY_MS = 24 * 60 * 60_000;
const MAX_PERSON_REPEAT_KEYS = 200;
const personFailures = new Map<string, { at: number[]; reportedAt: number | null }>();

/**
 * Writes a screen sends again on its own while it stays open (a viewer
 * restarting its stream, a status or decoration refresh), so a repeat is the
 * screen's retry, not a person trying again. Not `BACKGROUND_WRITES`: a person
 * opening the screen still wakes a sleeping cloud computer with them.
 */
const SCREEN_RETRIED_WRITES: ReadonlySet<string> = new Set([
  "mac_desktop.startStream",
  "ios_simulator.startStream",
  "android_emulator.startStream",
  "file.watchWorkspace",
  "file.refreshGitDecorations",
  "github.detectRepo",
  "proxy.status",
  "usage.noteQuotaDemand",
]);

/** A runtime action a person started, from its `domain.action` label. */
function isPersonInitiatedAction(channel: string, label: string): boolean {
  if (!RUNTIME_ACTION_CHANNELS.has(channel) || SCREEN_RETRIED_WRITES.has(label)) return false;
  const dot = label.indexOf(".");
  if (dot <= 0) return false;
  const domain = label.slice(0, dot);
  const action = label.slice(dot + 1);
  return adeActionAccess(domain, action) === "write" && !isBackgroundAdeWrite(domain, action);
}

/**
 * Counts one expected failure of a person's action; true when this one makes
 * the repeat worth an issue.
 */
function personFailureRepeats(key: string, now: number): boolean {
  let entry = personFailures.get(key);
  if (!entry) {
    if (personFailures.size >= MAX_PERSON_REPEAT_KEYS) personFailures.clear();
    entry = { at: [], reportedAt: null };
    personFailures.set(key, entry);
  }
  // `t <= now`: a clock set back must not keep old failures in the window forever.
  // Only the last few matter: a terminal typed into on a machine that is gone
  // fails on every key.
  entry.at = [...entry.at.filter((t) => t <= now && now - t < PERSON_REPEAT_WINDOW_MS), now].slice(-PERSON_REPEAT_THRESHOLD);
  if (entry.at.length < PERSON_REPEAT_THRESHOLD) return false;
  if (entry.reportedAt != null && now >= entry.reportedAt && now - entry.reportedAt < PERSON_REPORT_EVERY_MS) return false;
  entry.reportedAt = now;
  return true;
}

/**
 * What failed, as fixed words only: the error's own code (ADE's or an errno)
 * or its type, and the expected kind. Never its message, which can name the
 * person's machine ("Can't reach Mac Studio …") or files.
 */
function personFailureKind(error: unknown): [string, string] {
  const direct = (error as { code?: unknown } | null)?.code;
  const code = typeof direct === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(direct.trim()) ? direct.trim() : null;
  return [code ?? (error instanceof Error ? error.name : "unknown"), expectedErrorKind(error) ?? "unexpected"];
}

function reportRepeatedPersonFailure(channel: string, label: string, error: unknown): void {
  const failure = personFailureKind(error);
  if (!personFailureRepeats([label, ...failure].join("\u0000"), Date.now())) return;
  const failureClass = failure[0];
  // No message: it can name the person's machine or files. The Sentry Log
  // `ipc.expected.<label>` beside it has the scrubbed text.
  captureProblem(`${label} keeps failing for a person: ${failureClass}`, {
    level: "warning",
    tags: {
      "ipc.channel": channel,
      "runtime.action": label,
      "ipc.expected_repeat": "person",
      "error.code": failureClass,
    },
    extra: {
      expectedKind: expectedErrorKind(error) ?? null,
      logEvent: `ipc.expected.${label}`,
    },
    fingerprint: ["ipc-expected-repeat", label, ...failure],
  });
}

/**
 * One stall, one issue. When the main process or the brain stops answering,
 * every call in flight times out within seconds of each other, on different
 * channels (`attention.getSnapshot`, `lanes.list`, `chat.listSessions`, …),
 * and each channel used to open an issue of its own for the same stall. The
 * first timeout of a stall is the issue; each timeout of another call within
 * {@link STALL_WINDOW_MS} of the last one is the same stall, logged as
 * `ipc.timeout_in_stall.<label>` with the same `ipc.stall_id`, so one search
 * finds every call it took down.
 */
const STALL_WINDOW_MS = 30_000;
let currentStall: { id: string; lastAt: number; calls: number } | null = null;

function joinStall(now: number): { id: string; first: boolean; calls: number } {
  if (currentStall && now >= currentStall.lastAt && now - currentStall.lastAt < STALL_WINDOW_MS) {
    currentStall.lastAt = now;
    currentStall.calls += 1;
    return { id: currentStall.id, first: false, calls: currentStall.calls };
  }
  currentStall = { id: Math.random().toString(16).slice(2, 10).padEnd(8, "0"), lastAt: now, calls: 1 };
  return { id: currentStall.id, first: true, calls: 1 };
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
      const startedCpu = process.cpuUsage();
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
        const timeout = readIpcTimeout(error, startedAt, startedCpu);
        const expectedOutcome = isExpectedOutcome(error);
        if (expectedOutcome || sleptThroughTimeout(timeout, startedAt, startedMono)) {
          // An answer ("Lane not found", "Can't reach …"), or a timer that ran
          // out while ADE was not running: a Sentry Log, not an issue.
          const message = error instanceof Error ? error.message : String(error);
          const personAction = expectedOutcome && isPersonInitiatedAction(channel, label);
          if (!isExpectedRepeat(label, message, Date.now())) {
            forwardLogToSentry("warn", `ipc.expected.${label}`, {
              message,
              durationMs,
              // Logs search `initiated:person` lists what people were refused.
              ...(personAction ? { initiated: "person" } : {}),
              ...(timeout ? { lateMs: timeout.lateMs, cpuMs: timeout.cpuMs } : {}),
            });
          }
          if (personAction) reportRepeatedPersonFailure(channel, label, error);
          throw error;
        }
        addSentryBreadcrumb("ipc", label, { durationMs, ok: false }, "error");
        if (timeout && isTimeoutBurstRepeat(label, Date.now())) {
          forwardLogToSentry("warn", `ipc.timeout_repeat.${label}`, { durationMs });
          throw error;
        }
        const stall = timeout ? joinStall(Date.now()) : null;
        if (stall && !stall.first) {
          forwardLogToSentry("warn", `ipc.timeout_in_stall.${label}`, {
            durationMs,
            stallId: stall.id,
            stallCalls: stall.calls,
            lateMs: timeout?.lateMs ?? null,
            cpuMs: timeout?.cpuMs ?? null,
          });
          throw error;
        }
        if (!isExpectedFailure(error)) {
          const errorName = error instanceof Error ? error.name : "unknown";
          const code = parseCodedErrorMessage(error).code ?? null;
          const runtimeAction = RUNTIME_ACTION_CHANNELS.has(channel);
          const rpcCode = (error as { rpcCode?: unknown } | null)?.rpcCode;
          const brainFrames = runtimeAction ? readBrainFrames(error) : null;
          captureError(error, {
            tags: {
              "ipc.channel": channel,
              ...(runtimeAction ? { "runtime.action": label } : {}),
              ...(code ? { "error.code": code } : {}),
              ...(typeof rpcCode === "number" ? { "rpc.code": String(rpcCode) } : {}),
              ...(stall ? { "ipc.stall_id": stall.id } : {}),
            },
            extra: {
              durationMs,
              ...(timeout ? timeoutDiagnostics(timeout, startedAt, startedMono) : {}),
              // Where the brain failed: its own top frames, `function:line`.
              ...(brainFrames ? { brainFrames } : {}),
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
