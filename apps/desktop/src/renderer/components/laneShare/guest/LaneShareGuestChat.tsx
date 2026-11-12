import React from "react";
import { logRendererDebugEvent } from "../../../lib/debugLog";
import { ChatText, Lock, PaperPlaneRight, Stop } from "@phosphor-icons/react";
import type { AgentChatEventEnvelope } from "../../../../shared/types/chat";
import {
  collapseWhitespace,
  MAX_THREAD_COMMENT_BODY_CHARS,
  MAX_THREAD_COMMENT_EXCERPT_CHARS,
  type ChatThreadComment,
} from "../../../../shared/threadComments";
import type { LaneShareGuestState } from "../../../../shared/laneShareRights";
import { LANE_SHARE_PLAIN_TEXT_ONLY_MESSAGE, leadingPromptCommandCharacter, parseMessageAuthor } from "../../../../shared/messageAuthor";
import { parseCodedErrorMessage } from "../../../../shared/codedError";
import { ChatMarkdown } from "../../chat/chatMarkdown";
import { Banner } from "../../ui/notice";
import { resolveModelDescriptor } from "../../../../shared/modelRegistry";
import { LaneShareMeta, laneShareModeTitle } from "../laneShareUi";
import type { LaneShareGuestConnection } from "./laneShareGuestConnection";
import { refreshLaneShareGuestState } from "./laneShareGuestStore";
import { buildLaneShareGuestTranscript, LANE_SHARE_GUEST_MAX_ROWS, type LaneShareGuestRow } from "./laneShareGuestTranscript";

/**
 * One chat of a shared lane, as the guest sees it. The transcript is built
 * from plain text (`buildLaneShareGuestTranscript`): no link opens, no image
 * loads, no path of the owner's computer is used here. The composer shows
 * only what the rights allow; the host checks every action again and its
 * refusal shows as an inline notice.
 */

/** Links and images in a shared chat are text only. */
const INERT_MARKDOWN = {
  a: ({ children }: { children?: React.ReactNode }) => <span className="break-words underline decoration-dotted">{children}</span>,
  img: () => null,
};

const MAX_EVENTS = LANE_SHARE_GUEST_MAX_ROWS * 8;
/** Characters of a reply quoted by a guest comment (the whole reply is too long). */
const COMMENT_QUOTE_CHARS = 300;

/** Comments of this chat from a host answer or event, kept as plain values. */
function threadCommentsOf(value: unknown, sessionId: string): ChatThreadComment[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is ChatThreadComment =>
    Boolean(entry)
    && typeof entry === "object"
    && entry.sessionId === sessionId
    && typeof entry.id === "string"
    && typeof entry.messageKey === "string"
    && typeof entry.body === "string");
}

/**
 * Whether the guest may see this model name: always without "Hide my
 * models", else only a permitted one. The host already hides the others;
 * this is the second check.
 */
export function laneShareGuestModelLabel(modelId: string | null | undefined, state: LaneShareGuestState | null): string | null {
  const model = typeof modelId === "string" ? modelId.trim() : "";
  if (!model || !state) return null;
  if (state.rights.privacy.hideModels && !state.models.includes(model)) return null;
  return model;
}

function messagesLeftText(state: LaneShareGuestState): string | null {
  const { messagesLeftToday, messagesLeftTotal, messagesPerDay, messagesTotal } = state.limits;
  if (messagesPerDay != null && messagesLeftToday != null) return `${messagesLeftToday} of ${messagesPerDay} left today`;
  if (messagesTotal != null && messagesLeftTotal != null) return `${messagesLeftTotal} of ${messagesTotal} left`;
  return null;
}

function limitReached(state: LaneShareGuestState): string | null {
  const { messagesLeftToday, messagesLeftTotal, dailyResetAt } = state.limits;
  if (messagesLeftTotal === 0) return "You used all the messages this share allows. Ask the owner for more.";
  if (messagesLeftToday === 0) {
    const at = dailyResetAt != null
      ? new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(dailyResetAt))
      : null;
    return at ? `No messages left today. They start again ${at} (the owner's clock).` : "No messages left today.";
  }
  return null;
}

