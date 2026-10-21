import http from "node:http";
import https from "node:https";
import { randomBytes, timingSafeEqual } from "node:crypto";

import {
  IOS_VIDEO_RECORD_FLAG_KEYFRAME,
  IOS_VIDEO_RECORD_HEADER_BYTES,
  IOS_VIDEO_RECORD_MAGIC,
  IOS_VIDEO_RECORD_TYPE_ACCESS_UNIT,
  IOS_VIDEO_RECORD_TYPE_CONFIG,
} from "../../../shared/types/iosSimulator";

/**
 * Brain-side forwarder for the Apple device video stream.
 *
 * The helper encodes H.264 on the Mac that owns the simulator and serves it on
 * a loopback HTTP body that only this process can read — the token never leaves
 * the brain. A phone, a hosted web tab, or a desktop bound to another Mac has
 * no route to that loopback, so this service is the one place that does:
 *
 * 1. A viewer asks the sync command channel for a ticket (`apple.streamTicket`).
 *    The ticket is short-lived, single-use, and names one lane.
 * 2. The viewer opens a second WebSocket to the brain's sync listener at
 *    `/apple/stream/<ticket>?token=<token>` and this service pipes the helper's
 *    records through unchanged.
 * 3. `{t:"visible"}` / `{t:"hidden"}` from the viewer gate forwarding. When the
 *    last remote viewer goes hidden or leaves, the upstream body is dropped and
 *    the owning service is asked to stop capture — unless a viewer on the Mac
 *    itself is still watching.
 *
 * Two deliberate properties:
 *
 * **Record-aligned fan-out.** The upstream is a byte stream whose chunks split
 * records at arbitrary offsets. Forwarding raw chunks would hand a viewer that
 * joined mid-chunk half a header, so this parses the frame boundaries and sends
 * one binary WebSocket frame per record. The bytes inside a record are never
 * touched — the relay does not decode, transcode, or re-time anything.
 *
 * **Late joiners get a decodable start.** H.264 without SPS/PPS and a keyframe
 * is noise, so the last config record and the last keyframe access unit are
 * cached and replayed to a viewer the moment it attaches. Without this a second
 * viewer stared at black until the encoder's next IDR.
 *
 * **A viewer that acks is paced.** Over the tunnel relay the socket this
 * service writes to is a loopback pipe, so its `bufferedAmount` stays near zero
 * while frames queue up somewhere between here and the phone. A viewer that
 * sends `{t:"ack",n}` (records received so far) gives the one honest measure of
 * that queue: how long the oldest unacked record has been out, over the best
 * round trip seen lately. Past `APPLE_STREAM_LAG_BUDGET_MS` the viewer stops
 * getting delta frames, and once it has caught up it resumes at a keyframe the
 * relay asks the helper for. A stall also lowers the lane's encoder cap; a
 * quiet spell raises it back. A viewer that never acks (the web client, older
 * phones) is forwarded everything exactly as before.
 */

export const APPLE_STREAM_PATH_PREFIX = "/apple/stream/";
export const APPLE_STREAM_TICKET_TTL_MS = 60_000;
export const APPLE_STREAM_NOT_RUNNING_CODE = "APPLE_STREAM_NOT_RUNNING" as const;

/** How far behind its best round trip a pacing viewer may fall before deltas are skipped. */
export const APPLE_STREAM_LAG_BUDGET_MS = 250;
/** A skipping viewer resumes, at a keyframe, once it is back within this. */
export const APPLE_STREAM_RESUME_LAG_MS = 60;
/** The lowest encoder cap stalls may push a lane to. */
export const APPLE_STREAM_MIN_ADAPTIVE_KBPS = 400;
const KEYFRAME_REQUEST_MIN_INTERVAL_MS = 1_000;
/** A keyframe probe that never sees a byte is abandoned after this. */
const KEYFRAME_PROBE_TIMEOUT_MS = 3_000;
const STATS_INTERVAL_MS = 1_000;
/** The round-trip floor is the best of the last two windows of this length. */
const RTT_WINDOW_MS = 5_000;
/** Stalls this recent hold off raising a lowered cap. */
const CONGESTION_WINDOW_MS = 10_000;
/** A lowered cap gets this long to take effect before the next step down. */
const BITRATE_LOWER_INTERVAL_MS = 2_000;
/** How long without a stall before a lowered cap steps back up, and how often. */
const BITRATE_RAISE_QUIET_MS = 15_000;
const BITRATE_RAISE_INTERVAL_MS = 10_000;
/** Unacked records remembered per viewer; a viewer this far behind is skipping anyway. */
const MAX_INFLIGHT_RECORDS = 1_024;

/** A ticket, as the requester receives it over the JSON sync channel. */
export type AppleStreamTicket = {
  /** Absolute when the host knows its own reachable address; else null. */
  url: string | null;
  /** Always present. Resolve against the sync endpoint the client is on. */
  path: string;
  token: string;
  ticket: string;
  codec: string | null;
  width: number | null;
  height: number | null;
  /** Device POINTS, so a viewer can turn a touch on the picture into a tap. */
  pointWidth: number | null;
  pointHeight: number | null;
  expiresAt: string;
};

