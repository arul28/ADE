import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import { Terminal as TerminalIcon, Eraser, Plus, Power, Rows, X } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import type { AppControlSession, ChatTerminalSession, OpenProjectBinding, PtyExitEvent } from "../../../shared/types";
import { clearTerminalRuntimeScrollback, TerminalView } from "../terminals/TerminalView";
import {
  WORK_TOOL_CHROME_ROW,
  WORK_TOOL_PRIMARY_BUTTON,
  WorkToolChromeButton,
  WorkToolEmptyLine,
  WorkToolSurface,
} from "../terminals/workToolChrome";
import {
  clearWorkTerminalShellCount,
  publishWorkTerminalShellCount,
} from "../terminals/workTerminalShells";

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
  /**
   * Owner session for attached terminals. Historically this was always an ADE
   * chat id; Work CLI sessions now use their terminal session id here too.
   */
  chatSessionId?: string | null;
  /**
   * Machine the owning chat/CLI session lives on. Null (the default, and every
   * pre-existing call site) means the tab's bound machine. When set, terminal
   * creation, restore, disposal, and the xterm runtime are all addressed there.
   */
  runtimePin?: OpenProjectBinding | null;
  autoCreateOnOpen?: boolean;
  createRequestNonce?: number;
  disposeTabsOnUnmount?: boolean;
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
  activeTerminalId: string | null;
};

let nextTabIndex = 1;
const drawerUiStateByKey = new Map<string, DrawerUiState>();

function drawerStateKey(
  chatSessionId: string | null | undefined,
  laneId: string,
  pin?: OpenProjectBinding | null,
): string {
  const scope = chatSessionId ? `chat:${chatSessionId}` : `lane:${laneId}`;
  return pin ? `machine:${pin.kind}:${pin.key}::${scope}` : scope;
}

