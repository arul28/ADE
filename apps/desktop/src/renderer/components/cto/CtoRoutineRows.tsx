import { useCallback, useEffect, useRef, useState } from "react";
import { Alarm, ArrowsClockwise, Binoculars, CalendarBlank, CloudSlash, DotsThree, Lightning, PauseCircle, Trash } from "@phosphor-icons/react";
import type { AgentChatScheduledWorkItem, OpenProjectBinding } from "../../../shared/types";
import { useMinuteClock } from "../../hooks/useMinuteClock";
import { ipcErrorMessage } from "../../lib/format";
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

const RELOAD_DEBOUNCE_MS = 300;
/** How long a routine that just appeared stays lit. */
const FRESH_MS = 2_400;
const PENDING = new Set<AgentChatScheduledWorkItem["status"]>(["scheduled", "paused"]);
const FINISHED_LIMIT = 8;
/** How long a Run now shows "Running now" before the chat takes over. */
const RUNNING_HOLD_MS = 1_800;
/** A title made from the whole prompt clips past about this; the details then show the prompt in full. */
const TITLE_FITS_CHARS = 48;

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
    const next = PENDING.has(item.status) && !isRowPaused(item) ? describeNext(item.nextRunAt, nowMs) : null;
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

/**
 * How a routine's check last went: "failing", "no change 4 min ago" (the last
 * check woke nothing), or "checked 4 min ago" (it woke the routine's last run).
 */
function describeRoutineCheck(item: AgentChatScheduledWorkItem, nowMs: number): string | null {
  if (item.checkFailing) return "failing";
  const checkedAt = item.lastCheckedAt ? Date.parse(item.lastCheckedAt) : Number.NaN;
  const ago = describeAgo(item.lastCheckedAt, nowMs);
  if (!Number.isFinite(checkedAt) || !ago) return null;
  const ranAt = item.lastRunAt ? Date.parse(item.lastRunAt) : Number.NaN;
  // A check that wakes carries its run's own time; a later one was quiet.
  const quiet = !Number.isFinite(ranAt) || checkedAt > ranAt;
  return quiet ? `no change ${ago}` : `checked ${ago}`;
}

function routineTitle(item: AgentChatScheduledWorkItem): string {
  return item.title?.trim() || item.reason?.trim() || item.prompt.trim().split("\n")[0] || "Routine";
}

/** The row's own switch. Absent on an older host: read it off the status. */
function isRowPaused(item: AgentChatScheduledWorkItem): boolean {
  return item.paused ?? item.status === "paused";
}

const MENU_ITEM = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-fg/85 hover:bg-[var(--kit-hover)] disabled:opacity-50";

type RoutineNote = { text: string; tone?: "crit" | "accent" };

/**
 * The one quiet line under a settings row's schedule, the most useful thing
 * first: it is running, its check is failing, what came of the last run, or
 * that it wakes only on a change.
 */
function routineNote(item: AgentChatScheduledWorkItem, nowMs: number, running: boolean): RoutineNote | null {
  if (running) return { text: "Running now", tone: "accent" };
  const check = item.check?.trim();
  if (check && item.checkFailing) return { text: "Check failing · quiet until it passes", tone: "crit" };
  const lastRun = describeAgo(item.lastRunAt, nowMs);
  const outcome = item.outcomeSummary?.trim();
  if (outcome) return { text: lastRun ? `${outcome} · ${lastRun}` : outcome };
  if (check) return { text: lastRun ? `Quiet since it last woke ${lastRun}` : "Nothing new yet" };
  return null;
}

/** Panel rows are narrow: the cadence and the clock, without "next". */
function panelScheduleLine(item: AgentChatScheduledWorkItem, nowMs: number): string {
  if ((item.kind === "cron" || item.kind === "loop") && item.cron?.trim()) {
    const cadence = cronCadence(item.cron);
    // A watch runs when its check sees news, so how often it looks says more than the next clock time.
    if (item.check?.trim()) return `On change · ${cadence.charAt(0).toLowerCase()}${cadence.slice(1)}`;
    const next = PENDING.has(item.status) && !isRowPaused(item) ? describeNext(item.nextRunAt, nowMs) : null;
    return next ? `${cadence} · ${next}` : cadence;
  }
  return describeRoutineSchedule(item, nowMs);
}

