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
import type { AgentChatFileRef, AgentChatSession } from "../../../shared/types";
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
import { resolvePersonalChatsCatalogTargetKey, usePersonalChatPaneScope } from "./usePersonalChatPaneScope";
import {
  callPersonalOn,
  personalChatsBridgeFor,
  personalChatsMachineTargetKey,
  usePersonalChatMachines,
  usePersonalChatsAcrossMachines,
  type PersonalChatRow,
} from "./personalChatMachines";
import { isWebClientMode } from "../../lib/webClientMode";
import {
  ADE_OPEN_BUILT_IN_BROWSER_EVENT,
  navigateUrlInAdeBrowser,
  type OpenBuiltInBrowserDetail,
} from "../../lib/openExternal";
import { useAppStore } from "../../state/appStore";
import { readLastOpenChat, rememberLastOpenChat } from "../../state/lastOpenChat";
import { openChatInBrowserTab, openUrlInBrowserTab } from "../browser/browserTab";
import { useAgentBrowserPresenceSince } from "../terminals/agentBrowserPresence";
import { ChatSceneBackdrop } from "./ChatSceneBackdrop";
import { machineScopedId, parseMachineScopedId } from "../../state/foreignMachineReads";
import { THIS_MACHINE_ID } from "../../../shared/machineIdentity";

type ToolPanel = "browser" | "terminal" | null;

/** Ways to start a new chat. A chip fills the composer; the user finishes the sentence. */
const CHAT_SUGGESTIONS: ReadonlyArray<{ label: string; prefill: string }> = [
  { label: "Think through a decision", prefill: "Help me think through a decision I'm facing: " },
  { label: "Draft from a rough idea", prefill: "Help me draft this from a rough idea: " },
  { label: "Research a topic", prefill: "Research this topic with me: " },
  { label: "Plan from my notes", prefill: "Turn these notes into an action plan:\n" },
];

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

/** The chat last open, across every machine, kept as its row id. */
const LAST_OPEN_SCOPE = "all-machines";

