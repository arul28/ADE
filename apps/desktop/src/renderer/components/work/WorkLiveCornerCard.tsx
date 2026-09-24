import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";
import {
  AnimatePresence,
  motion,
  useDragControls,
  useMotionValue,
  useReducedMotion,
} from "motion/react";
import { X } from "@phosphor-icons/react";
import type {
  AppControlEventPayload,
  BuiltInBrowserActionTraceEntry,
  BuiltInBrowserEventPayload,
  BuiltInBrowserStatus,
  OpenProjectBinding,
} from "../../../shared/types";
import {
  selectActiveProjectStateKey,
  selectWorkViewState,
  useAppStore,
  type WorkSidebarTab,
} from "../../state/appStore";
import {
  WORK_LIVE_CARD_DEFAULT_WIDTH,
  WORK_LIVE_SCREEN_TOOLS,
  isWorkLiveCardSeen,
  isWorkLiveScreenTool,
  normalizeWorkLiveCardWidth,
  type WorkLiveCardClosedByTool,
  type WorkLiveCardSeenByTool,
  type WorkLiveScreenTool,
} from "../../state/workLiveCardState";
import { EMPHASIZED_EASE, exitTransition } from "../../lib/motion";
import { cn } from "../ui/cn";
import { workToolDefinition } from "../terminals/workTools";
import {
  closeWorkLiveCardForChat,
  markWorkLiveCardSeenForChat,
  unfloatWorkLiveCardForChat,
  useChatCompanionUiState,
} from "../chat/chatCompanionUiState";
import type { NativeToolFeedScope } from "../terminals/useNativeToolSessions";
import {
  useNativeToolFeedHandlers,
  useNativeToolFeeds,
} from "../terminals/NativeToolFeedsContext";
import {
  clampWorkLiveCardRect,
  commitWorkLiveScrubFrame,
  formatWorkLiveActionCaption,
  formatWorkLiveAge,
  selectWorkLiveCardTool,
  updateWorkLiveScrubCaption,
  workLiveBottomReserve,
  workLiveCardDragConstraints,
  workLiveCardFits,
  WORK_LIVE_CARD_OBJECT_FIT,
  workLiveCardPositionFromRect,
  workLiveCardRect,
  workLiveCardSize,
  workLivePreviewMaxWidth,
  workLiveCardWidthBounds,
  WORK_LIVE_CARD_AVOID_SELECTOR,
  workLiveScrubFrameKey,
  workLiveScrubIndex,
  workLiveSource,
  type WorkLiveActivity,
  type WorkLiveCardPosition,
  type WorkLiveScrubFrame,
} from "./workLiveCard";
import { MacDesktopMiniPlayer } from "./MacDesktopMiniPlayer";

/**
 * The floating live-preview card.
 *
 * The Work tab has exactly one pane for a screen tool, so the moment an agent
 * starts driving a browser while you read its diff, the thing you most want to
 * see is the thing you just navigated away from. This is that: a live thumbnail
 * of the most recently active screen tool that is NOT the one on screen, parked
 * in the corner of the chat column, one click away from taking the pane back.
 *
 * It follows the conversation you are reading: a session owned by another chat
 * is not shown here (`selectWorkLiveCardTool`). Its box follows the picture's
 * own aspect ratio, so nothing is cropped, and its "×" is keyed by session, so
 * frames and remounts can never bring a closed card back.
 *
 * Three things keep it from being a battery tax. It subscribes to feeds that
 * already exist (App Control's screencast, the browser's refcounted preview
 * stream) rather than opening its own; it
 * paints frames straight onto an `<img>` ref inside one rAF, so a 12fps feed
 * causes zero React renders; and it stops every feed the instant it stops
 * being shown.
 *
 * The Apple device is not one of its sources. A simulator floats in its own
 * player (`AppleDeviceMiniPlayer`), which the device rail OPENS — a device only
 * floats because somebody asked it to — so there is nothing for this card to
 * surface on its own.
 *
 * Nor is the Mac Desktop. It floats in the same kind of player as the device
 * (`MacDesktopMiniPlayer`, on the shared `FloatingPlayerShell`), which this
 * component mounts beside the card because it is the one the Work page
 * already renders over the chat column with everything the player needs.
 *
 * The chrome follows t3's mini-player: nothing but an 8px status dot at rest,
 * and a 32px blurred pill — icon, name, last action, ✕ — that takes its place
 * on hover and doubles as the drag handle. The picture is the whole card, so
 * every pixel of chrome is a pixel of preview you do not get.
 */

