import { captureProblem } from "../../shared/sentry/capture";
import { forwardSignalToSentry } from "../../shared/sentry/logBridge";
import { parseCodedErrorMessage } from "../../shared/codedError";
import type { RemoteRuntimeConnectionStatus } from "../../shared/types";

/**
 * Keeps trying a list's first load until it answers.
 *
 * Work's lists refresh on change events, and those only come once something
 * has loaded. A first load that failed (the machine was still restarting after
 * an update) left "No chats yet" on screen until ADE was reopened, with the
 * machine showing as connected the whole time. So a failed first load is
 * retried with a backoff, and at once when the tab's machine reconnects. A load
 * that works costs nothing here: no timer and no subscription start until one
 * fails, and all of it stops at the first success.
 *
 * Reads go through the tab's own binding, so the machine they ask is the
 * machine the list belongs to.
 */

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;
/** Long enough that a machine restarting for an update is not reported as a bug. */
const REPORT_AFTER_FAILING_FOR_MS = 30_000;
const ANALYTICS_DEDUPE_MS = 60 * 60 * 1_000;

export type FirstLoadSurface = "sessions" | "lanes";

function captureFirstLoadOutcome(outcome: "completed" | "failed"): void {
  void window.ade?.analytics?.capture({
    event: "ade_feature_used",
    properties: { feature: "connections", action: "work_first_load", outcome },
    dedupeKey: `work_first_load:${outcome}`,
    minimumIntervalMs: ANALYTICS_DEDUPE_MS,
  }).catch(() => undefined);
}

/** A code ADE authored. `macbook: refused` also parses as one, so it must be snake_case. */
function firstLoadErrorCode(error: unknown): string | null {
  const code = parseCodedErrorMessage(error).code ?? "";
  return /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(code) ? code : null;
}

/**
 * What kind of failure it was, from ADE's own wordings. The message itself
 * stays off the report: an SSH failure names the address it dialed.
 */
function firstLoadErrorClass(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/applying an update/i.test(message)) return "update_in_progress";
  if (/project is switching/i.test(message)) return "project_switching";
  if (/connection failed recently/i.test(message)) return "connect_backoff";
  if (/can't reach|transport unavailable/i.test(message)) return "machine_unreachable";
  if (/service connection (?:closed|failed)/i.test(message)) return "connection_lost";
  if (/timed? out|timeout/i.test(message)) return "timeout";
  return "other";
}

async function readConnection(targetId: string | null): Promise<RemoteRuntimeConnectionStatus | null> {
  if (!targetId) return null;
  try {
    const snapshot = await window.ade.remoteRuntime.getConnectionSnapshot();
    return snapshot.connections.find((connection) => connection.target.id === targetId) ?? null;
  } catch {
    // The report goes without the connection details; the state reads as unknown.
    return null;
  }
}

