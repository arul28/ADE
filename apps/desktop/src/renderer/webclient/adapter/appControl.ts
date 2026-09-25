/**
 * The App Control namespace for the hosted web client: watch only.
 *
 * App Control drives a local app over a CDP socket on the host, so a browser
 * tab cannot drive it. What it can do is watch: `appControl.status` says what
 * the lane has attached, and `appControl.streamSubscribe` pushes the lane's
 * throttled JPEG screencast frames as `appControl.streamFrame` envelopes.
 *
 * The desktop's App Control panel reads `getStatus` and listens on `onEvent`
 * for `frame` and session events. This namespace gives it the same shapes:
 * - `getStatus` answers from `appControl.status`;
 * - while `onEvent` has a listener, it polls status every few seconds so
 *   listeners hear session changes (the host has no session push for sync
 *   clients);
 * - while a view also holds `holdFrames`, it holds one frame subscription on
 *   the lane the last status named. Status-only listeners (the Work page's
 *   tool feed, recording cards) never keep frames flowing over the relay;
 * - the newest frame per lane stays cached after the subscription ends, so a
 *   view that mounts again paints it at once through `getLatestFrame`;
 * - the reads the panel makes while a session is connected answer empty, and
 *   every call that would drive the app rejects with a clear message.
 *
 * `streamSubscribe` / `streamUnsubscribe` / `onStreamFrame` / `onStreamEnded`
 * / `supportsLiveStream` are web-only members for a view that manages its own
 * subscription.
 */

import type {
  AppControlEventPayload,
  AppControlScreencastFrame,
  AppControlSession,
  AppControlStatus,
  AppControlTraceResult,
} from "../../../shared/types/appControl";
import type {
  SyncAppControlSession,
  SyncAppControlStatus,
  SyncAppControlStreamEndedPayload,
  SyncAppControlStreamFramePayload,
  SyncAppControlStreamSubscribeResult,
} from "../../../shared/types/sync";
import type { AdapterInfra } from "./types";

/** How often status is re-read while the panel listens for events. */
const STATUS_POLL_MS = 3_000;
/** Wait before re-subscribing after the host ended a subscription. */
const RESUBSCRIBE_DELAY_MS = 1_500;

const WATCH_ONLY_MESSAGE = "App Control runs on the desktop. From here you can only watch it.";

export type AppControlStreamSubscribeArgs = {
  laneId: string;
  subscriptionId: string;
  viewerLabel?: string | null;
  maxFps?: number | null;
};

export type AppControlWebApi = {
  getStatus: (argsOrPin?: unknown) => Promise<AppControlStatus>;
  onEvent: (listener: (event: AppControlEventPayload) => void, pin?: unknown) => () => void;
  holdFrames: () => () => void;
  supportsLiveStream: () => boolean;
  streamSubscribe: (args: AppControlStreamSubscribeArgs) => Promise<SyncAppControlStreamSubscribeResult | null>;
  streamUnsubscribe: (args: { subscriptionId: string }) => Promise<unknown>;
  onStreamFrame: (listener: (frame: SyncAppControlStreamFramePayload) => void) => () => void;
  onStreamEnded: (listener: (ended: SyncAppControlStreamEndedPayload) => void) => () => void;
  listTargets: () => Promise<[]>;
  getTrace: () => Promise<AppControlTraceResult>;
  listArtifacts: () => Promise<[]>;
  listDevices: () => Promise<[]>;
} & Record<string, unknown>;

