/**
 * The subscription fan-out that turns a lane's loopback H.264 stream into
 * sync-socket push notifications.
 *
 * The desktop reads its stream from a token-guarded loopback URL that no paired
 * phone or hosted web client can reach. This module opens that same loopback
 * reader in-process — one HTTP reader per subscription, which the stream server
 * already maps to its own upstream TCP connection and its own forced keyframe —
 * and re-publishes each framed record through the subscriber's sink.
 *
 * Ownership rides the existing stream-owner set: every subscription is passed
 * to `startStream` as an owner keyed by its `subscriptionId`, so a viewer that
 * unsubscribes (or whose sync socket closes) drops out exactly like a closing
 * chat, and the encoder stops when the last owner leaves.
 *
 * Backpressure is per subscription and deliberately crude: once the sink
 * reports more than `MAC_DESKTOP_SYNC_STREAM_PENDING_LIMIT_BYTES` queued, frame
 * records are dropped until the next keyframe. A frame is never sent whose
 * reference frame the sink already lost.
 */

import { request as httpRequest } from "node:http";

import {
  IOS_VIDEO_RECORD_FLAG_KEYFRAME,
  IOS_VIDEO_RECORD_TYPE_CONFIG,
} from "../../../shared/types/iosSimulator";
import {
  MAC_DESKTOP_STREAM_SUBSCRIPTION_ID_TOO_LONG_CODE,
  MAC_DESKTOP_STREAM_SUBSCRIPTION_LIMIT_CODE,
  type MacDesktopEventPayload,
} from "../../../shared/types/macDesktop";
import type {
  SyncMacDesktopStreamEndedPayload,
  SyncMacDesktopStreamRecordPayload,
  SyncMacDesktopStreamSubscribeResult,
} from "../../../shared/types/sync";
import type { Logger } from "../logging/logger";
import { createVideoRecordSplitter, VideoRecordFramingError } from "../media/videoRecords";

/** Queued bytes past which a subscription skips frames until the next keyframe. */
export const MAC_DESKTOP_SYNC_STREAM_PENDING_LIMIT_BYTES = 2 * 1024 * 1024;

/** The longest `subscriptionId` the fan-out accepts from a sync client. */
export const MAC_DESKTOP_SYNC_STREAM_MAX_SUBSCRIPTION_ID_LENGTH = 128;

/**
 * Live subscriptions one connection may hold on one lane. A viewer needs one;
 * the second is a reconnect that has not released the first yet. More than two
 * is a client bug, and each one costs its own upstream connection.
 */
export const MAC_DESKTOP_SYNC_STREAM_MAX_SUBSCRIPTIONS_PER_CONNECTION_LANE = 2;

/** How often a delivered record is allowed to count as stream activity. */
export const MAC_DESKTOP_SYNC_STREAM_ACTIVITY_THROTTLE_MS = 1_000;

/**
 * A refusal the sync client can branch on: the host sends `error.code` with
 * the command result, and both limits are client mistakes rather than failures.
 */
export class MacDesktopSyncStreamError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MacDesktopSyncStreamError";
    this.code = code;
  }
}

/**
 * The reader half of a subscription: raw framed bytes from the lane's loopback
 * stream, with the transport's end and failure as separate signals. Injectable
 * so the fan-out can be tested without a socket.
 */
export type MacDesktopSyncStreamReader = {
  onChunk(callback: (chunk: Buffer) => void): void;
  onEnd(callback: () => void): void;
  onError(callback: (message: string) => void): void;
  close(): void;
};

/**
 * Where one subscriber's records go. `pendingBytes` is the transport's own
 * queue depth; the sink owns delivery, the fan-out only decides what is worth
 * sending.
 */
export type MacDesktopSyncStreamSink = {
  /** Identifies this subscriber's sync connection, for close-time cleanup. */
  connectionId: string;
  /**
   * False when the transport refused the record rather than queued it (the
   * sync host's `send` returns false at its 4 MiB backpressure gate). The
   * fan-out then treats the picture as broken and skips to the next keyframe,
   * the same as if `pendingBytes` had crossed the limit.
   */
  sendRecord(record: SyncMacDesktopStreamRecordPayload): boolean;
  sendEnded(ended: SyncMacDesktopStreamEndedPayload): void;
  pendingBytes(): number;
};

