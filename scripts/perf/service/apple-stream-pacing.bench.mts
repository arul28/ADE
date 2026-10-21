// cd apps/ade-cli && npx tsx ../../scripts/perf/service/apple-stream-pacing.bench.mts
// Feeds `appleStreamRelay` a synthetic 60 fps H.264-sized stream and sends it to
// one viewer over a simulated link (bandwidth + one-way delay), paced (the
// viewer acks, like the phone) and not paced (no acks, like the web client).
// Prints the delay from the relay's send to the viewer's receipt for the second
// half of each run, when the pacing has settled, plus skips, cap changes and
// any delta frame the viewer could not decode (must be 0). Every frame carries
// its sequence number, so a delta after a gap — a skip — counts as one unless
// a keyframe came first.
// A new loopback reader makes the fake helper open with a keyframe, as the
// real helper's encoder rebuild does. DURATION_MS sets each run (default 30 s).
import {
  createAppleStreamRelay,
  type AppleStreamUpstream,
  type AppleStreamViewerSocket,
} from "../../../apps/desktop/src/main/services/ios/appleStreamRelay";

const durationMs = Number(process.env.DURATION_MS ?? 30_000);
const fps = 60;
const capKbps = 2_500;
/** Screen-content keyframes run far larger than a delta. */
const keyframeFactor = 20;

/**
 * `stall`: the link delivers nothing for `ms` every `everyMs`, both ways. It is
 * what an iPhone on Wi-Fi does while its radio sleeps between beacons, on a
 * link that is otherwise fast.
 */
type Scenario = {
  paced: boolean;
  linkKbps: number;
  oneWayMs: number;
  stall?: { everyMs: number; ms: number };
};
const scenarios: Scenario[] = [
  { paced: false, linkKbps: 1_000, oneWayMs: 40 },
  { paced: true, linkKbps: 1_000, oneWayMs: 40 },
  { paced: true, linkKbps: 600, oneWayMs: 120 },
  { paced: true, linkKbps: 5_000, oneWayMs: 20 },
  { paced: false, linkKbps: 20_000, oneWayMs: 5, stall: { everyMs: 2_000, ms: 250 } },
  { paced: true, linkKbps: 20_000, oneWayMs: 5, stall: { everyMs: 2_000, ms: 250 } },
];

function record(type: number, size: number, keyframe: boolean, seq = 0): Uint8Array {
  const bytes = new Uint8Array(12 + Math.max(size, 4));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0xade1f00d);
  view.setUint8(4, type);
  view.setUint8(5, keyframe ? 1 : 0);
  view.setUint32(8, Math.max(size, 4));
  view.setUint32(12, seq);
  return bytes;
}

function percentile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!);
}

