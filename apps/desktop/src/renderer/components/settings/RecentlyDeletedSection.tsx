import React from "react";
import { ArrowCounterClockwise, CircleNotch, ClockCounterClockwise, MagnifyingGlass, X } from "@phosphor-icons/react";
import type {
  DeletedChat,
  DeletedLaneSnapshot,
  ExternalSessionProvider,
  LaneSummary,
  OpenProjectBinding,
  RestoreDeletedLaneResult,
  RestoredLaneChat,
  TerminalToolType,
} from "../../../shared/types";
import { importProviderLabel } from "../../../shared/externalSessionPolicy";
import { ipcErrorMessage, relativeWhen } from "../../lib/format";
import { captureLaneSetupAnalytics } from "../../lib/laneSetupAnalytics";
import { openChatInWork, restoredLaneOpeners, restoredLaneToast } from "../app/toast/restoredLaneToast";
import { showToast } from "../app/toast/toastStore";
import { Banner } from "../ui/notice";
import { Dialog, confirmDialog } from "../ui/dialog";
import { LaneChip, LaneLogoMark, laneDisplayColor } from "../terminals/LaneChip";
import { LaneCombobox } from "../terminals/LaneCombobox";
import { ToolLogo } from "../terminals/ToolLogos";
import { PROVIDER_TOOL_TYPE } from "../terminals/importSessions/contract";
import { modelDisplayName } from "../terminals/importSessions/importBrowserModel";
import { SessionTranscriptPane } from "../terminals/importSessions/ImportSessionPreview";
import { sessionDateGroup } from "../terminals/importSessions/sessionPresentation";
import { MetaLine } from "./MetaLine";
import { NoProjectCopyNotice } from "./ProjectCopyScope";
import { SettingsColumn } from "./primitives";
import { useDeletedChatTranscript } from "./useDeletedChatTranscript";
import { useDeletedEverywhere, type DeletedSource, type MachineDeleted } from "./useDeletedEverywhere";
import "../terminals/importSessions/importSessions.css";
import "./primitives/settingsModern.css";
import "./machineSettings.css";
import "./recentlyDeleted.css";

/**
 * Settings › Deleted & Archived › Recently deleted: lanes and chats you
 * deleted, from every computer with a copy of the project, in one list,
 * newest first. A lane carries the chats that went with it, and Restore
 * brings both back. A chat deleted on its own opens in a dialog to read, and
 * Reopen brings it back.
 *
 * ADE keeps only a note of each deleted chat. The conversation itself is the
 * agent's own copy, which ADE never deletes, so a chat leaves this list when
 * the agent clears that copy, or when you reopen it or remove it here. A
 * deleted lane's unsaved work is kept as a git ref for a while.
 */

export const RECENTLY_DELETED_SETTINGS_ANCHOR = "recently-deleted";
const TOAST_ID = "settings-recently-deleted";
/** Entries drawn before "Show more"; the rest wait for the click. */
const PAGE_ROWS = 25;
const DAY_MS = 24 * 60 * 60 * 1000;

type KindFilter = "all" | "lanes" | "chats";

type LaneEntry = {
  kind: "lane";
  key: string;
  source: DeletedSource;
  lane: DeletedLaneSnapshot;
  /** The chats that went with the lane's delete: Restore brings them back. */
  chats: DeletedChat[];
  at: number;
};

type ChatEntry = {
  kind: "chat";
  key: string;
  source: DeletedSource;
  chat: DeletedChat;
  at: number;
};

type Entry = LaneEntry | ChatEntry;

function chatTitle(chat: DeletedChat): string {
  return chat.title?.trim() || (isCli(chat) ? "Untitled CLI session" : "Untitled chat");
}

/** A deleted agent CLI terminal (Claude Code, Codex, …): Reopen relaunches it in its lane. */
function isCli(chat: DeletedChat): boolean {
  return chat.kind === "cli";
}

/** The row's logo: a CLI's own tool, else the agent that keeps the conversation. */
function deletedChatToolType(chat: DeletedChat): TerminalToolType {
  return isCli(chat) && chat.toolType ? chat.toolType as TerminalToolType : PROVIDER_TOOL_TYPE[chat.sourceProvider];
}

