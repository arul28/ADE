import { useEffect, useState, useSyncExternalStore } from "react";
import type { OpenProjectBinding } from "../../shared/types";
import { CLOUD_PHONE_IDLE_SECONDS, type CloudPhoneStatusView } from "../../shared/cloudPhone";

/*
 * The account's ADE Cloud iPhone as this window last read it, shared by every
 * surface that shows it (the tools pane, the top bar). The phone is one per
 * account, so any brain's read is the same phone; each read is published here
 * and every surface follows the newest.
 *
 * Idle: NoMac stops a phone after `CLOUD_PHONE_IDLE_SECONDS` with no tool call
 * or person's input. The brain reports its own last call (`lastActivityAt`);
 * this window adds the person's last input in the pane. Another machine's
 * agent may also be using the phone, so the countdown is the earliest the
 * phone can stop, never a promise it will.
 */

export type CloudPhoneLive = {
  status: CloudPhoneStatusView | null;
  /** When `status` was read (ms). */
  readAt: number;
  /** The person's last input in this window's pane, for the live phone (ms). */
  inputAt: number | null;
};

let live: CloudPhoneLive = { status: null, readAt: 0, inputAt: null };
const listeners = new Set<() => void>();

function emit(next: CloudPhoneLive) {
  live = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const read = (): CloudPhoneLive => live;

/** A read of `cloud_phone.getStatus`, from any surface. A new phone forgets the old one's input. */
export function publishCloudPhoneStatus(status: CloudPhoneStatusView, readAt = Date.now()) {
  if (readAt < live.readAt) return;
  const samePhone = live.status?.phone?.id != null && live.status.phone.id === status.phone?.id;
  emit({ status, readAt, inputAt: samePhone ? live.inputAt : null });
}

/** The person touched the live phone in this window. Throttled: input arrives per pointer move. */
export function noteCloudPhoneInput(now = Date.now()) {
  if (live.inputAt != null && now - live.inputAt < 1_000) return;
  emit({ ...live, inputAt: now });
}

export function useCloudPhoneLive(): CloudPhoneLive {
  return useSyncExternalStore(subscribe, read, read);
}

/** Whether a phone runs or starts now, as last read. */
export function cloudPhoneIsUp(value: CloudPhoneLive): boolean {
  const state = value.status?.phone?.state;
  return state === "ready" || state === "starting";
}

/**
 * When the phone stops by itself with nothing more done, as this window knows
 * it: idle from the later of the brain's last call and this pane's input,
 * capped at the phone's time limit. Null while it starts or nothing is known.
 */
export function cloudPhoneIdleStopAt(value: CloudPhoneLive): number | null {
  const phone = value.status?.phone;
  if (!phone || phone.state !== "ready") return null;
  const last = Math.max(value.status?.lastActivityAt ?? 0, value.inputAt ?? 0, phone.readyAt ?? 0);
  return last > 0 ? last + CLOUD_PHONE_IDLE_SECONDS * 1_000 : null;
}

/** "1:05" / "12 min": a short time span for the strip and the top bar. */
export function formatPhoneSpan(ms: number, precise: boolean): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (precise || seconds < 60) return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * The plan's minutes left now: the read's count, less the time the phone has
 * run since that read (the server counts a running phone's minutes as it goes).
 */
export function cloudPhoneMinutesLeft(value: CloudPhoneLive, now: number): number | null {
  const minutes = value.status?.minutes;
  if (!minutes) return null;
  const running = value.status?.phone?.state === "ready" ? Math.floor((now - value.readAt) / 60_000) : 0;
  return Math.max(0, minutes.left - Math.max(0, running));
}

/**
 * A clock for the strip and the top bar: `now`, ticking only while `active`
 * and the window is visible. `fastMs` while `fast` (a countdown's last
 * stretch), else `slowMs`.
 */
export function usePhoneClock(active: boolean, fast: boolean, slowMs = 15_000, fastMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    let timer: number | undefined;
    const tick = () => {
      if (document.visibilityState === "visible") setNow(Date.now());
      timer = window.setTimeout(tick, fast ? fastMs : slowMs);
    };
    setNow(Date.now());
    timer = window.setTimeout(tick, fast ? fastMs : slowMs);
    const onVisible = () => { if (document.visibilityState === "visible") setNow(Date.now()); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, fast, fastMs, slowMs, setNow]);
  return now;
}

/*
 * The top bar's own reads, for a phone no pane in this window watches: once
 * when it mounts, when the window comes back to the front (at most every
 * 15 s), every 30 s while a phone runs (to see it end), and every 2 minutes
 * while the account has the phone and none runs (an agent may start one).
 * Nothing at all while the window is hidden, nor for an account without the
 * phone (read again on focus at most every 10 minutes).
 */
const UP_READ_MS = 30_000;
const DOWN_READ_MS = 2 * 60_000;
const NO_ACCESS_READ_MS = 10 * 60_000;
const FOCUS_READ_MIN_MS = 15_000;

export function useCloudPhoneBackgroundReads(pin: OpenProjectBinding | null, enabled: boolean) {
  const value = useCloudPhoneLive();
  const up = cloudPhoneIsUp(value);
  const access = value.status?.access ?? null;
  const pinKey = pin?.key ?? null;
  useEffect(() => {
    const api = typeof window === "undefined" ? undefined : window.ade?.cloudPhone;
    if (!enabled || typeof api?.status !== "function") return undefined;
    let cancelled = false;
    let inFlight = false;
    const readNow = () => {
      if (inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      const startedAt = Date.now();
      api.status(pin).then(
        (status) => { if (!cancelled) publishCloudPhoneStatus(status, startedAt); },
        () => { /* signed out, an older brain, offline: the icon keeps what it had */ },
      ).finally(() => { inFlight = false; });
    };
    const cadence = up ? UP_READ_MS : access === "on" ? DOWN_READ_MS : NO_ACCESS_READ_MS;
    // A read newer than the cadence (a pane's) stands in for this one.
    if (Date.now() - read().readAt >= Math.min(cadence, FOCUS_READ_MIN_MS)) readNow();
    const timer = window.setInterval(() => {
      if (Date.now() - read().readAt >= cadence - 1_000) readNow();
    }, cadence);
    const onFocus = () => {
      if (Date.now() - read().readAt >= (access === "on" || up ? FOCUS_READ_MIN_MS : NO_ACCESS_READ_MS)) readNow();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
    // The pin object can be rebuilt with the same key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, pinKey, up, access]);
}