/** The scrub strip OVERLAYS the media's bottom edge; it never adds height. */
const SCRUB_STRIP_HEIGHT = 2;
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
 * call activity is what keeps the most-recent-tool clock honest.
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
  chatSessionId,
  sessionLaneId = null,
  runtimePin,
  onPick,
}: {
  /** The Work route is on screen. Everything here is torn down when it is not. */
  active: boolean;
  laneId: string | null;
  /** The tool currently filling the tools pane, or null when it is closed/on the picker. */
  activeTool: WorkSidebarTab | null;
  /** The chat on screen. The card only shows sessions owned by this chat. */
  chatSessionId: string | null;
  /**
   * The chat's own lane, null for a lane-less chat. `laneId` is the pane's
   * lane, which a lane-less chat borrows; only a chat of the lane gets the
   * floating Mac Desktop by default.
   */
  sessionLaneId?: string | null;
  runtimePin: OpenProjectBinding | null;
  onPick: (tool: WorkSidebarTab) => void;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  const projectStateKey = useAppStore(selectActiveProjectStateKey);
  const setWorkViewState = useAppStore((state) => state.setWorkViewState);
  // Through the store's own selectors rather than a hand-built `"<p>::<lane>"`
  // key: the key shape and the normalizers are the store's business, and
  // spelling them here is how the two copies drifted in the first place.
  const storedPosition = useAppStore(
    useMemo(() => {
      const select = selectWorkViewState(projectStateKey);
      return (state: Parameters<typeof select>[0]) => select(state).workLiveCardPosition ?? null;
    }, [projectStateKey]),
  );
  // Width is a layout preference, so it is project-scoped beside the position.
  const storedWidth = useAppStore(
    useMemo(() => {
      const select = selectWorkViewState(projectStateKey);
      return (state: Parameters<typeof select>[0]) => select(state).workLiveCardWidth ?? null;
    }, [projectStateKey]),
  );

  const runtimePinRef = useRef(runtimePin);
  runtimePinRef.current = runtimePin;

  const [lastTrace, setLastTrace] = useState<BuiltInBrowserActionTraceEntry | null>(null);
  const [appControlAction, setAppControlAction] = useState<{ caption: string; at: number } | null>(null);
  const [activityAt, setActivityAt] = useState<Record<WorkLiveScreenTool, number>>({
    browser: 0,
    "app-control": 0,
    ios: 0,
    "mac-desktop": 0,
  });
  /** Only used when there is no project to persist into (a projectless Work surface). */
  const [localPosition, setLocalPosition] = useState<WorkLiveCardPosition | null>(null);
  const [localWidth, setLocalWidth] = useState<number | null>(null);
  /**
   * Closed/floated state for a surface with no chat. A chat-backed card reads
   * the per-chat source of truth in `chatCompanionUiState` instead.
   */
  const [localClosed, setLocalClosed] = useState<WorkLiveCardClosedByTool>({});
  const [localFloating, setLocalFloating] = useState<WorkLiveScreenTool[]>([]);
  const [localSeen, setLocalSeen] = useState<WorkLiveCardSeenByTool>({});
  /** The picture's own width / height, which the box is built from. */
  const [sourceAspect, setSourceAspect] = useState<number | null>(null);
  /** Live width while a resize gesture is in flight; null otherwise. */
  const [resizeWidth, setResizeWidth] = useState<number | null>(null);
  // Held by trace ID, not by index: a new action shifts the whole buffer left,
  // and an index would then caption a different action than the picture the
  // pointer is still parked on.
  const [scrubFrameId, setScrubFrameId] = useState<string | null>(null);
  const [hovering, setHovering] = useState(false);
  const [hostSize, setHostSize] = useState({ width: 0, height: 0 });
  const [bottomReserve, setBottomReserve] = useState(0);
  const [scrubBuffer, setScrubBuffer] = useState<readonly WorkLiveScrubFrame[]>([]);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const companionUi = useChatCompanionUiState(chatSessionId);
  const closed: WorkLiveCardClosedByTool = chatSessionId
    ? companionUi.workLiveCardClosedByTool
    : localClosed;
  const floating: readonly WorkLiveScreenTool[] = chatSessionId
    ? companionUi.workLiveCardFloating
    : localFloating;
  /**
   * Which session each tool showed the last time THIS chat's pane had it open.
   *
   * An unowned session — a tab you opened by hand, an app you attached — has
   * no chat, so it used to float over every chat and × only silenced it in
   * one. Now it may float only in a chat whose pane has shown it, which is
   * the chat you opened it in (and any chat you later looked at it from).
   */
  const seen: WorkLiveCardSeenByTool = chatSessionId
    ? companionUi.workLiveCardSeenByTool
    : localSeen;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const scrubImageRef = useRef<HTMLImageElement | null>(null);
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
  /** Latest frame not yet painted; drained by one rAF so 12fps costs one paint. */
  const pendingFrameRef = useRef<string | null>(null);
  const frameRafRef = useRef<number | null>(null);
  /** What is on screen right now, so a trace entry can snapshot it. */
  const liveFrameRef = useRef<string | null>(null);
  const draggingRef = useRef(false);
  /** A drag ends with a click event; that click must not also open the tool. */
  const suppressClickRef = useRef(false);
  const browserSignatureRef = useRef("");
  const appControlTraceIdRef = useRef<string | null>(null);
  /**
   * Which tool the card is painting. Both the browser and App Control feeds are
   * subscribed at once (that is how "which tool is most recently active" is
   * known at all), so the paint path has to be gated or App Control's 30fps
   * screencast would draw over the browser thumbnail.
   */
  const paintToolRef = useRef<WorkLiveScreenTool | null>(null);
  const activityRef = useRef<Record<WorkLiveScreenTool, number>>({
    browser: 0,
    "app-control": 0,
    ios: 0,
    "mac-desktop": 0,
  });
  const activityCommitRef = useRef<number | null>(null);
  /** Resize gesture state: where the pointer started and how wide the card was. */
  const resizeStartRef = useRef<{ x: number; width: number } | null>(null);

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

  /**
   * A browser that was already open when this card mounted still counts.
   *
   * Activity used to advance on events only, so a tab opened before the Work
   * page (or before a remount of it) had `lastActivityAt: 0` and
   * `selectWorkLiveCardTool` skipped it forever — a live tool the card could
   * never show. The settled `getStatus` answer is the session, not a refresh:
   * an unchanged signature is ignored.
   */
  const onBrowserStatusSettled = useCallback((status: BuiltInBrowserStatus | null) => {
    if (!status || !Array.isArray(status.tabs) || status.tabs.length === 0) return;
    const signature = browserActivitySignature(status);
    if (signature === browserSignatureRef.current) return;
    browserSignatureRef.current = signature;
    bump("browser");
  }, [bump]);

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
      // this card: bumping on it made the × unusable and let App Control win
      // the most-recent-activity tie-break forever. Real activity is a session
      // event or a new trace id.
      if (event.frame.width > 0 && event.frame.height > 0) {
        setSourceAspect(event.frame.width / event.frame.height);
      }
      paintFrame("app-control", `data:${event.frame.mimeType};base64,${event.frame.data}`);
    }
  }, [bump, paintFrame]);

  // The page's one subscription set, shared with the Work tools pane: the
  // capability gate, the web-client boundary check, the offline guard and the
  // teardown all live in `NativeToolFeedsProvider`. The card contributes
  // handlers to its fan-out and opens nothing of its own.
  const {
    browserStatus,
    iosSession,
    appControlSession,
    browserViewRoot,
    canBrowser,
    canAppControl,
    context: toolContext,
  } = useNativeToolFeeds();
  useNativeToolFeedHandlers(useMemo(() => ({
    onBrowserStatusSettled,
    onBrowserEvent,
    onAppControlEvent,
  }), [onAppControlEvent, onBrowserEvent, onBrowserStatusSettled]));

  /**
   * A session that was already running when this card mounted counts too.
   *
   * The same gap the settled browser answer closes: App Control and the
   * simulator only bump on events, so a card that mounted after the session
   * started — a Work remount, a chat switch — saw a live session with no
   * activity and could never picture it.
   */
  const seenAppControlSessionRef = useRef<string | null>(null);
  useEffect(() => {
    const key = appControlSession?.id ?? null;
    if (!key || key === seenAppControlSessionRef.current) return;
    seenAppControlSessionRef.current = key;
    bump("app-control");
  }, [appControlSession?.id, bump]);

  /* ── Which tool, and does it fit ───────────────────────────────────────── */

  const activeBrowserTab = useMemo(() => {
    if (!browserStatus) return null;
    return browserStatus.tabs.find((tab) => tab.id === browserStatus.activeTabId) ?? browserStatus.tabs[0] ?? null;
  }, [browserStatus]);

  // Every per-tool question the card asks — live, owner, caption, handoff,
  // recording, session key — answered once, by the adapter map beside the tool
  // list.
  const sourceState = useMemo(() => ({
    browserTab: activeBrowserTab,
    appControlSession,
    iosSession,
    // The Mac Desktop floats in its own player; this card never pictures it.
    macDesktopFrame: null,
  }), [activeBrowserTab, appControlSession, iosSession]);

  const sources = useMemo(() => ({
    browser: workLiveSource("browser", sourceState),
    "app-control": workLiveSource("app-control", sourceState),
    ios: workLiveSource("ios", sourceState),
    "mac-desktop": workLiveSource("mac-desktop", sourceState),
  }), [sourceState]);

  /**
   * The pane is showing a screen tool: remember its session for this chat.
   *
   * This is the one place the "seen" marker is written. It runs while the
   * pane is open on the tool (`activeTool`), so closing the pane floats what
   * you were just looking at, here, and nowhere else.
   */
  const paneSessionKey = activeTool && isWorkLiveScreenTool(activeTool)
    ? sources[activeTool].sessionKey
    : null;
  useEffect(() => {
    if (!activeTool || !isWorkLiveScreenTool(activeTool) || !paneSessionKey) return;
    if (chatSessionId) {
      markWorkLiveCardSeenForChat(chatSessionId, activeTool, paneSessionKey);
      return;
    }
    setLocalSeen((current) => (
      current[activeTool] === paneSessionKey ? current : { ...current, [activeTool]: paneSessionKey }
    ));
  }, [activeTool, chatSessionId, paneSessionKey]);

  /**
   * A floated tool's session ended (tab closed, app exited, simulator shut
   * down): the float was for that session, so drop it with the session.
   * Otherwise the card kept a blank frame with the tool's name on it after
   * you closed the very thing it was previewing.
   */
  const previousSessionKeysRef = useRef<Partial<Record<WorkLiveScreenTool, string | null>>>({});
  useEffect(() => {
    const previous = previousSessionKeysRef.current;
    for (const screenTool of WORK_LIVE_SCREEN_TOOLS) {
      const next = sources[screenTool].sessionKey;
      const before = previous[screenTool] ?? null;
      previous[screenTool] = next;
      if (before == null || next != null || !floating.includes(screenTool)) continue;
      if (chatSessionId) {
        unfloatWorkLiveCardForChat(chatSessionId, screenTool);
      } else {
        setLocalFloating((current) => current.filter((entry) => entry !== screenTool));
      }
    }
  }, [chatSessionId, floating, sources]);

  const activities = useMemo<WorkLiveActivity[]>(() => [
    {
      tool: "browser",
      lastActivityAt: activityAt.browser,
      available: canBrowser,
      live: sources.browser.live,
      ownerChatSessionId: activeBrowserTab?.ownerChatSessionId ?? null,
      sessionKey: sources.browser.sessionKey,
      showWhenUnowned: isWorkLiveCardSeen(seen, "browser", sources.browser.sessionKey),
    },
    {
      tool: "app-control",
      lastActivityAt: activityAt["app-control"],
      available: canAppControl,
      live: sources["app-control"].live,
      ownerChatSessionId: appControlSession?.chatSessionId ?? null,
      sessionKey: sources["app-control"].sessionKey,
      showWhenUnowned: isWorkLiveCardSeen(seen, "app-control", sources["app-control"].sessionKey),
    },
    /*
      The Apple device is deliberately absent: it floats in its own player,
      which the device rail opens (see the note on the component).
    */
    /*
      Nor is the Mac Desktop: it floats in `MacDesktopMiniPlayer`, beside
      this card.
    */
  ], [
    activeBrowserTab?.ownerChatSessionId,
    activityAt,
    appControlSession?.chatSessionId,
    canAppControl,
    canBrowser,
    seen,
    sources,
  ]);

  const tool = useMemo(
    () => selectWorkLiveCardTool({
      activeTool,
      activeChatSessionId: chatSessionId,
      activities,
      floatingTools: floating,
      closed,
    }),
    [activeTool, activities, chatSessionId, closed, floating],
  );

  const storedCardWidth = normalizeWorkLiveCardWidth(storedWidth);
  const chosenWidth = projectStateKey
    ? storedCardWidth ?? WORK_LIVE_CARD_DEFAULT_WIDTH
    : localWidth ?? WORK_LIVE_CARD_DEFAULT_WIDTH;

  const baseCardSize = workLiveCardSize({
    tool,
    width: resizeWidth ?? chosenWidth,
    aspect: sourceAspect,
    host: hostSize,
    bottomReserve,
  });
  const objectFit = WORK_LIVE_CARD_OBJECT_FIT;

  const fits = workLiveCardFits(hostSize, bottomReserve, baseCardSize);
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

  /*
    The card sits ABOVE whatever is parked at the bottom of the chat column —
    the composer, and anything that opts in with `data-work-live-card-avoid`.

    Measured as viewport RECTS against the host's own rect, not as
    `offsetHeight` of the first selector match: several chat panes stay mounted
    at once, and the previous version happily reserved space for a hidden
    empty-state composer belonging to a different session.
  */
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return undefined;
    const root = host.parentElement ?? host;
    let frame: number | null = null;
    const observed = new Set<Element>();
    const measure = () => {
      frame = null;
      const hostRect = host.getBoundingClientRect();
      const obstructions: { top: number; bottom: number; height: number }[] = [];
      const present = new Set<Element>();
      for (const element of root.querySelectorAll<HTMLElement>(WORK_LIVE_CARD_AVOID_SELECTOR)) {
        const rect = element.getBoundingClientRect();
        obstructions.push({ top: rect.top, bottom: rect.bottom, height: rect.height });
        present.add(element);
        // Observed lazily: a composer that grows with a draft has to re-measure,
        // and one that has not been rendered yet cannot be observed up front.
        if (observed.has(element)) continue;
        observer.observe(element);
        observed.add(element);
      }
      // ...and unobserved as soon as it leaves. A `ResizeObserver` holds a
      // strong reference to everything it watches.
      for (const element of observed) {
        if (present.has(element)) continue;
        observer.unobserve(element);
        observed.delete(element);
      }
      setBottomReserve(workLiveBottomReserve({
        host: { top: hostRect.top, bottom: hostRect.bottom, height: hostRect.height },
        obstructions,
      }));
    };
    const schedule = () => {
      if (frame != null) return;
      frame = window.requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(host);
    measure();
    return () => {
      if (frame != null) window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [visible]);

  const position = useMemo(
    () => (projectStateKey ? storedPosition : localPosition),
    [localPosition, projectStateKey, storedPosition],
  );

  const rect = useMemo(() => workLiveCardRect({
    host: hostSize,
    position,
    cardHeight: baseCardSize.height,
    cardWidth: baseCardSize.width,
    bottomReserve,
  }), [baseCardSize, bottomReserve, hostSize, position]);

  const dragConstraints = useMemo(() => workLiveCardDragConstraints({
    host: hostSize,
    origin: rect,
    cardHeight: baseCardSize.height,
    cardWidth: baseCardSize.width,
    bottomReserve,
  }), [baseCardSize, bottomReserve, hostSize, rect]);

  const dragX = useMotionValue(0);
  const dragY = useMotionValue(0);
  /** The pill is the drag handle, so the gesture is started by hand. */
  const dragControls = useDragControls();

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
      cardHeight: baseCardSize.height,
      cardWidth: baseCardSize.width,
      bottomReserve,
    });
    const next = workLiveCardPositionFromRect({
      host: hostSize,
      left: clamped.left,
      top: clamped.top,
      cardHeight: baseCardSize.height,
      cardWidth: baseCardSize.width,
    });
    if (projectStateKey) setWorkViewState(projectStateKey, { workLiveCardPosition: next });
    else setLocalPosition(next);
  }, [
    baseCardSize,
    bottomReserve,
    dragX,
    dragY,
    hostSize,
    projectStateKey,
    rect.left,
    rect.top,
    setWorkViewState,
  ]);

  /* ── Resize (width only; the aspect stays locked) ───────────────────────── */

  const commitResize = useCallback((width: number) => {
    const bounds = workLiveCardWidthBounds(hostSize.width);
    const next = Math.max(bounds.min, Math.min(bounds.max, Math.round(width)));
    const nextSize = workLiveCardSize({
      tool,
      width: next,
      aspect: sourceAspect,
      host: hostSize,
      bottomReserve,
    });
    // Widening moves the right edge (and a taller aspect the bottom edge), so a
    // card parked against one has to be pulled back inside before the new
    // width is persisted — otherwise the stored position reopens off-column.
    const clamped = clampWorkLiveCardRect({
      host: hostSize,
      left: rect.left,
      top: rect.top,
      cardHeight: nextSize.height,
      cardWidth: nextSize.width,
      bottomReserve,
    });
    const nextPosition = workLiveCardPositionFromRect({
      host: hostSize,
      left: clamped.left,
      top: clamped.top,
      cardHeight: nextSize.height,
      cardWidth: nextSize.width,
    });
    if (projectStateKey) {
      setWorkViewState(projectStateKey, {
        workLiveCardWidth: next,
        workLiveCardPosition: nextPosition,
      });
    } else {
      setLocalWidth(next);
      setLocalPosition(nextPosition);
    }
  }, [
    bottomReserve,
    hostSize,
    projectStateKey,
    rect.left,
    rect.top,
    setWorkViewState,
    sourceAspect,
    tool,
  ]);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    resizeStartRef.current = { x: event.clientX, width: baseCardSize.width };
    setResizeWidth(baseCardSize.width);
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  }, [baseCardSize.width]);

  const handleResizePointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const start = resizeStartRef.current;
    if (!start) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = workLiveCardWidthBounds(hostSize.width);
    const next = Math.max(bounds.min, Math.min(bounds.max, Math.round(start.width + (event.clientX - start.x))));
    setResizeWidth(next);
  }, [hostSize.width]);

  const handleResizePointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!resizeStartRef.current) return;
    resizeStartRef.current = null;
    event.preventDefault();
    event.stopPropagation();
    const bounds = workLiveCardWidthBounds(hostSize.width);
    const next = Math.max(bounds.min, Math.min(bounds.max, Math.round(resizeWidth ?? baseCardSize.width)));
    setResizeWidth(null);
    commitResize(next);
  }, [baseCardSize.width, commitResize, hostSize.width, resizeWidth]);

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
      maxWidth: workLivePreviewMaxWidth(window.devicePixelRatio, baseCardSize.width),
    }).catch(() => {
      started = false;
    });
    return () => {
      if (!started) return;
      void stopPreviewStream({ ...scope, tabId: previewTabId }).catch(() => {});
    };
  }, [baseCardSize.width, browserViewRoot, previewTabId, visible]);

  // Switching source tools must not leave the previous tool's last frame or
  // aspect on screen under the new tool's name.
  useEffect(() => {
    paintToolRef.current = visible ? tool : null;
    liveFrameRef.current = null;
    pendingFrameRef.current = null;
    appControlTraceIdRef.current = null;
    setSourceAspect(null);
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
    if (draggingRef.current || resizeStartRef.current) return;
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
  // than re-indexed.
  const scrubbedFrame = useMemo(() => (
    scrubFrameId == null
      ? null
      : scrubBuffer.find((frame) => workLiveScrubFrameKey(frame) === scrubFrameId) ?? null
  ), [scrubBuffer, scrubFrameId]);
  const ownerLabel = source?.ownerLabel ?? null;

  /**
   * What the card is a picture OF — `example.com`, the app under App Control,
   * the simulator's app. It leads the pill.
   */
  const identity = source?.caption ?? definition?.label ?? null;

  const caption = useMemo(() => {
    if (scrubbedFrame) {
      return scrubbedFrame.caption
        ? `${scrubbedFrame.caption} · ${formatWorkLiveAge(nowTick - scrubbedFrame.at)}`
        : formatWorkLiveAge(nowTick - scrubbedFrame.at);
    }
    // The most recent ACTION, in the slot after the page: "click 'Sign in' · 2s"
    // is the news, and the page it happened to is now the line before it.
    if (tool === "browser" && lastTrace) {
      const label = formatWorkLiveActionCaption(lastTrace.action, lastTrace.target);
      return `${label} · ${formatWorkLiveAge(nowTick - (Date.parse(lastTrace.endedAt) || nowTick))}`;
    }
    if (tool === "app-control" && appControlAction) {
      return `${appControlAction.caption} · ${formatWorkLiveAge(nowTick - appControlAction.at)}`;
    }
    return null;
  }, [appControlAction, lastTrace, nowTick, scrubbedFrame, tool]);

  const handoff = source?.handoff ?? null;
  const recording = source?.recording ?? null;

  /**
   * ×, keyed by the session the card is showing.
   *
   * A new session (new key) may show again; frames, status refreshes and
   * remounts never can, because they do not change the key.
   */
  const handleDismiss = useCallback(() => {
    if (!tool) return;
    const sessionKey = sources[tool]?.sessionKey ?? "";
    if (chatSessionId) {
      closeWorkLiveCardForChat(chatSessionId, tool, sessionKey);
      return;
    }
    setLocalClosed((current) => ({ ...current, [tool]: sessionKey }));
    setLocalFloating((current) => current.filter((entry) => entry !== tool));
  }, [chatSessionId, sources, tool]);

  const activate = useCallback(() => {
    if (suppressClickRef.current || draggingRef.current || resizeStartRef.current || !tool) return;
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
  /**
   * The whole of the resting chrome, as one colour.
   *
   * An 8px dot cannot spell "recording" or "waiting for you", so it does the
   * only thing that size affords: red beats amber beats rest, worst news first.
   */
  const statusColor = recording
    ? "var(--color-error)"
    : handoff
      ? "var(--color-warning)"
      : null;
  // The highlighted slot follows the frame the pointer holds, so an eviction
  // moves the highlight with the picture instead of leaving it behind.
  const scrubbedIndex = scrubbedFrame ? scrubBuffer.indexOf(scrubbedFrame) : -1;
  const timelineIndex = scrubbedIndex >= 0 ? scrubbedIndex : scrubBuffer.length - 1;
  const scrubbable = scrubBuffer.length > 1;

  return (
    <>
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
            // The pill is the handle, so the card itself listens for nothing:
            // dragging from the picture would fight the scrubber, which is the
            // same gesture across the same pixels.
            dragListener={false}
            dragControls={dragControls}
            dragMomentum={false}
            dragElastic={0}
            dragConstraints={dragConstraints}
            style={{
              x: dragX,
              y: dragY,
              left: rect.left,
              top: rect.top,
              width: baseCardSize.width,
              height: baseCardSize.height,
            }}
            animate={reduceMotion
              ? { opacity: 1 }
              : { opacity: 1, scale: 1 }}
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
            initial={reduceMotion
              ? { opacity: 0 }
              : { opacity: 0, scale: 0.96 }}
            exit={reduceMotion
              ? { opacity: 0, transition: { duration: 0 } }
              : { opacity: 0, scale: 0.97, transition: EXIT }}
            transition={reduceMotion
              ? { duration: 0 }
              : ENTER}
            data-work-live-card={tool}
            className={cn(
              "group pointer-events-auto absolute cursor-pointer overflow-hidden",
              "select-none",
              "rounded-[var(--radius-lg)] bg-[var(--color-surface)] shadow-[var(--shadow-float)]",
              "transition-shadow duration-[120ms] ease-out motion-reduce:transition-none",
              "hover:shadow-[var(--shadow-card-hover)]",
            )}
            onPointerEnter={() => setHovering(true)}
            onPointerMove={handlePointerMove}
            onPointerLeave={handlePointerLeave}
            onClick={handleCardClick}
          >
            {/* The picture is the card, contained so nothing is cropped. */}
            <button
              type="button"
              data-live-card-inert=""
              onClick={activate}
              aria-label={`Open ${definition.label} in the tools pane`}
              className={cn(
                "absolute inset-0 block h-full w-full cursor-pointer border-0 bg-transparent p-0",
                "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-accent)]",
              )}
            >
              <img
                ref={setImageRef}
                alt=""
                src={BLANK_FRAME}
                onLoad={(event) => {
                  const image = event.currentTarget;
                  if (image.naturalWidth > 0 && image.naturalHeight > 0) {
                    setSourceAspect(image.naturalWidth / image.naturalHeight);
                  }
                }}
                className="h-full w-full"
                style={{ objectFit }}
              />
              <img
                ref={setScrubImageRef}
                alt=""
                aria-hidden="true"
                src={BLANK_FRAME}
                className={cn(
                  "pointer-events-none absolute inset-0 h-full w-full bg-[var(--color-surface)]",
                  "transition-opacity duration-[120ms] ease-out motion-reduce:transition-none",
                )}
                style={{
                  opacity: scrubbedFrame?.dataUrl ? 1 : 0,
                  objectFit,
                }}
              />
            </button>

            {/*
              The hairline, drawn OVER the media rather than as a border under
              it: a full-bleed frame paints its own pixels into the rounded
              corners otherwise, and the card loses its edge against the chat.
            */}
            <span
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute inset-0 rounded-[inherit]",
                "shadow-[inset_0_0_0_1px_var(--chat-glass-border)]",
              )}
            />

            {/* The ten slots, oldest on the left. Hovering the card scrubs it. */}
            {hovering && scrubbable ? (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 bottom-0 flex items-stretch gap-[1px] px-1"
                style={{ height: SCRUB_STRIP_HEIGHT }}
              >
                {scrubBuffer.map((frame, index) => (
                  <span
                    key={`${frame.id ?? frame.at}-${index}`}
                    className="flex-1 rounded-full transition-colors duration-[120ms] motion-reduce:transition-none"
                    style={{
                      background: index === timelineIndex
                        ? hue
                        : "color-mix(in srgb, var(--color-fg) 24%, transparent)",
                    }}
                  />
                ))}
              </div>
            ) : null}

            {/*
              At rest: one 8px dot. It is the whole chrome, and it is enough —
              the card's job is to show you the screen, and a title bar over a
              picture spends a tenth of it saying what the picture already says.
            */}
            <span
              aria-hidden="true"
              data-live-card-status={recording ? "recording" : handoff ? "handoff" : "idle"}
              title={recording ? "Recording" : handoff?.detail ?? undefined}
              className={cn(
                "pointer-events-none absolute right-2 top-2 h-2 w-2 rounded-full",
                "shadow-[0_0_0_1px_rgba(0,0,0,0.45)]",
                "transition-opacity duration-[120ms] ease-out motion-reduce:transition-none",
                "group-hover:opacity-0 group-focus-within:opacity-0",
                statusColor ? null : "bg-fg/25",
                recording ? "[animation:ade-status-pulse_1.6s_steps(1)_infinite] motion-reduce:animate-none" : null,
              )}
              style={statusColor ? { background: statusColor } : undefined}
            />

            {/*
              …and on hover, in its place: the 32px pill. It is also the drag
              handle, so the thing you reach for to move the card is the thing
              that appears when you reach for the card.
            */}
            <div
              data-live-card-pill=""
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                dragControls.start(event);
              }}
              className={cn(
                "absolute inset-x-2 top-2 flex h-8 items-center gap-2 rounded-[10px] px-2",
                "border border-[var(--chat-glass-border)] bg-[var(--chat-glass-bg)]",
                "backdrop-blur-[var(--blur-popup)] shadow-[var(--shadow-popup)]",
                "cursor-grab active:cursor-grabbing",
                "pointer-events-none opacity-0 transition-opacity duration-[120ms] ease-out",
                "group-hover:pointer-events-auto group-hover:opacity-100",
                "group-focus-within:pointer-events-auto group-focus-within:opacity-100",
                "motion-reduce:transition-none",
              )}
            >
              {Icon ? (
                <Icon size={14} weight="duotone" className="shrink-0" style={{ color: hue }} />
              ) : null}
              {/*
                `min-w-0` + a shrink budget rather than `shrink-0`: a page title
                can be sixty characters, and pinning it at full width pushes the
                action, the ✕ and everything else out of the pill.
              */}
              <span
                className="min-w-0 shrink truncate text-[11px] font-medium text-fg"
                title={identity ?? undefined}
              >
                {identity ?? definition.label}
                {ownerLabel ? <span className="text-muted-fg"> · {ownerLabel}</span> : null}
              </span>
              <span
                className="min-w-0 flex-1 truncate text-[11px] text-muted-fg"
                title={caption ?? undefined}
              >
                {caption ?? " "}
              </span>
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
              {recording ? (
                <span
                  title="Recording"
                  aria-hidden="true"
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    "[animation:ade-status-pulse_1.6s_steps(1)_infinite] motion-reduce:animate-none",
                  )}
                  style={{ background: "var(--color-error)" }}
                />
              ) : null}
              {!scrubbedFrame && !recording && !handoff ? (
                <span className="shrink-0 text-[9.5px] font-medium tracking-[0.2px] text-muted-fg/70">
                  Live
                </span>
              ) : null}
              <button
                type="button"
                data-live-card-inert=""
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  handleDismiss();
                }}
                title="Close until a new session"
                aria-label={`Hide the ${definition.label} preview`}
                className={cn(
                  "-mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px]",
                  "text-muted-fg/80 transition-colors duration-[120ms] motion-reduce:transition-none",
                  "hover:bg-white/[0.08] hover:text-fg",
                  "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
                )}
              >
                <X size={11} weight="bold" />
              </button>
            </div>

            {/*
              The resize handle: bottom-right, width only. The aspect stays
              locked, so dragging it changes the box's width and lets the height
              follow the picture rather than distorting it.
            */}
            <span
              data-live-card-inert=""
              data-live-card-resize=""
              onPointerDown={handleResizePointerDown}
              onPointerMove={handleResizePointerMove}
              onPointerUp={handleResizePointerUp}
              onPointerCancel={handleResizePointerUp}
              onClick={(event) => event.stopPropagation()}
              title="Resize preview"
              className={cn(
                "absolute bottom-0 right-0 z-10 h-4 w-4 cursor-nwse-resize touch-none",
                "opacity-0 transition-opacity duration-[120ms] motion-reduce:transition-none",
                "group-hover:opacity-100 group-focus-within:opacity-100",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute bottom-[3px] right-[3px] h-2 w-2 rounded-[2px]",
                  "border-b border-r border-white/70 drop-shadow-[0_1px_1px_rgba(0,0,0,0.6)]",
                )}
              />
            </span>
          </motion.section>
        ) : null}
      </AnimatePresence>
    </div>
    {/*
      A sibling of the card's host, not a child: it is positioned in the chat
      column itself, like the floating Apple device, and above the card.
    */}
    <MacDesktopMiniPlayer
      active={active}
      laneId={laneId}
      paneTool={activeTool}
      chatSessionId={chatSessionId}
      sessionLaneId={sessionLaneId}
      runtimePin={runtimePin}
      supported={toolContext.supportsMacDesktop !== false}
      onOpenInPane={() => onPick("mac-desktop")}
    />
    </>
  );
}
