import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";
import { AnimatePresence, motion, useMotionValue, useReducedMotion } from "motion/react";
import { X } from "@phosphor-icons/react";
import type {
  AppControlEventPayload,
  BuiltInBrowserActionTraceEntry,
  BuiltInBrowserEventPayload,
  BuiltInBrowserStatus,
  IosSimulatorEventPayload,
  OpenProjectBinding,
} from "../../../shared/types";
import {
  selectActiveProjectStateKey,
  selectLaneWorkViewState,
  selectWorkViewState,
  useAppStore,
  type WorkSidebarTab,
} from "../../state/appStore";
import { EMPHASIZED_EASE, exitTransition } from "../../lib/motion";
import { cn } from "../ui/cn";
import { workToolDefinition } from "../terminals/workTools";
import type { NativeToolFeedScope } from "../terminals/useNativeToolSessions";
import {
  useNativeToolFeedHandlers,
  useNativeToolFeeds,
} from "../terminals/NativeToolFeedsContext";
import {
  acquireIosSimulatorPreviewStream,
  type IosSimulatorPreviewLease,
} from "./iosSimulatorPreviewStream";
import {
  WORK_LIVE_CARD_ASPECT,
  WORK_LIVE_CARD_WIDTH,
  clampWorkLiveCardRect,
  commitWorkLiveCardDismissal,
  commitWorkLiveScrubFrame,
  formatWorkLiveActionCaption,
  formatWorkLiveAge,
  normalizeWorkLiveCardDismissals,
  normalizeWorkLiveCardPosition,
  selectWorkLiveCardTool,
  updateWorkLiveScrubCaption,
  workLiveCardDragConstraints,
  workLiveCardFits,
  workLiveCardPositionFromRect,
  workLiveCardRect,
  workLivePreviewMaxWidth,
  workLiveScrubFrameKey,
  workLiveScrubIndex,
  workLiveSource,
  type WorkLiveActivity,
  type WorkLiveCardPosition,
  type WorkLiveScreenTool,
  type WorkLiveScrubFrame,
} from "./workLiveCard";

/**
 * The floating live-preview card.
 *
 * The Work tab has exactly one pane for a screen tool, so the moment an agent
 * starts driving a browser while you read its diff, the thing you most want to
 * see is the thing you just navigated away from. This is that: a 260px live
 * thumbnail of the most recently active screen tool that is NOT the one on
 * screen, parked in the corner of the chat column, one click away from taking
 * the pane back.
 *
 * Three things keep it from being a battery tax. It subscribes to feeds that
 * already exist (App Control's screencast, the browser's new refcounted preview
 * stream, the simulator's shared window capture) rather than opening its own;
 * it paints frames straight onto an `<img>`/`<video>` ref inside one rAF, so a
 * 12fps feed causes zero React renders; and it stops every feed the instant it
 * stops being shown.
 */

/** 16:10 media, plus a header, a caption row and the scrub strip. */
const MEDIA_HEIGHT = Math.round(WORK_LIVE_CARD_WIDTH / WORK_LIVE_CARD_ASPECT);
const HEADER_HEIGHT = 24;
const FOOTER_HEIGHT = 22;
const TIMELINE_HEIGHT = 2;
const CARD_HEIGHT = MEDIA_HEIGHT + HEADER_HEIGHT + FOOTER_HEIGHT + TIMELINE_HEIGHT;
/** How often a frame-rate feed is allowed to move the "most recent tool" clock. */
const ACTIVITY_COMMIT_MS = 500;
/** t3's mini-player entry, in ADE's emphasized curve. */
const ENTER = { duration: 0.2, ease: EMPHASIZED_EASE } as const;
const EXIT = exitTransition;
const PREVIEW_FPS = 12;
/**
 * A 1x1 transparent GIF. An `<img>` with no `src` draws the broken-image glyph
 * in Chromium, which is what the card would show for the second between mount
 * and the first frame — and permanently on the scrub overlay, which only ever
 * gets a `src` if you scrub.
 */
const BLANK_FRAME = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/**
 * What "the browser did something" means, as a string.
 *
 * Status events are bookkeeping as much as activity — closing the card stops
 * its preview stream, which itself emits one. Diffing the parts a human would
 * call activity is what makes the × stick: the dismissal is no longer undone
 * by the event the dismissal caused.
 */
