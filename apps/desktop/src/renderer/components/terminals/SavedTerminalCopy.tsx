import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowClockwise, PaperPlaneRight, Play, Terminal as TerminalIcon } from "@phosphor-icons/react";
import type { CloudChatQueuedMessage } from "../../../../../account-directory/src/cloud/contract";
import type { TerminalSessionSummary } from "../../../shared/types";
import { newClientSendId } from "../../../shared/adeCloud/chatQueue";
import { stripAnsi } from "../../../shared/ansiStrip";
import { SAVED_CHATS_MACHINE_PREFIX } from "../../../shared/cloudSavedChats";
import { savedAgoLabel, useAdeCloudAccountRead } from "../../lib/adeCloudAccountRead";
import { useCloudMachineWakeFailure, useCloudMachineWakeInFlight, wakeRestingCloudMachine } from "../../lib/cloudMachineWake";
import { savedTerminalAddress } from "../../state/cloudSavedTerminals";
import { rootAppStoreApi } from "../../state/appStore";
import { focusWorkSession } from "../../lib/workSessionRequests";
import type { MachineAddress } from "../../../shared/machineAddress";
import { AccountReadFailed } from "../adeCloud/AccountReadFailed";
import { Button } from "../ui/Button";
import { normalizeTranscriptToGrid } from "./terminalTranscriptNormalize";

/**
 * CLI and shell copies of an ADE Cloud computer that is not on: the text the
 * computer saved when it went to rest (`GET /cloud/sessions/:m/:s`). A shell
 * shows its last 5,000 lines; a CLI shows its saved screen. Read-only: the
 * terminal itself lives on the computer, and "Continue" wakes it.
 */

/** A shell shows at most this many lines of its saved text. */
const SHELL_LINES = 5_000;

function lastLines(text: string, count: number): { text: string; cut: boolean } {
  let index = text.length;
  for (let seen = 0; seen < count; seen += 1) {
    index = text.lastIndexOf("\n", index - 1);
    if (index < 0) return { text, cut: false };
  }
  return { text: text.slice(index + 1), cut: true };
}

/** The saved text as the person reads it: plain lines, colors and cursor moves resolved. */
function useReadableCopy(format: "text" | "xterm" | null, raw: string | null): { text: string | null; cut: boolean } {
  const [screen, setScreen] = useState<string | null>(null);
  useEffect(() => {
    setScreen(null);
    if (format !== "xterm" || !raw) return undefined;
    let cancelled = false;
    void normalizeTranscriptToGrid(raw).then((grid) => {
      if (!cancelled) setScreen(grid ?? stripAnsi(raw));
    });
    return () => {
      cancelled = true;
    };
  }, [format, raw]);
  return useMemo(() => {
    if (raw == null || format == null) return { text: null, cut: false };
    if (format === "xterm") return { text: screen, cut: false };
    return lastLines(stripAnsi(raw), SHELL_LINES);
  }, [format, raw, screen]);
}

/** How long after a wake Work still waits for the live terminal to be listed. */
const LIVE_ROW_WAIT_MS = 120_000;

/**
 * After Continue: select the live terminal once its computer lists it. The
 * saved row leaves the list when the computer connects, so this view may be
 * gone by then; the wait lives outside it, on the store, and ends when the
 * row is found or after `LIVE_ROW_WAIT_MS` (one cleanup, not a poll).
 */
function focusLiveTerminalWhenListed(address: MachineAddress, sessionId: string, laneId: string | null): void {
  if (address.kind !== "remote") return;
  const targetId = address.targetId;
  const tryFocus = (): boolean => {
    const slice = rootAppStoreApi.getState().crossMachineLanesByMachineId[targetId];
    if (!slice?.online) return false;
    const live = slice.sessions.find((session) => session.id === sessionId);
    if (!live) return false;
    focusWorkSession(live.id, live.laneId ?? laneId, slice.binding ?? null);
    return true;
  };
  if (tryFocus()) return;
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    unsubscribe();
    window.clearTimeout(cap);
  };
  const unsubscribe = rootAppStoreApi.subscribe((state, prev) => {
    if (state.crossMachineLanesByMachineId === prev.crossMachineLanesByMachineId) return;
    if (tryFocus()) stop();
  });
  const cap = window.setTimeout(stop, LIVE_ROW_WAIT_MS);
}

/** What the person reads about one message waiting for the CLI. */
function queuedLine(message: CloudChatQueuedMessage): string {
  switch (message.state) {
    case "queued":
      return "Waits for the computer";
    case "sending":
      return "Sending to the CLI";
    case "waiting_for_sign_in":
      return "Waits for a sign-in on ADE Cloud";
    case "failed":
      return message.error?.trim() || "It didn't reach the CLI.";
    default:
      return "";
  }
}

