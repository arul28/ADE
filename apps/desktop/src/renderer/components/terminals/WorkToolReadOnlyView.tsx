import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  WORK_TOOLS_CONTROL_HINT,
  WORK_TOOLS_MAC_DESKTOP_CONTROL_HINT,
  WORK_TOOLS_NO_DESKTOP_MESSAGE,
  workToolsUnavailableMessage,
  type WorkToolsLaneState,
  type WorkToolsMacDesktopState,
  type WorkToolsObservation,
} from "../../../shared/types/workTools";
import { H264VideoCanvas, isWebCodecsAvailable, type H264VideoRecordSource, type H264VideoStatus } from "../chat/H264VideoCanvas";
import { createH264FrameGate } from "../chat/h264FrameGate";
import {
  MAC_DESKTOP_TAKEOVER_CURSOR_HIDDEN_CLASS,
  MacDesktopTakeoverCursor,
} from "../chat/MacDesktopTakeoverCursor";
import { createMacDesktopLeaseHeartbeat } from "../chat/macDesktopLease";
import { viewPointToDisplayPoint, type ViewRect } from "../chat/macDesktopGeometry";
import {
  useMacDesktopRealInput,
  type MacDesktopInputCall,
  type MacDesktopPoint,
} from "../chat/useMacDesktopRealInput";
import { cn } from "../ui/cn";
import type { MacDesktopWebApi } from "../../webclient/adapter/macDesktop";

/**
 * The browser and App Control panes, as seen from a surface that cannot run
 * them.
 *
 * The hosted web client renders the same `WorkSidebar` as the desktop, but its
 * `builtInBrowser` / `appControl` namespaces are stubs — there is no
 * `WebContentsView` in a browser tab and no CDP socket to a local app. The old
 * answer was "Desktop app only", which is true and useless: the thing the user
 * wanted to know is what their desktop is *doing*. This shows exactly that and
 * offers no controls, so nothing here can lie about being interactive.
 *
 * Mac Desktop is the one read-only tool with a live picture: when the host
 * advertises `macDesktopStream` the pane subscribes over the sync socket and
 * decodes the same H.264 the desktop panel plays. When it also advertises
 * `macDesktopControl` the browser can take the lane's input lease and drive the
 * pointer through the same forwarded-input hook the desktop panel uses; the
 * control hint follows the capability rather than claiming control is always
 * elsewhere.
 */

/**
 * Poll interval. There is no generic runtime-event channel to a browser tab —
 * the web client's only push is cr-sqlite changesets, and none of this state is
 * table-backed — so a visible pane polls. Four seconds is slow enough to be
 * free and fast enough that a tab switch on the desktop reads as live.
 */
export const WORK_TOOL_READ_ONLY_POLL_MS = 4_000;

/**
 * The poll while the live picture is playing. Pushes carry the picture, so the
 * poll only refreshes the metadata around it (windows, lease, error) — and a
 * four-second cadence there is a state read and a render the viewer does not
 * need.
 */
export const WORK_TOOL_READ_ONLY_LIVE_POLL_MS = 15_000;

export type WorkToolReadOnlyViewProps = {
  tool: "browser" | "app-control" | "mac-desktop";
  laneId: string | null;
};

type PreviewState = {
  path: string;
  dataUrl: string | null;
};

