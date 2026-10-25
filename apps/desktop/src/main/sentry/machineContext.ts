/** Tags and context every Node-side Sentry client (main, brain) sets the same way. */
import os from "node:os";
import zlib from "node:zlib";
import { sentryChannelTag } from "../../shared/sentry/config";
import { enableSentryDiagnostics, registerSentryDiagnosticContext } from "../../shared/sentry/diagnostics";

export function sentryProcessTags(processName: string): Record<string, string> {
  return {
    process: processName,
    "os.release": os.release(),
    arch: process.arch,
    "package.channel": sentryChannelTag(process.env),
  };
}

export function sentryMachineContext(): Record<string, string | number | null> {
  const cpus = os.cpus();
  return {
    cpus: cpus.length,
    cpuModel: cpus[0]?.model ?? null,
    memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

const MB = 1024 * 1024;

function megabytes(bytes: number): number {
  return Math.round(bytes / MB);
}

/**
 * Turn on the diagnostics a Node-side report carries (`shared/sentry/
 * diagnostics.ts`), with gzip for its files, and the `process` context: how
 * long this process has run and how much memory it holds at the moment of the
 * failure. A crash right after a start, or a heap near its limit, shows here.
 */
export function startNodeSentryDiagnostics(): void {
  enableSentryDiagnostics({ gzip: (text) => zlib.gzipSync(text, { level: 6 }) });
  const startedAt = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();
  registerSentryDiagnosticContext("process_state", () => {
    const memory = process.memoryUsage();
    return {
      pid: process.pid,
      startedAt,
      uptimeSec: Math.round(process.uptime()),
      rssMb: megabytes(memory.rss),
      heapUsedMb: megabytes(memory.heapUsed),
      heapTotalMb: megabytes(memory.heapTotal),
      externalMb: megabytes(memory.external),
      arrayBuffersMb: megabytes(memory.arrayBuffers),
      systemFreeMemoryMb: megabytes(os.freemem()),
      ...(process.platform === "win32" ? {} : { loadAverage: os.loadavg().map((value) => Math.round(value * 100) / 100) }),
    };
  });
}
