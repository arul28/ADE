import React from "react";
import { ArrowCounterClockwise, CircleNotch, ClockCounterClockwise, MagnifyingGlass, X } from "@phosphor-icons/react";
import type { DeletedChat, ExternalSessionProvider, LaneSummary, OpenProjectBinding } from "../../../shared/types";
import { importProviderLabel } from "../../../shared/externalSessionPolicy";
import { isUnsupportedAdeActionError } from "../../../shared/codedError";
import { ipcErrorMessage, relativeWhen } from "../../lib/format";
import { navigateToAppTarget } from "../../lib/openExternal";
import { showToast } from "../app/toast/toastStore";
import { Banner } from "../ui/notice";
import { Dialog, confirmDialog } from "../ui/dialog";
import { LaneChip } from "../terminals/LaneChip";
import { LaneCombobox } from "../terminals/LaneCombobox";
import { ToolLogo } from "../terminals/ToolLogos";
import { PROVIDER_TOOL_TYPE } from "../terminals/importSessions/contract";
import { modelDisplayName } from "../terminals/importSessions/importBrowserModel";
import { SessionTranscriptPane } from "../terminals/importSessions/ImportSessionPreview";
import { sessionDateGroup } from "../terminals/importSessions/sessionPresentation";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import { SettingsColumn } from "./primitives";
import { useDeletedChatTranscript } from "./useDeletedChatTranscript";
import "../terminals/importSessions/importSessions.css";
import "./primitives/settingsModern.css";
import "./machineSettings.css";
import "./recentlyDeleted.css";

/**
 * Settings › Recently deleted: chats you deleted that can still be opened
 * again, with their history. A plain settings list, like Archive beside it;
 * a row opens the conversation in a dialog, and Reopen brings the chat back.
 *
 * ADE keeps only a note of each deleted chat. The conversation itself is the
 * agent's own copy, which ADE never deletes, so a chat leaves this list when
 * the agent clears that copy, or when you reopen it or remove it here.
 */

export const RECENTLY_DELETED_SETTINGS_ANCHOR = "recently-deleted";
const TOAST_ID = "settings-recently-deleted";
/** Rows drawn before "Show more"; the rest wait for the click. */
const PAGE_ROWS = 25;

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
    return <span className="ade-rd-gone">{chat.laneName ? `${chat.laneName} · lane deleted` : "Lane deleted"}</span>;
  }
  return <LaneChip laneName={chat.laneName ?? "Its lane"} laneColor={chat.laneColor} maxWidth={180} />;
}

function ChatMeta({ chat, model }: { chat: DeletedChat; model?: string | null }) {
  return (
    <>
      <LanePlace chat={chat} />
      <span aria-hidden className="ade-rd-sep">·</span>
      <span className="kit-num ade-rd-nowrap">Deleted {relativeWhen(chat.deletedAt)}</span>
      {model ? (
        <>
          <span aria-hidden className="ade-rd-sep">·</span>
          <span className="ade-rd-nowrap">{model}</span>
        </>
      ) : null}
    </>
  );
}

const DeletedChatRow = React.memo(function DeletedChatRow({
  chat,
  busy,
  reopening,
  onOpen,
  onReopen,
  onRemove,
}: {
  chat: DeletedChat;
  busy: boolean;
  reopening: boolean;
  onOpen: (chat: DeletedChat) => void;
  onReopen: (chat: DeletedChat) => void;
  onRemove: (chat: DeletedChat) => void;
}) {
  const model = modelDisplayName(chat.modelId);
  return (
    <div role="listitem" className="ade-ar-row ade-rd-row" data-reopening={reopening || undefined}>
      <button
        type="button"
        className="ade-rd-open"
        onClick={() => onOpen(chat)}
        aria-label={`Open ${chatTitle(chat)}`}
        data-deleted-chat-row={chat.id}
      >
        <span className="ade-ar-mark">
          <ToolLogo toolType={PROVIDER_TOOL_TYPE[chat.sourceProvider]} size={15} />
        </span>
        <span className="ade-rd-text">
          <span className="ade-ar-title">{chatTitle(chat)}</span>
          <span className="ade-ar-meta"><ChatMeta chat={chat} model={model} /></span>
        </span>
      </button>
      <div className="ade-rd-actions">
        <button
          type="button"
          aria-label="Remove from list"
          title="Remove from list"
          disabled={busy}
          onClick={() => onRemove(chat)}
          className="ade-ar-icon-btn ade-rd-hover"
        >
          <X size={14} />
        </button>
        <button
          type="button"
          className="ade-modern-btn"
          data-size="sm"
          disabled={busy}
          // A chat whose lane is gone needs a lane first: the dialog asks.
          onClick={() => (chat.laneExists ? onReopen(chat) : onOpen(chat))}
        >
          {reopening ? <CircleNotch size={12} className="animate-spin" /> : <ArrowCounterClockwise size={12} />}
          {reopening ? "Reopening…" : chat.laneExists ? "Reopen" : "Reopen…"}
        </button>
      </div>
    </div>
  );
});