function stringArg(value: unknown, key: "laneId" | "chatSessionId"): string | null {
  if (!value || typeof value !== "object") return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/** Fills the host-only fields a sync client never receives with nulls. */
function toAppControlSession(session: SyncAppControlSession | null | undefined): AppControlSession | null {
  if (!session) return null;
  return {
    id: session.id,
    appKind: session.appKind as AppControlSession["appKind"],
    label: session.label,
    projectRoot: null,
    laneId: session.laneId,
    cwd: null,
    command: null,
    pid: null,
    terminalSessionId: null,
    terminalPtyId: null,
    cdpPort: null,
    cdpEndpoint: null,
    cdpTargetId: session.cdpTargetId,
    provider: session.provider as AppControlSession["provider"],
    driver: session.driver as AppControlSession["driver"],
    chatSessionId: session.chatSessionId,
    startedAt: session.startedAt,
    connectedAt: session.connectedAt,
    status: session.status as AppControlSession["status"],
    lastError: session.lastError,
    lastObservationId: null,
    lastTraceEntryId: null,
  };
}

function toAppControlStatus(status: SyncAppControlStatus | null): AppControlStatus {
  return {
    platform: (status?.platform ?? "darwin") as AppControlStatus["platform"],
    supported: status?.supported ?? false,
    laneId: status?.laneId ?? null,
    activeSession: toAppControlSession(status?.session),
    sessions: (status?.sessions ?? []).map((session) => toAppControlSession(session)!).filter(Boolean),
    providers: [],
  } as AppControlStatus;
}

function sessionKey(session: AppControlSession | null): string {
  if (!session) return "";
  return [session.id, session.status, session.cdpTargetId ?? "", session.lastError ?? ""].join("\u0000");
}

function newSubscriptionId(): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `web-app-control-${random}`;
}

function rejectWatchOnly(): Promise<never> {
  return Promise.reject(new Error(WATCH_ONLY_MESSAGE));
}