function timeOf(iso: string | null | undefined): number {
  const ms = Date.parse(iso ?? "");
  return Number.isFinite(ms) ? ms : 0;
}

function errorText(error: unknown): string {
  return ipcErrorMessage(error) || "Something went wrong.";
}

function daysLeft(lane: DeletedLaneSnapshot): string {
  const days = Math.max(0, Math.ceil((timeOf(lane.expiresAt) - Date.now()) / DAY_MS));
  return days <= 1 ? "kept 1 more day" : `kept ${days} more days`;
}

function chatKey(source: DeletedSource, chat: DeletedChat): string {
  return `${source.pin.key}\nchat\n${chat.id}`;
}

function chatMatches(chat: DeletedChat, needle: string): boolean {
  return chatTitle(chat).toLowerCase().includes(needle)
    || (chat.laneName ?? "").toLowerCase().includes(needle)
    || importProviderLabel(chat.sourceProvider as ExternalSessionProvider).toLowerCase().includes(needle);
}

/**
 * Every machine's lanes and chats as one list. A chat that went with a lane
 * delete sits under that lane when the lane's work was kept; otherwise it is
 * its own row.
 */
function buildEntries(machines: readonly MachineDeleted[]): Entry[] {
  const entries: Entry[] = [];
  for (const machine of machines) {
    const source: DeletedSource = { pin: machine.pin, machineName: machine.machineName };
    const lanes = new Map<string, LaneEntry>();
    for (const lane of machine.lanes ?? []) {
      const entry: LaneEntry = { kind: "lane", key: `${machine.pin.key}\nlane\n${lane.id}`, source, lane, chats: [], at: timeOf(lane.deletedAt) };
      entries.push(entry);
      // A freed lane is still here (archived); its chats were never deleted.
      const held = lanes.get(lane.laneId);
      if (lane.kind !== "freed" && (!held || held.at < entry.at)) lanes.set(lane.laneId, entry);
    }
    for (const chat of machine.chats ?? []) {
      const owner = chat.withLane && !chat.laneExists && chat.laneId ? lanes.get(chat.laneId) : undefined;
      if (owner) owner.chats.push(chat);
      else entries.push({ kind: "chat", key: chatKey(source, chat), source, chat, at: timeOf(chat.deletedAt) });
    }
  }
  for (const entry of entries) {
    if (entry.kind === "lane") entry.chats.sort((a, b) => timeOf(b.lastActiveAt ?? b.deletedAt) - timeOf(a.lastActiveAt ?? a.deletedAt));
  }
  return entries.sort((a, b) => b.at - a.at);
}

/** The entries a filter and a search leave, newest first. */
function filterEntries(entries: readonly Entry[], kind: KindFilter, query: string): Entry[] {
  const needle = query.trim().toLowerCase();
  const out: Entry[] = [];
  for (const entry of entries) {
    if (entry.kind === "chat") {
      if (kind === "lanes") continue;
      if (!needle || chatMatches(entry.chat, needle)) out.push(entry);
      continue;
    }
    if (kind === "chats") {
      // The lane's chats on their own, each a row.
      for (const chat of entry.chats) {
        if (!needle || chatMatches(chat, needle)) {
          out.push({ kind: "chat", key: chatKey(entry.source, chat), source: entry.source, chat, at: timeOf(chat.deletedAt) });
        }
      }
      continue;
    }
    const laneHit = !needle
      || entry.lane.laneName.toLowerCase().includes(needle)
      || (entry.lane.branchName ?? "").toLowerCase().includes(needle);
    if (laneHit) {
      out.push(entry);
      continue;
    }
    const chats = entry.chats.filter((chat) => chatMatches(chat, needle));
    if (chats.length > 0) out.push({ ...entry, chats });
  }
  return kind === "chats" ? out.sort((a, b) => b.at - a.at) : out;
}