function browserActivitySignature(status: BuiltInBrowserStatus | null): string {
  if (!status || !Array.isArray(status.tabs)) return "";
  const tab = status.tabs.find((entry) => entry.id === status.activeTabId) ?? status.tabs[0] ?? null;
  if (!tab) return `${status.tabs.length}`;
  return [
    status.activeTabId ?? "",
    status.tabs.length,
    tab.url ?? "",
    tab.title ?? "",
    tab.isLoading ? "1" : "0",
    tab.recording?.startedAt ?? "",
    tab.handoff?.startedAt ?? "",
  ].join("|");
}

export function WorkLiveCornerCard({
  active,
  laneId,
  activeTool,
  runtimePin,
  onPick,
}: {
  /** The Work route is on screen. Everything here is torn down when it is not. */
  active: boolean;
  laneId: string | null;
  /** The tool currently filling the tools pane, or null when it is closed/on the picker. */
  activeTool: WorkSidebarTab | null;
  runtimePin: OpenProjectBinding | null;
  onPick: (tool: WorkSidebarTab) => void;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  const projectStateKey = useAppStore(selectActiveProjectStateKey);
  const setWorkViewState = useAppStore((state) => state.setWorkViewState);
  const setLaneWorkViewState = useAppStore((state) => state.setLaneWorkViewState);
  // Through the store's own selectors rather than a hand-built `"<p>::<lane>"`
  // key: the key shape and the normalizers are the store's business, and
  // spelling them here is how the two copies drifted in the first place.
  const storedPosition = useAppStore(
    useMemo(() => {
      const select = selectWorkViewState(projectStateKey);
      return (state: Parameters<typeof select>[0]) => select(state).workLiveCardPosition ?? null;
    }, [projectStateKey]),
  );
  // Dismissals are LANE-scoped: silencing the browser preview while you read
  // one lane's diff must not silence it in the lane you switch to next.
  const storedDismissals = useAppStore(
    useMemo(() => {
      const select = selectLaneWorkViewState(projectStateKey, laneId);
      return (state: Parameters<typeof select>[0]) => select(state).workLiveCardDismissed ?? null;
    }, [laneId, projectStateKey]),
  );

  const runtimePinRef = useRef(runtimePin);
  runtimePinRef.current = runtimePin;

  const [lastTrace, setLastTrace] = useState<BuiltInBrowserActionTraceEntry | null>(null);
  const [appControlAction, setAppControlAction] = useState<{ caption: string; at: number } | null>(null);
  const [activityAt, setActivityAt] = useState<Record<WorkLiveScreenTool, number>>({
    browser: 0,
    "app-control": 0,
    ios: 0,
  });
  /** Only used when there is no project to persist into (a projectless Work surface). */
  const [localPosition, setLocalPosition] = useState<WorkLiveCardPosition | null>(null);
  const [localDismissals, setLocalDismissals] = useState<Record<string, number> | null>(null);
  // Held by trace ID, not by index: a new action shifts the whole buffer left,
  // and an index would then caption a different action than the picture the
  // pointer is still parked on.
  const [scrubFrameId, setScrubFrameId] = useState<string | null>(null);
  const [hovering, setHovering] = useState(false);
  const [hostSize, setHostSize] = useState({ width: 0, height: 0 });
  const [bottomReserve, setBottomReserve] = useState(0);
  const [scrubBuffer, setScrubBuffer] = useState<readonly WorkLiveScrubFrame[]>([]);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const hostRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const scrubImageRef = useRef<HTMLImageElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  /**
   * Callback refs, not object refs.
   *
   * `AnimatePresence` defaults to `mode="sync"`, so on a tool switch the
   * OUTGOING section is still mounted while the incoming one attaches its ref.
   * React then runs the outgoing node's detach — which with an object ref is an
   * unconditional `ref.current = null`, killing the live thumbnail that had
   * just been attached. Clearing only when the node leaving is the one being
   * held makes the ordering irrelevant.
   */
  const setImageRef = useCallback((node: HTMLImageElement | null) => {
    if (node) imageRef.current = node;
    else if (imageRef.current && !imageRef.current.isConnected) imageRef.current = null;
  }, []);
  const setScrubImageRef = useCallback((node: HTMLImageElement | null) => {
    if (node) scrubImageRef.current = node;
    else if (scrubImageRef.current && !scrubImageRef.current.isConnected) scrubImageRef.current = null;
  }, []);
  const setVideoRef = useCallback((node: HTMLVideoElement | null) => {
    if (node) videoRef.current = node;
    else if (videoRef.current && !videoRef.current.isConnected) videoRef.current = null;
  }, []);
  /** Latest frame not yet painted; drained by one rAF so 12fps costs one paint. */
  const pendingFrameRef = useRef<string | null>(null);
  const frameRafRef = useRef<number | null>(null);
  /** What is on screen right now, so a trace entry can snapshot it. */
  const liveFrameRef = useRef<string | null>(null);
  const draggingRef = useRef(false);
  /** A drag ends with a click event; that click must not also open the tool. */
  const suppressClickRef = useRef(false);
  const browserSignatureRef = useRef("");
  /**
   * The current dismissals, read from inside feed callbacks that outlive the
   * render which subscribed them.
   */
  const dismissalsRef = useRef<Record<string, number> | null>(null);
  const appControlTraceIdRef = useRef<string | null>(null);
  /**
   * Which tool the card is painting. Both the browser and App Control feeds are
   * subscribed at once (that is how "which tool is most recently active" is
   * known at all), so the paint path has to be gated or App Control's 30fps
   * screencast would draw over the browser thumbnail.
   */
  const paintToolRef = useRef<WorkLiveScreenTool | null>(null);
  const activityRef = useRef<Record<WorkLiveScreenTool, number>>({ browser: 0, "app-control": 0, ios: 0 });
  const activityCommitRef = useRef<number | null>(null);

  /**
   * Records that a tool did something.
   *
   * Coalesced through a ref because App Control's screencast is a frame feed:
   * committing it to React state per frame would re-render the whole card 30
   * times a second to move a clock nobody reads at that resolution.
   */
  const bump = useCallback((tool: WorkLiveScreenTool) => {
    activityRef.current = { ...activityRef.current, [tool]: Date.now() };
    if (activityCommitRef.current != null) return;
    activityCommitRef.current = window.setTimeout(() => {
      activityCommitRef.current = null;
      setActivityAt(activityRef.current);
    }, ACTIVITY_COMMIT_MS);
  }, []);

  useEffect(() => () => {
    if (activityCommitRef.current != null) window.clearTimeout(activityCommitRef.current);
    // Here rather than in the browser feed's teardown: an App Control-only card
    // paints frames too, and used to leave one scheduled rAF behind at unmount.
    if (frameRafRef.current != null) {
      window.cancelAnimationFrame(frameRafRef.current);
      frameRafRef.current = null;
    }
  }, []);

  const paintFrame = useCallback((tool: WorkLiveScreenTool, dataUrl: string) => {
    if (paintToolRef.current !== tool) return;
    liveFrameRef.current = dataUrl;
    pendingFrameRef.current = dataUrl;
    if (frameRafRef.current != null) return;
    frameRafRef.current = window.requestAnimationFrame(() => {
      frameRafRef.current = null;
      const next = pendingFrameRef.current;
      pendingFrameRef.current = null;
      if (next && imageRef.current) imageRef.current.src = next;
    });
  }, []);

  /* ── Feeds ─────────────────────────────────────────────────────────────── */

  const onBrowserStatusSettled = useCallback((status: BuiltInBrowserStatus | null) => {
    // For a DISMISSED browser, the state it was already in when this card
    // mounted is not activity: seeding the signature is what stops a dismissal
    // from lasting only until the next remount. When it is not dismissed the
    // seed is skipped, so the first status still brings the card up for a
    // browser that was already running.
    if (dismissalsRef.current?.browser) browserSignatureRef.current = browserActivitySignature(status);
  }, []);

  const onBrowserEvent = useCallback((event: BuiltInBrowserEventPayload) => {
    if (event.type === "status" || event.type === "open-request") {
      const signature = browserActivitySignature(event.status);
      // An "open-request" is somebody asking for the browser, so it always
      // counts; a plain status only counts when something actually changed.
      if (event.type === "open-request" || signature !== browserSignatureRef.current) {
        browserSignatureRef.current = signature;
        bump("browser");
      }
      return;
    }
    if (event.type === "trace") {
      setLastTrace(event.entry);
      bump("browser");
      // The buffer advances on ACTIONS, not frames: ten near-identical
      // pictures 80ms apart are not something anybody can scrub through.
      setScrubBuffer((current) => commitWorkLiveScrubFrame(current, {
        id: event.entry.id,
        dataUrl: liveFrameRef.current,
        caption: formatWorkLiveActionCaption(event.entry.action, event.entry.target),
        at: Date.parse(event.entry.endedAt) || Date.now(),
      }));
      return;
    }
    if (event.type === "preview-frame") {
      paintFrame("browser", event.dataUrl);
    }
  }, [bump, paintFrame]);

  const onAppControlEvent = useCallback((event: AppControlEventPayload, scope: NativeToolFeedScope) => {
    if (event.type === "session-started" || event.type === "session-updated") {
      const session = event.session ?? null;
      bump("app-control");
      // App Control has no `trace` event; it announces an action by moving
      // `lastTraceEntryId`. Snapshot the frame at THAT instant and let the
      // words catch up — the picture is the perishable half.
      const traceId = session?.lastTraceEntryId ?? null;
      if (traceId && traceId !== appControlTraceIdRef.current) {
        appControlTraceIdRef.current = traceId;
        const at = Date.now();
        setScrubBuffer((current) => commitWorkLiveScrubFrame(current, {
          id: traceId,
          dataUrl: liveFrameRef.current,
          caption: null,
          at,
        }));
        void window.ade?.appControl?.getTrace?.({ limit: 1 }, runtimePinRef.current)
          .then((result) => {
            const entry = result?.entries?.[result.entries.length - 1] ?? null;
            if (!scope.isActive() || !entry || entry.id !== traceId) return;
            const caption = formatWorkLiveActionCaption(entry.action, entry.target);
            setAppControlAction({ caption, at: Date.parse(entry.endedAt) || at });
            setScrubBuffer((current) => updateWorkLiveScrubCaption(current, traceId, caption));
          })
          .catch(() => {});
      }
      return;
    }
    if (event.type === "frame") {
      // Painted, but deliberately NOT counted as activity. The panel's
      // screencast runs at 30fps for the life of the session, independent of
      // this card: bumping on it made the × unusable (the next frame undid the
      // dismissal 33ms later) and let App Control win the most-recent-activity
      // tie-break forever. Real activity is a session event or a new trace id.
      paintFrame("app-control", `data:${event.frame.mimeType};base64,${event.frame.data}`);
    }
  }, [bump, paintFrame]);

  const onIosEvent = useCallback((event: IosSimulatorEventPayload) => {
    if (event.type === "session-started" || event.type === "session-updated") bump("ios");
  }, [bump]);

  // The page's one subscription set, shared with the Work tools pane: the
  // capability gate, the web-client boundary check, the offline guard and the
  // teardown all live in `NativeToolFeedsProvider`. The card contributes
  // handlers to its fan-out and opens nothing of its own — which is also how it
  // inherited the offline guard it used to be missing.
  const {
    browserStatus,
    iosSession,
    appControlSession,
    browserViewRoot,
    canBrowser,
    canIos,
    canAppControl,
  } = useNativeToolFeeds();
  useNativeToolFeedHandlers(useMemo(() => ({
    onBrowserStatusSettled,
    onBrowserEvent,
    onAppControlEvent,
    onIosEvent,
  }), [onAppControlEvent, onBrowserEvent, onBrowserStatusSettled, onIosEvent]));

  /* ── Which tool, and does it fit ───────────────────────────────────────── */

  const activeBrowserTab = useMemo(() => {
    if (!browserStatus) return null;
    return browserStatus.tabs.find((tab) => tab.id === browserStatus.activeTabId) ?? browserStatus.tabs[0] ?? null;
  }, [browserStatus]);

  // Every per-tool question the card asks — live, owner, caption, handoff,
  // recording — answered once, by the adapter map beside the tool list.
  const sourceState = useMemo(() => ({
    browserTab: activeBrowserTab,
    appControlSession,
    iosSession,
  }), [activeBrowserTab, appControlSession, iosSession]);

  const sources = useMemo(() => ({
    browser: workLiveSource("browser", sourceState),
    "app-control": workLiveSource("app-control", sourceState),
    ios: workLiveSource("ios", sourceState),
  }), [sourceState]);

  const activities = useMemo<WorkLiveActivity[]>(() => [
    { tool: "browser", lastActivityAt: activityAt.browser, available: canBrowser, live: sources.browser.live },
    {
      tool: "app-control",
      lastActivityAt: activityAt["app-control"],
      available: canAppControl,
      live: sources["app-control"].live,
    },
    { tool: "ios", lastActivityAt: activityAt.ios, available: canIos, live: sources.ios.live },
  ], [activityAt, canAppControl, canBrowser, canIos, sources]);

  const dismissals = useMemo(
    () => normalizeWorkLiveCardDismissals(projectStateKey && laneId ? storedDismissals : localDismissals),
    [laneId, localDismissals, projectStateKey, storedDismissals],
  );
  const tool = useMemo(
    () => selectWorkLiveCardTool({ activeTool, activities, dismissals }),
    [activeTool, activities, dismissals],
  );
  dismissalsRef.current = dismissals;

  const fits = workLiveCardFits(hostSize, bottomReserve);
  const visible = active && tool != null && fits;

  /* ── Host geometry ─────────────────────────────────────────────────────── */

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return undefined;
    // `clientWidth` is 0 for a host that has not been laid out yet; the
    // bounding rect is the honest fallback, and a host with neither cannot
    // place a card at all.
    const measure = () => {
      const rect = host.getBoundingClientRect();
      setHostSize({
        width: host.clientWidth || Math.round(rect.width),
        height: host.clientHeight || Math.round(rect.height),
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    measure();
    return () => observer.disconnect();
  }, []);

  // The card sits ABOVE the composer, so it has to know how tall the composer
  // is. Measured rather than assumed: the composer grows with chips, attached
  // context and a multi-line draft.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return undefined;
    const composer = host.parentElement?.querySelector<HTMLElement>("[data-chat-composer-wrapper]") ?? null;
    if (!composer) {
      setBottomReserve(0);
      return undefined;
    }
    const observer = new ResizeObserver(() => setBottomReserve(composer.offsetHeight));
    observer.observe(composer);
    setBottomReserve(composer.offsetHeight);
    return () => observer.disconnect();
  }, [visible]);

  const position = useMemo(
    () => (projectStateKey ? normalizeWorkLiveCardPosition(storedPosition) : localPosition),
    [localPosition, projectStateKey, storedPosition],
  );

  const rect = useMemo(() => workLiveCardRect({
    host: hostSize,
    position,
    cardHeight: CARD_HEIGHT,
    bottomReserve,
  }), [bottomReserve, hostSize, position]);

  const dragConstraints = useMemo(() => workLiveCardDragConstraints({
    host: hostSize,
    origin: rect,
    cardHeight: CARD_HEIGHT,
    bottomReserve,
  }), [bottomReserve, hostSize, rect]);

  const dragX = useMotionValue(0);
  const dragY = useMotionValue(0);

  const commitDrag = useCallback(() => {
    const offsetX = dragX.get();
    const offsetY = dragY.get();
    // Reset FIRST and unconditionally: the offset is spent whether or not it
    // can be persisted, and leaving it on the motion value is how the card used
    // to stay parked half outside the column it was dragged out of.
    dragX.set(0);
    dragY.set(0);
    if (hostSize.width <= 0) return;
    const clamped = clampWorkLiveCardRect({
      host: hostSize,
      left: rect.left + offsetX,
      top: rect.top + offsetY,
      cardHeight: CARD_HEIGHT,
      bottomReserve,
    });
    const next = workLiveCardPositionFromRect({
      host: hostSize,
      left: clamped.left,
      top: clamped.top,
      cardHeight: CARD_HEIGHT,
    });
    if (projectStateKey) setWorkViewState(projectStateKey, { workLiveCardPosition: next });
    else setLocalPosition(next);
  }, [bottomReserve, dragX, dragY, hostSize, projectStateKey, rect.left, rect.top, setWorkViewState]);

  /* ── Feed start/stop for the SELECTED tool ─────────────────────────────── */

  const previewTabId = tool === "browser" ? activeBrowserTab?.id ?? null : null;
  useEffect(() => {
    if (!visible || !previewTabId) return undefined;
    const browser = window.ade?.builtInBrowser;
    // Paired start/stop: the service refcounts, so a start we never stop leaves
    // a capture loop running for a card that has unmounted.
    if (!browser?.startPreviewStream || !browser.stopPreviewStream) return undefined;
    const { startPreviewStream, stopPreviewStream } = browser;
    const scope = browserViewRoot ? { projectRoot: browserViewRoot } : {};
    let started = true;
    void startPreviewStream({
      ...scope,
      tabId: previewTabId,
      fps: PREVIEW_FPS,
      maxWidth: workLivePreviewMaxWidth(window.devicePixelRatio),
    }).catch(() => {
      started = false;
    });
    return () => {
      if (!started) return;
      void stopPreviewStream({ ...scope, tabId: previewTabId }).catch(() => {});
    };
  }, [browserViewRoot, previewTabId, visible]);

  const iosDeviceUdid = tool === "ios" ? iosSession?.deviceUdid ?? null : null;
  const iosDeviceName = iosSession?.deviceName ?? null;
  useEffect(() => {
    if (!visible || !iosDeviceUdid) return undefined;
    let lease: IosSimulatorPreviewLease | null = null;
    let cancelled = false;
    // Captured here rather than read in the cleanup: by teardown time the ref
    // may already point at the next tool's element (or nothing), and detaching
    // a stream from the wrong node leaves this one playing into a black card.
    const video = videoRef.current;
    void acquireIosSimulatorPreviewStream({ udid: iosDeviceUdid, name: iosDeviceName })
      .then((next) => {
        if (!next) return;
        if (cancelled) {
          next.release();
          return;
        }
        lease = next;
        const target = videoRef.current ?? video;
        if (target) {
          target.srcObject = next.stream;
          void target.play().catch(() => {});
        }
      });
    return () => {
      cancelled = true;
      if (video) video.srcObject = null;
      lease?.release();
    };
  }, [iosDeviceName, iosDeviceUdid, visible]);

  // Switching source tools must not leave the previous tool's last frame on
  // screen under the new tool's name.
  useEffect(() => {
    paintToolRef.current = visible ? tool : null;
    liveFrameRef.current = null;
    pendingFrameRef.current = null;
    appControlTraceIdRef.current = null;
    setScrubBuffer([]);
    setScrubFrameId(null);
    if (imageRef.current) imageRef.current.src = BLANK_FRAME;
    if (scrubImageRef.current) scrubImageRef.current.src = BLANK_FRAME;
  }, [tool, visible]);

  // One low-frequency tick so "· 2s" ages while you look at it. Only while the
  // card is actually on screen.
  useEffect(() => {
    if (!visible) return undefined;
    const timer = window.setInterval(() => setNowTick(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [visible]);

  /* ── Scrubbing ─────────────────────────────────────────────────────────── */

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    // Scrubbing and dragging are the same gesture until you commit to one; a
    // drag must not also rewind the thumbnail under the cursor.
    if (draggingRef.current) return;
    setHovering(true);
    const bounds = event.currentTarget.getBoundingClientRect();
    const index = workLiveScrubIndex({
      frameCount: scrubBuffer.length,
      offsetX: event.clientX - bounds.left,
      width: bounds.width,
    });
    const frame = index == null ? null : scrubBuffer[index] ?? null;
    setScrubFrameId(frame ? workLiveScrubFrameKey(frame) : null);
    // Painted onto the overlay, never onto the live image: the live feed keeps
    // running underneath, which is what makes leaving a 120ms crossfade back to
    // now rather than a jump to a stale frame.
    if (frame?.dataUrl && scrubImageRef.current) scrubImageRef.current.src = frame.dataUrl;
  }, [scrubBuffer]);

  const handlePointerLeave = useCallback(() => {
    setScrubFrameId(null);
    setHovering(false);
  }, []);

  /* ── Copy ──────────────────────────────────────────────────────────────── */

  const definition = tool ? workToolDefinition(tool) : null;
  const source = tool ? sources[tool] : null;
  // Resolved by ID on every render: the ring buffer shifts left when a new
  // action lands, so the frame the pointer is parked on must be re-found rather
  // than re-indexed — otherwise the caption starts describing a different
  // action than the picture still on screen.
  const scrubbedFrame = useMemo(() => (
    scrubFrameId == null
      ? null
      : scrubBuffer.find((frame) => workLiveScrubFrameKey(frame) === scrubFrameId) ?? null
  ), [scrubBuffer, scrubFrameId]);
  const ownerLabel = source?.ownerLabel ?? null;

  const caption = useMemo(() => {
    if (scrubbedFrame) {
      return scrubbedFrame.caption
        ? `${scrubbedFrame.caption} · ${formatWorkLiveAge(nowTick - scrubbedFrame.at)}`
        : formatWorkLiveAge(nowTick - scrubbedFrame.at);
    }
    // The tool's own most recent ACTION outranks whatever it is showing: "click
    // 'Sign in' · 2s" is the news, the page title is the context.
    if (tool === "browser" && lastTrace) {
      const label = formatWorkLiveActionCaption(lastTrace.action, lastTrace.target);
      return `${label} · ${formatWorkLiveAge(nowTick - (Date.parse(lastTrace.endedAt) || nowTick))}`;
    }
    if (tool === "app-control" && appControlAction) {
      return `${appControlAction.caption} · ${formatWorkLiveAge(nowTick - appControlAction.at)}`;
    }
    return source?.caption ?? null;
  }, [appControlAction, lastTrace, nowTick, scrubbedFrame, source, tool]);

  const handoff = source?.handoff ?? null;
  const recording = source?.recording ?? null;

  const handleDismiss = useCallback(() => {
    if (!tool) return;
    // Stamped with `now`, not with the activity clock the card was showing:
    // the clock is committed on a 500ms coalesce, so a bump already in flight
    // would otherwise re-open the card the instant it closed.
    const stamp = Math.max(Date.now(), activityRef.current[tool] ?? 0);
    if (projectStateKey && laneId) {
      setLaneWorkViewState(projectStateKey, laneId, (prev) => ({
        ...prev,
        workLiveCardDismissed: commitWorkLiveCardDismissal(
          normalizeWorkLiveCardDismissals(prev.workLiveCardDismissed),
          tool,
          stamp,
        ),
      }));
      return;
    }
    setLocalDismissals((current) => commitWorkLiveCardDismissal(current, tool, stamp));
  }, [laneId, projectStateKey, setLaneWorkViewState, tool]);

  const activate = useCallback(() => {
    if (suppressClickRef.current || draggingRef.current || !tool) return;
    onPick(tool);
  }, [onPick, tool]);

  const handleCardClick = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    // The whole card is the affordance except the two things that mean
    // something else: the close button and the timeline you scrub along.
    if ((event.target as HTMLElement | null)?.closest?.("[data-live-card-inert]")) return;
    activate();
  }, [activate]);

  const Icon = definition?.icon ?? null;
  const hue = definition?.color ?? "var(--color-accent)";
  // The highlighted slot follows the frame the pointer holds, so an eviction
  // moves the highlight with the picture instead of leaving it behind.
  const scrubbedIndex = scrubbedFrame ? scrubBuffer.indexOf(scrubbedFrame) : -1;
  const timelineIndex = scrubbedIndex >= 0 ? scrubbedIndex : scrubBuffer.length - 1;
  const scrubbable = scrubBuffer.length > 1;

  return (
    <div
      ref={hostRef}
      aria-hidden={visible ? undefined : true}
      className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
    >
      <AnimatePresence initial={false}>
        {visible && tool && definition ? (
          <motion.section
            key={tool}
            aria-label={`${definition.label} live preview`}
            drag
            dragMomentum={false}
            dragElastic={0}
            dragConstraints={dragConstraints}
            style={{ x: dragX, y: dragY, left: rect.left, top: rect.top, width: WORK_LIVE_CARD_WIDTH }}
            onDragStart={() => {
              draggingRef.current = true;
              suppressClickRef.current = true;
              setScrubFrameId(null);
            }}
            onDragEnd={() => {
              draggingRef.current = false;
              commitDrag();
              // Released after the click this drag is about to produce.
              window.setTimeout(() => {
                suppressClickRef.current = false;
              }, 0);
            }}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
            exit={reduceMotion
              ? { opacity: 0, transition: { duration: 0 } }
              : { opacity: 0, scale: 0.97, transition: EXIT }}
            transition={reduceMotion ? { duration: 0 } : ENTER}
            data-work-live-card={tool}
            className={cn(
              "pointer-events-auto absolute cursor-pointer overflow-hidden rounded-[var(--radius-md)]",
              "border border-white/[0.08] bg-[var(--chat-glass-bg)] shadow-[var(--shadow-card)]",
              "backdrop-blur-[var(--blur-popup)] transition-shadow duration-[120ms] ease-out",
              "hover:shadow-[var(--shadow-card-hover)] active:cursor-grabbing",
            )}
            onPointerMove={handlePointerMove}
            onPointerLeave={handlePointerLeave}
            onClick={handleCardClick}
          >
            <header
              className="flex items-center gap-1.5 px-2"
              style={{ height: HEADER_HEIGHT }}
            >
              {Icon ? <Icon size={12} weight="duotone" style={{ color: definition.color }} /> : null}
              <span className="min-w-0 truncate text-[11px] font-medium text-fg">
                {definition.label}
                {ownerLabel ? <span className="text-muted-fg"> · {ownerLabel}</span> : null}
              </span>
              {recording ? (
                <motion.span
                  title="Recording"
                  animate={reduceMotion ? undefined : { opacity: [1, 1, 0.3, 0.3] }}
                  transition={reduceMotion
                    ? undefined
                    : { duration: 1.2, times: [0, 0.5, 0.5, 1], repeat: Infinity, ease: "linear" }}
                  className={cn(
                    "shrink-0 rounded-full bg-red-500/15 px-1.5 text-[9px] font-semibold uppercase",
                    "tracking-[0.6px] text-red-300",
                  )}
                >
                  REC
                </motion.span>
              ) : null}
              {handoff ? (
                <span
                  title={handoff.detail ?? undefined}
                  className={cn(
                    "shrink-0 truncate rounded-full bg-amber-400/15 px-1.5 text-[9px] font-medium",
                    "text-amber-200",
                  )}
                >
                  {handoff.label}
                </span>
              ) : null}
              <span className="flex-1" />
              <button
                type="button"
                data-live-card-inert=""
                onClick={(event) => {
                  event.stopPropagation();
                  handleDismiss();
                }}
                title="Hide until the next activity"
                aria-label={`Hide the ${definition.label} preview`}
                className={cn(
                  "-mr-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-fg/70",
                  "transition-colors duration-[120ms] hover:bg-white/[0.08] hover:text-fg",
                  "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
                )}
              >
                <X size={10} weight="bold" />
              </button>
            </header>

            <button
              type="button"
              data-live-card-inert=""
              onClick={activate}
              aria-label={`Open ${definition.label} in the tools pane`}
              className={cn(
                "relative block w-full cursor-pointer overflow-hidden border-0 p-0",
                "bg-[var(--pane-bg)]",
                "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
              )}
              style={{ height: MEDIA_HEIGHT }}
            >
              {/*
                `contain`, never `cover`: a 16:10 crop of a 3:2 page slices a
                button in half and calls it a preview. Letterboxed against the
                pane colour is the honest shape of the thing being previewed.
              */}
              {tool === "ios" ? (
                <video
                  ref={setVideoRef}
                  muted
                  playsInline
                  className="h-full w-full object-contain"
                />
              ) : (
                <img
                  ref={setImageRef}
                  alt=""
                  src={BLANK_FRAME}
                  className="h-full w-full object-contain"
                />
              )}
              <img
                ref={setScrubImageRef}
                alt=""
                aria-hidden="true"
                src={BLANK_FRAME}
                className={cn(
                  "pointer-events-none absolute inset-0 h-full w-full bg-[var(--pane-bg)] object-contain",
                  "transition-opacity duration-[120ms] ease-out",
                )}
                style={{ opacity: scrubbedFrame?.dataUrl ? 1 : 0 }}
              />
            </button>

            <footer
              className="flex items-center gap-1.5 px-2"
              style={{ height: FOOTER_HEIGHT }}
            >
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted-fg" title={caption ?? undefined}>
                {caption ?? " "}
              </span>
              {hovering && !scrubbable ? (
                <span className="shrink-0 text-[9.5px] font-medium tracking-[0.2px] text-muted-fg/70">
                  Live
                </span>
              ) : null}
            </footer>

            {/* The ten slots, oldest on the left. Hovering the card scrubs it. */}
            <div
              data-live-card-inert=""
              aria-hidden="true"
              className="flex w-full items-stretch gap-[1px] px-2"
              style={{ height: TIMELINE_HEIGHT }}
            >
              {scrubbable
                ? scrubBuffer.map((frame, index) => (
                  <span
                    key={`${frame.id ?? frame.at}-${index}`}
                    className="flex-1 rounded-full transition-colors duration-[120ms]"
                    style={{
                      background: index === timelineIndex ? hue : "rgba(255,255,255,0.14)",
                    }}
                  />
                ))
                : null}
            </div>
          </motion.section>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
