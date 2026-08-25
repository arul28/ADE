// ---------------------------------------------------------------------------
// Machine power and sleep state.
//
// ADE used to have no idea when a host machine went to sleep: a phone happily
// reported "Connected" to a Mac whose lid had been shut for an hour, because
// every signal ADE had — a socket that had not yet failed, a `lastSeenAt` from
// 40 seconds ago — reads exactly the same on a live machine and on an
// unconscious one. The fix is to make sleep a STATED fact: a machine announces
// its own suspend before it goes dark, and everything downstream reads that
// announcement instead of guessing from silence.
//
// Every type here is shared by the desktop main process, the ade-cli brain, the
// account-directory Worker's wire shape, and the clients that render presence.
// Keep it dependency-free so all four can import it.
//
// THE POWER PHRASE, stated once here because two platforms render it.
//
// A machine's power is described by ONE phrase, chosen in this order:
//
//   1. It has a battery      -> "82% battery", whatever it is plugged into.
//   2. No battery, wall power -> "plugged in".
//   3. No battery, no wall power -> "on battery".
//
// A battery reading is never suppressed by wall power. "Plugged in" answers a
// question nobody asked about a laptop; "82% battery" is what tells the reader
// how long the machine has if the cable comes out, and it stays true either
// way. Only a machine with no battery has nothing better to say, and for that
// machine "plugged in" is the whole of the fact. Swift's renderer follows this
// paragraph, and `machinePowerPhrase` in `shared/machinePresence.ts` is its
// TypeScript implementation — they must agree word for word.
// ---------------------------------------------------------------------------

/** Absent entirely on machines with no battery (desktops, servers). */
export type MachineBattery = {
  /** Whole percent, 0-100. */
  percent: number;
  charging: boolean;
};

export type MachinePower = {
  /**
   * Omitted — never zeroed — when the machine has no battery. A Mac Studio
   * showing "0%" is a bug, not a flat desktop.
   */
  battery?: MachineBattery;
  /** Wall power. Desktops/servers are always true. */
  onExternalPower: boolean;
};

/** Presence is a stated fact, not a guess, wherever possible. */
export type MachineSleepState = "awake" | "asleep";

/**
 * What a client shows for a machine, most-alive first.
 *
 * - `connected` — we hold a live channel to it right now.
 * - `online` — it is heartbeating to the account directory.
 * - `asleep` — it announced a suspend, or went silent recently enough that
 *   sleep is the only reasonable reading.
 * - `offline` — silent long enough that we no longer claim to know.
 */
export type MachinePresence = "connected" | "online" | "asleep" | "offline";

/**
 * How long after a machine's last heartbeat we still call its silence "asleep"
 * rather than "offline".
 *
 * This is the INFERRED fallback, used only when no suspend announcement
 * arrived: a machine whose pre-suspend beat was lost, or one running a host too
 * old to send one. The directory's own online window is 90 seconds, so this
 * window effectively covers roughly 90 s to 10 min of silence.
 *
 * Ten minutes is chosen because the two failure modes are asymmetric. Calling a
 * genuinely-crashed machine "asleep" for a few extra minutes costs the user
 * nothing — both mean "you cannot reach it right now". Calling a sleeping
 * machine "offline" tells the user their machine is gone when it will wake up
 * fine, which is the more alarming and more wrong of the two. Past ten minutes
 * the honest answer becomes "we do not know", which is what `offline` means.
 */
export const MACHINE_SLEEP_INFERENCE_WINDOW_MS = 10 * 60_000;

/**
 * The account directory's flattened, fully-nullable wire shape for power.
 *
 * Every field is independently nullable because the Worker degrades a
 * malformed value to null rather than rejecting the whole machine record, and
 * because a host too old to report power omits all of them.
 */
export type MachinePowerRecord = {
  batteryPercent: number | null;
  charging: boolean | null;
  onExternalPower: boolean | null;
};

/** Everything a host publishes about its own power on a heartbeat. */
export type MachinePowerPublication = {
  power: MachinePowerRecord | null;
  sleepState: MachineSleepState | null;
  /** Epoch ms at which `sleepState` last changed. */
  sleepStateAt: number | null;
};

/** True when `percent` is a value we are willing to show a user. */
export function isValidBatteryPercent(percent: unknown): percent is number {
  return typeof percent === "number"
    && Number.isFinite(percent)
    && percent >= 0
    && percent <= 100;
}

/** Clamp a raw platform reading to a whole 0-100 percent, or null if unusable. */
export function normalizeBatteryPercent(percent: unknown): number | null {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  return Math.min(100, Math.max(0, Math.round(percent)));
}