function RoutineRow({
  item,
  variant,
  nowMs,
  busy,
  fresh,
  running,
  onPause,
  onRunNow,
  onCancel,
}: {
  item: AgentChatScheduledWorkItem;
  variant: CtoRoutineRowsProps["variant"];
  nowMs: number;
  busy: boolean;
  /** It was scheduled while the list was on screen. */
  fresh: boolean;
  /** A Run now is on its way, or the row is firing. */
  running: boolean;
  onPause: (paused: boolean) => void;
  onRunNow: () => void;
  onCancel: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const pending = PENDING.has(item.status);
  const rowPaused = isRowPaused(item);
  const check = item.check?.trim() || null;
  const Icon = check ? Binoculars : item.kind === "wakeup" ? Alarm : ArrowsClockwise;
  const title = routineTitle(item);
  const settings = variant === "settings";
  const prompt = item.prompt.trim();
  // A row ADE armed itself (an auto-resume) or one its API cannot manage has
  // no extra run to offer.
  const canRunNow = !item.source && item.cancellable;
  const scheduleLine = [
    settings && !check ? describeRoutineSchedule(item, nowMs) : panelScheduleLine(item, nowMs),
    item.late ? "late" : null,
  ].filter(Boolean).join(" · ");
  const note = settings ? routineNote(item, nowMs, running) : running ? { text: "Running now", tone: "accent" as const } : null;
  const checkLine = check ? describeRoutineCheck(item, nowMs) : null;
  const lastRun = describeAgo(item.lastRunAt, nowMs);
  const state = running ? "running" : check && item.checkFailing ? "failing" : rowPaused || !pending ? "off" : "on";
  const detailsId = `routine-details-${item.id}`;

  return (
    <li
      className="ade-cto-routine"
      data-variant={variant}
      data-state={state}
      data-open={open ? "true" : undefined}
      data-routine-id={item.id}
      data-fresh={fresh ? "true" : undefined}
    >
      <div className="ade-cto-routine-main">
        <span className="ade-cto-routine-tile" aria-hidden>
          <Icon size={settings ? 15 : 13} />
          {state === "running" || state === "failing" ? <i className="ade-cto-routine-signal" /> : null}
        </span>
        <button
          type="button"
          className="ade-cto-routine-text"
          aria-expanded={settings ? open : undefined}
          aria-controls={settings ? detailsId : undefined}
          disabled={!settings}
          onClick={() => setOpen((value) => !value)}
          // The lines clip, so the full text is a hover away.
          title={[title, note?.text, !settings && check ? `Wakes only when \`${check}\` changes or first fails` : null].filter(Boolean).join("\n")}
        >
          <span className="ade-cto-routine-title">{title}</span>
          <span className="ade-cto-routine-when">
            {scheduleLine}
          </span>
          {note ? (
            <span key={`${note.tone ?? "plain"}:${note.text}`} className="ade-cto-routine-note" data-tone={note.tone}>
              {note.text}
            </span>
          ) : null}
        </button>
        {pending ? (
          <div className="ade-cto-routine-controls">
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
                  className="kit-icon-btn ade-cto-routine-more"
                  aria-label={`More for ${title}`}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  data-open={menuOpen ? "true" : undefined}
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
      </div>
      {settings ? (
        <div className="ade-cto-routine-details" id={detailsId} aria-hidden={!open}>
          <div className="ade-cto-routine-details-inner">
            {prompt && (prompt !== title || prompt.length > TITLE_FITS_CHARS) ? <p className="ade-cto-routine-prompt">{prompt}</p> : null}
            {check ? (
              <div className="ade-cto-routine-check">
                <span className="kit-eyebrow">Wakes when this changes</span>
                <code>{check}</code>
                {checkLine ? (
                  <span className="ade-cto-routine-check-state" data-tone={item.checkFailing ? "crit" : undefined}>
                    {item.checkFailing ? "Failing. It wakes again when it passes with new output." : `${checkLine.charAt(0).toUpperCase()}${checkLine.slice(1)}`}
                  </span>
                ) : null}
              </div>
            ) : null}
            {lastRun ? <span className="ade-cto-routine-meta">Last ran {lastRun}</span> : null}
          </div>
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
  const [runningIds, setRunningIds] = useState<ReadonlySet<string>>(() => new Set());
  // Rows that appear after the first read light up, so a routine the CTO just
  // scheduled is seen arriving. Null until that first read.
  const seenIdsRef = useRef<Set<string> | null>(null);
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(() => new Set());
  // Only rows show a relative time; with none, nothing ticks.
  const nowMs = useMinuteClock(items.length > 0);
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
      const mine = next.filter((item) => item.sessionId === sessionId);
      const seen = seenIdsRef.current;
      if (seen) {
        const arrived = mine.filter((item) => !seen.has(item.id)).map((item) => item.id);
        if (arrived.length > 0) setFreshIds((current) => new Set([...current, ...arrived]));
      }
      seenIdsRef.current = new Set(mine.map((item) => item.id));
      setItems(mine);
      setError(null);
    } catch (err) {
      if (generation !== generationRef.current) return;
      setError(ipcErrorMessage(err) || "Couldn't read the routines.");
    } finally {
      if (generation === generationRef.current) setLoaded(true);
    }
  }, [sessionId, settings]);

  useEffect(() => {
    generationRef.current += 1;
    seenIdsRef.current = null;
    setFreshIds(new Set());
    setLoaded(false);
    setItems([]);
    void load();
    const target = pinRef.current;
    if (!sessionId || !target) return undefined;
    let timer: number | null = null;
    const unsubscribe = window.ade.agentChat.onEvent((envelope) => {
      if (envelope.sessionId !== sessionId) return;
      const event = envelope.event;
      // A quiet check keeps the row's status, so the scheduler reports it only
      // as a bare session_meta_updated; meta updates carrying a field are other news.
      const bareMetaUpdate = event.type === "session_meta_updated" && Object.keys(event).length === 1;
      if (event.type !== "scheduled_work_update" && event.type !== "done" && !bareMetaUpdate) return;
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

  useEffect(() => {
    if (freshIds.size === 0) return undefined;
    const timer = window.setTimeout(() => setFreshIds(new Set()), FRESH_MS);
    return () => window.clearTimeout(timer);
  }, [freshIds]);

  const act = async (item: AgentChatScheduledWorkItem, run: (target: OpenProjectBinding, sid: string) => Promise<unknown>, fallback: string) => {
    const target = pinRef.current;
    if (!target || !sessionId) return;
    setBusyId(item.id);
    setError(null);
    try {
      await run(target, sessionId);
      await load();
    } catch (err) {
      setError(ipcErrorMessage(err) || fallback);
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

  const runNow = (item: AgentChatScheduledWorkItem) => {
    setRunningIds((current) => new Set([...current, item.id]));
    void act(
      item,
      async (target, sid) => {
        const result = await window.ade.agentChat.runScheduledWorkNow({ sessionId: sid, scheduleId: item.id }, target);
        // Not fired (the chat is busy, the row is gone) is an answer, not a throw.
        if (result && result.fired === false) throw new Error(result.reason || "The routine didn't run.");
      },
      "Couldn't run the routine.",
    ).finally(() => {
      // Long enough to be seen; the chat itself shows the turn after that.
      window.setTimeout(() => setRunningIds((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      }), RUNNING_HOLD_MS);
    });
  };

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
      setError(ipcErrorMessage(err) || "Couldn't resume the routines.");
    }
  };
  const finished = settings
    ? items
      .filter((item) => !PENDING.has(item.status) && item.status !== "cancelled")
      .sort((a, b) => Date.parse(b.lastRunAt ?? b.createdAt) - Date.parse(a.lastRunAt ?? a.createdAt))
      .slice(0, FINISHED_LIMIT)
    : [];

  const renderList = (rows: AgentChatScheduledWorkItem[]) => (
    <ul className={cn("ade-cto-routine-list", settings && "ade-modern-rows")} data-variant={variant}>
      {rows.map((item) => (
        <RoutineRow
          key={item.id}
          item={item}
          variant={variant}
          nowMs={nowMs}
          busy={busyId === item.id}
          fresh={freshIds.has(item.id)}
          // A one-shot that never reported done stays "fired"; only a cron's fired is a run in progress.
          running={runningIds.has(item.id) || (item.status === "fired" && item.kind === "cron")}
          onPause={(paused) => pause(item, paused)}
          onRunNow={() => runNow(item)}
          onCancel={() => void cancel(item)}
        />
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
          <div className="kit-eyebrow mt-5">Recently ran</div>
          {renderList(finished)}
        </>
      ) : null}
      {error ? <CtoEmptyLine tone="crit" hint={error}>{error}</CtoEmptyLine> : null}
    </div>
  );
}
