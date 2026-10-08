import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ArrowsOutSimple, CaretDown, ChatCircleDots, Check, NotePencil, SpinnerGap, X } from "@phosphor-icons/react";
import type { AgentChatFileRef, AgentChatSession, AgentChatSessionSummary } from "../../../shared/types";
import type { BuiltInBrowserStatus, BuiltInBrowserTab } from "../../../shared/types/builtInBrowser";
import { attachBrowserTabToComposer, browserTabContextItem } from "../chat/browser/attachBrowserTabToChat";
import { ChatSceneBackdrop } from "../personalChats/ChatSceneBackdrop";
import { cn } from "../ui/cn";
import { Z_LAYERS } from "../ui/zLayers";
import { AgentChatPane, type AgentChatPaneComposerHandle } from "../chat/AgentChatPane";
import { AgentChatApiProvider } from "../chat/agentChatApi";
import { ChatBuiltInBrowserPanel } from "../chat/ChatBuiltInBrowserPanel";
import { CHROME_GHOST_ON, TOOLBAR_FOCUS, TOOLBAR_MOTION } from "../chat/browser/browserChrome";
import {
  callPersonal,
  resolvePersonalChatsCatalogTargetKey,
  usePersonalChatPaneScope,
} from "../personalChats/usePersonalChatPaneScope";
import { sessionTitle } from "../personalChats/sessionHelpers";
import { SuggestionChips, type SuggestionPrompt } from "../personalChats/SuggestionChips";
import {
  ADE_OPEN_BUILT_IN_BROWSER_EVENT,
  navigateUrlInAdeBrowser,
  type OpenBuiltInBrowserDetail,
} from "../../lib/openExternal";
import { useAppStore } from "../../state/appStore";

/** Every call this page makes is on the personal collection, the one project-less chats see. */
const PERSONAL_SCOPE = { tabCollection: "personal" } as const;

/** Ways to start a chat about the page; a chip fills the draft beside the page chip. */
const PAGE_SUGGESTIONS: ReadonlyArray<SuggestionPrompt> = [
  { label: "Summarize this page", prefill: "Summarize this page." },
  { label: "Explain it simply", prefill: "Explain what this page is about in plain words." },
  { label: "Find something here", prefill: "Find on this page: " },
  { label: "Do something on it", prefill: "On this page, " },
];
/** How many recent chats the dock's switcher offers. */
const RECENT_CHAT_LIMIT = 8;
/** Coalesces list refreshes: a streaming turn emits many events a second. */
const SESSIONS_REFRESH_DEBOUNCE_MS = 400;
/** The Chats page's header buttons, so the dock reads as the same surface. */
const DOCK_HEADER_BUTTON =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-fg/[0.06] bg-fg/[0.025] text-muted-fg/45 transition-colors hover:text-fg disabled:opacity-35 disabled:hover:text-muted-fg/45";

/** The tab in front, when it has a page a chat could be about. */
function activePageTab(status: BuiltInBrowserStatus): BuiltInBrowserTab | null {
  const tab = status.tabs.find((entry) => entry.id === status.activeTabId) ?? null;
  return tab && browserTabContextItem(tab) ? tab : null;
}

/**
 * Lease the tab to the chat, so the chat's `ade browser` calls drive the tab
 * the person is looking at instead of opening one of their own. Best effort:
 * the agent still claims the active tab on its first call without it.
 */
async function leaseTabToChat(tabId: string, chatSessionId: string): Promise<void> {
  const api = window.ade?.builtInBrowser;
  if (!api) return;
  await api.switchTab({ ...PERSONAL_SCOPE, tabId, chatSessionId });
}

function AskAgentButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid="browser-ask-agent"
      title={active ? "Close the chat" : "Ask an agent about this page"}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[7px] px-2 text-[11.5px] font-medium",
        "text-muted-fg/85 hover:bg-fg/[0.06] hover:text-fg",
        active && cn("bg-fg/[0.07]", CHROME_GHOST_ON),
        TOOLBAR_MOTION,
        TOOLBAR_FOCUS,
      )}
    >
      <ChatCircleDots size={15} weight={active ? "fill" : "regular"} />
      Ask agent
    </button>
  );
}

