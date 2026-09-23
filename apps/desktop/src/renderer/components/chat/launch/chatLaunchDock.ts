/**
 * T3-style composer dock for a foreground new-lane launch.
 *
 * The draft composer sits centered on the empty Work surface; the chat it
 * launches docks its composer at the bottom of the thread. Right before the
 * Work view switches to the new chat, the launching pane stashes the draft
 * composer's rect here (keyed by the new chat's session id). When the chat pane
 * mounts with its docked composer it takes that rect and plays a FLIP
 * translate from the old position to the new one, so the composer visibly
 * glides into place instead of the whole surface cross-fading.
 *
 * Everything here is synchronous: nothing awaits between Send and the switch.
 */

export type ComposerDockRect = { left: number; top: number; width: number; height: number };

const DOCK_STASH_TTL_MS = 1_500;
export const COMPOSER_DOCK_DURATION_MS = 340;
export const COMPOSER_DOCK_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";

const pendingDocks = new Map<string, { rect: ComposerDockRect; stashedAtMs: number }>();

function sweep(nowMs: number): void {
  for (const [sessionId, entry] of pendingDocks) {
    if (nowMs - entry.stashedAtMs > DOCK_STASH_TTL_MS) pendingDocks.delete(sessionId);
  }
}

export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Measure the draft composer and remember it for the session about to open. */
export function stashComposerDockOrigin(sessionId: string, element: Element | null | undefined): void {
  if (!element || typeof element.getBoundingClientRect !== "function") return;
  const rect = element.getBoundingClientRect();
  if (!(rect.width > 0 && rect.height > 0)) return;
  const nowMs = Date.now();
  sweep(nowMs);
  pendingDocks.set(sessionId, {
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    stashedAtMs: nowMs,
  });
}

/** True while a dock is waiting for this session's pane (drives the Work area's no-blur switch). */
export function hasPendingComposerDock(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  const entry = pendingDocks.get(sessionId);
  if (!entry) return false;
  if (Date.now() - entry.stashedAtMs > DOCK_STASH_TTL_MS) {
    pendingDocks.delete(sessionId);
    return false;
  }
  return true;
}

export function takeComposerDockOrigin(sessionId: string | null | undefined): ComposerDockRect | null {
  if (!sessionId || !hasPendingComposerDock(sessionId)) return null;
  const entry = pendingDocks.get(sessionId) ?? null;
  pendingDocks.delete(sessionId);
  return entry?.rect ?? null;
}

/**
 * FLIP the docked composer from where the draft composer was. Bottom edges and
 * horizontal centers are aligned, which reads as the same box gliding down;
 * width is not scaled because scaling a text field smears its glyphs.
 */
export function playComposerDock(element: HTMLElement | null, from: ComposerDockRect | null): Animation | null {
  if (!element || !from || prefersReducedMotion()) return null;
  if (typeof element.animate !== "function") return null;
  const to = element.getBoundingClientRect();
  if (!(to.width > 0 && to.height > 0)) return null;
  const dx = (from.left + from.width / 2) - (to.left + to.width / 2);
  const dy = (from.top + from.height) - (to.top + to.height);
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return null;
  try {
    return element.animate(
      [
        { transform: `translate(${dx}px, ${dy}px)` },
        { transform: "translate(0px, 0px)" },
      ],
      { duration: COMPOSER_DOCK_DURATION_MS, easing: COMPOSER_DOCK_EASING },
    );
  } catch {
    return null;
  }
}