/** The conversation, read-only, with Reopen under it. */
function DeletedChatDialog({
  chat,
  pin,
  lanes,
  lanesError,
  targetLaneId,
  onTargetLaneChange,
  reopening,
  removing,
  error,
  onClose,
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
  onClose: () => void;
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
    <Dialog
      open
      onOpenChange={(next) => { if (!next && !busy) onClose(); }}
      title={chatTitle(chat)}
      icon={<ToolLogo toolType={PROVIDER_TOOL_TYPE[chat.sourceProvider]} size={18} />}
      description={<span className="ade-rd-dialog-meta"><ChatMeta chat={chat} model={model} /></span>}
      width="min(960px, calc(100vw - 4rem))"
      height="min(780px, calc(100dvh - 4rem))"
      scrollBody={false}
      bodyPadding={false}
      // Opaque, like a side sheet: the settings rows behind would ghost
      // through the modal's 98% material around a long conversation.
      panelStyle={{ background: "var(--color-card)" }}
      dismissible={!busy}
      footerStart={(
        <div className="ade-rd-footer-start">
          {needsLane ? (
            <>
              <span>Reopen in</span>
              <LaneCombobox
                lanes={laneOptions}
                value={targetLaneId}
                onChange={onTargetLaneChange}
                placeholder={lanes ? "Pick a lane" : "Loading lanes…"}
                aria-label="Reopen in lane"
              />
              {lanesError ? <span className="ade-rd-error">{lanesError}</span> : null}
            </>
          ) : (
            <span>Picks up where it left off, in {chat.laneName ?? "its lane"}.</span>
          )}
        </div>
      )}
      footer={(
        <>
          <button type="button" className="kit-btn kit-btn-ghost" disabled={busy} onClick={onRemove}>
            {removing ? <CircleNotch size={13} className="animate-spin" /> : null}
            Remove from list
          </button>
          <button type="button" className="kit-btn kit-btn-primary" disabled={!canReopen} onClick={onReopen}>
            {reopening ? <CircleNotch size={13} className="animate-spin" /> : <ArrowCounterClockwise size={13} />}
            {reopening ? "Reopening…" : needsLane ? "Reopen as a copy" : "Reopen"}
          </button>
        </>
      )}
    >
      <div className="ade-rd-dialog-body">
        {error ? (
          <Banner
            layout="inline"
            style={{ margin: "12px 20px 0", flexShrink: 0 }}
            model={{ id: "recently-deleted-reopen-error", tone: "error", title: "Couldn't reopen this chat", detail: error }}
          />
        ) : null}
        <SessionTranscriptPane transcript={transcript} />
      </div>
    </Dialog>
  );
}

