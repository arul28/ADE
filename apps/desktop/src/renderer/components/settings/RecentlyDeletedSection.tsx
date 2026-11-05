import React from "react";
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  CircleNotch,
  ClockCounterClockwise,
  MagnifyingGlass,
} from "@phosphor-icons/react";
import type { DeletedChat, ExternalSessionProvider, LaneSummary, OpenProjectBinding } from "../../../shared/types";
import { importProviderLabel } from "../../../shared/externalSessionPolicy";
import { ipcErrorMessage, relativeWhen } from "../../lib/format";
import { isUnsupportedAdeActionError } from "../../../shared/codedError";
import { navigateToAppTarget } from "../../lib/openExternal";
import { isImeComposing } from "../../lib/imeComposition";
import { showToast } from "../app/toast/toastStore";
import { Banner } from "../ui/notice";
import { confirmDialog } from "../ui/dialog";
import { LaneCombobox } from "../terminals/LaneCombobox";
import { ToolLogo } from "../terminals/ToolLogos";
import { PROVIDER_TOOL_TYPE } from "../terminals/importSessions/contract";
import { ImportProviderFilter, SkeletonRows } from "../terminals/importSessions/ImportSessionList";
import { modelDisplayName } from "../terminals/importSessions/importBrowserModel";
import { LaneDot, MetaSeparator } from "../terminals/importSessions/ImportSessionParts";
import { SessionTranscriptPane } from "../terminals/importSessions/ImportSessionPreview";
import { sessionDateGroup } from "../terminals/importSessions/sessionPresentation";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import { SettingsColumn } from "./primitives";
import { useDeletedChatTranscript } from "./useDeletedChatTranscript";
import "../terminals/importSessions/importSessions.css";
import "./primitives/settingsModern.css";
import "./recentlyDeleted.css";

/**
 * Settings › Recently deleted: chats you deleted that can still be opened
 * again, with their history. Built like the Import window — a list on the
 * left, the conversation on the right, one Reopen button under it.
 *
 * ADE keeps only a note of each deleted chat. The conversation itself is the
 * agent's own copy, which ADE never deletes, so a chat leaves this list when
 * the agent clears that copy, or when you reopen it or remove it here.
 */

export const RECENTLY_DELETED_SETTINGS_ANCHOR = "recently-deleted";
const TOAST_ID = "settings-recently-deleted";

type ProviderFilter = "all" | ExternalSessionProvider;

function chatTitle(chat: DeletedChat): string {
  return chat.title?.trim() || "Untitled chat";
}

function deletedAtMs(chat: DeletedChat): number | null {
  const ms = Date.parse(chat.deletedAt);
  return Number.isFinite(ms) ? ms : null;
}

function errorText(error: unknown): string {
  return ipcErrorMessage(error) || "Something went wrong.";
}

/**
 * Opens the reopened chat in Work. The chat is seconds old, so Work's list may
 * not hold it yet: the select event loads it first (a `?sessionId=` link
 * would be dropped as unknown), the same route the command palette takes.
 */
function openInWork(result: { chatSessionId: string; laneId: string }, pin: OpenProjectBinding | null): void {
  window.dispatchEvent(new CustomEvent("ade:work:select-session", {
    detail: { sessionId: result.chatSessionId, laneId: result.laneId, ...(pin ? { binding: pin } : {}) },
  }));
  navigateToAppTarget({ kind: "work" });
}

function LanePlace({ chat }: { chat: DeletedChat }) {
  if (!chat.laneExists) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <LaneDot color={null} className="opacity-40" />
        <span className="truncate">{chat.laneName ? `${chat.laneName} (lane deleted)` : "Lane deleted"}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <LaneDot color={chat.laneColor} />
      <span className="truncate">{chat.laneName ?? "Its lane"}</span>
    </span>
  );
}

const DeletedChatRow = React.memo(function DeletedChatRow({
  chat,
  active,
  onSelect,
}: {
  chat: DeletedChat;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      data-deleted-chat-row={chat.id}
      onClick={() => onSelect(chat.id)}
      className="import-row"
    >
      <ToolLogo toolType={PROVIDER_TOOL_TYPE[chat.sourceProvider]} size={16} className="mt-[1px] shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="import-row-title block">{chatTitle(chat)}</span>
        <span className="import-meta mt-0.5">
          <LanePlace chat={chat} />
          <MetaSeparator />
          <span className="kit-num shrink-0">{relativeWhen(chat.deletedAt)}</span>
        </span>
      </span>
    </button>
  );
});

