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
import type { MacDesktopEventPayload } from "../../../shared/types/macDesktop";
import type {
  SyncMacDesktopStreamEndedPayload,
  SyncMacDesktopStreamRecordPayload,
  SyncMacDesktopStreamSubscribeResult,
} from "../../../shared/types/sync";
import type { Logger } from "../logging/logger";
import { createVideoRecordSplitter, VideoRecordFramingError } from "../media/videoRecords";

/** Queued bytes past which a subscription skips frames until the next keyframe. */
export const MAC_DESKTOP_SYNC_STREAM_PENDING_LIMIT_BYTES = 2 * 1024 * 1024;

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
  sendRecord(record: SyncMacDesktopStreamRecordPayload): void;
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
  now?: () => number;
  /** Test seam. Defaults to a loopback HTTP reader. */
  openReader?: (url: string) => MacDesktopSyncStreamReader;
};

type Subscription = {
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

export function createMacDesktopSyncStream(deps: MacDesktopSyncStreamDeps) {
  const now = deps.now ?? (() => Date.now());
  const openReader = deps.openReader ?? openLoopbackReader;
  const subscriptions = new Map<string, Subscription>();
  /** Subscribe calls still inside `startStream`, keyed id → connection. */
  const pending = new Map<string, string>();
  const cancelled = new Set<string>();
  let disposed = false;

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
    subscriptions.delete(subscription.subscriptionId);
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
    releaseOwner(subscription.subscriptionId);
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
    try {
      subscription.sink.sendRecord(record);
    } catch (error) {
      // A throwing sink is a dead transport. End without notifying it.
      endSubscription(subscription, "error", error instanceof Error ? error.message : String(error), { notify: false });
    }
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
      const existing = subscriptions.get(subscriptionId);
      if (existing) {
        if (existing.connectionId === args.connectionId) return existing.result;
        endSubscription(existing, "connection_closed", undefined, { notify: false });
      }
      const sink = args.sink;
      if (!sink) throw new Error("macDesktop.streamSubscribe requires a live sync connection.");
      pending.set(subscriptionId, args.connectionId);
      let started: MacDesktopSyncStreamStarted;
      try {
        started = await deps.startStream({ laneId, ownerId: subscriptionId });
      } catch (error) {
        pending.delete(subscriptionId);
        cancelled.delete(subscriptionId);
        throw error;
      }
      pending.delete(subscriptionId);
      const result: SyncMacDesktopStreamSubscribeResult = {
        ok: true,
        width: started.width,
        height: started.height,
        codec: started.codec,
      };
      // `startStream` is async; an unsubscribe or a socket close can land while
      // it was in flight. The owner was registered either way, so it still has
      // to be released.
      const wasCancelled = cancelled.delete(subscriptionId);
      if (disposed || wasCancelled) {
        releaseOwner(subscriptionId);
        return result;
      }
      const subscription: Subscription = {
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
      subscriptions.set(subscriptionId, subscription);
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
     * Ends one subscription. Safe for an id this process never had — the
     * unsubscribe may race the connection that owned it.
     */
    unsubscribe(subscriptionId: string): { ok: boolean } {
      const id = subscriptionId?.trim();
      if (!id) return { ok: true };
      const subscription = subscriptions.get(id);
      if (subscription) {
        endSubscription(subscription, "unsubscribed", undefined, { notify: true });
        return { ok: true };
      }
      // Still inside `startStream`: mark it so the owner is released when the
      // transport comes back.
      if (pending.has(id)) cancelled.add(id);
      return { ok: true };
    },

    /** Every subscription this sync connection owns is gone. */
    releaseConnection(connectionId: string): void {
      for (const [id, ownerConnectionId] of [...pending]) {
        if (ownerConnectionId !== connectionId) continue;
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
      return subscriptions.get(subscriptionId)?.droppedFrames ?? 0;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const subscription of [...subscriptions.values()]) {
        endSubscription(subscription, "stopped", undefined, { notify: false });
      }
      pending.clear();
      cancelled.clear();
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
      settled = true;
      request.destroy();
    },
  };
}
