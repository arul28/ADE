/**
 * The App Control live view for sync clients (phone and hosted web client).
 *
 * App Control already receives a CDP screencast for the desktop's own live
 * view: JPEG frames, emitted as `{ type: "frame" }` service events. This module
 * forwards those frames to sync subscribers, keyed by lane. It never starts or
 * stops the screencast and never encodes anything.
 *
 * Every subscription is throttled on its own:
 * - at most `maxFps` frames a second (10 by default, a client may ask for less);
 * - at most `maxBytesPerSecond` of base64 per rolling second;
 * - only the newest frame is kept. A frame that cannot go out now (rate, byte
 *   budget, or a socket over `pendingLimitBytes`) waits in a single slot and is
 *   replaced by any newer frame. Nothing queues.
 *
 * A pending frame is always delivered once the throttle allows it, so a still
 * app (CDP sends frames only when the page repaints) ends on its real last
 * picture rather than on whatever frame happened to fit the budget.
 *
 * Per lane: frames are matched to a lane by `event.laneId`, then
 * `event.frame.laneId`, then the session id → lane map this module builds from
 * session events and status reads. That covers both the single-session service
 * (frames carry only `sessionId`) and the per-lane service (frames carry
 * `laneId`).
 *
 * When no subscription is live, a frame costs one map write: the newest frame
 * per lane is kept by reference so a new viewer sees a picture at once.
 */

import type { AppControlEventPayload, AppControlScreencastFrame, AppControlSession } from "../../../../desktop/src/shared/types/appControl";
import type {
  SyncAppControlSession,
  SyncAppControlStatus,
  SyncAppControlStreamEndedPayload,
  SyncAppControlStreamFramePayload,
  SyncAppControlStreamSubscribeResult,
} from "../../../../desktop/src/shared/types/sync";
import type { Logger } from "../../../../desktop/src/main/services/logging/logger";

export const APP_CONTROL_SYNC_STREAM_DEFAULT_MAX_FPS = 10;
/** Base64 characters one subscription may receive per rolling second. */
export const APP_CONTROL_SYNC_STREAM_MAX_BYTES_PER_SECOND = 1_500_000;
/** Socket queue depth past which a subscription waits instead of sending. */
export const APP_CONTROL_SYNC_STREAM_PENDING_LIMIT_BYTES = 1024 * 1024;
export const APP_CONTROL_SYNC_STREAM_MAX_SUBSCRIPTION_ID_LENGTH = 128;
/** One viewer, plus one reconnect that has not released the first yet. */
export const APP_CONTROL_SYNC_STREAM_MAX_SUBSCRIPTIONS_PER_CONNECTION_LANE = 2;
/** A lane counts as live while its newest frame is younger than this. */
export const APP_CONTROL_SYNC_STREAM_LIVE_WINDOW_MS = 5_000;

export const APP_CONTROL_STREAM_SUBSCRIPTION_LIMIT_CODE = "app_control_stream_subscription_limit";
export const APP_CONTROL_STREAM_SUBSCRIPTION_ID_TOO_LONG_CODE = "app_control_stream_subscription_id_too_long";

export class AppControlSyncStreamError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AppControlSyncStreamError";
    this.code = code;
  }
}

/** Where one subscriber's frames go. The sync host owns delivery. */
export type AppControlSyncStreamSink = {
  connectionId: string;
  /** False when the transport refused the frame (its backpressure gate). */
  sendFrame(frame: SyncAppControlStreamFramePayload): boolean;
  sendEnded(ended: SyncAppControlStreamEndedPayload): void;
  pendingBytes(): number;
  /**
   * True once the socket is gone. A command routed to another project's host
   * is not released by this host's close handler, so the fan-out checks this
   * itself before every send.
   */
  isClosed?(): boolean;
};

/**
 * The status shape this module reads. It accepts both the single-session
 * service (`activeSession` only) and the per-lane service (`sessions`, and a
 * `getStatus({ laneId })` that answers for that lane).
 */
