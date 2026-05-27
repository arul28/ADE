import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import { Terminal as TerminalIcon, Plus, X } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import type { AppControlSession, ChatTerminalSession, PtyExitEvent } from "../../../shared/types";
import { TerminalView } from "../terminals/TerminalView";

type AppControlTabState = {
  terminalSessionId: string;
  tone: "active" | "warn" | "error";
  title: string;
};

function deriveAppControlTabState(session: AppControlSession | null): AppControlTabState | null {
  if (!session?.terminalSessionId) return null;
  const lostConnection = session.status === "running" && Boolean(session.connectedAt) && !session.cdpEndpoint;
  if (session.status === "connected") {
    return { terminalSessionId: session.terminalSessionId, tone: "active", title: `App Control connected · ${session.label}` };
  }
  if (session.status === "starting" || (session.status === "running" && !lostConnection)) {
    return { terminalSessionId: session.terminalSessionId, tone: "warn", title: `App Control launching · ${session.label}` };
  }
  if (session.status === "exited" || session.status === "stopped" || session.status === "failed" || lostConnection) {
    return {
      terminalSessionId: session.terminalSessionId,
      tone: "error",
      title: lostConnection
        ? `App Control disconnected · ${session.lastError ?? "app may have quit"}`
        : `App Control ${session.status}`,
    };
  }
  return null;
}

function tabIconColorClass(exited: boolean, appControlTone: AppControlTabState["tone"] | null): string {
  if (exited) return "text-red-400/60";
  switch (appControlTone) {
    case "active":
      return "text-emerald-300/85";
    case "warn":
      return "text-amber-200/80";
    case "error":
      return "text-rose-300/80";
    default:
      return "text-white/30";
  }
}

type ChatTerminalDrawerProps = {
  open: boolean;
  onToggle: () => void;
  laneId: string;
  chatSessionId?: string | null;
  autoCreateOnOpen?: boolean;
  createRequestNonce?: number;
  disposeTabsOnUnmount?: boolean;
  emptyMessage?: string;
  onCreateError?: (message: string) => void;
  revealRequest?: {
    terminalId: string;
    ptyId: string;
    label: string;
    nonce: number;
  } | null;
};

type TabEntry = {
  id: string;
  ptyId: string;
  sessionId: string;
  label: string;
  exited: boolean;
};

type DrawerUiState = {
  height: number;
  activeTerminalId: string | null;
};

let nextTabIndex = 1;
const drawerUiStateByKey = new Map<string, DrawerUiState>();

function drawerStateKey(chatSessionId: string | null | undefined, laneId: string): string {
  return chatSessionId ? `chat:${chatSessionId}` : `lane:${laneId}`;
}

function readDrawerUiState(key: string): DrawerUiState {
  const cached = drawerUiStateByKey.get(key);
  if (cached) return cached;
  try {
    const raw = window.sessionStorage.getItem(`ade.chat.terminalDrawer.${key}`);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DrawerUiState>;
      const state = {
        height: typeof parsed.height === "number" && Number.isFinite(parsed.height)
          ? Math.max(150, parsed.height)
          : 300,
        activeTerminalId: typeof parsed.activeTerminalId === "string" ? parsed.activeTerminalId : null,
      };
      drawerUiStateByKey.set(key, state);
      return state;
    }
  } catch {
    // Best-effort UI state only.
  }
  return { height: 300, activeTerminalId: null };
}

function writeDrawerUiState(key: string, state: DrawerUiState): void {
  drawerUiStateByKey.set(key, state);
  try {
    window.sessionStorage.setItem(`ade.chat.terminalDrawer.${key}`, JSON.stringify(state));
  } catch {
    // Best-effort UI state only.
  }
}

function tabFromTerminal(session: ChatTerminalSession): TabEntry | null {
  if (!session.ptyId) return null;
  return {
    id: `chat-term-${session.terminalId}`,
    ptyId: session.ptyId,
    sessionId: session.terminalId,
    label: session.title || "Terminal",
    exited: session.status !== "running",
  };
}