function readDrawerUiState(key: string): DrawerUiState {
  const cached = drawerUiStateByKey.get(key);
  if (cached) return cached;
  try {
    const raw = window.sessionStorage.getItem(`ade.chat.terminalDrawer.${key}`);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<DrawerUiState>;
      const state = {
        activeTerminalId: typeof parsed.activeTerminalId === "string" ? parsed.activeTerminalId : null,
      };
      drawerUiStateByKey.set(key, state);
      return state;
    }
  } catch {
    // Best-effort UI state only.
  }
  return { activeTerminalId: null };
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
  runtimePin = null,
  autoCreateOnOpen = true,
  createRequestNonce = 0,
  disposeTabsOnUnmount = false,
  onCreateError,
  revealRequest,
}: ChatTerminalDrawerProps) {
  const pin = runtimePin ?? null;
  // Lane and chat ids are only unique per machine, so the persisted UI state
  // (which shell was last active) is namespaced by machine too.
  const uiStateKey = drawerStateKey(chatSessionId, laneId, pin);
  const [tabs, setTabs] = useState<TabEntry[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [creatingTab, setCreatingTab] = useState(false);
  const [restoringTabs, setRestoringTabs] = useState(false);
  const [appControlTabState, setAppControlTabState] = useState<AppControlTabState | null>(null);
  /**
   * The shell shown UNDER the active one while the row's split toggle is on.
   *
   * A second pane, not a second layout mode: the panel is one column wide, so
   * splitting stacks. Held as a tab id rather than a boolean so closing that
   * shell can retire the split without leaving an empty half behind.
   */
  const [splitTabId, setSplitTabId] = useState<string | null>(null);
  const hadTabsRef = useRef(false);
  const previousOpenRef = useRef(open);
  const pendingAutoCreateRef = useRef(false);
  const tabsRef = useRef<TabEntry[]>([]);
  const createTabFlightRef = useRef<Promise<string | null> | null>(null);
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
    setTabs([]);
    setActiveTabId(null);
    if (!chatSessionId) restoringUiStateRef.current = false;
  }, [chatSessionId, uiStateKey]);

  /**
   * Tell the tools pane how many shells are on screen, including the one in a
   * split pane.
   *
   * The header's status is this number, not a second `terminal.list` read that
   * disagreed with it. Published on every tab change and retracted on unmount,
   * so a pane showing another tool falls back to its own read rather than to a
   * stale count from a panel that is no longer there.
   */
  useEffect(() => {
    if (!chatSessionId || !open) return undefined;
    publishWorkTerminalShellCount(chatSessionId, tabs.length);
    return () => clearWorkTerminalShellCount(chatSessionId);
  }, [chatSessionId, open, tabs.length]);

  useEffect(() => {
    if (restoringUiStateRef.current) return;
    const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
    writeDrawerUiState(uiStateKey, { activeTerminalId: activeTab?.sessionId ?? null });
  }, [activeTabId, tabs, uiStateKey]);

  /**
   * Open a shell, and say which one.
   *
   * The id comes back so the split toggle can put a brand-new shell in the
   * second pane instead of stealing the active one — the caller cannot infer
   * that from `activeTabId`, which this function also moves.
   */
  const createTab = useCallback(async (): Promise<string | null> => {
    if (createTabFlightRef.current) {
      return await createTabFlightRef.current.catch(() => null);
    }
    setCreatingTab(true);
    const flight = (async (): Promise<string | null> => {
      const tabIndex = nextTabIndex++;
      const label = `Terminal ${tabIndex}`;
      const created = await window.ade.pty.create({
        laneId,
        chatSessionId,
        cols: 80,
        rows: 24,
        title: label,
        tracked: true,
        toolType: "shell",
      }, pin);

      const tabId = `chat-term-${created.sessionId}`;
      const nextEntry: TabEntry = {
        id: tabId,
        ptyId: created.ptyId,
        sessionId: created.sessionId,
        label,
        exited: false,
      };

      const existing = tabsRef.current.find(
        (tab) => tab.sessionId === created.sessionId || tab.ptyId === created.ptyId,
      );
      if (existing) {
        setActiveTabId(existing.id);
        return existing.id;
      }
      setTabs((prev) => {
        const prevExisting = prev.find(
          (tab) => tab.sessionId === created.sessionId || tab.ptyId === created.ptyId,
        );
        if (prevExisting) return prev;
        return [...prev, nextEntry];
      });
      setActiveTabId(tabId);
      return tabId;
    })();
    createTabFlightRef.current = flight;
    try {
      return await flight;
    } catch (error) {
      reportCreateError(error);
      return null;
    } finally {
      if (createTabFlightRef.current === flight) createTabFlightRef.current = null;
      setCreatingTab(false);
    }
  }, [chatSessionId, laneId, pin, reportCreateError]);

  useEffect(() => {
    if (!chatSessionId) return;
    if (!open && !revealRequest) return;
    let cancelled = false;
    setRestoringTabs(true);
    window.ade.terminal.list({ chatSessionId, limit: 20 }, pin)
      .then((sessions) => {
        if (cancelled) return;
        const restored = sessions
          .map(tabFromTerminal)
          .filter((tab): tab is TabEntry => tab != null)
          .sort((a, b) => Number(a.exited) - Number(b.exited));
        if (!restored.length) return;
        setTabs((prev) => {
          const restoredBySessionId = new Map(restored.map((tab) => [tab.sessionId, tab]));
          const restoredByPtyId = new Map(restored.map((tab) => [tab.ptyId, tab]));
          const next = prev.map((tab) => restoredBySessionId.get(tab.sessionId) ?? restoredByPtyId.get(tab.ptyId) ?? tab);
          const existingSessionIds = new Set(next.map((tab) => tab.sessionId));
          const existingPtyIds = new Set(next.map((tab) => tab.ptyId));
          for (const tab of restored) {
            if (!existingSessionIds.has(tab.sessionId) && !existingPtyIds.has(tab.ptyId)) {
              next.push(tab);
              existingSessionIds.add(tab.sessionId);
              existingPtyIds.add(tab.ptyId);
            }
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
  }, [chatSessionId, open, pin, revealRequest, uiStateKey]);

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
    setTabs((prev) => {
      const existingInUpdate = prev.find(
        (tab) => tab.sessionId === revealRequest.terminalId || tab.ptyId === revealRequest.ptyId,
      );
      if (existingInUpdate) return prev;
      return [...prev, nextEntry];
    });
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
    }, pin);
    return unsubscribe;
  }, [pin]);

  useEffect(() => () => {
    if (!disposeTabsOnUnmount) return;
    for (const tab of tabsRef.current) {
      window.ade.pty.dispose({ ptyId: tab.ptyId, sessionId: tab.sessionId }, pin).catch(() => {});
    }
  }, [disposeTabsOnUnmount, pin]);

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
            .dispose({ ptyId: removed.ptyId, sessionId: removed.sessionId }, pin)
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
  }, [pin]);

  useEffect(() => {
    if (!open) return undefined;
    const appControlBridge = window.ade?.appControl;
    if (!appControlBridge) return undefined;
    let cancelled = false;
    void appControlBridge.getStatus(pin)
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
  }, [open, pin]);

  const closeTab = useCallback((tabId: string) => {
    const entry = tabsRef.current.find((tab) => tab.id === tabId);
    if (entry) {
      window.ade.pty.dispose({ ptyId: entry.ptyId, sessionId: entry.sessionId }, pin).catch(() => {});
    }

    setSplitTabId((current) => (current === tabId ? null : current));
    setTabs((prev) => {
      const next = prev.filter((tab) => tab.id !== tabId);
      setActiveTabId((current) => {
        if (current !== tabId) return current;
        return next.length > 0 ? next[next.length - 1].id : null;
      });
      return next;
    });
  }, [pin]);

  /**
   * Show a second shell under the active one, opening one if there is no
   * spare. Toggling off never closes anything — the shell stays in the strip.
   */
  const toggleSplit = useCallback(async () => {
    /*
      Gate on the pane that is actually SHOWING, not on the raw id.

      Clicking the split shell's own pill makes it active, which retires the
      second pane (the same runtime cannot fill both) while leaving `splitTabId`
      truthy. Reading the id alone then made the next click a no-op "toggle off"
      of a split nobody could see, and the button had already relabelled itself
      "Split". Resolving the pane here means a stale id is simply overwritten by
      the new split below.
    */
    const currentTabs = tabsRef.current;
    const active = currentTabs.find((tab) => tab.id === activeTabId) ?? currentTabs.at(-1) ?? null;
    const showing = splitTabId && splitTabId !== active?.id
      ? currentTabs.find((tab) => tab.id === splitTabId) ?? null
      : null;
    if (showing) {
      setSplitTabId(null);
      return;
    }
    const spare = currentTabs.find((tab) => tab.id !== activeTabId && !tab.exited);
    if (spare) {
      setSplitTabId(spare.id);
      return;
    }
    const keepActive = activeTabId;
    const created = await createTab();
    if (!created) return;
    setSplitTabId(created);
    // `createTab` focuses what it opened; the split pane is the new shell's
    // home, so focus goes back to the tab the split was requested from.
    if (keepActive) setActiveTabId(keepActive);
  }, [activeTabId, createTab, splitTabId]);

  if (!open) return null;

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs.at(-1) ?? null;
  // An empty tab strip is a row of chrome for tabs that do not exist, and its
  // "+" competes with the centred button below it for the same single action.
  // With no shells the panel shows one affordance, not two.
  const showEmptyState = tabs.length === 0;
  // Only a DIFFERENT shell can occupy the second pane; pointing the split at
  // the tab already on screen would paint the same runtime twice.
  const splitTab = splitTabId && splitTabId !== activeTab?.id
    ? tabs.find((tab) => tab.id === splitTabId) ?? null
    : null;

  const renderTabPill = (tab: TabEntry) => {
    const appControlTone = appControlTabState && appControlTabState.terminalSessionId === tab.sessionId
      ? appControlTabState.tone
      : null;
    const isActive = activeTab?.id === tab.id;
    const isSplit = splitTab?.id === tab.id;
    return (
      <div
        key={tab.id}
        data-testid="terminal-tab-pill"
        className={cn(
          "group/pill relative flex h-6 min-w-0 max-w-[144px] shrink-0 items-center gap-1.5 rounded-[6px] pl-2 pr-1",
          "text-[12px] transition-colors duration-[120ms] ease-out",
          isActive
            ? "bg-white/[0.08] text-fg"
            : isSplit
              ? "bg-white/[0.04] text-fg/75"
              : "text-muted-fg hover:bg-white/[0.05] hover:text-fg/85",
        )}
        title={appControlTone ? appControlTabState?.title : undefined}
      >
        <TerminalIcon
          size={12}
          weight="regular"
          aria-hidden
          className={cn("shrink-0", tabIconColorClass(tab.exited, appControlTone))}
        />
        <button
          type="button"
          onClick={() => setActiveTabId(tab.id)}
          className="min-w-0 flex-1 truncate bg-transparent p-0 text-left text-inherit focus-visible:outline-none"
        >
          {tab.label}
        </button>
        {/* The close slot is always reserved and only ever fades in, so
            revealing it on hover cannot reflow the label under the cursor. */}
        <button
          type="button"
          aria-label={`Close ${tab.label}`}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            closeTab(tab.id);
          }}
          // Space on a button scrolls the strip before the browser synthesises
          // its click, and the click would then bubble to the pill and select
          // the tab we are closing. Both are handled here rather than hoped for.
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              closeTab(tab.id);
            }
          }}
          className={cn(
            "flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] text-muted-fg",
            "opacity-0 transition-opacity duration-[120ms] ease-out",
            "hover:bg-white/[0.08] hover:text-fg group-hover/pill:opacity-100",
            "focus-visible:opacity-100 focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
          )}
        >
          <X size={10} weight="bold" />
        </button>
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-surface-recessed)]">
      {showEmptyState ? null : (
        <div className={WORK_TOOL_CHROME_ROW}>
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto scrollbar-none">
            {tabs.map(renderTabPill)}
            <WorkToolChromeButton
              label="New shell"
              onClick={() => { void createTab(); }}
              disabled={creatingTab}
              testId="terminal-new-shell"
            >
              <Plus size={16} />
            </WorkToolChromeButton>
          </div>

          <div className="flex shrink-0 items-center gap-0.5">
            <WorkToolChromeButton
              label={splitTab ? "Close split" : "Split"}
              onClick={() => { void toggleSplit(); }}
              active={Boolean(splitTab)}
              disabled={creatingTab || !activeTab}
              testId="terminal-split"
            >
              <Rows size={16} />
            </WorkToolChromeButton>
            <WorkToolChromeButton
              label="Clear"
              onClick={() => {
                if (activeTab) clearTerminalRuntimeScrollback(activeTab.sessionId);
              }}
              disabled={!activeTab}
              testId="terminal-clear"
            >
              <Eraser size={16} />
            </WorkToolChromeButton>
            <WorkToolChromeButton
              label="Kill shell"
              onClick={() => {
                if (activeTab) closeTab(activeTab.id);
              }}
              disabled={!activeTab}
              testId="terminal-kill"
            >
              <Power size={16} />
            </WorkToolChromeButton>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-2">
        {activeTab ? (
          <>
            <WorkToolSurface>
              <TerminalView
                ptyId={activeTab.ptyId}
                sessionId={activeTab.sessionId}
                runtimePin={pin}
                isActive
                isVisible
                className="h-full w-full"
              />
            </WorkToolSurface>
            {splitTab ? (
              <WorkToolSurface>
                <TerminalView
                  ptyId={splitTab.ptyId}
                  sessionId={splitTab.sessionId}
                  runtimePin={pin}
                  isActive={false}
                  isVisible
                  className="h-full w-full"
                />
              </WorkToolSurface>
            ) : null}
          </>
        ) : (
          <WorkToolEmptyLine
            title="Start a shell in this lane"
            action={(
              <button
                type="button"
                onClick={() => { void createTab(); }}
                disabled={creatingTab}
                className={WORK_TOOL_PRIMARY_BUTTON}
                data-testid="terminal-empty-new-shell"
              >
                <Plus size={14} weight="bold" />
                <span>New shell</span>
              </button>
            )}
          />
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