export type AppControlSyncStatusSource = {
  /** The lane the service answered for (per-lane service only). */
  laneId?: string | null;
  platform?: string | null;
  supported?: boolean | null;
  activeSession?: AppControlSession | null;
  sessions?: AppControlSession[] | null;
};

/** A frame event, with the lane fields a per-lane service adds. */
type AppControlFrameEvent = Extract<AppControlEventPayload, { type: "frame" }> & {
  laneId?: string | null;
  frame: AppControlScreencastFrame & { laneId?: string | null };
};

/** The narrow App Control surface this module needs. */
export type AppControlSyncSource = {
  getStatus: (
    args?: { laneId?: string | null; chatSessionId?: string | null },
  ) => Promise<AppControlSyncStatusSource> | AppControlSyncStatusSource;
  subscribeEvents: (listener: (event: AppControlEventPayload) => void) => () => void;
  /**
   * The lane's current picture when this module has none: a still app sends
   * no screencast frames, so a new viewer would wait forever. The service
   * publishes a fresh capture as a `frame` event, which fans out as usual.
   */
  getLatestFrame?: (args: { laneId: string }) => Promise<AppControlScreencastFrame | null>;
};

export type AppControlSyncStreamDeps = {
  logger: Logger;
  source: AppControlSyncSource;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  maxBytesPerSecond?: number;
  pendingLimitBytes?: number;
};

export type AppControlSyncStreamSubscribeArgs = {
  laneId: string;
  subscriptionId: string;
  connectionId: string;
  viewerLabel?: string | null;
  maxFps?: number | null;
  sink?: AppControlSyncStreamSink;
};

type LaneFrame = {
  frame: AppControlScreencastFrame;
  receivedAtMs: number;
};

type Subscription = {
  /** The subscription's key: its connection and its client-chosen id. */
  key: string;
  subscriptionId: string;
  laneId: string;
  connectionId: string;
  viewerLabel: string | null;
  sink: AppControlSyncStreamSink;
  result: SyncAppControlStreamSubscribeResult;
  minIntervalMs: number;
  seq: number;
  lastSentAtMs: number | null;
  /** Start of the current one-second byte window, and bytes sent in it. */
  windowStartedAtMs: number;
  windowBytes: number;
  pending: AppControlScreencastFrame | null;
  timer: unknown;
  sentFrames: number;
  droppedFrames: number;
  ended: boolean;
};

function cleanId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Strips host-only fields (launch command, CDP endpoint, pid, terminal ids). */
export function toSyncAppControlSession(session: AppControlSession | null | undefined): SyncAppControlSession | null {
  if (!session) return null;
  return {
    id: session.id,
    appKind: session.appKind,
    label: session.label,
    laneId: session.laneId ?? null,
    chatSessionId: session.chatSessionId ?? null,
    provider: session.provider,
    driver: session.driver,
    status: session.status,
    cdpTargetId: session.cdpTargetId ?? null,
    startedAt: session.startedAt,
    connectedAt: session.connectedAt ?? null,
    lastError: session.lastError ?? null,
  };
}

function statusSessions(status: AppControlSyncStatusSource | null | undefined): AppControlSession[] {
  const sessions: AppControlSession[] = [];
  const seen = new Set<string>();
  const add = (session: AppControlSession | null | undefined) => {
    if (!session || seen.has(session.id)) return;
    seen.add(session.id);
    sessions.push(session);
  };
  for (const session of status?.sessions ?? []) add(session);
  add(status?.activeSession ?? null);
  return sessions;
}

/** The lane's session in a status answer, whichever service shape it came from. */
function laneSession(status: AppControlSyncStatusSource | null | undefined, laneId: string): AppControlSession | null {
  return statusSessions(status).find((session) => session.laneId === laneId) ?? null;
}

/**
 * A subscription id is the client's own name for its stream, so it is only
 * unique on the connection that chose it. Keying by both means one viewer can
 * never end or replace another viewer's stream by reusing its id.
 */
function subscriptionKey(connectionId: string, subscriptionId: string): string {
  return `${connectionId}\u0000${subscriptionId}`;
}

