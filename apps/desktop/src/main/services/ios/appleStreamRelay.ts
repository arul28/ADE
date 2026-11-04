import http from "node:http";
import https from "node:https";
import { randomBytes, timingSafeEqual } from "node:crypto";

import {
  type AppleDevicePosture,
} from "../../../shared/types/iosSimulator";
import {
  VIDEO_RECORD_FLAG_KEYFRAME,
  VIDEO_RECORD_HEADER_BYTES,
  VIDEO_RECORD_MAGIC,
  VIDEO_RECORD_TYPE_ACCESS_UNIT,
  VIDEO_RECORD_TYPE_CONFIG,
} from "../../../shared/types/videoRecords";
import { appleDuoScreenName } from "../../../shared/appleOrientation";
import {
  createAppleStreamBitrateAdapter,
  createAppleStreamViewerPacer,
  type AppleStreamBitrateAdapter,
  type AppleStreamViewerPacer,
} from "./appleStreamPacing";

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
 * A viewer that joins a running stream gets that still and then waits for
 * a fresh keyframe, which the relay asks for: the deltas after the cached one
 * reference frames the viewer never saw.
 *
 * **A viewer that acks is paced** (`appleStreamPacing.ts`): one that falls
 * behind skips delta frames and resumes at a keyframe, and the lane's encoder
 * cap follows the slowest paced link. A viewer that never acks (the web
 * client, older phones) is forwarded everything.
 */

export const APPLE_STREAM_PATH_PREFIX = "/apple/stream/";
export const APPLE_STREAM_TICKET_TTL_MS = 60_000;
export const APPLE_STREAM_NOT_RUNNING_CODE = "APPLE_STREAM_NOT_RUNNING" as const;

/** Keyframe probes per lane, at most one this often. */
const KEYFRAME_REQUEST_MIN_INTERVAL_MS = 1_000;
/** How long a new capture waits for the device's pose before its first frame. */
const FIRST_POSTURE_WAIT_MS = 400;

/** A keyframe probe that never sees a byte is abandoned after this. */
const KEYFRAME_PROBE_TIMEOUT_MS = 3_000;

/**
 * The relay's `{t:"posture"}` note: a foldable's hinge, the panel that is on,
 * and how its picture sits on the framebuffer. Text, like `{t:"stats"}`, so a
 * viewer that does not know it skips it.
 */
