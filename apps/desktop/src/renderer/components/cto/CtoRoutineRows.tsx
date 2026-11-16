import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alarm, ArrowsClockwise, CalendarBlank, CloudSlash, DotsThree, Lightning, PauseCircle, Trash } from "@phosphor-icons/react";
import type { AgentChatScheduledWorkItem, OpenProjectBinding } from "../../../shared/types";
import { SettingsToggle } from "../settings/primitives";
import { AnchoredMenu } from "../ui/AnchoredMenu";
import { MENU_SURFACE_CLASS, MENU_WIDTH_CLASS } from "../ui/paneMenuTokens";
import { Z_LAYERS } from "../ui/zLayers";
import { confirmDialog } from "../ui/dialog";
import { cn } from "../ui/cn";
import { CtoEmptyLine } from "./ctoSettingsUi";

/**
 * The CTO's routines: everything it has scheduled on its own chat.
 *
 * Self-loading. Reads `agentChat.listScheduledWork` for the CTO session on
 * the CTO's home machine (`pin`), and reloads (debounced) when that session
 * reports a schedule change or finishes a turn. Each row has its own on/off
 * switch and a menu with Run now and Cancel. The settings variant also shows
 * the prompt, when it last ran and what came of it, plus recently finished
 * one-off wake-ups.
 */
export type CtoRoutineRowsProps = {
  /** The CTO chat. Null while it does not exist yet: nothing is scheduled. */
  sessionId: string | null;
  /** The CTO's home machine. Null means unreachable: nothing is read. */
  pin: OpenProjectBinding | null;
  variant: "panel" | "settings";
};

const RELOAD_DEBOUNCE_MS = 800;
const PENDING = new Set<AgentChatScheduledWorkItem["status"]>(["scheduled", "paused"]);
const FINISHED_LIMIT = 8;

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** "In 20 min", "Today at 3:40 PM", "Tomorrow at 9:00 AM", "Fri, Nov 21 at 9:00 AM". */
function describeWhen(iso: string | undefined, nowMs: number): string | null {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const minutes = Math.round((at - nowMs) / 60_000);
  if (minutes < -1) return `Was due ${clock(at)}`;
  if (minutes <= 0) return "Now";
  if (minutes < 60) return `In ${minutes} min`;
  const day = new Date(at);
  const today = new Date(nowMs);
  const tomorrow = new Date(nowMs + 86_400_000);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(day, today)) return `Today at ${clock(at)}`;
  if (sameDay(day, tomorrow)) return `Tomorrow at ${clock(at)}`;
  return `${day.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} at ${clock(at)}`;
}

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_PLURAL = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

/** "0,1-3" -> [0, 1, 2, 3]; null for anything fancier (steps, names). */
function cronDays(field: string): number[] | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const range = /^(\d)(?:-(\d))?$/.exec(part.trim());
    if (!range) return null;
    const from = Number(range[1]);
    const to = range[2] != null ? Number(range[2]) : from;
    for (let day = from; day <= to; day += 1) out.add(day % 7);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * How often a cron repeats, without its clock time: "Weekdays", "Daily",
 * "Every 20 min". The time is left out on purpose: a cron runs in its home
 * machine's timezone, so the clock time shown comes from `nextRunAt`, in the
 * viewer's own time.
 */
function cronCadence(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return "Repeats";
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  const minuteStep = /^\*\/(\d+)$/.exec(minute);
  if (hour === "*" && minuteStep) return `Every ${minuteStep[1]} min`;
  if (hour === "*" && minute === "*") return "Every minute";
  if (hour === "*") return "Hourly";
  const hourStep = /^\*\/(\d+)$/.exec(hour);
  if (hourStep) return `Every ${hourStep[1]} h`;
  if (month !== "*") return "Yearly";
  if (dayOfMonth !== "*") return "Monthly";
  if (dayOfWeek === "*") return "Daily";
  const days = cronDays(dayOfWeek);
  if (!days) return "Weekly";
  const key = days.join(",");
  if (key === "1,2,3,4,5") return "Weekdays";
  if (key === "0,6") return "Weekends";
  if (days.length === 7) return "Daily";
  if (days.length === 1) return DAY_PLURAL[days[0]!]!;
  return days.map((day) => DAY_SHORT[day]).join(", ");
}

