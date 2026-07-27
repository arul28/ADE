import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowClockwise, CheckCircle, CopySimple, Play, Terminal, Warning } from "@phosphor-icons/react";
import { cn } from "../ui/cn";

export type AgentCliAuthCardInfo = {
  agent: string;
  displayName: string;
  category: "missing" | "unauthenticated";
  installCommand: string;
  authCommand: string;
};

/**
 * Dispatched when the user clicks "Retry turn" on a logged-out card — the chat
 * pane that owns the session listens for it and resends the last user message.
 */
export const CHAT_RETRY_AUTH_TURN_EVENT = "ade:chat:retry-auth-turn";
/**
 * Dispatched by the chat pane when a turn succeeds again — visible logged-out
 * cards for that session collapse into a quiet "Reconnected" confirmation.
 */
export const CHAT_AUTH_RECOVERED_EVENT = "ade:chat:auth-recovered";
/**
 * Dispatched by the chat pane when a retry click is ignored locally (for example
 * another send is already in flight or there is no user message to resend).
 */
export const CHAT_AUTH_RETRY_REJECTED_EVENT = "ade:chat:retry-auth-rejected";

// Claude logs out far more often than the other CLIs, so its recovery card wears
// Claude's terracotta rather than the generic amber — it reads as "Claude", not a
// random error. Other agents keep the amber treatment.
type AccentTokens = {
  cardBorder: string;
  cardBg: string;
  iconChip: string;
  title: string;
  label: string;
  runButton: string;
};

const AMBER_ACCENT: AccentTokens = {
  cardBorder: "border-amber-300/14",
  cardBg: "bg-amber-300/[0.045]",
  iconChip: "border-amber-300/15 bg-amber-300/[0.08] text-amber-200",
  title: "text-amber-100/90",
  label: "text-muted-fg/45",
  runButton:
    "border-amber-300/20 bg-amber-300/[0.08] text-amber-100/82 hover:border-amber-300/35 hover:bg-amber-300/[0.12]",
};

const CLAUDE_ACCENT: AccentTokens = {
  cardBorder: "border-[#d97757]/16",
  cardBg: "bg-[#d97757]/[0.06]",
  iconChip: "border-[#d97757]/22 bg-[#d97757]/[0.12] text-[#f3b79b]",
  title: "text-[#f5cbb6]",
  label: "text-[#d97757]/65",
  runButton:
    "border-[#d97757]/28 bg-[#d97757]/[0.12] text-[#ffd9c6] hover:border-[#d97757]/45 hover:bg-[#d97757]/[0.18]",
};

function CommandCopyButton({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(command)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_500);
      })
      .catch(() => setCopied(false));
  }, [command]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.04] px-2 py-1 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.14em] text-fg/58 transition-colors hover:border-amber-300/25 hover:bg-amber-300/[0.07] hover:text-amber-100"
      title={copied ? "Copied" : `Copy ${label}`}
    >
      <CopySimple size={12} weight={copied ? "fill" : "regular"} aria-hidden />
      {copied ? "Copied" : label}
    </button>
  );
}

