import { useEffect, useMemo, useState } from "react";
import { ArrowCounterClockwise, Pause, Play, Timer } from "@phosphor-icons/react";
import { create } from "zustand";
import { WelcomeCardHead } from "../../projects/ProjectWelcomeSidePanels";
import { showToast } from "../../app/toast/toastStore";
import { localDayKey } from "../../usage/ActivityHeatmap";
import { useWidgetSpan, useWidgetVisible } from "../HomeWidgetGrid";
import type { HomeWidgetProps } from "../homeWidgetRegistry";
import "../homeWidgets.css";

/**
 * Focus timer. One timer for the whole app, kept by end time rather than by
 * ticking, so it survives leaving the home page and a restart (it is stored
 * in localStorage). Completed focus sessions are logged per day; consecutive
 * days with at least one session make the focus streak.
 *
 * Cost: one timeout to the end of the current phase; the card repaints once a
 * second only while it is on screen and running.
 */

const STORAGE_KEY = "ade.home.focus.v1";
const FOCUS_PRESETS = [25, 50] as const;
const BREAK_MINUTES = 5;

type Phase = "focus" | "break";
type FocusState = {
  phase: Phase;
  focusMinutes: number;
  /** Epoch ms the running phase ends; null when stopped or paused. */
  endsAt: number | null;
  /** Time left when paused; null when not paused. */
  pausedMs: number | null;
  /** Completed focus sessions and minutes per local day. */
  log: Record<string, { sessions: number; minutes: number }>;
};

function phaseMs(state: Pick<FocusState, "phase" | "focusMinutes">): number {
  return (state.phase === "focus" ? state.focusMinutes : BREAK_MINUTES) * 60_000;
}

function readState(): FocusState {
  const fallback: FocusState = { phase: "focus", focusMinutes: 25, endsAt: null, pausedMs: null, log: {} };
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<FocusState> | null;
    if (!raw) return fallback;
    return {
      phase: raw.phase === "break" ? "break" : "focus",
      focusMinutes: typeof raw.focusMinutes === "number" && raw.focusMinutes >= 1 && raw.focusMinutes <= 180 ? raw.focusMinutes : 25,
      endsAt: typeof raw.endsAt === "number" ? raw.endsAt : null,
      pausedMs: typeof raw.pausedMs === "number" ? raw.pausedMs : null,
      log: raw.log && typeof raw.log === "object" ? raw.log : {},
    };
  } catch {
    return fallback;
  }
}

type FocusStore = FocusState & {
  start: () => void;
  pause: () => void;
  reset: () => void;
  setFocusMinutes: (minutes: number) => void;
  complete: () => void;
};

const useFocusStore = create<FocusStore>((set, get) => {
  const save = (patch: Partial<FocusState>) => {
    set(patch);
    const { phase, focusMinutes, endsAt, pausedMs, log } = get();
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ phase, focusMinutes, endsAt, pausedMs, log }));
    } catch {
      // Unavailable storage: the timer still runs this session.
    }
    schedule();
  };
  return {
    ...readState(),
    start: () => {
      const state = get();
      const left = state.pausedMs ?? phaseMs(state);
      save({ endsAt: Date.now() + left, pausedMs: null });
    },
    pause: () => {
      const { endsAt } = get();
      if (endsAt == null) return;
      save({ endsAt: null, pausedMs: Math.max(0, endsAt - Date.now()) });
    },
    reset: () => save({ phase: "focus", endsAt: null, pausedMs: null }),
    setFocusMinutes: (minutes) => save({ focusMinutes: minutes, ...(get().phase === "focus" ? { endsAt: null, pausedMs: null } : {}) }),
    complete: () => {
      const state = get();
      if (state.phase === "focus") {
        // Credit the day the session ended on.
        const day = localDayKey(new Date(state.endsAt ?? Date.now()));
        const entry = state.log[day] ?? { sessions: 0, minutes: 0 };
        const log = { ...state.log, [day]: { sessions: entry.sessions + 1, minutes: entry.minutes + state.focusMinutes } };
        // Keep a year of history; older days do not change the streak.
        const cutoff = localDayKey(new Date(Date.now() - 400 * 86_400_000));
        for (const key of Object.keys(log)) if (key < cutoff) delete log[key];
        save({ phase: "break", endsAt: null, pausedMs: null, log });
        showToast({ id: "home-focus-done", tone: "success", title: "Focus session done", message: `Take ${BREAK_MINUTES} minutes.`, durationMs: 8_000 });
      } else {
        save({ phase: "focus", endsAt: null, pausedMs: null });
        showToast({ id: "home-focus-done", tone: "neutral", title: "Break's over", message: "Ready for the next one.", durationMs: 8_000 });
      }
    },
  };
});

let phaseTimer: number | null = null;
function schedule() {
  if (phaseTimer != null) window.clearTimeout(phaseTimer);
  phaseTimer = null;
  const { endsAt } = useFocusStore.getState();
  if (endsAt == null) return;
  phaseTimer = window.setTimeout(() => useFocusStore.getState().complete(), Math.max(0, endsAt - Date.now()));
}
// A phase that ended while ADE was closed completes on first load.
schedule();