/** "3:40 PM" today, "Mon 9:00 AM" this week, "Nov 21" further out; in the viewer's time. */
function describeNext(iso: string | undefined, nowMs: number): string | null {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const minutes = Math.round((at - nowMs) / 60_000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes} min`;
  const day = new Date(at);
  if (day.toDateString() === new Date(nowMs).toDateString()) return clock(at);
  if (at - nowMs < 6 * 86_400_000) return `${DAY_SHORT[day.getDay()]} ${clock(at)}`;
  return day.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The one line under a routine's title: when it runs, in plain words. */
export function describeRoutineSchedule(item: AgentChatScheduledWorkItem, nowMs: number): string {
  if ((item.kind === "cron" || item.kind === "loop") && item.cron?.trim()) {
    const cadence = cronCadence(item.cron);
    const next = PENDING.has(item.status) ? describeNext(item.nextRunAt, nowMs) : null;
    return next ? `${cadence} · next ${next}` : cadence;
  }
  if (item.status === "fired" || item.status === "completed") {
    const ago = describeAgo(item.lastRunAt, nowMs);
    return ago ? `Ran ${ago}` : "Ran";
  }
  if (item.status === "cancelled") return "Cancelled";
  return describeWhen(item.nextRunAt, nowMs) ?? "Scheduled";
}

function describeAgo(iso: string | undefined, nowMs: number): string | null {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const minutes = Math.round((nowMs - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function routineTitle(item: AgentChatScheduledWorkItem): string {
  return item.title?.trim() || item.reason?.trim() || item.prompt.trim().split("\n")[0] || "Routine";
}

/** The row's own switch. Absent on an older host: read it off the status. */
function isRowPaused(item: AgentChatScheduledWorkItem): boolean {
  return item.paused ?? item.status === "paused";
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

const MENU_ITEM = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-fg/85 hover:bg-[var(--kit-hover)] disabled:opacity-50";

function RoutineRow({
  item,
  variant,
  nowMs,
  busy,
  onPause,
  onRunNow,
  onCancel,
}: {
  item: AgentChatScheduledWorkItem;
  variant: CtoRoutineRowsProps["variant"];
  nowMs: number;
  busy: boolean;
  onPause: (paused: boolean) => void;
  onRunNow: () => void;
  onCancel: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const pending = PENDING.has(item.status);
  const rowPaused = isRowPaused(item);
  const Icon = item.kind === "wakeup" ? Alarm : ArrowsClockwise;
  const title = routineTitle(item);
  const settings = variant === "settings";
  const lastRun = describeAgo(item.lastRunAt, nowMs);
  const prompt = item.prompt.trim();
  // A row ADE armed itself (an auto-resume) or one its API cannot manage has
  // no extra run to offer.
  const canRunNow = !item.source && item.cancellable;
  const scheduleLine = [
    describeRoutineSchedule(item, nowMs),
    rowPaused && pending ? "Off" : null,
    item.late ? "Late" : null,
  ].filter(Boolean).join(" · ");
  // A finished row's schedule line already says when it ran.
  const lastRunLine = [pending && lastRun ? `Last ran ${lastRun}` : null, item.outcomeSummary?.trim() || null].filter(Boolean).join(" · ");

  return (
    <li
      className={cn(
        "flex min-w-0 gap-2.5",
        settings ? "items-start px-3.5 py-3" : "items-center px-2 py-1.5",
        !pending && "opacity-70",
      )}
      data-routine-id={item.id}
    >
      <span className={cn("flex w-4 shrink-0 justify-center text-[var(--kit-text-3)]", settings && "mt-[3px]")} aria-hidden>
        <Icon size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <div className={cn("truncate font-medium text-fg", settings ? "text-[13px]" : "text-[12.5px]")} title={title}>
          {title}
        </div>
        <div className="mt-0.5 truncate text-[12px] leading-[1.45] text-[var(--kit-text-3)]" title={scheduleLine}>
          {scheduleLine}
        </div>
        {settings && prompt && prompt !== title ? (
          <p className="m-0 mt-1 truncate text-[12px] leading-[1.5] text-[var(--kit-text-2)]" title={prompt}>
            {prompt}
          </p>
        ) : null}
        {settings && lastRunLine ? (
          <div className="mt-0.5 truncate text-[11.5px] leading-[1.45] text-[var(--kit-text-3)]" title={lastRunLine}>
            {lastRunLine}
          </div>
        ) : null}
      </div>
      {pending ? (
        <div className="flex shrink-0 items-center gap-1">
          <SettingsToggle
            label={rowPaused ? `Turn on ${title}` : `Turn off ${title}`}
            checked={!rowPaused}
            disabled={busy}
            onChange={(on) => onPause(!on)}
          />
          {canRunNow || item.cancellable ? (
            <>
              <button
                ref={moreRef}
                type="button"
                className="kit-icon-btn"
                aria-label={`More for ${title}`}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                disabled={busy}
                onClick={() => setMenuOpen((value) => !value)}
              >
                <DotsThree size={16} weight="bold" />
              </button>
              <AnchoredMenu
                open={menuOpen}
                anchorRef={moreRef}
                onClose={() => setMenuOpen(false)}
                placement="bottom-end"
                zIndex={Z_LAYERS.popover}
                className={cn(MENU_SURFACE_CLASS, MENU_WIDTH_CLASS)}
                role="menu"
              >
                {canRunNow ? (
                  <button
                    type="button"
                    role="menuitem"
                    className={MENU_ITEM}
                    onClick={() => { setMenuOpen(false); onRunNow(); }}
                  >
                    <Lightning size={14} /> Run now
                  </button>
                ) : null}
                {item.cancellable ? (
                  <button
                    type="button"
                    role="menuitem"
                    className={cn(MENU_ITEM, "text-[var(--kit-crit)]")}
                    onClick={() => { setMenuOpen(false); onCancel(); }}
                  >
                    <Trash size={14} /> Cancel routine
                  </button>
                ) : null}
              </AnchoredMenu>
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Held by the chat-wide pause, not by the row's own switch. */
function isHeldByChat(item: AgentChatScheduledWorkItem): boolean {
  return item.status === "paused" && !isRowPaused(item);
}

export function CtoRoutineRows({ sessionId, pin, variant }: CtoRoutineRowsProps) {
  const [items, setItems] = useState<AgentChatScheduledWorkItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const nowMs = useMinuteClock();
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const generationRef = useRef(0);
  const settings = variant === "settings";

  const load = useCallback(async () => {
    const target = pinRef.current;
    if (!sessionId || !target) {
      setItems([]);
      setLoaded(true);
      return;
    }
    const generation = generationRef.current;
    try {
      const next = await window.ade.agentChat.listScheduledWork({ sessionId, includeTerminal: settings }, target);
      if (generation !== generationRef.current) return;
      setItems(next.filter((item) => item.sessionId === sessionId));
      setError(null);
    } catch (err) {
      if (generation !== generationRef.current) return;
      setError(errorText(err, "Couldn't read the routines."));
    } finally {
      if (generation === generationRef.current) setLoaded(true);
    }
  }, [sessionId, settings]);

  useEffect(() => {
    generationRef.current += 1;
    setLoaded(false);
    setItems([]);
    void load();
    const target = pinRef.current;
    if (!sessionId || !target) return undefined;
    let timer: number | null = null;
    const unsubscribe = window.ade.agentChat.onEvent((envelope) => {
      if (envelope.sessionId !== sessionId) return;
      const type = envelope.event.type;
      if (type !== "scheduled_work_update" && type !== "done") return;
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void load();
      }, RELOAD_DEBOUNCE_MS);
    }, target);
    return () => {
      if (timer != null) window.clearTimeout(timer);
      unsubscribe();
    };
    // Keyed on the pin's key, not the object: a rebuilt pin re-subscribes nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, pin?.key, load]);

  const act = async (item: AgentChatScheduledWorkItem, run: (target: OpenProjectBinding, sid: string) => Promise<unknown>, fallback: string) => {
    const target = pinRef.current;
    if (!target || !sessionId) return;
    setBusyId(item.id);
    setError(null);
    try {
      await run(target, sessionId);
      await load();
    } catch (err) {
      setError(errorText(err, fallback));
    } finally {
      setBusyId(null);
    }
  };

  const pause = (item: AgentChatScheduledWorkItem, paused: boolean) => {
    // Flip the switch at once; the reload confirms (or reverts) it.
    setItems((current) => current.map((entry) => (entry.id === item.id ? { ...entry, paused } : entry)));
    void act(
      item,
      (target, sid) => window.ade.agentChat.setScheduledWorkItemPaused({ sessionId: sid, scheduleId: item.id, paused }, target),
      paused ? "Couldn't turn the routine off." : "Couldn't turn the routine on.",
    );
  };

  const runNow = (item: AgentChatScheduledWorkItem) => void act(
    item,
    async (target, sid) => {
      const result = await window.ade.agentChat.runScheduledWorkNow({ sessionId: sid, scheduleId: item.id }, target);
      // Not fired (the chat is busy, the row is gone) is an answer, not a throw.
      if (result && result.fired === false) throw new Error(result.reason || "The routine didn't run.");
    },
    "Couldn't run the routine.",
  );

  const cancel = async (item: AgentChatScheduledWorkItem) => {
    const confirmed = await confirmDialog({
      title: `Cancel "${routineTitle(item)}"?`,
      message: "It won't run again.",
      confirmLabel: "Cancel routine",
      cancelLabel: "Keep it",
      destructive: true,
    });
    if (!confirmed) return;
    await act(
      item,
      (target, sid) => window.ade.agentChat.cancelScheduledWork({ sessionId: sid, scheduleId: item.id }, target),
      "Couldn't cancel the routine.",
    );
  };

  const upcoming = items.filter((item) => PENDING.has(item.status));
  // The chat-wide pause holds every row at once: say it once, not per row.
  const chatPaused = upcoming.some(isHeldByChat);
  const resumeAll = async () => {
    const target = pinRef.current;
    if (!target || !sessionId) return;
    setError(null);
    try {
      await window.ade.agentChat.setScheduledWorkPaused({ sessionId, paused: false }, target);
      await load();
    } catch (err) {
      setError(errorText(err, "Couldn't resume the routines."));
    }
  };
  const finished = settings
    ? items
      .filter((item) => !PENDING.has(item.status) && item.status !== "cancelled")
      .sort((a, b) => Date.parse(b.lastRunAt ?? b.createdAt) - Date.parse(a.lastRunAt ?? a.createdAt))
      .slice(0, FINISHED_LIMIT)
    : [];

  const renderList = (rows: AgentChatScheduledWorkItem[]) => (
    <ul className={cn("m-0 list-none p-0", settings && "ade-modern-rows")}>
      {rows.map((item, index) => (
        <React.Fragment key={item.id}>
          {settings && index > 0 ? <li aria-hidden className="h-px bg-[var(--kit-rule)]" /> : null}
          <RoutineRow
            item={item}
            variant={variant}
            nowMs={nowMs}
            busy={busyId === item.id}
            onPause={(paused) => pause(item, paused)}
            onRunNow={() => runNow(item)}
            onCancel={() => void cancel(item)}
          />
        </React.Fragment>
      ))}
    </ul>
  );

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid={`cto-routines-${variant}`}>
      {chatPaused ? (
        <div className="ade-cto-empty" role="status">
          <span className="ade-cto-empty-icon" aria-hidden><PauseCircle size={14} /></span>
          <span className="ade-cto-empty-text">All routines paused</span>
          <button type="button" className="kit-btn shrink-0" data-size="xs" onClick={() => void resumeAll()}>
            Resume
          </button>
        </div>
      ) : null}
      {pin == null ? (
        <CtoEmptyLine icon={<CloudSlash size={14} />} hint="Routines live on the home machine">
          Home machine offline
        </CtoEmptyLine>
      ) : !loaded ? (
        <CtoEmptyLine icon={<CalendarBlank size={14} />}>Loading…</CtoEmptyLine>
      ) : error && items.length === 0 ? (
        null
      ) : upcoming.length === 0 ? (
        <CtoEmptyLine icon={<CalendarBlank size={14} />} hint="Ask in chat to schedule a check-in">
          Nothing scheduled
        </CtoEmptyLine>
      ) : (
        renderList(upcoming)
      )}
      {finished.length > 0 ? (
        <>
          <div className="mt-5 text-[12px] font-medium text-[var(--kit-text-2)]">Recently ran</div>
          {renderList(finished)}
        </>
      ) : null}
      {error ? <CtoEmptyLine tone="crit" hint={error}>{error}</CtoEmptyLine> : null}
    </div>
  );
}
