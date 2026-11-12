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
import { useCallback, useMemo, useState } from "react";
import type { Dispatch, KeyboardEvent, MouseEvent, MutableRefObject, SetStateAction } from "react";
import { ArrowSquareOut, ChatCircleText, Detective, FunnelSimple, Globe, Plus, PushPin, X, XCircle } from "@phosphor-icons/react";
import { motion } from "motion/react";
import { tunnelAwareUrl, type TabTunnelMap } from "../browserRemoteTunnels";
import { browserTabLabel } from "./browserToolbarLabels";
import { cn } from "../../ui/cn";
import { ContextMenu, type ContextMenuEntry, type ContextMenuState } from "../../ui/ContextMenu";
import { TOOLBAR_FOCUS } from "./browserChrome";
import { browserTabGroupKey } from "./browserTabGroups";
import {
  browserTabAutoCloseLabel,
  browserTabOwnerKind,
  buildBrowserTabStripItems,
  type BrowserTabStripItem,
} from "./browserTabOwnership";
import type { BrowserTab } from "./browserPanelTypes";

/** The `layoutId` spring the tools rail uses for its sliding indicator. */
const TAB_INDICATOR_SPRING = { type: "spring", stiffness: 520, damping: 38, mass: 0.7 } as const;
const TAB_INDICATOR_LAYOUT_ID = "ade-browser-tab-indicator";

/**
 * Chrome's tab-group colours, for a chat whose lane has no colour of its own.
 * Picked by the chat id, so a chat keeps its colour for as long as it lives.
 */
const GROUP_HUES = ["#8ab4f8", "#81c995", "#fdd663", "#f28b82", "#c58af9", "#78d9ec", "#fcad70", "#ff8bcb"] as const;

function hueForChat(chatSessionId: string): string {
  let hash = 0;
  for (let index = 0; index < chatSessionId.length; index += 1) {
    hash = (hash * 31 + chatSessionId.charCodeAt(index)) | 0;
  }
  return GROUP_HUES[Math.abs(hash) % GROUP_HUES.length]!;
}