export function createAppControlNamespace(infra: AdapterInfra): AppControlWebApi {
  const { client, commands } = infra;
  const listeners = new Set<(event: AppControlEventPayload) => void>();

  /** The lane the panel is looking at: the last lane a status read named. */
  let watchedLaneId: string | null = null;
  let lastSession: AppControlSession | null = null;
  let subscription: { id: string; laneId: string } | null = null;
  let subscribing = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let resubscribeTimer: ReturnType<typeof setTimeout> | null = null;
  let detachTransport: (() => void) | null = null;
  /** Mounted views that show frames. Only they keep the subscription. */
  let frameHolds = 0;
  /**
   * The newest frame the subscription delivered, kept after it ends. A view
   * that mounts again paints this at once through `getLatestFrame`, before the
   * new subscription's replay arrives. Cleared when the session changes.
   */
  let latestFrame: { laneId: string; frame: AppControlScreencastFrame } | null = null;

  const readStatus = async (
    laneId: string | null,
    chatSessionId: string | null = null,
  ): Promise<SyncAppControlStatus | null> =>
    await commands.call(
      "appControl.status",
      {
        ...(laneId ? { laneId } : {}),
        ...(!laneId && chatSessionId ? { chatSessionId } : {}),
      },
      { fallback: null as SyncAppControlStatus | null },
    );

  const emit = (event: AppControlEventPayload): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // One listener must not stop the others.
      }
    }
  };

  /** Tells listeners about a session change the poll found. */
  const noteStatus = (status: AppControlStatus): void => {
    const next = status.activeSession;
    const laneId = status.laneId ?? next?.laneId ?? watchedLaneId;
    if (sessionKey(next) === sessionKey(lastSession)) return;
    const previous = lastSession;
    lastSession = next;
    // The cached picture belongs to the app that was there before.
    if (latestFrame && latestFrame.frame.sessionId !== next?.id) latestFrame = null;
    if (listeners.size === 0) return;
    if (!next) {
      emit({ type: "session-stopped", laneId: laneId ?? null, previousSession: previous } as AppControlEventPayload);
      return;
    }
    emit({
      type: previous?.id === next.id ? "session-updated" : "session-started",
      laneId: laneId ?? null,
      session: next,
    } as AppControlEventPayload);
  };

  const dropSubscription = (): void => {
    const current = subscription;
    subscription = null;
    if (!current) return;
    void commands.call(
      "appControl.streamUnsubscribe",
      { subscriptionId: current.id },
      { fallback: null, idempotent: false },
    ).catch(() => {});
  };

  /** Frames reach views through `onEvent`, so a hold needs a listener too. */
  const wantsFrames = (): boolean => listeners.size > 0 && frameHolds > 0;

  /** Holds one subscription on the watched lane while a view shows frames. */
  const ensureSubscription = async (): Promise<void> => {
    const laneId = watchedLaneId;
    if (!wantsFrames() || !laneId || !client.supportsAppControlStream()) {
      dropSubscription();
      return;
    }
    // One subscribe at a time. The in-flight one re-checks when it settles.
    if (subscribing || subscription?.laneId === laneId) return;
    dropSubscription();
    const id = newSubscriptionId();
    subscribing = true;
    subscription = { id, laneId };
    let registered = false;
    try {
      const result = await commands.call(
        "appControl.streamSubscribe",
        { laneId, subscriptionId: id, viewerLabel: "Web viewer" },
        { fallback: null as SyncAppControlStreamSubscribeResult | null, idempotent: false },
      );
      registered = Boolean(result);
    } catch {
      registered = false;
    } finally {
      subscribing = false;
    }
    if (subscription?.id !== id) {
      // Dropped while in flight (the panel closed, the lane changed, the socket
      // dropped). The unsubscribe sent then reached the host before this
      // subscription existed there, so it was a no-op: release it now, or it
      // streams to nobody and counts against the per-lane cap.
      if (registered) {
        void commands.call(
          "appControl.streamUnsubscribe",
          { subscriptionId: id },
          { fallback: null, idempotent: false },
        ).catch(() => {});
      }
      // A listener that arrived meanwhile was turned away by `subscribing`.
      void ensureSubscription();
      return;
    }
    if (!registered) {
      subscription = null;
      return;
    }
    // The lane or the frame demand changed while the call was in flight.
    if (!wantsFrames() || watchedLaneId !== laneId) {
      dropSubscription();
      void ensureSubscription();
    }
  };

  const getLatestFrame = async (args?: unknown): Promise<AppControlScreencastFrame | null> => {
    const laneId = stringArg(args, "laneId") ?? watchedLaneId;
    if (!laneId) return null;
    if (latestFrame?.laneId === laneId) return latestFrame.frame;
    // Subscribed but no picture yet (a still app): a fresh subscription makes
    // the host replay its newest frame or capture one.
    if (subscription?.laneId === laneId && !subscribing) {
      dropSubscription();
      void ensureSubscription();
    }
    return null;
  };

  const getStatus = async (argsOrPin?: unknown): Promise<AppControlStatus> => {
    const requestedLane = stringArg(argsOrPin, "laneId");
    const requestedChat = stringArg(argsOrPin, "chatSessionId");
    const status = toAppControlStatus(
      await readStatus(requestedLane ?? (requestedChat ? null : watchedLaneId), requestedChat),
    );
    const laneId = requestedLane ?? status.laneId ?? status.activeSession?.laneId ?? null;
    if (laneId && laneId !== watchedLaneId) {
      watchedLaneId = laneId;
      void ensureSubscription();
    }
    noteStatus(status);
    return status;
  };

  const handleFrame = (frame: SyncAppControlStreamFramePayload): void => {
    if (!subscription || frame.subscriptionId !== subscription.id || listeners.size === 0) return;
    const { subscriptionId: _subscriptionId, seq: _seq, laneId, ...screencastFrame } = frame;
    const next = { ...screencastFrame, laneId } as AppControlScreencastFrame;
    latestFrame = { laneId, frame: next };
    emit({ type: "frame", laneId, frame: next } as AppControlEventPayload);
  };

  const handleEnded = (ended: SyncAppControlStreamEndedPayload): void => {
    if (!subscription || ended.subscriptionId !== subscription.id) return;
    subscription = null;
    latestFrame = null;
    if (ended.reason === "unsubscribed" || !wantsFrames()) return;
    if (resubscribeTimer != null) return;
    resubscribeTimer = setTimeout(() => {
      resubscribeTimer = null;
      void ensureSubscription();
    }, RESUBSCRIBE_DELAY_MS);
  };

  const startWatching = (): void => {
    if (pollTimer == null) {
      pollTimer = setInterval(() => {
        void getStatus(watchedLaneId ? { laneId: watchedLaneId } : undefined).catch(() => {});
      }, STATUS_POLL_MS);
    }
    if (!detachTransport) {
      const detachStatus = client.subscribe((status) => {
        const ready = status.state === "connected" && status.readiness === "ready";
        // The host released every subscription of the old socket.
        if (!ready) {
          subscription = null;
          latestFrame = null;
        } else void ensureSubscription();
      });
      const detachFrames = client.onAppControlStreamFrame(handleFrame);
      const detachEnded = client.onAppControlStreamEnded(handleEnded);
      detachTransport = () => {
        detachStatus();
        detachFrames();
        detachEnded();
      };
    }
    void ensureSubscription();
  };

  const stopWatching = (): void => {
    if (pollTimer != null) clearInterval(pollTimer);
    pollTimer = null;
    if (resubscribeTimer != null) clearTimeout(resubscribeTimer);
    resubscribeTimer = null;
    detachTransport?.();
    detachTransport = null;
    dropSubscription();
  };

  infra.addDispose(() => {
    listeners.clear();
    stopWatching();
  });

  return {
    // The literal action strings are scanned by
    // `adapter/__tests__/hostCommandContract.test.ts`; keep them inline.
    getStatus,
    onEvent: (listener) => {
      listeners.add(listener);
      startWatching();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stopWatching();
      };
    },
    holdFrames: () => {
      frameHolds += 1;
      void ensureSubscription();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        frameHolds -= 1;
        void ensureSubscription();
      };
    },
    supportsLiveStream: () => client.supportsAppControlStream(),
    streamSubscribe: (args) =>
      commands.call(
        "appControl.streamSubscribe",
        {
          laneId: args.laneId,
          subscriptionId: args.subscriptionId,
          ...(args.viewerLabel ? { viewerLabel: args.viewerLabel } : {}),
          ...(typeof args.maxFps === "number" ? { maxFps: args.maxFps } : {}),
        },
        { fallback: null as SyncAppControlStreamSubscribeResult | null, idempotent: false },
      ),
    streamUnsubscribe: (args) =>
      commands.call(
        "appControl.streamUnsubscribe",
        { subscriptionId: args.subscriptionId },
        { fallback: null, idempotent: false },
      ),
    onStreamFrame: (listener) => client.onAppControlStreamFrame(listener),
    onStreamEnded: (listener) => client.onAppControlStreamEnded(listener),
    // Reads the desktop panel makes while a session is connected. The web
    // client has no CDP socket, so they answer empty instead of null.
    listTargets: async () => [],
    getTrace: async () => ({ sessionId: lastSession?.id ?? null, entries: [] }),
    // A new subscription gets the host's replay; a panel that mounts under a
    // subscription that is already live gets the newest frame it delivered.
    getLatestFrame,
    listArtifacts: async () => [],
    listDevices: async () => [],
    // Everything below needs the app's CDP socket on the host.
    getSnapshot: rejectWatchOnly,
    listDrivers: rejectWatchOnly,
    observe: rejectWatchOnly,
    screenshot: rejectWatchOnly,
    inspectPoint: rejectWatchOnly,
    selectPoint: rejectWatchOnly,
    launch: rejectWatchOnly,
    launchInTerminal: rejectWatchOnly,
    connect: rejectWatchOnly,
    stop: rejectWatchOnly,
    focusWindow: rejectWatchOnly,
    minimizeWindow: rejectWatchOnly,
    click: rejectWatchOnly,
    typeText: rejectWatchOnly,
    scroll: rejectWatchOnly,
    dispatchKey: rejectWatchOnly,
    attachToTarget: rejectWatchOnly,
    windows: rejectWatchOnly,
    switchWindow: rejectWatchOnly,
  };
}
