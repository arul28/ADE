import React, { useEffect, useState } from "react";
import { Alarm, ArrowsClockwise, CaretRight } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { describeCron } from "../automations/cronDescribe";
import type { AgentChatEvent } from "../../../shared/types";

type ScheduledWorkEvent = Extract<AgentChatEvent, { type: "scheduled_work_update" }>;

const PENDING_STATUSES: ReadonlySet<string> = new Set(["scheduled", "paused", "running"]);

/** `in 20m`, `in 1h 5m`, `in 2d`, or `now`; null for an unparseable time. */
function formatRelativeIn(value: string | null | undefined, nowMs: number): string | null {
  const at = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const minutes = Math.round((at - nowMs) / 60_000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes}m`;
  if (minutes < 60 * 24) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `in ${hours}h ${rest}m` : `in ${hours}h`;
  }
  return `in ${Math.round(minutes / (60 * 24))}d`;
}

function formatClock(value: string | null | undefined): string | null {
  const at = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** `every 30 minutes` → `every 30m`, so a cron line stays one short line. */
function compactCronGloss(cron: string): string {
  return describeCron(cron)
    .replace(/every (\d+) minutes?/, "every $1m")
    .replace(/every (\d+) hours?/, "every $1h");
}

/**
 * The words of one scheduled-work line, without the icon. Pure so the wording
 * is testable without a clock: `Wakes in 20m`, `Cron · every 30m · next 14:30`.
 */
export function describeScheduledWorkLine(
  event: ScheduledWorkEvent,
  nowMs: number,
): { kind: "wake" | "repeat"; head: string; detail: string | null; pending: boolean } {
  const pending = PENDING_STATUSES.has(event.status);
  const note = event.reason?.trim() || event.title?.trim() || event.prompt?.trim() || null;
  if (event.kind === "wakeup" || event.kind === "remote_trigger") {
    const noun = event.kind === "wakeup" ? "Wake-up" : "Trigger";
    let head: string;
    if (event.status === "paused") head = `${noun} paused`;
    else if (pending) {
      const when = formatRelativeIn(event.nextRunAt, nowMs);
      head = when ? (when === "now" ? "Wakes now" : `Wakes ${when}`) : "Wake-up scheduled";
    } else if (event.status === "fired" || event.status === "completed") {
      const clock = formatClock(event.firedAt ?? event.lastRunAt ?? event.nextRunAt);
      head = clock ? `Woke at ${clock}` : "Woke";
    } else {
      head = `${noun} ${event.status}`;
    }
    return { kind: "wake", head, detail: note, pending };
  }
  const label = event.kind === "loop" ? "Loop" : "Cron";
  const parts = [label];
  if (event.cron?.trim()) parts.push(compactCronGloss(event.cron.trim()));
  if (pending && event.status !== "paused") {
    const next = formatClock(event.nextRunAt);
    if (next) parts.push(`next ${next}`);
  } else {
    parts.push(event.status);
  }
  return { kind: "repeat", head: parts.join(" · "), detail: note, pending };
}

/** Re-render once a minute while a relative time is on screen. */
function useMinuteClock(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, [active]);
  return nowMs;
}

/**
 * One compact line for a wake-up, cron, or loop the agent scheduled:
 * `⏰ Wakes in 20m · <reason>` or `⟳ Cron · every 30m · next 14:30`. Left
 * aligned in thread text size, like the background-job row, instead of a card.
 * Clicking opens the chat actions pane where the schedule lives.
 */
export function ScheduledWorkLine({
  event,
  onOpen,
}: {
  event: ScheduledWorkEvent;
  onOpen?: () => void;
}) {
  const nowMs = useMinuteClock(PENDING_STATUSES.has(event.status) && Boolean(event.nextRunAt));
  const line = describeScheduledWorkLine(event, nowMs);
  const Icon = line.kind === "wake" ? Alarm : ArrowsClockwise;
  const content = (
    <>
      <Icon size={13} weight="regular" className={cn("shrink-0", line.pending ? "text-amber-200/70" : "text-fg/35")} aria-hidden />
      <span className={cn("shrink-0", line.pending ? "text-fg/65" : "text-fg/45")}>{line.head}</span>
      {line.detail ? (
        <span className="min-w-0 truncate text-fg/40" title={line.detail}>
          <span className="text-fg/25" aria-hidden>· </span>{line.detail}
        </span>
      ) : null}
      {onOpen ? <CaretRight size={10} weight="bold" className="shrink-0 text-fg/35" aria-hidden /> : null}
    </>
  );
  const className = "flex min-w-0 max-w-full items-center gap-2 py-0.5 font-sans text-[length:var(--chat-font-size)]";
  if (!onOpen) {
    return <div className={className} data-scheduled-work={event.id} data-scheduled-work-status={event.status}>{content}</div>;
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      data-scheduled-work={event.id}
      data-scheduled-work-status={event.status}
      title="Show scheduled work in the chat actions pane"
      className={cn(
        className,
        "rounded-md text-left transition-colors hover:text-fg/80 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-300/40",
      )}
    >
      {content}
    </button>
  );
}
