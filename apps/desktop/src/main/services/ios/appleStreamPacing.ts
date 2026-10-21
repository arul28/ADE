/**
 * Pacing for the Apple device stream relay: how far behind a viewer is, when
 * it stops getting delta frames, and the lane's encoder cap.
 *
 * Over the tunnel relay the socket the brain writes to is a loopback pipe, so
 * its `bufferedAmount` stays near zero while frames queue up somewhere between
 * the Mac and the phone. A viewer that sends `{t:"ack",n}` (records received
 * so far) gives the one honest measure of that queue: how long the oldest
 * unacked record has been out, over the best round trip seen lately.
 *
 * Past `APPLE_STREAM_LAG_BUDGET_MS` the viewer stops getting delta frames, and
 * once it is back within `APPLE_STREAM_RESUME_LAG_MS` it resumes at a keyframe
 * the relay asks the helper for. A stall also lowers the lane's encoder cap;
 * a quiet spell raises it back. A viewer that never acks is never paced.
 *
 * Kept apart from the relay, which owns tickets, sockets and upstreams: this
 * file only does arithmetic on send and ack times.
 */

/** How far behind its best round trip a paced viewer may fall before deltas are skipped. */
export const APPLE_STREAM_LAG_BUDGET_MS = 250;
/** A skipping viewer resumes, at a keyframe, once it is back within this. */
export const APPLE_STREAM_RESUME_LAG_MS = 60;
/** The lowest encoder cap stalls may push a lane to. */
export const APPLE_STREAM_MIN_ADAPTIVE_KBPS = 400;
const STATS_INTERVAL_MS = 1_000;
/** The round-trip floor is the best of the last two windows of this length. */
const RTT_WINDOW_MS = 5_000;
/** A lowered cap gets this long to take effect before the next step down. */
const BITRATE_LOWER_INTERVAL_MS = 2_000;
/** How long without a stall before a lowered cap steps back up, and how often. */
const BITRATE_RAISE_QUIET_MS = 15_000;
const BITRATE_RAISE_INTERVAL_MS = 10_000;
/** Sends remembered per viewer; a viewer this far behind is skipping anyway. */
const MAX_INFLIGHT_RECORDS = 1_024;

/** What one access unit gets. */
export type AppleStreamAdmission = {
  send: boolean;
  /** This call began a stall: the lane's cap should come down. */
  stalled: boolean;
};

export type AppleStreamViewerPacer = {
  /** A record went out on the viewer's socket. Every record, so the count matches the viewer's. */
  recordSent(): void;
  /** `{t:"ack",n}`. Returns false for an ack that cannot be true, which changes nothing. */
  ack(received: number): boolean;
  /** Whether the viewer has acked at all. One that never does is forwarded everything. */
  readonly acking: boolean;
  /** Skipping, and caught up: the next keyframe would be on time, so ask for one. */
  readonly wantsKeyframe: boolean;
  /** Whether this access unit goes to the viewer now. Records sent before the first ack count. */
  admit(keyframe: boolean): AppleStreamAdmission;
  /**
   * The `{t:"stats"}` note when one is due, else null. The phone reads the
   * round trip and the skip count; the rest is there for whoever reads the
   * socket while diagnosing a slow link.
   */
  takeStats(bitrateKbps: number | null): string | null;
  /** Forget what was out: the viewer was hidden, and nothing it missed says anything about the link now. */
  reset(): void;
};

