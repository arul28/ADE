import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatBrowserTabMentionToken } from "../../../shared/browserTabMention";
import {
  AppWindow,
  Archive,
  ArrowCounterClockwise,
  ArrowLeft,
  Copy,
  Globe,
  PencilSimple,
  PushPin,
  PushPinSlash,
  SpinnerGap,
  Stop,
  TerminalWindow,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useLocation, useNavigate } from "react-router-dom";
import type {
  AgentChatFileRef,
  AgentChatSession,
  AgentChatSessionSummary,
  OpenProjectBinding,
} from "../../../shared/types";
import { cn } from "../ui/cn";
import { Banner } from "../ui/notice";
import { ContextMenu, type ContextMenuEntry } from "../ui/ContextMenu";
import { confirmDialog } from "../ui/dialog/confirm";
import { showToast } from "../app/toast/toastStore";
import { AgentChatPane, type AgentChatPaneComposerHandle } from "../chat/AgentChatPane";
import { AgentChatApiProvider } from "../chat/agentChatApi";
import { ChatBuiltInBrowserPanel } from "../chat/ChatBuiltInBrowserPanel";
import { DraftMachinePicker } from "../chat/DraftMachinePicker";
import { PersonalTerminalPanel } from "./PersonalTerminalPanel";
import { ProjectlessSidebar } from "./ProjectlessSidebar";
import { CHAT_HEADER_BUTTON, sessionPreview, sessionTitle } from "./sessionHelpers";
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
const EMPTY_SELECTION: ReadonlySet<string> = new Set();
/** Same look as the Work sidebar's selection toolbar. */
const BULK_ACTION_BUTTON_CLASS =
  "inline-flex h-6 items-center gap-1 rounded-md px-1.5 font-sans text-[10px] font-medium text-muted-fg transition-colors hover:bg-fg/[0.04] hover:text-fg";
const BULK_DESTRUCTIVE_BUTTON_CLASS =
  "inline-flex h-6 items-center gap-1 rounded-md px-1.5 font-sans text-[10px] font-medium text-red-300/75 transition-colors hover:bg-red-500/10 hover:text-red-200";

/** A row's menu: the rows it acts on (one, or the whole multi-selection) and where it opened. */
type RowMenuState = { x: number; y: number; anchorId: string; targetIds: string[] } | null;