/** What hovering a tab says about who it belongs to. */
function ownerLine(tab: BrowserTab, chatName: string | null): string {
  if (tab.handoff) return `Yours until you hand it back · ${tab.handoff.reason}`;
  const kind = browserTabOwnerKind(tab);
  if (kind === "you") {
    return tab.ownerChatSessionId ? `Your tab · ${chatName ?? "a chat"} is using it` : "Your tab";
  }
  if (kind === "free") return "Opened by an agent · no chat is using it";
  const closing = browserTabAutoCloseLabel(tab.autoCloseAt);
  return [`Opened by ${chatName ?? "an agent"}`, closing].filter(Boolean).join(" · ");
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
  /** Lane color for a chat group. A lane with no colour gets a Chrome group colour. */
  laneColorById?: ReadonlyMap<string, string>;
  /** Chat names for group labels and tooltips; an unknown chat is "Agent". */
  chatNameById?: ReadonlyMap<string, string>;
  /** Right-click → "Attach to chat". Absent where there is no chat to attach to. */
  onAttachTab?: (tabId: string) => void;
  /** Keep an agent's tab: ADE stops counting it down. */
  onKeepTab?: (tabId: string) => void;
  /** Open the chat behind a group. Absent where there is nowhere to open it. */
  onOpenChat?: (chatSessionId: string, laneId: string | null) => void;
  /**
   * The one lane toggle: this lane's tabs (plus your own), or every tab.
   * Absent when there is no lane, or no tab outside it to hide.
   */
  laneFilter?: {
    mode: "lane" | "all";
    /** Tabs the lane view is hiding, shown on the toggle. */
    hiddenCount: number;
    onToggle: () => void;
  } | null;
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
  laneColorById,
  chatNameById,
  onAttachTab,
  onKeepTab,
  onOpenChat,
  laneFilter,
}: BrowserTabStripProps) {
  const [tabMenu, setTabMenu] = useState<(NonNullable<ContextMenuState> & { tabId?: string; chatSessionId?: string }) | null>(null);
  const [collapsedChats, setCollapsedChats] = useState<ReadonlySet<string>>(() => new Set());
  const closeTabMenu = useCallback(() => setTabMenu(null), []);
  const items = useMemo(() => buildBrowserTabStripItems(tabs), [tabs]);
  const chatName = useCallback(
    (chatSessionId: string | null | undefined): string | null => (chatSessionId ? chatNameById?.get(chatSessionId) ?? null : null),
    [chatNameById],
  );
  const groupOf = useCallback(
    (chatSessionId: string) => items.find((item): item is Extract<BrowserTabStripItem<BrowserTab>, { kind: "group" }> => (
      item.kind === "group" && item.chatSessionId === chatSessionId
    )) ?? null,
    [items],
  );
  /** The tabs a person can reach right now: a collapsed group's tabs are folded away. */
  const reachableTabs = useMemo(() => items.flatMap((item) => {
    if (item.kind === "tab") return [item.tab];
    if (collapsedChats.has(item.chatSessionId)) {
      // The active tab never folds away, as in Chrome.
      return item.tabs.filter((tab) => tab.id === activeTabId);
    }
    return item.tabs;
  }), [activeTabId, collapsedChats, items]);

  const menuTab = tabMenu?.tabId ? tabs.find((tab) => tab.id === tabMenu.tabId) ?? null : null;
  const menuChat = tabMenu?.chatSessionId ?? null;
  const tabMenuEntries = useMemo<ContextMenuEntry[]>(() => {
    const entries: ContextMenuEntry[] = [];
    if (menuTab) {
      if (onKeepTab && browserTabOwnerKind(menuTab) !== "you") {
        entries.push({ kind: "item", key: "keep", label: "Keep this tab", icon: PushPin, onSelect: () => onKeepTab(menuTab.id), hint: browserTabAutoCloseLabel(menuTab.autoCloseAt) ?? undefined });
      }
      if (onAttachTab) {
        entries.push({ kind: "item", key: "attach-to-chat", label: "Attach to chat", icon: ChatCircleText, onSelect: () => onAttachTab(menuTab.id) });
      }
      const owningChat = menuTab.ownerChatSessionId ?? menuTab.openedByChatSessionId;
      if (onOpenChat && owningChat) {
        entries.push({ kind: "item", key: "open-chat", label: `Open ${chatName(owningChat) ?? "the chat"}`, icon: ArrowSquareOut, onSelect: () => onOpenChat(owningChat, menuTab.ownerLaneId ?? menuTab.openedByLaneId ?? null) });
      }
      if (entries.length > 0) entries.push({ kind: "separator", key: "sep" });
      entries.push({ kind: "item", key: "close", label: "Close tab", icon: X, onSelect: () => onCloseTab(menuTab.id) });
      return entries;
    }
    if (menuChat) {
      const group = groupOf(menuChat);
      if (!group) return entries;
      if (onOpenChat) {
        entries.push({ kind: "item", key: "open-chat", label: `Open ${chatName(menuChat) ?? "the chat"}`, icon: ArrowSquareOut, onSelect: () => onOpenChat(menuChat, group.laneId) });
      }
      if (onKeepTab) {
        entries.push({ kind: "item", key: "keep-all", label: group.tabs.length === 1 ? "Keep this tab" : `Keep all ${group.tabs.length} tabs`, icon: PushPin, onSelect: () => group.tabs.forEach((tab) => onKeepTab(tab.id)) });
      }
      if (entries.length > 0) entries.push({ kind: "separator", key: "sep" });
      entries.push({ kind: "item", key: "close-group", label: group.tabs.length === 1 ? "Close tab" : `Close ${group.tabs.length} tabs`, icon: XCircle, danger: true, onSelect: () => group.tabs.forEach((tab) => onCloseTab(tab.id)) });
    }
    return entries;
  }, [chatName, groupOf, menuChat, menuTab, onAttachTab, onCloseTab, onKeepTab, onOpenChat]);
  const openMenuAt = (event: MouseEvent<HTMLElement>, target: { tabId?: string; chatSessionId?: string }) => {
    event.preventDefault();
    // The keyboard's menu key reports no pointer, so open under the target.
    const rect = event.currentTarget.getBoundingClientRect();
    const fromKeyboard = event.clientX === 0 && event.clientY === 0;
    setTabMenu({
      x: fromKeyboard ? rect.left : event.clientX,
      y: fromKeyboard ? rect.bottom : event.clientY,
      ...target,
    });
  };
  const toggleGroup = (chatSessionId: string) => {
    setCollapsedChats((current) => {
      const next = new Set(current);
      if (next.has(chatSessionId)) next.delete(chatSessionId);
      else next.add(chatSessionId);
      return next;
    });
  };

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
    const target = reachableTabs[index];
    if (!strip || !target) return;
    const wrappers = strip.querySelectorAll<HTMLElement>('[role="tab"]');
    wrappers.item(index)?.focus();
    if (target.id !== activeTabId) onSwitchTab(target.id);
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const tab = reachableTabs[index];
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
      focusTabAt(reachableTabs.length - 1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (tab.id !== activeTabId) onSwitchTab(tab.id);
    }
  };

  // One tab is not a choice. The title lives in the tool header above, so the
  // strip stays out of the way until there is something to switch between —
  // unless the lane view is hiding tabs, when the strip is how you get them back.
  if (tabs.length <= 1 && !(laneFilter && laneFilter.mode === "lane" && laneFilter.hiddenCount > 0)) return null;

  const renderTab = (tab: BrowserTab, group: { color: string } | null) => {
    const index = reachableTabs.indexOf(tab);
    const active = tab.id === activeTabId;
    // A tunneled tab falls back to the REMOTE origin, never the forward
    // port, when the page has no title of its own.
    const tabUrl = tunnelAwareUrl(tab.url, tabTunnels[tab.id] ?? null) || null;
    const label = browserTabLabel(tab, tabUrl);
    const kind = browserTabOwnerKind(tab);
    const owningChat = tab.ownerChatSessionId ?? tab.openedByChatSessionId;
    const canKeep = Boolean(onKeepTab) && kind !== "you";
    const laneColor = laneColorById?.get(browserTabGroupKey(tab) ?? "") ?? null;
    return (
      <div
        key={tab.id}
        role="tab"
        aria-selected={active}
        tabIndex={active ? 0 : -1}
        data-owner={kind}
        onClick={() => {
          if (!active) onSwitchTab(tab.id);
        }}
        onKeyDown={(event) => handleTabKeyDown(event, Math.max(0, index))}
        onContextMenu={(event) => openMenuAt(event, { tabId: tab.id })}
        className={cn(
          "group/tab relative inline-flex h-6 max-w-[160px] min-w-[84px] shrink-0 items-center",
          "gap-1.5 rounded-md px-2 text-[12px]",
          "transition-colors duration-[120ms] ease-out",
          active ? "text-fg/92" : "text-muted-fg/70 hover:bg-fg/[0.04] hover:text-fg/85",
        )}
        // A lane's own tab outside any chat group keeps the lane outline it had.
        style={!group && laneColor ? { boxShadow: `inset 0 0 0 1px ${laneColor}` } : undefined}
        title={[
          ownerLine(tab, chatName(owningChat)),
          tab.isolatedProfile ? `Separate sign-in "${tab.isolatedProfile}" · not your cookies` : null,
          tab.sleeping ? "Asleep to save memory · loads again when you open it" : null,
          tabUrl ?? label,
        ].filter(Boolean).join("\n")}
      >
        {active ? (
          reduceMotion ? (
            <span aria-hidden="true" className="absolute inset-0 rounded-md bg-fg/[0.07]" />
          ) : (
            <motion.span
              aria-hidden="true"
              layoutId={TAB_INDICATOR_LAYOUT_ID}
              className="absolute inset-0 rounded-md bg-fg/[0.07]"
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
          className={cn("relative inline-flex min-w-0 flex-1 items-center gap-1.5 text-left", TOOLBAR_FOCUS)}
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
          <span className={cn("min-w-0 truncate leading-none", tab.sleeping && !active ? "opacity-60" : null)}>{label}</span>
          {tab.recording ? (
            <span
              aria-label="Recording"
              title="Recording this tab"
              className="h-[5px] w-[5px] shrink-0 rounded-full bg-rose-400 shadow-[0_0_0_2.5px_rgba(251,113,133,0.18)]"
            />
          ) : null}
          {tab.isolatedProfile ? (
            <Detective
              size={11}
              weight="duotone"
              aria-label={`Separate sign-in "${tab.isolatedProfile}"`}
              className="shrink-0 text-violet-200/70"
            />
          ) : null}
        </button>
        {canKeep ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={`Keep ${label}`}
            title="Keep this tab: ADE won't close it"
            data-testid="browser-tab-keep"
            className={cn(
              "relative inline-flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px]",
              "text-muted-fg/45 opacity-0 transition-colors duration-[120ms] ease-out",
              "hover:bg-fg/[0.1] hover:text-fg/85 group-hover/tab:opacity-100 focus-visible:opacity-100",
              TOOLBAR_FOCUS,
            )}
            onClick={(event) => {
              event.stopPropagation();
              onKeepTab?.(tab.id);
            }}
          >
            <PushPin size={10} />
          </button>
        ) : null}
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Close ${label}`}
          className={cn(
            "relative -mr-1 inline-flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px]",
            "text-muted-fg/45 opacity-0 transition-colors duration-[120ms] ease-out",
            "hover:bg-fg/[0.1] hover:text-fg/85 group-hover/tab:opacity-100 focus-visible:opacity-100",
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
  };

  const renderGroup = (group: Extract<BrowserTabStripItem<BrowserTab>, { kind: "group" }>) => {
    const color = (group.laneId ? laneColorById?.get(group.laneId) : null) ?? hueForChat(group.chatSessionId);
    const name = chatName(group.chatSessionId) ?? "Agent";
    const collapsed = collapsedChats.has(group.chatSessionId);
    const shown = collapsed ? group.tabs.filter((tab) => tab.id === activeTabId) : group.tabs;
    const closing = group.tabs.map((tab) => browserTabAutoCloseLabel(tab.autoCloseAt)).find(Boolean) ?? null;
    return (
      <div
        key={`group:${group.chatSessionId}`}
        role="group"
        aria-label={`${name}'s tabs`}
        data-testid="browser-tab-group"
        className="relative inline-flex shrink-0 items-center gap-1 pb-[3px]"
      >
        {/* Chrome's group label: the chat's name in its colour. A click folds
            the group away; right-click opens it, keeps it, or closes it. */}
        <button
          type="button"
          tabIndex={-1}
          onClick={() => toggleGroup(group.chatSessionId)}
          onContextMenu={(event) => openMenuAt(event, { chatSessionId: group.chatSessionId })}
          className={cn(
            "inline-flex h-[18px] max-w-[132px] shrink-0 items-center gap-1 rounded-[5px] px-1.5",
            "text-[11px] font-medium leading-none transition-[filter] duration-[120ms] ease-out hover:brightness-110",
            TOOLBAR_FOCUS,
          )}
          style={{
            background: `color-mix(in srgb, ${color} 22%, transparent)`,
            color: `color-mix(in srgb, ${color} 80%, var(--color-fg))`,
          }}
          title={[
            `Opened by ${name}`,
            closing ?? (group.tabs.length === 1 ? "Closes 15 min after the chat goes idle" : "These close 15 min after the chat goes idle"),
            collapsed ? "Click to show" : "Click to fold away",
          ].join("\n")}
          aria-expanded={!collapsed}
        >
          <span className="min-w-0 truncate">{name}</span>
          {collapsed ? <span className="shrink-0 opacity-70">{group.tabs.length}</span> : null}
        </button>
        {shown.map((tab) => renderTab(tab, { color }))}
        {/* The line under the group, as in Chrome: one colour from label to last tab. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0.5 bottom-0 h-[2px] rounded-full"
          style={{ background: color, opacity: 0.85 }}
        />
      </div>
    );
  };

  return (
    <div className="relative flex h-[32px] min-w-0 shrink-0 select-none items-center overflow-hidden">
      <div
        ref={stripRef}
        onScroll={onScroll}
        role="tablist"
        aria-label="ADE browser tabs"
        className="scrollbar-none flex min-w-0 flex-1 flex-nowrap items-center gap-1 overflow-x-auto px-2"
      >
        {items.map((item) => (item.kind === "tab" ? renderTab(item.tab, null) : renderGroup(item)))}
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
          className={cn(
            "pointer-events-none absolute top-0 h-full w-6 bg-gradient-to-l from-[var(--color-bg)] to-transparent",
            laneFilter ? "right-[92px]" : "right-8",
          )}
        />
      ) : null}
      {laneFilter ? (
        <button
          type="button"
          onClick={laneFilter.onToggle}
          data-testid="browser-lane-filter"
          aria-pressed={laneFilter.mode === "lane"}
          className={cn(
            "mr-0.5 inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px]",
            "transition-colors duration-[120ms] ease-out hover:bg-fg/[0.06]",
            laneFilter.mode === "lane" ? "text-[var(--color-accent)]" : "text-muted-fg/70 hover:text-fg/85",
            TOOLBAR_FOCUS,
          )}
          title={laneFilter.mode === "lane"
            ? `Showing this lane's tabs and your own${laneFilter.hiddenCount > 0 ? ` · ${laneFilter.hiddenCount} more in other lanes` : ""}. Click to show every tab.`
            : "Showing every tab. Click to show only this lane's tabs and your own."}
        >
          <FunnelSimple size={11} weight={laneFilter.mode === "lane" ? "fill" : "regular"} />
          <span>{laneFilter.mode === "lane" ? "This lane" : "All tabs"}</span>
          {laneFilter.mode === "lane" && laneFilter.hiddenCount > 0 ? (
            <span className="rounded-full bg-fg/[0.08] px-1 text-[10px] leading-[14px] text-muted-fg/80">+{laneFilter.hiddenCount}</span>
          ) : null}
        </button>
      ) : null}
      <button
        type="button"
        disabled={Boolean(busy) || !apiAvailable}
        onClick={onNewTab}
        className={cn(
          "mr-2 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
          "text-muted-fg/60 transition-colors duration-[120ms] ease-out hover:bg-fg/[0.06] hover:text-fg/85",
          "disabled:cursor-not-allowed disabled:opacity-45",
          TOOLBAR_FOCUS,
        )}
        title="New tab"
        aria-label="New tab"
      >
        <Plus size={12} />
      </button>
      {/* Portaled: the strip sits over a native page view, and the menu has to
          land under the pointer and be seen by the view's occlusion pass. */}
      <ContextMenu
        menu={tabMenu && tabMenuEntries.length > 0 ? tabMenu : null}
        entries={tabMenuEntries}
        onClose={closeTabMenu}
        label="Browser tab actions"
        portal
      />
    </div>
  );
}