/** The helper's loopback body, as the owning service reports it. */
export type AppleStreamSource = {
  url: string;
  token: string;
  codec?: string | null;
  width?: number | null;
  height?: number | null;
};

/** Just enough of a `ws` socket to forward records onto it. */
export type AppleStreamViewerSocket = {
  /** Binary for a record, text for the relay's own `{t:"stats"}` notes. */
  send(data: Uint8Array | string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown, isBinary?: boolean) => void): void;
  on(event: "close" | "error", listener: (...args: unknown[]) => void): void;
};

/** An open upstream body. The default implementation is one `http.get`. */
export type AppleStreamUpstream = {
  onData(listener: (chunk: Uint8Array) => void): void;
  /** Called exactly once, with an error when the body ended badly. */
  onEnd(listener: (error?: Error) => void): void;
  close(): void;
};

export type AppleStreamRelayDeps = {
  /**
   * Start (or restart) capture for this lane at the remote-viewer bitrate cap
   * and hand back the loopback body. Called for the FIRST remote viewer of a
   * lane only — later viewers share the one upstream.
   */
  openSource(args: { laneId: string }): Promise<AppleStreamSource>;
  /**
   * The last remote viewer went away. `localViewers` says whether someone on
   * this Mac is still watching, so the implementation can leave capture up.
   */
  closeSource(args: { laneId: string; localViewers: boolean }): Promise<void>;
  /** Whether a viewer on the owning machine is watching right now. */
  hasLocalViewer?: (laneId: string) => boolean;
  /** Absolute `ws://host:port` prefix for the ticket URL, when known. */
  publicOrigin?: () => string | null;
  connect?: (source: AppleStreamSource) => AppleStreamUpstream;
  /**
   * The configured remote cap, the ceiling adaptive pacing may climb back to.
   * Without it (or `applyBitrateCap`) pacing still skips frames but never
   * touches the encoder.
   */
  bitrateCapKbps?: () => number | null;
  /** Re-cap the lane's live encoder. The helper rebuilds it, starting with a keyframe. */
  applyBitrateCap?: (args: { laneId: string; bitrateKbps: number }) => Promise<unknown>;
  now?: () => number;
  logger?: {
    debug?: (event: string, data?: Record<string, unknown>) => void;
    warn?: (event: string, data?: Record<string, unknown>) => void;
  };
};

export type AppleStreamRelay = {
  issue(args: {
    laneId: string;
    codec?: string | null;
    width?: number | null;
    height?: number | null;
    pointWidth?: number | null;
    pointHeight?: number | null;
  }): AppleStreamTicket;
  /** The ticket id in `/apple/stream/<id>`, or null when the url is not ours. */
  ticketFromUrl(url: string | null | undefined): string | null;
  /** True while this relay holds the unexpired, unused ticket. */
  hasTicket(ticket: string): boolean;
  /**
   * Take over a freshly upgraded socket. Resolves false when the ticket is
   * unknown, expired, already used, or the token does not match — the caller
   * has already closed the socket in that case.
   */
  attach(socket: AppleStreamViewerSocket, args: { ticket: string; token: string | null }): Promise<boolean>;
  /** Remote viewers currently attached (visible or hidden). */
  viewerCount(laneId?: string): number;
  /** Remote viewers currently asking for frames. */
  visibleViewerCount(laneId?: string): number;
  pendingTicketCount(): number;
  dispose(): void;
};

type PendingTicket = {
  ticket: string;
  token: string;
  laneId: string;
  codec: string | null;
  width: number | null;
  height: number | null;
  expiresAtMs: number;
};

type Viewer = {
  socket: AppleStreamViewerSocket;
  laneId: string;
  visible: boolean;
  closed: boolean;
  /** Records sent on this socket, the count the viewer's acks are in. */
  sent: number;
  /** Set by the viewer's first ack; a viewer that never acks is never paced. */
  pacing: ViewerPacing | null;
};

type ViewerPacing = {
  /** Sent and not yet acked, oldest first. */
  inflight: Array<{ seq: number; at: number }>;
  acked: number;
  lastRttMs: number | null;
  /** Best round trip in the current and the previous `RTT_WINDOW_MS`. */
  rttMin: number | null;
  rttPrevMin: number | null;
  rttWindowStartedAt: number;
  /** Dropping access units until a keyframe can be delivered on time. */
  skipping: boolean;
  skipped: number;
  lastStatsAt: number;
};

