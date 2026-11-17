/**
 * A small congestion window for bulk transfers to or from one machine:
 * transcript pictures pulled in chunks (`artifactMediaServer.ts`) and pastes
 * sent in parts (`remoteAttachmentParts.ts`).
 * - A piece is about `targetMs` of the measured delivery rate, so a key or a
 *   small reply on the same connection waits behind about one piece.
 * - Enough pieces are out at once to cover the round trip plus one piece, so
 *   the link stays full.
 * - The round trip comes only from pieces that had none of this meter's
 *   pieces ahead of them. A piece queued behind its own pieces measures the
 *   queue too; counted as round trip, that queue let more pieces out, which
 *   made the queue longer, until every key waited behind the most pieces.
 */
/** From this delivery rate up (32 Mbit/s), a bulk transfer goes as on a LAN. */
const FAST_LINK_BYTES_PER_MS = 4_000;
/** Before any piece arrived: from this round trip up, the link counts as slow or far. */
const FAR_LINK_RTT_MS = 40;

/**
 * Whether a bulk transfer on this link should take the slow-link path (a
 * display copy, a paste in parts). On a fast, near link the plain path is as
 * quick and costs nothing extra. Unknown link: the slow-link path, the safe side.
 */
export function linkWantsSlowPath(meter: LinkMeter | null, roundTripMs: number | null): boolean {
  const rate = meter?.rateBytesPerMs() ?? null;
  if (rate !== null) return rate < FAST_LINK_BYTES_PER_MS;
  if (roundTripMs !== null) return roundTripMs >= FAR_LINK_RTT_MS;
  return true;
}

export type LinkMeterConfig = {
  targetMs: number;
  minBytes: number;
  /** Before any piece arrived: a size a slow link carries well inside a call's budget. */
  startBytes: number;
  maxBytes: number;
  inFlightMin: number;
  inFlightMax: number;
  /**
   * Pieces out at once before the first one arrived. Several small pieces
   * sent together measure the rate within one round trip; one big piece
   * holds the link as long and measures less.
   */
  startInFlight: number;
  /** Recent latencies of pieces with nothing of ours ahead; the smallest stands for the round trip. */
  latencySamples: number;
  now?: () => number;
};

export type LinkMeter = {
  /** Waits for room on this machine's link. */
  acquire: () => Promise<void>;
  release: () => void;
  /** The bytes to ask for in the next chunk. */
  chunkBytes: () => number;
  /** How many chunks may be out at once now. */
  inFlightLimit: () => number;
  /** Taken just before a piece goes out; `delivered` reads it back. */
  stamp: () => LinkMeterStamp;
  /** A piece of `bytes` arrived; `stamp` was taken when it went out. */
  delivered: (bytes: number, stamp: LinkMeterStamp) => void;
  /** A chunk timed out or its connection dropped: send less at a time. */
  slowDown: () => void;
  /** The measured delivery rate, or null before the first piece arrived. */
  rateBytesPerMs: () => number | null;
};

export type LinkMeterStamp = { sentAt: number; deliveriesBefore: number };

export function createLinkMeter(config: LinkMeterConfig): LinkMeter {
  const now = config.now ?? Date.now;
  let rateBytesPerMs: number | null = null;
  const latencies: number[] = [];
  let deliveries = 0;
  let lastDeliveryAt = Number.NEGATIVE_INFINITY;
  let active = 0;
  const waiting: Array<() => void> = [];
  const chunkBytes = (): number => {
    if (rateBytesPerMs === null) return config.startBytes;
    const sized = Math.round(rateBytesPerMs * config.targetMs);
    return Math.max(config.minBytes, Math.min(config.maxBytes, sized));
  };
  const inFlightLimit = (): number => {
    if (rateBytesPerMs === null || latencies.length === 0) return config.startInFlight;
    const roundTripMs = Math.min(...latencies);
    const chunkMs = chunkBytes() / rateBytesPerMs;
    const needed = Math.ceil(roundTripMs / Math.max(1, chunkMs)) + 1;
    return Math.max(config.inFlightMin, Math.min(config.inFlightMax, needed));
  };
  const wake = () => {
    while (waiting.length && active < inFlightLimit()) {
      active += 1;
      waiting.shift()!();
    }
  };
  return {
    async acquire() {
      if (active < inFlightLimit()) {
        active += 1;
        return;
      }
      // `wake` counts this one in before it runs.
      await new Promise<void>((resolve) => waiting.push(resolve));
    },
    release() {
      active = Math.max(0, active - 1);
      wake();
    },
    chunkBytes,
    inFlightLimit,
    stamp: () => ({ sentAt: now(), deliveriesBefore: deliveries }),
    delivered(bytes, { sentAt, deliveriesBefore }) {
      const at = now();
      // Nothing of ours arrived while this piece was out, so nothing of ours
      // was ahead of it: its latency is the round trip plus its own bytes.
      if (deliveries === deliveriesBefore) {
        latencies.push(Math.max(0, at - sentAt));
        if (latencies.length > config.latencySamples) latencies.shift();
      }
      deliveries += 1;
      // The delivery rate: bytes over the time since the later of this
      // chunk's send and the last arrival. Chunks queued behind each other on
      // a full link measure the link; a lone chunk measures low (it carries
      // the round trip), and the window it opens corrects that.
      const interval = Math.max(1, at - Math.max(sentAt, lastDeliveryAt));
      lastDeliveryAt = at;
      if (bytes > 0) {
        const sample = bytes / interval;
        rateBytesPerMs = rateBytesPerMs === null ? sample : rateBytesPerMs * 0.7 + sample * 0.3;
      }
      wake();
    },
    rateBytesPerMs: () => rateBytesPerMs,
    slowDown() {
      rateBytesPerMs = rateBytesPerMs === null
        ? config.minBytes / config.targetMs
        : rateBytesPerMs / 4;
    },
  };
}

