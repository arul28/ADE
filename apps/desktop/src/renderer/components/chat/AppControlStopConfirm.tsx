import { useEffect, useRef } from "react";
import type { AppControlSession } from "../../../shared/types";
import { cn } from "../ui/cn";
import { MAC_DESKTOP_SECONDARY_BUTTON } from "./MacDesktopStateCard";

/**
 * Whether Stop quits the app or only lets go of it.
 *
 * ADE quits an app it launched (the whole process tree and its launch
 * terminal). An app it attached to over a CDP port was started by someone
 * else, so Stop only detaches and the app keeps running.
 */
export function appControlStopQuitsApp(session: Pick<AppControlSession, "command" | "terminalSessionId" | "pid"> | null): boolean {
  if (!session) return false;
  return Boolean(session.command || session.terminalSessionId);
}

export function appControlStopSentence(session: Pick<AppControlSession, "label" | "command" | "terminalSessionId" | "pid"> | null): {
  title: string;
  body: string;
  confirmLabel: string;
} {
  const label = session?.label?.trim() || "the app";
  if (appControlStopQuitsApp(session)) {
    return {
      title: `Stop ${label}?`,
      body: "ADE quits the app it launched and closes its launch terminal, even with unsaved work.",
      confirmLabel: "Quit app",
    };
  }
  return {
    title: `Detach from ${label}?`,
    body: "ADE stops driving it. The app keeps running.",
    confirmLabel: "Detach",
  };
}

/**
 * "Stop <app>?", asked in the pane the way the Mac Desktop pane asks before it
 * stops a display. It names what Stop does for THIS session, because the same
 * button quits a launched app and only detaches an attached one.
 */
export function AppControlStopConfirm({
  session,
  busy,
  onKeep,
  onStop,
}: {
  session: AppControlSession | null;
  busy: boolean;
  onKeep: () => void;
  onStop: () => void;
}) {
  const stopRef = useRef<HTMLButtonElement | null>(null);
  const copy = appControlStopSentence(session);
  useEffect(() => {
    stopRef.current?.focus();
  }, []);
  return (
    <div
      role="alertdialog"
      aria-label={copy.title}
      data-testid="app-control-stop-confirm"
      className="mx-2 mt-1.5 flex min-w-0 shrink-0 flex-wrap items-center gap-2 rounded-[10px] border border-border bg-surface px-3 py-2 font-sans text-[12px] text-fg"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onKeep();
      }}
    >
      <span className="min-w-0 flex-1">
        <span className="font-medium">{copy.title}</span>
        <span className="text-muted-fg"> {copy.body}</span>
      </span>
      <button type="button" className={cn(MAC_DESKTOP_SECONDARY_BUTTON, "h-7")} onClick={onKeep}>
        Keep running
      </button>
      <button
        ref={stopRef}
        type="button"
        data-testid="app-control-stop-confirm-yes"
        disabled={busy}
        className={cn(
          MAC_DESKTOP_SECONDARY_BUTTON,
          "h-7 border-[color-mix(in_srgb,var(--color-error)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-error)_18%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-error)_26%,transparent)]",
        )}
        onClick={onStop}
      >
        {copy.confirmLabel}
      </button>
    </div>
  );
}