function LanePlace({ chat }: { chat: DeletedChat }) {
  if (!chat.laneExists) {
    return <span className="ade-rd-gone">{chat.laneName ? `${chat.laneName} (deleted)` : "Lane deleted"}</span>;
  }
  return <LaneChip laneName={chat.laneName ?? "Its lane"} laneColor={chat.laneColor} maxWidth={180} />;
}

function ChatMeta({ chat, model }: { chat: DeletedChat; model?: string | null }) {
  return (
    <MetaLine
      items={[
        <LanePlace key="lane" chat={chat} />,
        <span key="when" className="kit-num">Deleted {relativeWhen(chat.deletedAt)}</span>,
        isCli(chat) ? (chat.resumable ? "CLI session" : "CLI session, starts fresh") : null,
        model,
      ]}
    />
  );
}

/** The square at the start of a lane row: the lane mark on the lane colour. */
function LaneMark() {
  const color = laneDisplayColor(null);
  return (
    <span
      className="ade-ar-mark"
      style={{
        background: `color-mix(in srgb, ${color} 16%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 28%, transparent)`,
      }}
    >
      <LaneLogoMark color={color} size={15} />
    </span>
  );
}

const DeletedChatRow = React.memo(function DeletedChatRow({
  entry,
  busy,
  reopening,
  machineHint,
  onOpen,
  onReopen,
  onRemove,
}: {
  entry: ChatEntry;
  busy: boolean;
  reopening: boolean;
  machineHint: string | undefined;
  onOpen: (entry: ChatEntry) => void;
  onReopen: (entry: ChatEntry) => void;
  onRemove: (entry: ChatEntry) => void;
}) {
  const { chat } = entry;
  const model = modelDisplayName(chat.modelId);
  return (
    <div role="listitem" className="ade-ar-row ade-rd-row" data-reopening={reopening || undefined} title={machineHint}>
      <button
        type="button"
        className="ade-rd-open"
        onClick={() => onOpen(entry)}
        aria-label={`Open ${chatTitle(chat)}`}
        data-deleted-chat-row={chat.id}
      >
        <span className="ade-ar-mark">
          <ToolLogo toolType={deletedChatToolType(chat)} size={15} />
        </span>
        <span className="ade-rd-text">
          <span className="ade-ar-title">{chatTitle(chat)}</span>
          <ChatMeta chat={chat} model={model} />
        </span>
      </button>
      <div className="ade-rd-actions">
        <button
          type="button"
          aria-label="Remove from list"
          title="Remove from list"
          disabled={busy}
          onClick={() => onRemove(entry)}
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
          onClick={() => (chat.laneExists ? onReopen(entry) : onOpen(entry))}
        >
          {reopening ? <CircleNotch size={12} className="animate-spin" /> : <ArrowCounterClockwise size={12} />}
          {reopening ? "Reopening…" : chat.laneExists ? "Reopen" : "Reopen…"}
        </button>
      </div>
    </div>
  );
});