function DeletedChatPreview({
  chat,
  pin,
  lanes,
  lanesError,
  targetLaneId,
  onTargetLaneChange,
  reopening,
  removing,
  error,
  onReopen,
  onRemove,
}: {
  chat: DeletedChat;
  pin: OpenProjectBinding | null;
  lanes: LaneSummary[] | null;
  lanesError: string | null;
  targetLaneId: string;
  onTargetLaneChange: (laneId: string) => void;
  reopening: boolean;
  removing: boolean;
  error: string | null;
  onReopen: () => void;
  onRemove: () => void;
}) {
  const transcript = useDeletedChatTranscript(chat.id, pin);
  const model = modelDisplayName(transcript.detail?.model ?? chat.modelId);
  const busy = reopening || removing;
  const needsLane = !chat.laneExists;
  const laneOptions = React.useMemo(
    () => (lanes ?? []).map((lane) => ({ id: lane.id, name: lane.name, color: lane.color ?? null, branchRef: lane.branchRef ?? null })),
    [lanes],
  );
  const canReopen = !busy && (!needsLane || Boolean(targetLaneId));

  return (
    <>
      <header className="import-preview-head">
        <div className="import-preview-title">
          <ToolLogo toolType={PROVIDER_TOOL_TYPE[chat.sourceProvider]} size={18} className="shrink-0" />
          <h3 title={chatTitle(chat)}>{chatTitle(chat)}</h3>
        </div>
        <div className="import-meta">
          <span className="max-w-[220px] text-(--kit-text-2)"><LanePlace chat={chat} /></span>
          <MetaSeparator />
          <span>Deleted {relativeWhen(chat.deletedAt)}</span>
          <MetaSeparator />
          <span>{importProviderLabel(chat.sourceProvider)}</span>
          {model ? <><MetaSeparator /><span className="max-w-[160px] truncate">{model}</span></> : null}
        </div>
      </header>
      <SessionTranscriptPane transcript={transcript} />
      <footer className="import-actions">
        <div className="import-actions-row">
          {needsLane ? (
            <>
              <span className="import-actions-label">Reopen in</span>
              <LaneCombobox
                lanes={laneOptions}
                value={targetLaneId}
                onChange={onTargetLaneChange}
                placeholder={lanes ? "Pick a lane" : "Loading lanes…"}
                aria-label="Reopen in lane"
              />
            </>
          ) : (
            <span className="import-actions-label">Picks up where it left off, in {chat.laneName ?? "its lane"}.</span>
          )}
          <div className="import-actions-end">
            <button type="button" className="kit-btn kit-btn-ghost" disabled={busy} onClick={onRemove}>
              {removing ? <CircleNotch size={13} className="animate-spin" /> : null}
              Remove from list
            </button>
            <button type="button" className="kit-btn kit-btn-primary" disabled={!canReopen} onClick={onReopen}>
              {reopening ? <CircleNotch size={13} className="animate-spin" /> : <ArrowCounterClockwise size={13} />}
              {reopening ? "Reopening…" : "Reopen"}
              {reopening ? null : <kbd className="import-kbd" aria-hidden="true">⏎</kbd>}
            </button>
          </div>
        </div>
        {needsLane ? (
          <p className="import-actions-note">
            {lanesError
              ? `Couldn't load this machine's lanes: ${lanesError}`
              : "Its lane was deleted, so it opens as a copy in the lane you pick."}
          </p>
        ) : null}
        {error ? (
          <Banner
            layout="inline"
            style={{ marginTop: 10 }}
            model={{ id: "recently-deleted-reopen-error", tone: "error", title: "Couldn't reopen this chat", detail: error }}
          />
        ) : null}
      </footer>
    </>
  );
}

