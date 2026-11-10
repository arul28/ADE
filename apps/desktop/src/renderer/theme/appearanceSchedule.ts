import { captureError } from "../../shared/sentry/capture";
import { normalizeScenePreferences, type ScenePreferences } from "../scene/scenePreferences";
import {
  normalizeInterfacePreferences,
  type InterfaceMonoFont,
  type InterfacePreferences,
  type InterfaceSansFont,
} from "../state/appearanceStore";

/**
 * Appearance schedule: whole looks (theme, mode, background, fonts) that take
 * over at set times of day on this computer.
 *
 * The day is cut at each slot's start time; a slot runs until the next one
 * starts, and the last wraps past midnight to the first. Start times are the
 * only thing stored, so slots can never overlap or leave a gap.
 *
 * The schedule writes the ordinary appearance preferences when a slot begins,
 * so everything that paints the app keeps reading one set of values. A change
 * made by hand afterwards holds until the next slot begins: `lastApplied`
 * remembers which slot start was applied, and a slot is applied once per start.
 *
 * Per machine and never synced: a schedule is about the room the computer is
 * in. It has its own storage key, read fresh on every check, so several
 * windows agree on what was applied.
 */

export type ScheduledLook = {
  themeId: string;
  followsSystem: boolean;
  scene: ScenePreferences;
  sansFont: InterfaceSansFont;
  monoFont: InterfaceMonoFont;
};

export type ScheduleSlot = {
  id: string;
  /** Minutes after local midnight, 0–1439. Unique within a schedule. */
  start: number;
  /** What the user calls it; empty means the part of the day it starts in. */
  name: string;
  look: ScheduledLook;
};

export type AppearanceSchedule = {
  enabled: boolean;
  /** Sorted by `start`. */
  slots: ScheduleSlot[];
  /** The slot start last applied: which slot, and the moment it began. */
  lastApplied: { slotId: string; at: number } | null;
};

export const APPEARANCE_SCHEDULE_STORAGE_KEY = "ade.appearanceSchedule.v1";
export const MINUTES_PER_DAY = 24 * 60;
export const MAX_SCHEDULE_SLOTS = 8;
export const MAX_SLOT_NAME = 24;

export const EMPTY_APPEARANCE_SCHEDULE: AppearanceSchedule = { enabled: false, slots: [], lastApplied: null };

function normalizeLook(value: unknown): ScheduledLook | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const themeId = typeof raw.themeId === "string" ? raw.themeId.trim() : "";
  if (!themeId) return null;
  // Fonts read like the interface preferences they become; the scene keeps its
  // own revision, and a stale one reads as this client's default.
  const { sansFont, monoFont } = normalizeInterfacePreferences(raw);
  return { themeId, followsSystem: raw.followsSystem === true, scene: normalizeScenePreferences(raw.scene), sansFont, monoFont };
}

/** The look a set of appearance preferences puts on screen. */
export function lookFromState(state: {
  themeId: string;
  themeFollowsSystem: boolean;
  interfacePreferences: Pick<InterfacePreferences, "scene" | "sansFont" | "monoFont">;
}): ScheduledLook {
  const { scene, sansFont, monoFont } = state.interfacePreferences;
  return { themeId: state.themeId, followsSystem: state.themeFollowsSystem, scene, sansFont, monoFont };
}

/** Two looks are the same on screen. Shuffle's pool and similar fine print do not count. */
export function sameLook(a: ScheduledLook, b: ScheduledLook): boolean {
  const sa = a.scene;
  const sb = b.scene;
  return (
    a.themeId === b.themeId &&
    a.followsSystem === b.followsSystem &&
    a.sansFont === b.sansFont &&
    a.monoFont === b.monoFont &&
    sa.mode === sb.mode &&
    (sa.mode !== "image" || sa.imageId === sb.imageId) &&
    sa.showImage === sb.showImage &&
    sa.texture === sb.texture &&
    sa.dim === sb.dim &&
    sa.matchTheme === sb.matchTheme
  );
}

