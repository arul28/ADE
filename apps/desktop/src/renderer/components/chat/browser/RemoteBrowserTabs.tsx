/**
 * Browser tabs on another machine: listed beside this computer's, watched live,
 * and taken over when a person wants to.
 *
 * Tabs stay on the machine that opened them (sign-ins are per machine, and a
 * browser mirrored live between machines would be heavy and fragile). When a
 * chat runs on another machine and its agent used *that* machine's browser —
 * a chat started from the phone, a Mac Studio doing the dev work — its tabs
 * show here as a row named for that machine. Picking one streams it: a few
 * frames a second, only while you watch (each poll renews a short watch on
 * that machine; stop polling and it stops capturing). Two buttons sit on the
 * picture:
 *
 * - **Take control**: your clicks, scrolls and typing go to that tab. The tab
 *   becomes yours, so ADE will not close it on its own.
 * - **Open here**: load the page in this computer's browser instead (a
 *   localhost page goes through a tunnel, as any remote localhost does).
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from "react";
import { ArrowSquareIn, CursorClick, Desktop, HandPointing, X } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../../shared/types";
import type { BuiltInBrowserRemoteInputEvent, BuiltInBrowserRemoteTabFrame } from "../../../../shared/types/builtInBrowser";
import type { WorkToolsAgentBrowserPresence, WorkToolsBrowserTab } from "../../../../shared/types/workTools";
import { cn } from "../../ui/cn";
import { TOOLBAR_FOCUS } from "./browserChrome";

type RemotePin = Extract<OpenProjectBinding, { kind: "remote" }>;

/** How often the remote machine's tab list is read while the pane is up. */
const REMOTE_TABS_POLL_MS = 5_000;
/** Frames a second while watching. The other machine's capture loop runs at the same rate. */
const FRAME_POLL_MS = 250;

export type RemoteBrowserTabsState = {
  tabs: WorkToolsBrowserTab[];
  presence: WorkToolsAgentBrowserPresence[];
};

/**
 * The other machine's tabs for this lane, read from its Work-tools mirror
 * every few seconds while the pane is mounted and the window is visible.
 * Nothing is read for this computer's own lanes.
 */