export type MacDesktopSyncStreamStarted = {
  url: string;
  width: number | null;
  height: number | null;
  codec: string | null;
};

export type MacDesktopSyncStreamSubscribeArgs = {
  laneId: string;
  subscriptionId: string;
  connectionId: string;
  viewerLabel?: string | null;
  sink?: MacDesktopSyncStreamSink;
};

export type MacDesktopSyncStreamDeps = {
  logger: Logger;
  /** Starts (or joins) the lane's stream and returns its loopback transport. */
  startStream: (args: { laneId: string; ownerId: string }) => Promise<MacDesktopSyncStreamStarted>;
  /** Drops one owner; stops the encoder when it was the lane's last. */
  releaseOwner: (ownerId: string) => Promise<void> | void;
  subscribeEvents?: (listener: (event: MacDesktopEventPayload) => void) => () => void;
  /**
   * Counts a live subscription as stream activity, so a passive viewer does
   * not fall to the idle rate after five quiet seconds. Wired to the stream
   * server's own `noteActivity`.
   */
  noteActivity?: (laneId: string) => void;
  now?: () => number;
  /** Test seam. Defaults to a loopback HTTP reader. */
  openReader?: (url: string) => MacDesktopSyncStreamReader;
};

type Subscription = {
  /** The subscription's key: its connection and its client-chosen id. */
  key: string;
  subscriptionId: string;
  laneId: string;
  connectionId: string;
  viewerLabel: string | null;
  sink: MacDesktopSyncStreamSink;
  result: SyncMacDesktopStreamSubscribeResult;
  reader: MacDesktopSyncStreamReader | null;
  splitter: ReturnType<typeof createVideoRecordSplitter>;
  seq: number;
  startedAtMs: number;
  droppingFrames: boolean;
  droppedFrames: number;
  ended: boolean;
};

/**
 * A subscription id is the client's own name for its stream, so it is only
 * unique on the connection that chose it. Keying by both means one viewer can
 * never end, replace or release another viewer's stream by reusing its id.
 * The key is also the stream owner id, so two connections' owners never merge.
 */
function subscriptionKey(connectionId: string, subscriptionId: string): string {
  return `${connectionId}\u0000${subscriptionId}`;
}

