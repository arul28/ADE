import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowClockwise, CheckCircle, DownloadSimple, Terminal } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { useChatRuntimeScope } from "./ChatRuntimeScope";
import { pinnedToolLine, usePinnedToolStatus } from "../../hooks/usePinnedToolStatus";

export type AgentCliAuthCardInfo = {
  agent: string;
  displayName: string;
  category: "missing" | "unauthenticated";
  authCommand: string;
};

/**
 * Dispatched when the user clicks "Retry turn" on the card — the chat pane
 * that owns the session listens for it and resends the last user message.
 */
export const CHAT_RETRY_AUTH_TURN_EVENT = "ade:chat:retry-auth-turn";
/**
 * Dispatched by the chat pane when a turn succeeds again — a visible card for
 * that session collapses into a quiet confirmation, and a signed-out line in
 * the transcript reads "signed in again".
 */
export const CHAT_AUTH_RECOVERED_EVENT = "ade:chat:auth-recovered";
/**
 * Dispatched by the chat pane when a retry click is ignored locally (for example
 * another send is already in flight or there is no user message to resend).
 */
export const CHAT_AUTH_RETRY_REJECTED_EVENT = "ade:chat:retry-auth-rejected";

const BUTTON_CLASS =
  "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.14em] transition-colors disabled:pointer-events-none disabled:opacity-45";
const AMBER_BUTTON_CLASS =
  "border-amber-300/20 bg-amber-300/[0.08] text-amber-100/82 hover:border-amber-300/35 hover:bg-amber-300/[0.12]";

/**
 * The card for a chat whose agent ADE has not downloaded to the chat's
 * machine yet: where that download stands there, Download/Retry, and Retry
 * turn once it has landed. A signed-out agent has no card here; its sign-in
 * card takes the composer's place (`ProviderSignInCard.tsx`).
 */