type LaneStream = {
  laneId: string;
  viewers: Set<Viewer>;
  upstream: AppleStreamUpstream | null;
  opening: Promise<void> | null;
  /** The loopback body the upstream reads, kept for keyframe probes. */
  source: AppleStreamSource | null;
  /** Whole framed records, kept so a late joiner can decode immediately. */
  configRecord: AppleStreamRecord | null;
  keyframeRecord: AppleStreamRecord | null;
  buffer: Uint8Array;
  lastKeyframeRequestAt: number;
  keyframeProbe: AppleStreamUpstream | null;
  /** The cap pacing chose, below the configured one; null when untouched. */
  adaptiveKbps: number | null;
  congestionAt: number[];
  lastBitrateChangeAt: number;
};

/**
 * A record larger than this is not something the helper sends. Refusing it
 * stops a desynchronised reader from allocating on a length it misread — the
 * same ceiling the renderer's parser applies.
 */
const MAX_RECORD_BYTES = 16 * 1024 * 1024;

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b.slice();
  const next = new Uint8Array(a.byteLength + b.byteLength);
  next.set(a, 0);
  next.set(b, a.byteLength);
  return next;
}

export type AppleStreamRecord = {
  type: number;
  keyframe: boolean;
  /** Header AND payload, exactly as it arrived. */
  bytes: Uint8Array;
};

/**
 * Split a byte stream into whole records, exported for the relay's tests and
 * for anything else that needs the boundaries without a decoder.
 *
 * Returns the records it could complete plus whatever tail did not fit, which
 * the caller feeds back in with the next chunk.
 */
export function splitAppleStreamRecords(
  buffer: Uint8Array,
): { records: AppleStreamRecord[]; rest: Uint8Array } {
  const records: AppleStreamRecord[] = [];
  let offset = 0;
  while (buffer.byteLength - offset >= IOS_VIDEO_RECORD_HEADER_BYTES) {
    const view = new DataView(
      buffer.buffer,
      buffer.byteOffset + offset,
      IOS_VIDEO_RECORD_HEADER_BYTES,
    );
    if (view.getUint32(0, false) !== IOS_VIDEO_RECORD_MAGIC) {
      throw new Error("The Apple device stream is not framed as expected.");
    }
    const type = view.getUint8(4);
    const flags = view.getUint8(5);
    const length = view.getUint32(8, false);
    if (length > MAX_RECORD_BYTES) {
      throw new Error(`The Apple device stream declared a ${length} byte record.`);
    }
    const end = offset + IOS_VIDEO_RECORD_HEADER_BYTES + length;
    if (buffer.byteLength < end) break;
    records.push({
      type,
      keyframe: (flags & IOS_VIDEO_RECORD_FLAG_KEYFRAME) !== 0,
      bytes: buffer.subarray(offset, end).slice(),
    });
    offset = end;
  }
  return { records, rest: offset === 0 ? buffer : buffer.subarray(offset).slice() };
}

function defaultConnect(source: AppleStreamSource): AppleStreamUpstream {
  const dataListeners = new Set<(chunk: Uint8Array) => void>();
  let endListener: ((error?: Error) => void) | null = null;
  let ended = false;
  const finish = (error?: Error): void => {
    if (ended) return;
    ended = true;
    endListener?.(error);
  };
  const transport = source.url.startsWith("https:") ? https : http;
  const request = transport.get(
    source.url,
    // The helper's FrameStreamServer wants a lowercase `bearer` scheme; HTTP
    // auth schemes are case-insensitive, so this is the spelling that is both
    // correct and what the Swift side documents.
    { headers: { authorization: `bearer ${source.token}` } },
    (response) => {
      if ((response.statusCode ?? 0) !== 200) {
        response.resume();
        finish(new Error(`The Apple device helper refused the stream with HTTP ${String(response.statusCode)}.`));
        return;
      }
      response.on("data", (chunk: Buffer) => {
        for (const listener of dataListeners) listener(new Uint8Array(chunk));
      });
      response.on("end", () => finish());
      response.on("error", (error: Error) => finish(error));
    },
  );
  request.on("error", (error: Error) => finish(error));
  return {
    onData: (listener) => {
      dataListeners.add(listener);
    },
    onEnd: (listener) => {
      endListener = listener;
    },
    close: () => {
      try {
        request.destroy();
      } catch {
        // Already gone; the end listener has fired or is about to.
      }
      finish();
    },
  };
}