/** Flatten local power state into the directory's wire shape. */
export function toMachinePowerRecord(power: MachinePower | null): MachinePowerRecord | null {
  if (!power) return null;
  return {
    batteryPercent: power.battery ? power.battery.percent : null,
    charging: power.battery ? power.battery.charging : null,
    onExternalPower: power.onExternalPower,
  };
}

/**
 * Rebuild local power state from the directory's wire shape.
 *
 * A record whose `batteryPercent` is null describes a machine with no battery,
 * so `battery` comes back absent rather than zeroed.
 */
export function fromMachinePowerRecord(record: MachinePowerRecord | null): MachinePower | null {
  if (!record) return null;
  const percent = isValidBatteryPercent(record.batteryPercent) ? record.batteryPercent : null;
  return {
    ...(percent === null
      ? {}
      : { battery: { percent, charging: record.charging === true } }),
    onExternalPower: record.onExternalPower !== false,
  };
}

export type ResolveMachinePresenceInput = {
  /** We hold a live channel to this machine right now. */
  connected: boolean;
  /** The account directory considers it inside the online window. */
  online: boolean;
  /** The machine's own last announcement, when it made one. */
  sleepState: MachineSleepState | null | undefined;
  /**
   * Epoch ms at which that announcement was made. Absent for a record stored
   * before the stamp existed — and read as STALE, because an announcement that
   * cannot be dated cannot be aged out, and an `asleep` that outranks
   * `connected` forever is the failure this whole gate exists to prevent.
   */
  sleepStateAt?: number | null | undefined;
  /** Epoch ms of its last directory heartbeat. */
  lastSeenAt: number | null | undefined;
  /** Injectable clock; defaults to `Date.now()`. */
  now?: number;
};

/**
 * Whether an `asleep` announcement is old enough to stop being treated as fact.
 *
 * The directory coalesces `sleep_state` forward on every heartbeat so a dropped
 * field cannot blank it — correct, but it means the column has no path back to
 * NULL. A machine that slept once and is then downgraded to a build that omits
 * `sleepState` heartbeats forever with a stored `asleep`, and since `asleep`
 * outranks `connected`, every client would show a reachable machine as Asleep
 * with no way back. The same shape appears locally when a host's resume
 * announcement is lost.
 *
 * Aging the announcement is what closes both: past the window ADE already uses
 * to stop inferring sleep from silence, "asleep" is a claim nothing has
 * confirmed, and the machine's live signals get to speak instead. A stamp in
 * the future is clock skew, not staleness.
 *
 * An announcement with NO stamp is stale. It cannot be dated, so it is not
 * evidence — and honouring it is precisely what reintroduces the unrecoverable
 * stuck-`asleep` state this gate exists to prevent. `syncSleepAnnouncementIsStale`
 * in `apps/ios/ADE/Services/SyncMachineWake.swift` is the authoritative twin of
 * this function, down to the inclusive boundary; the two must not drift.
 */
function sleepAnnouncementIsStale(
  sleepStateAt: number | null | undefined,
  now: number,
): boolean {
  if (typeof sleepStateAt !== "number" || !Number.isFinite(sleepStateAt)) return true;
  return now - sleepStateAt >= MACHINE_SLEEP_INFERENCE_WINDOW_MS;
}

/**
 * The single place presence is decided, so a phone, the desktop, and the CLI
 * cannot disagree about whether a machine is awake.
 *
 * An announced suspend deliberately outranks `connected`. That ordering IS the
 * bug fix: a channel to a sleeping machine does not report itself closed — the
 * socket simply stops answering, and every layer above keeps rendering the last
 * thing it believed. The machine's own "I am going to sleep now", sent while it
 * could still speak, is better evidence than a connection flag that has not yet
 * discovered otherwise.
 *
 * That ordering is only safe because the announcement is aged. A resume
 * normally publishes `awake` at once, but nothing GUARANTEES the resume half
 * arrives — a lost hop, or a downgrade to a build that no longer sends
 * `sleepState` at all, both leave the stored `asleep` with nothing to clear it.
 * `sleepAnnouncementIsStale` is what keeps that from outranking `connected`
 * forever.
 */
export function resolveMachinePresence(input: ResolveMachinePresenceInput): MachinePresence {
  const now = input.now ?? Date.now();
  if (input.sleepState === "asleep" && !sleepAnnouncementIsStale(input.sleepStateAt, now)) {
    return "asleep";
  }
  if (input.connected) return "connected";
  if (input.online) return "online";
  const lastSeenAt = input.lastSeenAt;
  if (typeof lastSeenAt === "number" && Number.isFinite(lastSeenAt)) {
    const silentMs = now - lastSeenAt;
    // A clock skew that puts the heartbeat in the future is still a recent
    // heartbeat, not a reason to call the machine gone.
    if (silentMs < MACHINE_SLEEP_INFERENCE_WINDOW_MS) return "asleep";
  }
  return "offline";
}
