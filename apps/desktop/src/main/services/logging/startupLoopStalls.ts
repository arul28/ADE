/**
 * Launch diagnostics: the times main's event loop could not run a 5 ms timer
 * on time, from IPC registration to the first window-session answer. A window
 * session read that main answers late while its handler did no work waited
 * behind these. Logged in `startup.window_session_first`; ids and numbers only.
 *
 * It runs once per process and stops at the first answer, or after 15 s.
 */
const STEP_MS = 5;
/** Shorter gaps are timer jitter, not a blocked loop. */
const MIN_STALL_MS = 20;
const MAX_WATCH_MS = 15_000;
const MAX_STALLS = 12;

type StallWatch = {
  startedAtMs: number;
  lastTickMs: number;
  timer: NodeJS.Timeout | null;
  /** [process uptime when the stall began, length], longest kept. */
  stalls: Array<[number, number]>;
  totalStallMs: number;
};

let watch: StallWatch | null = null;
let started = false;

const uptimeMs = (): number => process.uptime() * 1000;

function tick(current: StallWatch): void {
  const now = uptimeMs();
  const gap = now - current.lastTickMs - STEP_MS;
  if (gap >= MIN_STALL_MS) {
    current.totalStallMs += gap;
    current.stalls.push([Math.round(current.lastTickMs + STEP_MS), Math.round(gap)]);
    if (current.stalls.length > MAX_STALLS) {
      current.stalls.sort((a, b) => b[1] - a[1]);
      current.stalls.length = MAX_STALLS;
    }
  }
  current.lastTickMs = now;
  if (now - current.startedAtMs >= MAX_WATCH_MS) {
    current.timer = null;
    return;
  }
  current.timer = setTimeout(() => tick(current), STEP_MS);
  current.timer.unref?.();
}

export function startStartupLoopStallWatch(): void {
  if (started) return;
  started = true;
  const now = uptimeMs();
  const current: StallWatch = { startedAtMs: now, lastTickMs: now, timer: null, stalls: [], totalStallMs: 0 };
  watch = current;
  current.timer = setTimeout(() => tick(current), STEP_MS);
  current.timer.unref?.();
}

/** Stops the watch and returns what it saw, or null when it never ran. */
export function takeStartupLoopStalls(): {
  watchedFromMs: number;
  totalStallMs: number;
  stalls: Array<[number, number]>;
} | null {
  const current = watch;
  if (!current) return null;
  watch = null;
  if (current.timer) clearTimeout(current.timer);
  current.timer = null;
  return {
    watchedFromMs: Math.round(current.startedAtMs),
    totalStallMs: Math.round(current.totalStallMs),
    stalls: [...current.stalls].sort((a, b) => a[0] - b[0]),
  };
}