export function normalizeAppearanceSchedule(value: unknown): AppearanceSchedule {
  if (!value || typeof value !== "object") return EMPTY_APPEARANCE_SCHEDULE;
  const raw = value as Record<string, unknown>;
  const seen = new Set<number>();
  const slots: ScheduleSlot[] = [];
  for (const entry of Array.isArray(raw.slots) ? raw.slots : []) {
    if (!entry || typeof entry !== "object") continue;
    const slot = entry as Record<string, unknown>;
    const start = typeof slot.start === "number" && Number.isFinite(slot.start) ? Math.round(slot.start) : NaN;
    const look = normalizeLook(slot.look);
    const id = typeof slot.id === "string" && slot.id ? slot.id : null;
    if (!id || !look || !(start >= 0 && start < MINUTES_PER_DAY) || seen.has(start)) continue;
    seen.add(start);
    const name = typeof slot.name === "string" ? slot.name.trim().slice(0, MAX_SLOT_NAME) : "";
    slots.push({ id, start, name, look });
  }
  slots.sort((a, b) => a.start - b.start);
  const last = raw.lastApplied as Record<string, unknown> | null | undefined;
  const lastApplied =
    last && typeof last.slotId === "string" && typeof last.at === "number" && Number.isFinite(last.at)
      ? { slotId: last.slotId, at: last.at }
      : null;
  return { enabled: raw.enabled === true, slots: slots.slice(0, MAX_SCHEDULE_SLOTS), lastApplied };
}

/* ── time ───────────────────────────────────────────────────────────── */

/** The moment `minutes` after local midnight falls on the day of `day` (DST-safe: local clock time). */
function atMinutes(day: Date, minutes: number): number {
  const at = new Date(day);
  at.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return at.getTime();
}

function shiftDays(day: Date, days: number): Date {
  const next = new Date(day);
  next.setDate(next.getDate() + days);
  return next;
}

export type ActiveSlot = {
  slot: ScheduleSlot;
  /** When this run of the slot began (today or, past midnight, yesterday). */
  startedAt: number;
  /** When the next slot takes over. */
  endsAt: number;
  next: ScheduleSlot;
};

/** The slot in charge at `now`, or null for an empty schedule. */
export function activeSlotAt(slots: readonly ScheduleSlot[], now: number): ActiveSlot | null {
  if (slots.length === 0) return null;
  const date = new Date(now);
  const minutes = date.getHours() * 60 + date.getMinutes();
  let index = -1;
  for (let i = 0; i < slots.length; i += 1) if (slots[i]!.start <= minutes) index = i;
  // Before the first start of the day, yesterday's last slot is still running.
  const startedToday = index >= 0;
  const slot = startedToday ? slots[index]! : slots[slots.length - 1]!;
  const slotIndex = startedToday ? index : slots.length - 1;
  const startDay = startedToday ? date : shiftDays(date, -1);
  const startedAt = atMinutes(startDay, slot.start);
  const next = slots[(slotIndex + 1) % slots.length]!;
  // The next start falls on the day the slot started, or the day after when the order wraps
  // (one slot wraps to itself). Decided by the slot order, not by comparing timestamps: on a
  // spring-forward night a start in the skipped hour moves forward, and that shift must not
  // push the next start into tomorrow.
  const wraps = slotIndex === slots.length - 1;
  const endsAt = atMinutes(wraps ? shiftDays(startDay, 1) : startDay, next.start);
  return { slot, startedAt, endsAt, next };
}

/**
 * The slot to apply now, or null when the one in charge was already applied
 * (a change by hand since then holds). A different slot id than the last one
 * applied is always due: the clock moved, a time zone changed, or the slot
 * that was applied is gone.
 */
