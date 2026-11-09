/** Sizes, plans and the arithmetic of hours. Hours are integer thousandths of a Small-hour. */

export type CloudComputerType = "default" | "vm";

export type CloudSize = {
  id: string;
  type: CloudComputerType;
  cpu: number;
  memoryGb: number;
  multiplierMilli: number;
};

export const CLOUD_SIZES: readonly CloudSize[] = [
  { id: "small", type: "default", cpu: 2, memoryGb: 4, multiplierMilli: 1000 },
  { id: "medium", type: "default", cpu: 4, memoryGb: 8, multiplierMilli: 2000 },
  { id: "large", type: "default", cpu: 4, memoryGb: 16, multiplierMilli: 3300 },
  { id: "xlarge", type: "default", cpu: 4, memoryGb: 32, multiplierMilli: 5800 },
  { id: "vm-small", type: "vm", cpu: 2, memoryGb: 4, multiplierMilli: 2500 },
  { id: "vm-medium", type: "vm", cpu: 4, memoryGb: 8, multiplierMilli: 5000 },
  { id: "vm-large", type: "vm", cpu: 4, memoryGb: 16, multiplierMilli: 8200 },
  { id: "vm-xlarge", type: "vm", cpu: 4, memoryGb: 32, multiplierMilli: 14500 },
];

export function cloudSizeFor(type: unknown, cpu: unknown, memoryGb: unknown): CloudSize | null {
  return CLOUD_SIZES.find((size) => size.type === type && size.cpu === cpu && size.memoryGb === memoryGb) ?? null;
}

export const DISK_ON_CREATE_GB = 4;
/** Disk grows in steps of this many GB. */
export const DISK_STEP_GB = 4;
/** Free computers never grow past this; paid accounts share `PAID_DISK_POOL_GB`. */
export const FREE_DISK_GB = 4;
export const PAID_DISK_POOL_GB = 40;

export const FREE_COMPUTER_LIMIT = 3;
export const PAID_COMPUTER_LIMIT = 10;

export const FREE_INCLUDED_MILLI = 50_000;
export const PAID_INCLUDED_MILLI = 500_000;

/** ADE's wake URL (`CLOUD_WAKE_PORT` on the desktop): the only public port allowed. */
export const WAKE_PORT = 7337;

/** What the meter counts as awake, and `cloudKeepAwake`'s "running" side of a stretch. */
const METERED_STATUSES = new Set(["running", "restarting", "updating"]);
export function isMeteredStatus(status: string): boolean {
  return METERED_STATUSES.has(status);
}

/** Thousandths of a Small-hour for `ms` of awake time at this size. */
export function hoursMilliFor(ms: number, multiplierMilli: number): number {
  if (ms <= 0) return 0;
  return Math.round((ms * multiplierMilli) / 3_600_000);
}

/** `YYYY-MM-DD` in UTC. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Splits `[from, to)` by UTC day, oldest first. */
export function splitByUtcDay(from: number, to: number): Array<{ day: string; ms: number }> {
  if (to <= from) return [];
  const out: Array<{ day: string; ms: number }> = [];
  let start = from;
  while (start < to) {
    const nextMidnight = Date.UTC(
      new Date(start).getUTCFullYear(),
      new Date(start).getUTCMonth(),
      new Date(start).getUTCDate() + 1,
    );
    const end = Math.min(nextMidnight, to);
    out.push({ day: utcDay(start), ms: end - start });
    start = end;
  }
  return out;
}

/** The free period holding `now`: the current UTC month. */
export function freePeriodFor(now: number): { start: number; end: number } {
  const date = new Date(now);
  return {
    start: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1),
    end: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1),
  };
}
