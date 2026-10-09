import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ArrowsOutSimple, CaretDown, ChatCircleDots, Check, NotePencil, SpinnerGap, X } from "@phosphor-icons/react";
import type { AgentChatFileRef, AgentChatSession, AgentChatSessionSummary } from "../../../shared/types";
import type { BuiltInBrowserStatus, BuiltInBrowserTab } from "../../../shared/types/builtInBrowser";
import {
  formatBrowserTabMentionForPrompt,
  formatBrowserTabMentionToken,
  type BrowserTabMentionTarget,
} from "../../../shared/browserTabMention";
import { ChatSceneBackdrop } from "../personalChats/ChatSceneBackdrop";
import { cn } from "../ui/cn";
import { Banner } from "../ui/notice";
import { Z_LAYERS } from "../ui/zLayers";
import { AgentChatPane, type AgentChatPaneComposerHandle } from "../chat/AgentChatPane";
import { AgentChatApiProvider } from "../chat/agentChatApi";
import { DraftMachinePicker, type DraftMachineOption } from "../chat/DraftMachinePicker";
import { useRemoteConnectionSnapshot } from "../../state/projectMachines";
import { THIS_MACHINE_ID, THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import { ChatBuiltInBrowserPanel } from "../chat/ChatBuiltInBrowserPanel";
import { CHROME_GHOST_ON, TOOLBAR_FOCUS, TOOLBAR_MOTION } from "../chat/browser/browserChrome";
import {
  callPersonal,
  resolvePersonalChatsCatalogTargetKey,
  usePersonalChatPaneScope,
} from "../personalChats/usePersonalChatPaneScope";
import { CHAT_HEADER_BUTTON, sessionTitle } from "../personalChats/sessionHelpers";
import {
  ADE_OPEN_BUILT_IN_BROWSER_EVENT,
  navigateUrlInAdeBrowser,
  type OpenBuiltInBrowserDetail,
} from "../../lib/openExternal";
import { useAppStore } from "../../state/appStore";

/** Every call this page makes is on the personal collection, the one project-less chats see. */
const PERSONAL_SCOPE = { tabCollection: "personal" } as const;

/** How many recent chats the dock's switcher offers. */
const RECENT_CHAT_LIMIT = 8;
/** Coalesces list refreshes: a streaming turn emits many events a second. */
const SESSIONS_REFRESH_DEBOUNCE_MS = 400;

/** The tab in front, when it has a page a chat could be about. */
function activePageTab(status: BuiltInBrowserStatus): BuiltInBrowserTab | null {
  const tab = status.tabs.find((entry) => entry.id === status.activeTabId) ?? null;
  return tab && !tab.isLaunchpad && tab.url ? tab : null;
}

/**
 * Hand the tab to the chat, as the tab menu's "Attach to chat" does: its lease
 * moves to that chat even when another chat held it, so the agent's
 * `ade browser claim` is not refused. It does not bring the tab to the front
 * or ask for consent; the person already chose it.
 */
async function handTabToChat(tabId: string, chatSessionId: string): Promise<void> {
  await window.ade?.builtInBrowser?.handTabToChat?.({ ...PERSONAL_SCOPE, tabId, chatSessionId });
}

function AskAgentButton({ active, onClick, onWarm }: { active: boolean; onClick: () => void; onWarm: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      onPointerEnter={onWarm}
      onFocus={onWarm}
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

/** The dock's new-chat state: the page this chat will be about, small and quiet. */
function DockPageCard({ tab }: { tab: BuiltInBrowserTab | null }) {
  let host: string | null = null;
  try {
    host = tab?.url ? new URL(tab.url).host.replace(/^www\./, "") : null;
  } catch {
    host = null;
  }
  return (
    <div className="flex w-full max-w-[360px] flex-col items-center gap-2 px-2 pb-1" data-testid="browser-dock-page">
      {tab ? (
        <div className="flex w-full min-w-0 items-center gap-2.5 rounded-lg border border-fg/[0.07] bg-fg/[0.03] px-3 py-2 text-left">
          {tab.faviconUrl ? (
            <img src={tab.faviconUrl} alt="" className="size-4 shrink-0 rounded-[3px]" />
          ) : (
            <ChatCircleDots size={16} className="shrink-0 text-muted-fg/60" />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] font-medium text-fg/90">{tab.title?.trim() || host || tab.url}</div>
            {host ? <div className="truncate text-[11px] text-muted-fg/60">{host}</div> : null}
          </div>
        </div>
      ) : null}
      {tab ? null : <p className="m-0 text-[12px] text-muted-fg/70">Open a page, then ask about it here.</p>}
    </div>
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
  /**
   * Set when the pointer reaches "Ask agent" (or the dock opens) and kept: the
   * model catalog loads while the hand is still moving, so the first open does
   * not wait on it, and closing the dock does not throw it away.
   */
  const [dockWarm, setDockWarm] = useState(dock.open);
  const warmDock = useCallback(() => setDockWarm(true), []);
  const { chatScope, catalog, availableModelIds, providerUnavailable } = usePersonalChatPaneScope(targetKey, {
    enabled: dock.open || dockWarm,
    onError: setError,
  });
  const composerRef = useRef<AgentChatPaneComposerHandle | null>(null);
  /**
   * The page in front, kept live from the browser's status. Every message the
   * dock sends names it in hidden context, so "this page" always means the
   * page the person is looking at, with no chip for them to manage.
   */
  const [frontTab, setFrontTab] = useState<BuiltInBrowserTab | null>(null);
  const frontTabRef = useRef<BuiltInBrowserTab | null>(null);
  frontTabRef.current = frontTab;
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
    setError(`The chat could not take this tab: ${detail}`);
  }, []);

  // Follow the page in front of the person on this collection.
  useEffect(() => {
    const api = window.ade?.builtInBrowser;
    if (!api) return undefined;
    let collectionKey: string | null = null;
    let disposed = false;
    void api.getStatus(PERSONAL_SCOPE).then((status) => {
      if (disposed) return;
      collectionKey = status.collectionKey;
      setFrontTab(activePageTab(status));
    }).catch(() => undefined);
    const unsubscribe = api.onEvent?.((payload) => {
      if (payload.type !== "status" && payload.type !== "open-request") return;
      if (collectionKey == null || payload.status.collectionKey !== collectionKey) return;
      const next = activePageTab(payload.status);
      setFrontTab((current) => (
        current?.id === next?.id && current?.url === next?.url && current?.title === next?.title ? current : next
      ));
    });
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  const ambientTurnContext = useCallback((): string | null => {
    const tab = frontTabRef.current;
    return tab ? formatBrowserTabMentionForPrompt({ tabId: tab.id, title: tab.title?.trim() || null, url: tab.url }) : null;
  }, []);

  /** Lease the page in front to the dock's chat (now, when the chat exists) so its agent can drive it. */
  const attachActiveTab = useCallback(async (chatSessionId: string | null) => {
    const api = window.ade?.builtInBrowser;
    if (!api) return;
    const tab = activePageTab(await api.getStatus(PERSONAL_SCOPE));
    askedTabIdRef.current = tab?.id ?? null;
    if (tab && chatSessionId) await handTabToChat(tab.id, chatSessionId);
  }, []);

  const toggleDock = useCallback(() => {
    setError(null);
    setDockWarm(true);
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
    if (tabId) void handTabToChat(tabId, session.id).catch(reportLeaseFailure);
    void refreshSessions().catch(() => undefined);
  }, [refreshSessions, reportLeaseFailure, setBrowserDock, targetKey]);

  /**
   * Show another of this machine's chats in the dock, as picking it in Chats
   * would, and hand it the page in front so its agent drives that tab.
   */
  const switchDockChat = useCallback((sessionId: string) => {
    if (sessionId === dockChatId) return;
    setError(null);
    setBrowserDock({ chat: { targetKey, sessionId } });
    setDockGeneration((value) => value + 1);
    void (async () => {
      const api = window.ade?.builtInBrowser;
      if (!api) return;
      const tab = activePageTab(await api.getStatus(PERSONAL_SCOPE));
      askedTabIdRef.current = tab?.id ?? null;
      if (tab) await handTabToChat(tab.id, sessionId);
    })().catch(reportLeaseFailure);
  }, [dockChatId, reportLeaseFailure, setBrowserDock, targetKey]);

  /** The dock's chat, full size on the Chats page: the same session, not a copy. */
  const openDockChatInChats = useCallback(() => {
    if (!dockChatId) return;
    useAppStore.getState().setPersonalChatsTabOpen(true);
    navigate(`/chats?chat=${encodeURIComponent(dockChatId)}`);
  }, [dockChatId, navigate]);

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

  const insertIntoComposer = useCallback((text: string) => composerRef.current?.insertDraft(text), []);
  const attachToComposer = useCallback(
    (attachment: AgentChatFileRef) => composerRef.current?.addAttachment(attachment),
    [],
  );
  const addBrowserContextToComposer = useCallback(
    (item: unknown) => composerRef.current?.addBuiltInBrowserContext(item),
    [],
  );
  const attachTabToComposer = useCallback(
    (tab: BrowserTabMentionTarget) => composerRef.current?.insertDraft(formatBrowserTabMentionToken(tab)),
    [],
  );

  return (
    <div className="ade-chat-scene relative flex h-full min-h-0 text-fg" data-testid="browser-page">
      <ChatSceneBackdrop />
      {/* The panels share the dock chat's API scope: a screenshot or element
          sent from the browser lands in that chat's attachment store. */}
      <AgentChatApiProvider scope={chatScope}>
        <main className="relative flex min-w-0 flex-1 flex-col">
          {error ? (
            <Banner
              layout="inline"
              model={{ id: "browser-page-error", tone: "error", title: error, dismiss: { onDismiss: () => setError(null) } }}
            />
          ) : null}
          <div className="min-h-0 flex-1">
            <ChatBuiltInBrowserPanel
              // Inspect, Attach and "insert into the message" only exist while
              // there is a chat beside the page to receive them.
              sessionId={dock.open ? dockChatId : null}
              projectRootOverride={null}
              flush
              onAddContext={dock.open ? addBrowserContextToComposer : undefined}
              onAddAttachment={dock.open ? attachToComposer : undefined}
              onInsertDraft={dock.open ? insertIntoComposer : undefined}
              onAttachTab={dock.open ? attachTabToComposer : undefined}
              toolbarEnd={<AskAgentButton active={dock.open} onClick={toggleDock} onWarm={warmDock} />}
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
              <button type="button" onClick={startNewDockChat} disabled={!dockChatId} className={CHAT_HEADER_BUTTON} title="New chat" aria-label="New chat">
                <NotePencil size={14} />
              </button>
              <button type="button" onClick={openDockChatInChats} disabled={!dockChatId} className={CHAT_HEADER_BUTTON} title="Open in Chats" aria-label="Open in Chats">
                <ArrowsOutSimple size={14} />
              </button>
              <button type="button" onClick={() => setBrowserDock({ open: false })} className={CHAT_HEADER_BUTTON} title="Close the chat" aria-label="Close the chat">
                <X size={14} />
              </button>
            </div>
            {providerUnavailable && !dockChatId ? (
              <Banner
                layout="inline"
                model={{
                  id: "browser-dock-no-provider",
                  tone: "warning",
                  title: "No connected agent is available right now",
                  detail: "Sign in to a provider from Settings to start a chat.",
                }}
              />
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
                  emptyStateHero={<DockPageCard tab={frontTab} />}
                  emptyStateAccessory={<DockMachineChoice />}
                  ambientTurnContext={ambientTurnContext}
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

const DOCK_MACHINE_DESCRIPTION =
  "The page is in this computer's browser, so the chat beside it runs here too. To run a chat on another machine, start it from Chats.";

/**
 * Where the dock's chat runs: always this computer, because the page it reads
 * is in this computer's browser and an agent on another machine cannot see it.
 * Paired machines are listed, disabled with that reason, so the choice reads
 * as made rather than missing.
 */
function DockMachineChoice() {
  const { snapshot } = useRemoteConnectionSnapshot(true);
  const machines = useMemo<DraftMachineOption[]>(() => [
    { id: THIS_MACHINE_ID, name: THIS_MACHINE_NAME },
    ...(snapshot?.connections ?? [])
      .filter((connection) => connection.state === "connected")
      .map((connection) => {
        const name = connection.target.name || connection.target.hostname;
        return {
          id: connection.target.id,
          name,
          unavailableReason: `An agent on ${name} can't see this computer's browser. Start a chat there from Chats.`,
        };
      }),
  ], [snapshot]);
  return (
    <div className="flex w-full items-center px-3 pt-1.5">
      <DraftMachinePicker
        machines={machines}
        selectedMachineId={THIS_MACHINE_ID}
        onChange={() => undefined}
        tooltipDescription={DOCK_MACHINE_DESCRIPTION}
        showWhenSingle
      />
    </div>
  );
}