function appleStreamPostureNote(posture: AppleDevicePosture): string | null {
  if (!posture.supported) return null;
  return JSON.stringify({
    t: "posture",
    angle: posture.angle,
    screen: appleDuoScreenName(posture.activeScreenId),
    displayOrientation: posture.displayOrientation,
    tableMode: posture.tableMode,
  });
}

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
  /**
   * Read the device's pose for a capture just opened (`notePosture` it). The
   * relay waits up to `FIRST_POSTURE_WAIT_MS` before it reads frames, so the
   * first viewer is primed with the pose and draws its first frame the right
   * way up; a slower read still lands as a note.
   */
  readPosture?: (args: { laneId: string }) => Promise<void>;
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
  /**
   * A foldable's pose changed (or was read): every viewer of the lane hears
   * it as a `{t:"posture"}` note, and a viewer that joins later gets the last
   * one before its first frame. A phone draws the live panel the way the
   * guest says it sits, as the desktop does.
   */
  notePosture(laneId: string | null | undefined, posture: AppleDevicePosture): void;
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
  pacer: AppleStreamViewerPacer;
  /** Joined a running stream: deltas wait for the next keyframe. */
  awaitingKeyframe: boolean;
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
  bitrate: AppleStreamBitrateAdapter;
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
  while (buffer.byteLength - offset >= VIDEO_RECORD_HEADER_BYTES) {
    const view = new DataView(
      buffer.buffer,
      buffer.byteOffset + offset,
      VIDEO_RECORD_HEADER_BYTES,
    );
    if (view.getUint32(0, false) !== VIDEO_RECORD_MAGIC) {
      throw new Error("The Apple device stream is not framed as expected.");
    }
    const type = view.getUint8(4);
    const flags = view.getUint8(5);
    const length = view.getUint32(8, false);
    if (length > MAX_RECORD_BYTES) {
      throw new Error(`The Apple device stream declared a ${length} byte record.`);
    }
    const end = offset + VIDEO_RECORD_HEADER_BYTES + length;
    if (buffer.byteLength < end) break;
    records.push({
      type,
      keyframe: (flags & VIDEO_RECORD_FLAG_KEYFRAME) !== 0,
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
  /** The last posture note per lane, for viewers that join after it. */
  const postureNotes = new Map<string, string>();
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
      bitrate: createAppleStreamBitrateAdapter({
        now,
        ceilingKbps: () => deps.bitrateCapKbps?.() ?? null,
        apply: (kbps) => applyBitrateCap(created, kbps),
      }),
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
    if (!source || !stream.upstream || stream.keyframeProbe || disposed) return;
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
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      if (error) {
        warn("apple.stream_keyframe_probe_failed", { laneId: stream.laneId, error: error.message });
      }
      if (stream.keyframeProbe !== probe) return;
      stream.keyframeProbe = null;
      try {
        probe.close();
      } catch {
        // Already ended.
      }
    };
    const timer = setTimeout(() => finish(), KEYFRAME_PROBE_TIMEOUT_MS);
    timer.unref?.();
    probe.onData(() => finish());
    probe.onEnd(finish);
    debug("apple.stream_keyframe_requested", { laneId: stream.laneId });
  };

  /**
   * Re-cap the lane's running capture for pacing. Never while no upstream is
   * up: a cap sent to a capture the relay is closing could start a new one.
   */
  const applyBitrateCap = (stream: LaneStream, kbps: number): void => {
    if (!deps.applyBitrateCap || !stream.upstream || disposed) return;
    debug("apple.stream_bitrate_adapted", { laneId: stream.laneId, bitrateKbps: kbps });
    void Promise.resolve(deps.applyBitrateCap({ laneId: stream.laneId, bitrateKbps: kbps })).catch((error: unknown) => {
      warn("apple.stream_bitrate_adapt_failed", {
        laneId: stream.laneId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  /**
   * The paced viewers left and someone unpaced still watches: the lowered cap
   * was for a link that is gone. With nobody watching, `releaseIfIdle` lifts
   * the remote cap itself.
   */
  const restoreCapIfUnpaced = (stream: LaneStream): void => {
    const watching = [...stream.viewers].filter((viewer) => viewer.visible && !viewer.closed);
    if (watching.length === 0) return;
    if (watching.some((viewer) => viewer.pacer.acking)) return;
    stream.bitrate.restore();
  };

  const sendTo = (stream: LaneStream, viewer: Viewer, record: AppleStreamRecord): void => {
    if (viewer.closed || !viewer.visible) return;
    if (record.type === VIDEO_RECORD_TYPE_ACCESS_UNIT) {
      if (viewer.awaitingKeyframe) {
        if (!record.keyframe) {
          requestKeyframe(stream);
          return;
        }
        viewer.awaitingKeyframe = false;
      }
      const admission = viewer.pacer.admit(record.keyframe);
      if (admission.stalled) {
        debug("apple.stream_viewer_skipping", { laneId: stream.laneId });
        stream.bitrate.stalled();
      }
      if (!admission.send) {
        if (viewer.pacer.wantsKeyframe) requestKeyframe(stream);
        return;
      }
    }
    if (!sendRaw(viewer, record.bytes)) return;
    viewer.pacer.recordSent();
  };

  /** `{t:"ack",n}`: the viewer has received `n` records on this socket. */
  const onAck = (stream: LaneStream, viewer: Viewer, received: number): void => {
    if (viewer.closed || !viewer.visible) return;
    if (!viewer.pacer.ack(received)) return;
    // An idle simulator may send nothing for seconds, so a viewer that caught
    // up asks for its keyframe here rather than waiting on the next frame.
    if (viewer.pacer.wantsKeyframe) requestKeyframe(stream);
    stream.bitrate.maybeRaise();
    const stats = viewer.pacer.takeStats(stream.bitrate.kbps);
    if (stats) sendRaw(viewer, stats);
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
      if (record.type === VIDEO_RECORD_TYPE_CONFIG) {
        stream.configRecord = record;
      } else if (record.type === VIDEO_RECORD_TYPE_ACCESS_UNIT && record.keyframe) {
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
    // The next upstream is a new capture, opened on its own keyframe: the old
    // start would only show a stale picture and cost an encoder rebuild.
    stream.configRecord = null;
    stream.keyframeRecord = null;
    // It also starts at the configured cap, so pacing starts over.
    stream.bitrate.forget();
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

  /** The pose read for a new capture, but never longer than the cap. */
  const waitForFirstPosture = async (laneId: string): Promise<void> => {
    const read = deps.readPosture?.({ laneId }).catch((error: unknown) => {
      // The watcher's next change still reaches the viewers; only the first
      // frame may be drawn the old way up.
      warn("apple.stream_relay.posture_read_failed", {
        laneId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    if (!read) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      read,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FIRST_POSTURE_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
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
      await waitForFirstPosture(stream.laneId);
      if (disposed || stream.viewers.size === 0) return;
      stream.source = source;
      const upstream = connect(source);
      stream.upstream = upstream;
      upstream.onData((chunk) => onUpstreamChunk(stream, chunk));
      upstream.onEnd((error) => {
        if (stream.upstream !== upstream) return;
        stream.upstream = null;
        stream.buffer = new Uint8Array(0);
        stream.configRecord = null;
        stream.keyframeRecord = null;
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
    if (!stream) return;
    releaseIfIdle(stream);
    restoreCapIfUnpaced(stream);
  }

  /**
   * The cached config and keyframe at once, so a viewer that joins or comes
   * back has a picture, then no deltas until a fresh keyframe: the deltas
   * after the cached one reference frames it never saw. A viewer that opened
   * the lane finds nothing cached and reads the upstream from its start.
   */
  const primeViewer = (stream: LaneStream, viewer: Viewer): void => {
    // The pose first, so the first frame is drawn the right way up.
    const posture = postureNotes.get(stream.laneId);
    if (posture && !viewer.closed) {
      try {
        viewer.socket.send(posture);
      } catch {
        // The close handler drops it.
      }
    }
    if (!stream.configRecord && !stream.keyframeRecord) return;
    if (stream.configRecord) sendTo(stream, viewer, stream.configRecord);
    if (stream.keyframeRecord) sendTo(stream, viewer, stream.keyframeRecord);
    viewer.awaitingKeyframe = true;
    requestKeyframe(stream);
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
        pacer: createAppleStreamViewerPacer(now),
        awaitingKeyframe: false,
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
          if (typeof parsed.n === "number") onAck(stream, viewer, parsed.n);
          return;
        }
        if (parsed.t === "hidden") {
          if (!viewer.visible) return;
          viewer.visible = false;
          releaseIfIdle(stream);
          restoreCapIfUnpaced(stream);
          return;
        }
        if (parsed.t === "visible") {
          if (viewer.visible || viewer.closed) return;
          viewer.visible = true;
          // What was out while hidden says nothing about the link now.
          viewer.pacer.reset();
          void ensureUpstream(stream).then(() => primeViewer(stream, viewer));
        }
      });
      const onGone = (): void => dropViewer(viewer, 1000, "viewer closed");
      socket.on("close", onGone);
      socket.on("error", onGone);

      await ensureUpstream(stream);
      primeViewer(stream, viewer);
      return true;
    },

    notePosture(laneId, posture) {
      const key = laneId?.trim();
      if (!key || disposed) return;
      const note = appleStreamPostureNote(posture);
      // Not a foldable (another device now, or a rigid one): no pose to
      // replay, or a later viewer would draw it a Duo's way up.
      if (!note) {
        postureNotes.delete(key);
        return;
      }
      if (postureNotes.get(key) === note) return;
      postureNotes.set(key, note);
      const stream = lanes.get(key);
      if (!stream) return;
      for (const viewer of stream.viewers) {
        if (viewer.closed) continue;
        try {
          viewer.socket.send(note);
        } catch {
          // The close handler drops it.
        }
      }
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
      postureNotes.clear();
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
