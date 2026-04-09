import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import { Terminal as TerminalIcon, Plus, X } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import type { PtyDataEvent, PtyExitEvent } from "../../../shared/types";

import "@xterm/xterm/css/xterm.css";

/* ── Types ── */

type ChatTerminalDrawerProps = {
  open: boolean;
  onToggle: () => void;
  laneId: string;
  sessionId?: string;
};

type TabEntry = {
  id: string;
  ptyId: string;
  label: string;
  exited: boolean;
};

/* ── Lazy xterm loader ── */

type XtermModules = {
  Terminal: typeof import("@xterm/xterm").Terminal;
  FitAddon: typeof import("@xterm/addon-fit").FitAddon;
};

let xtermCache: Promise<XtermModules> | null = null;

function loadXterm(): Promise<XtermModules> {
  if (!xtermCache) {
    xtermCache = Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
    ]).then(([xtermMod, fitMod]) => ({
      Terminal: xtermMod.Terminal,
      FitAddon: fitMod.FitAddon,
    }));
  }
  return xtermCache;
}

/* ── Constants ── */

const TERM_THEME = {
  background: "#0A090E",
  foreground: "#E8E8ED",
  cursor: "#A78BFA",
  cursorAccent: "#0A090E",
  selectionBackground: "rgba(167, 139, 250, 0.22)",
};

let nextTabIndex = 1;

/* ── Main drawer ── */

