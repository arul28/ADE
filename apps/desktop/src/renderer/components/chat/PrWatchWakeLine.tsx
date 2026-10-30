import { useState } from "react";
import { CaretDown, CaretRight, CheckCircle, CircleNotch, GitPullRequest, XCircle } from "@phosphor-icons/react";
import type { AdeCardPayload } from "../../../shared/adeCard";
import { normalizeAdeCardTone } from "../../../shared/adeCard";
import { navigateToAppTarget } from "../../lib/openExternal";
import { cn } from "../ui/cn";
import { openPrInChatToolsPane } from "./chatPrPaneRequests";

const LINE_TEXT = "font-sans text-[length:calc(var(--chat-font-size)*10.5/14)]";

/**
 * "Watching PR #1991 · 8 new comments", read off a `pr_watch_wake` card. The
 * card's subtitle ends in the watch's state when ADE sent it ("watching",
 * "shipping", "watch stopped"); its title is "PR #N · <what changed>".
 */
export function prWatchWakeLineText(card: AdeCardPayload): { lead: string; summary: string } {
  const title = card.title?.trim() ?? "";
  const titleMatch = title.match(/^PR #(\d+)\s*·\s*(.*)$/);
  const target = card.navTarget;
  const prNumber = target?.kind === "pr" && typeof target.prNumber === "number"
    ? target.prNumber
    : titleMatch ? Number(titleMatch[1]) : null;
  const status = card.subtitle?.trim().split("·").pop()?.trim() ?? "";
  const verb = status === "shipping" ? "Shipping" : status === "watch stopped" ? "Stopped watching" : "Watching";
  return {
    lead: prNumber != null ? `${verb} PR #${prNumber}` : verb,
    summary: titleMatch ? titleMatch[2]!.trim() : title,
  };
}

/**
 * A PR Watch / Ship wake as one quiet divider line: what ADE is watching, what
 * changed, and Open PR. The user did not write the wake, and the agent's reply
 * right under it shows it was read, so the line stays out of the way. Clicking
 * it shows what changed and the exact message the agent got.
 */
export function PrWatchWakeLine({ card, wakeText, watchId, sessionId }: {
  card: AdeCardPayload;
  wakeText: string;
  watchId: string;
  /** The chat this line is in: its tools pane shows the PR. */
  sessionId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const { lead, summary } = prWatchWakeLineText(card);
  const rows = card.rows ?? [];
  const warning = rows.some((row) => row.icon === "fail" || normalizeAdeCardTone(row.tone) === "warning");
  const target = card.navTarget ?? null;
  const Caret = open ? CaretDown : CaretRight;
  const progress = card.progress ?? null;
  // A wake that is only about checks says it with the counts alone.
  const checksOnly = progress != null && rows.length > 0 && rows.every((row) => row.icon === "pass" || row.icon === "fail");
  const openPr = () => {
    if (target?.kind === "pr" && target.laneId && target.prId) {
      openPrInChatToolsPane({ laneId: target.laneId, sessionId, prId: target.prId });
    } else if (target) {
      navigateToAppTarget(target);
    }
  };
  return (
    <div className="my-3 flex flex-col gap-1.5" data-pr-watch-wake={watchId}>
      <div className={cn("flex items-center gap-2 text-fg/45", LINE_TEXT)}>
        <span className="h-px flex-1 bg-fg/[0.08]" />
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          title={open ? "Hide what changed" : "Show what changed and what the agent was told"}
          className="inline-flex min-w-0 shrink items-center gap-1 transition-colors hover:text-fg/75"
        >
          <span className="shrink-0 font-medium text-fg/60">{lead}</span>
          {summary && !checksOnly ? (
            <>
              <span aria-hidden className="text-fg/25">·</span>
              <span className={cn("truncate", warning && "text-amber-300/85")}>{summary}</span>
            </>
          ) : null}
          {progress ? (
            <>
              <span aria-hidden className="text-fg/25">·</span>
              <CheckCounts progress={progress} />
            </>
          ) : null}
          <Caret size={9} weight="bold" className="shrink-0" aria-hidden />
        </button>
        {target ? (
          <>
            <span aria-hidden className="text-fg/25">·</span>
            <button
              type="button"
              onClick={openPr}
              aria-label={`Open ${lead.replace(/^(?:Watching|Shipping|Stopped watching) /, "")}`}
              title="Open the pull request"
              className="inline-flex shrink-0 items-center gap-0.5 transition-colors hover:text-fg/75"
            >
              <GitPullRequest size={11} weight="bold" aria-hidden />
              <CaretRight size={9} weight="bold" aria-hidden />
            </button>
          </>
        ) : null}
        <span className="h-px flex-1 bg-fg/[0.08]" />
      </div>
      {open ? (
        <div className={cn("mx-auto flex w-full max-w-[var(--chat-content-width,52rem)] flex-col gap-1.5 text-fg/55", LINE_TEXT)}>
          {rows.length ? (
            <ul className="flex flex-col gap-0.5">
              {rows.map((row, index) => {
                const rowWarning = row.icon === "fail" || normalizeAdeCardTone(row.tone) === "warning";
                return (
                  <li key={`${index}:${row.text}`} className="flex min-w-0 items-baseline gap-2" title={row.detail ?? row.text}>
                    <span aria-hidden className={cn("shrink-0", rowWarning ? "text-amber-300/85" : "text-fg/30")}>•</span>
                    <span className="truncate text-fg/65">{row.text}</span>
                    {row.detail?.trim() ? <span className="truncate text-fg/40">{row.detail.trim()}</span> : null}
                  </li>
                );
              })}
              {card.rowsTruncated ? <li className="pl-4 text-fg/35">+{card.rowsTruncated} more</li> : null}
            </ul>
          ) : null}
          <div className="text-fg/40">What the agent was told</div>
          <pre className="whitespace-pre-wrap break-words rounded-md border border-fg/[0.06] bg-fg/[0.02] p-2 font-sans leading-relaxed text-fg/60">
            {wakeText}
          </pre>
        </div>
      ) : null}
    </div>
  );
}

/** "✓ 38  ✕ 2  ◌ 1": the checks behind a checks wake, each count with its glyph. */
function CheckCounts({ progress }: { progress: NonNullable<AdeCardPayload["progress"]> }) {
  const parts = [
    { count: progress.passed, Glyph: CheckCircle, className: "text-emerald-300/85", label: "passed" },
    { count: progress.failed, Glyph: XCircle, className: "text-amber-300/85", label: "failed" },
    { count: progress.running + progress.queued, Glyph: CircleNotch, className: "text-fg/50", label: "still running" },
  ].filter((part) => part.count > 0);
  return (
    <span className="inline-flex shrink-0 items-center gap-2 font-mono tabular-nums">
      {parts.map(({ count, Glyph, className, label }) => (
        <span key={label} className={cn("inline-flex items-center gap-0.5", className)} title={`${count} ${label}`}>
          <Glyph size={11} weight="bold" aria-hidden />
          {count}
          <span className="sr-only"> {label}</span>
        </span>
      ))}
    </span>
  );
}