export function createAppleStreamRelay(deps: AppleStreamRelayDeps): AppleStreamRelay {
  const now = deps.now ?? Date.now;
  const connect = deps.connect ?? defaultConnect;
  const tickets = new Map<string, PendingTicket>();
  const lanes = new Map<string, LaneStream>();
  let disposed = false;

  const debug = (event: string, data?: Record<string, unknown>): void => {
    try {
      deps.logger?.debug?.(event, data);
    } catch {
      // A logger that throws must not take the stream with it.
    }
  };
  const warn = (event: string, data?: Record<string, unknown>): void => {
    try {
      deps.logger?.warn?.(event, data);
    } catch {
      // as above
    }
  };

  const pruneTickets = (): void => {
    const nowMs = now();
    for (const [id, ticket] of tickets) {
      if (ticket.expiresAtMs <= nowMs) tickets.delete(id);
    }
  };

  const laneStream = (laneId: string): LaneStream => {
    const existing = lanes.get(laneId);
    if (existing) return existing;
    const created: LaneStream = {
      laneId,
      viewers: new Set(),
      upstream: null,
      opening: null,
      source: null,
      configRecord: null,
      keyframeRecord: null,
      buffer: new Uint8Array(0),
      lastKeyframeRequestAt: 0,
      keyframeProbe: null,
      adaptiveKbps: null,
      congestionAt: [],
      lastBitrateChangeAt: 0,
    };
    lanes.set(laneId, created);
    return created;
  };

  const sendRaw = (viewer: Viewer, data: Uint8Array | string): boolean => {
    try {
      viewer.socket.send(data);
      return true;
    } catch (error) {
      warn("apple.stream_send_failed", {
        laneId: viewer.laneId,
        error: error instanceof Error ? error.message : String(error),
      });
      dropViewer(viewer, 1011, "send failed");
      return false;
    }
  };

  /** How far the viewer is behind its own best round trip, in ms. */
  const lagOf = (pacing: ViewerPacing): number => {
    const oldest = pacing.inflight[0];
    if (!oldest) return 0;
    const floor = Math.min(pacing.rttMin ?? Infinity, pacing.rttPrevMin ?? Infinity);
    return Math.max(0, now() - oldest.at - (Number.isFinite(floor) ? floor : 0));
  };

  /**
   * Ask the helper for a keyframe by attaching a second loopback reader.
   *
   * The helper rebuilds its encoder for every reader that attaches, and a new
   * encoder opens with an IDR that every reader receives — this one included,
   * which is all the relay wanted. There is no "send a keyframe" command, and
   * this needs none.
   */
  const requestKeyframe = (stream: LaneStream): void => {
    const source = stream.source;
    if (!source || stream.keyframeProbe || disposed) return;
    const at = now();
    if (at - stream.lastKeyframeRequestAt < KEYFRAME_REQUEST_MIN_INTERVAL_MS) return;
    stream.lastKeyframeRequestAt = at;
    let probe: AppleStreamUpstream;
    try {
      probe = connect(source);
    } catch (error) {
      warn("apple.stream_keyframe_probe_failed", {
        laneId: stream.laneId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    stream.keyframeProbe = probe;
    const finish = (): void => {
      clearTimeout(timer);
      if (stream.keyframeProbe !== probe) return;
      stream.keyframeProbe = null;
      try {
        probe.close();
      } catch {
        // Already ended.
      }
    };
    const timer = setTimeout(finish, KEYFRAME_PROBE_TIMEOUT_MS);
    timer.unref?.();
    probe.onData(finish);
    probe.onEnd(finish);
    debug("apple.stream_keyframe_requested", { laneId: stream.laneId });
  };

  const setAdaptiveCap = (stream: LaneStream, kbps: number): void => {
    if (!deps.applyBitrateCap) return;
    stream.adaptiveKbps = kbps;
    stream.lastBitrateChangeAt = now();
    debug("apple.stream_bitrate_adapted", { laneId: stream.laneId, bitrateKbps: kbps });
    void Promise.resolve(deps.applyBitrateCap({ laneId: stream.laneId, bitrateKbps: kbps })).catch((error: unknown) => {
      warn("apple.stream_bitrate_adapt_failed", {
        laneId: stream.laneId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  /**
   * A viewer fell behind: lower the cap, at most once per
   * `BITRATE_LOWER_INTERVAL_MS` so the last change has time to show.
   *
   * Skipping alone cannot fix a link slower than the encoder: every resume
   * starts with a keyframe the link then queues behind, so the viewer
   * stutters between stalls. A lower cap is what makes it smooth again.
   */
  const noteCongestion = (stream: LaneStream): void => {
    const at = now();
    stream.congestionAt = [...stream.congestionAt.filter((t) => at - t < CONGESTION_WINDOW_MS), at];
    if (at - stream.lastBitrateChangeAt < BITRATE_LOWER_INTERVAL_MS) return;
    const ceiling = deps.bitrateCapKbps?.() ?? null;
    if (ceiling == null) return;
    const current = stream.adaptiveKbps ?? ceiling;
    const next = Math.max(APPLE_STREAM_MIN_ADAPTIVE_KBPS, Math.round(current * 0.6));
    if (next < current) setAdaptiveCap(stream, next);
  };

  /** A quiet link earns back a quarter of the cap at a time, up to the ceiling. */
  const maybeRaiseCap = (stream: LaneStream): void => {
    if (stream.adaptiveKbps == null) return;
    const at = now();
    const lastCongestion = stream.congestionAt[stream.congestionAt.length - 1] ?? 0;
    if (at - lastCongestion < BITRATE_RAISE_QUIET_MS) return;
    if (at - stream.lastBitrateChangeAt < BITRATE_RAISE_INTERVAL_MS) return;
    const ceiling = deps.bitrateCapKbps?.() ?? null;
    if (ceiling == null) return;
    const next = Math.min(ceiling, Math.round(stream.adaptiveKbps * 1.25));
    if (next >= ceiling) {
      stream.adaptiveKbps = null;
      stream.lastBitrateChangeAt = at;
      void Promise.resolve(deps.applyBitrateCap?.({ laneId: stream.laneId, bitrateKbps: ceiling })).catch(() => null);
      return;
    }
    setAdaptiveCap(stream, next);
  };

  /** Whether a paced viewer gets this access unit. */
  const admit = (stream: LaneStream, pacing: ViewerPacing, keyframe: boolean): boolean => {
    const lag = lagOf(pacing);
    if (!pacing.skipping) {
      if (lag <= APPLE_STREAM_LAG_BUDGET_MS) return true;
      pacing.skipping = true;
      debug("apple.stream_viewer_skipping", { laneId: stream.laneId, lagMs: Math.round(lag) });
      noteCongestion(stream);
      return false;
    }
    if (lag > APPLE_STREAM_RESUME_LAG_MS) return false;
    // Caught up. Only a keyframe can restart a decoder that missed frames, so
    // anything else is still dropped and a keyframe is asked for.
    if (keyframe) {
      pacing.skipping = false;
      return true;
    }
    requestKeyframe(stream);
    return false;
  };

  const sendTo = (stream: LaneStream, viewer: Viewer, record: AppleStreamRecord): void => {
    if (viewer.closed || !viewer.visible) return;
    const pacing = viewer.pacing;
    if (pacing && record.type === IOS_VIDEO_RECORD_TYPE_ACCESS_UNIT && !admit(stream, pacing, record.keyframe)) {
      pacing.skipped += 1;
      return;
    }
    if (!sendRaw(viewer, record.bytes)) return;
    viewer.sent += 1;
    if (!pacing) return;
    pacing.inflight.push({ seq: viewer.sent, at: now() });
    if (pacing.inflight.length > MAX_INFLIGHT_RECORDS) pacing.inflight.shift();
  };

  /** `{t:"ack",n}`: the viewer has received `n` records on this socket. */
  const onAck = (stream: LaneStream, viewer: Viewer, received: number): void => {
    if (!Number.isFinite(received) || received < 0 || received > viewer.sent) return;
    const at = now();
    const pacing = viewer.pacing ?? (viewer.pacing = {
      inflight: [],
      acked: 0,
      lastRttMs: null,
      rttMin: null,
      rttPrevMin: null,
      rttWindowStartedAt: at,
      skipping: false,
      skipped: 0,
      lastStatsAt: at,
    });
    if (received <= pacing.acked) return;
    pacing.acked = received;
    let newest: { seq: number; at: number } | undefined;
    while (pacing.inflight.length > 0 && pacing.inflight[0]!.seq <= received) {
      newest = pacing.inflight.shift();
    }
    if (newest) {
      const rtt = at - newest.at;
      pacing.lastRttMs = rtt;
      if (at - pacing.rttWindowStartedAt >= RTT_WINDOW_MS) {
        pacing.rttPrevMin = pacing.rttMin;
        pacing.rttMin = null;
        pacing.rttWindowStartedAt = at;
      }
      pacing.rttMin = pacing.rttMin == null ? rtt : Math.min(pacing.rttMin, rtt);
    }
    // An idle simulator may send nothing for seconds, so a viewer that caught
    // up asks for its keyframe here rather than waiting on the next frame.
    if (pacing.skipping && lagOf(pacing) <= APPLE_STREAM_RESUME_LAG_MS) requestKeyframe(stream);
    maybeRaiseCap(stream);
    if (at - pacing.lastStatsAt >= STATS_INTERVAL_MS) {
      pacing.lastStatsAt = at;
      const floor = Math.min(pacing.rttMin ?? Infinity, pacing.rttPrevMin ?? Infinity);
      sendRaw(viewer, JSON.stringify({
        t: "stats",
        rttMs: pacing.lastRttMs == null ? null : Math.round(pacing.lastRttMs),
        baseRttMs: Number.isFinite(floor) ? Math.round(floor) : null,
        lagMs: Math.round(lagOf(pacing)),
        skipped: pacing.skipped,
        bitrateKbps: stream.adaptiveKbps ?? deps.bitrateCapKbps?.() ?? null,
      }));
    }
  };

  const onUpstreamChunk = (stream: LaneStream, chunk: Uint8Array): void => {
    let split: { records: AppleStreamRecord[]; rest: Uint8Array };
    try {
      split = splitAppleStreamRecords(concat(stream.buffer, chunk));
    } catch (error) {
      warn("apple.stream_framing_failed", {
        laneId: stream.laneId,
        error: error instanceof Error ? error.message : String(error),
      });
      closeUpstream(stream);
      for (const viewer of [...stream.viewers]) dropViewer(viewer, 1011, "stream framing failed");
      return;
    }
    stream.buffer = split.rest;
    for (const record of split.records) {
      if (record.type === IOS_VIDEO_RECORD_TYPE_CONFIG) {
        stream.configRecord = record;
      } else if (record.type === IOS_VIDEO_RECORD_TYPE_ACCESS_UNIT && record.keyframe) {
        stream.keyframeRecord = record;
      }
      for (const viewer of [...stream.viewers]) sendTo(stream, viewer, record);
    }
  };

  const closeUpstream = (stream: LaneStream): void => {
    const upstream = stream.upstream;
    const probe = stream.keyframeProbe;
    stream.upstream = null;
    stream.keyframeProbe = null;
    stream.buffer = new Uint8Array(0);
    // The next upstream starts at the configured cap, so pacing starts over.
    stream.adaptiveKbps = null;
    stream.congestionAt = [];
    try {
      probe?.close();
    } catch {
      // Already ended.
    }
    if (!upstream) return;
    try {
      upstream.close();
    } catch {
      // Closing a body that already ended is not a failure.
    }
  };

  /**
   * Bring the upstream up for the first viewer that wants frames.
   *
   * Deliberately keyed on "wants frames" rather than "is attached": a viewer
   * that attached hidden (a backgrounded phone restoring its socket) must not
   * restart capture at the remote bitrate, because that would re-encode for
   * nobody and — when a local viewer is watching — visibly degrade their view.
   */
  const ensureUpstream = async (stream: LaneStream): Promise<void> => {
    if (disposed || stream.upstream || stream.opening) {
      if (stream.opening) await stream.opening;
      return;
    }
    const open = (async () => {
      const source = await deps.openSource({ laneId: stream.laneId });
      if (disposed || stream.viewers.size === 0) return;
      stream.source = source;
      const upstream = connect(source);
      stream.upstream = upstream;
      upstream.onData((chunk) => onUpstreamChunk(stream, chunk));
      upstream.onEnd((error) => {
        if (stream.upstream !== upstream) return;
        stream.upstream = null;
        stream.buffer = new Uint8Array(0);
        if (error) {
          warn("apple.stream_upstream_ended", { laneId: stream.laneId, error: error.message });
        }
        for (const viewer of [...stream.viewers]) dropViewer(viewer, 1012, "stream ended");
      });
    })().catch((error: unknown) => {
      warn("apple.stream_open_failed", {
        laneId: stream.laneId,
        error: error instanceof Error ? error.message : String(error),
      });
      for (const viewer of [...stream.viewers]) dropViewer(viewer, 1011, "stream unavailable");
    }).finally(() => {
      stream.opening = null;
    });
    stream.opening = open;
    await open;
  };

  /** Nobody remote wants frames any more: drop the body, maybe stop capture. */
  const releaseIfIdle = (stream: LaneStream): void => {
    const wanted = [...stream.viewers].some((viewer) => viewer.visible && !viewer.closed);
    if (wanted) return;
    closeUpstream(stream);
    if (stream.viewers.size === 0) lanes.delete(stream.laneId);
    const localViewers = deps.hasLocalViewer?.(stream.laneId) ?? false;
    void Promise.resolve(deps.closeSource({ laneId: stream.laneId, localViewers })).catch((error: unknown) => {
      warn("apple.stream_close_failed", {
        laneId: stream.laneId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  function dropViewer(viewer: Viewer, code: number, reason: string): void {
    if (viewer.closed) return;
    viewer.closed = true;
    viewer.visible = false;
    const stream = lanes.get(viewer.laneId);
    stream?.viewers.delete(viewer);
    try {
      viewer.socket.close(code, reason);
    } catch {
      // Already closing.
    }
    if (stream) releaseIfIdle(stream);
  }

  const primeViewer = (stream: LaneStream, viewer: Viewer): void => {
    if (stream.configRecord) sendTo(stream, viewer, stream.configRecord);
    if (stream.keyframeRecord) sendTo(stream, viewer, stream.keyframeRecord);
  };

  return {
    issue({ laneId, codec = null, width = null, height = null, pointWidth = null, pointHeight = null }) {
      pruneTickets();
      const trimmed = laneId.trim();
      if (!trimmed) throw new Error("apple.streamTicket requires a laneId.");
      const ticket = randomBytes(24).toString("base64url");
      const token = randomBytes(32).toString("base64url");
      const expiresAtMs = now() + APPLE_STREAM_TICKET_TTL_MS;
      tickets.set(ticket, {
        ticket,
        token,
        laneId: trimmed,
        codec,
        width,
        height,
        expiresAtMs,
      });
      const path = `${APPLE_STREAM_PATH_PREFIX}${ticket}`;
      const origin = deps.publicOrigin?.() ?? null;
      return {
        url: origin ? `${origin.replace(/\/+$/, "")}${path}?token=${token}` : null,
        path,
        token,
        ticket,
        codec,
        width,
        height,
        pointWidth,
        pointHeight,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    },

    hasTicket(ticket) {
      pruneTickets();
      return tickets.has(ticket);
    },

    ticketFromUrl(url) {
      if (typeof url !== "string" || !url.startsWith(APPLE_STREAM_PATH_PREFIX)) return null;
      const withoutQuery = url.split("?")[0] ?? "";
      const id = withoutQuery.slice(APPLE_STREAM_PATH_PREFIX.length);
      return /^[A-Za-z0-9_-]{8,128}$/.test(id) ? id : null;
    },

    async attach(socket, { ticket, token }) {
      pruneTickets();
      const pending = tickets.get(ticket);
      if (!pending || !token || !constantTimeEquals(pending.token, token)) {
        // A warning, not a debug line: the viewer only says "the stream pass
        // expired", and this line is the one place that says why.
        warn("apple.stream_ticket_rejected", {
          reason: !pending ? "unknown_or_used_ticket" : !token ? "missing_token" : "token_mismatch",
        });
        try {
          socket.close(4401, "invalid stream ticket");
        } catch {
          // already closing
        }
        return false;
      }
      // Single use: a replayed ticket must not resume someone else's view.
      tickets.delete(ticket);
      const stream = laneStream(pending.laneId);
      const viewer: Viewer = {
        socket,
        laneId: pending.laneId,
        visible: true,
        closed: false,
        sent: 0,
        pacing: null,
      };
      stream.viewers.add(viewer);

      socket.on("message", (data: unknown, isBinary?: boolean) => {
        if (isBinary === true) return;
        const text = typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : data instanceof Uint8Array
              ? Buffer.from(data).toString("utf8")
              : null;
        if (!text) return;
        let parsed: { t?: unknown; n?: unknown };
        try {
          parsed = JSON.parse(text) as { t?: unknown; n?: unknown };
        } catch {
          return;
        }
        if (parsed.t === "ack") {
          if (typeof parsed.n === "number" && !viewer.closed) onAck(stream, viewer, parsed.n);
          return;
        }
        if (parsed.t === "hidden") {
          if (!viewer.visible) return;
          viewer.visible = false;
          releaseIfIdle(stream);
          return;
        }
        if (parsed.t === "visible") {
          if (viewer.visible || viewer.closed) return;
          viewer.visible = true;
          // What was out while hidden says nothing about the link now.
          if (viewer.pacing) {
            viewer.pacing.inflight = [];
            viewer.pacing.skipping = false;
          }
          void ensureUpstream(stream).then(() => primeViewer(stream, viewer));
        }
      });
      const onGone = (): void => dropViewer(viewer, 1000, "viewer closed");
      socket.on("close", onGone);
      socket.on("error", onGone);

      await ensureUpstream(stream);
      // After the upstream is up, not before: a viewer that joins an already
      // running lane gets the cached config and keyframe immediately, and one
      // that opened the lane gets nothing here because nothing has arrived yet.
      primeViewer(stream, viewer);
      return true;
    },

    viewerCount(laneId) {
      if (laneId) return lanes.get(laneId)?.viewers.size ?? 0;
      let total = 0;
      for (const stream of lanes.values()) total += stream.viewers.size;
      return total;
    },

    visibleViewerCount(laneId) {
      const count = (stream: LaneStream): number =>
        [...stream.viewers].filter((viewer) => viewer.visible && !viewer.closed).length;
      if (laneId) {
        const stream = lanes.get(laneId);
        return stream ? count(stream) : 0;
      }
      let total = 0;
      for (const stream of lanes.values()) total += count(stream);
      return total;
    },

    pendingTicketCount() {
      pruneTickets();
      return tickets.size;
    },

    dispose() {
      disposed = true;
      tickets.clear();
      for (const stream of [...lanes.values()]) {
        closeUpstream(stream);
        for (const viewer of [...stream.viewers]) {
          viewer.closed = true;
          try {
            viewer.socket.close(1001, "going away");
          } catch {
            // already closing
          }
        }
        stream.viewers.clear();
      }
      lanes.clear();
    },
  };
}

/** What the service may ask the relay before a local viewer's stop. */
export type AppleRemoteViewerProbe = {
  /** A remote viewer is reading this lane's capture right now. */
  watching(laneId: string): boolean;
  /** The relay now owns stopping this lane's capture. */
  adopt(laneId: string): void;
};

/** The slice of the simulator service the relay drives. */
export type AppleStreamOwningService = {
  getStreamStatus(args: { laneId?: string | null }): { running: boolean };
  startStream(args: { laneId?: string | null; bitrateKbps?: number | null }): Promise<{
    transport?: {
      url?: string | null;
      token?: string | null;
      codec?: string | null;
      width?: number | null;
      height?: number | null;
    } | null;
  }>;
  stopStream(args: { laneId?: string | null }): Promise<unknown>;
  /**
   * Is a renderer on this machine still watching this lane's stream? The
   * service tracks it, so the answer is the same whether the renderer reached
   * the service through IPC or a runtime action.
   */
  hasLocalViewer?: (laneId: string) => boolean;
  /**
   * Lets the service ask, before a LOCAL viewer's stop, whether a remote
   * viewer still reads the capture, and hand the stop to the relay if so.
   */
  setRemoteViewerProbe?: (probe: AppleRemoteViewerProbe | null) => void;
  /**
   * The last remote viewer left while a viewer on this machine still watches:
   * drop the remote bitrate cap so the local view is back at full quality.
   */
  liftStreamBitrateCap?: (args: { laneId: string }) => Promise<unknown>;
};

/**
 * Build a relay over a simulator service.
 *
 * The one rule worth naming: **the relay stops only what the relay started.**
 * The desktop reads the helper's loopback body itself, so the brain cannot see
 * its viewers; without this rule, closing a phone's viewer would black out the
 * Mac's own live view. Tracking which lanes this relay brought up is a cheaper
 * and more honest answer than inventing a local-viewer registry the desktop
 * would have to remember to update.
 */
export function createAppleStreamRelayForService(deps: {
  service: AppleStreamOwningService;
  /** `apple.remoteBitrateKbpsCap`, read per start so a settings change lands. */
  remoteBitrateKbpsCap: () => number | null;
  /**
   * Is a viewer on this machine's own renderer still watching this lane?
   *
   * `startedLanes` below answers "did the relay bring this up", which is not
   * the same question: a web tab can start a capture that the desktop column
   * then joins, and closing the tab would stop a device somebody is still
   * looking at. The headless brain has no renderer, so it passes nothing and
   * the answer is a constant false.
   */
  hasLocalViewer?: (laneId: string) => boolean;
  logger?: AppleStreamRelayDeps["logger"];
  connect?: AppleStreamRelayDeps["connect"];
  publicOrigin?: AppleStreamRelayDeps["publicOrigin"];
}): AppleStreamRelay {
  const startedLanes = new Set<string>();
  const relay = createAppleStreamRelay({
    logger: deps.logger,
    connect: deps.connect,
    publicOrigin: deps.publicOrigin,
    bitrateCapKbps: deps.remoteBitrateKbpsCap,
    // A running capture takes a new cap on its live encoder, keeping its
    // address and its readers (see the service's `startStream`).
    applyBitrateCap: ({ laneId, bitrateKbps }) => deps.service.startStream({ laneId, bitrateKbps }),
    // Fall back to the service's own tracker, so the brain (which passes no
    // registry) still sees a desktop renderer that joined a remote-started
    // capture.
    hasLocalViewer: deps.hasLocalViewer
      ?? (deps.service.hasLocalViewer
        ? (laneId: string) => deps.service.hasLocalViewer?.(laneId) ?? false
        : undefined),
    openSource: async ({ laneId }) => {
      const alreadyRunning = deps.service.getStreamStatus({ laneId }).running;
      const status = await deps.service.startStream({
        laneId,
        bitrateKbps: deps.remoteBitrateKbpsCap(),
      });
      if (!alreadyRunning) startedLanes.add(laneId);
      const transport = status.transport;
      if (!transport?.url || !transport.token) {
        throw new Error(
          `${APPLE_STREAM_NOT_RUNNING_CODE}: the Apple device helper reported no stream address for lane ${laneId}.`,
        );
      }
      return {
        url: transport.url,
        token: transport.token,
        codec: transport.codec ?? null,
        width: transport.width ?? null,
        height: transport.height ?? null,
      };
    },
    closeSource: async ({ laneId, localViewers }) => {
      if (localViewers) {
        // Somebody on this machine is still watching. Forget that the relay
        // started it: the local viewer owns the stop now, and a later remote
        // viewer must not inherit the right to end it. The cap was for the
        // remote viewers, so it goes with them.
        startedLanes.delete(laneId);
        await deps.service.liftStreamBitrateCap?.({ laneId });
        return;
      }
      // Not the relay's capture to stop, so it keeps running for whoever
      // started it, without the remote cap.
      if (!startedLanes.delete(laneId)) {
        await deps.service.liftStreamBitrateCap?.({ laneId });
        return;
      }
      await Promise.resolve(deps.service.stopStream({ laneId })).catch(() => null);
    },
  });
  // A desktop viewer leaving must not cut off a phone still reading the same
  // capture: the service asks here first, and the relay takes the stop over.
  deps.service.setRemoteViewerProbe?.({
    watching: (laneId) => relay.visibleViewerCount(laneId) > 0,
    adopt: (laneId) => {
      startedLanes.add(laneId);
    },
  });
  const disposeRelay = relay.dispose.bind(relay);
  return {
    ...relay,
    dispose: () => {
      deps.service.setRemoteViewerProbe?.(null);
      disposeRelay();
    },
  };
}
