/**
 * The browser pane's tab strip.
 *
 * Its own file because the strip is the one part of the chrome with real
 * keyboard semantics to get right — a tablist with roving focus — and that
 * logic was invisible buried in the middle of a 3,000-line render.
 *
 * It renders nothing at all for a single tab. One tab is not a choice, and a
 * strip that draws a lone chip above the address bar is 28px of furniture
 * restating what the tool header already says.
 */
import type { Dispatch, KeyboardEvent, MutableRefObject, SetStateAction } from "react";
import { Globe, Plus, Robot, X } from "@phosphor-icons/react";
import { motion } from "motion/react";
import type { BuiltInBrowserTab } from "../../../../shared/types/builtInBrowser";
import { tunnelAwareUrl, type TabTunnelMap } from "../browserRemoteTunnels";
import { browserTabLabel } from "./browserToolbarLabels";
import { cn } from "../../ui/cn";
import { TOOLBAR_FOCUS } from "./browserChrome";
import type { BrowserTab } from "./browserPanelTypes";

/** The `layoutId` spring the tools rail uses for its sliding indicator. */
const TAB_INDICATOR_SPRING = { type: "spring", stiffness: 520, damping: 38, mass: 0.7 } as const;
const TAB_INDICATOR_LAYOUT_ID = "ade-browser-tab-indicator";

function shortSessionId(sessionId: string | null): string | null {
  if (!sessionId) return null;
  return sessionId.length <= 8 ? sessionId : `${sessionId.slice(0, 4)}…${sessionId.slice(-3)}`;
}

function shortOwnerId(value: string | null): string | null {
  if (!value) return null;
  return value.length <= 10 ? value : `${value.slice(0, 5)}…${value.slice(-4)}`;
}

function browserTabOwnerLabel(tab: BuiltInBrowserTab): string | null {
  // During a login handoff the tab is the human's, so the strip must not keep
  // advertising an agent owner it has just been taken away from.
  if (tab.handoff) return "you own this tab";
  const lane = shortOwnerId(tab.ownerLaneId);
  const chat = shortSessionId(tab.ownerChatSessionId);
  if (lane && chat) return `${lane} · ${chat}`;
  return lane ?? chat;
}

export type BrowserTabStripProps = {
  stripRef: MutableRefObject<HTMLDivElement | null>;
  tabs: BrowserTab[];
  activeTabId: string | null;
  tabTunnels: TabTunnelMap;
  failedFavicons: Record<string, true>;
  setFailedFavicons: Dispatch<SetStateAction<Record<string, true>>>;
  fades: { start: boolean; end: boolean };
  reduceMotion: boolean;
  busy: string | null;
  apiAvailable: boolean;
  onScroll: () => void;
  onSwitchTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: () => void;
};

