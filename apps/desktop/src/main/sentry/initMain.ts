/**
 * Sentry in the Electron main process.
 *
 * Covers main itself (uncaught exceptions, unhandled rejections, logger
 * warnings and errors), the renderer (its events arrive here over IPC, so the
 * packaged CSP never has to allow Sentry's host), native crashes of every
 * Electron process as minidumps, unresponsive windows, renderer freezes, and
 * child processes that die. Must run after `app.setPath("userData")`, because
 * the offline queue and the crash dumps live there, and before `app` is ready.
 */
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import * as Sentry from "@sentry/electron/main";
import { resolveMachineAdeLayout } from "../../../../ade-cli/src/services/projects/machineLayout";
import { addSentryBreadcrumb, connectSentry } from "../../shared/sentry/capture";
import {
  resolveSentryDsn,
  resolveSentryEnvironment,
  SENTRY_DATA_COLLECTION,
  sentryDist,
  sentryReleaseName,
  SENTRY_TRACES_SAMPLE_RATE,
  shouldEnableSentry,
} from "../../shared/sentry/config";
import {
  DIAGNOSTIC_FILE_MAX_CHARS,
  registerSentryDiagnosticAttachment,
  registerSentryDiagnosticContext,
} from "../../shared/sentry/diagnostics";
import { createSentryEventHooks } from "../../shared/sentry/eventFilter";
import { installIpcErrorCapture } from "./ipcCapture";
import { sentryMachineContext, sentryProcessTags, startNodeSentryDiagnostics } from "./machineContext";
import { hasPriorTelemetryOptOut } from "./priorOptOut";

let started = false;

/** Integrations ADE leaves out: local variables can hold anything, and ADE wires its own preload. */
const EXCLUDED_INTEGRATIONS = /^(?:LocalVariables|PreloadInjection|Screenshots)/;

export function initMainSentry(options: {
  /** Names an IPC call for its issue and breadcrumb; see `installIpcErrorCapture`. */
  ipcLabel: (channel: string, args: readonly unknown[]) => string;
}): boolean {
  if (started) return true;
  const packaged = app.isPackaged;
  if (!shouldEnableSentry({ env: process.env, packaged, priorOptOut: hasPriorTelemetryOptOut() })) return false;
  started = true;
  const hooks = createSentryEventHooks({ diagnostics: true });
  Sentry.init({
    dsn: resolveSentryDsn("desktop", process.env),
    release: sentryReleaseName(app.getVersion()),
    environment: resolveSentryEnvironment({ env: process.env, packaged }),
    dist: sentryDist(process.platform, process.arch),
    // Classic IPC: no custom protocol scheme, and only ADE's own preload
    // carries the bridge (see `src/preload/preload.ts`).
    ipcMode: Sentry.IPCMode.Classic,
    tracesSampleRate: SENTRY_TRACES_SAMPLE_RATE,
    // Never add trace headers to provider, GitHub or other third-party requests.
    tracePropagationTargets: [],
    sendClientReports: true,
    maxBreadcrumbs: 100,
    dataCollection: SENTRY_DATA_COLLECTION,
    integrations: (defaults) => defaults.filter((integration) => !EXCLUDED_INTEGRATIONS.test(integration.name)),
    beforeSend: hooks.beforeSend,
    beforeBreadcrumb: hooks.beforeBreadcrumb,
    beforeSendSpan: hooks.beforeSendSpan,
    beforeSendLog: hooks.beforeSendLog,
  });
  connectSentry(Sentry);
  Sentry.setTags(sentryProcessTags("main"));
  Sentry.setContext("machine", { ...sentryMachineContext(), locale: app.getLocale?.() ?? null });
  startNodeSentryDiagnostics();
  registerSentryDiagnosticContext("electron_processes", electronProcessesContext);
  registerSentryDiagnosticAttachment("brain-log", readBrainLogTail);
  startMemoryWatch();
  installIpcErrorCapture(options.ipcLabel);
  return true;
}

const KB_PER_MB = 1024;

/** Every Electron process with its memory and CPU, largest first. A renderer near its heap limit shows here. */
function electronProcessesContext(): Record<string, unknown> | null {
  if (!app.isReady()) return null;
  const metrics = app.getAppMetrics();
  const processes = metrics
    .map((metric) => ({
      type: metric.type,
      pid: metric.pid,
      ...(metric.serviceName ? { service: metric.serviceName } : {}),
      ...(metric.name ? { name: metric.name } : {}),
      workingSetMb: Math.round(metric.memory.workingSetSize / KB_PER_MB),
      peakWorkingSetMb: Math.round(metric.memory.peakWorkingSetSize / KB_PER_MB),
      cpuPercent: Math.round(metric.cpu.percentCPUUsage * 10) / 10,
    }))
    .sort((left, right) => right.workingSetMb - left.workingSetMb);
  return {
    count: processes.length,
    totalWorkingSetMb: processes.reduce((sum, item) => sum + item.workingSetMb, 0),
    processes: processes.slice(0, 12),
  };
}

/**
 * The newest part of the brain's own log (`<ADE home>/runtime/brain.jsonl`).
 * Most of what the desktop does runs in the brain, so a failed runtime action
 * is explained there; the brain's own reports carry it too, but a desktop
 * report must not need a second lookup. A read of the file's last bytes only.
 */
function readBrainLogTail(): { filename: string; data: string } | null {
  const logPath = path.join(resolveMachineAdeLayout().runtimeDir, "brain.jsonl");
  let fd: number | null = null;
  try {
    fd = fs.openSync(logPath, "r");
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, DIAGNOSTIC_FILE_MAX_CHARS);
    if (length <= 0) return null;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    // A read that starts mid-file starts mid-line: drop that partial line.
    const data = length < size ? text.slice(text.indexOf("\n") + 1) : text;
    return data ? { filename: "brain-log-tail.jsonl", data } : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

const MEMORY_WATCH_INTERVAL_MS = 60_000;
/** A process that grew this much since its last step gets a new one. */
const MEMORY_STEP_GROWTH = 1.25;
const MEMORY_STEP_FLOOR_MB = 500;

/**
 * A step in the trail when an Electron process grows past 500 MB, then each
 * time it grows another quarter. A renderer killed for running out of memory
 * leaves a report whose trail shows the climb and when it started.
 * One `getAppMetrics` call a minute; no log line.
 */
function startMemoryWatch(): void {
  const lastStepMbByPid = new Map<number, number>();
  const timer = setInterval(() => {
    if (!app.isReady()) return;
    const seen = new Set<number>();
    for (const metric of app.getAppMetrics()) {
      seen.add(metric.pid);
      const workingSetMb = Math.round(metric.memory.workingSetSize / KB_PER_MB);
      const last = lastStepMbByPid.get(metric.pid);
      const threshold = last === undefined ? MEMORY_STEP_FLOOR_MB : last * MEMORY_STEP_GROWTH;
      if (workingSetMb < threshold) continue;
      lastStepMbByPid.set(metric.pid, workingSetMb);
      addSentryBreadcrumb("memory", "process.memory_grew", {
        type: metric.type,
        pid: metric.pid,
        workingSetMb,
        previousStepMb: last ?? null,
      }, workingSetMb >= 2_000 ? "warning" : "info");
    }
    for (const pid of lastStepMbByPid.keys()) {
      if (!seen.has(pid)) lastStepMbByPid.delete(pid);
    }
  }, MEMORY_WATCH_INTERVAL_MS);
  timer.unref?.();
}

export function isMainSentryStarted(): boolean {
  return started;
}
