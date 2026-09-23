import { useEffect, useState, type ReactNode } from "react";
import { Monitor } from "@phosphor-icons/react";

import { cn } from "../ui/cn";

/**
 * The one card the pane shows when there is no picture to show.
 *
 * Off, Checking, Starting, Stopping and every failure use this card, on the
 * same gradient page and glass card as the Apple tool's loading card, so the
 * pane reads as one tool moving through states rather than a different line
 * of text for each. A busy card has a spinner and, after a few seconds, a
 * stopwatch. A failed card has the sentence and the buttons that get out of it.
 */

/** A wait shorter than this needs no stopwatch. The Apple card's number. */
export const MAC_DESKTOP_ELAPSED_AFTER_MS = 5_000;

/** The secondary button beside `WORK_TOOL_PRIMARY_BUTTON`. */
export const MAC_DESKTOP_SECONDARY_BUTTON = cn(
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[8px] px-3",
  "border border-white/[0.10] bg-white/[0.04]",
  "font-sans text-[12px] font-medium text-fg/85 transition-colors duration-[120ms] ease-out",
  "hover:bg-white/[0.08] hover:text-fg focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
  "disabled:pointer-events-none disabled:opacity-40",
);

export type MacDesktopStateCardTone = "idle" | "busy" | "error";

function useElapsedSeconds(active: boolean): number | null {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  const elapsed = now - startedAt;
  return active && elapsed >= MAC_DESKTOP_ELAPSED_AFTER_MS ? Math.floor(elapsed / 1_000) : null;
}

export function MacDesktopStateCard({
  testId,
  tone,
  title,
  detail,
  actions,
}: {
  testId: string;
  tone: MacDesktopStateCardTone;
  title: string;
  /** One short line under the title. On an error card, the reason. */
  detail?: string | null;
  actions?: ReactNode;
}) {
  const busy = tone === "busy";
  const failed = tone === "error";
  const elapsedSeconds = useElapsedSeconds(busy);
  return (
    <div
      data-testid={testId}
      data-mac-desktop-state={tone}
      role={failed ? "alert" : "status"}
      className="ade-tool-picker-static relative flex size-full min-h-0 items-center justify-center overflow-auto rounded-[10px] px-6 py-10"
    >
      <div className="ade-tool-card flex w-full min-w-0 max-w-sm flex-col items-center gap-3 p-6 text-center">
        <Monitor
          size={40}
          weight="duotone"
          aria-hidden="true"
          className={cn("shrink-0", failed ? "text-[var(--color-warning)]" : "text-fg/70")}
        />
        <div className="flex min-w-0 flex-col items-center gap-1">
          <div className="flex min-w-0 items-center gap-2">
            {busy ? (
              <span
                aria-hidden="true"
                data-testid={`${testId}-spinner`}
                className="h-3 w-3 shrink-0 animate-spin rounded-full border border-muted-fg/35 border-t-accent"
              />
            ) : null}
            <p className="min-w-0 break-words font-sans text-sm font-medium text-fg">{title}</p>
            {elapsedSeconds != null ? (
              <span className="shrink-0 font-sans text-xs tabular-nums text-muted-fg">{elapsedSeconds}s</span>
            ) : null}
          </div>
          {detail ? (
            <p className="min-w-0 break-words font-sans text-xs leading-5 text-muted-fg">{detail}</p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center justify-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