function errorDetail(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** Copy from a menu that has already closed, so a refused write still says so. */
function copyToClipboard(text: string, what: string): void {
  void navigator.clipboard.writeText(text).catch(() => {
    showToast({ title: `Could not copy ${what}`, tone: "error" });
  });
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
  const [rowMenu, setRowMenu] = useState<RowMenuState>(null);
  // Rows picked with shift / cmd / ctrl-click. Separate from `selectedId`
  // (the chat open in the pane), as in the Work sidebar.
  const [multiSelectedIds, setMultiSelectedIds] = useState<ReadonlySet<string>>(EMPTY_SELECTION);
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // The rail lists archived chats instead of live ones, so they can come back.
  const [showArchived, setShowArchived] = useState(false);
  const showArchivedRef = useRef(showArchived);
  showArchivedRef.current = showArchived;
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
    const archived = showArchivedRef.current;
    const rows = await callPersonal<AgentChatSessionSummary[]>("list", { includeArchived: archived });
    // A reply for the other view (the toggle moved mid-flight) is dropped too.
    if (generation !== targetGenerationRef.current || archived !== showArchivedRef.current) return;
    const listed = Array.isArray(rows) ? rows : [];
    // `includeArchived` returns live chats as well; the archived view shows only the archived ones.
    const inView = listed.filter((session) => Boolean(session.archivedAt) === archived);
    const ordered = [...inView].sort(
      (left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt),
    );
    setSessions(ordered);
  }, []);

  useEffect(() => {
    const generation = ++targetGenerationRef.current;
    setSessions([]);
    setSelectedId(null);
    setMultiSelectedIds(EMPTY_SELECTION);
    setSelectionAnchorId(null);
    setRowMenu(null);
    setRenamingId(null);
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

  // Switching between live and archived chats reloads the rail; the open chat stays open.
  const archivedViewInitializedRef = useRef(false);
  useEffect(() => {
    if (!archivedViewInitializedRef.current) {
      archivedViewInitializedRef.current = true;
      return;
    }
    const generation = targetGenerationRef.current;
    setSessions([]);
    setMultiSelectedIds(EMPTY_SELECTION);
    setSelectionAnchorId(null);
    setRowMenu(null);
    setRenamingId(null);
    setLoading(true);
    void refreshSessions(generation).catch((reason) => {
      if (generation === targetGenerationRef.current) setError(errorDetail(reason));
    }).finally(() => {
      if (generation === targetGenerationRef.current) setLoading(false);
    });
  }, [refreshSessions, showArchived]);

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

  // The open chat keeps its summary while the rail shows the other view
  // (archived chats), where its row is not listed.
  const lastSelectedSessionRef = useRef<AgentChatSessionSummary | null>(null);
  const listedSelectedSession = sessions.find((session) => session.sessionId === selectedId) ?? null;
  if (listedSelectedSession) lastSelectedSessionRef.current = listedSelectedSession;
  const selectedSession = listedSelectedSession
    ?? (lastSelectedSessionRef.current?.sessionId === selectedId ? lastSelectedSessionRef.current : null);


  const selectSession = useCallback((sessionId: string | null) => {
    setSelectedId(sessionId);
    setPaneGeneration((value) => value + 1);
    setRowMenu(null);
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

  // The rail's rows in the order they are drawn: what a shift-click range and
  // the arrow keys walk.
  const orderedIds = useMemo(
    () => grouped.flatMap(([, rows]) => rows.map((session) => session.sessionId)),
    [grouped],
  );
  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.sessionId, session] as const)),
    [sessions],
  );

  // A selected row that leaves the rail (deleted, archived elsewhere, filtered
  // out by search) leaves the selection with it.
  useEffect(() => {
    const visible = new Set(orderedIds);
    setMultiSelectedIds((current) => {
      if (current.size === 0) return current;
      const next = new Set([...current].filter((id) => visible.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [orderedIds]);

  const clearSelection = useCallback(() => {
    setMultiSelectedIds(EMPTY_SELECTION);
    setSelectionAnchorId(null);
  }, []);

  /**
   * Runs one action over every chat it names, each on its own: one chat that
   * refuses does not stop the rest. Failures are reported with a count.
   */
  const runChatAction = useCallback(async (
    verb: string,
    ids: string[],
    action: (sessionId: string) => Promise<unknown>,
  ): Promise<string[]> => {
    setRowMenu(null);
    setError(null);
    const succeeded: string[] = [];
    let firstFailure: unknown = null;
    for (const sessionId of ids) {
      try {
        await action(sessionId);
        succeeded.push(sessionId);
      } catch (reason) {
        firstFailure ??= reason;
      }
    }
    if (firstFailure != null) {
      const detail = errorDetail(firstFailure);
      setError(ids.length === 1
        ? `Could not ${verb} this chat${detail ? `: ${detail}` : "."}`
        : `Could not ${verb} ${ids.length - succeeded.length} of ${ids.length} chats${detail ? `: ${detail}` : "."}`);
    }
    await refreshSessions().catch(() => undefined);
    return succeeded;
  }, [refreshSessions]);

  const removeChats = useCallback(async (ids: string[], action: "archive" | "unarchive" | "delete") => {
    if (ids.length === 0) return;
    if (action === "delete") {
      const only = ids.length === 1 ? sessionsById.get(ids[0]!) : undefined;
      const confirmed = await confirmDialog({
        title: ids.length === 1
          ? `Delete "${only ? sessionTitle(only) : "this chat"}"?`
          : `Delete ${ids.length} chats?`,
        message: ids.length === 1
          ? "This permanently removes the chat and its history."
          : "This permanently removes the selected chats and their history.",
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!confirmed) return;
    }
    const done = await runChatAction(action, ids, (sessionId) => callPersonal<void>(action, { sessionId }));
    // An archived or deleted chat leaves the pane; an unarchived one stays open.
    if (selectedId && done.includes(selectedId) && action !== "unarchive") selectSession(null);
    setMultiSelectedIds((current) => {
      if (!done.some((id) => current.has(id))) return current;
      return new Set([...current].filter((id) => !done.includes(id)));
    });
  }, [runChatAction, selectSession, selectedId, sessionsById]);

  const renameSession = useCallback((sessionId: string, title: string) => {
    setRenamingId(null);
    void runChatAction("rename", [sessionId], () => callPersonal("updateSession", { sessionId, title, manuallyNamed: true }));
  }, [runChatAction]);

  // An older host has no `setPinned` (personal-chat capabilities are not
  // exposed to this page): its refusal hides Pin for that machine instead of
  // surfacing as an error.
  const [pinUnsupportedTarget, setPinUnsupportedTarget] = useState<string | null>(null);
  const pinSupported = pinUnsupportedTarget !== targetKey;
  const setPinned = useCallback((ids: string[], pinned: boolean) => {
    let unsupported = false;
    void runChatAction(pinned ? "pin" : "unpin", ids, async (sessionId) => {
      if (unsupported) return;
      try {
        await callPersonal("setPinned", { sessionId, pinned });
      } catch (reason) {
        if (!errorDetail(reason).includes("Unsupported personal chat action")) throw reason;
        unsupported = true;
        setPinUnsupportedTarget(targetKey);
      }
    });
  }, [runChatAction, targetKey]);

  const stopChats = useCallback((ids: string[]) => {
    void runChatAction("stop", ids, (sessionId) => callPersonal("interrupt", { sessionId }));
  }, [runChatAction]);

  /** Selected rows, in rail order. */
  const selectedRowIds = useMemo(
    () => orderedIds.filter((id) => multiSelectedIds.has(id)),
    [multiSelectedIds, orderedIds],
  );

  /**
   * Plain click opens the chat. Shift-click selects the range from the anchor;
   * cmd-click (ctrl-click on Windows and Linux) adds or removes one row. The
   * chat already open counts as the first pick, so cmd-clicking a second row
   * selects both.
   */
  const handleRowClick = useCallback((id: string, event: React.MouseEvent) => {
    const useRange = event.shiftKey;
    const useToggle = event.metaKey || event.ctrlKey;
    if (useRange) {
      const anchorId = [selectionAnchorId, selectedId, id]
        .find((candidate) => candidate != null && orderedIds.includes(candidate)) ?? id;
      const from = orderedIds.indexOf(anchorId);
      const to = orderedIds.indexOf(id);
      if (from >= 0 && to >= 0) {
        const [start, end] = from <= to ? [from, to] : [to, from];
        setMultiSelectedIds(new Set(orderedIds.slice(start, end + 1)));
        setSelectionAnchorId(anchorId);
        return;
      }
    }
    if (useToggle || useRange) {
      setMultiSelectedIds((current) => {
        const next = new Set(current);
        if (next.size === 0 && selectedId && selectedId !== id && orderedIds.includes(selectedId)) next.add(selectedId);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setSelectionAnchorId(id);
      return;
    }
    clearSelection();
    setSelectionAnchorId(id);
    selectSession(id);
  }, [clearSelection, orderedIds, selectSession, selectedId, selectionAnchorId]);

  // Right-clicking a row inside a multi-selection acts on the selection, the
  // way the Work sidebar (and Finder) does; any other row gets its own menu.
  const openRowMenu = useCallback((id: string, position: { x: number; y: number }) => {
    const targetIds = multiSelectedIds.size > 1 && multiSelectedIds.has(id) ? selectedRowIds : [id];
    setRowMenu({ ...position, anchorId: id, targetIds });
  }, [multiSelectedIds, selectedRowIds]);

  const browserAvailable = !isWebClientMode() && Boolean(window.ade?.builtInBrowser);

  const rowMenuEntries = useMemo((): ContextMenuEntry[] => {
    if (!rowMenu) return [];
    const targets = rowMenu.targetIds
      .map((id) => sessionsById.get(id))
      .filter((session): session is AgentChatSessionSummary => session != null);
    if (targets.length === 0) return [];
    const ids = targets.map((session) => session.sessionId);
    const total = targets.length;
    const hint = (count: number) => (total > 1 && count < total ? `${count} of ${total}` : undefined);
    const unpinned = targets.filter((session) => !session.pinned).map((session) => session.sessionId);
    const running = targets.filter((session) => session.status === "active").map((session) => session.sessionId);
    const archived = targets.filter((session) => session.archivedAt).map((session) => session.sessionId);
    const live = targets.filter((session) => !session.archivedAt).map((session) => session.sessionId);
    const plural = total > 1 ? ` ${total}` : "";
    const single = total === 1 ? targets[0]! : null;

    return [
      ...(total > 1 ? [{ kind: "label" as const, key: "count", label: `${total} selected` }] : []),
      ...(single
        ? [{
            kind: "item" as const,
            key: "rename",
            label: "Rename",
            icon: PencilSimple,
            onSelect: () => setRenamingId(single.sessionId),
          }]
        : []),
      ...(pinSupported
        ? [unpinned.length
            ? {
                kind: "item" as const,
                key: "pin",
                label: "Pin",
                icon: PushPin,
                hint: hint(unpinned.length),
                onSelect: () => setPinned(unpinned, true),
              }
            : {
                kind: "item" as const,
                key: "unpin",
                label: "Unpin",
                icon: PushPinSlash,
                onSelect: () => setPinned(ids, false),
              }]
        : []),
      ...(running.length
        ? [{
            kind: "item" as const,
            key: "stop",
            label: "Stop",
            icon: Stop,
            hint: hint(running.length),
            title: "Stop the turn in progress",
            onSelect: () => stopChats(running),
          }]
        : []),
      ...(single && browserAvailable
        ? [{
            kind: "item" as const,
            key: "browser-tab",
            label: "Open in the Browser tab",
            icon: AppWindow,
            onSelect: () => {
              void openChatInBrowserTab(single.sessionId, targetKey, navigate)
                .catch((reason) => setError(errorDetail(reason)));
            },
          }]
        : []),
      { kind: "separator", key: "copy-sep" },
      {
        kind: "item",
        key: "copy-id",
        label: total > 1 ? "Copy chat IDs" : "Copy chat ID",
        icon: Copy,
        onSelect: () => copyToClipboard(ids.join("\n"), total > 1 ? "chat IDs" : "chat ID"),
      },
      ...(total > 1
        ? [{ kind: "item" as const, key: "clear", label: "Clear selection", icon: X, onSelect: clearSelection }]
        : []),
      { kind: "separator", key: "remove-sep" },
      ...(live.length
        ? [{
            kind: "item" as const,
            key: "archive",
            label: `Archive${plural}`,
            icon: Archive,
            hint: hint(live.length),
            onSelect: () => void removeChats(live, "archive"),
          }]
        : []),
      ...(archived.length
        ? [{
            kind: "item" as const,
            key: "unarchive",
            label: `Unarchive${plural}`,
            icon: ArrowCounterClockwise,
            hint: hint(archived.length),
            onSelect: () => void removeChats(archived, "unarchive"),
          }]
        : []),
      {
        kind: "item",
        key: "delete",
        label: total > 1 ? `Delete ${total}…` : "Delete…",
        icon: Trash,
        danger: true,
        onSelect: () => void removeChats(ids, "delete"),
      },
    ];
  }, [
    browserAvailable,
    clearSelection,
    navigate,
    pinSupported,
    removeChats,
    rowMenu,
    sessionsById,
    setPinned,
    stopChats,
    targetKey,
  ]);

  const focusRow = useCallback((id: string) => {
    const row = Array.from(document.querySelectorAll<HTMLElement>("[data-chat-row-id]"))
      .find((element) => element.dataset.chatRowId === id);
    const button = row?.querySelector<HTMLButtonElement>("button");
    button?.focus();
    button?.scrollIntoView({ block: "nearest" });
  }, []);

  /**
   * Keys on a focused row: arrows move focus (shift extends the selection),
   * Enter opens (the row is a button), Delete or Backspace deletes the
   * selection or the focused row after a confirm, Escape clears the selection,
   * cmd/ctrl+A selects every listed chat. Typing in the rename field is left alone.
   */
  const handleListKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, [contenteditable='true']")) return;
    const rowId = target.closest<HTMLElement>("[data-chat-row-id]")?.dataset.chatRowId ?? null;
    const mod = event.metaKey || event.ctrlKey;
    switch (event.key) {
      case "Escape": {
        if (multiSelectedIds.size === 0) return;
        event.preventDefault();
        clearSelection();
        return;
      }
      case "Delete":
      case "Backspace": {
        const ids = selectedRowIds.length ? selectedRowIds : rowId ? [rowId] : [];
        if (ids.length === 0) return;
        event.preventDefault();
        void removeChats(ids, "delete");
        return;
      }
      case "ArrowDown":
      case "ArrowUp": {
        if (orderedIds.length === 0) return;
        event.preventDefault();
        const from = rowId ?? selectedId;
        const index = from ? orderedIds.indexOf(from) : -1;
        const step = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex = index < 0
          ? (step > 0 ? 0 : orderedIds.length - 1)
          : Math.min(orderedIds.length - 1, Math.max(0, index + step));
        const nextId = orderedIds[nextIndex]!;
        if (event.shiftKey) {
          const anchorId = [selectionAnchorId, from]
            .find((candidate) => candidate != null && orderedIds.includes(candidate)) ?? nextId;
          const anchorIndex = orderedIds.indexOf(anchorId);
          const [start, end] = anchorIndex <= nextIndex ? [anchorIndex, nextIndex] : [nextIndex, anchorIndex];
          setMultiSelectedIds(new Set(orderedIds.slice(start, end + 1)));
          setSelectionAnchorId(anchorId);
        }
        focusRow(nextId);
        return;
      }
      case "a":
      case "A": {
        if (!mod || orderedIds.length === 0) return;
        event.preventDefault();
        setMultiSelectedIds(new Set(orderedIds));
        setSelectionAnchorId(orderedIds[0]!);
        return;
      }
      default:
    }
  }, [clearSelection, focusRow, multiSelectedIds.size, orderedIds, removeChats, selectedId, selectedRowIds, selectionAnchorId]);

  const selectedRows = selectedRowIds
    .map((id) => sessionsById.get(id))
    .filter((session): session is AgentChatSessionSummary => session != null);
  const selectionToolbar = selectedRows.length > 0 ? (
    <div
      className="mx-3 mb-2 flex min-h-8 flex-wrap items-center gap-0.5 border-t border-fg/[0.06] px-1 pt-1"
      data-testid="personal-chats-selection-toolbar"
    >
      <span className="min-w-0 flex-1 truncate px-1 font-sans text-[10px] font-medium tabular-nums text-muted-fg/70">
        {selectedRows.length} selected
      </span>
      {pinSupported && selectedRows.some((session) => !session.pinned) ? (
        <button
          type="button"
          className={BULK_ACTION_BUTTON_CLASS}
          onClick={() => setPinned(selectedRows.filter((session) => !session.pinned).map((session) => session.sessionId), true)}
        >
          <PushPin size={10} /> Pin
        </button>
      ) : null}
      {showArchived ? (
        <button type="button" className={BULK_ACTION_BUTTON_CLASS} onClick={() => void removeChats(selectedRowIds, "unarchive")}>
          <ArrowCounterClockwise size={10} /> Unarchive
        </button>
      ) : (
        <button type="button" className={BULK_ACTION_BUTTON_CLASS} onClick={() => void removeChats(selectedRowIds, "archive")}>
          <Archive size={10} /> Archive
        </button>
      )}
      <button type="button" className={BULK_DESTRUCTIVE_BUTTON_CLASS} onClick={() => void removeChats(selectedRowIds, "delete")}>
        <Trash size={10} /> Delete {selectedRows.length}
      </button>
      <button
        type="button"
        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-fg/50 transition-colors hover:bg-fg/[0.04] hover:text-fg"
        onClick={clearSelection}
        aria-label="Clear selected chats"
        title="Clear selection"
      >
        <X size={10} />
      </button>
    </div>
  ) : null;

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
        multiSelectedIds={multiSelectedIds}
        onRowClick={handleRowClick}
        onRowContextMenu={openRowMenu}
        menuOpenId={rowMenu?.anchorId ?? null}
        renamingId={renamingId}
        onRenameCommit={renameSession}
        onRenameCancel={() => setRenamingId(null)}
        showArchived={showArchived}
        onToggleArchived={() => setShowArchived((current) => !current)}
        selectionToolbar={selectionToolbar}
        onListKeyDown={handleListKeyDown}
        onNewChat={() => { clearSelection(); selectSession(null); }}
        onBack={() => navigate("/work")}
        mobileListOpen={mobileListOpen}
      />
      {/* Portaled: the rail's frosted plane is a containing block for fixed
          children, which would pin the menu to the rail instead of the pointer. */}
      <ContextMenu
        menu={rowMenu && rowMenuEntries.length ? rowMenu : null}
        entries={rowMenuEntries}
        onClose={() => setRowMenu(null)}
        label={rowMenu && rowMenu.targetIds.length > 1 ? `${rowMenu.targetIds.length} selected chats` : "Chat actions"}
        testId="personal-chats-row-menu"
        portal
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
            <button type="button" onClick={() => void openChatInBrowserTab(selectedId, targetKey, navigate).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))} className={CHAT_HEADER_BUTTON} title="Show beside its page in the Browser tab" aria-label="Show in the Browser tab"><AppWindow size={14} /></button>
          ) : null}
          {browserAvailable ? (
            <button type="button" onClick={() => setToolPanel((current) => current === "browser" ? null : "browser")} className={cn("flex h-7 w-7 items-center justify-center rounded-md border transition-colors", toolPanel === "browser" ? "border-sky-300/25 bg-sky-500/10 text-sky-200" : "border-fg/[0.06] bg-fg/[0.025] text-muted-fg/45 hover:text-fg")} title="Browser" aria-label="Toggle browser"><Globe size={14} /></button>
          ) : null}
          <button type="button" onClick={() => setToolPanel((current) => current === "terminal" ? null : "terminal")} className={cn("flex h-7 w-7 items-center justify-center rounded-md border transition-colors", toolPanel === "terminal" ? "border-violet-300/25 bg-violet-500/10 text-violet-200" : "border-fg/[0.06] bg-fg/[0.025] text-muted-fg/45 hover:text-fg")} title="Terminal" aria-label="Toggle terminal"><TerminalWindow size={14} /></button>
        </div>
        {error || (providerUnavailable && !selectedSession) ? (
          <div className="flex shrink-0 flex-col gap-1.5 px-3 pt-2">
            {error ? (
              <Banner
                layout="inline"
                model={{ id: "personal-chats-error", tone: "error", title: error, dismiss: { onDismiss: () => setError(null) } }}
              />
            ) : null}
            {providerUnavailable && !selectedSession ? (
              <Banner
                layout="inline"
                model={{
                  id: "personal-chats-no-provider",
                  tone: "warning",
                  title: "No connected agent is available right now. Sign in to a provider from Settings to start a chat.",
                }}
              />
            ) : null}
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
                emptyStateAccessory={(
                  <div className="flex flex-col items-center gap-2">
                    {/* Where a new chat runs, chosen beside the prompt like a
                        project chat's launch shelf. Shown even with no provider
                        here: another machine may have one. Renders nothing with
                        a single machine. */}
                    <DraftMachinePicker
                      machines={machineOptions}
                      selectedMachineId={machineId}
                      onChange={selectMachine}
                      tooltipLabel="Where it runs"
                      showWhenSingle
                    />
                    {providerUnavailable ? null : <SuggestionChips prompts={CHAT_SUGGESTIONS} onSelect={setComposerDraft} />}
                  </div>
                )}
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
