import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Globe, SpinnerGap, TerminalWindow } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import type {
  AgentChatFileRef,
  AgentChatModelCatalog,
  AgentChatSession,
  AgentChatSessionSummary,
  OpenProjectBinding,
  PersonalChatAction,
  PersonalChatCallResponse,
} from "../../../shared/types";
import { cn } from "../ui/cn";
import { AgentChatPane, type AgentChatPaneComposerHandle } from "../chat/AgentChatPane";
import { AgentChatApiProvider, type ChatPaneScope } from "../chat/agentChatApi";
import { ChatBuiltInBrowserPanel } from "../chat/ChatBuiltInBrowserPanel";
import { PersonalTerminalPanel } from "./PersonalTerminalPanel";
import { ProjectlessSidebar } from "./ProjectlessSidebar";
import { sessionPreview, sessionTitle } from "./sessionHelpers";
import { createPersonalAgentChatApi, type PersonalChatsBridge } from "./personalAgentChatApi";
import { projectOnOtherMachine, switchToThisMachineProject } from "../chat/thisMachineProjectRoot";
import {
  agentChatModelCatalogHasAvailableModels,
  descriptorsFromAgentChatModelCatalog,
  personalChatCatalogScopeKey,
} from "../shared/ModelPicker/modelCatalog";
import { isWebClientMode } from "../../lib/webClientMode";
import { useWebChatsMachines, type WebChatsMachinePicker } from "../../webclient/workspace/useWebChatsMachines";
import {
  ADE_OPEN_BUILT_IN_BROWSER_EVENT,
  navigateUrlInAdeBrowser,
  type OpenBuiltInBrowserDetail,
} from "../../lib/openExternal";
import { useAppStore } from "../../state/appStore";
import { useRemoteConnectionSnapshot } from "../../state/projectMachines";
import { rememberExplicitRemotePick } from "../app/usePreferLocalCheckout";
import { remoteProjectBindingKey } from "../../../shared/projectIdentity";
import {
  THIS_MACHINE_ID as LOCAL_MACHINE_ID,
  THIS_MACHINE_NAME as LOCAL_MACHINE_NAME,
} from "../../../shared/machineIdentity";

type ToolPanel = "browser" | "terminal" | null;

/** Ways to start a new chat. A chip fills the composer; the user finishes the sentence. */
const SUGGESTION_PROMPTS: ReadonlyArray<{ label: string; prefill: string }> = [
  { label: "Think through a decision", prefill: "Help me think through a decision I'm facing: " },
  { label: "Draft from a rough idea", prefill: "Help me draft this from a rough idea: " },
  { label: "Research a topic", prefill: "Research this topic with me: " },
  { label: "Plan from my notes", prefill: "Turn these notes into an action plan:\n" },
];

function SuggestionChips({ onSelect }: { onSelect: (prefill: string) => void }) {
  return (
    <div className="flex flex-wrap justify-center gap-1.5" aria-label="Suggestions">
      {SUGGESTION_PROMPTS.map((prompt) => (
        <button
          key={prompt.label}
          type="button"
          onClick={() => onSelect(prompt.prefill)}
          className="h-7 rounded-full border border-fg/[0.08] bg-fg/[0.03] px-3 font-sans text-[11px] text-fg/65 transition-colors hover:border-fg/[0.14] hover:bg-fg/[0.06] hover:text-fg/85"
        >
          {prompt.label}
        </button>
      ))}
    </div>
  );
}

export type PersonalChatsMachineOption = { id: string; name: string };

// Stable empty fallbacks: hosts that seed only part of the app store (tests,
// the projectless standalone shell) must not crash the machine picker.
const EMPTY_REMOTE_TABS: Extract<OpenProjectBinding, { kind: "remote" }>[] = [];
const EMPTY_TAB_ROOTS: string[] = [];
/** Rail refreshes coalesce: a streaming turn emits many events a second. */
const SESSIONS_REFRESH_DEBOUNCE_MS = 400;