export function PersonalChatsPage({ standalone = false }: { standalone?: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const browserTabOpen = useAppStore((state) => state.browserTabOpen) ?? false;
  const {
    machines,
    settled: machinesSettled,
    draftOptions,
    draftOptionId,
    draftMachineId,
    selectDraft,
    boundMachineId,
  } = usePersonalChatMachines();
  // The Browser tab's docked chat names its machine this way.
  const projectBinding = useAppStore((state) => state.projectBinding);
  const browserDockTargetKey = resolvePersonalChatsCatalogTargetKey(projectBinding);
  // The rail lists archived chats instead of live ones, so they can come back.
  const [showArchived, setShowArchived] = useState(false);
  const {
    rows: sessions,
    loadByMachine,
    readMachineIds,
    refreshMachine,
  } = usePersonalChatsAcrossMachines(machines, showArchived);
  // The chat open in the pane, as its row id (machine and session). Leaving
  // the page (or the window) and coming back reopens the one you were in; only
  // New chat starts a draft.
  const [selectedId, setSelectedId] = useState<string | null>(() => readLastOpenChat(LAST_OPEN_SCOPE));
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  // Bumped only when the user navigates (picks a chat, starts a new one), so a
  // chat created by the pane's own first send keeps the same pane mounted.
  const [paneGeneration, setPaneGeneration] = useState(0);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [rowMenu, setRowMenu] = useState<RowMenuState>(null);
  // Rows picked with shift / cmd / ctrl-click. Separate from `selectedId`
  // (the chat open in the pane), as in the Work sidebar.
  const [multiSelectedIds, setMultiSelectedIds] = useState<ReadonlySet<string>>(EMPTY_SELECTION);
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [toolPanel, setToolPanel] = useState<ToolPanel>(null);
  const [mobileListOpen, setMobileListOpen] = useState(true);
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

  // The pane runs on the open chat's machine, or for a draft on the machine
  // picked beside the composer.
  const selectedTarget = selectedId ? parseMachineScopedId(selectedId) : null;
  const selectedSessionId = selectedTarget?.id ?? null;
  const paneMachineId = selectedTarget?.machineId ?? draftMachineId;
  const paneMachineIdRef = useRef(paneMachineId);
  paneMachineIdRef.current = paneMachineId;
  const paneTargetKey = paneMachineId ? personalChatsMachineTargetKey(paneMachineId) : "web:pending";
  const { chatScope, catalog, availableModelIds, providerUnavailable } = usePersonalChatPaneScope(paneTargetKey, {
    machineId: paneMachineId,
    machineName: machines.find((machine) => machine.id === paneMachineId)?.name ?? null,
    onError: setError,
  });
  const terminalBridge = useMemo(
    () => (paneMachineId ? personalChatsBridgeFor(paneMachineId) : window.ade.personalChats),
    [paneMachineId],
  );

  const loading = sessions.length === 0
    && machines.some((machine) => loadByMachine[machine.id]?.status === "loading");

  // The chat to reopen was deleted or archived since, or its machine is gone:
  // open the most recent chat instead, or a draft when there is none. Decided
  // once, when the remembered chat's machine has answered.
  const restorePendingRef = useRef(selectedId != null);
  useEffect(() => {
    if (!restorePendingRef.current) return;
    const restoredId = selectedIdRef.current;
    const target = restoredId ? parseMachineScopedId(restoredId) : null;
    const machineListed = target != null && machines.some((machine) => machine.id === target.machineId);
    if (target && machineListed && !readMachineIds.has(target.machineId)) return;
    if (target && !machineListed && !machinesSettled) return;
    restorePendingRef.current = false;
    if (!target || (machineListed && sessions.some((session) => session.rowId === restoredId))) return;
    // A machine that failed its read cannot say the chat is gone.
    if (machineListed && loadByMachine[target.machineId]?.status === "error") return;
    const fallbackId = sessions[0]?.rowId ?? null;
    rememberLastOpenChat(LAST_OPEN_SCOPE, fallbackId);
    setSelectedId(fallbackId);
    setPaneGeneration((value) => value + 1);
  }, [loadByMachine, machines, machinesSettled, readMachineIds, sessions]);

  // Switching between live and archived chats clears the rail's selection; the open chat stays open.
  const archivedViewInitializedRef = useRef(false);
  useEffect(() => {
    if (!archivedViewInitializedRef.current) {
      archivedViewInitializedRef.current = true;
      return;
    }
    setMultiSelectedIds(EMPTY_SELECTION);
    setSelectionAnchorId(null);
    setRowMenu(null);
    setRenamingId(null);
  }, [showArchived]);

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
  const lastSelectedSessionRef = useRef<PersonalChatRow | null>(null);
  const listedSelectedSession = sessions.find((session) => session.rowId === selectedId) ?? null;
  if (listedSelectedSession) lastSelectedSessionRef.current = listedSelectedSession;
  const selectedSession = listedSelectedSession
    ?? (lastSelectedSessionRef.current?.rowId === selectedId ? lastSelectedSessionRef.current : null);

  const selectSession = useCallback((rowId: string | null) => {
    restorePendingRef.current = false;
    rememberLastOpenChat(LAST_OPEN_SCOPE, rowId);
    setSelectedId(rowId);
    setPaneGeneration((value) => value + 1);
    setRowMenu(null);
    setMobileListOpen(false);
  }, []);

  // `/chats?chat=<id>` opens that chat: the Browser tab's dock sends its chat
  // here to be read full size. The dock's chat lives on the window's machine.
  const requestedChatId = new URLSearchParams(location.search).get("chat");
  useEffect(() => {
    if (!requestedChatId) return;
    selectSession(machineScopedId(boundMachineId ?? THIS_MACHINE_ID, requestedChatId));
    navigate("/chats", { replace: true });
    // selectSession is stable; only a new request should re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedChatId]);

  const handleSessionCreated = useCallback((session: AgentChatSession) => {
    // Same pane, now locked to the chat its first message created.
    const machineId = paneMachineIdRef.current;
    if (!machineId) return;
    const rowId = machineScopedId(machineId, session.id);
    restorePendingRef.current = false;
    rememberLastOpenChat(LAST_OPEN_SCOPE, rowId);
    setSelectedId(rowId);
    void refreshMachine(machineId);
  }, [refreshMachine]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? sessions.filter((session) => `${sessionTitle(session)} ${sessionPreview(session)} ${session.machineName ?? ""}`.toLowerCase().includes(needle))
      : sessions;
  }, [query, sessions]);
  const grouped = useMemo(() => {
    const groups = new Map<string, PersonalChatRow[]>();
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
    () => grouped.flatMap(([, rows]) => rows.map((session) => session.rowId)),
    [grouped],
  );
  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.rowId, session] as const)),
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
   * Runs one action over every chat it names, each on its own machine: one
   * chat that refuses does not stop the rest. Failures are reported with a
   * count. Every machine an action ran on is re-read.
   */
  const runChatAction = useCallback(async (
    verb: string,
    rowIds: string[],
    action: (target: { machineId: string; sessionId: string }) => Promise<unknown>,
  ): Promise<string[]> => {
    setRowMenu(null);
    setError(null);
    const succeeded: string[] = [];
    const touchedMachines = new Set<string>();
    let firstFailure: unknown = null;
    for (const rowId of rowIds) {
      const target = parseMachineScopedId(rowId);
      if (!target) continue;
      touchedMachines.add(target.machineId);
      try {
        await action({ machineId: target.machineId, sessionId: target.id });
        succeeded.push(rowId);
      } catch (reason) {
        firstFailure ??= reason;
      }
    }
    if (firstFailure != null) {
      const detail = errorDetail(firstFailure);
      setError(rowIds.length === 1
        ? `Could not ${verb} this chat${detail ? `: ${detail}` : "."}`
        : `Could not ${verb} ${rowIds.length - succeeded.length} of ${rowIds.length} chats${detail ? `: ${detail}` : "."}`);
    }
    await Promise.all([...touchedMachines].map((machineId) => refreshMachine(machineId)));
    return succeeded;
  }, [refreshMachine]);

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
    const done = await runChatAction(action, ids, ({ machineId, sessionId }) =>
      callPersonalOn<void>(machineId, action, { sessionId }));
    // An archived or deleted chat leaves the pane; an unarchived one stays open.
    if (selectedId && done.includes(selectedId) && action !== "unarchive") selectSession(null);
    setMultiSelectedIds((current) => {
      if (!done.some((id) => current.has(id))) return current;
      return new Set([...current].filter((id) => !done.includes(id)));
    });
  }, [runChatAction, selectSession, selectedId, sessionsById]);

  const renameSession = useCallback((rowId: string, title: string) => {
    setRenamingId(null);
    void runChatAction("rename", [rowId], ({ machineId, sessionId }) =>
      callPersonalOn(machineId, "updateSession", { sessionId, title, manuallyNamed: true }));
  }, [runChatAction]);

  // An older host has no `setPinned` (personal-chat capabilities are not
  // exposed to this page): its refusal hides Pin for that machine's chats
  // instead of surfacing as an error.
  const [pinUnsupportedMachines, setPinUnsupportedMachines] = useState<ReadonlySet<string>>(() => new Set());
  const pinSupportedFor = useCallback(
    (rows: readonly PersonalChatRow[]) => rows.every((row) => !pinUnsupportedMachines.has(row.machineId)),
    [pinUnsupportedMachines],
  );
  const setPinned = useCallback((ids: string[], pinned: boolean) => {
    void runChatAction(pinned ? "pin" : "unpin", ids, async ({ machineId, sessionId }) => {
      try {
        await callPersonalOn(machineId, "setPinned", { sessionId, pinned });
      } catch (reason) {
        if (!errorDetail(reason).includes("Unsupported personal chat action")) throw reason;
        setPinUnsupportedMachines((current) => (current.has(machineId) ? current : new Set([...current, machineId])));
      }
    });
  }, [runChatAction]);

  const stopChats = useCallback((ids: string[]) => {
    void runChatAction("stop", ids, ({ machineId, sessionId }) => callPersonalOn(machineId, "interrupt", { sessionId }));
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
      .filter((session): session is PersonalChatRow => session != null);
    if (targets.length === 0) return [];
    const ids = targets.map((session) => session.rowId);
    const total = targets.length;
    const hint = (count: number) => (total > 1 && count < total ? `${count} of ${total}` : undefined);
    const unpinned = targets.filter((session) => !session.pinned).map((session) => session.rowId);
    const running = targets.filter((session) => session.status === "active").map((session) => session.rowId);
    const archived = targets.filter((session) => session.archivedAt).map((session) => session.rowId);
    const live = targets.filter((session) => !session.archivedAt).map((session) => session.rowId);
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
            onSelect: () => setRenamingId(single.rowId),
          }]
        : []),
      ...(pinSupportedFor(targets)
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
      // The Browser tab's dock runs on the window's machine, so only its chats go there.
      ...(single && browserAvailable && single.machineId === boundMachineId
        ? [{
            kind: "item" as const,
            key: "browser-tab",
            label: "Open in the Browser tab",
            icon: AppWindow,
            onSelect: () => {
              void openChatInBrowserTab(single.sessionId, browserDockTargetKey, navigate)
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
        onSelect: () => copyToClipboard(targets.map((session) => session.sessionId).join("\n"), total > 1 ? "chat IDs" : "chat ID"),
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
    pinSupportedFor,
    removeChats,
    rowMenu,
    sessionsById,
    setPinned,
    stopChats,
    boundMachineId,
    browserDockTargetKey,
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
    .filter((session): session is PersonalChatRow => session != null);
  const selectionToolbar = selectedRows.length > 0 ? (
    <div
      className="mx-3 mb-2 flex min-h-8 flex-wrap items-center gap-0.5 border-t border-fg/[0.06] px-1 pt-1"
      data-testid="personal-chats-selection-toolbar"
    >
      <span className="min-w-0 flex-1 truncate px-1 font-sans text-[10px] font-medium tabular-nums text-muted-fg/70">
        {selectedRows.length} selected
      </span>
      {pinSupportedFor(selectedRows) && selectedRows.some((session) => !session.pinned) ? (
        <button
          type="button"
          className={BULK_ACTION_BUTTON_CLASS}
          onClick={() => setPinned(selectedRows.filter((session) => !session.pinned).map((session) => session.rowId), true)}
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
  // click from its page there. The dock runs on the window's machine.
  const selectedBrowsingSince = useAgentBrowserPresenceSince(selectedSessionId);
  const browserDockChatId = useAppStore((state) => state.browserDock?.chat?.sessionId ?? null);
  const selectedOnBoundMachine = selectedTarget != null && selectedTarget.machineId === boundMachineId;
  const showInBrowserTab = browserAvailable && selectedOnBoundMachine
    && (selectedBrowsingSince != null || browserDockChatId === selectedSessionId);
  const showReconnecting = Boolean(error) && !isWebClientMode() && paneMachineId != null && paneMachineId !== THIS_MACHINE_ID;
  // The rail's footer: every machine whose chats are listed, and how its read went.
  const machineStatuses = useMemo(
    () => machines.map((machine) => ({
      id: machine.id,
      name: machine.name,
      status: loadByMachine[machine.id]?.status ?? ("ok" as const),
      message: loadByMachine[machine.id]?.message ?? null,
    })),
    [loadByMachine, machines],
  );
  const title = selectedSession ? sessionTitle(selectedSession) : "New chat";

  return (
    <div className="ade-chat-scene relative flex h-full min-h-0 text-fg" data-testid="personal-chats-page" data-target={paneTargetKey}>
      <ChatSceneBackdrop />
      <ProjectlessSidebar
        standalone={standalone}
        machines={machineStatuses}
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
          {showInBrowserTab && selectedSessionId ? (
            <button type="button" onClick={() => void openChatInBrowserTab(selectedSessionId!, browserDockTargetKey, navigate).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))} className={CHAT_HEADER_BUTTON} title="Show beside its page in the Browser tab" aria-label="Show in the Browser tab"><AppWindow size={14} /></button>
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
                key={`${paneTargetKey}:${paneGeneration}`}
                laneId={null}
                chatScope={chatScope}
                lockSessionId={selectedSessionId}
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
                      machines={draftOptions}
                      selectedMachineId={draftOptionId}
                      onChange={(optionId) => {
                        if (optionId === draftOptionId) return;
                        setError(null);
                        void selectDraft(optionId).then(setError);
                      }}
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
                  sessionId={selectedSessionId}
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
                <PersonalTerminalPanel chatSessionId={selectedSessionId} bridge={terminalBridge} onClose={() => setToolPanel(null)} />
              </div>
            ) : null}
          </AgentChatApiProvider>
        </div>
      </main>
    </div>
  );
}