export const ChatTerminalDrawer = memo(function ChatTerminalDrawer({
  open,
  onToggle,
  laneId,
  chatSessionId,
  autoCreateOnOpen = true,
  createRequestNonce = 0,
  disposeTabsOnUnmount = false,
  emptyMessage = "Create a terminal to start working in this chat.",
  onCreateError,
  revealRequest,
}: ChatTerminalDrawerProps) {
  const uiStateKey = drawerStateKey(chatSessionId, laneId);
  const [tabs, setTabs] = useState<TabEntry[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [drawerHeight, setDrawerHeight] = useState(() => readDrawerUiState(uiStateKey).height);
  const [creatingTab, setCreatingTab] = useState(false);
  const [restoringTabs, setRestoringTabs] = useState(false);
  const [appControlTabState, setAppControlTabState] = useState<AppControlTabState | null>(null);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const hadTabsRef = useRef(false);
  const previousOpenRef = useRef(open);
  const pendingAutoCreateRef = useRef(false);
  const tabsRef = useRef<TabEntry[]>([]);
  const restoringUiStateRef = useRef(false);
  const lastHandledCreateRequestRef = useRef(0);
  const createRequestHandledThisOpenRef = useRef(false);
  const revealHandledThisOpenRef = useRef(false);
  // revealRequest is edge-triggered (the parent re-uses the same prop slot
  // across renders). Track the (chatKey, nonce) we've already applied so a
  // stale request from a previous chat doesn't keep blocking the new chat's
  // auto-create path.
  const lastHandledRevealRef = useRef<{ chatKey: string; nonce: number } | null>(null);

  tabsRef.current = tabs;

  const reportCreateError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    onCreateError?.(message);
  }, [onCreateError]);

  useEffect(() => {
    restoringUiStateRef.current = true;
    previousOpenRef.current = open;
    pendingAutoCreateRef.current = false;
    hadTabsRef.current = false;
    setDrawerHeight(readDrawerUiState(uiStateKey).height);
    setTabs([]);
    setActiveTabId(null);
    if (!chatSessionId) restoringUiStateRef.current = false;
  }, [chatSessionId, uiStateKey]);

  useEffect(() => {
    if (restoringUiStateRef.current) return;
    const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
    writeDrawerUiState(uiStateKey, {
      height: drawerHeight,
      activeTerminalId: activeTab?.sessionId ?? null,
    });
  }, [activeTabId, drawerHeight, tabs, uiStateKey]);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startHeight: drawerHeight };

    const handleDragMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = dragRef.current.startY - ev.clientY;
      // Cap to viewport height minus a small reserved strip so the chat
      // header is still grabbable; floor stays at 150 so a single line
      // is always visible.
      const maxHeight = Math.max(200, window.innerHeight - 80);
      const nextHeight = Math.max(150, Math.min(maxHeight, dragRef.current.startHeight + delta));
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
        chatSessionId,
        cols: 80,
        rows: 24,
        title: label,
        tracked: true,
        toolType: "shell",
      });

      const nextEntry: TabEntry = {
        id: tabId,
        ptyId: created.ptyId,
        sessionId: created.sessionId,
        label,
        exited: false,
      };

      const existing = tabs.find(
        (tab) => tab.sessionId === created.sessionId || tab.ptyId === created.ptyId,
      );
      setActiveTabId(existing?.id ?? tabId);
      if (!existing) setTabs((prev) => [...prev, nextEntry]);
    } catch (error) {
      reportCreateError(error);
    } finally {
      setCreatingTab(false);
    }
  }, [chatSessionId, creatingTab, laneId, reportCreateError, tabs]);

  useEffect(() => {
    if (!chatSessionId) return;
    let cancelled = false;
    setRestoringTabs(true);
    window.ade.terminal.list({ chatSessionId, limit: 20 })
      .then((sessions) => {
        if (cancelled) return;
        const restored = sessions
          .map(tabFromTerminal)
          .filter((tab): tab is TabEntry => tab != null)
          .sort((a, b) => Number(a.exited) - Number(b.exited));
        if (!restored.length) return;
        setTabs((prev) => {
          const restoredBySessionId = new Map(restored.map((tab) => [tab.sessionId, tab]));
          const next = prev.map((tab) => restoredBySessionId.get(tab.sessionId) ?? tab);
          const existingSessionIds = new Set(next.map((tab) => tab.sessionId));
          for (const tab of restored) {
            if (!existingSessionIds.has(tab.sessionId)) next.push(tab);
          }
          return next;
        });
        const savedActiveId = readDrawerUiState(uiStateKey).activeTerminalId;
        const active = restored.find((tab) => tab.sessionId === savedActiveId)
          ?? restored.find((tab) => !tab.exited)
          ?? restored[0]
          ?? null;
        if (active) setActiveTabId((current) => current ?? active.id);
      })
      .finally(() => {
        if (!cancelled) {
          setRestoringTabs(false);
          restoringUiStateRef.current = false;
        }
      });
    return () => {
      cancelled = true;
    };
  }, [chatSessionId, uiStateKey]);

  useEffect(() => {
    if (!revealRequest) return;
    const last = lastHandledRevealRef.current;
    if (last && last.chatKey === uiStateKey && last.nonce === revealRequest.nonce) {
      // Already handled this exact request — treat subsequent renders with
      // the same revealRequest in props as no-ops.
      return;
    }
    lastHandledRevealRef.current = { chatKey: uiStateKey, nonce: revealRequest.nonce };
    const existing = tabsRef.current.find(
      (tab) => tab.sessionId === revealRequest.terminalId || tab.ptyId === revealRequest.ptyId,
    );
    if (existing) {
      setActiveTabId(existing.id);
      revealHandledThisOpenRef.current = true;
      return;
    }
    const tabId = `chat-term-${revealRequest.terminalId}`;
    const nextEntry: TabEntry = {
      id: tabId,
      ptyId: revealRequest.ptyId,
      sessionId: revealRequest.terminalId,
      label: revealRequest.label || "App Control",
      exited: false,
    };
    setTabs((prev) => [...prev, nextEntry]);
    setActiveTabId(tabId);
    revealHandledThisOpenRef.current = true;
  }, [revealRequest, uiStateKey]);

  useEffect(() => {
    if (!open || creatingTab || createRequestNonce <= 0 || lastHandledCreateRequestRef.current === createRequestNonce) return;
    lastHandledCreateRequestRef.current = createRequestNonce;
    pendingAutoCreateRef.current = false;
    createRequestHandledThisOpenRef.current = true;
    void createTab();
  }, [createRequestNonce, createTab, creatingTab, open]);

  useEffect(() => {
    const wasOpen = previousOpenRef.current;
    previousOpenRef.current = open;

    if (!open) {
      pendingAutoCreateRef.current = false;
      return;
    }

    if (!wasOpen) pendingAutoCreateRef.current = true;
    if (createRequestHandledThisOpenRef.current) {
      createRequestHandledThisOpenRef.current = false;
      pendingAutoCreateRef.current = false;
      return;
    }
    if (revealHandledThisOpenRef.current) {
      revealHandledThisOpenRef.current = false;
      pendingAutoCreateRef.current = false;
      return;
    }
    // Treat already-consumed reveal requests as null so switching chats with
    // a stale revealRequest in props doesn't block auto-create on the new
    // drawer.
    const last = lastHandledRevealRef.current;
    const revealActive = revealRequest != null
      && !(last && last.chatKey === uiStateKey && last.nonce === revealRequest.nonce);
    if (!autoCreateOnOpen || revealActive || tabs.length > 0) {
      pendingAutoCreateRef.current = false;
      return;
    }
    if (!pendingAutoCreateRef.current || creatingTab || restoringTabs) return;

    pendingAutoCreateRef.current = false;
    void createTab();
  }, [autoCreateOnOpen, createTab, creatingTab, open, restoringTabs, revealRequest, tabs.length, uiStateKey]);

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
    const ptyBridge = window.ade?.pty;
    if (!ptyBridge?.onExit) return undefined;
    const unsubscribe = ptyBridge.onExit((ev: PtyExitEvent) => {
      setTabs((prev) => prev.map((tab) => (
        tab.ptyId === ev.ptyId
          ? { ...tab, exited: true }
          : tab
      )));
    });
    return unsubscribe;
  }, []);

  useEffect(() => () => {
    if (!disposeTabsOnUnmount) return;
    for (const tab of tabsRef.current) {
      window.ade.pty.dispose({ ptyId: tab.ptyId, sessionId: tab.sessionId }).catch(() => {});
    }
  }, [disposeTabsOnUnmount]);

  // Drop drawer tabs when their session is deleted from the sidebar so the user
  // can't keep working in a shell whose backing session no longer exists.
  useEffect(() => {
    const sessionsBridge = window.ade?.sessions;
    if (!sessionsBridge?.onChanged) return undefined;
    return sessionsBridge.onChanged((event) => {
      if (event.reason !== "deleted") return;
      setTabs((prev) => {
        const removed = prev.find((tab) => tab.sessionId === event.sessionId);
        if (!removed) return prev;
        if (removed.ptyId) {
          window.ade.pty
            .dispose({ ptyId: removed.ptyId, sessionId: removed.sessionId })
            .catch(() => {});
        }
        const next = prev.filter((tab) => tab.sessionId !== event.sessionId);
        setActiveTabId((current) => {
          if (current !== removed.id) return current;
          return next.length > 0 ? next[next.length - 1].id : null;
        });
        return next;
      });
    });
  }, []);

  useEffect(() => {
    const appControlBridge = window.ade?.appControl;
    if (!appControlBridge) return undefined;
    let cancelled = false;
    void appControlBridge.getStatus()
      .then((status) => {
        if (cancelled) return;
        setAppControlTabState(deriveAppControlTabState(status?.activeSession ?? null));
      })
      .catch(() => {});
    const unsubscribe = appControlBridge.onEvent((event) => {
      if (event.type === "session-started" || event.type === "session-updated") {
        setAppControlTabState(deriveAppControlTabState(event.session));
      } else if (event.type === "session-stopped") {
        setAppControlTabState(deriveAppControlTabState(event.previousSession ?? null));
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
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
          {tabs.map((tab) => {
            const appControlTone = appControlTabState && appControlTabState.terminalSessionId === tab.sessionId
              ? appControlTabState.tone
              : null;
            const isActive = activeTab?.id === tab.id;
            return (
            <div
              key={tab.id}
              className={cn(
                "group relative flex h-6 shrink-0 items-center gap-1 border-r border-white/[0.04] px-2 font-mono text-[10px] transition-colors",
                isActive
                  ? "bg-white/[0.06] text-fg/85"
                  : "bg-transparent text-fg/35 hover:bg-white/[0.03] hover:text-fg/60",
                appControlTone ? "pl-4" : null,
              )}
              title={appControlTone ? appControlTabState?.title : undefined}
            >
              {appControlTone ? (
                <span
                  aria-hidden
                  className={cn(
                    "pointer-events-none absolute left-1.5 top-1.5 h-1.5 w-1.5 rounded-full",
                    appControlTone === "active" && "bg-emerald-300/85 shadow-[0_0_4px_rgba(16,185,129,0.6)]",
                    appControlTone === "warn" && "bg-amber-300/80",
                    appControlTone === "error" && "bg-rose-400/85",
                  )}
                />
              ) : null}
              {isActive ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-[var(--color-accent)]"
                />
              ) : null}
              <button
                type="button"
                onClick={() => setActiveTabId(tab.id)}
                className="flex h-full min-w-0 items-center gap-1 bg-transparent p-0 text-inherit"
              >
                <TerminalIcon
                  size={10}
                  weight="bold"
                  className={cn("shrink-0", tabIconColorClass(tab.exited, appControlTone))}
                />
                <span className="max-w-[80px] truncate">{tab.label}</span>
              </button>
              <button
                type="button"
                aria-label="Close tab"
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
              </button>
            </div>
            );
          })}
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
            {emptyMessage}
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
  const label = open ? "Close terminal" : "Open terminal";
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border font-sans transition-all",
        open
          ? "border-violet-400/20 bg-violet-500/[0.08] text-violet-200/80"
          : "border-white/[0.08] bg-white/[0.03] text-fg/45 hover:border-white/[0.12] hover:text-fg/65",
      )}
      title={label}
      aria-label={label}
    >
      <TerminalIcon size={13} weight={open ? "fill" : "regular"} />
    </button>
  );
});