export function RecentlyDeletedSection() {
  const { pin } = useSettingsMachineScope();
  const pinKey = pin?.key ?? null;
  const pinRef = React.useRef(pin);
  pinRef.current = pin;

  const [chats, setChats] = React.useState<DeletedChat[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [providerFilter, setProviderFilter] = React.useState<ProviderFilter>("all");
  const [shownRows, setShownRows] = React.useState(PAGE_ROWS);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [lanes, setLanes] = React.useState<LaneSummary[] | null>(null);
  const [lanesError, setLanesError] = React.useState<string | null>(null);
  const [targetLaneId, setTargetLaneId] = React.useState("");
  const [running, setRunning] = React.useState<{ id: string; kind: "reopen" | "remove" } | null>(null);
  const [actionError, setActionError] = React.useState<{ id: string; message: string } | null>(null);
  const requestSeq = React.useRef(0);

  const load = React.useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoadError(null);
    try {
      const result = await window.ade.agentChat.listDeleted({}, pinRef.current);
      if (seq === requestSeq.current) setChats(result.chats);
    } catch (error) {
      if (seq !== requestSeq.current) return;
      setLoadError(isUnsupportedAdeActionError(error)
        ? "This computer runs an older ADE. Update it to see its recently deleted chats."
        : errorText(error));
    }
  }, []);

  // A different machine is a different list: nothing from the old one may be
  // shown, opened, or sent to the new one.
  React.useEffect(() => {
    setChats(null);
    setOpenId(null);
    setLanes(null);
    setLanesError(null);
    setTargetLaneId("");
    setActionError(null);
    setShownRows(PAGE_ROWS);
    void load();
  }, [load, pinKey]);

  const providerChips = React.useMemo(() => {
    const counts = new Map<ExternalSessionProvider, number>();
    for (const chat of chats ?? []) counts.set(chat.sourceProvider, (counts.get(chat.sourceProvider) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([provider, count]) => ({ provider, count }));
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
    for (const chat of visible.slice(0, shownRows)) {
      const label = sessionDateGroup(deletedAtMs(chat));
      const last = out[out.length - 1];
      if (last?.label === label) last.rows.push(chat);
      else out.push({ label, rows: [chat] });
    }
    return out;
  }, [shownRows, visible]);

  const openChat = (chats ?? []).find((chat) => chat.id === openId) ?? null;

  // Lanes are needed only to reopen a chat whose lane was deleted.
  const needsLanes = Boolean(openChat && !openChat.laneExists);
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
        setLanesError(`Couldn't load this computer's lanes: ${errorText(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [lanes, needsLanes, pinKey]);

  const open = React.useCallback((chat: DeletedChat) => {
    setActionError(null);
    setOpenId(chat.id);
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
      setOpenId(null);
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
      // Reopened from the list without the dialog: open it to show why.
      setOpenId(chat.id);
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
    try {
      await window.ade.agentChat.removeDeleted({ ids: [chat.id] }, pinRef.current);
      setChats((prev) => prev?.filter((entry) => entry.id !== chat.id) ?? prev);
      setOpenId((current) => (current === chat.id ? null : current));
    } catch (error) {
      showToast({ id: TOAST_ID, tone: "error", title: "Couldn't remove that chat", message: errorText(error) });
    } finally {
      setRunning(null);
    }
  }, [running]);

  const total = chats?.length ?? 0;
  const hidden = Math.max(0, visible.length - shownRows);

  return (
    <SettingsColumn wide>
      <section
        id={RECENTLY_DELETED_SETTINGS_ANCHOR}
        data-settings-anchor={RECENTLY_DELETED_SETTINGS_ANCHOR}
        className="ade-modern-page"
      >
        <div className="ade-ap-section">
          <header className="ade-ap-head" style={{ alignItems: "center" }}>
            <div style={{ minWidth: 0 }}>
              <h2>Recently deleted</h2>
              <p>Chats you deleted. Open one to read it, or bring it back with Reopen.</p>
            </div>
            {total > 0 ? (
              <label className="ade-rd-search">
                <MagnifyingGlass size={13} aria-hidden="true" />
                <input
                  className="kit-input"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setShownRows(PAGE_ROWS);
                  }}
                  placeholder="Search"
                  aria-label="Search deleted chats"
                />
              </label>
            ) : null}
          </header>

          {providerChips.length > 1 ? (
            <div role="radiogroup" aria-label="Agent" className="kit-seg" data-case="sentence" style={{ alignSelf: "flex-start" }}>
              {[{ provider: "all" as const, count: total }, ...providerChips].map((chip) => (
                <button
                  key={chip.provider}
                  type="button"
                  role="radio"
                  aria-checked={effectiveProvider === chip.provider}
                  onClick={() => setProviderFilter(chip.provider)}
                >
                  {chip.provider === "all" ? "All" : (
                    <>
                      <ToolLogo toolType={PROVIDER_TOOL_TYPE[chip.provider]} size={12} />
                      {importProviderLabel(chip.provider)}
                    </>
                  )}
                  <span className="kit-num ade-rd-count">{chip.count}</span>
                </button>
              ))}
            </div>
          ) : null}

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
          ) : !chats ? (
            <p className="ade-modern-muted">Looking for deleted chats…</p>
          ) : total === 0 ? (
            <div className="ade-ar-empty">
              <ClockCounterClockwise size={22} weight="light" />
              <div className="ade-ap-rowtitle">Nothing deleted recently</div>
              <p className="ade-modern-muted">Chats you delete show up here, so you can bring them back.</p>
            </div>
          ) : visible.length === 0 ? (
            <p className="ade-modern-muted">No deleted chats match “{query.trim()}”.</p>
          ) : (
            <div className="ade-ar-table">
              {groups.map((group) => (
                <div key={group.label} className="ade-ar-block">
                  <div className="ade-ar-group">
                    <span className="kit-eyebrow">{group.label}</span>
                    <span className="ade-ar-group-count kit-num">{group.rows.length}</span>
                  </div>
                  <div role="list" aria-label={group.label} className="ade-modern-rows ade-ar-list">
                    {group.rows.map((chat) => (
                      <DeletedChatRow
                        key={chat.id}
                        chat={chat}
                        busy={running != null}
                        reopening={running?.id === chat.id && running.kind === "reopen"}
                        onOpen={open}
                        onReopen={(entry) => void reopen(entry)}
                        onRemove={(entry) => void remove(entry)}
                      />
                    ))}
                  </div>
                </div>
              ))}
              {hidden > 0 ? (
                <button
                  type="button"
                  className="ade-modern-btn"
                  data-size="sm"
                  style={{ alignSelf: "center" }}
                  onClick={() => setShownRows((count) => count + PAGE_ROWS)}
                >
                  Show {Math.min(hidden, PAGE_ROWS)} more
                </button>
              ) : null}
            </div>
          )}
        </div>
      </section>
      {openChat ? (
        <DeletedChatDialog
          key={openChat.id}
          chat={openChat}
          pin={pin}
          lanes={lanes}
          lanesError={lanesError}
          targetLaneId={targetLaneId}
          onTargetLaneChange={setTargetLaneId}
          reopening={running?.id === openChat.id && running.kind === "reopen"}
          removing={running?.id === openChat.id && running.kind === "remove"}
          error={actionError?.id === openChat.id ? actionError.message : null}
          onClose={() => setOpenId(null)}
          onReopen={() => void reopen(openChat)}
          onRemove={() => void remove(openChat)}
        />
      ) : null}
    </SettingsColumn>
  );
}
