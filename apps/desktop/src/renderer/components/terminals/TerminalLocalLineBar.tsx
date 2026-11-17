import { useLayoutEffect, useRef } from "react";
import { cn } from "../ui/cn";
import type { TerminalLocalLineState } from "./TerminalView";

const OFF_STORAGE_KEY = "ade.terminal.localLineOff";
const OFF_SESSIONS_KEPT = 200;

function readOffSessions(): string[] {
  try {
    const raw = window.localStorage.getItem(OFF_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Whether the person turned the local line off for this session. */
export function readLocalLineOff(sessionId: string): boolean {
  return readOffSessions().includes(sessionId);
}

export function writeLocalLineOff(sessionId: string, off: boolean): void {
  const rest = readOffSessions().filter((id) => id !== sessionId);
  const next = off ? [...rest, sessionId].slice(-OFF_SESSIONS_KEPT) : rest;
  try {
    window.localStorage.setItem(OFF_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The switch still holds for this view; it is only not remembered.
  }
}

/**
 * The line being typed, over the bottom of the terminal, in the terminal's
 * font. The dashed edge and the "Not sent" note say it is still on this
 * computer; it goes away when the CLI has the line.
 */
export function TerminalLocalLineBar({
  state,
  fontFamily,
  fontSize,
  lineHeight,
}: {
  state: TerminalLocalLineState;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}) {
  const textRef = useRef<HTMLDivElement | null>(null);
  // A long line shows its end, where the typing is.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.text, state.sendingText]);
  const note = state.error === "stopped"
    ? "Not sent: this terminal has stopped."
    : state.error === "dropped"
      ? "Not sent: the connection dropped. Enter sends it again, and it never arrives twice."
      : state.error === "refused"
        ? "Not sent: the machine did not take it."
      : state.sending
        ? "Sending"
        : "Not sent yet. Enter sends it, Shift+Enter adds a line.";
  return (
    <div
      data-ade-terminal-local-line
      role="status"
      aria-live="polite"
      className={cn(
        "pointer-events-none absolute inset-x-2 bottom-2 flex flex-col gap-1 rounded-lg border border-dashed bg-card/95 px-2.5 py-1.5 shadow-card backdrop-blur-sm",
        state.error ? "border-warning/70" : "border-accent/60",
      )}
    >
      <div
        ref={textRef}
        className="max-h-[7.5em] overflow-hidden whitespace-pre-wrap break-words text-fg"
        style={{ fontFamily, fontSize, lineHeight }}
      >
        {state.sendingText && !state.text ? <span className="text-muted-fg">{state.sendingText}</span> : state.text}
        {state.sending && !state.text ? null : (
          <span aria-hidden className="ml-px inline-block w-[0.6em] translate-y-[0.12em] bg-accent/80" style={{ height: "1.05em" }} />
        )}
      </div>
      <div className={cn("text-[11px] leading-4", state.error ? "text-warning" : "text-muted-fg")}>{note}</div>
    </div>
  );
}

/**
 * Turns the local line off or on for this session. Off, every key goes to the
 * CLI at once, as on a fast link.
 */
export function TerminalLocalLineSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      data-ade-terminal-local-line-switch={on ? "on" : "off"}
      aria-pressed={on}
      title={on
        ? "The link to this machine is slow, so what you type stays on this computer until you press Enter. Click to send each key as you type."
        : "Each key goes to the machine as you type. Click to keep typing on this computer until Enter."}
      // Keep the terminal's focus: a click here must not eat the next key.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onChange(!on)}
      className={cn(
        "absolute right-2 top-2 flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] leading-4 shadow-card backdrop-blur-sm transition-colors",
        on
          ? "border-accent/40 bg-card/90 text-fg hover:bg-card"
          : "border-border/20 bg-card/70 text-muted-fg hover:text-fg",
      )}
    >
      <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", on ? "bg-accent" : "bg-muted-fg/50")} />
      {on ? "Typing stays here until Enter" : "Keys go straight to the machine"}
    </button>
  );
}
