import { useEffect, useMemo, useState } from "react";
import { ArrowCounterClockwise, Pause, Play, Timer } from "@phosphor-icons/react";
import { create } from "zustand";
import { WelcomeCardHead } from "../../projects/ProjectWelcomeSidePanels";
import { showToast } from "../../app/toast/toastStore";
import { localDayKey } from "../../usage/ActivityHeatmap";
import { useWidgetVisible } from "../HomeWidgetGrid";
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
  const big = item.size !== "s";

  const radius = 44;
  const circumference = 2 * Math.PI * radius;

  return (
    <section className="kit-card ade-home-card ade-pomo" aria-label="Focus timer" data-size={item.size} data-phase={state.phase}>
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
            <circle cx="50" cy="50" r={radius} className="ade-pomo-track" />
            <circle
              cx="50"
              cy="50"
              r={radius}
              className="ade-pomo-fill"
              strokeDasharray={`${circumference * progress} ${circumference}`}
              transform="rotate(-90 50 50)"
            />
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
            <div><dt className="kit-eyebrow">Today</dt><dd className="kit-num">{todayLog.sessions} {todayLog.sessions === 1 ? "session" : "sessions"}</dd></div>
            {big ? <div><dt className="kit-eyebrow">Focused</dt><dd className="kit-num">{todayLog.minutes} min</dd></div> : null}
            <div><dt className="kit-eyebrow">Streak</dt><dd className="kit-num">{streak > 0 ? `${streak} day${streak === 1 ? "" : "s"}` : "—"}</dd></div>
          </dl>
        </div>
      </div>
    </section>
  );
}
