/** Tags and context every Node-side Sentry client (main, brain) sets the same way. */
import os from "node:os";
import { sentryChannelTag } from "../../shared/sentry/config";

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