export function runFirstLoadWithRetry(args: {
  surface: FirstLoadSurface;
  /** The machine the list is read from when that is not this computer. */
  targetId: string | null;
  load: (attempt: number) => Promise<unknown>;
  onRetryingChange?: (retrying: boolean) => void;
}): () => void {
  const { surface, targetId, load, onRetryingChange } = args;
  const bindingKind = targetId ? "remote" : "local";
  let cancelled = false;
  let loaded = false;
  let inFlight = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wakeRequested = false;
  let firstFailedAtMs: number | null = null;
  let lastError: unknown = null;
  let waitingReported = false;
  let issueReported = false;
  let reportInFlight = false;
  let targetWasConnected = false;
  let stopWatching: (() => void) | null = null;

  const clearTimer = () => {
    if (timer != null) clearTimeout(timer);
    timer = null;
  };
  const stop = () => {
    clearTimer();
    stopWatching?.();
    stopWatching = null;
  };

  const details = async () => {
    const connection = await readConnection(targetId);
    return {
      connection,
      fields: {
        surface,
        bindingKind,
        attempts: attempt,
        failingMs: firstFailedAtMs == null ? 0 : Date.now() - firstFailedAtMs,
        windowUptimeMs: Math.round(performance.now()),
        errorCode: firstLoadErrorCode(lastError),
        errorClass: firstLoadErrorClass(lastError),
        connectionState: connection?.state ?? null,
        // The same id as this machine's `remote.connect_failed` for that dial.
        correlationId: connection?.lastErrorInfo?.correlationId ?? connection?.route?.correlationId ?? null,
        failure: connection?.lastErrorInfo?.failure ?? null,
        routeKind: connection?.route?.kind ?? null,
        peerVersion: connection?.version ?? null,
      },
    };
  };

  const reportStillFailing = async () => {
    const { connection, fields } = await details();
    if (!waitingReported) captureFirstLoadOutcome("failed");
    // A machine that is really offline, or a brain mid-update, is not a bug.
    // One that is connected, or this computer's own service, should have
    // answered by now, so a machine that comes back and still fails gets its
    // issue then.
    if (fields.errorClass === "update_in_progress" || (targetId && connection?.state !== "connected")) {
      if (!waitingReported) forwardSignalToSentry("work.first_load_waiting", fields, surface);
      waitingReported = true;
      return;
    }
    issueReported = true;
    captureProblem(`Work ${surface} list could not load`, {
      fingerprint: ["work", "first_load_failed", surface, bindingKind],
      tags: { "work.first_load": surface, "binding.kind": bindingKind },
      extra: fields,
      handled: true,
    });
  };

  const reportRecovered = async () => {
    const { fields } = await details();
    captureFirstLoadOutcome("completed");
    forwardSignalToSentry("work.first_load_recovered", fields, surface, "info");
  };

  const attemptLoad = () => {
    clearTimer();
    if (cancelled || loaded || inFlight) return;
    // Hidden windows read nothing; the timer comes round again.
    if (attempt > 0 && document.visibilityState === "hidden") {
      scheduleRetry();
      return;
    }
    inFlight = true;
    attempt += 1;
    // Started in the caller's own tick, as a plain load would be.
    let pending: Promise<unknown>;
    try {
      pending = load(attempt);
    } catch (error) {
      pending = Promise.reject(error);
    }
    void pending.then(onLoaded, onFailed);
  };

  const scheduleRetry = () => {
    timer = setTimeout(attemptLoad, RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]);
  };

  // A wake that lands during an attempt is held until that attempt ends.
  const wake = () => {
    if (inFlight) wakeRequested = true;
    else attemptLoad();
  };

  const watchForWakes = () => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") wake();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    const stopWatchingConnection = targetId
      ? window.ade?.remoteRuntime?.onConnectionSnapshotChanged?.((snapshot) => {
        const connected = snapshot.connections.some(
          (connection) => connection.target.id === targetId && connection.state === "connected",
        );
        const justConnected = connected && !targetWasConnected;
        targetWasConnected = connected;
        if (justConnected) wake();
      })
      : undefined;
    stopWatching = () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stopWatchingConnection?.();
    };
    // The attempt that just failed may have hung across the reconnect itself,
    // before anything was listening for it.
    void readConnection(targetId).then((connection) => {
      if (connection?.state !== "connected" || targetWasConnected) return;
      targetWasConnected = true;
      wake();
    });
  };

  const onLoaded = () => {
    inFlight = false;
    wakeRequested = false;
    loaded = true;
    if (cancelled) return;
    stop();
    if (firstFailedAtMs == null) return;
    onRetryingChange?.(false);
    void reportRecovered().catch(() => undefined);
  };

  const onFailed = (error: unknown) => {
    inFlight = false;
    if (cancelled) return;
    lastError = error;
    if (firstFailedAtMs == null) {
      firstFailedAtMs = Date.now();
      onRetryingChange?.(true);
      watchForWakes();
    }
    if (!issueReported && !reportInFlight && Date.now() - firstFailedAtMs >= REPORT_AFTER_FAILING_FOR_MS) {
      reportInFlight = true;
      void reportStillFailing()
        .catch(() => undefined)
        .finally(() => {
          reportInFlight = false;
        });
    }
    if (wakeRequested) {
      wakeRequested = false;
      attemptLoad();
      return;
    }
    scheduleRetry();
  };

  attemptLoad();
  return () => {
    cancelled = true;
    stop();
    if (firstFailedAtMs != null) onRetryingChange?.(false);
  };
}