export function createMacDesktopSyncStream(deps: MacDesktopSyncStreamDeps) {
  const now = deps.now ?? (() => Date.now());
  const openReader = deps.openReader ?? openLoopbackReader;
  const subscriptions = new Map<string, Subscription>();
  /** Subscribe calls still inside `startStream`, keyed by subscription key. */
  const pending = new Map<string, { connectionId: string; laneId: string }>();
  const cancelled = new Set<string>();
  /** laneId → `now()` of the last activity note, for the 1s throttle. */
  const lastActivityNotedAtMs = new Map<string, number>();
  let disposed = false;

  /**
   * A live viewer is doing something: it is watching. Without this the stream
   * server's idle timer only hears about input paths, so a phone or browser
   * watching a lane the agent is not touching drops to the idle rate after
   * five seconds. Delivered records call it throttled to once per second;
   * subscribing calls it immediately because the forced keyframe that answers
   * a subscribe may not arrive for a moment.
   */
  function noteActivity(laneId: string, force = false): void {
    const note = deps.noteActivity;
    if (!note) return;
    const nowMs = now();
    if (!force) {
      const last = lastActivityNotedAtMs.get(laneId);
      if (last !== undefined && nowMs - last < MAC_DESKTOP_SYNC_STREAM_ACTIVITY_THROTTLE_MS) return;
    }
    lastActivityNotedAtMs.set(laneId, nowMs);
    note(laneId);
  }

  /** Live and in-flight subscriptions this connection holds on this lane. */
  function connectionLaneSubscriptionCount(connectionId: string, laneId: string): number {
    let count = 0;
    for (const subscription of subscriptions.values()) {
      if (subscription.connectionId === connectionId && subscription.laneId === laneId) count += 1;
    }
    for (const entry of pending.values()) {
      if (entry.connectionId === connectionId && entry.laneId === laneId) count += 1;
    }
    return count;
  }

  const eventUnsubscribe = deps.subscribeEvents?.((event) => {
    if (event.type === "display-destroyed") {
      endLaneSubscriptions(event.laneId, "display_destroyed", undefined);
      return;
    }
    if (event.type === "stream-stopped") {
      endLaneSubscriptions(event.status.laneId, "stopped", undefined);
      return;
    }
    if (event.type === "stream-error") {
      endLaneSubscriptions(event.status.laneId, "error", event.status.lastError ?? "The desktop stream failed.");
    }
  }) ?? null;

  function releaseOwner(ownerId: string): void {
    try {
      const result = deps.releaseOwner(ownerId);
      if (result && typeof (result as Promise<void>).then === "function") {
        void (result as Promise<void>).catch((error) => {
          deps.logger.debug("mac_desktop.sync_stream_release_failed", {
            subscriptionId: ownerId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    } catch (error) {
      deps.logger.debug("mac_desktop.sync_stream_release_failed", {
        subscriptionId: ownerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function endLaneSubscriptions(
    laneId: string,
    reason: SyncMacDesktopStreamEndedPayload["reason"],
    message: string | undefined,
  ): void {
    for (const subscription of [...subscriptions.values()]) {
      if (subscription.laneId !== laneId) continue;
      endSubscription(subscription, reason, message, { notify: true });
    }
  }

  function endSubscription(
    subscription: Subscription,
    reason: SyncMacDesktopStreamEndedPayload["reason"],
    message: string | undefined,
    options: { notify: boolean },
  ): void {
    if (subscription.ended) return;
    subscription.ended = true;
    // Remove before releasing: releaseOwner can stop the stream, which closes
    // our reader and would re-enter this path.
    subscriptions.delete(subscription.key);
    subscription.reader?.close();
    subscription.reader = null;
    if (options.notify) {
      try {
        subscription.sink.sendEnded({
          subscriptionId: subscription.subscriptionId,
          reason,
          ...(message ? { message } : {}),
        });
      } catch (error) {
        deps.logger.debug("mac_desktop.sync_stream_ended_send_failed", {
          subscriptionId: subscription.subscriptionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    releaseOwner(subscription.key);
    deps.logger.debug("mac_desktop.sync_stream_ended", {
      subscriptionId: subscription.subscriptionId,
      laneId: subscription.laneId,
      reason,
      droppedFrames: subscription.droppedFrames,
    });
  }

  function handleChunk(subscription: Subscription, chunk: Buffer): void {
    if (subscription.ended) return;
    let records;
    try {
      records = subscription.splitter.push(chunk);
    } catch (error) {
      const message = error instanceof VideoRecordFramingError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
      endSubscription(subscription, "error", message, { notify: true });
      return;
    }
    for (const record of records) {
      if (subscription.ended) return;
      if (record.type === IOS_VIDEO_RECORD_TYPE_CONFIG) {
        // A config always goes: it is small, and it is what lets a client that
        // joined mid-stream configure a decoder at all.
        pushRecord(subscription, "config", false, record.payload);
        continue;
      }
      const keyframe = (record.flags & IOS_VIDEO_RECORD_FLAG_KEYFRAME) !== 0;
      if (subscription.droppingFrames || subscription.sink.pendingBytes() > MAC_DESKTOP_SYNC_STREAM_PENDING_LIMIT_BYTES) {
        if (!keyframe) {
          subscription.droppingFrames = true;
          subscription.droppedFrames += 1;
          // `seq` counts source records, sent or not: a gap tells the client
          // frames were dropped, so it can hold P-frames until the keyframe.
          subscription.seq += 1;
          continue;
        }
        // Resuming at a keyframe is the only safe way back from dropped frames.
        subscription.droppingFrames = false;
      }
      pushRecord(subscription, "frame", keyframe, record.payload);
    }
  }

  function pushRecord(
    subscription: Subscription,
    kind: "config" | "frame",
    keyframe: boolean,
    payload: Buffer,
  ): void {
    const record: SyncMacDesktopStreamRecordPayload = {
      subscriptionId: subscription.subscriptionId,
      seq: subscription.seq,
      kind,
      keyframe,
      timestampUs: Math.max(0, Math.round((now() - subscription.startedAtMs) * 1000)),
      data: payload.toString("base64"),
    };
    subscription.seq += 1;
    let delivered = true;
    try {
      // The sync host's `send` returns false at its 4 MiB backpressure gate
      // instead of throwing. A refused record is lost but its `seq` is spent,
      // so the next delivered record carries the gap; the flag makes sure the
      // first one after that is a keyframe.
      delivered = subscription.sink.sendRecord(record) !== false;
    } catch (error) {
      // A throwing sink is a dead transport. End without notifying it.
      endSubscription(subscription, "error", error instanceof Error ? error.message : String(error), { notify: false });
      return;
    }
    if (!delivered) {
      subscription.droppingFrames = true;
      subscription.droppedFrames += 1;
      return;
    }
    noteActivity(subscription.laneId);
  }

  return {
    /**
     * Starts a subscription. Idempotent per `subscriptionId`: a client that
     * retries after a lost reply gets the live subscription back rather than a
     * second reader on the same lane.
     */
    async subscribe(args: MacDesktopSyncStreamSubscribeArgs): Promise<SyncMacDesktopStreamSubscribeResult> {
      if (disposed) throw new Error("The Mac Desktop sync stream has been disposed.");
      const laneId = args.laneId?.trim();
      const subscriptionId = args.subscriptionId?.trim();
      if (!laneId) throw new Error("macDesktop.streamSubscribe requires laneId.");
      if (!subscriptionId) throw new Error("macDesktop.streamSubscribe requires subscriptionId.");
      if (subscriptionId.length > MAC_DESKTOP_SYNC_STREAM_MAX_SUBSCRIPTION_ID_LENGTH) {
        throw new MacDesktopSyncStreamError(
          MAC_DESKTOP_STREAM_SUBSCRIPTION_ID_TOO_LONG_CODE,
          `macDesktop.streamSubscribe subscriptionId is limited to `
            + `${MAC_DESKTOP_SYNC_STREAM_MAX_SUBSCRIPTION_ID_LENGTH} characters.`,
        );
      }
      const key = subscriptionKey(args.connectionId, subscriptionId);
      const existing = subscriptions.get(key);
      if (existing) return existing.result;
      if (
        connectionLaneSubscriptionCount(args.connectionId, laneId)
        >= MAC_DESKTOP_SYNC_STREAM_MAX_SUBSCRIPTIONS_PER_CONNECTION_LANE
      ) {
        throw new MacDesktopSyncStreamError(
          MAC_DESKTOP_STREAM_SUBSCRIPTION_LIMIT_CODE,
          `macDesktop.streamSubscribe allows `
            + `${MAC_DESKTOP_SYNC_STREAM_MAX_SUBSCRIPTIONS_PER_CONNECTION_LANE} live subscriptions `
            + "per connection per lane.",
        );
      }
      const sink = args.sink;
      if (!sink) throw new Error("macDesktop.streamSubscribe requires a live sync connection.");
      pending.set(key, { connectionId: args.connectionId, laneId });
      let started: MacDesktopSyncStreamStarted;
      try {
        started = await deps.startStream({ laneId, ownerId: key });
      } catch (error) {
        pending.delete(key);
        cancelled.delete(key);
        throw error;
      }
      pending.delete(key);
      const result: SyncMacDesktopStreamSubscribeResult = {
        ok: true,
        width: started.width,
        height: started.height,
        codec: started.codec,
      };
      // `startStream` is async; an unsubscribe or a socket close can land while
      // it was in flight. The owner was registered either way, so it still has
      // to be released.
      const wasCancelled = cancelled.delete(key);
      if (disposed || wasCancelled) {
        releaseOwner(key);
        return result;
      }
      noteActivity(laneId, true);
      const subscription: Subscription = {
        key,
        subscriptionId,
        laneId,
        connectionId: args.connectionId,
        viewerLabel: args.viewerLabel?.trim() || null,
        sink,
        result,
        reader: null,
        splitter: createVideoRecordSplitter(),
        seq: 0,
        startedAtMs: now(),
        droppingFrames: false,
        droppedFrames: 0,
        ended: false,
      };
      subscriptions.set(key, subscription);
      let reader: MacDesktopSyncStreamReader;
      try {
        reader = openReader(started.url);
      } catch (error) {
        endSubscription(
          subscription,
          "error",
          error instanceof Error ? error.message : String(error),
          { notify: false },
        );
        throw error instanceof Error ? error : new Error(String(error));
      }
      subscription.reader = reader;
      reader.onChunk((chunk) => handleChunk(subscription, chunk));
      reader.onEnd(() => endSubscription(subscription, "stopped", undefined, { notify: true }));
      reader.onError((message) => endSubscription(subscription, "error", message, { notify: true }));
      deps.logger.debug("mac_desktop.sync_stream_subscribed", {
        subscriptionId,
        laneId,
        connectionId: args.connectionId,
        viewerLabel: subscription.viewerLabel,
      });
      return result;
    },

    /**
     * Ends one of this connection's subscriptions. Safe for an id this
     * process never had — the unsubscribe may race the connection that owned
     * it — and a no-op for another connection's id: without the connection
     * that subscribed there is nothing this caller may end.
     */
    unsubscribe(subscriptionId: string, connectionId?: string | null): { ok: boolean } {
      const id = subscriptionId?.trim();
      if (!id || !connectionId) return { ok: true };
      const key = subscriptionKey(connectionId, id);
      const subscription = subscriptions.get(key);
      if (subscription) {
        endSubscription(subscription, "unsubscribed", undefined, { notify: true });
        return { ok: true };
      }
      // Still inside `startStream`: mark it so the owner is released when the
      // transport comes back.
      if (pending.has(key)) cancelled.add(key);
      return { ok: true };
    },

    /** Every subscription this sync connection owns is gone. */
    releaseConnection(connectionId: string): void {
      for (const [id, owner] of [...pending]) {
        if (owner.connectionId !== connectionId) continue;
        cancelled.add(id);
      }
      for (const subscription of [...subscriptions.values()]) {
        if (subscription.connectionId !== connectionId) continue;
        endSubscription(subscription, "connection_closed", undefined, { notify: false });
      }
    },

    /** Test seam: how many subscriptions are live. */
    subscriptionCount(): number {
      return subscriptions.size;
    },

    /** Test seam: how many frames one subscription has dropped. */
    droppedFrameCount(subscriptionId: string): number {
      for (const subscription of subscriptions.values()) {
        if (subscription.subscriptionId === subscriptionId) return subscription.droppedFrames;
      }
      return 0;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const subscription of [...subscriptions.values()]) {
        endSubscription(subscription, "stopped", undefined, { notify: false });
      }
      pending.clear();
      cancelled.clear();
      lastActivityNotedAtMs.clear();
      eventUnsubscribe?.();
    },
  };
}

export type MacDesktopSyncStream = ReturnType<typeof createMacDesktopSyncStream>;

/**
 * The default reader: one HTTP GET against the lane's loopback stream. The
 * stream server treats it exactly like a desktop reader — its own upstream TCP
 * connection, its own config record, and a forced keyframe — so the brain does
 * not need a second framing path.
 *
 * The request is dispatched here, after every handler is wired: `http.request`
 * only builds the request object. Without `end()` nothing is written to the
 * socket, the server never answers, and the reader sits silent forever — which
 * is exactly how the brain's first live view behaved.
 */
export function openLoopbackReader(url: string): MacDesktopSyncStreamReader {
  let chunkHandler: ((chunk: Buffer) => void) | null = null;
  let endHandler: (() => void) | null = null;
  let errorHandler: ((message: string) => void) | null = null;
  let settled = false;

  const settleEnd = (): void => {
    if (settled) return;
    settled = true;
    endHandler?.();
  };
  const settleError = (message: string): void => {
    if (settled) return;
    settled = true;
    errorHandler?.(message);
  };

  const request = httpRequest(new URL(url), { method: "GET" }, (response) => {
    if (response.statusCode !== 200) {
      settleError(`The desktop stream answered ${response.statusCode}.`);
      response.resume();
      return;
    }
    response.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      chunkHandler?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    response.on("end", settleEnd);
    response.on("error", (error: Error) => settleError(error.message));
  });
  request.on("error", (error: Error) => settleError(error.message));
  request.on("close", settleEnd);
  // Dispatch now that the response path is wired. Nothing can be delivered
  // before the caller registers its handlers: both the response callback and
  // every socket event are asynchronous, so the same-turn registration in
  // `subscribe` always wins the race.
  request.end();

  return {
    onChunk(callback) {
      chunkHandler = callback;
    },
    onEnd(callback) {
      endHandler = callback;
    },
    onError(callback) {
      errorHandler = callback;
    },
    close() {
      if (settled) return;
      request.destroy();
      // The request's own close event is asynchronous, so this guard still
      // lands first: an explicit close never doubles as an end notification.
      settled = true;
    },
  };
}
