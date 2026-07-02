import { useSyncExternalStore } from "react";

/**
 * Reusable, renderer-only toast store. Bespoke bottom-right notices in
 * `AppShell` (PR notifications, auto-link, remote/stale banners) predate this
 * and are intentionally left alone; this is the shared primitive new product
 * code should push through. Timers (auto-dismiss + hover pause/resume) live in
 * the store so rendering components stay dumb; see `ToastStack`.
 */

export type ToastTone = "info" | "success" | "error";

export type ToastAction = {
  label: string;
  onClick: () => void;
};

export type ToastInput = {
  id?: string;
  title: string;
  message?: string;
  tone?: ToastTone;
  /** CSS color for the small lane dot rendered before the title. */
  colorDot?: string;
  action?: ToastAction;
  /** Auto-dismiss delay; <= 0 or non-finite keeps the toast until dismissed. */
  durationMs?: number;
};

export type Toast = {
  id: string;
  title: string;
  message?: string;
  tone: ToastTone;
  colorDot?: string;
  action?: ToastAction;
  durationMs: number;
};

/** Merge-patch shape for {@link updateToast}. */
export type ToastPatch = Partial<Omit<ToastInput, "id">>;

const DEFAULT_DURATION_MS = 6000;
const MAX_TOASTS = 4;

type TimerEntry = {
  handle: ReturnType<typeof setTimeout> | null;
  /** Time left on the current countdown; the full duration while running. */
  remaining: number;
  /** `Date.now()` when the current run started (for elapsed math on pause). */
  startedAt: number;
  paused: boolean;
};

// Ordered oldest -> newest. `ToastStack` renders in array order inside a
// bottom-anchored flex column, so the newest toast sits closest to the corner.
let toasts: Toast[] = [];
const listeners = new Set<() => void>();
const timers = new Map<string, TimerEntry>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Toast[] {
  return toasts;
}

function generateId(): string {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function clearTimer(id: string): void {
  const entry = timers.get(id);
  if (entry?.handle != null) clearTimeout(entry.handle);
}

/** (Re)arm the auto-dismiss countdown for a toast, clearing any prior timer. */
function scheduleTimer(id: string, durationMs: number): void {
  clearTimer(id);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    timers.delete(id);
    return;
  }
  const handle = setTimeout(() => dismissToast(id), durationMs);
  timers.set(id, {
    handle,
    remaining: durationMs,
    startedAt: Date.now(),
    paused: false,
  });
}

/**
 * Show a toast, or replace an in-place one when `id` matches an existing toast
 * (keeping its stack position). Returns the toast id.
 */
export function showToast(input: ToastInput): string {
  const id = input.id ?? generateId();
  const durationMs = input.durationMs ?? DEFAULT_DURATION_MS;
  const toast: Toast = {
    id,
    title: input.title,
    message: input.message,
    tone: input.tone ?? "info",
    colorDot: input.colorDot,
    action: input.action,
    durationMs,
  };

  const existingIndex = toasts.findIndex((t) => t.id === id);
  if (existingIndex >= 0) {
    const next = toasts.slice();
    next[existingIndex] = toast;
    toasts = next;
  } else {
    let next = [...toasts, toast];
    if (next.length > MAX_TOASTS) {
      const dropCount = next.length - MAX_TOASTS;
      for (const dropped of next.slice(0, dropCount)) {
        clearTimer(dropped.id);
        timers.delete(dropped.id);
      }
      next = next.slice(dropCount);
    }
    toasts = next;
  }

  scheduleTimer(id, durationMs);
  emit();
  return id;
}

/**
 * Merge-patch an existing toast (no-op if unknown). Only resets the dismiss
 * timer when `durationMs` is part of the patch.
 */
export function updateToast(id: string, patch: ToastPatch): void {
  const index = toasts.findIndex((t) => t.id === id);
  if (index < 0) return;
  const next = toasts.slice();
  const merged: Toast = { ...next[index], ...patch };
  next[index] = merged;
  toasts = next;
  if (patch.durationMs !== undefined) {
    scheduleTimer(id, merged.durationMs);
  }
  emit();
}

export function dismissToast(id: string): void {
  clearTimer(id);
  timers.delete(id);
  const next = toasts.filter((t) => t.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

/** Freeze a toast's countdown (e.g. while hovered), recording time remaining. */
export function pauseToast(id: string): void {
  const entry = timers.get(id);
  if (!entry || entry.paused) return;
  if (entry.handle != null) clearTimeout(entry.handle);
  const elapsed = Date.now() - entry.startedAt;
  const remaining = Math.max(0, entry.remaining - elapsed);
  timers.set(id, { handle: null, remaining, startedAt: Date.now(), paused: true });
}

/** Resume a paused countdown from the remaining time recorded at pause. */
export function resumeToast(id: string): void {
  const entry = timers.get(id);
  if (!entry || !entry.paused) return;
  if (!Number.isFinite(entry.remaining) || entry.remaining <= 0) {
    dismissToast(id);
    return;
  }
  const handle = setTimeout(() => dismissToast(id), entry.remaining);
  timers.set(id, {
    handle,
    remaining: entry.remaining,
    startedAt: Date.now(),
    paused: false,
  });
}

/** Imperative read of the current toast stack (oldest -> newest). */
export function getToasts(): readonly Toast[] {
  return toasts;
}

/** Subscribe a component to the current toast stack. */
export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
