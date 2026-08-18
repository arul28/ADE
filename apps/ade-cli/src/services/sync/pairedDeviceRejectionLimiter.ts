/**
 * Host-side throttle for repeated paired-hello rejections from the same
 * device id.
 *
 * A phone that kept a pairing secret after the host forgot the record will
 * retry forever (LAN + Tailscale + Relay racing). Each hello is a full reject
 * + close + warn log; left alone that is thousands of lines a day.
 *
 * The wire body stays identical for `unknown_device` and `secret_mismatch`.
 * This limiter never sees the reason: applying a different delay or log
 * cadence per reason would let an unauthenticated caller tell whether the
 * device id exists.
 */

export const PAIRED_DEVICE_REJECTION_WINDOW_MS = 60_000;
export const PAIRED_DEVICE_REJECTION_LOG_EVERY = 8;
export const PAIRED_DEVICE_REJECTION_DELAY_AFTER = 3;
export const PAIRED_DEVICE_REJECTION_BASE_DELAY_MS = 250;
export const PAIRED_DEVICE_REJECTION_MAX_DELAY_MS = 8_000;
const PAIRED_DEVICE_REJECTION_MAX_TRACKED = 512;

export type PairedDeviceRejectionAction = {
  countInWindow: number;
  shouldLog: boolean;
  delayMs: number;
};

export type PairedDeviceRejectionLimiter = {
  record(deviceId: string): PairedDeviceRejectionAction;
};

type PairedDeviceRejectionLimiterOptions = {
  now?: () => number;
  windowMs?: number;
  logEvery?: number;
  delayAfter?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

export function createPairedDeviceRejectionLimiter(
  options: PairedDeviceRejectionLimiterOptions = {},
): PairedDeviceRejectionLimiter {
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? PAIRED_DEVICE_REJECTION_WINDOW_MS;
  const logEvery = options.logEvery ?? PAIRED_DEVICE_REJECTION_LOG_EVERY;
  const delayAfter = options.delayAfter ?? PAIRED_DEVICE_REJECTION_DELAY_AFTER;
  const baseDelayMs = options.baseDelayMs ?? PAIRED_DEVICE_REJECTION_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? PAIRED_DEVICE_REJECTION_MAX_DELAY_MS;
  const hits = new Map<string, number[]>();

  const pruneExpired = (nowMs: number): void => {
    for (const [id, stamps] of hits) {
      const next = stamps.filter((ts) => nowMs - ts <= windowMs);
      if (next.length === 0) hits.delete(id);
      else hits.set(id, next);
    }
  };

  return {
    record(deviceId: string): PairedDeviceRejectionAction {
      const key = deviceId.trim();
      if (!key) {
        return { countInWindow: 1, shouldLog: true, delayMs: 0 };
      }
      const nowMs = now();
      pruneExpired(nowMs);
      if (hits.size >= PAIRED_DEVICE_REJECTION_MAX_TRACKED && !hits.has(key)) {
        const oldest = hits.keys().next().value;
        if (oldest) hits.delete(oldest);
      }
      const series = hits.get(key) ?? [];
      series.push(nowMs);
      hits.set(key, series);
      const countInWindow = series.length;
      const shouldLog = countInWindow === 1 || countInWindow % logEvery === 0;
      let delayMs = 0;
      if (countInWindow > delayAfter) {
        const exp = Math.min(countInWindow - delayAfter - 1, 16);
        delayMs = Math.min(maxDelayMs, baseDelayMs * (2 ** exp));
      }
      return { countInWindow, shouldLog, delayMs };
    },
  };
}

export async function applyPairedDeviceRejectionThrottle(
  action: PairedDeviceRejectionAction,
): Promise<void> {
  if (action.delayMs <= 0) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, action.delayMs);
  });
}
