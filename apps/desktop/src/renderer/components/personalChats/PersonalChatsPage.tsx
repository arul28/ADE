import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatBrowserTabMentionToken } from "../../../shared/browserTabMention";
import { AppWindow, ArrowLeft, Globe, SpinnerGap, TerminalWindow } from "@phosphor-icons/react";
import { useLocation, useNavigate } from "react-router-dom";
import type {
  AgentChatFileRef,
  AgentChatSession,
  AgentChatSessionSummary,
  OpenProjectBinding,
} from "../../../shared/types";
import { cn } from "../ui/cn";
import { AgentChatPane, type AgentChatPaneComposerHandle } from "../chat/AgentChatPane";
import { AgentChatApiProvider } from "../chat/agentChatApi";
import { ChatBuiltInBrowserPanel } from "../chat/ChatBuiltInBrowserPanel";
import { PersonalTerminalPanel } from "./PersonalTerminalPanel";
import { ProjectlessSidebar } from "./ProjectlessSidebar";
import { sessionPreview, sessionTitle } from "./sessionHelpers";
import { SuggestionChips } from "./SuggestionChips";
import {
  callPersonal,
  resolvePersonalChatsCatalogTargetKey,
  usePersonalChatPaneScope,
} from "./usePersonalChatPaneScope";
import { projectOnOtherMachine, switchToThisMachineProject } from "../chat/thisMachineProjectRoot";
import { isWebClientMode } from "../../lib/webClientMode";
import { useWebChatsMachines } from "../../webclient/workspace/useWebChatsMachines";
import {
  ADE_OPEN_BUILT_IN_BROWSER_EVENT,
  navigateUrlInAdeBrowser,
  type OpenBuiltInBrowserDetail,
} from "../../lib/openExternal";
import { useAppStore } from "../../state/appStore";
import { openChatInBrowserTab, openUrlInBrowserTab } from "../browser/browserTab";
import { useAgentBrowserPresenceSince } from "../terminals/agentBrowserPresence";
import { ChatSceneBackdrop } from "./ChatSceneBackdrop";
import { useRemoteConnectionSnapshot } from "../../state/projectMachines";
import { rememberExplicitRemotePick } from "../app/usePreferLocalCheckout";
import { remoteProjectBindingKey } from "../../../shared/projectIdentity";
import {
  THIS_MACHINE_ID as LOCAL_MACHINE_ID,
  THIS_MACHINE_NAME as LOCAL_MACHINE_NAME,
} from "../../../shared/machineIdentity";

type ToolPanel = "browser" | "terminal" | null;

/** Ways to start a new chat. A chip fills the composer; the user finishes the sentence. */
const CHAT_SUGGESTIONS: ReadonlyArray<{ label: string; prefill: string }> = [
  { label: "Think through a decision", prefill: "Help me think through a decision I'm facing: " },
  { label: "Draft from a rough idea", prefill: "Help me draft this from a rough idea: " },
  { label: "Research a topic", prefill: "Research this topic with me: " },
  { label: "Plan from my notes", prefill: "Turn these notes into an action plan:\n" },
];

export type PersonalChatsMachineOption = { id: string; name: string };

// Stable empty fallbacks: hosts that seed only part of the app store (tests,
// the projectless standalone shell) must not crash the machine picker.
const EMPTY_REMOTE_TABS: Extract<OpenProjectBinding, { kind: "remote" }>[] = [];
const EMPTY_TAB_ROOTS: string[] = [];
/** Rail refreshes coalesce: a streaming turn emits many events a second. */
const SESSIONS_REFRESH_DEBOUNCE_MS = 400;

function groupLabel(value: string | null | undefined): string {
  const timestamp = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) return "Older";
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  return "Older";
}

// Kept importable from here: the Chats page is where this key is read.
export { resolvePersonalChatsCatalogTargetKey };

