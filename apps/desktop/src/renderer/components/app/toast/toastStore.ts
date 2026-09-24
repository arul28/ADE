import { useSyncExternalStore } from "react";
import type { NoticeTone } from "../../ui/notice/noticeTones";
import type { ToastCardAction, ToastCardModel, ToastChip } from "../../ui/notice/ToastCard";

/**
 * ADE's one toast store. Every bottom-right notice — lane events, PR
 * notifications, auto-link undo, the idle-sessions nudge, batch launches —
 * goes through `showToast` and renders as the shared `ToastCard` in
 * `ToastStack`. Timers (auto-dismiss + hover pause/resume) live in the store so
 * rendering components stay dumb.
 */

export type ToastTone = NoticeTone;

export type { ToastCardAction, ToastChip };

/**
 * A toast is a `ToastCardModel` plus the store's own bookkeeping, so the stack
 * hands it to `ToastCard` as-is. `actions` are pill buttons (the first is the
 * primary); an action dismisses the toast unless it sets `keepOpen`.
 */
export type ToastInput = Omit<ToastCardModel, "tone" | "title"> & {
  id?: string;
  title: string;
  /** Defaults to "info". */
  tone?: ToastTone;
  /** Runs when the user closes the toast with × (not on auto-dismiss). */
  onClose?: () => void;
  /**
   * Auto-dismiss delay; <= 0 or non-finite keeps the toast until dismissed.
   * Sticky toasts outlive timed ones when the stack is over its cap.
   */
  durationMs?: number;
  /**
   * Fires once `ToastStack` has actually committed this toast to the DOM.
   *
   * Queueing a toast is not the same as showing one: `showToast` only mutates
   * this module, and React has not rendered anything at the point it returns. A
   * caller that has to state truthfully that the user was shown something —
   * `useAutoDiagnosticsToast`, which tells main it may stop offering a notice —
   * has to wait for the commit, so the render path reports it rather than the
   * queue path guessing. Re-fires when a toast is replaced in place with a new
   * callback, which is what makes a repeated notice acknowledge again.
   */
  onRendered?: () => void;
};

export type Toast = Omit<ToastInput, "id" | "tone" | "durationMs"> & {
  id: string;
  tone: ToastTone;
  durationMs: number;
};

/** Merge-patch shape for {@link updateToast}. */
export type ToastPatch = Partial<Omit<ToastInput, "id">>;

const DEFAULT_DURATION_MS = 6000;
const MAX_TOASTS = 5;

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

function isSticky(toast: Toast): boolean {
  return !Number.isFinite(toast.durationMs) || toast.durationMs <= 0;
}

/**
 * Which toast to drop when the stack is over its cap: the oldest one that would
 * time out anyway. Sticky toasts (live progress, "N sessions idle", an undo that
 * waits for an answer) only go when every toast is sticky, so a burst of
 * "Lane created" events cannot push them off screen.
 */
function oldestEvictableIndex(stack: readonly Toast[]): number {
  const timed = stack.findIndex((t) => !isSticky(t));
  return timed >= 0 ? timed : 0;
}

/**
 * Show a toast, or replace an in-place one when `id` matches an existing toast
 * (keeping its stack position). Returns the toast id.
 */
export function showToast(input: ToastInput): string {
  const id = input.id ?? generateId();
  const durationMs = input.durationMs ?? DEFAULT_DURATION_MS;
  const toast: Toast = {
    ...input,
    id,
    tone: input.tone ?? "info",
    durationMs,
  };

  const existingIndex = toasts.findIndex((t) => t.id === id);
  if (existingIndex >= 0) {
    const next = toasts.slice();
    next[existingIndex] = toast;
    toasts = next;
  } else {
    const next = [...toasts, toast];
    while (next.length > MAX_TOASTS) {
      const [dropped] = next.splice(oldestEvictableIndex(next), 1);
      clearTimer(dropped.id);
      timers.delete(dropped.id);
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
