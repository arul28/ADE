import React, { useEffect, useState } from "react";
import { Alarm, ArrowsClockwise, CaretDown, CaretRight } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { describeCron } from "../automations/cronDescribe";
import type { AgentChatEvent } from "../../../shared/types";
import type { ChatActivityBundleItem, WakeChainRenderEvent } from "./chatTranscriptRows";

type ScheduledWorkEvent = Extract<AgentChatEvent, { type: "scheduled_work_update" }>;

const PENDING_STATUSES: ReadonlySet<string> = new Set(["scheduled", "paused", "running"]);

/**
 * `in 20m`, `in 1h 5m`, `in 2d`, `now`, or `overdue` once the fire time is
 * more than a minute gone; null for an unparseable time.
 */
function formatRelativeIn(value: string | null | undefined, nowMs: number): string | null {
  const at = value ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const minutes = Math.round((at - nowMs) / 60_000);
  if (minutes < -1) return "overdue";
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
      if (!when) head = "Wake-up scheduled";
      else if (when === "now") head = "Wakes now";
      else if (when === "overdue") head = `Was due ${formatClock(event.nextRunAt)}`;
      else head = `Wakes ${when}`;
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

/** `5 earlier checks · 8:53 PM – 9:25 PM`. Pure so the wording is testable. */
export function describeWakeChainRow(event: WakeChainRenderEvent): { head: string; span: string | null } {
  const head = `${event.checkCount} earlier ${event.checkCount === 1 ? "check" : "checks"}`;
  const first = formatClock(event.firstAt);
  const last = formatClock(event.lastAt);
  const span = first && last ? (first === last ? first : `${first} – ${last}`) : first ?? last;
  return { head, span };
}

/**
 * One row for the earlier turns of a self-paced wake-up loop. The latest check
 * stays in the thread below it; opening the row shows the earlier ones.
 */
export function WakeChainRow({
  event,
  open,
  onToggle,
}: {
  event: WakeChainRenderEvent;
  open: boolean;
  onToggle?: (chainId: string) => void;
}) {
  const line = describeWakeChainRow(event);
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={`${line.head}. ${open ? "Hide" : "Show"} the earlier wake-up checks`}
      onClick={() => onToggle?.(event.chainId)}
      data-wake-chain={event.chainId}
      // Same size and tone as the turn fold row (`Worked for …`) it sits beside.
      className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left font-sans text-[length:calc(var(--chat-font-size)*11/14)] tabular-nums text-fg/50 outline-none transition-colors hover:text-fg/80 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-300/40"
    >
      <Alarm size={11} weight="bold" className="shrink-0 text-amber-200/55" aria-hidden />
      <span className="shrink-0">{line.head}</span>
      {line.span ? (
        <span className="min-w-0 truncate text-fg/40">
          <span className="text-fg/25" aria-hidden>· </span>{line.span}
        </span>
      ) : null}
      {open
        ? <CaretDown size={9} weight="bold" className="shrink-0" aria-hidden />
        : <CaretRight size={9} weight="bold" className="shrink-0" aria-hidden />}
    </button>
  );
}

/**
 * The schedules a finished turn left behind, as small chips at the end of its
 * turn-end line: `⏰ Wakes in 2m`, `⏰ Woke at 9:50 PM`, `⟳ Cron · every 30m`.
 * The reason rides the tooltip; a click opens the schedule in chat actions.
 */
export function ScheduledWorkChips({
  items,
  onOpen,
}: {
  items: readonly ChatActivityBundleItem[];
  onOpen?: (item: ChatActivityBundleItem) => void;
}) {
  const live = items.some((item) => PENDING_STATUSES.has(item.event.status) && Boolean(item.event.nextRunAt));
  const nowMs = useMinuteClock(live);
  return (
    // The turn-end line's own type: `ran 7.3s · 09:48 PM · … · ⏰ woke at 09:50 PM`.
    <span className="inline-flex min-w-0 items-center gap-2 font-mono tabular-nums text-[length:calc(var(--chat-font-size)*10/14)]">
      {items.map((item) => {
        const line = describeScheduledWorkLine(item.event, nowMs);
        const head = line.head.charAt(0).toLowerCase() + line.head.slice(1);
        const Icon = line.kind === "wake" ? Alarm : ArrowsClockwise;
        return (
          <button
            key={item.event.id}
            type="button"
            onClick={onOpen ? () => onOpen(item) : undefined}
            data-scheduled-work={item.event.id}
            data-scheduled-work-status={item.event.status}
            title={line.detail ? `${line.head} · ${line.detail}` : line.head}
            aria-label={line.detail ? `${line.head}: ${line.detail}` : line.head}
            className={cn(
              "inline-flex min-w-0 shrink items-center gap-1 rounded font-mono tabular-nums outline-none transition-colors hover:text-fg/85 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-300/40",
              line.pending ? "text-fg/60" : "text-fg/40",
            )}
          >
            <Icon size={11} weight="bold" className={cn("shrink-0", line.pending ? "text-amber-300/80" : "text-fg/35")} aria-hidden />
            <span className="truncate">{head}</span>
          </button>
        );
      })}
    </span>
  );
}

/**
 * `+3 checks ›` at the end of the turn-end line right above the folded checks;
 * opening it shows them directly below that line.
 */
export function WakeChainChip({
  chainId,
  checkCount,
  open,
  onToggle,
}: {
  chainId: string;
  checkCount: number;
  open: boolean;
  onToggle?: (chainId: string) => void;
}) {
  const label = `${checkCount} more ${checkCount === 1 ? "check" : "checks"}`;
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={`${open ? "Hide" : "Show"} ${label}`}
      onClick={() => onToggle?.(chainId)}
      data-wake-chain={chainId}
      className="inline-flex shrink-0 items-center gap-1 rounded font-mono tabular-nums text-[length:calc(var(--chat-font-size)*10/14)] text-fg/45 outline-none transition-colors hover:text-fg/85 focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-300/40"
    >
      <span className="text-fg/25" aria-hidden>·</span>
      <span>+{label}</span>
      {open
        ? <CaretDown size={9} weight="bold" className="shrink-0" aria-hidden />
        : <CaretRight size={9} weight="bold" className="shrink-0" aria-hidden />}
    </button>
  );
}