/** A deleted lane, with the chats that went with it under it. */
const DeletedLaneRow = React.memo(function DeletedLaneRow({
  entry,
  busy,
  restoring,
  machineHint,
  onRestore,
  onDrop,
  onOpenChat,
}: {
  entry: LaneEntry;
  busy: boolean;
  restoring: boolean;
  machineHint: string | undefined;
  onRestore: (entry: LaneEntry) => void;
  onDrop: (entry: LaneEntry) => void;
  onOpenChat: (entry: ChatEntry) => void;
}) {
  const { lane, chats } = entry;
  const freed = lane.kind === "freed";
  const chatCount = chats.length === 1 ? "its chat" : `its ${chats.length} chats`;
  return (
    <div role="listitem" className="ade-rd-lane" title={machineHint}>
      <div className="ade-ar-row ade-rd-row">
        <div className="ade-rd-open ade-rd-info">
          <LaneMark />
          <span className="ade-rd-text">
            <span className="ade-ar-title">{lane.laneName}</span>
            <MetaLine
              items={[
                lane.branchName ? <span className="ade-ar-branch">{lane.branchName}</span> : null,
                lane.uncommitted ? "Uncommitted files saved" : "Unpushed commits saved",
                <span className="kit-num">{freed ? "Space freed" : "Deleted"} {relativeWhen(lane.deletedAt)}, {daysLeft(lane)}</span>,
              ]}
            />
          </span>
        </div>
        <div className="ade-rd-actions">
          <button
            type="button"
            aria-label="Drop saved work"
            title="Drop saved work"
            disabled={busy}
            onClick={() => onDrop(entry)}
            className="ade-ar-icon-btn ade-rd-hover"
          >
            <X size={14} />
          </button>
          <button
            type="button"
            className="ade-modern-btn"
            data-size="sm"
            disabled={busy}
            title={freed ? "Put the lane's files back" : chats.length > 0 ? `Bring back the lane and ${chatCount}` : "Bring back the lane"}
            onClick={() => onRestore(entry)}
          >
            {restoring ? <CircleNotch size={12} className="animate-spin" /> : <ArrowCounterClockwise size={12} />}
            {freed ? (restoring ? "Putting back…" : "Put back") : restoring ? "Restoring…" : "Restore"}
          </button>
        </div>
      </div>
      {chats.length > 0 ? (
        <div role="list" aria-label={`Chats of ${lane.laneName}`} className="ade-rd-lane-chats">
          {chats.map((chat) => (
            <button
              key={chat.id}
              type="button"
              role="listitem"
              className="ade-rd-lane-chat"
              onClick={() => onOpenChat({ kind: "chat", key: chatKey(entry.source, chat), source: entry.source, chat, at: timeOf(chat.deletedAt) })}
              aria-label={`Open ${chatTitle(chat)}`}
              data-deleted-chat-row={chat.id}
            >
              <ToolLogo toolType={deletedChatToolType(chat)} size={13} />
              <span className="ade-rd-lane-chat-title">{chatTitle(chat)}</span>
              {modelDisplayName(chat.modelId) ? <span className="ade-rd-lane-chat-meta">{modelDisplayName(chat.modelId)}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
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
  pin: OpenProjectBinding;
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
      icon={<ToolLogo toolType={deletedChatToolType(chat)} size={18} />}
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
            <span>
              {!isCli(chat)
                ? `Picks up where it left off, in ${chat.laneName ?? "its lane"}.`
                : chat.resumable
                  ? `Relaunches the CLI in ${chat.laneName ?? "its lane"}, resuming its conversation.`
                  : `Starts a new CLI in ${chat.laneName ?? "its lane"}: ADE can't resume its conversation.`}
            </span>
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
            {reopening ? "Reopening…" : needsLane ? (isCli(chat) ? "Reopen in this lane" : "Reopen as a copy") : "Reopen"}
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

/**
 * Reopens a restored lane's chats from this client, for a machine whose ADE
 * restores the lane alone (no `reopenedChats` in its answer). Oldest first,
 * so the newest chat is the newest in the lane again.
 */
async function reopenChatsHere(
  chats: readonly DeletedChat[],
  laneId: string,
  pin: OpenProjectBinding,
): Promise<{ reopened: RestoredLaneChat[]; failed: number }> {
  const out = { reopened: [] as RestoredLaneChat[], failed: 0 };
  for (const chat of [...chats].reverse()) {
    try {
      const result = await window.ade.agentChat.reopenDeleted({ id: chat.id, laneId }, pin);
      out.reopened.push({ chatSessionId: result.chatSessionId, title: chat.title });
    } catch {
      out.failed += 1;
    }
  }
  return out;
}

export function RecentlyDeletedSection() {
  const { machines, noCopy, reload } = useDeletedEverywhere();
  const [query, setQuery] = React.useState("");
  const [kind, setKind] = React.useState<KindFilter>("all");
  const [shownRows, setShownRows] = React.useState(PAGE_ROWS);
  const [open, setOpen] = React.useState<ChatEntry | null>(null);
  const [lanes, setLanes] = React.useState<LaneSummary[] | null>(null);
  const [lanesError, setLanesError] = React.useState<string | null>(null);
  const [targetLaneId, setTargetLaneId] = React.useState("");
  const [running, setRunning] = React.useState<{ key: string; kind: "reopen" | "remove" | "restore" | "drop" } | null>(null);
  const [actionError, setActionError] = React.useState<{ key: string; message: string } | null>(null);

  const entries = React.useMemo(() => buildEntries(machines), [machines]);
  const counts = React.useMemo(() => {
    let laneCount = 0;
    let chatCount = 0;
    for (const entry of entries) {
      if (entry.kind === "lane") {
        laneCount += 1;
        chatCount += entry.chats.length;
      } else {
        chatCount += 1;
      }
    }
    return { all: laneCount + chatCount, lanes: laneCount, chats: chatCount };
  }, [entries]);
  const visible = React.useMemo(() => filterEntries(entries, kind, query), [entries, kind, query]);
  const groups = React.useMemo(() => {
    const out: Array<{ label: string; rows: Entry[] }> = [];
    for (const entry of visible.slice(0, shownRows)) {
      const label = sessionDateGroup(entry.at || null);
      const last = out[out.length - 1];
      if (last?.label === label) last.rows.push(entry);
      else out.push({ label, rows: [entry] });
    }
    return out;
  }, [shownRows, visible]);

  // The machine is named on hover only when the list holds more than one.
  const severalMachines = machines.length > 1;
  const machineHint = (source: DeletedSource) => (severalMachines ? `On ${source.machineName}` : undefined);

  // The open chat, read again from its machine's list so a reload updates it.
  const openKey = open?.key ?? null;
  const openChat = React.useMemo(() => {
    if (!open) return null;
    const machine = machines.find((entry) => entry.pin.key === open.source.pin.key);
    return machine?.chats?.find((chat) => chat.id === open.chat.id) ?? null;
  }, [machines, open]);

  // Lanes are needed only to reopen a chat whose lane was deleted, on its machine.
  const lanesPin = open && openChat && !openChat.laneExists ? open.source.pin : null;
  const lanesPinKey = lanesPin?.key ?? null;
  React.useEffect(() => {
    setLanes(null);
    setLanesError(null);
    setTargetLaneId("");
    if (!lanesPin) return;
    let cancelled = false;
    void window.ade.lanes.list({ includeArchived: false, includeStatus: false }, lanesPin)
      .then((list) => {
        if (!cancelled) setLanes(list.filter((lane) => !lane.archivedAt));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLanes([]);
        setLanesError(`Couldn't load the lanes: ${errorText(error)}`);
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the machine and the chat, not on the pin object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lanesPinKey, openKey]);

  const openEntry = React.useCallback((entry: ChatEntry) => {
    setActionError(null);
    setOpen(entry);
  }, []);

  const reopen = React.useCallback(async (entry: ChatEntry) => {
    if (running) return;
    const { chat, source } = entry;
    const laneId = chat.laneExists ? null : targetLaneId || null;
    if (!chat.laneExists && !laneId) return;
    setRunning({ key: entry.key, kind: "reopen" });
    setActionError(null);
    try {
      const result = await window.ade.agentChat.reopenDeleted({ id: chat.id, ...(laneId ? { laneId } : {}) }, source.pin);
      setOpen(null);
      const cli = result.kind === "cli";
      showToast({
        id: TOAST_ID,
        tone: "success",
        title: cli ? "CLI session reopened" : "Chat reopened",
        message: result.mode === "copy"
          ? `${chatTitle(chat)}, as a copy in the lane you picked.`
          : result.notice
            ? `${chatTitle(chat)}. ${result.notice}`
            : chatTitle(chat),
        actions: [{ label: cli ? "Open session" : "Open chat", onClick: () => openChatInWork(result, source.pin) }],
      });
      openChatInWork(result, source.pin);
    } catch (error) {
      setActionError({ key: entry.key, message: errorText(error) });
      // Reopened from the list without the dialog: open it to show why.
      setOpen(entry);
    } finally {
      setRunning(null);
      reload(source.pin.key);
    }
  }, [reload, running, targetLaneId]);

  const remove = React.useCallback(async (entry: ChatEntry) => {
    if (running) return;
    const { chat, source } = entry;
    const ok = await confirmDialog({
      title: "Remove from Recently deleted?",
      message: `You won't be able to reopen “${chatTitle(chat)}” in ADE anymore. ${importProviderLabel(chat.sourceProvider)} keeps its own copy${isCli(chat) && !chat.resumable ? ", if it made one" : ""}.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    setRunning({ key: entry.key, kind: "remove" });
    try {
      await window.ade.agentChat.removeDeleted({ ids: [chat.id] }, source.pin);
      setOpen((current) => (current?.key === entry.key ? null : current));
    } catch (error) {
      showToast({ id: TOAST_ID, tone: "error", title: "Couldn't remove that chat", message: errorText(error) });
    } finally {
      setRunning(null);
      reload(source.pin.key);
    }
  }, [reload, running]);

  const restore = React.useCallback(async (entry: LaneEntry) => {
    if (running) return;
    const { lane, source } = entry;
    setRunning({ key: entry.key, kind: "restore" });
    try {
      let result: RestoreDeletedLaneResult = await window.ade.lanes.restoreDeleted({ id: lane.id }, source.pin);
      if (result.reopenedChats === undefined && entry.chats.length > 0) {
        const chats = await reopenChatsHere(entry.chats, result.lane.id, source.pin);
        result = { ...result, reopenedChats: chats.reopened, chatsNotReopened: chats.failed };
      }
      captureLaneSetupAnalytics({ action: "deleted_lane_restored", outcome: result.restoredUncommitted ? "completed" : "failed" });
      showToast({ id: TOAST_ID, ...restoredLaneToast(lane, result, restoredLaneOpeners(result, source.pin)) });
    } catch (error) {
      captureLaneSetupAnalytics({ action: "deleted_lane_restored", outcome: "failed" });
      showToast({
        id: TOAST_ID,
        tone: "error",
        title: `Couldn't restore ${lane.laneName}`,
        message: errorText(error),
        replayMask: { title: true },
      });
    } finally {
      setRunning(null);
      reload(source.pin.key);
    }
  }, [reload, running]);

  const drop = React.useCallback(async (entry: LaneEntry) => {
    if (running) return;
    const { lane, source } = entry;
    const ok = await confirmDialog({
      title: "Drop this lane's saved work?",
      message: lane.kind === "freed"
        ? `“${lane.laneName}” stays archived, but ADE will no longer be able to put back its uncommitted files.`
        : lane.uncommitted
          ? `ADE will no longer be able to bring back “${lane.laneName}” or its uncommitted files.`
          : `ADE will no longer be able to bring back “${lane.laneName}”. Commits that only it held are lost.`,
      confirmLabel: "Drop",
      destructive: true,
    });
    if (!ok) return;
    setRunning({ key: entry.key, kind: "drop" });
    try {
      await window.ade.lanes.removeDeleted({ id: lane.id }, source.pin);
    } catch (error) {
      showToast({ id: TOAST_ID, tone: "error", title: "Couldn't drop that lane", message: errorText(error) });
    } finally {
      setRunning(null);
      reload(source.pin.key);
    }
  }, [reload, running]);

  const loaded = machines.filter((machine) => machine.lanes != null && machine.chats != null);
  const pending = machines.filter((machine) => machine.lanes == null || machine.chats == null);
  const failed = loaded.filter((machine) => machine.error);
  const outdated = loaded.filter((machine) => machine.outdated);
  const hidden = Math.max(0, visible.length - shownRows);
  const busy = running != null;

  const toolbar = counts.all > 0 ? (
    <div className="ade-ar-toolbar">
      <div role="radiogroup" aria-label="Show" className="kit-seg" data-case="sentence">
        {([["all", "All"], ["lanes", "Lanes"], ["chats", "Chats"]] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={kind === value}
            onClick={() => {
              setKind(value);
              setShownRows(PAGE_ROWS);
            }}
          >
            {label}
            <span className="kit-num ade-ar-count">{counts[value]}</span>
          </button>
        ))}
      </div>
      <label className="ade-ar-search">
        <MagnifyingGlass size={13} aria-hidden="true" />
        <input
          className="kit-input"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setShownRows(PAGE_ROWS);
          }}
          placeholder="Search lanes and chats"
          aria-label="Search deleted lanes and chats"
        />
      </label>
    </div>
  ) : null;

  return (
    <SettingsColumn wide>
      <section
        id={RECENTLY_DELETED_SETTINGS_ANCHOR}
        data-settings-anchor={RECENTLY_DELETED_SETTINGS_ANCHOR}
        className="ade-modern-page"
        aria-label="Recently deleted"
      >
        <div className="ade-ap-section">
          {toolbar}

          {failed.map((machine) => (
            <Banner
              key={machine.pin.key}
              layout="inline"
              model={{
                id: `recently-deleted-load-error-${machine.pin.key}`,
                tone: "error",
                title: `Couldn't read ${machine.machineName}`,
                detail: machine.error,
                actions: [{ label: "Try again", onClick: () => reload(machine.pin.key) }],
                report: { surface: "recently_deleted_load", technicalDetail: machine.error ?? "" },
              }}
            />
          ))}
          {outdated.map((machine) => (
            <p key={machine.pin.key} className="ade-modern-muted">
              {machine.machineName} runs an older ADE — update it there to see its deleted chats.
            </p>
          ))}

          {noCopy ? (
            <NoProjectCopyNotice />
          ) : loaded.length === 0 ? (
            <p className="ade-modern-muted">Looking for deleted lanes and chats…</p>
          ) : counts.all === 0 && pending.length === 0 ? (
            <div className="ade-ar-empty">
              <ClockCounterClockwise size={22} weight="light" />
              <div className="ade-ap-rowtitle">Nothing deleted</div>
              <p className="ade-modern-muted">Lanes and chats you delete show up here, so you can bring them back.</p>
            </div>
          ) : visible.length === 0 && query.trim() ? (
            <p className="ade-modern-muted">Nothing deleted matches “{query.trim()}”.</p>
          ) : (
            <div className="ade-ar-table">
              {groups.map((group) => (
                <div key={group.label} className="ade-ar-block">
                  <div className="ade-ar-group">
                    <span className="kit-eyebrow">{group.label}</span>
                    <span className="ade-ar-group-count kit-num">{group.rows.length}</span>
                  </div>
                  <div role="list" aria-label={group.label} className="ade-modern-rows ade-ar-list">
                    {group.rows.map((entry) => entry.kind === "lane" ? (
                      <DeletedLaneRow
                        key={entry.key}
                        entry={entry}
                        busy={busy}
                        restoring={running?.key === entry.key && running.kind === "restore"}
                        machineHint={machineHint(entry.source)}
                        onRestore={(target) => void restore(target)}
                        onDrop={(target) => void drop(target)}
                        onOpenChat={openEntry}
                      />
                    ) : (
                      <DeletedChatRow
                        key={entry.key}
                        entry={entry}
                        busy={busy}
                        reopening={running?.key === entry.key && running.kind === "reopen"}
                        machineHint={machineHint(entry.source)}
                        onOpen={openEntry}
                        onReopen={(target) => void reopen(target)}
                        onRemove={(target) => void remove(target)}
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
          {loaded.length > 0 && pending.length > 0 ? (
            <p className="ade-modern-muted">Still reading {pending.map((machine) => machine.machineName).join(", ")}…</p>
          ) : null}
        </div>
      </section>
      {open && openChat ? (
        <DeletedChatDialog
          key={open.key}
          chat={openChat}
          pin={open.source.pin}
          lanes={lanes}
          lanesError={lanesError}
          targetLaneId={targetLaneId}
          onTargetLaneChange={setTargetLaneId}
          reopening={running?.key === open.key && running.kind === "reopen"}
          removing={running?.key === open.key && running.kind === "remove"}
          error={actionError?.key === open.key ? actionError.message : null}
          onClose={() => setOpen(null)}
          onReopen={() => void reopen({ ...open, chat: openChat })}
          onRemove={() => void remove({ ...open, chat: openChat })}
        />
      ) : null}
    </SettingsColumn>
  );
}