const SHOWN_STATES = new Set<CloudChatQueuedMessage["state"]>(["queued", "sending", "waiting_for_sign_in", "failed"]);

/**
 * A message to a saved CLI copy goes to the account's queue
 * (`POST /cloud/chats/:machineKey/:sessionId/messages`, the same as a chat).
 * The server wakes the computer, or restores the CLI on a new one when its
 * computer is gone. Reads ride the view opening, a send and window focus;
 * nothing polls. A shell has no queue (the server answers 404), so it gets no box.
 */
function SavedCliSendBox({ machineKey, sessionId }: { machineKey: string; sessionId: string }): JSX.Element | null {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [messages, setMessages] = useState<CloudChatQueuedMessage[]>([]);

  const refresh = useCallback(async () => {
    const read = window.ade?.adeCloud?.chatMessages;
    if (!read) return;
    try {
      const next = await read({ machineKey, chatId: sessionId });
      if (next) setMessages(next.filter((message) => SHOWN_STATES.has(message.state)).sort((a, b) => a.seq - b.seq).slice(-5));
    } catch {
      // The rows stay as they were; the next focus or send reads again.
    }
  }, [machineKey, sessionId]);

  useEffect(() => {
    setMessages([]);
    setNotice(null);
    setUnsupported(false);
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const send = async () => {
    const text = draft.trim();
    const sendMessage = window.ade?.cloud?.sendChatMessage;
    if (!text || sending) return;
    if (!sendMessage) {
      setUnsupported(true);
      return;
    }
    setSending(true);
    setNotice(null);
    try {
      const answer = await sendMessage({ machineKey, chatId: sessionId, messageId: newClientSendId(), text });
      if (answer.state === "unsupported") {
        setUnsupported(true);
        return;
      }
      if (answer.state === "refused") {
        setNotice({ tone: "error", text: answer.message });
        return;
      }
      setDraft("");
      setNotice({
        tone: "info",
        text: answer.wake.state === "awake"
          ? "Sent. The CLI gets it now."
          : answer.wake.state === "launching"
            ? "Its computer is gone. A new ADE Cloud computer restores this CLI and sends it."
            : "Waking your ADE Cloud computer. The CLI gets this when it's up.",
      });
      void refresh();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error && error.message ? error.message : "ADE couldn't send that. Try again." });
    } finally {
      setSending(false);
    }
  };

  const takeBack = async (messageId: string) => {
    const cancel = window.ade?.adeCloud?.cancelChatMessage;
    if (!cancel) return;
    try {
      const answer = await cancel({ machineKey, chatId: sessionId, messageId });
      // Taken back: the "waking for it" line no longer says what happens.
      setNotice(answer.ok ? null : { tone: "error", text: answer.message });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error && error.message ? error.message : "ADE couldn't take that back. Try again." });
    }
    void refresh();
  };

  if (unsupported) {
    return (
      <div className="shrink-0 border-t border-border/40 px-4 py-2.5 text-[11.5px] text-muted-fg/75">
        This ADE Cloud can't take a message for a CLI yet. Continue opens the CLI on its computer.
      </div>
    );
  }

  return (
    <div className="shrink-0 border-t border-border/40 px-4 py-2.5" data-testid="saved-cli-send">
      {messages.length > 0 ? (
        <ul className="mb-2 flex flex-col gap-1">
          {messages.map((message) => (
            <li key={message.messageId} className="flex items-center gap-2 text-[11.5px]">
              <span className="min-w-0 flex-1 truncate text-fg/85" data-ph-mask="">{message.text}</span>
              <span className={message.state === "failed" ? "shrink-0 text-red-300" : "shrink-0 text-muted-fg/70"} role={message.state === "failed" ? "alert" : undefined}>
                {queuedLine(message)}
              </span>
              {message.state === "queued" ? (
                <Button size="sm" variant="ghost" onClick={() => void takeBack(message.messageId)}>Take back</Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {notice ? (
        <div className={notice.tone === "error" ? "mb-2 text-[11.5px] text-red-300" : "mb-2 text-[11.5px] text-muted-fg/80"} role={notice.tone === "error" ? "alert" : "status"}>
          {notice.text}
        </div>
      ) : null}
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          className="min-h-[34px] flex-1 resize-none rounded-md border border-border/50 bg-transparent px-2.5 py-1.5 text-[12.5px] text-fg outline-none placeholder:text-muted-fg/60 focus-visible:border-accent/60"
          rows={1}
          value={draft}
          placeholder="Message the CLI. Its computer wakes for it."
          aria-label="Message the CLI"
          data-ph-mask=""
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <Button size="sm" variant="primary" type="submit" disabled={sending || !draft.trim()}>
          <PaperPlaneRight size={12} weight="fill" />
          {sending ? "Sending…" : "Send"}
        </Button>
      </form>
    </div>
  );
}

/**
 * The read-only view of one saved terminal copy. Reading it never wakes the
 * computer; "Continue" does, and the live terminal opens when it connects.
 */
export function SavedTerminalCopyView({
  session,
}: {
  session: Pick<TerminalSessionSummary, "id" | "title" | "toolType" | "lastActivityAt" | "laneId">;
}): JSX.Element | null {
  const address = savedTerminalAddress(session.id);
  const { state, retry } = useAdeCloudAccountRead(address ? { call: "savedSession" as const, ...address } : null);
  const copy = state.data ?? null;
  const readable = useReadableCopy(copy?.format ?? null, copy?.text ?? null);
  const machineKey = address?.machineKey ?? null;
  const waking = useCloudMachineWakeInFlight(machineKey);
  const wakeFailure = useCloudMachineWakeFailure(machineKey);
  if (!address) return null;

  const isShell = session.toolType === "shell";
  const saved = savedAgoLabel(copy?.session.updatedAt ?? session.lastActivityAt);
  const continueWork = () => {
    wakeRestingCloudMachine(
      { machineId: `${SAVED_CHATS_MACHINE_PREFIX}${address.machineKey}`, machineName: "ADE Cloud", hostname: copy?.session.instanceId ?? null },
      (connected) => focusLiveTerminalWhenListed(connected, address.sessionId, session.laneId ?? null),
    );
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden" data-testid="saved-terminal-copy">
      <div className="flex shrink-0 items-center gap-3 border-b border-border/40 px-4 py-2.5">
        <TerminalIcon size={15} className="shrink-0 text-muted-fg/70" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-fg">{session.title ?? (isShell ? "Shell" : "CLI")}</div>
          <div className="truncate text-[11px] text-muted-fg/70">
            {saved ?? "Saved"} on ADE Cloud. {isShell ? "The last lines it showed." : "Its screen when it went to rest."} Reading this doesn't wake it.
          </div>
        </div>
        <Button
          size="sm"
          variant="primary"
          disabled={waking}
          onClick={continueWork}
          title="Wake the computer and open the live terminal"
        >
          <Play size={12} weight="fill" />
          {waking ? "Waking…" : "Continue"}
        </Button>
      </div>
      {wakeFailure ? (
        <div className="shrink-0 px-4 pt-3 text-[11.5px] text-red-300" role="alert">{wakeFailure}</div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto bg-black/20">
        {state.status === "failed" && !copy ? (
          <div className="p-4">
            <AccountReadFailed id="saved-terminal" what="the saved terminal" code={state.code} message={state.message} onRetry={retry} />
          </div>
        ) : state.status === "unsupported" ? (
          <div className="p-4 text-[12px] text-muted-fg/75">This ADE can't read saved terminals. Continue to open it on its computer.</div>
        ) : state.status === "ready" && !copy ? (
          <div className="flex flex-col items-start gap-2 p-4 text-[12px] text-muted-fg/75">
            <span>This terminal has no saved copy any more.</span>
            <Button size="sm" variant="ghost" onClick={retry}>
              <ArrowClockwise size={12} />
              Retry
            </Button>
          </div>
        ) : readable.text == null ? (
          <div className="flex flex-col gap-1.5 p-4" aria-busy="true" aria-label="Loading the saved terminal">
            {[0, 1, 2, 3].map((index) => <div key={index} className="h-3 w-2/3 animate-pulse rounded bg-fg/[0.05]" />)}
          </div>
        ) : (
          <pre
            className="m-0 min-h-full whitespace-pre-wrap break-words p-4 font-mono text-[12px] leading-[1.45] text-fg/85 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent/60"
            tabIndex={0}
            aria-label={`Saved text of ${session.title ?? "the terminal"}`}
          >
            {readable.cut ? `… (the last ${SHELL_LINES.toLocaleString()} lines)\n` : ""}
            {readable.text || (isShell ? "(The shell showed nothing.)" : "(The screen was empty.)")}
          </pre>
        )}
      </div>
      {isShell ? null : <SavedCliSendBox machineKey={address.machineKey} sessionId={address.sessionId} />}
    </div>
  );
}
