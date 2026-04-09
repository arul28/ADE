import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import { Terminal as TerminalIcon, Plus, X } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import type { PtyExitEvent } from "../../../shared/types";
import { TerminalView } from "../terminals/TerminalView";

type ChatTerminalDrawerProps = {
  open: boolean;
  onToggle: () => void;
  laneId: string;
};

type TabEntry = {
  id: string;
  ptyId: string;
  sessionId: string;
  label: string;
  exited: boolean;
};

let nextTabIndex = 1;

export const ChatTerminalDrawer = memo(function ChatTerminalDrawer({
  open,
  onToggle,
  laneId,
}: ChatTerminalDrawerProps) {
  const [tabs, setTabs] = useState<TabEntry[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [drawerHeight, setDrawerHeight] = useState(300);
  const [creatingTab, setCreatingTab] = useState(false);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const hadTabsRef = useRef(false);
  const tabsRef = useRef<TabEntry[]>([]);

  tabsRef.current = tabs;

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startHeight: drawerHeight };

    const handleDragMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = dragRef.current.startY - ev.clientY;
      const nextHeight = Math.max(150, Math.min(600, dragRef.current.startHeight + delta));
      setDrawerHeight(nextHeight);
    };

    const handleDragEnd = () => {
      dragRef.current = null;
      document.removeEventListener("mousemove", handleDragMove);
      document.removeEventListener("mouseup", handleDragEnd);
    };

    document.addEventListener("mousemove", handleDragMove);
    document.addEventListener("mouseup", handleDragEnd);
  }, [drawerHeight]);

  const createTab = useCallback(async () => {
    if (creatingTab) return;
    setCreatingTab(true);
    try {
      const tabIndex = nextTabIndex++;
      const label = `Terminal ${tabIndex}`;
      const tabId = `chat-term-${Date.now()}-${tabIndex}`;
      const created = await window.ade.pty.create({
        laneId,
        cols: 80,
        rows: 24,
        title: label,
        tracked: false,
        toolType: "shell",
      });

      const nextEntry: TabEntry = {
        id: tabId,
        ptyId: created.ptyId,
        sessionId: created.sessionId,
        label,
        exited: false,
      };

      setTabs((prev) => [...prev, nextEntry]);
      setActiveTabId(tabId);
    } finally {
      setCreatingTab(false);
    }
  }, [creatingTab, laneId]);

  useEffect(() => {
    if (!open || creatingTab || tabs.length > 0) return;
    void createTab();
  }, [createTab, creatingTab, open, tabs.length]);

  useEffect(() => {
    if (tabs.length > 0) {
      hadTabsRef.current = true;
      return;
    }
    if (!open || creatingTab || !hadTabsRef.current) return;
    hadTabsRef.current = false;
    onToggle();
  }, [creatingTab, onToggle, open, tabs.length]);

  useEffect(() => {
    const unsubscribe = window.ade.pty.onExit((ev: PtyExitEvent) => {
      setTabs((prev) => prev.map((tab) => (
        tab.ptyId === ev.ptyId
          ? { ...tab, exited: true }
          : tab
      )));
    });
    return unsubscribe;
  }, []);

  const closeTab = useCallback((tabId: string) => {
    const entry = tabsRef.current.find((tab) => tab.id === tabId);
    if (entry) {
      window.ade.pty.dispose({ ptyId: entry.ptyId, sessionId: entry.sessionId }).catch(() => {});
    }

    setTabs((prev) => {
      const next = prev.filter((tab) => tab.id !== tabId);
      setActiveTabId((current) => {
        if (current !== tabId) return current;
        return next.length > 0 ? next[next.length - 1].id : null;
      });
      return next;
    });
  }, []);

  useEffect(() => {
    return () => {
      for (const tab of tabsRef.current) {
        window.ade.pty.dispose({ ptyId: tab.ptyId, sessionId: tab.sessionId }).catch(() => {});
      }
    };
  }, []);

  if (!open) return null;

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs.at(-1) ?? null;

  return (
    <div
      className="flex flex-col border-t border-white/[0.06] bg-[var(--color-surface-recessed)] shadow-[inset_0_2px_8px_rgba(0,0,0,0.3)]"
      style={{ height: drawerHeight }}
    >
      <div
        className="flex h-2 cursor-row-resize items-center justify-center transition-colors hover:bg-white/[0.04]"
        onMouseDown={handleDragStart}
      >
        <div className="h-0.5 w-8 rounded-full bg-white/[0.12]" />
      </div>

      <div className="flex h-6 shrink-0 items-center overflow-x-auto border-b border-white/[0.06] bg-black/10">
        <div className="flex min-w-0 items-center gap-0 overflow-x-auto scrollbar-none">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTabId(tab.id)}
              className={cn(
                "group flex h-6 shrink-0 items-center gap-1 border-r border-white/[0.04] px-2 font-mono text-[10px] transition-colors",
                activeTab?.id === tab.id
                  ? "border-b-2 border-b-[var(--color-accent)] bg-white/[0.06] text-fg/85"
                  : "bg-transparent text-fg/35 hover:bg-white/[0.03] hover:text-fg/60",
              )}
            >
              <TerminalIcon
                size={10}
                weight="bold"
                className={tab.exited ? "shrink-0 text-red-400/60" : "shrink-0 text-white/30"}
              />
              <span className="max-w-[80px] truncate">{tab.label}</span>
              <span
                role="button"
                tabIndex={-1}
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.stopPropagation();
                    closeTab(tab.id);
                  }
                }}
                className="ml-0.5 text-white/30 opacity-0 transition-opacity group-hover:opacity-100 hover:text-white/60"
              >
                <X size={8} weight="bold" />
              </span>
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => { void createTab(); }}
          className="mx-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-white/[0.06] text-white/30 transition-colors hover:bg-white/[0.04] hover:text-white/60"
          title="New terminal"
          disabled={creatingTab}
        >
          <Plus size={10} weight="bold" />
        </button>

        <div className="flex-1" />
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab ? (
          <TerminalView
            ptyId={activeTab.ptyId}
            sessionId={activeTab.sessionId}
            isActive
            isVisible
            className="h-full w-full"
          />
        ) : (
          <div className="flex h-full items-center justify-center px-4 font-mono text-[11px] text-muted-fg">
            Create a terminal to start working in this chat.
          </div>
        )}
      </div>
    </div>
  );
});

type ChatTerminalToggleProps = {
  open: boolean;
  onToggle: () => void;
};

export const ChatTerminalToggle = memo(function ChatTerminalToggle({
  open,
  onToggle,
}: ChatTerminalToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 font-sans text-[10px] font-medium transition-all",
        open
          ? "border-violet-400/20 bg-violet-500/[0.08] text-violet-200/80"
          : "border-white/[0.08] bg-white/[0.03] text-fg/45 hover:border-white/[0.12] hover:text-fg/65",
      )}
      title={open ? "Close terminal" : "Open terminal"}
    >
      <TerminalIcon size={12} weight={open ? "fill" : "regular"} />
      <span>Terminal</span>
    </button>
  );
});
