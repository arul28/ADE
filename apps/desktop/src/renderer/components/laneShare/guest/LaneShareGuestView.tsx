import React from "react";
import { logRendererDebugEvent } from "../../../lib/debugLog";
import { ArrowsClockwise, ArrowsLeftRight, ChatCircle, FolderPlus, Plus, Robot, SignOut, Terminal, TerminalWindow, X } from "@phosphor-icons/react";
import type { LaneShareReceivedEntry } from "../../../../shared/types/laneShare";
import { laneShareMayMove, type LaneShareGuestState } from "../../../../shared/laneShareRights";
import { parseCodedErrorMessage } from "../../../../shared/codedError";
import { leadingPromptCommandCharacter, LANE_SHARE_PLAIN_TEXT_ONLY_MESSAGE } from "../../../../shared/messageAuthor";
import { isLaunchProfile } from "../../../../shared/cliLaunch";
import { resolveChatProviderForDescriptor, resolveCliProviderForModel, resolveModelDescriptor } from "../../../../shared/modelRegistry";
import { Banner } from "../../ui/notice";
import { confirmDialog } from "../../ui/dialog";
import { showToast } from "../../app/toast/toastStore";
import { CloneLocallyDialog, type CloneLocallyTarget } from "../../projects/CloneLocallyDialog";
import { openProjectCopy } from "../../projects/AddProjectForm";
import { formatLaneShareEnd } from "../laneShareModel";
import type { LaneShareGuestConnection, LaneShareGuestConnectionState, LaneShareGuestSession } from "./laneShareGuestConnection";
import {
  clearLaneShareGuestNotice,
  laneShareGuestConnection,
  laneShareGuestProblem,
  leaveLaneShare,
  refreshLaneShareGuestState,
  retainLaneShareGuestConnection,
  useLaneShareGuestStore,
} from "./laneShareGuestStore";
import { LaneShareGuestChat, laneShareGuestModelLabel } from "./LaneShareGuestChat";
import { plainTerminalText } from "./laneShareGuestTranscript";
import { LaneShareGuestMoveCard, LaneShareGuestMoveOut } from "./LaneShareGuestMove";

/**
 * A shared lane opened by its guest: a header (lane, owner, connection),
 * the lane's sessions, and the open chat or read-only terminal. The view
 * holds the guest connection open while it is shown; closing it closes the
 * connection when nothing else uses it.
 */

const EMPTY_SESSIONS: LaneShareGuestSession[] = [];
const MAX_TERMINAL_CHARS = 200_000;
const GUEST_STATE_REFRESH_MS = 60_000;

export function laneShareGuestSessionIcon(kind: LaneShareGuestSession["kind"], size = 13) {
  if (kind === "chat") return <ChatCircle size={size} aria-hidden />;
  if (kind === "subagent") return <Robot size={size} aria-hidden />;
  if (kind === "cli") return <TerminalWindow size={size} aria-hidden />;
  return <Terminal size={size} aria-hidden />;
}

export function laneShareConnectionLabel(state: LaneShareGuestConnectionState | undefined): { text: string; tone: "ok" | "warn" | "crit" | null } {
  switch (state?.kind) {
    case "connected":
      return { text: "Connected", tone: "ok" };
    case "connecting":
      return { text: "Connecting…", tone: null };
    case "retrying":
      return { text: "Reconnecting…", tone: "warn" };
    case "host_offline":
      return { text: "Owner offline", tone: "warn" };
    case "stopped":
      return { text: state.reason === "ended" ? "Access ended" : state.reason === "paused" ? "Paused" : "Not connected", tone: "crit" };
    default:
      return { text: "Not connected", tone: null };
  }
}

