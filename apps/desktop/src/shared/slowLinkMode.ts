/**
 * Slow-connection mode, per connection to one machine.
 *
 * Always-on fixes (smaller chunks, parts, re-sends) cost nothing on a good
 * link. The mode holds the changes that hide or delay what a person sees:
 * pictures load on a tap, terminals type ahead with dimmed characters. So it
 * turns on only for a connection that is slow now, from what this computer
 * measured, and off again when the link is good for a while. It is never
 * global: a fast LAN machine and a far one in the same window each get their
 * own answer.
 *
 * The rule:
 * - On: two of the last three round trips at or above `SLOW_RTT_ON_MS`, or
 *   `SLOW_DROPS_ON` dropped connections within `SLOW_DROP_WINDOW_MS`.
 * - Off: the last `SLOW_RTT_OFF_SAMPLES` round trips all under
 *   `SLOW_RTT_OFF_MS`, and no drop within `SLOW_DROP_WINDOW_MS`.
 * - Between the two it keeps what it was, so a link near the line does not
 *   switch back and forth.
 * - The person's setting for the machine wins: "on" or "off".
 */
export const SLOW_RTT_ON_MS = 400;
export const SLOW_RTT_OFF_MS = 250;
export const SLOW_RTT_OFF_SAMPLES = 5;
export const SLOW_DROPS_ON = 2;
export const SLOW_DROP_WINDOW_MS = 5 * 60_000;
const RTT_SAMPLES_KEPT = SLOW_RTT_OFF_SAMPLES;

/** The person's setting for one machine. Absent: "auto". */
export type SlowLinkPreference = "auto" | "on" | "off";

export type SlowLinkReason = "latency" | "drops" | "setting";

/** What the window shows for one connection. */
export type SlowLinkStatus = {
  active: boolean;
  /** Why it is on. Null while it is off. */
  reason: SlowLinkReason | null;
  /** The last measured round trip, for the label. */
  rttMs: number | null;
};

export type SlowLinkMeasure = {
  /** Recent round trips, oldest first. */
  rttMs: number[];
  /** When recent drops happened. */
  dropAt: number[];
  /** What the automatic rule said last. */
  slow: boolean;
  reason: Exclude<SlowLinkReason, "setting"> | null;
};

export function emptySlowLinkMeasure(): SlowLinkMeasure {
  return { rttMs: [], dropAt: [], slow: false, reason: null };
}

export function normalizeSlowLinkPreference(value: unknown): SlowLinkPreference {
  return value === "on" || value === "off" ? value : "auto";
}

function decide(measure: SlowLinkMeasure, now: number): SlowLinkMeasure {
  const dropAt = measure.dropAt.filter((at) => now - at <= SLOW_DROP_WINDOW_MS);
  const lastThree = measure.rttMs.slice(-3);
  const slowSamples = lastThree.filter((rtt) => rtt >= SLOW_RTT_ON_MS).length;
  const latencyOn = slowSamples >= 2;
  const dropsOn = dropAt.length >= SLOW_DROPS_ON;
  if (latencyOn || dropsOn) {
    return { rttMs: measure.rttMs, dropAt, slow: true, reason: latencyOn ? "latency" : "drops" };
  }
  const recent = measure.rttMs.slice(-SLOW_RTT_OFF_SAMPLES);
  const calm = recent.length >= SLOW_RTT_OFF_SAMPLES
    && recent.every((rtt) => rtt < SLOW_RTT_OFF_MS)
    && dropAt.length === 0;
  if (measure.slow && !calm) return { ...measure, dropAt };
  return { rttMs: measure.rttMs, dropAt, slow: false, reason: null };
}

/** One measured round trip on this connection. */
export function noteSlowLinkRtt(measure: SlowLinkMeasure, rttMs: number, now: number): SlowLinkMeasure {
  const rtt = Math.max(0, Math.round(rttMs));
  return decide({ ...measure, rttMs: [...measure.rttMs, rtt].slice(-RTT_SAMPLES_KEPT) }, now);
}

/** The connection dropped (it closed, or a call lost its answer to a broken link). */
export function noteSlowLinkDrop(measure: SlowLinkMeasure, now: number): SlowLinkMeasure {
  return decide({ ...measure, dropAt: [...measure.dropAt, now] }, now);
}

export function slowLinkStatus(measure: SlowLinkMeasure, preference: SlowLinkPreference): SlowLinkStatus {
  const rttMs = measure.rttMs.length ? measure.rttMs[measure.rttMs.length - 1]! : null;
  if (preference === "on") return { active: true, reason: "setting", rttMs };
  if (preference === "off") return { active: false, reason: null, rttMs };
  return { active: measure.slow, reason: measure.slow ? measure.reason : null, rttMs };
}

/**
 * What a desktop says about its link on the maintenance `ping` (`params.link`),
 * so the machine it connects to can log the same numbers. An older machine
 * ignores it.
 */
export type ClientLinkReport = {
  rttP50Ms: number | null;
  rttP95Ms: number | null;
  /** Drops seen by the desktop in the last summary period. */
  drops: number;
  slow: boolean;
};

export function readClientLinkReport(value: unknown): ClientLinkReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const ms = (raw: unknown): number | null =>
    typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : null;
  return {
    rttP50Ms: ms(record.rttP50Ms),
    rttP95Ms: ms(record.rttP95Ms),
    drops: ms(record.drops) ?? 0,
    slow: record.slow === true,
  };
}

/** The p-th percentile (0-100) of samples, nearest rank; null for none. */
export function percentileMs(samples: number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank]!;
}