export function useRemoteBrowserTabs(pin: RemotePin | null, laneId: string | null): RemoteBrowserTabsState {
  const [state, setState] = useState<RemoteBrowserTabsState>({ tabs: [], presence: [] });
  const pinKey = pin?.key ?? null;
  const pinRef = useRef(pin);
  pinRef.current = pin;
  useEffect(() => {
    const getLaneState = window.ade?.workTools?.getLaneState;
    if (!pinKey || !laneId || typeof getLaneState !== "function") {
      setState({ tabs: [], presence: [] });
      return undefined;
    }
    let cancelled = false;
    let timer: number | null = null;
    const read = async () => {
      timer = null;
      if (document.visibilityState === "visible") {
        try {
          const lane = await getLaneState(laneId, pinRef.current);
          if (!cancelled) {
            setState((current) => {
              const tabs = lane?.browser?.tabs ?? [];
              const presence = lane?.agentBrowserPresence ?? [];
              const same = current.tabs.length === tabs.length
                && current.tabs.every((tab, index) => tab.id === tabs[index]?.id && tab.title === tabs[index]?.title && tab.url === tabs[index]?.url)
                && current.presence.length === presence.length
                && current.presence.every((entry, index) => entry.chatSessionId === presence[index]?.chatSessionId && entry.tabId === presence[index]?.tabId);
              return same ? current : { tabs, presence };
            });
          }
        } catch {
          // An unreachable machine just shows no remote tabs.
        }
      }
      if (!cancelled) timer = window.setTimeout(read, REMOTE_TABS_POLL_MS);
    };
    void read();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [laneId, pinKey]);
  return state;
}

function hostLabel(url: string | null): string {
  if (!url) return "New tab";
  try {
    const parsed = new URL(url);
    return parsed.host || url;
  } catch {
    return url;
  }
}

/** The row of the other machine's tabs, under this computer's strip. */
export function RemoteBrowserTabRow({
  machineName,
  tabs,
  presence,
  selectedTabId,
  onSelect,
}: {
  machineName: string;
  tabs: WorkToolsBrowserTab[];
  presence: WorkToolsAgentBrowserPresence[];
  selectedTabId: string | null;
  onSelect: (tabId: string | null) => void;
}) {
  if (tabs.length === 0) return null;
  const busyTabs = new Set(presence.map((entry) => entry.tabId).filter(Boolean));
  return (
    <div
      className="flex h-[28px] min-w-0 shrink-0 select-none items-center gap-1 overflow-x-auto px-2 scrollbar-none"
      role="tablist"
      aria-label={`Browser tabs on ${machineName}`}
      data-testid="browser-remote-tabs"
    >
      <span className="inline-flex shrink-0 items-center gap-1 pr-1 text-[11px] text-muted-fg/60" title={`These tabs are open in ADE on ${machineName}. Pick one to watch it live.`}>
        <Desktop size={11} />
        {machineName}
      </span>
      {tabs.map((tab) => {
        const selected = tab.id === selectedTabId;
        const live = busyTabs.has(tab.id);
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(selected ? null : tab.id)}
            className={cn(
              "relative inline-flex h-[22px] max-w-[180px] shrink-0 items-center gap-1.5 rounded-md px-2 text-[11.5px]",
              "transition-colors duration-[120ms] ease-out",
              selected ? "bg-fg/[0.08] text-fg/90" : "text-muted-fg/70 hover:bg-fg/[0.04] hover:text-fg/85",
              TOOLBAR_FOCUS,
            )}
            title={[
              tab.title ?? hostLabel(tab.url),
              tab.url,
              live ? "An agent is using this tab right now" : null,
              selected ? "Click to stop watching" : `Watch it live from ${machineName}`,
            ].filter(Boolean).join("\n")}
          >
            {live ? (
              <span aria-label="Agent is using this tab" className="h-[5px] w-[5px] shrink-0 rounded-full bg-[var(--color-accent)] [animation:ade-status-pulse_1.6s_steps(1)_infinite] motion-reduce:animate-none" />
            ) : null}
            <span className="min-w-0 truncate">{tab.title?.trim() || hostLabel(tab.url)}</span>
          </button>
        );
      })}
    </div>
  );
}

const SPECIAL_KEYS: Record<string, string> = {
  Enter: "Enter",
  Backspace: "Backspace",
  Tab: "Tab",
  Delete: "Delete",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
};

/**
 * The live picture of one tab on another machine, over the stage.
 *
 * Polls one frame at a time (never two in flight), so a slow link lowers the
 * frame rate instead of queueing. Watching is passive; Take control turns the
 * picture into an input surface until Esc or the button again.
 */