/** A git origin from a repo key the directory gave (`github.com/owner/name`), or null. */
function repoUrlFromKey(repoKey: string | null): string | null {
  if (!repoKey) return null;
  const cleaned = repoKey.replace(/^repo:/, "").trim();
  if (!/^[a-z0-9.-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/i.test(cleaned)) return null;
  return `https://${cleaned}`;
}

/** A line the CLI reads as a command, which a guest may not type (as the host refuses for a first line). */
function commandLineCharacter(line: string): string | null {
  return leadingPromptCommandCharacter(line) ?? (line.trimStart().startsWith("#") ? "#" : null);
}

function GuestTerminal({
  session,
  grantId,
  connected,
  canType,
  guestState,
}: {
  session: LaneShareGuestSession;
  grantId: string;
  connected: boolean;
  canType: boolean;
  guestState: LaneShareGuestState | null;
}) {
  const sessionId = session.sessionId;
  const [text, setText] = React.useState("");
  const [line, setLine] = React.useState("");
  const [typing, setTyping] = React.useState(false);
  const [refusal, setRefusal] = React.useState<string | null>(null);
  const [exited, setExited] = React.useState<number | null | undefined>(undefined);
  const ref = React.useRef<HTMLPreElement | null>(null);
  React.useEffect(() => {
    const connection = laneShareGuestConnection(grantId);
    if (!connection || !connected) return;
    setText("");
    setExited(undefined);
    const off = connection.on("terminal", (event) => {
      if (event.sessionId !== sessionId) return;
      if (event.kind === "exit") {
        setExited(event.exitCode);
        return;
      }
      const chunk = plainTerminalText(event.kind === "snapshot" ? event.transcript : event.data);
      setText((previous) => {
        const next = event.kind === "snapshot" && !event.delta ? chunk : previous + chunk;
        return next.length > MAX_TERMINAL_CHARS ? next.slice(-MAX_TERMINAL_CHARS) : next;
      });
    });
    const unsubscribe = connection.subscribeTerminal(sessionId);
    return () => {
      off();
      unsubscribe();
    };
  }, [connected, grantId, sessionId]);
  React.useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);
  const commandChar = commandLineCharacter(line);
  const typeLine = async () => {
    const connection = laneShareGuestConnection(grantId);
    const value = line.trim();
    if (!connection || !value || typing || commandChar) return;
    setTyping(true);
    setRefusal(null);
    try {
      await connection.sendTerminalLine(sessionId, value);
      setLine("");
      void refreshLaneShareGuestState(grantId);
    } catch (error) {
      const parsed = parseCodedErrorMessage(error);
      setRefusal(parsed.message || "The owner's computer did not take this line.");
      if (parsed.code?.startsWith("lane_share_")) void refreshLaneShareGuestState(grantId);
    } finally {
      setTyping(false);
    }
  };
  const live = canType && connected && exited === undefined;
  const modelLabel = laneShareGuestModelLabel(session.modelId, guestState);
  const facts = [modelLabel, session.permissionMode ? `Mode: ${session.permissionMode}` : null].filter(Boolean).join(" · ");
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="lane-share-guest-terminal">
      <pre ref={ref} className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[11.5px] leading-[1.45] text-fg/85">
        {text || (connected ? "Waiting for output…" : "Waiting for the owner's computer…")}
      </pre>
      <div className="flex shrink-0 flex-col gap-1.5 border-t border-fg/[0.06] px-4 py-2 text-[11.5px] text-fg/50">
        {refusal ? (
          <Banner layout="inline" model={{ id: `lane-share-typing-${sessionId}`, tone: "warning", title: refusal, report: false, dismiss: { onDismiss: () => setRefusal(null) } }} />
        ) : null}
        {live ? (
          <div className="flex min-w-0 items-center gap-2">
            <input
              className="min-w-0 flex-1 rounded-md border border-fg/10 bg-transparent px-2 py-1 font-mono text-[12px] text-fg/85 outline-none focus:border-fg/25"
              value={line}
              disabled={typing}
              placeholder="Type a line for the CLI"
              aria-label="A line for the CLI"
              onChange={(event) => setLine(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void typeLine();
                }
              }}
            />
            <button type="button" className="kit-btn" data-size="sm" disabled={!line.trim() || typing || Boolean(commandChar)} onClick={() => { void typeLine(); }}>
              Send line
            </button>
          </div>
        ) : null}
        {live && commandChar ? <span className="text-[var(--color-warning)]">{LANE_SHARE_PLAIN_TEXT_ONLY_MESSAGE}</span> : null}
        <span>
          {exited !== undefined ? `Exited${exited != null ? ` (${exited})` : ""}. ` : ""}
          {live ? "Each line counts as one message." : "Read only: you can watch this session, not type in it."}
          {facts ? ` ${facts}` : ""}
        </span>
      </div>
    </div>
  );
}