export function AgentCliAuthCard({
  agentCli,
  chatSessionId,
  runtimeName,
}: {
  agentCli: AgentCliAuthCardInfo;
  chatSessionId?: string | null;
  runtimeName?: string | null;
}) {
  // The agent runs on the chat's machine, so its download is read and started there.
  const runtimePin = useChatRuntimeScope().pin;
  const [retrying, setRetrying] = useState(false);
  const [resolved, setResolved] = useState(false);
  const retryResetTimerRef = useRef<number | null>(null);
  const pinnedTool = usePinnedToolStatus(agentCli.agent, runtimePin, { enabled: true });
  // Retry needs a session to resend the last message into, and a copy that
  // has landed on the chat's machine.
  const canRetry = Boolean(chatSessionId) && pinnedTool.status?.state === "ready";

  useEffect(() => () => {
    if (retryResetTimerRef.current != null) window.clearTimeout(retryResetTimerRef.current);
  }, []);

  const clearRetrying = useCallback(() => {
    if (retryResetTimerRef.current != null) {
      window.clearTimeout(retryResetTimerRef.current);
      retryResetTimerRef.current = null;
    }
    setRetrying(false);
  }, []);

  useEffect(() => {
    if (!chatSessionId) return undefined;
    const onRecovered = (event: Event) => {
      if ((event as CustomEvent<{ sessionId?: string | null }>).detail?.sessionId !== chatSessionId) return;
      clearRetrying();
      setResolved(true);
    };
    const onRejected = (event: Event) => {
      if ((event as CustomEvent<{ sessionId?: string | null }>).detail?.sessionId === chatSessionId) clearRetrying();
    };
    window.addEventListener(CHAT_AUTH_RECOVERED_EVENT, onRecovered);
    window.addEventListener(CHAT_AUTH_RETRY_REJECTED_EVENT, onRejected);
    return () => {
      window.removeEventListener(CHAT_AUTH_RECOVERED_EVENT, onRecovered);
      window.removeEventListener(CHAT_AUTH_RETRY_REJECTED_EVENT, onRejected);
    };
  }, [chatSessionId, clearRetrying]);

  const handleRetry = useCallback(() => {
    if (!chatSessionId || retrying) return;
    setRetrying(true);
    window.dispatchEvent(new CustomEvent(CHAT_RETRY_AUTH_TURN_EVENT, { detail: { sessionId: chatSessionId } }));
    // The resend produces fresh events; clear the spinner in case it is refused.
    if (retryResetTimerRef.current != null) window.clearTimeout(retryResetTimerRef.current);
    retryResetTimerRef.current = window.setTimeout(() => {
      retryResetTimerRef.current = null;
      setRetrying(false);
    }, 4_000);
  }, [chatSessionId, retrying]);

  if (resolved) {
    return (
      <div className="mt-3 inline-flex items-center gap-2 rounded-[calc(var(--chat-radius-card)-6px)] border border-emerald-400/18 bg-emerald-400/[0.06] px-3 py-1.5 text-[length:calc(var(--chat-font-size)*11/14)] font-medium text-emerald-100/85">
        <CheckCircle size={14} weight="fill" aria-hidden />
        {agentCli.displayName} is ready
      </div>
    );
  }

  // Machines are always named absolutely — "this machine" has no fixed referent
  // once a chat's machine can change underneath it.
  const installLocation = runtimeName?.trim() ? runtimeName.trim() : "This computer";
  const pinnedLine = pinnedTool.status ? pinnedToolLine(pinnedTool.status, { machineName: installLocation }) : null;

  return (
    <div className="mt-3 overflow-hidden rounded-[calc(var(--chat-radius-card)-6px)] border border-amber-300/14 bg-amber-300/[0.045]">
      <div className="flex items-start gap-3 p-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-amber-300/15 bg-amber-300/[0.08] text-amber-200">
          <Terminal size={15} weight="bold" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-sans text-[length:calc(var(--chat-font-size)*12/14)] font-semibold text-amber-100/90">
            {agentCli.displayName} is not on {installLocation} yet
          </div>
          <div className="mt-1 text-[length:calc(var(--chat-font-size)*11/14)] leading-relaxed text-fg/66">
            ADE runs its own copy of {agentCli.displayName} and downloads it for {installLocation}. Once it is there, retry the chat.
          </div>
          <div className="mt-3 grid gap-2">
            {pinnedLine && pinnedTool.status ? (
              <div className="grid gap-1.5">
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-fg/[0.06] bg-black/20 px-2.5 py-2">
                  <span
                    className={cn(
                      "min-w-0 flex-1 text-[length:calc(var(--chat-font-size)*11/14)]",
                      pinnedLine.tone === "error" ? "text-red-200/80" : "text-fg/78",
                    )}
                  >
                    {pinnedLine.text}
                  </span>
                  {pinnedLine.action ? (
                    <button
                      type="button"
                      onClick={() => void pinnedTool.download()}
                      disabled={pinnedTool.starting}
                      className={cn(BUTTON_CLASS, AMBER_BUTTON_CLASS)}
                    >
                      <DownloadSimple size={12} weight="bold" aria-hidden />
                      {pinnedTool.starting ? "Starting" : pinnedLine.action === "retry" ? "Retry" : "Download"}
                    </button>
                  ) : null}
                </div>
                {pinnedTool.error ? (
                  <div className="font-mono text-[length:calc(var(--chat-font-size)*9/14)] text-red-200/70">
                    {pinnedTool.error}
                  </div>
                ) : null}
              </div>
            ) : null}
            {canRetry ? (
              <div className="flex items-center justify-end">
                <button
                  type="button"
                  onClick={handleRetry}
                  disabled={retrying}
                  className={cn(BUTTON_CLASS, "border-emerald-400/40 bg-emerald-400/[0.12] text-emerald-100 hover:border-emerald-400/55 hover:bg-emerald-400/[0.18]")}
                  title="Resend the last message"
                >
                  <ArrowClockwise size={12} weight="bold" className={retrying ? "animate-spin" : undefined} aria-hidden />
                  {retrying ? "Retrying" : "Retry turn"}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
