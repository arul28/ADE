/**
 * The diagnostics only the desktop's main process can add to a report
 * (`shared/sentry/diagnostics.ts`): every Electron process with its memory,
 * the newest part of the brain's log, this machine's background service
 * (`brainServiceDiagnostics.ts`), and a memory trail in the breadcrumbs.
 */
import { app } from "electron";
import { brainLogPath } from "../../../../ade-cli/src/services/projects/machineLayout";
import { readFileTail, registerBrainServiceSentryDiagnostics } from "../../../../ade-cli/src/sentry/brainServiceDiagnostics";
import { addSentryBreadcrumb } from "../../shared/sentry/capture";
import {
  DIAGNOSTIC_FILE_MAX_CHARS,
  registerSentryDiagnosticAttachment,
  registerSentryDiagnosticContext,
  toMegabytes,
  type DiagnosticEvent,
} from "../../shared/sentry/diagnostics";

/** `getAppMetrics` reports memory in kilobytes. */
const BYTES_PER_KB = 1024;

export function registerDesktopSentryDiagnostics(): void {
  registerSentryDiagnosticContext("electron_processes", electronProcessesContext);
  registerSentryDiagnosticAttachment("brain-log", (event) => (isRemoteMachineEvent(event) ? null : readBrainLogTail()));
  registerBrainServiceSentryDiagnostics({ skipFilesFor: isRemoteMachineEvent });
  startMemoryWatch();
}

/**
 * A failure of a call to another machine's brain. This machine's brain log
 * and project list say nothing about it; that brain reports on its own.
 */
export function isRemoteMachineEvent(event: DiagnosticEvent): boolean {
  const channel = event.tags?.["ipc.channel"];
  return typeof channel === "string" && channel.startsWith("ade.remoteRuntime.");
}

/** Every Electron process with its memory and CPU, largest first. A renderer near its heap limit shows here. */
function electronProcessesContext(): Record<string, unknown> | null {
  if (!app.isReady()) return null;
  const processes = app.getAppMetrics()
    .map((metric) => ({
      type: metric.type,
      pid: metric.pid,
      ...(metric.serviceName ? { service: metric.serviceName } : {}),
      ...(metric.name ? { name: metric.name } : {}),
      workingSetMb: toMegabytes(metric.memory.workingSetSize * BYTES_PER_KB),
      peakWorkingSetMb: toMegabytes(metric.memory.peakWorkingSetSize * BYTES_PER_KB),
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
 * The newest part of this machine's brain log. Most of what the desktop does
 * runs in the brain, so a failed runtime action is explained there; the
 * brain's own reports carry it too, but a desktop report must not need a
 * second lookup. A read of the file's last bytes only.
 */
function readBrainLogTail(): { filename: string; data: string } | null {
  const data = readFileTail(brainLogPath(), DIAGNOSTIC_FILE_MAX_CHARS);
  return data ? { filename: "brain-log-tail.jsonl", data } : null;
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
      const workingSetMb = toMegabytes(metric.memory.workingSetSize * BYTES_PER_KB);
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
