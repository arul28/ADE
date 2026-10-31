/** Tags and context every Node-side Sentry client (main, brain) sets the same way. */
import os from "node:os";
import zlib from "node:zlib";
import type { ReleaseChannel } from "../../shared/packageChannel";
import { sentryChannelTag, sentryCommonTags } from "../../shared/sentry/config";
import { enableSentryDiagnostics, registerSentryDiagnosticContext, toMegabytes } from "../../shared/sentry/diagnostics";
import { isInternalInstall } from "./priorOptOut";

export function sentryProcessTags(args: {
  processName: string;
  surface: "desktop" | "brain";
  releaseChannel: ReleaseChannel;
}): Record<string, string> {
  return {
    ...sentryCommonTags({
      surface: args.surface,
      client: args.surface === "desktop" ? "desktop" : "runtime",
      releaseChannel: args.releaseChannel,
      isInternal: isInternalInstall(),
      arch: process.arch,
    }),
    process: args.processName,
    "os.release": os.release(),
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

/**
 * Turn on the diagnostics a Node-side report carries (`shared/sentry/
 * diagnostics.ts`), with gzip for its files, and the `process_state` context: how
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
      rssMb: toMegabytes(memory.rss),
      heapUsedMb: toMegabytes(memory.heapUsed),
      heapTotalMb: toMegabytes(memory.heapTotal),
      externalMb: toMegabytes(memory.external),
      arrayBuffersMb: toMegabytes(memory.arrayBuffers),
      systemFreeMemoryMb: toMegabytes(os.freemem()),
      ...(process.platform === "win32" ? {} : { loadAverage: os.loadavg().map((value) => Math.round(value * 100) / 100) }),
    };
  });
}