export function dueSlot(schedule: AppearanceSchedule, now: number): ActiveSlot | null {
  if (!schedule.enabled) return null;
  const active = activeSlotAt(schedule.slots, now);
  if (!active) return null;
  const last = schedule.lastApplied;
  if (last && last.slotId === active.slot.id && last.at >= active.startedAt) return null;
  return active;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** `sameLook`, and every setting a slot saves the same too, the shuffle's included. */
export function sameSavedLook(a: ScheduledLook, b: ScheduledLook): boolean {
  return (
    sameLook(a, b) &&
    a.scene.shuffleEvery === b.scene.shuffleEvery &&
    sameList(a.scene.shuffleExclude, b.scene.shuffleExclude) &&
    sameList(a.scene.shuffleInclude, b.scene.shuffleInclude)
  );
}

/**
 * `schedule` with slot `id` starting at `start`. Moving a time is not a new
 * start: when the slot on screen stays in charge, it stays applied, so a
 * change made by hand still holds.
 */
export function withSlotStart(schedule: AppearanceSchedule, id: string, start: number, now: number): AppearanceSchedule {
  const before = activeSlotAt(schedule.slots, now);
  const held = before != null && dueSlot(schedule, now) == null;
  const slots = schedule.slots
    .map((slot) => (slot.id === id ? { ...slot, start } : slot))
    .sort((a, b) => a.start - b.start);
  const after = activeSlotAt(slots, now);
  const lastApplied =
    held && after && after.slot.id === before.slot.id ? { slotId: after.slot.id, at: after.startedAt } : schedule.lastApplied;
  return { ...schedule, slots, lastApplied };
}

/** "08:00" for 480. */
export function formatSlotTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 480 for "08:00", null for anything that is not a time of day. */
export function parseSlotTime(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

/** "8:00 AM" or "08:00", as this computer writes times. */
export function formatSlotClock(minutes: number): string {
  const at = new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60);
  try {
    return at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch (error) {
    reportFallback("format-clock", error);
    return formatSlotTime(minutes);
  }
}

/** The slot's own name, else the part of the day it starts in. */
export function slotLabel(slot: Pick<ScheduleSlot, "name" | "start">): string {
  return slot.name || slotDayPart(slot.start);
}

/** A short name for the part of the day a slot starts in. */
export function slotDayPart(minutes: number): "Morning" | "Day" | "Evening" | "Night" {
  if (minutes >= 5 * 60 && minutes < 11 * 60) return "Morning";
  if (minutes >= 11 * 60 && minutes < 17 * 60) return "Day";
  if (minutes >= 17 * 60 && minutes < 21 * 60) return "Evening";
  return "Night";
}

/* ── storage ────────────────────────────────────────────────────────── */

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached: AppearanceSchedule = EMPTY_APPEARANCE_SCHEDULE;

const reportedFailures = new Set<string>();

/** A fallback that hides a failure is reported once per area: reads run on every render and poll. */
function reportFallback(area: string, error: unknown): void {
  if (reportedFailures.has(area)) return;
  reportedFailures.add(area);
  captureError(error, { tags: { area: `appearance-schedule.${area}` }, fingerprint: [`appearance-schedule.${area}`], handled: true });
}

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(APPEARANCE_SCHEDULE_STORAGE_KEY);
  } catch (error) {
    // Unreadable storage reads as no schedule.
    reportFallback("storage-read", error);
    return null;
  }
}

export function readAppearanceSchedule(): AppearanceSchedule {
  const raw = readRaw();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    try {
      cached = raw ? normalizeAppearanceSchedule(JSON.parse(raw)) : EMPTY_APPEARANCE_SCHEDULE;
    } catch (error) {
      reportFallback("storage-parse", error);
      cached = EMPTY_APPEARANCE_SCHEDULE;
    }
  }
  return cached;
}

export function writeAppearanceSchedule(next: AppearanceSchedule): void {
  const normalized = normalizeAppearanceSchedule(next);
  try {
    window.localStorage.setItem(APPEARANCE_SCHEDULE_STORAGE_KEY, JSON.stringify(normalized));
  } catch (error) {
    // Kept for this window: reads keep the copy while storage still holds the old raw value.
    console.warn("[appearance-schedule] could not save the schedule", error);
    cachedRaw = readRaw();
    cached = normalized;
  }
  for (const listener of listeners) listener();
}

export function updateAppearanceSchedule(change: (prev: AppearanceSchedule) => AppearanceSchedule): void {
  writeAppearanceSchedule(change(readAppearanceSchedule()));
}

/** For `useSyncExternalStore`: this window's writes and other windows' (the `storage` event). */
export function subscribeAppearanceSchedule(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === APPEARANCE_SCHEDULE_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Record that `active` was applied, so a change by hand holds until the next slot. */
export function markSlotApplied(active: Pick<ActiveSlot, "slot" | "startedAt">): void {
  updateAppearanceSchedule((prev) => ({ ...prev, lastApplied: { slotId: active.slot.id, at: active.startedAt } }));
}

export function newSlotId(): string {
  return `slot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