/**
 * The Browser top tab: ADE's browser as a page of its own, with no project.
 *
 * It shows the `personal` tab collection on the global `persist:ade-browser`
 * profile, so sign-ins are the ones every ADE browser shares and the tabs are
 * the ones a project-less chat's agent sees. The page holds no browser state:
 * tabs live in the main process, and this page only positions their view over
 * its stage. Leaving the tab unmounts the panel, which hides the view; coming
 * back shows the same pages.
 *
 * "Ask agent" docks a normal project-less chat on the right. The chat is kept
 * in the app store, so closing the dock or switching tabs and coming back shows
 * the same chat until the person starts a new one.
 */
export function BrowserPage() {
  const navigate = useNavigate();
  const projectBinding = useAppStore((state) => state.projectBinding);
  // The same machine the Chats tab uses, so the docked chat is in that list.
  const targetKey = resolvePersonalChatsCatalogTargetKey(projectBinding, null);
  const dock = useAppStore((state) => state.browserDock);
  const setBrowserDock = useAppStore((state) => state.setBrowserDock);
  const dockChatId = dock.chat?.targetKey === targetKey ? dock.chat.sessionId : null;
  const [dockGeneration, setDockGeneration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const { chatScope, catalog, availableModelIds, providerUnavailable } = usePersonalChatPaneScope(targetKey, {
    enabled: dock.open,
    onError: setError,
  });
  const composerRef = useRef<AgentChatPaneComposerHandle | null>(null);
  /** The tab waiting to be attached once the dock's composer has mounted. */
  const pendingTabRef = useRef<BuiltInBrowserTab | null>(null);
  const [contextRequest, setContextRequest] = useState(0);
  /** The tab "Ask agent" was pressed on; a new chat leases it once it exists. */
  const askedTabIdRef = useRef<string | null>(null);
  /** This machine's project-less chats, newest first: the dock's title and switcher. */
  const [sessions, setSessions] = useState<AgentChatSessionSummary[]>([]);
  const dockSession = sessions.find((session) => session.sessionId === dockChatId) ?? null;

  const refreshSessions = useCallback(async () => {
    const rows = await callPersonal<AgentChatSessionSummary[]>("list", { includeArchived: false });
    setSessions([...(Array.isArray(rows) ? rows : [])].sort(
      (left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt),
    ));
  }, []);

  // The same live list the Chats page reads: titles and status follow the
  // chat's own event stream while the dock is open.
  useEffect(() => {
    if (!dock.open) return undefined;
    void refreshSessions().catch(() => undefined);
    let timer: number | null = null;
    const unsubscribe = chatScope.agentChat.onEvent(() => {
      if (timer != null) return;
      timer = window.setTimeout(() => {
        timer = null;
        void refreshSessions().catch(() => undefined);
      }, SESSIONS_REFRESH_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer != null) window.clearTimeout(timer);
    };
  }, [chatScope, dock.open, refreshSessions]);

  const reportLeaseFailure = useCallback((reason: unknown) => {
    const detail = reason instanceof Error ? reason.message : String(reason);
    setError(`The agent could not take this tab: ${detail}`);
  }, []);

  /** Stage the active tab as context for the dock's chat; lease it now when that chat exists. */
  const attachActiveTab = useCallback(async (chatSessionId: string | null) => {
    const api = window.ade?.builtInBrowser;
    if (!api) return;
    const status = await api.getStatus(PERSONAL_SCOPE);
    const tab = activePageTab(status);
    askedTabIdRef.current = tab?.id ?? null;
    if (!tab) return;
    pendingTabRef.current = tab;
    setContextRequest((value) => value + 1);
    if (chatSessionId) await leaseTabToChat(tab.id, chatSessionId);
  }, []);

  const toggleDock = useCallback(() => {
    setError(null);
    if (dock.open) {
      setBrowserDock({ open: false });
      return;
    }
    setBrowserDock({ open: true });
    void attachActiveTab(dockChatId).catch(reportLeaseFailure);
  }, [attachActiveTab, dock.open, dockChatId, reportLeaseFailure, setBrowserDock]);

  const startNewDockChat = useCallback(() => {
    setError(null);
    setBrowserDock({ chat: null });
    setDockGeneration((value) => value + 1);
    void attachActiveTab(null).catch(reportLeaseFailure);
  }, [attachActiveTab, reportLeaseFailure, setBrowserDock]);

  const handleSessionCreated = useCallback((session: AgentChatSession) => {
    // Same pane, now locked to the chat its first message created.
    setBrowserDock({ chat: { targetKey, sessionId: session.id } });
    const tabId = askedTabIdRef.current;
    if (tabId) void leaseTabToChat(tabId, session.id).catch(reportLeaseFailure);
    void refreshSessions().catch(() => undefined);
  }, [refreshSessions, reportLeaseFailure, setBrowserDock, targetKey]);

  /** Show another of this machine's chats in the dock, as picking it in Chats would. */
  const switchDockChat = useCallback((sessionId: string) => {
    if (sessionId === dockChatId) return;
    setError(null);
    setBrowserDock({ chat: { targetKey, sessionId } });
    setDockGeneration((value) => value + 1);
  }, [dockChatId, setBrowserDock, targetKey]);

  /** The dock's chat, full size on the Chats page: the same session, not a copy. */
  const openDockChatInChats = useCallback(() => {
    if (!dockChatId) return;
    useAppStore.getState().setPersonalChatsTabOpen(true);
    navigate(`/chats?chat=${encodeURIComponent(dockChatId)}`);
  }, [dockChatId, navigate]);

  // The chip lands once the pane (and so its composer) has mounted, which on a
  // first open waits for the model catalog.
  useEffect(() => {
    if (!dock.open || !pendingTabRef.current) return undefined;
    let frame: number | null = null;
    let attempts = 0;
    const flush = () => {
      frame = null;
      const handle = composerRef.current;
      const tab = pendingTabRef.current;
      if (!tab) return;
      if (handle) {
        pendingTabRef.current = null;
        attachBrowserTabToComposer(handle, tab);
        return;
      }
      if (++attempts < 120) frame = window.requestAnimationFrame(flush);
    };
    frame = window.requestAnimationFrame(flush);
    return () => {
      if (frame != null) window.cancelAnimationFrame(frame);
    };
  }, [catalog, contextRequest, dock.open, dockGeneration]);

  // Links clicked in the docked chat open as tabs here, beside it, rather than
  // in a project's browser the person cannot see from this tab.
  useEffect(() => {
    const openHere = (rawEvent: Event) => {
      const event = rawEvent as CustomEvent<OpenBuiltInBrowserDetail>;
      if (event.defaultPrevented || !event.detail?.url) return;
      event.preventDefault();
      navigateUrlInAdeBrowser(event.detail.url, { newTab: true, ...PERSONAL_SCOPE }, {
        fallbackToExternal: false,
        onFailure: () => setError("ADE Browser couldn't open that link. Try again."),
      });
    };
    window.addEventListener(ADE_OPEN_BUILT_IN_BROWSER_EVENT, openHere);
    return () => window.removeEventListener(ADE_OPEN_BUILT_IN_BROWSER_EVENT, openHere);
  }, []);

  const setComposerDraft = useCallback((text: string) => composerRef.current?.setDraft(text), []);
  const insertIntoComposer = useCallback((text: string) => composerRef.current?.insertDraft(text), []);
  const attachToComposer = useCallback(
    (attachment: AgentChatFileRef) => composerRef.current?.addAttachment(attachment),
    [],
  );
  const addBrowserContextToComposer = useCallback(
    (item: unknown) => composerRef.current?.addBuiltInBrowserContext(item),
    [],
  );

  return (
    <div className="ade-chat-scene relative flex h-full min-h-0 text-fg" data-testid="browser-page">
      <ChatSceneBackdrop />
      {/* The panels share the dock chat's API scope: a screenshot or element
          sent from the browser lands in that chat's attachment store. */}
      <AgentChatApiProvider scope={chatScope}>
        <main className="relative flex min-w-0 flex-1 flex-col gap-1.5 p-1.5">
          {error ? (
            <div role="alert" className="flex shrink-0 items-center gap-2 rounded-md border border-rose-400/15 bg-rose-500/[0.06] px-3 py-1.5 font-sans text-[11px] text-rose-200/80">
              <span className="min-w-0 flex-1 truncate" title={error}>{error}</span>
              <button type="button" onClick={() => setError(null)} className="shrink-0 text-rose-200/60 hover:text-rose-100">Dismiss</button>
            </div>
          ) : null}
          <div className="min-h-0 flex-1">
            <ChatBuiltInBrowserPanel
              // Inspect, Attach and "insert into the message" only exist while
              // there is a chat beside the page to receive them.
              sessionId={dock.open ? dockChatId : null}
              projectRootOverride={null}
              onAddContext={dock.open ? addBrowserContextToComposer : undefined}
              onAddAttachment={dock.open ? attachToComposer : undefined}
              onInsertDraft={dock.open ? insertIntoComposer : undefined}
              toolbarEnd={<AskAgentButton active={dock.open} onClick={toggleDock} />}
              toolbarEndControlCount={3}
            />
          </div>
        </main>
        {dock.open ? (
          <aside
            className="ade-chat-scene-plane relative flex w-[min(40%,480px)] min-w-[340px] shrink-0 flex-col border-l border-fg/[0.07] bg-bg"
            aria-label="Chat about this page"
            data-testid="browser-dock"
          >
            <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-fg/[0.055] px-3">
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-1 rounded-md py-1 text-left font-sans text-[12px] font-medium text-fg/75 hover:text-fg"
                    title="Switch to a recent chat"
                    aria-label="Recent chats"
                  >
                    <span className="min-w-0 truncate">{dockSession ? sessionTitle(dockSession) : "New chat"}</span>
                    <CaretDown size={11} className="shrink-0 text-muted-fg/50" />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="start"
                    sideOffset={4}
                    style={{ zIndex: Z_LAYERS.popover }}
                    className="min-w-[220px] max-w-[320px] rounded-lg border border-fg/[0.08] bg-[var(--color-popup-bg,var(--color-bg))] p-1 font-sans text-[12px] text-fg/80 shadow-xl"
                  >
                    <DropdownMenu.Label className="px-2 py-1 text-[10.5px] text-muted-fg/60">Recent chats</DropdownMenu.Label>
                    {sessions.length === 0 ? (
                      <div className="px-2 py-1.5 text-muted-fg/55">No chats yet</div>
                    ) : sessions.slice(0, RECENT_CHAT_LIMIT).map((session) => (
                      <DropdownMenu.Item
                        key={session.sessionId}
                        onSelect={() => switchDockChat(session.sessionId)}
                        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-fg/[0.06]"
                      >
                        <span className="min-w-0 flex-1 truncate">{sessionTitle(session)}</span>
                        {session.sessionId === dockChatId ? <Check size={12} className="shrink-0 text-accent" /> : null}
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
              <button type="button" onClick={startNewDockChat} disabled={!dockChatId} className={DOCK_HEADER_BUTTON} title="New chat" aria-label="New chat">
                <NotePencil size={14} />
              </button>
              <button type="button" onClick={openDockChatInChats} disabled={!dockChatId} className={DOCK_HEADER_BUTTON} title="Open in Chats" aria-label="Open in Chats">
                <ArrowsOutSimple size={14} />
              </button>
              <button type="button" onClick={() => setBrowserDock({ open: false })} className={DOCK_HEADER_BUTTON} title="Close the chat" aria-label="Close the chat">
                <X size={14} />
              </button>
            </div>
            {providerUnavailable && !dockChatId ? (
              <div className="shrink-0 border-b border-amber-400/15 bg-amber-500/[0.06] px-3 py-1.5 font-sans text-[11px] text-amber-200/80">
                No connected agent is available right now. Sign in to a provider from Settings to start a chat.
              </div>
            ) : null}
            <div className="min-h-0 flex-1">
              {dockChatId == null && catalog == null ? (
                <div className="flex h-full items-center justify-center"><SpinnerGap size={20} className="animate-spin text-muted-fg/35" /></div>
              ) : (
                <AgentChatPane
                  key={`${targetKey}:${dockGeneration}`}
                  laneId={null}
                  chatScope={chatScope}
                  lockSessionId={dockChatId}
                  lockSessionProvider={dockSession?.provider ?? null}
                  initialSessionSummary={dockSession}
                  availableModelIdsOverride={availableModelIds}
                  onSessionCreated={handleSessionCreated}
                  composerHandleRef={composerRef}
                  personalDraftKey="personal:browser-dock-draft"
                  emptyStateAccessory={providerUnavailable ? null : <SuggestionChips prompts={PAGE_SUGGESTIONS} onSelect={setComposerDraft} />}
                  canvasFill="var(--ade-chat-scene-canvas)"
                  hideSessionTabs
                  hideWorkspaceChrome
                  hideSurfaceHeader
                  hideLaneToolDrawers
                  shouldAutofocusComposer
                  presentation={{
                    mode: "standard",
                    title: dockSession ? sessionTitle(dockSession) : "New chat",
                    assistantLabel: dockSession ? sessionTitle(dockSession) : "ADE",
                    messagePlaceholder: "Ask about this page, or have the agent do something on it…",
                  }}
                />
              )}
            </div>
          </aside>
        ) : null}
      </AgentChatApiProvider>
    </div>
  );
}