export function createAppleStreamViewerPacer(now: () => number): AppleStreamViewerPacer {
  /** Sent and not yet acked, oldest first. */
  let inflight: Array<{ seq: number; at: number }> = [];
  let sent = 0;
  let acked = 0;
  let acking = false;
  let lastRttMs: number | null = null;
  /** Best round trip in the current and the previous `RTT_WINDOW_MS`. */
  let rttMin: number | null = null;
  let rttPrevMin: number | null = null;
  let rttWindowStartedAt = now();
  /** Dropping access units until a keyframe can be delivered on time. */
  let skipping = false;
  let skipped = 0;
  let lastStatsAt = now();

  const rttFloor = (): number | null => {
    if (rttMin == null) return rttPrevMin;
    if (rttPrevMin == null) return rttMin;
    return Math.min(rttMin, rttPrevMin);
  };

  const lag = (): number => {
    const oldest = inflight[0];
    if (!oldest) return 0;
    return Math.max(0, now() - oldest.at - (rttFloor() ?? 0));
  };

  return {
    recordSent() {
      sent += 1;
      inflight.push({ seq: sent, at: now() });
      if (inflight.length > MAX_INFLIGHT_RECORDS) inflight.shift();
    },

    ack(received) {
      if (!Number.isFinite(received) || received < 0 || received > sent) return false;
      acking = true;
      if (received <= acked) return true;
      acked = received;
      const at = now();
      let newest: { seq: number; at: number } | undefined;
      let head = inflight[0];
      while (head && head.seq <= received) {
        newest = inflight.shift();
        head = inflight[0];
      }
      if (!newest) return true;
      const rtt = at - newest.at;
      lastRttMs = rtt;
      if (at - rttWindowStartedAt >= RTT_WINDOW_MS) {
        rttPrevMin = rttMin;
        rttMin = null;
        rttWindowStartedAt = at;
      }
      rttMin = rttMin == null ? rtt : Math.min(rttMin, rtt);
      return true;
    },

    get acking() {
      return acking;
    },

    get wantsKeyframe() {
      return skipping && lag() <= APPLE_STREAM_RESUME_LAG_MS;
    },

    admit(keyframe) {
      // No acks, or no round trip measured yet: there is nothing to pace
      // against. Without a floor every link slower than the budget would look
      // like a stall on its first frame.
      if (!acking || rttFloor() == null) return { send: true, stalled: false };
      const behind = lag();
      if (!skipping) {
        if (behind <= APPLE_STREAM_LAG_BUDGET_MS) return { send: true, stalled: false };
        skipping = true;
        skipped += 1;
        return { send: false, stalled: true };
      }
      // Caught up. Only a keyframe can restart a decoder that missed frames.
      if (keyframe && behind <= APPLE_STREAM_RESUME_LAG_MS) {
        skipping = false;
        return { send: true, stalled: false };
      }
      skipped += 1;
      return { send: false, stalled: false };
    },

    takeStats(bitrateKbps) {
      const at = now();
      if (!acking || at - lastStatsAt < STATS_INTERVAL_MS) return null;
      lastStatsAt = at;
      const floor = rttFloor();
      return JSON.stringify({
        t: "stats",
        rttMs: lastRttMs == null ? null : Math.round(lastRttMs),
        baseRttMs: floor == null ? null : Math.round(floor),
        lagMs: Math.round(lag()),
        skipped,
        bitrateKbps,
      });
    },

    reset() {
      inflight = [];
      skipping = false;
    },
  };
}

export type AppleStreamBitrateAdapter = {
  /** The cap the lane runs at now, or null when nothing is configured. */
  readonly kbps: number | null;
  /** A viewer stalled: step the cap down, at most once per `BITRATE_LOWER_INTERVAL_MS`. */
  stalled(): void;
  /** Called as acks arrive: a quiet link earns back a quarter at a time. */
  maybeRaise(): void;
  /** Nobody paced is watching any more: put the configured cap back. */
  restore(): void;
  /** The capture went away; the next one starts at the configured cap. */
  forget(): void;
};

/**
 * The lane's encoder cap under pacing.
 *
 * Skipping alone cannot fix a link slower than the encoder: every resume
 * starts with a keyframe the link then queues behind, so the viewer stutters
 * between stalls. A lower cap is what makes it smooth again. The cap is the
 * lane's, so it also reaches the Mac's own view while a remote viewer is
 * attached, as the remote cap already did.
 */
export function createAppleStreamBitrateAdapter(deps: {
  now: () => number;
  /** The configured remote cap, the ceiling to climb back to. */
  ceilingKbps: () => number | null;
  /** Re-cap the running capture. `kbps` is always a real cap. */
  apply: (kbps: number) => void;
}): AppleStreamBitrateAdapter {
  /** The cap pacing chose, below the configured one; null when untouched. */
  let adaptiveKbps: number | null = null;
  let lastStallAt = 0;
  let lastChangeAt = 0;

  const set = (kbps: number | null): void => {
    adaptiveKbps = kbps;
    lastChangeAt = deps.now();
    const target = kbps ?? deps.ceilingKbps();
    if (target != null) deps.apply(target);
  };

  return {
    get kbps() {
      return adaptiveKbps ?? deps.ceilingKbps();
    },

    stalled() {
      const at = deps.now();
      lastStallAt = at;
      if (at - lastChangeAt < BITRATE_LOWER_INTERVAL_MS) return;
      const ceiling = deps.ceilingKbps();
      if (ceiling == null) return;
      const current = adaptiveKbps ?? ceiling;
      const next = Math.max(APPLE_STREAM_MIN_ADAPTIVE_KBPS, Math.round(current * 0.6));
      if (next < current) set(next);
    },

    maybeRaise() {
      if (adaptiveKbps == null) return;
      const at = deps.now();
      if (at - lastStallAt < BITRATE_RAISE_QUIET_MS) return;
      if (at - lastChangeAt < BITRATE_RAISE_INTERVAL_MS) return;
      const ceiling = deps.ceilingKbps();
      if (ceiling == null) return;
      const next = Math.round(adaptiveKbps * 1.25);
      set(next >= ceiling ? null : next);
    },

    restore() {
      if (adaptiveKbps != null) set(null);
    },

    forget() {
      adaptiveKbps = null;
      lastStallAt = 0;
    },
  };
}