function presenceText(state: LaneShareGuestState): string | null {
  const others = state.present.filter((entry) => !entry.self);
  if (others.length === 0) return null;
  const names = others.map((entry) => entry.name ?? (entry.kind === "owner" ? "The owner" : "A guest"));
  return names.length <= 2 ? `${names.join(" and ")} here` : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more here`;
}

/** The comments on one reply, as plain text, and a text-only box to add one. */
function GuestReplyComments({
  comments,
  canComment,
  selfUserId,
  ownerLabel,
  onAdd,
}: {
  comments: readonly ChatThreadComment[];
  canComment: boolean;
  selfUserId: string | null;
  ownerLabel: string;
  onAdd: (body: string) => Promise<boolean>;
}) {
  const [open, setOpen] = React.useState(false);
  const [body, setBody] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  if (comments.length === 0 && !canComment) return null;
  const add = async () => {
    const value = body.trim();
    if (!value || busy) return;
    setBusy(true);
    const ok = await onAdd(value);
    setBusy(false);
    if (ok) {
      setBody("");
      setOpen(false);
    }
  };
  return (
    <div className="ml-3 flex min-w-0 flex-col gap-1.5 border-l border-fg/10 pl-3" data-row="comments">
      {comments.map((comment) => {
        const author = parseMessageAuthor(comment.author);
        const name = author?.kind === "guest"
          ? (selfUserId && author.userId === selfUserId ? "You" : (author.name ?? "A guest"))
          : (author?.name ?? ownerLabel);
        return (
          <div key={comment.id} className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[11px] font-medium text-fg/55">{name}</span>
            <div className="min-w-0 whitespace-pre-wrap break-words text-[12px] text-fg/80">{comment.body}</div>
          </div>
        );
      })}
      {canComment ? (
        open ? (
          <div className="flex min-w-0 items-end gap-2">
            <textarea
              className="kit-input min-h-[32px] min-w-0 flex-1"
              rows={Math.min(4, Math.max(1, body.split("\n").length))}
              value={body}
              maxLength={MAX_THREAD_COMMENT_BODY_CHARS}
              placeholder="Your comment"
              aria-label="Your comment"
              disabled={busy}
              onChange={(event) => setBody(event.target.value)}
            />
            <button type="button" className="kit-btn kit-btn-primary" data-size="sm" disabled={!body.trim() || busy} onClick={() => { void add(); }}>
              Comment
            </button>
            <button type="button" className="kit-btn" data-size="sm" onClick={() => { setOpen(false); setBody(""); }}>Cancel</button>
          </div>
        ) : (
          <button type="button" className="kit-btn self-start" data-size="sm" onClick={() => setOpen(true)}>
            <ChatText size={12} />
            Comment
          </button>
        )
      ) : null}
    </div>
  );
}

function GuestRow({
  row,
  canApprove,
  canAnswer,
  ownerLabel,
  onDecide,
  comments,
}: {
  row: LaneShareGuestRow;
  canApprove: boolean;
  canAnswer: boolean;
  ownerLabel: string;
  onDecide: (itemId: string, decision: "accept" | "decline", question: boolean, answer?: string) => void;
  comments?: React.ReactNode;
}) {
  const [answer, setAnswer] = React.useState("");
  if (row.kind === "user") {
    return (
      <div className="flex min-w-0 flex-col gap-0.5" data-row="user">
        <span className="text-[11px] font-medium text-fg/55">{row.author}</span>
        <div className="min-w-0 whitespace-pre-wrap break-words rounded-lg bg-fg/[0.05] px-3 py-2 text-[13px] text-fg/90">{row.text}</div>
      </div>
    );
  }
  if (row.kind === "assistant") {
    return (
      <div className="flex min-w-0 flex-col gap-2" data-row="assistant">
        <div className="min-w-0 text-[13px] leading-relaxed text-fg/90">
          <ChatMarkdown componentOverrides={INERT_MARKDOWN}>{row.text}</ChatMarkdown>
        </div>
        {comments}
      </div>
    );
  }
  if (row.kind === "activity") {
    return (
      <div className={`min-w-0 truncate font-mono text-[11px] ${row.failed ? "text-[var(--color-error)]" : "text-fg/45"}`} title={row.text}>
        {row.text}
      </div>
    );
  }
  if (row.kind === "error") {
    return <div className="min-w-0 break-words text-[12px] text-[var(--color-error)]">{row.text}</div>;
  }
  const allowed = row.question ? canAnswer : canApprove;
  return (
    <div className="kit-panel flex min-w-0 flex-col gap-2 p-3" data-row="approval">
      <div className="min-w-0 whitespace-pre-wrap break-words text-[12.5px] text-fg/85">{row.description}</div>
      {row.resolved ? (
        <span className="text-[11.5px] text-fg/55">{row.resolved}</span>
      ) : !allowed ? (
        <span className="text-[11.5px] text-fg/55">Waiting for {ownerLabel}.</span>
      ) : row.question ? (
        <div className="flex min-w-0 items-center gap-2">
          <input
            className="kit-input min-w-0 flex-1" data-size="sm"
            value={answer}
            placeholder="Your answer"
            aria-label="Your answer"
            onChange={(event) => setAnswer(event.target.value)}
          />
          <button type="button" className="kit-btn" data-size="sm" disabled={!answer.trim()} onClick={() => onDecide(row.itemId, "accept", true, answer.trim())}>
            Answer
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <button type="button" className="kit-btn kit-btn-primary" data-size="sm" onClick={() => onDecide(row.itemId, "accept", false)}>Approve</button>
          <button type="button" className="kit-btn" data-size="sm" onClick={() => onDecide(row.itemId, "decline", false)}>Deny</button>
        </div>
      )}
    </div>
  );
}

/** A picker of the values the owner allows. Nothing else is listed. */
/** One choice the owner allows more than one value for, as a segmented control. The current value is pressed. */
function GuestPicker({
  label,
  values,
  current,
  title,
  onPick,
}: {
  label: string;
  values: readonly string[];
  current: string | null;
  title: (value: string) => string;
  onPick: (value: string) => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="text-[11.5px] text-fg/55">{label}</span>
      <div className="kit-seg" data-case="sentence" role="group" aria-label={label}>
        {values.map((value) => (
          <button key={value} type="button" aria-pressed={value === current} onClick={() => { if (value !== current) onPick(value); }}>
            {title(value)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function LaneShareGuestChat({
  connection,
  sessionId,
  connected,
  selfUserId,
  ownerLabel,
  guestState,
  composerCard = null,
}: {
  connection: LaneShareGuestConnection;
  sessionId: string;
  connected: boolean;
  selfUserId: string | null;
  ownerLabel: string;
  guestState: LaneShareGuestState | null;
  /** A card above the composer (a move the owner offers). */
  composerCard?: React.ReactNode;
}) {
  const [events, setEvents] = React.useState<AgentChatEventEnvelope[]>([]);
  const [initialTurnActive, setInitialTurnActive] = React.useState<boolean | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [text, setText] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [refusal, setRefusal] = React.useState<{ code: string | null; message: string } | null>(null);
  const [comments, setComments] = React.useState<ChatThreadComment[]>([]);
  const [current, setCurrent] = React.useState<{ modelId: string | null; permissionMode: string | null }>({ modelId: null, permissionMode: null });
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const grantId = connection.grantId;

  const readCurrent = React.useCallback(async () => {
    try {
      const summary = await connection.call<{ modelId?: unknown; model?: unknown; permissionMode?: unknown } | null>("chat.getSummary", { sessionId });
      const modelId = typeof summary?.modelId === "string" ? summary.modelId : typeof summary?.model === "string" ? summary.model : null;
      setCurrent({ modelId, permissionMode: typeof summary?.permissionMode === "string" ? summary.permissionMode : null });
    } catch {
      // The status line shows nothing it cannot read.
    }
  }, [connection, sessionId]);

  const readComments = React.useCallback(() => {
    void connection.call("chat.listThreadComments", { sessionId })
      .then((result) => setComments(threadCommentsOf(result, sessionId)))
      .catch((error: unknown) => {
        // The last comments stay; the next change reads them again.
        logRendererDebugEvent("lane_share.guest_comments_read_failed", { error: error instanceof Error ? error.message : String(error) });
      });
  }, [connection, sessionId]);

  // Subscribe while connected; a reconnect subscribes again (the host sends a fresh tail).
  React.useEffect(() => {
    if (!connected) return;
    setLoaded(false);
    const offSnapshot = connection.on("chatSnapshot", (snapshot) => {
      if (snapshot.sessionId !== sessionId) return;
      setEvents(snapshot.events.slice(-MAX_EVENTS));
      setInitialTurnActive(snapshot.turnActive);
      setLoaded(true);
    });
    const offEvent = connection.on("chatEvent", (envelope) => {
      if (envelope.sessionId !== sessionId) return;
      setEvents((previous) => {
        const next = previous.length >= MAX_EVENTS ? previous.slice(-(MAX_EVENTS - 1)) : previous.slice();
        next.push(envelope);
        return next;
      });
      if (envelope.event.type === "done" || envelope.event.type === "status") void refreshLaneShareGuestState(grantId);
      if (envelope.event.type === "session_meta_updated") {
        const meta = envelope.event;
        if (Array.isArray(meta.threadComments)) setComments(threadCommentsOf(meta.threadComments, sessionId));
        if (typeof meta.permissionMode === "string") {
          const permissionMode = meta.permissionMode;
          setCurrent((previous) => ({ ...previous, permissionMode }));
        }
      }
    });
    const unsubscribe = connection.subscribeChat(sessionId);
    // The comments and the current model and mode, read once per connect; events keep them current.
    readComments();
    void readCurrent();
    return () => {
      offSnapshot();
      offEvent();
      unsubscribe();
    };
  }, [connection, connected, grantId, readComments, readCurrent, sessionId]);

  const commentsByKey = React.useMemo(() => {
    const map = new Map<string, ChatThreadComment[]>();
    for (const comment of comments) {
      const list = map.get(comment.messageKey);
      if (list) list.push(comment);
      else map.set(comment.messageKey, [comment]);
    }
    return map;
  }, [comments]);

  const transcript = React.useMemo(
    () => buildLaneShareGuestTranscript(events, { selfUserId, ownerLabel, initialTurnActive }),
    [events, initialTurnActive, ownerLabel, selfUserId],
  );

  React.useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [transcript.rows.length]);

  const rights = guestState?.rights ?? null;
  const paused = guestState?.state === "paused";
  const canSend = Boolean(rights?.speak.send);
  const canDraft = Boolean(rights?.speak.drafts);
  const canStop = Boolean(rights && (rights.speak.steer || rights.speak.interruptAnyTurn));
  const reached = guestState ? limitReached(guestState) : null;
  const commandChar = leadingPromptCommandCharacter(text);
  const mode: "send" | "draft" | "none" = canSend ? "send" : canDraft ? "draft" : "none";

  const run = async (action: string, args: Record<string, unknown>) => {
    setRefusal(null);
    try {
      await connection.call(action, args);
      if (action === "chat.updateSession") void readCurrent();
      return true;
    } catch (error) {
      const parsed = parseCodedErrorMessage(error);
      setRefusal({ code: parsed.code ?? null, message: parsed.message || "The owner's computer refused this." });
      if (parsed.code?.startsWith("lane_share_")) void refreshLaneShareGuestState(grantId);
      return false;
    }
  };

  const submit = async () => {
    const value = text.trim();
    if (!value || sending || commandChar || reached || paused || !connected) return;
    setSending(true);
    const ok = mode === "send"
      ? await run("chat.send", { sessionId, text: value, clientSendId: `lsg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` })
      : await run("chat.createDraft", { originSessionId: sessionId, text: value });
    setSending(false);
    if (ok) {
      setText("");
      void refreshLaneShareGuestState(grantId);
    }
  };

  const addComment = async (row: Extract<LaneShareGuestRow, { kind: "assistant" }>, body: string): Promise<boolean> => {
    if (!row.messageKey) return false;
    const flat = collapseWhitespace(row.text);
    const ok = await run("chat.createThreadComment", {
      sessionId,
      messageKey: row.messageKey,
      messageExcerpt: flat.slice(0, MAX_THREAD_COMMENT_EXCERPT_CHARS),
      anchor: { kind: "text", quote: flat.slice(0, COMMENT_QUOTE_CHARS) || "(reply)", prefix: "", suffix: "" },
      body,
    });
    if (ok) readComments();
    return ok;
  };

  const decide = (itemId: string, decision: "accept" | "decline", question: boolean, answer?: string) => {
    void (question
      ? run("chat.respondToInput", { sessionId, itemId, decision, responseText: answer ?? "" })
      : run("chat.approve", { sessionId, itemId, decision }));
  };

  const lockedModel = rights && rights.run.models.length === 0;
  const lockedMode = rights && rights.run.permissionModes.length === 0;
  const left = guestState ? messagesLeftText(guestState) : null;
  const presence = guestState ? presenceText(guestState) : null;
  const modelLabel = laneShareGuestModelLabel(current.modelId, guestState);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col" data-testid="lane-share-guest-chat">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="mx-auto flex max-w-[760px] flex-col gap-3">
          {!connected ? <div className="text-[12px] text-fg/50">Waiting for the owner's computer…</div> : null}
          {connected && !loaded ? <div className="text-[12px] text-fg/50">Loading the chat…</div> : null}
          {loaded && transcript.rows.length === 0 ? (
            <div className="text-[12px] text-fg/50">
              {rights && !rights.see.historyBeforeShare
                ? "No messages since you got access. Earlier messages in this chat are not shared."
                : "No messages yet."}
            </div>
          ) : null}
          {transcript.rows.map((row) => (
            <GuestRow
              key={row.key}
              row={row}
              canApprove={Boolean(rights?.decide.approvals)}
              canAnswer={Boolean(rights?.decide.questions)}
              ownerLabel={ownerLabel}
              onDecide={decide}
              comments={row.kind === "assistant" && row.messageKey ? (
                <GuestReplyComments
                  comments={commentsByKey.get(row.messageKey) ?? []}
                  canComment={Boolean(rights?.speak.comment) && connected && !paused}
                  selfUserId={selfUserId}
                  ownerLabel={ownerLabel}
                  onAdd={(body) => addComment(row, body)}
                />
              ) : null}
            />
          ))}
        </div>
      </div>
      <div className="shrink-0 border-t border-fg/[0.06] px-4 pb-3 pt-2">
        <div className="mx-auto flex max-w-[760px] flex-col gap-2">
          {composerCard}
          {refusal ? (
            <Banner
              layout="inline"
              model={{
                id: `lane-share-refusal-${sessionId}`,
                tone: "warning",
                title: refusal.message,
                report: false,
                dismiss: { onDismiss: () => setRefusal(null) },
              }}
            />
          ) : null}
          {paused ? (
            <div className="text-[12px] text-fg/60">The owner paused this lane. You can read it, but not send.</div>
          ) : reached && mode !== "none" ? (
            <div className="text-[12px] text-fg/60" role="status">{reached}</div>
          ) : mode === "none" ? (
            <div className="ade-ls-line">{rights ? "You're watching. Only people the owner allows can send here." : "Reading your access…"}</div>
          ) : (
            <div className="flex min-w-0 items-end gap-2">
              <textarea
                className="kit-input min-h-[38px] min-w-0 flex-1"
                rows={Math.min(6, Math.max(1, text.split("\n").length))}
                value={text}
                disabled={!connected || sending}
                placeholder={mode === "send" ? `Message the agent on ${ownerLabel}'s lane` : `Write a draft for ${ownerLabel}`}
                aria-label={mode === "send" ? "Message" : "Draft"}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void submit();
                  }
                }}
              />
              {transcript.turnActive && canStop ? (
                <button type="button" className="kit-btn" data-size="sm" title="Stop the turn" onClick={() => { void run("chat.interrupt", { sessionId }); }}>
                  <Stop size={13} />
                  Stop
                </button>
              ) : null}
              <button
                type="button"
                className="kit-btn kit-btn-primary"
                data-size="sm"
                disabled={!text.trim() || sending || Boolean(commandChar) || !connected}
                onClick={() => { void submit(); }}
              >
                <PaperPlaneRight size={13} />
                {mode === "send" ? "Send" : `Send as draft to ${ownerLabel}`}
              </button>
            </div>
          )}
          {commandChar && mode !== "none" ? <div className="text-[11.5px] text-[var(--color-warning)]">{LANE_SHARE_PLAIN_TEXT_ONLY_MESSAGE}</div> : null}
          {rights && mode === "send" && !paused && (guestState?.models.length || rights.run.permissionModes.length || rights.run.reasoningLevels.length) ? (
            <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
              {guestState && guestState.models.length > 1 ? (
                <GuestPicker
                  label="Model"
                  values={guestState.models}
                  current={current.modelId ?? null}
                  title={(id) => resolveModelDescriptor(id)?.displayName ?? id}
                  onPick={(modelId) => { void run("chat.updateSession", { sessionId, modelId }); }}
                />
              ) : null}
              {rights.run.reasoningLevels.length > 1 ? (
                <GuestPicker
                  label="Reasoning"
                  values={rights.run.reasoningLevels}
                  current={null}
                  title={(level) => level.charAt(0).toUpperCase() + level.slice(1)}
                  onPick={(reasoningEffort) => { void run("chat.updateSession", { sessionId, reasoningEffort }); }}
                />
              ) : null}
              {rights.run.permissionModes.length > 1 ? (
                <GuestPicker
                  label="Mode"
                  values={rights.run.permissionModes}
                  current={current.permissionMode ?? null}
                  title={laneShareModeTitle}
                  onPick={(permissionMode) => { void run("chat.updateSession", { sessionId, permissionMode }); }}
                />
              ) : null}
            </div>
          ) : null}
          {guestState ? (
            <LaneShareMeta
              testId="lane-share-guest-meta"
              parts={[
                modelLabel ? (
                  <span title={lockedModel ? "The owner fixed the model of this chat." : undefined}>
                    {lockedModel ? <Lock size={10} className="ade-ls-lock" aria-label="Fixed by the owner" /> : null}
                    {resolveModelDescriptor(modelLabel)?.displayName ?? modelLabel}
                  </span>
                ) : null,
                current.permissionMode ? (
                  <span title={lockedMode ? "The owner fixed the mode of this chat." : undefined}>
                    {lockedMode ? <Lock size={10} className="ade-ls-lock" aria-label="Fixed by the owner" /> : null}
                    {laneShareModeTitle(current.permissionMode)}
                  </span>
                ) : null,
                left ? <span className="kit-num" data-tone={reached ? "warn" : undefined}>{left}</span> : null,
                presence,
              ]}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