export function BrowserTabStrip({
  stripRef,
  tabs,
  activeTabId,
  tabTunnels,
  failedFavicons,
  setFailedFavicons,
  fades,
  reduceMotion,
  busy,
  apiAvailable,
  onScroll,
  onSwitchTab,
  onCloseTab,
  onNewTab,
}: BrowserTabStripProps) {
  /*
    Roving focus, so the strip costs one Tab stop instead of 2N.

    The tablist's own children are the tabs — the wrapper carries `role="tab"`
    and the select/close buttons inside it are taken out of the tab order — and
    the arrows walk between them by index, which is the same order the DOM is
    in. `aria-controls` is deliberately absent: the page is a native view the
    compositor paints over this renderer, so there is no DOM panel to point at.
  */
  const focusTabAt = (index: number) => {
    const strip = stripRef.current;
    const target = tabs[index];
    if (!strip || !target) return;
    const wrappers = strip.querySelectorAll<HTMLElement>('[role="tab"]');
    wrappers.item(index)?.focus();
    if (target.id !== activeTabId) onSwitchTab(target.id);
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const tab = tabs[index];
    if (!tab) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      focusTabAt(index + (event.key === "ArrowLeft" ? -1 : 1));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      focusTabAt(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      focusTabAt(tabs.length - 1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (tab.id !== activeTabId) onSwitchTab(tab.id);
    }
  };

  // One tab is not a choice. The title lives in the tool header above, so the
  // strip stays out of the way until there is something to switch between.
  if (tabs.length <= 1) return null;

  return (
    <div className="relative flex h-[32px] min-w-0 shrink-0 select-none items-center overflow-hidden">
      <div
        ref={stripRef}
        onScroll={onScroll}
        role="tablist"
        aria-label="ADE browser tabs"
        className="scrollbar-none flex min-w-0 flex-1 flex-nowrap items-center gap-1 overflow-x-auto px-2"
      >
        {tabs.map((tab, index) => {
          const active = tab.id === activeTabId;
          // A tunneled tab falls back to the REMOTE origin, never the forward
          // port, when the page has no title of its own.
          const tabUrl = tunnelAwareUrl(tab.url, tabTunnels[tab.id] ?? null) || null;
          const label = browserTabLabel(tab, tabUrl);
          const ownerLabel = browserTabOwnerLabel(tab);
          const ownerTitle = tab.handoff
            ? `You own this tab until you hand it back · ${tab.handoff.reason}`
            : ownerLabel
              ? `Agent holds this tab · ${ownerLabel}`
              : null;
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => {
                if (!active) onSwitchTab(tab.id);
              }}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
              className={cn(
                "group/tab relative inline-flex h-6 max-w-[144px] min-w-[84px] shrink-0 items-center",
                "gap-1.5 rounded-md px-2 text-[12px]",
                "transition-colors duration-[120ms] ease-out",
                active ? "text-fg/92" : "text-muted-fg/70 hover:bg-white/[0.04] hover:text-fg/85",
              )}
              title={[ownerTitle, tabUrl ?? label].filter(Boolean).join(" · ")}
            >
              {active ? (
                reduceMotion ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-0 rounded-md bg-white/[0.07]"
                  />
                ) : (
                  <motion.span
                    aria-hidden="true"
                    layoutId={TAB_INDICATOR_LAYOUT_ID}
                    className="absolute inset-0 rounded-md bg-white/[0.07]"
                    transition={TAB_INDICATOR_SPRING}
                  />
                )
              ) : null}
              <button
                type="button"
                tabIndex={-1}
                onClick={() => {
                  if (!active) onSwitchTab(tab.id);
                }}
                className={cn(
                  "relative inline-flex min-w-0 flex-1 items-center gap-1.5 text-left",
                  TOOLBAR_FOCUS,
                )}
              >
                {tab.faviconUrl && !failedFavicons[tab.id] ? (
                  <motion.img
                    key={tab.faviconUrl}
                    src={tab.faviconUrl}
                    alt=""
                    aria-hidden="true"
                    draggable={false}
                    initial={reduceMotion ? false : { opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.12, ease: "easeOut" }}
                    onError={() => setFailedFavicons((previous) => (
                      previous[tab.id] ? previous : { ...previous, [tab.id]: true }
                    ))}
                    className="h-3 w-3 shrink-0 rounded-[2px] object-contain"
                  />
                ) : (
                  <Globe size={12} className={cn("shrink-0", active ? "text-fg/70" : "text-muted-fg/50")} />
                )}
                <span className="min-w-0 truncate leading-none">{label}</span>
                {tab.recording ? (
                  <span
                    aria-label="Recording"
                    title="Recording this tab"
                    className="h-[5px] w-[5px] shrink-0 rounded-full bg-rose-400 shadow-[0_0_0_2.5px_rgba(251,113,133,0.18)]"
                  />
                ) : null}
                {ownerLabel ? (
                  <Robot
                    size={11}
                    weight="duotone"
                    aria-label={ownerTitle ?? undefined}
                    className="shrink-0 text-cyan-200/70"
                  />
                ) : null}
              </button>
              <button
                type="button"
                tabIndex={-1}
                aria-label={`Close ${label}`}
                className={cn(
                  "relative -mr-1 inline-flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px]",
                  "text-muted-fg/45 opacity-0 transition-colors duration-[120ms] ease-out",
                  "hover:bg-white/[0.1] hover:text-fg/85 group-hover/tab:opacity-100 focus-visible:opacity-100",
                  TOOLBAR_FOCUS,
                )}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTab(tab.id);
                }}
              >
                <X size={10} />
              </button>
            </div>
          );
        })}
      </div>
      {fades.start ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 h-full w-6 bg-gradient-to-r from-[var(--color-bg)] to-transparent"
        />
      ) : null}
      {fades.end ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-8 top-0 h-full w-6 bg-gradient-to-l from-[var(--color-bg)] to-transparent"
        />
      ) : null}
      <button
        type="button"
        disabled={Boolean(busy) || !apiAvailable}
        onClick={onNewTab}
        className={cn(
          "mr-2 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
          "text-muted-fg/60 transition-colors duration-[120ms] ease-out hover:bg-white/[0.06] hover:text-fg/85",
          "disabled:cursor-not-allowed disabled:opacity-45",
          TOOLBAR_FOCUS,
        )}
        title="New tab"
        aria-label="New tab"
      >
        <Plus size={12} />
      </button>
    </div>
  );
}