function clampFps(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return APP_CONTROL_SYNC_STREAM_DEFAULT_MAX_FPS;
  return Math.max(1, Math.min(APP_CONTROL_SYNC_STREAM_DEFAULT_MAX_FPS, Math.floor(value)));
}

export function createAppControlSyncStream(deps: AppControlSyncStreamDeps) {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const maxBytesPerSecond = Math.max(1, deps.maxBytesPerSecond ?? APP_CONTROL_SYNC_STREAM_MAX_BYTES_PER_SECOND);
  const pendingLimitBytes = Math.max(0, deps.pendingLimitBytes ?? APP_CONTROL_SYNC_STREAM_PENDING_LIMIT_BYTES);

  const subscriptions = new Map<string, Subscription>();
  /** sessionId → laneId, learned from session events and status reads. */
  const sessionLanes = new Map<string, string>();
  /** laneId → newest frame, kept by reference. */
  const latestFrames = new Map<string, LaneFrame>();
  let disposed = false;

  function learnSession(session: AppControlSession | null | undefined): void {
    if (!session) return;
    const laneId = cleanId(session.laneId);
    if (laneId) sessionLanes.set(session.id, laneId);
  }

  function forgetSession(session: AppControlSession | null | undefined): void {
    if (!session) return;
    const laneId = sessionLanes.get(session.id) ?? cleanId(session.laneId);
    sessionLanes.delete(session.id);
    // The lane's last picture belongs to the app that just went away.
    if (laneId && latestFrames.get(laneId)?.frame.sessionId === session.id) latestFrames.delete(laneId);
  }

  function frameLaneId(event: AppControlFrameEvent): string | null {
    return cleanId(event.laneId)
      ?? cleanId(event.frame.laneId)
      ?? sessionLanes.get(event.frame.sessionId)
      ?? null;
  }

  const eventUnsubscribe = deps.source.subscribeEvents((event) => {
    if (disposed) return;
    switch (event.type) {
      case "session-started":
        learnSession(event.session);
        return;
      case "session-updated":
        learnSession(event.session);
        return;
      case "session-stopped":
        forgetSession(event.previousSession);
        return;
      case "frame": {
        const frameEvent = event as AppControlFrameEvent;
        const laneId = frameLaneId(frameEvent);
        if (!laneId) return;
        latestFrames.set(laneId, { frame: frameEvent.frame, receivedAtMs: now() });
        for (const subscription of subscriptions.values()) {
          if (subscription.laneId !== laneId) continue;
          subscription.pending = frameEvent.frame;
          flush(subscription);
        }
        return;
      }
      default:
        return;
    }
  });

  function cancelTimer(subscription: Subscription): void {
    if (subscription.timer == null) return;
    clearTimer(subscription.timer);
    subscription.timer = null;
  }

  function schedule(subscription: Subscription, delayMs: number): void {
    if (subscription.timer != null || subscription.ended) return;
    subscription.timer = setTimer(() => {
      subscription.timer = null;
      flush(subscription);
    }, Math.max(1, Math.ceil(delayMs)));
  }

  /** Sends the pending frame now if the throttle allows it, else waits. */
  function flush(subscription: Subscription): void {
    if (subscription.ended || disposed) return;
    const frame = subscription.pending;
    if (!frame) return;
    if (subscription.sink.isClosed?.()) {
      endSubscription(subscription, "connection_closed", undefined, { notify: false });
      return;
    }
    const nowMs = now();
    if (subscription.lastSentAtMs != null) {
      const waitMs = subscription.lastSentAtMs + subscription.minIntervalMs - nowMs;
      if (waitMs > 0) {
        schedule(subscription, waitMs);
        return;
      }
    }
    if (nowMs - subscription.windowStartedAtMs >= 1_000) {
      subscription.windowStartedAtMs = nowMs;
      subscription.windowBytes = 0;
    }
    const bytes = frame.data.length;
    // One frame larger than the whole budget still goes out on a fresh window;
    // otherwise a big screen would never be shown at all.
    if (subscription.windowBytes > 0 && subscription.windowBytes + bytes > maxBytesPerSecond) {
      schedule(subscription, subscription.windowStartedAtMs + 1_000 - nowMs);
      return;
    }
    if (subscription.sink.pendingBytes() > pendingLimitBytes) {
      // The socket is behind. Keep only this frame and look again later.
      subscription.droppedFrames += 1;
      schedule(subscription, subscription.minIntervalMs);
      return;
    }
    const payload: SyncAppControlStreamFramePayload = {
      subscriptionId: subscription.subscriptionId,
      laneId: subscription.laneId,
      seq: subscription.seq,
      sessionId: frame.sessionId,
      cdpTargetId: frame.cdpTargetId ?? null,
      mimeType: frame.mimeType,
      data: frame.data,
      width: frame.width,
      height: frame.height,
      scale: frame.scale,
      ...(frame.viewportWidth != null ? { viewportWidth: frame.viewportWidth } : {}),
      ...(frame.viewportHeight != null ? { viewportHeight: frame.viewportHeight } : {}),
      ...(frame.devicePixelRatio != null ? { devicePixelRatio: frame.devicePixelRatio } : {}),
      ...(frame.scaleX != null ? { scaleX: frame.scaleX } : {}),
      ...(frame.scaleY != null ? { scaleY: frame.scaleY } : {}),
      capturedAt: frame.capturedAt,
    };
    let delivered: boolean;
    try {
      delivered = subscription.sink.sendFrame(payload) !== false;
    } catch (error) {
      // A throwing sink is a dead transport. End without notifying it.
      endSubscription(subscription, "error", error instanceof Error ? error.message : String(error), { notify: false });
      return;
    }
    if (!delivered) {
      subscription.droppedFrames += 1;
      schedule(subscription, subscription.minIntervalMs);
      return;
    }
    subscription.seq += 1;
    subscription.sentFrames += 1;
    subscription.lastSentAtMs = nowMs;
    subscription.windowBytes += bytes;
    // Only clear the slot if no newer frame replaced it during the send.
    if (subscription.pending === frame) subscription.pending = null;
  }

  function endSubscription(
    subscription: Subscription,
    reason: SyncAppControlStreamEndedPayload["reason"],
    message: string | undefined,
    options: { notify: boolean },
  ): void {
    if (subscription.ended) return;
    subscription.ended = true;
    subscriptions.delete(subscription.key);
    cancelTimer(subscription);
    subscription.pending = null;
    if (options.notify) {
      try {
        subscription.sink.sendEnded({
          subscriptionId: subscription.subscriptionId,
          reason,
          ...(message ? { message } : {}),
        });
      } catch (error) {
        deps.logger.debug("app_control.sync_stream_ended_send_failed", {
          subscriptionId: subscription.subscriptionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    deps.logger.debug("app_control.sync_stream_ended", {
      subscriptionId: subscription.subscriptionId,
      laneId: subscription.laneId,
      reason,
      sentFrames: subscription.sentFrames,
      droppedFrames: subscription.droppedFrames,
    });
  }

  function connectionLaneCount(connectionId: string, laneId: string): number {
    let count = 0;
    for (const subscription of subscriptions.values()) {
      if (subscription.connectionId === connectionId && subscription.laneId === laneId) count += 1;
    }
    return count;
  }

  async function readStatus(
    laneId: string | null,
    chatSessionId: string | null = null,
  ): Promise<AppControlSyncStatusSource | null> {
    try {
      const status = await deps.source.getStatus(
        laneId || chatSessionId
          ? { ...(laneId ? { laneId } : {}), ...(chatSessionId ? { chatSessionId } : {}) }
          : undefined,
      );
      for (const session of statusSessions(status)) learnSession(session);
      return status ?? null;
    } catch (error) {
      deps.logger.debug("app_control.sync_stream_status_failed", {
        laneId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  function laneViewerCount(laneId: string): number {
    let count = 0;
    for (const subscription of subscriptions.values()) {
      if (subscription.laneId === laneId) count += 1;
    }
    return count;
  }

  return {
    /**
     * The lane's App Control state for a remote viewer. A chat id names the
     * chat's lane. With neither there is no session to show: a viewer watches
     * one lane at a time, like Mac Desktop and Apple, and never falls back to
     * some other lane's app.
     */
    async getStatus(args: { laneId?: string | null; chatSessionId?: string | null } = {}): Promise<SyncAppControlStatus> {
      const chatSessionId = cleanId(args.chatSessionId);
      const status = await readStatus(cleanId(args.laneId), chatSessionId);
      const laneId = cleanId(args.laneId) ?? cleanId(status?.laneId);
      const session = laneId ? laneSession(status, laneId) : null;
      const latest = laneId ? latestFrames.get(laneId) ?? null : null;
      const latestIsCurrent = Boolean(latest && session && latest.frame.sessionId === session.id);
      return {
        laneId,
        platform: status?.platform ?? process.platform,
        supported: status?.supported ?? false,
        session: toSyncAppControlSession(session),
        sessions: [],
        stream: {
          live: Boolean(latestIsCurrent && latest && now() - latest.receivedAtMs < APP_CONTROL_SYNC_STREAM_LIVE_WINDOW_MS),
          lastFrameAt: latestIsCurrent && latest ? latest.frame.capturedAt : null,
          width: latestIsCurrent && latest ? latest.frame.width : null,
          height: latestIsCurrent && latest ? latest.frame.height : null,
          viewerCount: laneId ? laneViewerCount(laneId) : 0,
        },
      };
    },

    /**
     * Starts forwarding the lane's frames to this sink. Idempotent per
     * `subscriptionId` on the same connection. Subscribing to a lane with no
     * session is allowed: frames start when an app attaches there.
     */
    async subscribe(args: AppControlSyncStreamSubscribeArgs): Promise<SyncAppControlStreamSubscribeResult> {
      if (disposed) throw new Error("The App Control sync stream has been disposed.");
      const laneId = cleanId(args.laneId);
      const subscriptionId = cleanId(args.subscriptionId);
      if (!laneId) throw new Error("appControl.streamSubscribe requires laneId.");
      if (!subscriptionId) throw new Error("appControl.streamSubscribe requires subscriptionId.");
      if (subscriptionId.length > APP_CONTROL_SYNC_STREAM_MAX_SUBSCRIPTION_ID_LENGTH) {
        throw new AppControlSyncStreamError(
          APP_CONTROL_STREAM_SUBSCRIPTION_ID_TOO_LONG_CODE,
          `appControl.streamSubscribe subscriptionId is limited to ${APP_CONTROL_SYNC_STREAM_MAX_SUBSCRIPTION_ID_LENGTH} characters.`,
        );
      }
      const sink = args.sink;
      if (!sink) throw new Error("appControl.streamSubscribe requires a live sync connection.");
      const key = subscriptionKey(args.connectionId, subscriptionId);
      const existing = subscriptions.get(key);
      if (existing) {
        if (existing.laneId === laneId) return existing.result;
        endSubscription(existing, "connection_closed", undefined, { notify: false });
      }
      if (connectionLaneCount(args.connectionId, laneId) >= APP_CONTROL_SYNC_STREAM_MAX_SUBSCRIPTIONS_PER_CONNECTION_LANE) {
        throw new AppControlSyncStreamError(
          APP_CONTROL_STREAM_SUBSCRIPTION_LIMIT_CODE,
          `appControl.streamSubscribe allows ${APP_CONTROL_SYNC_STREAM_MAX_SUBSCRIPTIONS_PER_CONNECTION_LANE} live subscriptions per connection per lane.`,
        );
      }
      const status = await readStatus(laneId);
      if (disposed) throw new Error("The App Control sync stream has been disposed.");
      const session = laneSession(status, laneId);
      const latest = latestFrames.get(laneId) ?? null;
      const maxFps = clampFps(args.maxFps);
      const result: SyncAppControlStreamSubscribeResult = {
        ok: true,
        laneId,
        maxFps,
        session: toSyncAppControlSession(session),
        width: latest?.frame.width ?? null,
        height: latest?.frame.height ?? null,
      };
      // A second subscribe with the same id can land while the status read was
      // in flight. The first one wins; this one hands back its result.
      const raced = subscriptions.get(key);
      if (raced && raced.laneId === laneId) return raced.result;
      if (raced) endSubscription(raced, "connection_closed", undefined, { notify: false });
      const subscription: Subscription = {
        key,
        subscriptionId,
        laneId,
        connectionId: args.connectionId,
        viewerLabel: cleanId(args.viewerLabel),
        sink,
        result,
        minIntervalMs: 1_000 / maxFps,
        seq: 0,
        lastSentAtMs: null,
        windowStartedAtMs: now(),
        windowBytes: 0,
        pending: null,
        timer: null,
        sentFrames: 0,
        droppedFrames: 0,
        ended: false,
      };
      subscriptions.set(key, subscription);
      deps.logger.debug("app_control.sync_stream_subscribed", {
        subscriptionId,
        laneId,
        connectionId: args.connectionId,
        viewerLabel: subscription.viewerLabel,
        maxFps,
      });
      // The newest frame goes out on the next tick, after the command reply,
      // so the client has registered its handler for this subscription id.
      if (latest && (!session || latest.frame.sessionId === session.id)) {
        subscription.pending = latest.frame;
        schedule(subscription, 1);
      } else if (session && deps.source.getLatestFrame) {
        // No picture yet (a still app, or frames from before this module
        // listened). Ask for one; it arrives as a frame event.
        void Promise.resolve()
          .then(() => deps.source.getLatestFrame?.({ laneId }))
          .then((frame) => {
            if (!frame || subscription.ended || disposed || subscription.pending || subscription.sentFrames > 0) return;
            if (frame.sessionId !== session.id) return;
            subscription.pending = frame;
            schedule(subscription, 1);
          })
          .catch((error: unknown) => {
            deps.logger.debug("app_control.sync_stream_latest_frame_failed", {
              laneId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
      return result;
    },

    /**
     * Ends one of this connection's subscriptions. Safe for an id this process
     * never had, and a no-op for another connection's id: without the
     * connection that subscribed there is nothing this caller may end.
     */
    unsubscribe(subscriptionId: string, connectionId?: string | null): { ok: true } {
      const id = cleanId(subscriptionId);
      const subscription = id && connectionId ? subscriptions.get(subscriptionKey(connectionId, id)) : undefined;
      if (subscription) endSubscription(subscription, "unsubscribed", undefined, { notify: true });
      return { ok: true };
    },

    /** Every subscription this sync connection owns is gone. */
    releaseConnection(connectionId: string): void {
      for (const subscription of [...subscriptions.values()]) {
        if (subscription.connectionId !== connectionId) continue;
        endSubscription(subscription, "connection_closed", undefined, { notify: false });
      }
    },

    /** Test seam: live subscriptions. */
    subscriptionCount(): number {
      return subscriptions.size;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const subscription of [...subscriptions.values()]) {
        endSubscription(subscription, "stopped", undefined, { notify: true });
      }
      latestFrames.clear();
      sessionLanes.clear();
      try {
        eventUnsubscribe();
      } catch {
        // The source is going away with us.
      }
    },
  };
}

export type AppControlSyncStream = ReturnType<typeof createAppControlSyncStream>;

/**
 * Reads App Control events from the runtime event buffer. The service's
 * `onEvent` callback has one slot, which the runtime uses to push
 * `{ type: "app_control_event", event }` into its buffer; subscribing to that
 * buffer is how a second consumer hears the same events without changing the
 * service.
 */
export function appControlEventsFromRuntimeBuffer(buffer: {
  subscribe(listener: (event: { category: string; payload: Record<string, unknown> }) => void): () => void;
}): AppControlSyncSource["subscribeEvents"] {
  return (listener) => buffer.subscribe((entry) => {
    if (entry.category !== "runtime") return;
    const payload = entry.payload;
    if (payload?.type !== "app_control_event") return;
    const event = payload.event as AppControlEventPayload | undefined;
    if (event && typeof event === "object" && typeof event.type === "string") listener(event);
  });
}