export function PersonalChatsPage({ standalone = false }: { standalone?: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const projectBinding = useAppStore((state) => state.projectBinding);
  const openRemoteProjectTabs = useAppStore((state) => state.openRemoteProjectTabs) ?? EMPTY_REMOTE_TABS;
  const openProjectTabRoots = useAppStore((state) => state.openProjectTabRoots) ?? EMPTY_TAB_ROOTS;
  const localProjectRootPath = useAppStore((state) => state.project?.rootPath ?? null);
  const switchProjectToPath = useAppStore((state) => state.switchProjectToPath);
  const switchRemoteProject = useAppStore((state) => state.switchRemoteProject);
  const browserTabOpen = useAppStore((state) => state.browserTabOpen) ?? false;
  const webMachines = useWebChatsMachines();
  const targetKey = useMemo(
    () => resolvePersonalChatsCatalogTargetKey(projectBinding, webMachines),
    [projectBinding, webMachines, webMachines?.machineId],
  );
  const [sessions, setSessions] = useState<AgentChatSessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Bumped only when the user navigates (picks a chat, starts a new one), so a
  // chat created by the pane's own first send keeps the same pane mounted.
  const [paneGeneration, setPaneGeneration] = useState(0);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [toolPanel, setToolPanel] = useState<ToolPanel>(null);
  const [mobileListOpen, setMobileListOpen] = useState(true);
  const targetGenerationRef = useRef(0);
  // The pane owns the draft; chips and the browser panel write to it through
  // the pane's composer handle.
  const composerRef = useRef<AgentChatPaneComposerHandle | null>(null);
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

  // The pane's personal API scope and model catalog for this machine; both
  // reset when the window moves to another machine.
  const { chatScope, catalog, availableModelIds, providerUnavailable } = usePersonalChatPaneScope(targetKey, {
    onError: setError,
  });

  const refreshSessions = useCallback(async (generation = targetGenerationRef.current) => {
    const rows = await callPersonal<AgentChatSessionSummary[]>("list", { includeArchived: false });
    if (generation !== targetGenerationRef.current) return;
    const ordered = [...(Array.isArray(rows) ? rows : [])].sort(
      (left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt),
    );
    setSessions(ordered);
  }, []);

  useEffect(() => {
    const generation = ++targetGenerationRef.current;
    setSessions([]);
    setSelectedId(null);
    setPaneGeneration((value) => value + 1);
    setToolPanel(null);
    setLoading(true);
    setError(null);
    void refreshSessions(generation).catch((reason) => {
      if (generation === targetGenerationRef.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }).finally(() => {
      if (generation === targetGenerationRef.current) setLoading(false);
    });
  }, [refreshSessions, targetKey]);

  // The rail follows the same event stream the pane reads: titles, activity
  // and new chats appear without a manual refresh.
  useEffect(() => {
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
  }, [chatScope, refreshSessions]);

  // A link opens beside the chat when the Browser panel is already showing
  // there. Otherwise, with the Browser tab open, it opens in that tab: the
  // same personal tabs, full size. With neither, the panel opens here.
  const toolPanelRef = useRef(toolPanel);
  toolPanelRef.current = toolPanel;
  const browserTabOpenRef = useRef(browserTabOpen);
  browserTabOpenRef.current = browserTabOpen;
  useEffect(() => {
    const openPersonalBrowser = (rawEvent: Event) => {
      const event = rawEvent as CustomEvent<OpenBuiltInBrowserDetail>;
      if (!event.detail?.url || isWebClientMode()) return;
      event.preventDefault();
      if (toolPanelRef.current !== "browser" && browserTabOpenRef.current) {
        openUrlInBrowserTab(event.detail.url, navigate, () => setError("ADE Browser couldn't open that link. Try again."));
        return;
      }
      setToolPanel("browser");
      navigateUrlInAdeBrowser(event.detail.url, {
        newTab: true,
        tabCollection: "personal",
      }, {
        fallbackToExternal: false,
        onFailure: () => setError("ADE Browser couldn't open that link. Try again."),
      }, event.detail.runtimePin ?? null);
    };
    window.addEventListener(ADE_OPEN_BUILT_IN_BROWSER_EVENT, openPersonalBrowser);
    return () => window.removeEventListener(ADE_OPEN_BUILT_IN_BROWSER_EVENT, openPersonalBrowser);
  }, [navigate]);

  const selectedSession = sessions.find((session) => session.sessionId === selectedId) ?? null;


  const selectSession = useCallback((sessionId: string | null) => {
    setSelectedId(sessionId);
    setPaneGeneration((value) => value + 1);
    setMenuId(null);
    setMobileListOpen(false);
  }, []);

  // `/chats?chat=<id>` opens that chat: the Browser tab's dock sends its chat
  // here to be read full size.
  const requestedChatId = new URLSearchParams(location.search).get("chat");
  useEffect(() => {
    if (!requestedChatId) return;
    selectSession(requestedChatId);
    navigate("/chats", { replace: true });
    // selectSession is stable; only a new request should re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedChatId]);

  const handleSessionCreated = useCallback((session: AgentChatSession) => {
    // Same pane, now locked to the chat its first message created.
    setSelectedId(session.id);
    void refreshSessions().catch(() => undefined);
  }, [refreshSessions]);

  const runRowAction = useCallback(async (label: string, action: () => Promise<unknown>) => {
    setMenuId(null);
    setError(null);
    try {
      await action();
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      setError(`Could not ${label} this chat${detail ? `: ${detail}` : "."}`);
    }
    await refreshSessions().catch(() => undefined);
  }, [refreshSessions]);

  const removeSession = useCallback(async (sessionId: string, action: "archive" | "delete") => {
    await runRowAction(action, () => callPersonal<void>(action, { sessionId }));
    if (selectedId === sessionId) selectSession(null);
  }, [runRowAction, selectSession, selectedId]);

  const renameSession = useCallback((sessionId: string, title: string) => {
    void runRowAction("rename", () => callPersonal("updateSession", { sessionId, title, manuallyNamed: true }));
  }, [runRowAction]);

  const togglePin = useCallback((sessionId: string, pinned: boolean) => {
    void runRowAction(pinned ? "pin" : "unpin", () => callPersonal("setPinned", { sessionId, pinned }));
  }, [runRowAction]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? sessions.filter((session) => `${sessionTitle(session)} ${sessionPreview(session)}`.toLowerCase().includes(needle))
      : sessions;
  }, [query, sessions]);
  const grouped = useMemo(() => {
    const groups = new Map<string, AgentChatSessionSummary[]>();
    for (const session of filtered) {
      const label = session.pinned ? "Pinned" : groupLabel(session.lastActivityAt);
      groups.set(label, [...(groups.get(label) ?? []), session]);
    }
    // Pinned chats lead the rail; the recency groups follow in their order.
    return [...groups.entries()].sort(([left], [right]) => (left === "Pinned" ? -1 : right === "Pinned" ? 1 : 0));
  }, [filtered]);

  const browserAvailable = !isWebClientMode() && Boolean(window.ade?.builtInBrowser);
  // A chat that is browsing, or the one docked in the Browser tab, is one
  // click from its page there.
  const selectedBrowsingSince = useAgentBrowserPresenceSince(selectedId);
  const browserDockChatId = useAppStore((state) => state.browserDock?.chat?.sessionId ?? null);
  const showInBrowserTab = browserAvailable && selectedId != null
    && (selectedBrowsingSince != null || browserDockChatId === selectedId);
  const isRemote = projectBinding?.kind === "remote";
  // Machines are named absolutely — the Chats tab runs on whichever machine this
  // window is bound to, so the name is the fact and the picker is the control.
  // In the browser the same picker rebinds the same page, but there is no
  // "This computer" to offer: every option is one of the account's machines, and picking
  // one points the federated adapter's chats surface at it.
  const machineLabel = webMachines
    ? webMachines.machineLabel ?? "No machine connected"
    : isRemote ? projectBinding.runtimeName : LOCAL_MACHINE_NAME;
  const machineId = webMachines
    ? webMachines.machineId ?? ""
    : isRemote ? projectBinding.targetId : LOCAL_MACHINE_ID;
  // Every connected machine with a project the picker can bind to, whether or
  // not it has an open project tab.
  const { snapshot: remoteSnapshot } = useRemoteConnectionSnapshot(!webMachines);
  const remoteProjectFor = useCallback(
    (targetId: string) =>
      projectOnOtherMachine({
        currentOrigin: projectBinding?.gitOriginUrl,
        openTabProjectId: openRemoteProjectTabs.find((entry) => entry.targetId === targetId)?.projectId,
        machineProjects: remoteSnapshot?.connections
          .find((connection) => connection.target.id === targetId)?.projects ?? [],
      }),
    [openRemoteProjectTabs, projectBinding?.gitOriginUrl, remoteSnapshot],
  );
  const desktopMachineOptions = useMemo<PersonalChatsMachineOption[]>(() => {
    const options: PersonalChatsMachineOption[] = [
      { id: LOCAL_MACHINE_ID, name: LOCAL_MACHINE_NAME },
    ];
    const add = (id: string, name: string) => {
      if (!options.some((option) => option.id === id)) options.push({ id, name });
    };
    for (const tab of openRemoteProjectTabs) add(tab.targetId, tab.runtimeName);
    for (const connection of remoteSnapshot?.connections ?? []) {
      if (connection.state !== "connected" || !remoteProjectFor(connection.target.id)) continue;
      add(connection.target.id, connection.target.name || connection.target.hostname);
    }
    return options;
  }, [openRemoteProjectTabs, remoteProjectFor, remoteSnapshot]);
  const machineOptions = webMachines ? webMachines.options : desktopMachineOptions;
  const selectMachine = useCallback(
    (nextMachineId: string) => {
      if (nextMachineId === machineId) return;
      setError(null);
      if (webMachines) {
        void webMachines.select(nextMachineId).then(setError);
        return;
      }
      if (nextMachineId === LOCAL_MACHINE_ID) {
        // The machine is a dimension of THIS repo's tab, so "This computer" must
        // resolve to this repo's local checkout — never to whichever local tab
        // happens to be first.
        void switchToThisMachineProject({
          projectBinding,
          openProjectTabRoots,
          localProjectRootPath,
          switchProjectToPath,
        }).then(setError);
        return;
      }
      const projectId = remoteProjectFor(nextMachineId);
      if (!projectId) return;
      // A machine picked here is a choice, so the tab keeps it rather than
      // moving back to this computer's checkout.
      rememberExplicitRemotePick(remoteProjectBindingKey(nextMachineId, projectId));
      void switchRemoteProject(nextMachineId, projectId).catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    },
    [
      localProjectRootPath,
      machineId,
      openProjectTabRoots,
      projectBinding,
      remoteProjectFor,
      switchProjectToPath,
      switchRemoteProject,
      webMachines,
    ],
  );
  const showReconnecting = Boolean(error) && isRemote;
  const title = selectedSession ? sessionTitle(selectedSession) : "New chat";

  return (
    <div className="ade-chat-scene relative flex h-full min-h-0 text-fg" data-testid="personal-chats-page" data-target={targetKey}>
      <ChatSceneBackdrop />
      <ProjectlessSidebar
        standalone={standalone}
        machineLabel={machineLabel}
        machineId={machineId}
        machineOptions={machineOptions}
        onSelectMachine={selectMachine}
        grouped={grouped}
        loading={loading}
        query={query}
        onQueryChange={setQuery}
        selectedId={selectedId}
        onSelect={selectSession}
        onNewChat={() => selectSession(null)}
        onBack={() => navigate("/work")}
        mobileListOpen={mobileListOpen}
        menuId={menuId}
        onToggleMenu={setMenuId}
        onRemove={(id, action) => void removeSession(id, action)}
        onRename={renameSession}
        onTogglePin={togglePin}
      />

      <main className="ade-chat-scene-plane relative flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-fg/[0.055] px-3">
          <button type="button" className="hidden h-7 w-7 items-center justify-center rounded-md text-muted-fg/55 hover:bg-fg/[0.06] max-md:flex" onClick={() => setMobileListOpen(true)} aria-label="Show chats"><ArrowLeft size={15} /></button>
          <div className="min-w-0 flex-1 truncate font-sans text-[12px] font-medium text-fg/75">{title}</div>
          {showReconnecting ? (
            <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-amber-400/20 bg-amber-500/10 px-2 py-0.5 font-sans text-[10px] text-amber-200/80">
              <SpinnerGap size={11} className="animate-spin" /> Reconnecting…
            </span>
          ) : null}
          {showInBrowserTab && selectedId ? (
            <button type="button" onClick={() => void openChatInBrowserTab(selectedId, targetKey, navigate).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))} className="flex h-7 w-7 items-center justify-center rounded-md border border-fg/[0.06] bg-fg/[0.025] text-muted-fg/45 transition-colors hover:text-fg" title="Show beside its page in the Browser tab" aria-label="Show in the Browser tab"><AppWindow size={14} /></button>
          ) : null}
          {browserAvailable ? (
            <button type="button" onClick={() => setToolPanel((current) => current === "browser" ? null : "browser")} className={cn("flex h-7 w-7 items-center justify-center rounded-md border transition-colors", toolPanel === "browser" ? "border-sky-300/25 bg-sky-500/10 text-sky-200" : "border-fg/[0.06] bg-fg/[0.025] text-muted-fg/45 hover:text-fg")} title="Browser" aria-label="Toggle browser"><Globe size={14} /></button>
          ) : null}
          <button type="button" onClick={() => setToolPanel((current) => current === "terminal" ? null : "terminal")} className={cn("flex h-7 w-7 items-center justify-center rounded-md border transition-colors", toolPanel === "terminal" ? "border-violet-300/25 bg-violet-500/10 text-violet-200" : "border-fg/[0.06] bg-fg/[0.025] text-muted-fg/45 hover:text-fg")} title="Terminal" aria-label="Toggle terminal"><TerminalWindow size={14} /></button>
        </div>
        {error ? (
          <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-rose-400/15 bg-rose-500/[0.06] px-3 py-1.5 font-sans text-[11px] text-rose-200/80">
            <span className="min-w-0 flex-1 truncate">{error}</span>
            <button type="button" onClick={() => setError(null)} className="shrink-0 text-rose-200/60 hover:text-rose-100">Dismiss</button>
          </div>
        ) : null}
        {providerUnavailable && !selectedSession ? (
          <div className="shrink-0 border-b border-amber-400/15 bg-amber-500/[0.06] px-3 py-1.5 font-sans text-[11px] text-amber-200/80">
            No connected agent is available right now. Sign in to a provider from Settings to start a chat.
          </div>
        ) : null}
        <div className="relative flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">
            {loading && selectedId == null && catalog == null ? (
              <div className="flex h-full items-center justify-center"><SpinnerGap size={22} className="animate-spin text-muted-fg/35" /></div>
            ) : (
              <AgentChatPane
                key={`${targetKey}:${paneGeneration}`}
                laneId={null}
                chatScope={chatScope}
                lockSessionId={selectedId}
                lockSessionProvider={selectedSession?.provider ?? null}
                initialSessionSummary={selectedSession}
                availableModelIdsOverride={availableModelIds}
                onSessionCreated={handleSessionCreated}
                composerHandleRef={composerRef}
                emptyStateAccessory={providerUnavailable ? null : <SuggestionChips prompts={CHAT_SUGGESTIONS} onSelect={setComposerDraft} />}
                canvasFill="var(--ade-chat-scene-canvas)"
                hideSessionTabs
                hideWorkspaceChrome
                hideSurfaceHeader
                hideLaneToolDrawers
                shouldAutofocusComposer
                presentation={{
                  mode: "standard",
                  title,
                  assistantLabel: selectedSession ? sessionTitle(selectedSession) : "ADE",
                  messagePlaceholder: "Ask anything, or have the agent do it…",
                }}
              />
            )}
          </div>
          {/* The panels sit outside the pane, so they get the same API scope:
              a screenshot inserted from the browser lands in this chat's
              attachment store, not the active project's. */}
          <AgentChatApiProvider scope={chatScope}>
            {toolPanel === "browser" ? (
              <div className="w-[min(44%,560px)] min-w-[340px] border-l border-fg/[0.07] bg-bg max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-30 max-lg:w-[min(92%,560px)] max-lg:shadow-2xl">
                <ChatBuiltInBrowserPanel
                  sessionId={selectedId}
                  projectRootOverride={null}
                  onInsertDraft={insertIntoComposer}
                  onAddContext={addBrowserContextToComposer}
                  onAddAttachment={attachToComposer}
                  onAttachTab={(tab) => insertIntoComposer(formatBrowserTabMentionToken(tab))}
                />
              </div>
            ) : null}
            {toolPanel === "terminal" ? (
              <div className="w-[min(44%,560px)] min-w-[340px] border-l border-fg/[0.07] bg-bg max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-30 max-lg:w-[min(92%,560px)] max-lg:shadow-2xl">
                <PersonalTerminalPanel chatSessionId={selectedId} onClose={() => setToolPanel(null)} />
              </div>
            ) : null}
          </AgentChatApiProvider>
        </div>
      </main>
    </div>
  );
}