export function RemoteBrowserTabViewer({
  pin,
  machineName,
  tabId,
  onClose,
  onOpenHere,
}: {
  pin: RemotePin;
  machineName: string;
  tabId: string;
  onClose: () => void;
  onOpenHere: (url: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<BuiltInBrowserRemoteTabFrame | null>(null);
  const [gone, setGone] = useState(false);
  const [controlling, setControlling] = useState(false);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const pinRef = useRef(pin);
  pinRef.current = pin;

  useEffect(() => {
    const read = window.ade?.workTools?.readBrowserTabFrame;
    if (typeof read !== "function") return undefined;
    let cancelled = false;
    let timer: number | null = null;
    let misses = 0;
    const tick = async () => {
      timer = null;
      if (document.visibilityState === "visible") {
        try {
          const next = await read({ tabId, maxWidth: 1_440 }, pinRef.current);
          if (cancelled) return;
          if (next) {
            misses = 0;
            setGone(false);
            setSnapshot((current) => (
              current && current.frame?.capturedAt === next.frame?.capturedAt && current.url === next.url && current.title === next.title
                ? current
                : next
            ));
          } else {
            misses += 1;
            // Three answers in a row with no tab: it closed over there.
            if (misses >= 3) setGone(true);
          }
        } catch {
          // A dropped link: keep the last frame and try again.
        }
      }
      if (!cancelled) timer = window.setTimeout(tick, FRAME_POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [pin.key, tabId]);

  useEffect(() => {
    if (controlling) surfaceRef.current?.focus();
  }, [controlling]);

  const send = useCallback((event: BuiltInBrowserRemoteInputEvent) => {
    void window.ade?.workTools?.sendBrowserTabInput?.({ tabId, event }, pinRef.current).catch(() => {});
  }, [tabId]);

  /** Where in the picture (0–1 each way) the pointer is; null outside it. */
  const fractionAt = (event: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const image = imageRef.current;
    if (!image) return null;
    const rect = image.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  };

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!controlling) return;
    const at = fractionAt(event);
    if (at) send({ type: "click", ...at });
  };
  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!controlling) return;
    const at = fractionAt(event);
    if (at) send({ type: "scroll", ...at, deltaY: event.deltaY });
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!controlling) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setControlling(false);
      return;
    }
    if (event.metaKey || event.ctrlKey) return;
    const special = SPECIAL_KEYS[event.key];
    if (special) {
      event.preventDefault();
      send({ type: "key", key: special });
      return;
    }
    if (event.key.length === 1) {
      event.preventDefault();
      send({ type: "text", text: event.key });
    }
  };

  const frame = snapshot?.frame ?? null;
  const url = snapshot?.url ?? null;
  return (
    <div className="absolute inset-0 z-[1] flex flex-col bg-[var(--color-bg)]" data-testid="browser-remote-viewer">
      <div className="flex h-8 shrink-0 items-center gap-2 px-3 text-[11.5px]">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-fg/75">
          <span aria-hidden="true" className="h-[6px] w-[6px] shrink-0 rounded-full bg-emerald-400/90" />
          <span className="shrink-0">Live from {machineName}</span>
          {snapshot?.title ? <span className="min-w-0 truncate text-fg/80">· {snapshot.title}</span> : null}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setControlling((value) => !value)}
          disabled={gone}
          aria-pressed={controlling}
          className={cn(
            "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2",
            controlling ? "bg-[var(--color-accent)]/20 text-[var(--color-accent)]" : "text-fg/75 hover:bg-fg/[0.06]",
            "disabled:opacity-40",
            TOOLBAR_FOCUS,
          )}
          title={controlling ? "Stop controlling (Esc)" : `Click and type in this tab on ${machineName}. The tab becomes yours.`}
        >
          {controlling ? <HandPointing size={12} weight="fill" /> : <CursorClick size={12} />}
          {controlling ? "In control" : "Take control"}
        </button>
        <button
          type="button"
          onClick={() => url && onOpenHere(url)}
          disabled={!url}
          className={cn("inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-fg/75 hover:bg-fg/[0.06] disabled:opacity-40", TOOLBAR_FOCUS)}
          title="Open this page in this computer's browser"
        >
          <ArrowSquareIn size={12} />
          Open here
        </button>
        <button
          type="button"
          onClick={onClose}
          className={cn("inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-fg/70 hover:bg-fg/[0.06] hover:text-fg", TOOLBAR_FOCUS)}
          aria-label="Stop watching"
          title="Stop watching"
        >
          <X size={12} />
        </button>
      </div>
      <div
        ref={surfaceRef}
        tabIndex={controlling ? 0 : -1}
        onClick={handleClick}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
        className={cn(
          "relative mx-2 mb-2 flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-[10px] outline-none",
          "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-fg)_8%,transparent)]",
          controlling ? "cursor-pointer shadow-[inset_0_0_0_2px_var(--color-accent)]" : "cursor-default",
        )}
        aria-label={controlling ? `Controlling a tab on ${machineName}. Press Escape to stop.` : `Live picture of a tab on ${machineName}`}
      >
        {frame ? (
          <img
            ref={imageRef}
            src={frame.dataUrl}
            alt=""
            draggable={false}
            className="max-h-full max-w-full select-none object-contain"
          />
        ) : (
          <span className="text-[12px] text-muted-fg/60">
            {gone ? `This tab is no longer open on ${machineName}.` : `Connecting to ${machineName}…`}
          </span>
        )}
        {controlling ? (
          <span className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-white/90">
            You're in control · Esc to stop
          </span>
        ) : null}
      </div>
    </div>
  );
}