function ShellRunButton({
  command,
  label,
  laneId,
  chatSessionId,
  accent,
  onRevealTerminal,
  onLaunched,
}: {
  command: string;
  label: string;
  laneId?: string | null;
  chatSessionId?: string | null;
  accent: AccentTokens;
  onRevealTerminal?: (terminal: { terminalId: string; ptyId: string; label: string }) => void;
  onLaunched?: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = running || !window.ade?.pty?.create || (!laneId && !window.ade?.lanes?.list);

  const handleRun = useCallback(() => {
    if (disabled) return;
    setRunning(true);
    setError(null);
    const terminalLabel = label.replace(/^Run\s+/i, "").replace(/^Log in to\s+/i, "") || label;
    void (async () => {
      const resolvedLaneId = laneId ?? (await window.ade.lanes.list({
        includeArchived: false,
        includeStatus: false,
      }))[0]?.id ?? null;
      if (!resolvedLaneId) {
        throw new Error("No active lane is available for this project.");
      }
      return window.ade.pty.create({
        laneId: resolvedLaneId,
        ...(chatSessionId ? { chatSessionId } : {}),
        cols: 100,
        rows: 28,
        title: terminalLabel,
        tracked: true,
        toolType: "shell",
        startupCommand: command,
      });
    })()
      .then((created) => {
        onRevealTerminal?.({
          terminalId: created.sessionId,
          ptyId: created.ptyId,
          label: terminalLabel,
        });
        onLaunched?.();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setRunning(false));
  }, [chatSessionId, command, disabled, label, laneId, onLaunched, onRevealTerminal]);

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleRun}
        disabled={disabled}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.14em] transition-colors disabled:pointer-events-none disabled:opacity-45",
          accent.runButton,
        )}
        title={!laneId && !window.ade?.lanes?.list ? "Open a project to run this command" : label}
      >
        <Play size={12} weight={running ? "fill" : "bold"} aria-hidden />
        {running ? "Opening" : label}
      </button>
      {error ? (
        <div className="max-w-[22rem] text-right font-mono text-[length:calc(var(--chat-font-size)*9/14)] text-red-200/70">
          {error}
        </div>
      ) : null}
    </div>
  );
}