export const ChatTerminalDrawer = memo(function ChatTerminalDrawer({
  open,
  onToggle,
  laneId,
  sessionId,
}: ChatTerminalDrawerProps) {
  const [tabs, setTabs] = useState<TabEntry[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [drawerHeight, setDrawerHeight] = useState(300);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startHeight: drawerHeight };

    const handleDragMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = dragRef.current.startY - ev.clientY;
      const newHeight = Math.max(150, Math.min(600, dragRef.current.startHeight + delta));
      setDrawerHeight(newHeight);
    };

    const handleDragEnd = () => {
      dragRef.current = null;
      document.removeEventListener("mousemove", handleDragMove);
      document.removeEventListener("mouseup", handleDragEnd);
    };

    document.addEventListener("mousemove", handleDragMove);
    document.addEventListener("mouseup", handleDragEnd);
  }, [drawerHeight]);

  /* Refs per-tab: terminal instance, fit addon, container, pty unsubs */
  const terminalsRef = useRef<
    Map<
      string,
      {
        term: InstanceType<XtermModules["Terminal"]>;
        fit: InstanceType<XtermModules["FitAddon"]>;
        container: HTMLDivElement;
        unsubData: (() => void) | null;
        unsubExit: (() => void) | null;
        disposed: boolean;
      }
    >
  >(new Map());

  const containerRef = useRef<HTMLDivElement>(null);
  const hasCreatedInitial = useRef(false);

  /* ── Create a new terminal tab ── */
  const createTab = useCallback(async () => {
    const mods = await loadXterm();

    const tabId = `chat-term-${Date.now()}-${nextTabIndex++}`;
    const label = `Terminal ${tabs.length + 1}`;

    /* Create PTY */
    const ptyResult = await window.ade.pty.create({
      laneId,
      cols: 80,
      rows: 24,
      title: label,
      tracked: false,
    });

    const entry: TabEntry = {
      id: tabId,
      ptyId: ptyResult.ptyId,
      label,
      exited: false,
    };

    /* Create xterm instance */
    const term = new mods.Terminal({
      fontFamily: "var(--font-mono)",
      fontSize: 11,
      lineHeight: 1.3,
      cursorBlink: true,
      allowTransparency: true,
      theme: TERM_THEME,
      scrollback: 5000,
    });

    const fit = new mods.FitAddon();
    term.loadAddon(fit);

    /* Create host container */
    const host = document.createElement("div");
    host.style.width = "100%";
    host.style.height = "100%";
    host.dataset.termTabId = tabId;

    /* PTY data -> terminal */
    const unsubData = window.ade.pty.onData((ev: PtyDataEvent) => {
      if (ev.ptyId !== ptyResult.ptyId) return;
      try {
        term.write(ev.data);
      } catch {
        /* ignore writes after disposal */
      }
    });

    /* PTY exit */
    const unsubExit = window.ade.pty.onExit((ev: PtyExitEvent) => {
      if (ev.ptyId !== ptyResult.ptyId) return;
      setTabs((prev) =>
        prev.map((t) => (t.id === tabId ? { ...t, exited: true } : t)),
      );
    });

    /* Terminal input -> PTY */
    term.onData((data) => {
      window.ade.pty.write({ ptyId: ptyResult.ptyId, data }).catch(() => {});
    });

    terminalsRef.current.set(tabId, {
      term,
      fit,
      container: host,
      unsubData,
      unsubExit,
      disposed: false,
    });

    setTabs((prev) => [...prev, entry]);
    setActiveTabId(tabId);

    /* Defer open + fit until the host is mounted */
    requestAnimationFrame(() => {
      if (!host.isConnected) return;
      term.open(host);
      try {
        fit.fit();
      } catch {
        /* ignore initial fit failures */
      }
      const dims = { cols: term.cols, rows: term.rows };
      if (dims.cols > 0 && dims.rows > 0) {
        window.ade.pty
          .resize({ ptyId: ptyResult.ptyId, cols: dims.cols, rows: dims.rows })
          .catch(() => {});
      }
    });
  }, [laneId, tabs.length]);

  /* ── Lazy-create first terminal on open ── */
  useEffect(() => {
    if (!open || hasCreatedInitial.current) return;
    hasCreatedInitial.current = true;
    createTab();
  }, [open, createTab]);

  /* ── Close a tab ── */
  const closeTab = useCallback(
    (tabId: string) => {
      const entry = tabs.find((t) => t.id === tabId);
      const runtime = terminalsRef.current.get(tabId);

      if (entry && !runtime?.disposed) {
        window.ade.pty
          .dispose({ ptyId: entry.ptyId, sessionId })
          .catch(() => {});
      }

      if (runtime) {
        runtime.unsubData?.();
        runtime.unsubExit?.();
        try {
          runtime.term.dispose();
        } catch {
          /* ignore */
        }
        runtime.disposed = true;
        terminalsRef.current.delete(tabId);
      }

      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== tabId);
        if (activeTabId === tabId) {
          setActiveTabId(next.length > 0 ? next[next.length - 1].id : null);
        }
        if (next.length === 0) {
          onToggle();
        }
        return next;
      });
    },
    [tabs, activeTabId, sessionId, onToggle],
  );

  /* ── Mount / unmount active terminal container ── */
  useEffect(() => {
    if (!activeTabId || !containerRef.current) return;
    const runtime = terminalsRef.current.get(activeTabId);
    if (!runtime || runtime.disposed) return;

    const wrapper = containerRef.current;

    /* Detach all other terminal hosts */
    for (const [id, rt] of terminalsRef.current) {
      if (id !== activeTabId && rt.container.parentElement === wrapper) {
        wrapper.removeChild(rt.container);
      }
    }

    /* Attach active host */
    if (runtime.container.parentElement !== wrapper) {
      wrapper.appendChild(runtime.container);
    }

    /* Open terminal into DOM if not yet opened */
    if (!runtime.container.querySelector(".xterm")) {
      runtime.term.open(runtime.container);
    }

    /* Fit to container */
    requestAnimationFrame(() => {
      try {
        runtime.fit.fit();
      } catch {
        /* ignore */
      }
    });
  }, [activeTabId]);

  /* ── ResizeObserver to auto-fit ── */
  useEffect(() => {
    if (!open || !containerRef.current) return;

    const observer = new ResizeObserver(() => {
      if (!activeTabId) return;
      const runtime = terminalsRef.current.get(activeTabId);
      if (!runtime || runtime.disposed) return;
      try {
        runtime.fit.fit();
      } catch {
        /* ignore */
      }

      const tab = tabs.find((t) => t.id === activeTabId);
      if (tab) {
        const dims = { cols: runtime.term.cols, rows: runtime.term.rows };
        if (dims.cols > 0 && dims.rows > 0) {
          window.ade.pty
            .resize({ ptyId: tab.ptyId, cols: dims.cols, rows: dims.rows })
            .catch(() => {});
        }
      }
    });

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [open, activeTabId, tabs]);

  /* ── Re-fit terminals when drawer height changes ── */
  useEffect(() => {
    if (!open) return;
    for (const [, entry] of terminalsRef.current) {
      if (!entry.disposed) {
        try { entry.fit.fit(); } catch { /* ignore */ }
      }
    }
  }, [drawerHeight, open]);

  /* ── Cleanup all PTYs on unmount ── */
  useEffect(() => {
    return () => {
      for (const [, runtime] of terminalsRef.current) {
        if (runtime.disposed) continue;
        runtime.unsubData?.();
        runtime.unsubExit?.();
        try {
          runtime.term.dispose();
        } catch {
          /* ignore */
        }
        runtime.disposed = true;
      }
      /* Dispose PTYs */
      for (const tab of tabs) {
        window.ade.pty
          .dispose({ ptyId: tab.ptyId, sessionId })
          .catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!open) return null;

  return (
    <div className="flex flex-col bg-[#0A090E] border-t border-white/[0.06] shadow-[inset_0_2px_8px_rgba(0,0,0,0.3)]" style={{ height: drawerHeight }}>
      {/* Resize handle */}
      <div
        className="flex h-2 cursor-row-resize items-center justify-center hover:bg-white/[0.04] transition-colors"
        onMouseDown={handleDragStart}
      >
        <div className="h-0.5 w-8 rounded-full bg-white/[0.12]" />
      </div>
      {/* Tab bar */}
      <div className="flex items-center h-6 shrink-0 border-b border-white/[0.06] bg-[#0D0B12]/80 overflow-x-auto">
        <div className="flex items-center gap-0 min-w-0 overflow-x-auto scrollbar-none">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTabId(tab.id)}
              className={cn(
                "group flex items-center gap-1 px-2 h-6 font-mono text-[10px] shrink-0 transition-colors border-r border-white/[0.04]",
                activeTabId === tab.id
                  ? "bg-white/[0.06] border-b-2 border-b-violet-400/40 text-fg/80"
                  : "bg-transparent text-fg/35 hover:text-fg/55 hover:bg-white/[0.03]",
              )}
            >
              <TerminalIcon
                size={10}
                weight="bold"
                className={cn(
                  "shrink-0",
                  tab.exited ? "text-red-400/60" : "text-white/30",
                )}
              />
              <span className="truncate max-w-[80px]">{tab.label}</span>
              <span
                role="button"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }
                }}
                className="ml-0.5 opacity-0 group-hover:opacity-100 text-white/30 hover:text-white/60 transition-opacity"
              >
                <X size={8} weight="bold" />
              </span>
            </button>
          ))}
        </div>

        {/* Add tab button */}
        <button
          type="button"
          onClick={createTab}
          className="flex items-center justify-center w-6 h-6 shrink-0 border border-white/[0.06] rounded-md text-white/30 hover:text-white/60 hover:bg-white/[0.04] transition-colors mx-1"
          title="New terminal"
        >
          <Plus size={10} weight="bold" />
        </button>

        {/* Spacer */}
        <div className="flex-1" />
      </div>

      {/* Terminal viewport */}
      <div ref={containerRef} className="flex-1 min-h-0 overflow-hidden" />
    </div>
  );
});

/* ── Toggle button (for parent to embed in chat header) ── */

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
