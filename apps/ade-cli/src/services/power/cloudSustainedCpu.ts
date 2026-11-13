/**
 * Mining-like use on an ADE Cloud computer: hours near full CPU with no chat
 * turn or agent working. The keep-awake check samples the CPU once a minute
 * (`os.cpus()` times, all cores) beside its busy reasons, and this watch
 * reports a stretch to ADE Cloud (`POST /cloud/instances/:id/cpu-report`) for
 * the owner's daily report. Nothing acts on it.
 *
 * Limits: the computer reports on itself; under gVisor the CPU counters are
 * the sandbox's own accounting, close but not exact; and a long build or test
 * in a terminal looks the same as a miner. The report is for a person to look at.
 */

import os from "node:os";

/** All cores together at or above this share of time busy, minute after minute. */
export const CLOUD_CPU_HIGH_PERCENT = 85;
/** A stretch this long is reported. */
export const CLOUD_CPU_HIGH_REPORT_AFTER_MS = 2 * 60 * 60_000;
/** While it lasts, again at most this often. */
export const CLOUD_CPU_HIGH_REPORT_EVERY_MS = 6 * 60 * 60_000;
/** After a failed send, the next try waits this long. */
const REPORT_RETRY_MS = 10 * 60_000;
/** A gap this long between samples means the machine slept: the stretch starts over. */
const SAMPLE_GAP_MS = 3 * 60_000;
/**
 * Busy reasons that leave high CPU unexplained: a command in a terminal,
 * someone's use, a timer. Anything else (a chat turn, an agent CLI, setup, a
 * clone, move or copy, unknown) explains it.
 */
const UNEXPLAINED_REASONS = new Set(["terminal", "in_use", "schedule"]);

export type CpuTimes = { busy: number; total: number };

/** All cores' busy and total time so far (ms), or null when the OS gives none. */
export function readCpuTimes(): CpuTimes | null {
  const cpus = os.cpus();
  if (!cpus.length) return null;
  let busy = 0;
  let total = 0;
  for (const cpu of cpus) {
    const { user, nice, sys, idle, irq } = cpu.times;
    busy += user + nice + sys + irq;
    total += user + nice + sys + idle + irq;
  }
  return { busy, total };
}

export type SustainedCpuReport = { since: number; minutes: number; cpuPercent: number };

export function createSustainedCpuWatch(options: {
  report: (report: SustainedCpuReport) => Promise<void>;
  readTimes?: () => CpuTimes | null;
  logger?: { info(event: string, data?: unknown): void; warn(event: string, data?: unknown): void };
}) {
  const readTimes = options.readTimes ?? readCpuTimes;
  let last: { at: number; times: CpuTimes } | null = null;
  let stretch: { since: number; sum: number; samples: number } | null = null;
  let nextReportAt = 0;
  let sending = false;

  return {
    /** One sample at `at`, with the keep-awake check's busy reasons. */
    sample(at: number, reasons: readonly string[]): void {
      const times = readTimes();
      if (!times) return;
      const previous = last;
      last = { at, times };
      if (!previous || at - previous.at > SAMPLE_GAP_MS || times.total <= previous.times.total) {
        stretch = null;
        return;
      }
      const percent = ((times.busy - previous.times.busy) / (times.total - previous.times.total)) * 100;
      const unexplained = reasons.every((reason) => UNEXPLAINED_REASONS.has(reason));
      if (percent < CLOUD_CPU_HIGH_PERCENT || !unexplained) {
        stretch = null;
        return;
      }
      stretch ??= { since: previous.at, sum: 0, samples: 0 };
      stretch.sum += percent;
      stretch.samples += 1;
      const lasted = at - stretch.since;
      if (lasted < CLOUD_CPU_HIGH_REPORT_AFTER_MS || at < nextReportAt || sending) return;
      const report: SustainedCpuReport = {
        since: stretch.since,
        minutes: Math.round(lasted / 60_000),
        cpuPercent: Math.round(stretch.sum / stretch.samples),
      };
      sending = true;
      nextReportAt = at + CLOUD_CPU_HIGH_REPORT_EVERY_MS;
      options.logger?.info("cloud.cpu_sustained", report);
      void options.report(report).catch((error: unknown) => {
        nextReportAt = at + REPORT_RETRY_MS;
        options.logger?.warn("cloud.cpu_sustained_report_failed", { error: error instanceof Error ? error.message : String(error) });
      }).finally(() => {
        sending = false;
      });
    },
  };
}