export function RecentlyDeletedSection() {
  const { pin } = useSettingsMachineScope();
  const pinKey = pin?.key ?? null;
  const pinRef = React.useRef(pin);
  pinRef.current = pin;

  const [chats, setChats] = React.useState<DeletedChat[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [providerFilter, setProviderFilter] = React.useState<ProviderFilter>("all");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [selectionTouched, setSelectionTouched] = React.useState(false);
  const [lanes, setLanes] = React.useState<LaneSummary[] | null>(null);
  const [lanesError, setLanesError] = React.useState<string | null>(null);
  const [targetLaneId, setTargetLaneId] = React.useState("");
  const [running, setRunning] = React.useState<{ id: string; kind: "reopen" | "remove" } | null>(null);
  const [actionError, setActionError] = React.useState<{ id: string; message: string } | null>(null);
  const requestSeq = React.useRef(0);

  const load = React.useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await window.ade.agentChat.listDeleted({}, pinRef.current);
      if (seq !== requestSeq.current) return;
      setChats(result.chats);
    } catch (error) {
      if (seq !== requestSeq.current) return;
      setLoadError(isUnsupportedAdeActionError(error)
        ? "This computer runs an older ADE. Update it to see its recently deleted chats."
        : errorText(error));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, []);

  // A different machine is a different list: nothing from the old one may be
  // shown, selected, or sent to the new one.
  React.useEffect(() => {
    setChats(null);
    setSelectedId(null);
    setSelectionTouched(false);
    setLanes(null);
    setLanesError(null);
    setTargetLaneId("");
    setActionError(null);
    void load();
  }, [load, pinKey]);

  const providerChips = React.useMemo(() => {
    const counts = new Map<ExternalSessionProvider, number>();
    for (const chat of chats ?? []) counts.set(chat.sourceProvider, (counts.get(chat.sourceProvider) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([provider, count]) => ({ provider, count }));
  }, [chats]);
  const effectiveProvider: ProviderFilter = providerFilter !== "all" && providerChips.some((chip) => chip.provider === providerFilter)
    ? providerFilter
    : "all";

  const visible = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (chats ?? []).filter((chat) =>
      (effectiveProvider === "all" || chat.sourceProvider === effectiveProvider)
      && (!needle
        || chatTitle(chat).toLowerCase().includes(needle)
        || (chat.laneName ?? "").toLowerCase().includes(needle)
        || importProviderLabel(chat.sourceProvider).toLowerCase().includes(needle)));
  }, [chats, effectiveProvider, query]);

  const groups = React.useMemo(() => {
    const out: Array<{ label: string; rows: DeletedChat[] }> = [];
    for (const chat of visible) {
      const label = sessionDateGroup(deletedAtMs(chat));
      const last = out[out.length - 1];
      if (last?.label === label) last.rows.push(chat);
      else out.push({ label, rows: [chat] });
    }
    return out;
  }, [visible]);

  const active = visible.find((chat) => chat.id === selectedId) ?? visible[0] ?? null;
  const activeId = active?.id ?? null;

  // Lanes are needed only to reopen a chat whose lane was deleted.
  const needsLanes = Boolean(active && !active.laneExists);
  React.useEffect(() => {
    if (!needsLanes || lanes) return;
    let cancelled = false;
    void window.ade.lanes.list({ includeArchived: false, includeStatus: false }, pinRef.current)
      .then((list) => {
        if (!cancelled) setLanes(list.filter((lane) => !lane.archivedAt));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLanes([]);
        setLanesError(errorText(error));
      });
    return () => {
      cancelled = true;
    };
  }, [lanes, needsLanes, pinKey]);

  const select = React.useCallback((id: string) => {
    setSelectedId(id);
    setSelectionTouched(true);
    setActionError(null);
  }, []);

  const reopen = React.useCallback(async (chat: DeletedChat) => {
    if (running) return;
    const laneId = chat.laneExists ? null : targetLaneId || null;
    if (!chat.laneExists && !laneId) return;
    setRunning({ id: chat.id, kind: "reopen" });
    setActionError(null);
    try {
      const result = await window.ade.agentChat.reopenDeleted({ id: chat.id, ...(laneId ? { laneId } : {}) }, pinRef.current);
      setChats((prev) => prev?.filter((entry) => entry.id !== chat.id) ?? prev);
      showToast({
        id: TOAST_ID,
        tone: "success",
        title: "Chat reopened",
        message: result.mode === "copy" ? `${chatTitle(chat)}, as a copy in the lane you picked.` : chatTitle(chat),
        actions: [{ label: "Open chat", onClick: () => openInWork(result, pinRef.current) }],
      });
      openInWork(result, pinRef.current);
    } catch (error) {
      setActionError({ id: chat.id, message: errorText(error) });
    } finally {
      setRunning(null);
    }
  }, [running, targetLaneId]);

  const remove = React.useCallback(async (chat: DeletedChat) => {
    if (running) return;
    const ok = await confirmDialog({
      title: "Remove from Recently deleted?",
      message: `You won't be able to reopen “${chatTitle(chat)}” in ADE anymore. ${importProviderLabel(chat.sourceProvider)} keeps its own copy.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    setRunning({ id: chat.id, kind: "remove" });
    setActionError(null);
    try {
      await window.ade.agentChat.removeDeleted({ ids: [chat.id] }, pinRef.current);
      setChats((prev) => prev?.filter((entry) => entry.id !== chat.id) ?? prev);
    } catch (error) {
      showToast({ id: TOAST_ID, tone: "error", title: "Couldn't remove that chat", message: errorText(error) });
    } finally {
      setRunning(null);
    }
  }, [running]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(event)) return;
    const target = event.target as HTMLElement;
    const inSearch = target.dataset.deletedChatSearch != null;
    const inRow = target.dataset.deletedChatRow != null;
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && (inSearch || inRow) && visible.length) {
      event.preventDefault();
      const index = Math.max(0, visible.findIndex((chat) => chat.id === activeId));
      const next = visible[Math.min(visible.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))];
      if (next) select(next.id);
      return;
    }
    if (event.key === "Enter" && active && (inRow || (inSearch && selectionTouched))) {
      event.preventDefault();
      void reopen(active);
    }
  };

  // Keep the selected row in view as the keyboard moves it.
  const listRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!activeId) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-deleted-chat-row="${CSS.escape(activeId)}"]`);
    if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
    const focused = document.activeElement;
    if (row && focused instanceof HTMLElement && focused !== row && focused.dataset.deletedChatRow != null) {
      row.focus({ preventScroll: true });
    }
  }, [activeId]);

  const total = chats?.length ?? 0;

  return (
    <SettingsColumn wide>
      <section
        id={RECENTLY_DELETED_SETTINGS_ANCHOR}
        data-settings-anchor={RECENTLY_DELETED_SETTINGS_ANCHOR}
        className="ade-modern-page"
      >
        <div className="ade-ap-section">
          <header className="ade-ap-head">
            <div style={{ minWidth: 0 }}>
              <h2>Recently deleted</h2>
              <p>Chats you deleted, ready to open again with their history.</p>
            </div>
          </header>

          {loadError && !chats ? (
            <Banner
              layout="inline"
              model={{
                id: "recently-deleted-load-error",
                tone: "error",
                title: "Couldn't load recently deleted chats",
                detail: loadError,
                actions: [{ label: "Try again", onClick: () => void load() }],
                report: { surface: "recently_deleted_load", technicalDetail: loadError },
              }}
            />
          ) : chats && total === 0 ? (
            <div className="ade-ar-empty">
              <ClockCounterClockwise size={22} weight="light" />
              <div className="ade-ap-rowtitle">Nothing deleted recently</div>
              <p className="ade-modern-muted">Chats you delete show up here, so you can bring them back.</p>
            </div>
          ) : (
            <div className="kit-card ade-rd-browser" onKeyDown={onKeyDown}>
              <div className="import-toolbar">
                <label className="import-search">
                  <MagnifyingGlass size={12} aria-hidden="true" />
                  <input
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setSelectionTouched(true);
                    }}
                    placeholder="Search deleted chats"
                    aria-label="Search deleted chats"
                    data-deleted-chat-search=""
                  />
                </label>
                <button
                  type="button"
                  className="kit-icon-btn"
                  aria-label="Refresh"
                  title="Refresh"
                  disabled={loading}
                  onClick={() => void load()}
                >
                  <ArrowClockwise size={13} className={loading ? "animate-spin" : undefined} />
                </button>
              </div>
              <div className="import-split">
                <aside className="import-list-col">
                  {providerChips.length > 1 ? (
                    <ImportProviderFilter
                      providerChips={providerChips}
                      totalCount={total}
                      providerFilter={effectiveProvider}
                      onProviderFilterChange={setProviderFilter}
                    />
                  ) : null}
                  <div
                    ref={listRef}
                    className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2"
                    data-scroll-lock-scrollable=""
                  >
                    {!chats ? (
                      <>
                        <span role="status" className="sr-only">Looking for deleted chats…</span>
                        <SkeletonRows count={5} />
                      </>
                    ) : groups.length ? (
                      <div role="listbox" aria-label="Deleted chats">
                        {groups.map((group) => (
                          <div key={group.label} role="group" aria-label={group.label}>
                            <div aria-hidden="true" className="kit-eyebrow import-group-label">{group.label}</div>
                            <div className="flex flex-col gap-px px-2">
                              {group.rows.map((chat) => (
                                <DeletedChatRow key={chat.id} chat={chat} active={chat.id === activeId} onSelect={select} />
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="import-center text-[12px] text-(--kit-text-3)">No deleted chats match.</div>
                    )}
                  </div>
                </aside>
                <section className="import-preview-col" aria-label="Deleted chat preview">
                  {active ? (
                    <DeletedChatPreview
                      key={active.id}
                      chat={active}
                      pin={pin}
                      lanes={lanes}
                      lanesError={lanesError}
                      targetLaneId={targetLaneId}
                      onTargetLaneChange={setTargetLaneId}
                      reopening={running?.id === active.id && running.kind === "reopen"}
                      removing={running?.id === active.id && running.kind === "remove"}
                      error={actionError?.id === active.id ? actionError.message : null}
                      onReopen={() => void reopen(active)}
                      onRemove={() => void remove(active)}
                    />
                  ) : chats ? (
                    <div className="import-center text-[12px] text-(--kit-text-3)">
                      Pick a chat to see its conversation.
                    </div>
                  ) : null}
                </section>
              </div>
            </div>
          )}
        </div>
      </section>
    </SettingsColumn>
  );
}