function bridge(): PersonalChatsBridge {
  const candidate = (window.ade as typeof window.ade & { personalChats?: PersonalChatsBridge }).personalChats;
  if (!candidate) throw new Error("Personal chats are not available in this ADE runtime.");
  return candidate;
}

function resultOf<T>(response: PersonalChatCallResponse | T): T {
  if (response && typeof response === "object" && "result" in response) {
    return (response as PersonalChatCallResponse).result as T;
  }
  return response as T;
}

async function callPersonal<T>(action: PersonalChatAction, args?: Record<string, unknown>): Promise<T> {
  const request = (args === undefined ? { action } : { action, args }) as Parameters<PersonalChatsBridge["call"]>[0];
  return resultOf<T>(await bridge().call(request));
}

function groupLabel(value: string | null | undefined): string {
  const timestamp = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) return "Older";
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  return "Older";
}

/** Machine identity for personal Chats catalog scope and target-scoped reload effects. */
export function resolvePersonalChatsCatalogTargetKey(
  projectBinding: OpenProjectBinding | null | undefined,
  webMachines: WebChatsMachinePicker | null,
): string {
  if (webMachines) {
    const webKey = webMachines.machineId?.trim();
    return webKey ? `web:${webKey}` : "web:pending";
  }
  return projectBinding?.kind === "remote" ? projectBinding.key : "local-machine";
}