export function WorkToolReadOnlyView({ tool, laneId }: WorkToolReadOnlyViewProps): JSX.Element {
  const [state, setState] = useState<WorkToolsLaneState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  /**
   * Whether the Mac Desktop canvas has drawn a live frame. While it has, the
   * still fetch is pointless and the state poll can be slow; the panel is the
   * only thing that knows, so it reports the status up.
   */
  const [livePlaying, setLivePlaying] = useState(false);
  // Guards against a slow refresh landing after the pane moved to another lane.
  const requestedLaneId = useRef(laneId);
  requestedLaneId.current = laneId;

  const refresh = useCallback(async (): Promise<void> => {
    if (!laneId) {
      setState(null);
      setLoaded(true);
      return;
    }
    const read = window.ade?.workTools?.getLaneState;
    if (!read) {
      setLoaded(true);
      return;
    }
    try {
      const next = await read(laneId);
      if (requestedLaneId.current !== laneId) return;
      setState(next);
    } catch {
      if (requestedLaneId.current !== laneId) return;
      setState(null);
    } finally {
      if (requestedLaneId.current === laneId) setLoaded(true);
    }
  }, [laneId]);

  useEffect(() => {
    setLoaded(false);
    setState(null);
    setPreview(null);
    setLivePlaying(false);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const intervalMs = livePlaying ? WORK_TOOL_READ_ONLY_LIVE_POLL_MS : WORK_TOOL_READ_ONLY_POLL_MS;
    const timer = window.setInterval(() => void refresh(), intervalMs);
    return () => window.clearInterval(timer);
  }, [refresh, livePlaying]);

  const observation = readOnlyObservation(tool, state);
  const observationPath = observation?.path ?? null;
  // The Mac Desktop pane is the one tool whose watch-only sentence depends on
  // the host: when it advertises takeover, "Control from the desktop" would
  // contradict the button right above it. `supportsMacDesktopControl` is a
  // synchronous hello read, so this costs no state.
  const macDesktopControlAvailable = tool === "mac-desktop"
    && macDesktopWebApi()?.supportsMacDesktopControl?.() === true;

  useEffect(() => {
    if (!observationPath) {
      setPreview(null);
      return;
    }
    // The live picture replaces the still, so a still fetched while it plays is
    // a megabyte of bytes for a frame nobody sees. When playback stops, this
    // effect re-runs and fetches the current frame again.
    if (livePlaying) return;
    // Frames are fetched by path, one at a time, never pushed: a state poll
    // that carried image bytes would multiply every refresh by a megabyte.
    let cancelled = false;
    setPreview((current) => (current?.path === observationPath ? current : { path: observationPath, dataUrl: null }));
    void (async () => {
      const read = window.ade?.workTools?.readObservationPreview;
      if (!read) return;
      try {
        const result = await read(observationPath);
        if (cancelled) return;
        setPreview({ path: observationPath, dataUrl: result?.dataUrl ?? null });
      } catch {
        if (!cancelled) setPreview({ path: observationPath, dataUrl: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [observationPath, livePlaying]);

  if (!loaded) {
    return <ReadOnlyMessage message="Loading…" />;
  }
  if (!laneId) {
    return <ReadOnlyMessage message="Select a lane to see what its tools are doing." />;
  }
  if (!state) {
    return <ReadOnlyMessage message={WORK_TOOLS_NO_DESKTOP_MESSAGE} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto px-3 py-3">
      {tool === "browser" ? <BrowserSummary state={state} /> : null}
      {tool === "app-control" ? <AppControlSummary state={state} /> : null}
      {tool === "mac-desktop" ? (
        <MacDesktopPanel
          laneId={laneId}
          macDesktop={state.macDesktop}
          observation={observation}
          dataUrl={preview?.path === observationPath ? preview?.dataUrl ?? null : null}
          stateCapturedAt={state.capturedAt}
          onRefresh={() => void refresh()}
          onLivePlayingChange={setLivePlaying}
        />
      ) : (
        <ObservationFrame
          observation={observation}
          dataUrl={preview?.path === observationPath ? preview?.dataUrl ?? null : null}
        />
      )}
      <p className="text-[11px] text-muted-fg">
        {macDesktopControlAvailable ? WORK_TOOLS_MAC_DESKTOP_CONTROL_HINT : WORK_TOOLS_CONTROL_HINT}
      </p>
    </div>
  );
}

/**
 * The frame this pane shows. Mac Desktop's lives on its own slice rather than
 * on a `WorkToolsObservation`, because the desktop's observation carries an id
 * and an element tree the browser's never had; the shape is flattened to the
 * same three fields here so one `ObservationFrame` serves all three tools.
 */
function readOnlyObservation(
  tool: WorkToolReadOnlyViewProps["tool"],
  state: WorkToolsLaneState | null,
): WorkToolsObservation | null {
  if (tool === "browser") return state?.browser?.latestObservation ?? null;
  if (tool === "app-control") return state?.appControl?.latestObservation ?? null;
  const last = state?.macDesktop?.lastObservation ?? null;
  if (!last) return null;
  return { path: last.screenshotPath, capturedAt: last.capturedAt, caption: last.caption };
}

function ReadOnlyMessage({ message }: { message: string }): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-muted-fg">
      {message}
    </div>
  );
}

function BrowserSummary({ state }: { state: WorkToolsLaneState }): JSX.Element {
  const browser = state.browser;
  if (!browser) {
    // `browserUnavailable` says WHY, and only one of its four reasons is "open
    // ADE on your Mac". The wording is shared with the iOS sheet so the two
    // read-only clients cannot drift; an unknown reason falls back to the
    // common case rather than inventing a diagnosis.
    return <ReadOnlyMessage message={workToolsUnavailableMessage(state.browserUnavailable)} />;
  }
  if (!browser.tabs.length) {
    return (
      <p className="text-[12px] text-muted-fg">No browser tabs are open in this lane.</p>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {browser.tabs.map((tab) => (
        <li
          key={tab.id}
          className="rounded-md border border-border/60 px-2.5 py-2 text-[12px]"
        >
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium">{tab.title ?? "Untitled tab"}</span>
            {tab.active ? <Badge label="Active" /> : null}
            {tab.recording ? <Badge label="Recording" /> : null}
          </div>
          {tab.url ? (
            <div className="truncate text-[11px] text-muted-fg">{tab.url}</div>
          ) : null}
          {tab.ownerChatSessionId ? (
            <div className="truncate text-[11px] text-muted-fg">
              Claimed by chat {tab.ownerChatSessionId}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function AppControlSummary({ state }: { state: WorkToolsLaneState }): JSX.Element {
  const appControl = state.appControl;
  if (!appControl) {
    return <p className="text-[12px] text-muted-fg">App Control is not driving an app in this lane.</p>;
  }
  return (
    <div className="rounded-md border border-border/60 px-2.5 py-2 text-[12px]">
      <div className="truncate font-medium">{appControl.appName}</div>
      <div className="text-[11px] text-muted-fg">
        {appControl.status} · {appControl.driver}
      </div>
    </div>
  );
}

/** The web namespace is optional on every surface; read it defensively. */
function macDesktopWebApi(): Partial<MacDesktopWebApi> | null {
  // Through `unknown` on purpose: on the desktop this slot is the Electron IPC
  // namespace, whose `renewLease` takes a `holderId` where the web one takes a
  // token. This component only mounts on the web client (see
  // `isReadOnlyWorkTool`), but the type of `window.ade` is the desktop surface.
  const api = window.ade?.macDesktop as unknown as Partial<MacDesktopWebApi> | undefined;
  return api ?? null;
}

function randomSubscriptionId(laneId: string): string {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `macdesk-${laneId}-${suffix}`;
}

function decodeBase64Bytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * A push-fed record source over the web `macDesktop` namespace. One
 * subscription per source instance; abandoning the source unsubscribes.
 *
 * P-frames after a sequence gap are withheld: the host skips frames under
 * backpressure and always resumes at a keyframe, so decoding a P-frame whose
 * reference was skipped paints corruption that outlives the drop.
 */
export function createMacDesktopStreamSource(args: {
  api: Partial<MacDesktopWebApi>;
  laneId: string;
  subscriptionId: string;
  viewerLabel: string;
}): H264VideoRecordSource {
  const { api, laneId, subscriptionId, viewerLabel } = args;
  return {
    subscribe(handlers) {
      let closed = false;
      const gate = createH264FrameGate();
      const offRecord = api.onStreamRecord?.((record) => {
        if (closed || record.subscriptionId !== subscriptionId) return;
        if (record.kind === "config") {
          // A config rebuilds the decoder, so the picture restarts at a
          // keyframe even though no sequence number was skipped.
          gate.reset();
          try {
            const config = JSON.parse(new TextDecoder().decode(decodeBase64Bytes(record.data))) as {
              codec?: unknown;
              width?: unknown;
              height?: unknown;
              annexB?: unknown;
            };
            if (typeof config.codec !== "string" || !config.codec) {
              handlers.onError("The video stream sent no codec.");
              return;
            }
            handlers.onRecord({
              kind: "config",
              codec: config.codec,
              width: typeof config.width === "number" ? config.width : null,
              height: typeof config.height === "number" ? config.height : null,
              annexB: config.annexB !== false,
            });
          } catch {
            handlers.onError("The video stream sent an unreadable configuration.");
          }
          return;
        }
        if (!gate.shouldDeliver(record.keyframe, record.seq)) return;
        handlers.onRecord({
          kind: "access-unit",
          keyframe: record.keyframe,
          seq: record.seq,
          bytes: decodeBase64Bytes(record.data),
        });
      }) ?? (() => {});
      const offEnded = api.onStreamEnded?.((ended) => {
        if (closed || ended.subscriptionId !== subscriptionId) return;
        if (ended.reason === "error") {
          handlers.onError(ended.message ?? "The desktop stream failed.");
        } else {
          handlers.onEnd();
        }
      }) ?? (() => {});
      void Promise.resolve(api.streamSubscribe?.({ laneId, subscriptionId, viewerLabel }))
        .then((result) => {
          if (closed || !api.streamSubscribe) return;
          if (!result) handlers.onError("The live desktop view is not available on this host.");
        })
        .catch((error: unknown) => {
          if (closed) return;
          handlers.onError(error instanceof Error ? error.message : String(error));
        });
      return () => {
        closed = true;
        offRecord();
        offEnded();
        void Promise.resolve(api.streamUnsubscribe?.({ subscriptionId })).catch(() => {
          // A dead socket already released the subscription host-side.
        });
      };
    },
  };
}

/**
 * The lane's private macOS screen in the hosted web client: the live picture
 * when the host and this browser can play it, the last still frame otherwise,
 * and — when the host advertises `macDesktopControl` — takeover.
 *
 * Takeover is the desktop panel's interaction transplanted rather than
 * re-invented: the gesture translation, the move coalescing, the keyboard
 * rules and the local cursor glyph all come from `useMacDesktopRealInput` /
 * `MacDesktopTakeoverCursor`, and the coordinate mapping is the shared
 * `macDesktopGeometry`. What is web-specific is only who carries the calls (a
 * sync action instead of IPC) and what ends control: a heartbeat renewal that
 * comes back null, a hidden tab, a closed socket, a stream that stopped, or
 * another controller taking the lease.
 */
function randomControlToken(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function MacDesktopPanel({
  laneId,
  macDesktop,
  observation,
  dataUrl,
  stateCapturedAt,
  onRefresh,
  onLivePlayingChange,
}: {
  laneId: string;
  macDesktop: WorkToolsMacDesktopState | null;
  observation: WorkToolsObservation | null;
  dataUrl: string | null;
  /** The lane-state read's own clock, for the stale-poll guard below. */
  stateCapturedAt: string | null;
  onRefresh: () => void;
  /** True from the first drawn frame until the canvas stops. */
  onLivePlayingChange?: (playing: boolean) => void;
}): JSX.Element {
  const api = macDesktopWebApi();
  // The host half and the browser half are separate answers: a host that
  // advertises the contract but a browser without WebCodecs gets the still
  // frame plus one honest line, not a dead pane.
  const hostSupportsLive = Boolean(
    api?.streamSubscribe
    && api.onStreamRecord
    && api.supportsLiveStream?.() === true,
  );
  const browserSupportsLive = isWebCodecsAvailable();
  const liveSupported = hostSupportsLive && browserSupportsLive;
  // Takeover is its own pair of answers, independent of the stream: a browser
  // without WebCodecs can still click a still frame, and a host that cannot
  // stream can still accept real input.
  const controlSupported = Boolean(
    api?.takeControl
    && api.returnControl
    && api.renewLease
    && api.input
    && api.supportsMacDesktopControl?.() === true,
  );
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  const [connected, setConnected] = useState(true);
  const [retryNonce, setRetryNonce] = useState(0);
  const [streamStatus, setStreamStatus] = useState<H264VideoStatus>("connecting");
  const [streamError, setStreamError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** The derived holder id this tab last took, or null when not controlling. */
  const [controlHolderId, setControlHolderId] = useState<string | null>(null);
  /** One line when control ended on its own; never an error. */
  const [controlNotice, setControlNotice] = useState<string | null>(null);
  const [controlBusy, setControlBusy] = useState(false);
  const [viewRect, setViewRect] = useState<ViewRect>({ left: 0, top: 0, width: 0, height: 0 });
  const [surfaceNode, setSurfaceNode] = useState<HTMLDivElement | null>(null);
  /**
   * The per-tab token the host turns into `web:<connectionId>:<token>`. A
   * fresh mount is a new identity, which is correct: after a socket drop the
   * derived holder id it could renew is gone anyway. Held in a ref rather than
   * a `useMemo` so the lane is part of the identity without pretending the
   * memo body reads it.
   */
  const controllerTokenRef = useRef<{ laneId: string; token: string } | null>(null);
  if (controllerTokenRef.current?.laneId !== laneId) {
    controllerTokenRef.current = { laneId, token: randomControlToken() };
  }
  const controllerToken = controllerTokenRef.current.token;
  /** Guards the lease reconciliation against a poll older than the takeover. */
  const holdingSinceRef = useRef(0);

  useEffect(() => {
    const onVisibilityChange = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  // A tool switch or a lane change unmounts the panel; the parent's longer
  // poll and skipped still fetch must not outlive the live picture that
  // justified them.
  useEffect(() => () => onLivePlayingChange?.(false), [onLivePlayingChange]);

  useEffect(() => {
    if (!liveSupported || !api?.onConnectionChange) return undefined;
    return api.onConnectionChange((next) => setConnected(next));
  }, [liveSupported, api]);

  const streamKey = `${pageVisible ? "shown" : "hidden"}:${connected ? "on" : "off"}:${retryNonce}`;
  const subscriptionId = useMemo(
    () => randomSubscriptionId(laneId),
    // A reconnect or a manual retry is a new subscription; the old one was
    // released by the server with the socket or by our own unsubscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [laneId, streamKey],
  );
  const source = useMemo(() => {
    if (!liveSupported || !api || !pageVisible || !connected) return null;
    return createMacDesktopStreamSource({
      api,
      laneId,
      subscriptionId,
      viewerLabel: "ADE Web",
    });
  }, [liveSupported, api, laneId, subscriptionId, pageVisible, connected]);

  const display = macDesktop?.display ?? null;
  const lease = macDesktop?.lease ?? null;

  /* ── Geometry ────────────────────────────────────────────────────────── */

  /**
   * The picture's own rectangle, the same measurement the desktop panel takes.
   * Overlays and pointer mapping are positioned from it, and the observer is
   * re-pointed when the pane mounts a different surface.
   */
  useEffect(() => {
    const node = surfaceNode;
    if (!node) return undefined;
    const measure = (): void => {
      const rect = node.getBoundingClientRect();
      setViewRect((current) =>
        current.left === rect.left && current.top === rect.top
          && current.width === rect.width && current.height === rect.height
          ? current
          : { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener("scroll", measure, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", measure, true);
    };
  }, [display?.displayId, surfaceNode]);

  const toDisplayPoint = useCallback((clientX: number, clientY: number): MacDesktopPoint | null => {
    if (!display) return null;
    // The shared letterbox arithmetic, not a second copy: a click landing off
    // the picture by the size of a black band is invisible in a screenshot.
    return viewPointToDisplayPoint({ clientX, clientY, rect: viewRect, display });
  }, [display, viewRect]);

  /* ── Real input, only while this tab holds the lease ──────────────────── */

  const sendInputCall = useCallback((call: MacDesktopInputCall) => {
    if (!api?.input) {
      return Promise.reject(new Error("The host does not accept input from this client."));
    }
    // A remote controller does not lock its pointer, so it never asks the
    // driver to hold the lane's cursor and has nothing to put back. The call
    // exists for the desktop takeover; here it is a no-op rather than a wire
    // message the host would have to understand.
    if (call.kind === "releaseCursor") return Promise.resolve(null);
    return api.input({ laneId, call });
  }, [api, laneId]);

  const realInput = useMacDesktopRealInput({
    laneId,
    sessionId: null,
    controllerId: controllerToken,
    enabled: controlHolderId != null,
    toDisplayPoint,
    runtimePin: null,
    sender: controlSupported ? sendInputCall : null,
    // The desktop deliberately does not post hover moves (the warp floods
    // ScreenCaptureKit and its local glyph is the pointer instead); a remote
    // controller needs the lane's pointer to track, so the same pump is opted
    // in here — one call per frame, latest position only.
    forwardPointerMoves: controlSupported,
    // This tab's screen coordinates are not the host's. The sync host drops
    // `home` either way; omitting it here means a stalled socket never carries
    // a point that would warp the Mac's cursor to a screen it does not have.
    reportCursorHome: false,
  });

  // A refused forwarded event lands in the pane's one error line, which clears
  // with the rest of the control state on hand-back.
  const clearRealInputError = realInput.clearInputError;
  useEffect(() => {
    if (realInput.inputError) setActionError(realInput.inputError);
  }, [realInput.inputError]);

  /* ── Takeover ────────────────────────────────────────────────────────── */

  const heartbeat = useMemo(
    () => createMacDesktopLeaseHeartbeat({
      renew: () => api?.renewLease
        ? api.renewLease({ laneId, controllerId: controllerToken })
        : Promise.resolve(null),
      onLost: () => {
        setControlHolderId(null);
        setControlNotice("Control ended.");
      },
    }),
    [api, controllerToken, laneId],
  );

  useEffect(() => {
    if (controlHolderId) heartbeat.start();
    else heartbeat.stop();
  }, [controlHolderId, heartbeat]);

  const endControl = useCallback((notice: string) => {
    heartbeat.stop();
    setControlHolderId(null);
    setControlNotice(notice);
  }, [heartbeat]);

  const returnControl = useCallback(async (): Promise<void> => {
    heartbeat.stop();
    setControlHolderId(null);
    // Input refusals belong to the stretch of control that just ended.
    setActionError(null);
    clearRealInputError();
    if (!api?.returnControl) return;
    try {
      await api.returnControl({ laneId, controllerId: controllerToken });
    } catch {
      // The lease is a deadline: a failed hand-back costs at most one TTL, and
      // surfacing it would be a notice about something already self-healing.
    }
  }, [api, clearRealInputError, controllerToken, heartbeat, laneId]);

  const takeControl = useCallback(async () => {
    if (!api?.takeControl) return;
    setControlBusy(true);
    setActionError(null);
    setControlNotice(null);
    try {
      const next = await api.takeControl({
        laneId,
        controllerId: controllerToken,
        controllerLabel: "ADE Web",
      });
      if (!next) throw new Error("The host did not grant control.");
      holdingSinceRef.current = Date.now();
      setControlHolderId(next.holderId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setControlBusy(false);
    }
  }, [api, controllerToken, laneId]);

  /**
   * A hidden tab or a leaving page hands control back.
   *
   * A hidden tab cannot forward the pointer events that make a takeover
   * useful, so keeping the lease would be holding the lane's input hostage
   * from a surface nobody is looking at. The same effect covers unmount,
   * which is what a tool switch or a lane change does.
   */
  const controlHolderIdRef = useRef<string | null>(null);
  controlHolderIdRef.current = controlHolderId;
  const returnControlRef = useRef(returnControl);
  returnControlRef.current = returnControl;
  const cancelInputRef = useRef(realInput.cancelInput);
  cancelInputRef.current = realInput.cancelInput;
  /**
   * Escape returns the lane, on this tab the same way it does in the desktop
   * pane. Capture phase on `window` so it runs before the surface's key
   * forwarder, which would otherwise type Escape into the app on the Mac.
   * The local half — forget the gesture, stop the pump, free pointer capture —
   * happens inside `cancelInput` and is not awaited: a wedged socket is the
   * usual reason the key was pressed.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (!controlHolderIdRef.current) return;
      cancelInputRef.current();
      void returnControlRef.current();
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
  useEffect(() => {
    const release = (): void => {
      void returnControlRef.current();
    };
    const onVisibility = (): void => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") release();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", release);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", release);
      if (controlHolderIdRef.current) release();
    };
  }, []);

  // A reconnect is a new socket, and the derived holder id died with the old
  // one. The host returns the lease on close; dropping the local state keeps
  // the affordance honest until the next hello.
  useEffect(() => {
    if (!controlHolderId || !api?.onConnectionChange) return undefined;
    return api.onConnectionChange((next) => {
      if (!next) void returnControl();
    });
  }, [api, controlHolderId, returnControl]);

  // The stream the person was driving ended (encoder stopped, display gone).
  // The lease is not control of a screen nobody can see.
  useEffect(() => {
    if (!controlHolderId || !api?.onStreamEnded) return undefined;
    return api.onStreamEnded((ended) => {
      if (ended.subscriptionId !== subscriptionId) return;
      void returnControl();
    });
  }, [api, controlHolderId, returnControl, subscriptionId]);

  // The lease changed hands under this tab — another window took it, or the
  // TTL lapsed and the agent re-armed. A poll captured at or before the
  // takeover is not evidence of either, so it is skipped by its `capturedAt`;
  // the heartbeat is the backstop when the next poll is four seconds away.
  useEffect(() => {
    if (!controlHolderId || !lease) return;
    if (lease.holder === "user" && lease.holderId === controlHolderId) return;
    const capturedAtMs = Date.parse(stateCapturedAt ?? "");
    if (Number.isFinite(capturedAtMs) && capturedAtMs <= holdingSinceRef.current) return;
    endControl("Control ended.");
  }, [controlHolderId, endControl, lease, stateCapturedAt]);

  if (!macDesktop || !macDesktop.supported) {
    return <ReadOnlyMessage message="This machine can't host a lane desktop." />;
  }
  // "Agent driving" vs "You have control" is the same sentence the desktop's
  // strip shows, so the two surfaces cannot describe one lease two ways. This
  // tab's own holder id decides the first case, so the line cannot lag behind
  // the takeover while the four-second poll catches up.
  const leaseLine = controlHolderId
    ? "You have control."
    : lease
      ? (lease.holder === "user"
        ? `Someone has control${lease.holderLabel ? ` · ${lease.holderLabel}` : ""}`
        : `Agent driving${lease.holderLabel ? ` · ${lease.holderLabel}` : ""}`)
      : "Nobody has taken control.";
  // The same answer as a badge beside the name, so who drives reads at a
  // glance. Only this tab's own takeover is "you"; a person holding it from
  // elsewhere is someone else as far as this tab can tell.
  const ownerBadge = controlHolderId
    ? "You have control"
    : lease
      ? (lease.holder === "user" ? "Someone has control" : "Agent driving")
      : null;
  // Optional on the wire: an older host sends no recording, which reads as none.
  const recording = macDesktop.recording?.running === true;

  const runAction = async (action: "start" | "stop") => {
    if (!api) return;
    setBusy(true);
    setActionError(null);
    try {
      if (action === "start") await api.start?.({ laneId });
      else await api.stop?.({ laneId });
      onRefresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  if (!display) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-[12px] text-muted-fg">This lane has no desktop running.</p>
        {api?.start ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void runAction("start")}
            className="self-start rounded-md border border-border/60 px-2.5 py-1.5 text-[12px] hover:bg-muted/40 disabled:opacity-50"
          >
            {busy ? "Starting…" : "Start desktop"}
          </button>
        ) : null}
        {actionError ? <p className="text-[11px] text-red-400">{actionError}</p> : null}
      </div>
    );
  }

  const stream = macDesktop.stream;
  const pictureVisible = source && pageVisible && connected;
  const stillFallbackReason = !liveSupported && hostSupportsLive
    ? "This browser can't play the live view, so this is the latest frame."
    : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-md border border-border/60 px-2.5 py-2 text-[12px]">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium">{display.name}</span>
          {stream?.running ? <Badge label={stream.idle ? "Idle" : "Live"} /> : null}
          {streamError && pictureVisible && streamStatus === "error"
            ? <Badge label="No signal" />
            : null}
          {recording ? <Badge label="Recording" tone="recording" testId="mac-desktop-web-recording" /> : null}
          {ownerBadge ? <Badge label={ownerBadge} testId="mac-desktop-web-owner" /> : null}
        </div>
        <div className="text-[11px] text-muted-fg">
          {display.width} × {display.height} · {display.mode}
        </div>
        <div className="text-[11px] text-muted-fg">{leaseLine}</div>
        <div className="mt-1.5 flex items-center gap-2">
          {/* The takeover control, left of everything else in the strip row:
              it is the one control that changes what the picture means. */}
          {controlSupported ? (
            controlHolderId ? (
              <span
                className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[12px] text-amber-200"
                data-testid="mac-desktop-web-takeover-banner"
              >
                You have control
                <button
                  type="button"
                  className="underline underline-offset-2"
                  onClick={() => void returnControl()}
                >
                  Return to agent
                </button>
                <span className="text-[10px] text-muted-fg">Esc</span>
              </span>
            ) : (
              <button
                type="button"
                disabled={controlBusy}
                onClick={() => void takeControl()}
                data-testid="mac-desktop-web-takeover"
                className="rounded-md border border-border/60 px-2 py-1 text-[11px] hover:bg-muted/40 disabled:opacity-50"
              >
                {controlBusy ? "Taking control…" : "Take control"}
              </button>
            )
          ) : null}
          {stream?.running ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAction("stop")}
              className="rounded-md border border-border/60 px-2 py-1 text-[11px] hover:bg-muted/40 disabled:opacity-50"
            >
              {busy ? "Stopping…" : "Stop"}
            </button>
          ) : null}
          {pictureVisible && streamStatus !== "playing" ? (
            <button
              type="button"
              onClick={() => setRetryNonce((value) => value + 1)}
              className="rounded-md border border-border/60 px-2 py-1 text-[11px] hover:bg-muted/40"
            >
              {streamStatus === "error" ? "Retry live view" : "Reconnect live view"}
            </button>
          ) : null}
        </div>
        {controlNotice ? (
          <p
            className="mt-1 text-[11px] text-amber-300"
            data-testid="mac-desktop-web-control-notice"
          >
            {controlNotice}
          </p>
        ) : null}
        {actionError ? (
          <p className="mt-1 flex items-center gap-1.5 text-[11px] text-red-400" data-testid="mac-desktop-web-error">
            <span className="min-w-0 truncate" title={actionError}>{actionError}</span>
            <button
              type="button"
              aria-label="Dismiss error"
              className="shrink-0 px-0.5 text-red-300/80 hover:text-red-200"
              onClick={() => {
                setActionError(null);
                clearRealInputError();
              }}
            >
              ×
            </button>
          </p>
        ) : null}
      </div>

      {/* The display's own aspect ratio, contained — never cropped. This is
          also the takeover surface: pointer capture keeps a click/drag on the
          picture through the host's cursor warp, and while this tab holds the
          lease the OS cursor is hidden and the local glyph is the pointer. */}
      <div
        ref={setSurfaceNode}
        role={controlHolderId ? "application" : undefined}
        tabIndex={controlHolderId ? 0 : -1}
        data-control={controlHolderId ? "user" : "agent"}
        data-testid="mac-desktop-web-surface"
        className={cn(
          "relative w-full overflow-hidden rounded-md border border-border/60 bg-muted/20",
          controlHolderId && MAC_DESKTOP_TAKEOVER_CURSOR_HIDDEN_CLASS,
        )}
        style={{ aspectRatio: `${display.width} / ${display.height}` }}
        onPointerDown={realInput.onPointerDown}
        onPointerUp={realInput.onPointerUp}
        onPointerLeave={realInput.onPointerLeave}
        onPointerMove={realInput.onPointerMove}
        onWheel={realInput.onWheel}
        onKeyDown={realInput.onKeyDown}
        onContextMenu={(event) => {
          if (controlHolderId) event.preventDefault();
        }}
      >
        {pictureVisible ? (
          <H264VideoCanvas
            source={source}
            className="absolute inset-0 h-full w-full"
            onStatus={(status, error) => {
              setStreamStatus(status);
              setStreamError(error);
              onLivePlayingChange?.(status === "playing");
            }}
          />
        ) : null}
        {!pictureVisible || streamStatus !== "playing" ? (
          dataUrl ? (
            <img
              src={dataUrl}
              alt={observation?.caption ?? "Latest captured frame"}
              className="absolute inset-0 h-full w-full object-contain"
            />
          ) : pictureVisible ? (
            <div className="absolute inset-0 flex items-center justify-center text-[11px] text-muted-fg">
              Waiting for the first frame…
            </div>
          ) : null
        ) : null}
        <MacDesktopTakeoverCursor
          feed={realInput.cursorFeed}
          rect={viewRect}
          display={display}
          active={controlHolderId != null}
        />
      </div>
      {stillFallbackReason ? <p className="text-[11px] text-muted-fg">{stillFallbackReason}</p> : null}
      <p className="text-[11px] text-muted-fg">
        {macDesktop.windows.length === 0
          ? "No windows are parked on this desktop."
          : macDesktop.windows.map((window) => window.appName).join(" · ")}
      </p>
    </div>
  );
}

function ObservationFrame({
  observation,
  dataUrl,
}: {
  observation: WorkToolsObservation | null;
  dataUrl: string | null;
}): JSX.Element | null {
  if (!observation) return null;
  return (
    <figure className="m-0 flex flex-col gap-1">
      {dataUrl ? (
        <img
          src={dataUrl}
          alt={observation.caption ?? "Latest captured frame"}
          className="w-full rounded-md border border-border/60"
        />
      ) : (
        <div className="flex h-24 items-center justify-center rounded-md border border-border/60 text-[11px] text-muted-fg">
          Loading frame…
        </div>
      )}
      <figcaption className="truncate text-[11px] text-muted-fg">
        {observation.caption ?? "Latest frame"}
      </figcaption>
    </figure>
  );
}

function Badge({
  label,
  tone = "muted",
  testId,
}: {
  label: string;
  /** `recording` is red with a pulsing dot, as recording reads everywhere else. */
  tone?: "muted" | "recording";
  testId?: string;
}): JSX.Element {
  return (
    <span
      data-testid={testId}
      className={
        tone === "recording"
          ? "inline-flex shrink-0 items-center gap-1 rounded-sm border border-red-400/50 px-1 text-[10px] uppercase tracking-wide text-red-300"
          : "shrink-0 rounded-sm border border-border/60 px-1 text-[10px] uppercase tracking-wide text-muted-fg"
      }
    >
      {tone === "recording" ? (
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 rounded-full bg-[var(--color-error)] [animation:ade-status-pulse_1.6s_steps(1)_infinite] motion-reduce:animate-none"
        />
      ) : null}
      {label}
    </span>
  );
}