type GuestStartKind = "chat" | "cli";

/** The provider a permitted model starts with, or null when this kind cannot start it. */
function startProviderFor(kind: GuestStartKind, modelId: string): string | null {
  const descriptor = resolveModelDescriptor(modelId);
  if (!descriptor) return null;
  if (kind === "chat") return resolveChatProviderForDescriptor(descriptor).provider;
  const profile = resolveCliProviderForModel(descriptor);
  return profile && isLaunchProfile(profile) ? profile : null;
}

/**
 * Starts a chat or a CLI session on the shared lane with only what the owner
 * allows: a permitted model, reasoning level and mode. The host checks each
 * value again; its refusal shows here.
 */
function GuestStartPanel({
  kind,
  connection,
  guestState,
  onStarted,
  onCancel,
}: {
  kind: GuestStartKind;
  connection: LaneShareGuestConnection;
  guestState: LaneShareGuestState;
  onStarted: (sessionId: string | null) => void;
  onCancel: () => void;
}) {
  const rights = guestState.rights;
  const models = React.useMemo(
    () => guestState.models.filter((modelId) => startProviderFor(kind, modelId) != null),
    [guestState.models, kind],
  );
  const [modelId, setModelId] = React.useState(models[0] ?? "");
  const [reasoningEffort, setReasoningEffort] = React.useState(rights.run.reasoningLevels[0] ?? "");
  const [permissionMode, setPermissionMode] = React.useState<string>(rights.run.permissionModes[0] ?? "");
  const [firstLine, setFirstLine] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [refusal, setRefusal] = React.useState<string | null>(null);
  const canTypeFirst = kind === "cli" && rights.run.typeInCliSessions;
  const firstLineCommand = canTypeFirst ? commandLineCharacter(firstLine) : null;

  const start = async () => {
    const provider = modelId ? startProviderFor(kind, modelId) : null;
    if (!provider || busy || firstLineCommand) return;
    setBusy(true);
    setRefusal(null);
    try {
      const args: Record<string, unknown> = {
        provider,
        modelId,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(canTypeFirst && firstLine.trim() ? { initialInput: firstLine.trim() } : {}),
      };
      const result = await connection.call<{ id?: unknown; sessionId?: unknown } | null>(kind === "chat" ? "chat.create" : "work.startCliSession", args);
      const id = typeof result?.sessionId === "string" ? result.sessionId : typeof result?.id === "string" ? result.id : null;
      await connection.refreshSessions().catch((error: unknown) => {
        // The session list reads again on the next host event.
        logRendererDebugEvent("lane_share.guest_sessions_read_failed", { error: error instanceof Error ? error.message : String(error) });
      });
      onStarted(id);
    } catch (error) {
      setRefusal(parseCodedErrorMessage(error).message || "The owner's computer refused this.");
    } finally {
      setBusy(false);
    }
  };

  const select = (label: string, value: string, values: readonly string[], onChange: (next: string) => void) => (
    <label className="flex items-center gap-1.5 text-[11.5px] text-fg/60">
      <span>{label}</span>
      <select
        className="max-w-[200px] rounded-md border border-fg/10 bg-transparent px-1.5 py-0.5 text-[11.5px] text-fg/85"
        value={value}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
      >
        {values.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
      </select>
    </label>
  );

  return (
    <div className="kit-panel flex max-w-[640px] flex-col gap-2 p-3" data-testid={`lane-share-guest-start-${kind}`}>
      <span className="text-[12.5px] font-medium text-fg/85">{kind === "chat" ? "New chat" : "New CLI session"}</span>
      {models.length === 0 ? (
        <span className="text-[12px] text-fg/55">The owner has not allowed a model that can start this here.</span>
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          {select("Model", modelId, models, setModelId)}
          {rights.run.reasoningLevels.length > 0 ? select("Reasoning", reasoningEffort, rights.run.reasoningLevels, setReasoningEffort) : null}
          {rights.run.permissionModes.length > 0 ? select("Mode", permissionMode, rights.run.permissionModes, setPermissionMode) : null}
        </div>
      )}
      {canTypeFirst && models.length > 0 ? (
        <input
          className="min-w-0 rounded-md border border-fg/10 bg-transparent px-2 py-1 text-[12px] outline-none focus:border-fg/25"
          value={firstLine}
          placeholder="First line for the CLI (optional, counts as one message)"
          aria-label="First line for the CLI"
          onChange={(event) => setFirstLine(event.target.value)}
        />
      ) : null}
      {firstLineCommand ? <span className="text-[11.5px] text-[var(--color-warning)]">{LANE_SHARE_PLAIN_TEXT_ONLY_MESSAGE}</span> : null}
      {refusal ? (
        <Banner layout="inline" model={{ id: `lane-share-start-${kind}`, tone: "warning", title: refusal, report: false, dismiss: { onDismiss: () => setRefusal(null) } }} />
      ) : null}
      <div className="flex items-center gap-2">
        <button type="button" className="kit-btn kit-btn-primary" data-size="sm" disabled={!modelId || busy || Boolean(firstLineCommand)} onClick={() => { void start(); }}>
          {busy ? "Starting…" : "Start"}
        </button>
        <button type="button" className="kit-btn" data-size="sm" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export function LaneShareGuestView({
  entry,
  sessionId,
  onSelectSession,
  onClose,
}: {
  entry: LaneShareReceivedEntry;
  sessionId: string | null;
  onSelectSession: (sessionId: string | null) => void;
  onClose?: () => void;
}) {
  const grantId = entry.grantId;
  React.useEffect(() => retainLaneShareGuestConnection(entry), [entry.grantId, entry.laneId]); // eslint-disable-line react-hooks/exhaustive-deps
  const connectionState = useLaneShareGuestStore((state) => state.connections[grantId]);
  const sessions = useLaneShareGuestStore((state) => state.sessions[grantId] ?? EMPTY_SESSIONS);
  const guestState = useLaneShareGuestStore((state) => state.guestStates[grantId] ?? null);
  const notice = useLaneShareGuestStore((state) => state.notices[grantId] ?? null);
  const [cloneTarget, setCloneTarget] = React.useState<CloneLocallyTarget | null>(null);
  const [starting, setStarting] = React.useState<GuestStartKind | null>(null);
  const [movingOut, setMovingOut] = React.useState(false);
  const connected = connectionState?.kind === "connected";
  const connection = laneShareGuestConnection(grantId);

  // The host signals presence, rights and limits changes. A slow timer, only
  // while this view is on screen and connected, is the fallback, and re-reads
  // the session list.
  React.useEffect(() => {
    if (!connected) return;
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void refreshLaneShareGuestState(grantId, { withSessions: true });
    }, GUEST_STATE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [connected, grantId]);
  const ownerLabel = entry.giverLabel ?? "the owner";
  const selected = sessions.find((session) => session.sessionId === sessionId) ?? null;
  const label = laneShareConnectionLabel(connectionState);
  const repoUrl = repoUrlFromKey(entry.repoKey);
  const machineName = connectionState?.kind === "connected" ? connectionState.hostName : null;

  const leave = async () => {
    const ok = await confirmDialog({
      title: "Leave this lane?",
      message: "You lose access to this lane. The owner can invite you again.",
      confirmLabel: "Leave",
      destructive: true,
    });
    if (!ok) return;
    try {
      await leaveLaneShare(grantId);
      showToast({ tone: "success", title: "You left the lane" });
      onClose?.();
    } catch (error) {
      showToast({ tone: "error", title: "Couldn't leave the lane", message: laneShareGuestProblem(error).message });
    }
  };

  const stopped = connectionState?.kind === "stopped" ? connectionState : null;
  const rights = guestState?.rights ?? null;
  const paused = guestState?.state === "paused";
  const canStartChat = Boolean(rights?.run.startChats) && connected && !paused;
  const canStartCli = Boolean(rights?.run.startCliSessions) && connected && !paused;
  const canTypeCli = Boolean(rights?.run.typeInCliSessions) && !paused;
  const waiting = connectionState?.kind === "retrying" || connectionState?.kind === "host_offline" ? connectionState : null;
  // Moving a chat to the owner needs Collaborate (send and start chats); the host checks it again.
  const canMoveOut = laneShareMayMove(rights) && connected && !paused;
  const openAddProject = () => {
    if (!repoUrl) return;
    setCloneTarget({
      displayName: entry.projectLabel ?? "this project",
      machineName: ownerLabel,
      gitOriginUrl: repoUrl,
      remoteKey: `lane-share:${grantId}`,
    });
  };
  const moveCard = connection ? (
    <LaneShareGuestMoveCard entry={entry} connection={connection} guestState={guestState} onAddProject={openAddProject} />
  ) : null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col" data-testid="lane-share-guest-view">
      <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-fg/[0.06] px-4 py-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="min-w-0 truncate text-[13px] font-medium text-fg/90" title={entry.laneLabel ?? undefined}>
            {entry.laneLabel ?? "Shared lane"}
            {selected ? <span className="text-fg/50"> / {selected.title}</span> : null}
          </span>
          <span className="min-w-0 truncate text-[11px] text-fg/50">
            Shared by {ownerLabel}
            {entry.projectLabel ? ` · ${entry.projectLabel}` : ""}
            {machineName ? ` · on ${machineName}` : ""}
            {` · ${formatLaneShareEnd(entry.endsAt)}`}
          </span>
        </div>
        <span className="kit-tag shrink-0" data-tone={label.tone ?? undefined}>{label.text}</span>
        {selected ? (
          <button type="button" className="kit-btn" data-size="sm" onClick={() => onSelectSession(null)}>All sessions</button>
        ) : null}
        {repoUrl ? (
          <button
            type="button"
            className="kit-btn"
            data-size="sm"
            title="Add the repository of this lane on this computer. The share works without it."
            onClick={openAddProject}
          >
            <FolderPlus size={13} />
            Add this project
          </button>
        ) : null}
        <button type="button" className="kit-btn" data-size="sm" onClick={() => { void leave(); }}>
          <SignOut size={13} />
          Leave
        </button>
        {onClose ? (
          <button type="button" className="kit-btn" data-size="sm" aria-label="Close the shared lane" onClick={onClose}>
            <X size={13} />
          </button>
        ) : null}
      </div>
      {notice ? (
        <div className="shrink-0 px-4 pt-2">
          <Banner layout="inline" model={{ id: `lane-share-notice-${grantId}`, tone: "info", title: notice.message, report: false, dismiss: { onDismiss: () => clearLaneShareGuestNotice(grantId) } }} />
        </div>
      ) : null}
      {stopped ? (
        <div className="shrink-0 px-4 pt-2">
          <Banner
            layout="inline"
            model={{
              id: `lane-share-stopped-${grantId}`,
              tone: stopped.reason === "ended" || stopped.reason === "not_for_account" ? "neutral" : "warning",
              title: stopped.reason === "ended" ? "Access ended" : stopped.reason === "access_changed" ? "Access changed" : stopped.message,
              detail: stopped.reason === "ended" || stopped.reason === "access_changed" ? stopped.message : undefined,
              report: false,
              actions: stopped.reason === "ended" || stopped.reason === "not_for_account"
                ? []
                : [{ label: "Try again", onClick: () => laneShareGuestConnection(grantId)?.reconnect() }],
            }}
          />
        </div>
      ) : waiting ? (
        <div className="flex shrink-0 items-center gap-2 px-4 pt-2 text-[12px] text-fg/60">
          <span className="min-w-0 flex-1">{waiting.message}</span>
          <button type="button" className="kit-btn" data-size="sm" onClick={() => laneShareGuestConnection(grantId)?.reconnect()}>
            <ArrowsClockwise size={13} />
            Try now
          </button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {selected && connection && (selected.kind === "chat" || selected.kind === "subagent") ? (
          <LaneShareGuestChat
            key={selected.sessionId}
            connection={connection}
            sessionId={selected.sessionId}
            connected={connected}
            selfUserId={connectionState?.kind === "connected" ? connectionState.selfUserId : null}
            ownerLabel={ownerLabel}
            guestState={guestState}
            composerCard={moveCard}
          />
        ) : selected ? (
          <GuestTerminal
            key={selected.sessionId}
            session={selected}
            grantId={grantId}
            connected={connected}
            canType={canTypeCli && selected.kind === "cli"}
            guestState={guestState}
          />
        ) : (
          <div className="h-full overflow-y-auto px-4 py-3">
            {connected && sessions.length === 0 ? <div className="text-[12px] text-fg/55">Nothing you can see on this lane yet.</div> : null}
            {!connected && !stopped ? <div className="text-[12px] text-fg/50">Waiting for the owner's computer…</div> : null}
            {moveCard ? <div className="mb-3 max-w-[640px] empty:hidden">{moveCard}</div> : null}
            {(canStartChat || canStartCli) && !starting ? (
              <div className="mb-2 flex items-center gap-2">
                {canStartChat ? (
                  <button type="button" className="kit-btn" data-size="sm" onClick={() => setStarting("chat")}>
                    <Plus size={13} />
                    New chat
                  </button>
                ) : null}
                {canStartCli ? (
                  <button type="button" className="kit-btn" data-size="sm" onClick={() => setStarting("cli")}>
                    <TerminalWindow size={13} />
                    New CLI session
                  </button>
                ) : null}
                {canMoveOut && !movingOut ? (
                  <button type="button" className="kit-btn" data-size="sm" onClick={() => setMovingOut(true)}>
                    <ArrowsLeftRight size={13} />
                    Move a chat to {ownerLabel}'s computer
                  </button>
                ) : null}
              </div>
            ) : null}
            {movingOut && connection && guestState ? (
              <div className="mb-3">
                <LaneShareGuestMoveOut entry={entry} connection={connection} guestState={guestState} onClose={() => setMovingOut(false)} />
              </div>
            ) : null}
            {starting && connection && guestState ? (
              <div className="mb-3">
                <GuestStartPanel
                  kind={starting}
                  connection={connection}
                  guestState={guestState}
                  onCancel={() => setStarting(null)}
                  onStarted={(id) => {
                    setStarting(null);
                    if (id) onSelectSession(id);
                  }}
                />
              </div>
            ) : null}
            <div className="flex max-w-[640px] flex-col gap-1">
              {sessions.map((session) => (
                <button
                  key={session.sessionId}
                  type="button"
                  className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-fg/85 hover:bg-fg/[0.05]"
                  onClick={() => onSelectSession(session.sessionId)}
                >
                  <span className="shrink-0 text-fg/55">{laneShareGuestSessionIcon(session.kind)}</span>
                  <span className="min-w-0 flex-1 truncate" title={session.title}>{session.title}</span>
                  <span className="shrink-0 text-[11px] text-fg/45">
                    {session.kind === "shell" || (session.kind === "cli" && !canTypeCli) ? "Read only" : session.status}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <CloneLocallyDialog target={cloneTarget} onClose={() => setCloneTarget(null)} onOpenProject={openProjectCopy} />
    </div>
  );
}