function focusStreak(log: FocusState["log"], today: string): number {
  let streak = 0;
  const cursor = new Date();
  // Today counts once it has a session; an empty today does not break yesterday's run.
  if (!(log[today]?.sessions)) cursor.setDate(cursor.getDate() - 1);
  for (;;) {
    const key = localDayKey(cursor);
    if (!(log[key]?.sessions)) break;
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export default function PomodoroWidget({ item }: HomeWidgetProps) {
  const visible = useWidgetVisible();
  const state = useFocusStore();
  const running = state.endsAt != null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || !visible) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, visible]);

  const total = phaseMs(state);
  const left = running ? Math.max(0, state.endsAt! - now) : state.pausedMs ?? total;
  const progress = total > 0 ? 1 - left / total : 0;
  const today = localDayKey();
  const todayLog = state.log[today] ?? { sessions: 0, minutes: 0 };
  const streak = useMemo(() => focusStreak(state.log, today), [state.log, today]);
  const span = useWidgetSpan(item);
  const big = span.w >= 2 || span.h >= 2;
  // The last seven days, oldest first, for the week strip.
  const week = useMemo(() => {
    const days: Array<{ key: string; label: string; sessions: number; today: boolean }> = [];
    for (let back = 6; back >= 0; back -= 1) {
      const date = new Date();
      date.setDate(date.getDate() - back);
      const key = localDayKey(date);
      days.push({ key, label: date.toLocaleDateString(undefined, { weekday: "narrow" }), sessions: state.log[key]?.sessions ?? 0, today: back === 0 });
    }
    return days;
  }, [state.log]);
  const weekMax = Math.max(1, ...week.map((day) => day.sessions));

  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const angle = progress * 2 * Math.PI - Math.PI / 2;

  return (
    <section className="kit-card ade-home-card ade-pomo" aria-label="Focus timer" data-size={item.size} data-phase={state.phase} data-running={running || undefined} data-big={big || undefined}>
      <WelcomeCardHead icon={Timer} title="Focus timer">
        <div className="kit-seg ade-pomo-presets" role="radiogroup" aria-label="Focus length">
          {FOCUS_PRESETS.map((minutes) => (
            <button key={minutes} type="button" role="radio" aria-checked={state.focusMinutes === minutes} disabled={running} onClick={() => state.setFocusMinutes(minutes)}>
              {minutes}m
            </button>
          ))}
        </div>
      </WelcomeCardHead>
      <div className="kit-card-body ade-pomo-body">
        <div className="ade-pomo-dial">
          <svg viewBox="0 0 100 100" aria-hidden>
            <defs>
              <linearGradient id={`pomo-${item.id}`} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" className="ade-pomo-stop-a" />
                <stop offset="100%" className="ade-pomo-stop-b" />
              </linearGradient>
            </defs>
            <circle cx="50" cy="50" r="48.5" className="ade-pomo-ticks" strokeDasharray={`0.6 ${(2 * Math.PI * 48.5) / 60 - 0.6}`} transform="rotate(-90 50 50)" />
            <circle cx="50" cy="50" r={radius} className="ade-pomo-track" />
            <circle
              cx="50"
              cy="50"
              r={radius}
              className="ade-pomo-fill"
              stroke={`url(#pomo-${item.id})`}
              strokeDasharray={`${circumference * progress} ${circumference}`}
              transform="rotate(-90 50 50)"
            />
            {progress > 0 ? <circle className="ade-pomo-knob" cx={50 + radius * Math.cos(angle)} cy={50 + radius * Math.sin(angle)} r="3.6" /> : null}
          </svg>
          <div className="ade-pomo-center">
            <div className="ade-pomo-time kit-num" role="timer" aria-live="off">{formatClock(left)}</div>
            <div className="ade-pomo-phase">{state.phase === "focus" ? (running ? "Focusing" : state.pausedMs != null ? "Paused" : "Focus") : "Break"}</div>
          </div>
        </div>
        <div className="ade-pomo-side">
          <div className="ade-pomo-controls">
            <button type="button" className="kit-btn kit-btn-primary" onClick={running ? state.pause : state.start}>
              {running ? <Pause size={13} weight="fill" /> : <Play size={13} weight="fill" />}
              {running ? "Pause" : state.pausedMs != null ? "Resume" : state.phase === "break" ? "Start break" : "Start"}
            </button>
            {running || state.pausedMs != null || state.phase === "break" ? (
              <button type="button" className="kit-icon-btn" aria-label="Reset timer" title="Reset" onClick={state.reset}>
                <ArrowCounterClockwise size={14} />
              </button>
            ) : null}
          </div>
          <dl className="ade-pomo-facts">
            <div><dt className="kit-eyebrow">Today</dt><dd className="kit-num">{todayLog.sessions} <span>{todayLog.sessions === 1 ? "session" : "sessions"}</span></dd></div>
            {big ? <div><dt className="kit-eyebrow">Focused</dt><dd className="kit-num">{todayLog.minutes} <span>min</span></dd></div> : null}
            <div><dt className="kit-eyebrow">Streak</dt><dd className="kit-num">{streak > 0 ? <>{streak} <span>{streak === 1 ? "day" : "days"}</span></> : "—"}</dd></div>
          </dl>
          {big ? (
            <div className="ade-pomo-week" role="img" aria-label={`Focus sessions, last 7 days: ${week.map((day) => day.sessions).join(", ")}`}>
              {week.map((day) => (
                <div key={day.key} className="ade-pomo-week-day" data-today={day.today || undefined}>
                  <div className="ade-pomo-week-track"><i style={{ height: `${day.sessions === 0 ? 0 : Math.max(14, (day.sessions / weekMax) * 100)}%` }} /></div>
                  <span>{day.label}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
