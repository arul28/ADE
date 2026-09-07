import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { AnimatePresence, motion, useMotionValue, useReducedMotion } from "motion/react";
import { X } from "@phosphor-icons/react";
import type {
  AppControlSession,
  BuiltInBrowserActionTraceEntry,
  BuiltInBrowserStatus,
  IosSimulatorSession,
  OpenProjectBinding,
} from "../../../shared/types";
import {
  selectActiveProjectRoot,
  useAppStore,
  selectActiveProjectStateKey,
  type WorkSidebarTab,
} from "../../state/appStore";
import { isMacPlatform } from "../../lib/platform";
import { isWebClientMode } from "../../lib/webClientMode";
import { cn } from "../ui/cn";
import {
  workToolAvailability,
  workToolDefinition,
  type WorkToolContext,
} from "../terminals/workTools";
import {
  acquireIosSimulatorPreviewStream,
  type IosSimulatorPreviewLease,
} from "./iosSimulatorPreviewStream";
import {
  WORK_LIVE_CARD_ASPECT,
  WORK_LIVE_CARD_WIDTH,
  commitWorkLiveScrubFrame,
  formatWorkLiveActionCaption,
  formatWorkLiveAge,
  normalizeWorkLiveCardPosition,
  selectWorkLiveCardTool,
  workLiveCardFits,
  workLiveCardPositionFromRect,
  workLiveCardRect,
  workLiveScrubIndex,
  type WorkLiveActivity,
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

/** 16:10 media, plus a header and a caption row. */
const MEDIA_HEIGHT = Math.round(WORK_LIVE_CARD_WIDTH / WORK_LIVE_CARD_ASPECT);
const CHROME_HEIGHT = 44;
const CARD_HEIGHT = MEDIA_HEIGHT + CHROME_HEIGHT;
/** How often a frame-rate feed is allowed to move the "most recent tool" clock. */
const ACTIVITY_COMMIT_MS = 500;
/** t3's mini-player entry, in ADE's overshoot curve. */
const ENTER = { duration: 0.2, ease: [0.22, 1, 0.36, 1] as const };
const EXIT = { duration: 0.14, ease: [0.4, 0, 0.2, 1] as const };
const PREVIEW_FPS = 12;
const PREVIEW_MAX_WIDTH = 480;

type LiveHandoff = { label: string } | null;

/**
 * Feature detection, not a type assertion: the handoff field is being added by
 * another unit and may not exist in this build. An absent field renders
 * nothing rather than an "unknown" chip.
 */
function detectHandoff(value: unknown): LiveHandoff {
  if (!value || typeof value !== "object") return null;
  const handoff = (value as { handoff?: unknown }).handoff;
  if (!handoff || typeof handoff !== "object") return null;
  const record = handoff as { reason?: unknown; label?: unknown; state?: unknown; status?: unknown };
  for (const candidate of [record.reason, record.label, record.state, record.status]) {
    if (typeof candidate === "string" && candidate.trim()) return { label: candidate.trim() };
  }
  return { label: "Handoff" };
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
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const projectStateKey = useAppStore(selectActiveProjectStateKey);
  const isRemoteProject = useAppStore((state) => state.projectBinding?.kind === "remote");
  const setWorkViewState = useAppStore((state) => state.setWorkViewState);
  const storedPosition = useAppStore((state) => (
    projectStateKey ? state.workViewByProject[projectStateKey]?.workLiveCardPosition ?? null : null
  ));

  const context = useMemo<WorkToolContext>(() => ({
    isRemoteProject,
    supportsIosSimulator: isMacPlatform(),
    isWebClient: isWebClientMode(),
  }), [isRemoteProject]);

  const browserViewRoot = runtimePin?.kind === "local" ? runtimePin.rootPath : projectRoot;
  const runtimePinRef = useRef(runtimePin);
  runtimePinRef.current = runtimePin;

  const [browserStatus, setBrowserStatus] = useState<BuiltInBrowserStatus | null>(null);
  const [iosSession, setIosSession] = useState<IosSimulatorSession | null>(null);
  const [appControlSession, setAppControlSession] = useState<AppControlSession | null>(null);
  const [lastTrace, setLastTrace] = useState<BuiltInBrowserActionTraceEntry | null>(null);
  const [activityAt, setActivityAt] = useState<Record<WorkLiveScreenTool, number>>({
    browser: 0,
    "app-control": 0,
    ios: 0,
  });
  const [dismissedByLane, setDismissedByLane] = useState<Record<string, number>>({});
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const [hostSize, setHostSize] = useState({ width: 0, height: 0 });
  const [bottomReserve, setBottomReserve] = useState(0);
  const [scrubBuffer, setScrubBuffer] = useState<readonly WorkLiveScrubFrame[]>([]);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const hostRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  /** Latest frame not yet painted; drained by one rAF so 12fps costs one paint. */
  const pendingFrameRef = useRef<string | null>(null);
  const frameRafRef = useRef<number | null>(null);
  /** What is on screen right now, so a trace entry can snapshot it. */
  const liveFrameRef = useRef<string | null>(null);
  const scrubbingRef = useRef(false);
  const draggingRef = useRef(false);
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
  }, []);

  const paintFrame = useCallback((tool: WorkLiveScreenTool, dataUrl: string) => {
    if (paintToolRef.current !== tool) return;
    liveFrameRef.current = dataUrl;
    if (scrubbingRef.current) return;
    pendingFrameRef.current = dataUrl;
    if (frameRafRef.current != null) return;
    frameRafRef.current = window.requestAnimationFrame(() => {
      frameRafRef.current = null;
      const next = pendingFrameRef.current;
      pendingFrameRef.current = null;
      if (next && imageRef.current) imageRef.current.src = next;
    });
  }, []);

  const canBrowser = workToolAvailability("browser", context).available;
  const canIos = workToolAvailability("ios", context).available;
  const canAppControl = workToolAvailability("app-control", context).available;

  /* ── Feeds ─────────────────────────────────────────────────────────────── */

  useEffect(() => {
    if (!active || !canBrowser) {
      setBrowserStatus(null);
      return undefined;
    }
    const browser = window.ade?.builtInBrowser;
    if (!browser?.getStatus || !browser.onEvent) return undefined;
    let cancelled = false;
    const scope = browserViewRoot ? { projectRoot: browserViewRoot } : {};
    void browser.getStatus(scope, runtimePinRef.current)
      .then((status) => {
        if (!cancelled) setBrowserStatus(status ?? null);
      })
      .catch(() => {});
    const unsubscribe = browser.onEvent((event) => {
      if (event.type === "status" || event.type === "open-request") {
        setBrowserStatus(event.status);
        bump("browser");
        return;
      }
      if (event.type === "trace") {
        setLastTrace(event.entry);
        bump("browser");
        // The buffer advances on ACTIONS, not frames: ten near-identical
        // pictures 80ms apart are not something anybody can scrub through.
        setScrubBuffer((current) => commitWorkLiveScrubFrame(current, {
          dataUrl: liveFrameRef.current,
          caption: formatWorkLiveActionCaption(event.entry.action, event.entry.target),
          at: Date.parse(event.entry.endedAt) || Date.now(),
        }));
        return;
      }
      if (event.type === "preview-frame") {
        paintFrame("browser", event.dataUrl);
      }
    }, runtimePinRef.current);
    return () => {
      cancelled = true;
      unsubscribe();
      if (frameRafRef.current != null) {
        window.cancelAnimationFrame(frameRafRef.current);
        frameRafRef.current = null;
      }
    };
  }, [active, browserViewRoot, bump, canBrowser, paintFrame, runtimePin?.key]);

  useEffect(() => {
    if (!active || !canAppControl) {
      setAppControlSession(null);
      return undefined;
    }
    const appControl = window.ade?.appControl;
    if (!appControl?.getStatus || !appControl.onEvent) return undefined;
    let cancelled = false;
    void appControl.getStatus(runtimePinRef.current)
      .then((status) => {
        if (!cancelled) setAppControlSession(status.activeSession ?? null);
      })
      .catch(() => {});
    const unsubscribe = appControl.onEvent((event) => {
      if (event.type === "session-started" || event.type === "session-updated") {
        setAppControlSession(event.session ?? null);
        bump("app-control");
        return;
      }
      if (event.type === "session-stopped") {
        setAppControlSession(null);
        return;
      }
      if (event.type === "frame") {
        // App Control needs no start call — the panel's screencast is already
        // running and this is a second reader of the same event stream.
        bump("app-control");
        paintFrame("app-control", `data:${event.frame.mimeType};base64,${event.frame.data}`);
      }
    }, runtimePinRef.current);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [active, bump, canAppControl, paintFrame, runtimePin?.key]);

  useEffect(() => {
    if (!active || !canIos) {
      setIosSession(null);
      return undefined;
    }
    const iosSimulator = window.ade?.iosSimulator;
    if (!iosSimulator?.getStatus || !iosSimulator.onEvent) return undefined;
    let cancelled = false;
    void iosSimulator.getStatus(runtimePinRef.current)
      .then((status) => {
        if (!cancelled) setIosSession(status.activeSession ?? null);
      })
      .catch(() => {});
    const unsubscribe = iosSimulator.onEvent((event) => {
      if (event.type === "session-started" || event.type === "session-updated") {
        setIosSession(event.session ?? null);
        bump("ios");
      } else if (event.type === "session-released") {
        setIosSession(null);
      }
    }, runtimePinRef.current);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [active, bump, canIos, runtimePin?.key]);

  /* ── Which tool, and does it fit ───────────────────────────────────────── */

  const activeBrowserTab = useMemo(() => {
    if (!browserStatus) return null;
    return browserStatus.tabs.find((tab) => tab.id === browserStatus.activeTabId) ?? browserStatus.tabs[0] ?? null;
  }, [browserStatus]);

  const activities = useMemo<WorkLiveActivity[]>(() => [
    {
      tool: "browser",
      lastActivityAt: activityAt.browser,
      available: canBrowser,
      live: Boolean(activeBrowserTab),
    },
    {
      tool: "app-control",
      lastActivityAt: activityAt["app-control"],
      available: canAppControl,
      live: Boolean(appControlSession)
        && appControlSession?.status !== "stopped"
        && appControlSession?.status !== "exited",
    },
    {
      tool: "ios",
      lastActivityAt: activityAt.ios,
      available: canIos,
      live: Boolean(iosSession),
    },
  ], [activeBrowserTab, activityAt, appControlSession, canAppControl, canBrowser, canIos, iosSession]);

  const dismissedAt = laneId ? dismissedByLane[laneId] ?? null : null;
  const tool = useMemo(
    () => selectWorkLiveCardTool({ activeTool, activities, dismissedAt }),
    [activeTool, activities, dismissedAt],
  );

  const fits = workLiveCardFits(hostSize);
  const visible = active && tool != null && fits;

  /* ── Host geometry ─────────────────────────────────────────────────────── */

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      setHostSize({ width: host.clientWidth, height: host.clientHeight });
    });
    observer.observe(host);
    setHostSize({ width: host.clientWidth, height: host.clientHeight });
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

  const rect = useMemo(() => workLiveCardRect({
    host: hostSize,
    position: normalizeWorkLiveCardPosition(storedPosition),
    cardHeight: CARD_HEIGHT,
    bottomReserve,
  }), [bottomReserve, hostSize, storedPosition]);

  const dragX = useMotionValue(0);
  const dragY = useMotionValue(0);

  const commitDrag = useCallback(() => {
    if (!projectStateKey || hostSize.width <= 0) return;
    const next = workLiveCardPositionFromRect({
      host: hostSize,
      left: rect.left + dragX.get(),
      top: rect.top + dragY.get(),
      cardHeight: CARD_HEIGHT,
    });
    dragX.set(0);
    dragY.set(0);
    setWorkViewState(projectStateKey, { workLiveCardPosition: next });
  }, [dragX, dragY, hostSize, projectStateKey, rect.left, rect.top, setWorkViewState]);

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
    void startPreviewStream({ ...scope, tabId: previewTabId, fps: PREVIEW_FPS, maxWidth: PREVIEW_MAX_WIDTH })
      .catch(() => {
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
    setScrubBuffer([]);
    setScrubIndex(null);
    scrubbingRef.current = false;
    if (imageRef.current) imageRef.current.removeAttribute("src");
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
    const bounds = event.currentTarget.getBoundingClientRect();
    const index = workLiveScrubIndex({
      frameCount: scrubBuffer.length,
      offsetX: event.clientX - bounds.left,
      width: bounds.width,
    });
    setScrubIndex(index);
    scrubbingRef.current = index != null;
    const frame = index == null ? null : scrubBuffer[index];
    if (frame?.dataUrl && imageRef.current) imageRef.current.src = frame.dataUrl;
  }, [scrubBuffer]);

  const handlePointerLeave = useCallback(() => {
    setScrubIndex(null);
    scrubbingRef.current = false;
    // Snap back to live: whatever arrived while scrubbing is the freshest frame.
    if (liveFrameRef.current && imageRef.current) imageRef.current.src = liveFrameRef.current;
  }, []);

  /* ── Copy ──────────────────────────────────────────────────────────────── */

  const definition = tool ? workToolDefinition(tool) : null;
  const scrubbedFrame = scrubIndex == null ? null : scrubBuffer[scrubIndex] ?? null;
  const ownerLabel = useMemo(() => {
    if (tool === "browser") return activeBrowserTab?.ownerChatSessionId ? "agent" : null;
    if (tool === "app-control") return appControlSession?.chatSessionId ? "agent" : null;
    if (tool === "ios") return iosSession?.chatSessionId ? "agent" : null;
    return null;
  }, [activeBrowserTab, appControlSession, iosSession, tool]);

  const caption = useMemo(() => {
    if (scrubbedFrame) {
      return scrubbedFrame.caption
        ? `${scrubbedFrame.caption} · ${formatWorkLiveAge(nowTick - scrubbedFrame.at)}`
        : formatWorkLiveAge(nowTick - scrubbedFrame.at);
    }
    if (tool === "browser" && lastTrace) {
      const label = formatWorkLiveActionCaption(lastTrace.action, lastTrace.target);
      return `${label} · ${formatWorkLiveAge(nowTick - (Date.parse(lastTrace.endedAt) || nowTick))}`;
    }
    if (tool === "browser") return activeBrowserTab?.title ?? activeBrowserTab?.url ?? null;
    if (tool === "app-control") return appControlSession?.label ?? null;
    if (tool === "ios") return iosSession?.appName ?? iosSession?.deviceName ?? null;
    return null;
  }, [activeBrowserTab, appControlSession, iosSession, lastTrace, nowTick, scrubbedFrame, tool]);

  const handoff = useMemo(() => {
    if (tool === "browser") return detectHandoff(activeBrowserTab);
    if (tool === "app-control") return detectHandoff(appControlSession);
    if (tool === "ios") return detectHandoff(iosSession);
    return null;
  }, [activeBrowserTab, appControlSession, iosSession, tool]);

  const recording = tool === "browser" ? activeBrowserTab?.recording ?? null : null;

  const handleDismiss = useCallback(() => {
    if (!laneId) return;
    setDismissedByLane((current) => ({ ...current, [laneId]: Date.now() }));
  }, [laneId]);

  const Icon = definition?.icon ?? null;

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
            dragElastic={0.08}
            dragConstraints={hostRef}
            style={{ x: dragX, y: dragY, left: rect.left, top: rect.top, width: WORK_LIVE_CARD_WIDTH }}
            onDragStart={() => {
              draggingRef.current = true;
              scrubbingRef.current = false;
              setScrubIndex(null);
            }}
            onDragEnd={() => {
              draggingRef.current = false;
              commitDrag();
            }}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
            exit={reduceMotion
              ? { opacity: 0, transition: { duration: 0 } }
              : { opacity: 0, scale: 0.97, transition: EXIT }}
            transition={reduceMotion ? { duration: 0 } : ENTER}
            data-work-live-card={tool}
            className={cn(
              "pointer-events-auto absolute cursor-grab overflow-hidden rounded-[var(--radius-xl)]",
              "border border-white/[0.08] bg-[var(--chat-glass-bg)] shadow-[var(--shadow-float)]",
              "backdrop-blur-[var(--blur-popup)] active:cursor-grabbing",
            )}
            onPointerMove={handlePointerMove}
            onPointerLeave={handlePointerLeave}
          >
            <header className="flex items-center gap-1.5 px-2 pt-1.5 pb-1">
              {Icon ? <Icon size={12} weight="duotone" style={{ color: definition.color }} /> : null}
              <span className="min-w-0 truncate text-[10.5px] font-medium text-fg">{definition.label}</span>
              {ownerLabel ? (
                <span className="shrink-0 rounded-full bg-white/[0.07] px-1.5 text-[9px] font-medium uppercase tracking-[0.6px] text-muted-fg">
                  {ownerLabel}
                </span>
              ) : null}
              {recording ? (
                <span
                  className="shrink-0 rounded-full bg-red-500/15 px-1.5 text-[9px] font-semibold uppercase tracking-[0.6px] text-red-300"
                  title="Recording"
                >
                  REC
                </span>
              ) : null}
              {handoff ? (
                <span className="shrink-0 truncate rounded-full bg-amber-400/15 px-1.5 text-[9px] font-medium text-amber-200">
                  {handoff.label}
                </span>
              ) : null}
              <span className="flex-1" />
              <button
                type="button"
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
              onClick={() => onPick(tool)}
              aria-label={`Open ${definition.label} in the tools pane`}
              className={cn(
                "block w-full cursor-pointer border-0 bg-black/40 p-0",
                "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
              )}
              style={{ height: MEDIA_HEIGHT }}
            >
              {tool === "ios" ? (
                <video
                  ref={videoRef}
                  muted
                  playsInline
                  className="h-full w-full object-contain"
                />
              ) : (
                <img
                  ref={imageRef}
                  alt=""
                  className="h-full w-full object-cover object-top"
                />
              )}
            </button>

            <footer className="flex items-center gap-1 px-2 py-1">
              <span className="min-w-0 flex-1 truncate text-[9.5px] text-muted-fg" title={caption ?? undefined}>
                {caption ?? " "}
              </span>
              {scrubBuffer.length > 1 ? (
                <span
                  aria-hidden="true"
                  className="flex shrink-0 items-center gap-[2px]"
                >
                  {scrubBuffer.map((frame, index) => (
                    <span
                      key={`${frame.at}-${index}`}
                      className={cn(
                        "h-[3px] w-[3px] rounded-full transition-colors duration-[120ms]",
                        index === (scrubIndex ?? scrubBuffer.length - 1)
                          ? "bg-[var(--color-accent)]"
                          : "bg-white/20",
                      )}
                    />
                  ))}
                </span>
              ) : null}
            </footer>
          </motion.section>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