export function AgentCliAuthCard({
  agentCli,
  laneId,
  chatSessionId,
  runtimeName,
  onRevealTerminal,
}: {
  agentCli: AgentCliAuthCardInfo;
  laneId?: string | null;
  chatSessionId?: string | null;
  runtimeName?: string | null;
  onRevealTerminal?: (terminal: { terminalId: string; ptyId: string; label: string }) => void;
}) {
  const missing = agentCli.category === "missing";
  const accent = agentCli.agent === "claude" ? CLAUDE_ACCENT : AMBER_ACCENT;
  // Retry only makes sense for the logged-out variant (not the "missing CLI"
  // variant) and only when there's a session to resend the last message into.
  const canRetry = !missing && Boolean(chatSessionId);

  const [loginStarted, setLoginStarted] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [resolved, setResolved] = useState(false);
  const retryResetTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (retryResetTimerRef.current != null) {
      window.clearTimeout(retryResetTimerRef.current);
    }
  }, []);

  const clearRetrying = useCallback(() => {
    if (retryResetTimerRef.current != null) {
      window.clearTimeout(retryResetTimerRef.current);
      retryResetTimerRef.current = null;
    }
    setRetrying(false);
  }, []);

  // A later turn for this session succeeded — collapse to a quiet confirmation.
  useEffect(() => {
    if (!chatSessionId) return undefined;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string | null }>).detail;
      if (detail?.sessionId && detail.sessionId === chatSessionId) {
        clearRetrying();
        setResolved(true);
      }
    };
    window.addEventListener(CHAT_AUTH_RECOVERED_EVENT, handler);
    return () => window.removeEventListener(CHAT_AUTH_RECOVERED_EVENT, handler);
  }, [chatSessionId, clearRetrying]);

  useEffect(() => {
    if (!chatSessionId) return undefined;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string | null }>).detail;
      if (detail?.sessionId && detail.sessionId === chatSessionId) {
        clearRetrying();
      }
    };
    window.addEventListener(CHAT_AUTH_RETRY_REJECTED_EVENT, handler);
    return () => window.removeEventListener(CHAT_AUTH_RETRY_REJECTED_EVENT, handler);
  }, [chatSessionId, clearRetrying]);

  const handleRetry = useCallback(() => {
    if (!chatSessionId || retrying) return;
    setRetrying(true);
    window.dispatchEvent(new CustomEvent(CHAT_RETRY_AUTH_TURN_EVENT, {
      detail: { sessionId: chatSessionId },
    }));
    // The card unmounts/collapses once the resend produces fresh events; clear the
    // spinner defensively in case the resend is rejected (still logged out).
    if (retryResetTimerRef.current != null) {
      window.clearTimeout(retryResetTimerRef.current);
    }
    retryResetTimerRef.current = window.setTimeout(() => {
      retryResetTimerRef.current = null;
      setRetrying(false);
    }, 4_000);
  }, [chatSessionId, retrying]);

  // Once a subsequent turn succeeds, the logged-out state is history — collapse
  // the whole card into a quiet confirmation instead of leaving a scary panel.
  if (resolved) {
    return (
      <div className="mt-3 inline-flex items-center gap-2 rounded-[calc(var(--chat-radius-card)-6px)] border border-emerald-400/18 bg-emerald-400/[0.06] px-3 py-1.5 text-[length:calc(var(--chat-font-size)*11/14)] font-medium text-emerald-100/85">
        <CheckCircle size={14} weight="fill" aria-hidden />
        Reconnected to {agentCli.displayName}
      </div>
    );
  }

  // Machines are always named absolutely — "this machine" has no fixed referent
  // once a chat's machine can change underneath it.
  const installLocation = runtimeName?.trim() ? runtimeName.trim() : "This Mac";
  const title = missing
    ? `${agentCli.displayName} is not installed`
    : `${agentCli.displayName} is logged out`;
  const body = missing
    ? `Install the CLI on ${installLocation}, authenticate it, then retry the chat.`
    : `Log back in on ${installLocation} to continue this chat.`;

  return (
    <div className={cn("mt-3 overflow-hidden rounded-[calc(var(--chat-radius-card)-6px)] border", accent.cardBorder, accent.cardBg)}>
      <div className="flex items-start gap-3 p-3">
        <div className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border", accent.iconChip)}>
          {missing ? <Terminal size={15} weight="bold" aria-hidden /> : <Warning size={15} weight="bold" aria-hidden />}
        </div>
        <div className="min-w-0 flex-1">
          <div className={cn("font-sans text-[length:calc(var(--chat-font-size)*12/14)] font-semibold", accent.title)}>
            {title}
          </div>
          <div className="mt-1 text-[length:calc(var(--chat-font-size)*11/14)] leading-relaxed text-fg/66">
            {body}
          </div>
          <div className="mt-3 grid gap-2">
            {missing ? (
              <div className="grid gap-1.5">
                <div className={cn("font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.16em]", accent.label)}>
                  Install
                </div>
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/[0.06] bg-black/20 px-2.5 py-2">
                  <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-fg/78">
                    {agentCli.installCommand}
                  </code>
                  <ShellRunButton
                    command={agentCli.installCommand}
                    label="Run install"
                    laneId={laneId}
                    chatSessionId={chatSessionId}
                    accent={accent}
                    onRevealTerminal={onRevealTerminal}
                  />
                  <CommandCopyButton command={agentCli.installCommand} label="Copy install" />
                </div>
              </div>
            ) : null}
            <div className={cn("grid gap-1.5", missing ? "" : "mt-0")}>
              <div className={cn("font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.16em]", accent.label)}>
                Authenticate
              </div>
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/[0.06] bg-black/20 px-2.5 py-2">
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[length:calc(var(--chat-font-size)*11/14)] text-fg/78">
                  {agentCli.authCommand}
                </code>
                <ShellRunButton
                  command={agentCli.authCommand}
                  label={agentCli.agent === "claude" ? "Log in to Claude" : "Run auth"}
                  laneId={laneId}
                  chatSessionId={chatSessionId}
                  accent={accent}
                  onRevealTerminal={onRevealTerminal}
                  onLaunched={() => setLoginStarted(true)}
                />
                <CommandCopyButton command={agentCli.authCommand} label="Copy auth" />
              </div>
            </div>
            {canRetry ? (
              <div className="flex items-center justify-end gap-2">
                {loginStarted ? (
                  <span className="font-sans text-[length:calc(var(--chat-font-size)*10/14)] text-fg/45">
                    Logged in? Resend your message.
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={handleRetry}
                  disabled={retrying}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.14em] transition-colors disabled:pointer-events-none disabled:opacity-55",
                    loginStarted
                      ? "border-emerald-400/40 bg-emerald-400/[0.12] text-emerald-100 shadow-[0_0_18px_rgba(52,211,153,0.16)] hover:border-emerald-400/55 hover:bg-emerald-400/[0.18]"
                      : "border-white/[0.1] bg-white/[0.04] text-fg/70 hover:border-white/[0.18] hover:bg-white/[0.07] hover:text-fg",
                  )}
                  title="Re-check authentication and resend the last message"
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