export function PersonalChatsPage({ standalone = false }: { standalone?: boolean }) {
  const navigate = useNavigate();
  const projectBinding = useAppStore((state) => state.projectBinding);
  const openRemoteProjectTabs = useAppStore((state) => state.openRemoteProjectTabs) ?? EMPTY_REMOTE_TABS;
  const openProjectTabRoots = useAppStore((state) => state.openProjectTabRoots) ?? EMPTY_TAB_ROOTS;
  const localProjectRootPath = useAppStore((state) => state.project?.rootPath ?? null);
  const switchProjectToPath = useAppStore((state) => state.switchProjectToPath);
  const switchRemoteProject = useAppStore((state) => state.switchRemoteProject);
  const webMachines = useWebChatsMachines();
  const targetKey = useMemo(
    () => resolvePersonalChatsCatalogTargetKey(projectBinding, webMachines),
    [projectBinding, webMachines, webMachines?.machineId],
  );
  const personalCatalogScopeKey = personalChatCatalogScopeKey(targetKey);
  const personalCatalogScopeKeyRef = useRef(personalCatalogScopeKey);
  personalCatalogScopeKeyRef.current = personalCatalogScopeKey;
  const [sessions, setSessions] = useState<AgentChatSessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Bumped only when the user navigates (picks a chat, starts a new one), so a
  // chat created by the pane's own first send keeps the same pane mounted.
  const [paneGeneration, setPaneGeneration] = useState(0);
  const [catalog, setCatalog] = useState<AgentChatModelCatalog | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [toolPanel, setToolPanel] = useState<ToolPanel>(null);
  const [mobileListOpen, setMobileListOpen] = useState(true);
  const targetGenerationRef = useRef(0);
  const catalogRequestSeqRef = useRef(0);
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

  // The one routing decision for the pane: every chat call it makes goes to
  // this machine's personal scope. Rebuilt per machine so a switched window
  // never keeps polling the previous machine's stream.
  const chatScope = useMemo<ChatPaneScope>(() => ({
    kind: "personal",
    // Resolved per call, so a runtime without personal chats surfaces as a
    // call error in the page rather than a render crash.
    agentChat: createPersonalAgentChatApi({
      call: (request) => bridge().call(request),
      streamEvents: (request) => bridge().streamEvents(request),
    }),
    modelCatalogScopeKey: personalCatalogScopeKey,
  }), [personalCatalogScopeKey]);

  const refreshSessions = useCallback(async (generation = targetGenerationRef.current) => {
    const rows = await callPersonal<AgentChatSessionSummary[]>("list", { includeArchived: false });
    if (generation !== targetGenerationRef.current) return;
    const ordered = [...(Array.isArray(rows) ? rows : [])].sort(
      (left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt),
    );
    setSessions(ordered);
  }, []);

  const loadModelCatalog = useCallback(async (
    mode: "cached" | "refresh-stale" | "force" = "refresh-stale",
    generation = targetGenerationRef.current,
  ) => {
    const requestId = ++catalogRequestSeqRef.current;
    const scopeKey = personalCatalogScopeKeyRef.current;
    const publish = (next: AgentChatModelCatalog) => {
      if (generation !== targetGenerationRef.current) return;
      if (requestId !== catalogRequestSeqRef.current) return;
      if (scopeKey !== personalCatalogScopeKeyRef.current) return;
      setCatalog(next);
    };
    let next = await callPersonal<AgentChatModelCatalog>("modelCatalog", { mode });
    publish(next);
    if (generation !== targetGenerationRef.current || requestId !== catalogRequestSeqRef.current) return;
    if (
      mode === "refresh-stale"
      && (next.stale === true || !agentChatModelCatalogHasAvailableModels(next))
    ) {
      next = await callPersonal<AgentChatModelCatalog>("modelCatalog", { mode: "force" });
      publish(next);
    }
  }, []);

  useEffect(() => {
    const generation = ++targetGenerationRef.current;
    catalogRequestSeqRef.current += 1;
    setSessions([]);
    setSelectedId(null);
    setPaneGeneration((value) => value + 1);
    setToolPanel(null);
    setCatalog(null);
    setLoading(true);
    setError(null);
    void refreshSessions(generation).catch((reason) => {
      if (generation === targetGenerationRef.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }).finally(() => {
      if (generation === targetGenerationRef.current) setLoading(false);
    });
    void loadModelCatalog("refresh-stale", generation).catch((reason) => {
      if (generation === targetGenerationRef.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    });
  }, [loadModelCatalog, refreshSessions, targetKey]);

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

  useEffect(() => {
    const openPersonalBrowser = (rawEvent: Event) => {
      const event = rawEvent as CustomEvent<OpenBuiltInBrowserDetail>;
      if (!event.detail?.url || isWebClientMode()) return;
      event.preventDefault();
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
  }, []);

  const selectedSession = sessions.find((session) => session.sessionId === selectedId) ?? null;
  // Registers the personal catalog's descriptors under its scope key, which is
  // where the pane's model picker reads them.
  const availableModelIds = useMemo(
    () => (catalog ? descriptorsFromAgentChatModelCatalog(catalog, undefined, personalCatalogScopeKey).availableModelIds : []),
    [catalog, personalCatalogScopeKey],
  );

  const selectSession = useCallback((sessionId: string | null) => {
    setSelectedId(sessionId);
    setPaneGeneration((value) => value + 1);
    setMenuId(null);
    setMobileListOpen(false);
  }, []);

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
  // Only declare the provider unavailable once the catalog has actually
  // loaded — an in-flight fetch is not "no provider".
  const providerUnavailable = catalog !== null && availableModelIds.length === 0;
  const showReconnecting = Boolean(error) && isRemote;
  const title = selectedSession ? sessionTitle(selectedSession) : "New chat";

  return (
    <div className="flex h-full min-h-0 bg-bg text-fg" data-testid="personal-chats-page" data-target={targetKey}>
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

      <main className="relative flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-fg/[0.055] px-3">
          <button type="button" className="hidden h-7 w-7 items-center justify-center rounded-md text-muted-fg/55 hover:bg-fg/[0.06] max-md:flex" onClick={() => setMobileListOpen(true)} aria-label="Show chats"><ArrowLeft size={15} /></button>
          <div className="min-w-0 flex-1 truncate font-sans text-[12px] font-medium text-fg/75">{title}</div>
          {showReconnecting ? (
            <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-amber-400/20 bg-amber-500/10 px-2 py-0.5 font-sans text-[10px] text-amber-200/80">
              <SpinnerGap size={11} className="animate-spin" /> Reconnecting…
            </span>
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
                emptyStateAccessory={providerUnavailable ? null : <SuggestionChips onSelect={setComposerDraft} />}
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