async function run({ paced, linkKbps, oneWayMs, stall }: Scenario): Promise<Record<string, unknown>> {
  let encoderKbps = capKbps;
  let forceKeyframe = true;
  let feed: ((chunk: Uint8Array) => void) | null = null;
  let readers = 0;
  const caps: number[] = [];
  const connect = (): AppleStreamUpstream => {
    readers += 1;
    const isProbe = readers > 1;
    if (isProbe) forceKeyframe = true;
    return {
      onData: (listener) => {
        if (isProbe) setTimeout(() => listener(new Uint8Array(1)), 20);
        else feed = listener;
      },
      onEnd: () => {},
      close: () => {},
    };
  };
  const relay = createAppleStreamRelay({
    openSource: async () => ({ url: "loopback", token: "token" }),
    closeSource: async () => {},
    connect,
    bitrateCapKbps: () => capKbps,
    applyBitrateCap: async ({ bitrateKbps }) => {
      caps.push(bitrateKbps);
      encoderKbps = bitrateKbps;
      forceKeyframe = true;
    },
  });

  const started = Date.now();
  /** The first moment at or after `at` the radio is awake. */
  const awake = (at: number): number => {
    if (!stall) return at;
    const phase = (at - started) % stall.everyMs;
    return phase < stall.ms ? at + (stall.ms - phase) : at;
  };
  const lateDelays: number[] = [];
  const listeners: Array<(data: unknown, isBinary?: boolean) => void> = [];
  let wireFreeAt = 0;
  let received = 0;
  let awaitingKeyframe = true;
  let lastSeq = 0;
  let undecodable = 0;
  let skipped = 0;
  // One in-order queue, like the TCP stream under a WebSocket. A timer per
  // frame would let two frames due in the same millisecond fire out of order,
  // which reads as a gap no real link produces.
  const wire: Array<{ at: number; data: Uint8Array | string; sentAt: number }> = [];
  let draining: ReturnType<typeof setTimeout> | null = null;
  const drain = (): void => {
    draining = null;
    const now = Date.now();
    while (wire.length > 0 && wire[0]!.at <= now) {
      const next = wire.shift()!;
      arrive(next.data, next.sentAt);
    }
    if (wire.length > 0) draining = setTimeout(drain, wire[0]!.at - now);
  };
  const socket = {
    send(data: Uint8Array | string) {
      const sentAt = Date.now();
      const bytes = typeof data === "string" ? data.length : data.byteLength;
      wireFreeAt = awake(Math.max(sentAt, wireFreeAt)) + (bytes * 8) / linkKbps;
      wire.push({ at: wireFreeAt + oneWayMs, data, sentAt });
      if (!draining) draining = setTimeout(drain, wire[0]!.at - sentAt);
    },
    close() {},
    on(event: string, listener: (data: unknown, isBinary?: boolean) => void) {
      if (event === "message") listeners.push(listener);
    },
  } as unknown as AppleStreamViewerSocket;

  function arrive(data: Uint8Array | string, sentAt: number): void {
    if (typeof data === "string") {
      skipped = (JSON.parse(data) as { skipped?: number }).skipped ?? skipped;
      return;
    }
    received += 1;
    if (data[4] === 2) {
      const seq = new DataView(data.buffer, data.byteOffset).getUint32(12);
      if (seq !== lastSeq + 1) awaitingKeyframe = true;
      lastSeq = seq;
      if (data[5]! & 1) awaitingKeyframe = false;
      else if (awaitingKeyframe) undecodable += 1;
      if (sentAt - started > durationMs / 2) lateDelays.push(Date.now() - sentAt);
    }
    if (!paced) return;
    const n = received;
    setTimeout(() => {
      for (const listener of listeners) listener(Buffer.from(JSON.stringify({ t: "ack", n })), false);
    }, awake(Date.now()) - Date.now() + oneWayMs);
  }

  const ticket = relay.issue({ laneId: "bench" });
  await relay.attach(socket, { ticket: ticket.ticket, token: ticket.token });
  feed!(record(1, 0, false));
  let lastKeyframeAt = 0;
  let seq = 0;
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      const now = Date.now();
      if (now - started > durationMs) {
        clearInterval(timer);
        resolve();
        return;
      }
      const keyframe = forceKeyframe || now - lastKeyframeAt > 5_000;
      forceKeyframe = false;
      if (keyframe) lastKeyframeAt = now;
      const deltaBytes = Math.round((encoderKbps * 1_000) / 8 / fps);
      seq += 1;
      feed!(record(2, keyframe ? deltaBytes * keyframeFactor : deltaBytes, keyframe, seq));
    }, 1_000 / fps);
  });
  // Let the link drain, however far behind it is, so the slowest frame counts.
  const drainedAt = Math.min(wireFreeAt + oneWayMs * 2 + 200, Date.now() + 60_000);
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, drainedAt - Date.now())));
  relay.dispose();
  const sorted = lateDelays.sort((a, b) => a - b);
  return {
    paced,
    linkKbps,
    oneWayMs,
    ...(stall ? { stall } : {}),
    fps: +(sorted.length / (durationMs / 2_000)).toFixed(1),
    secondHalf: { frames: sorted.length, p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9), p99: percentile(sorted, 0.99) },
    skipped,
    caps,
    undecodable,
  };
}

for (const scenario of scenarios) {
  console.log(JSON.stringify(await run(scenario)));
}
process.exit(0);
