import { useCallback, useRef } from "react";

/**
 * Is a surface (a Work tool, a chat drawer) really on screen?
 *
 * `ade ui show` must not answer "shown" for a surface the user cannot see.
 * Writing "open the Apple tool" into the store is only a request: the tools
 * pane slides open on an animation, the tool mounts a commit later, and in a
 * window that is hidden or on another Space the animation never runs at all
 * (the pane stayed 19px wide in the 2026-09-23 repro). So a show waits for the
 * surface's own element to mount, its pane to have real width, and the window
 * to be visible — and says so only then.
 */

const mounted = new Map<string, Set<Element>>();

/**
 * One surface on one machine. `id` is the lane for a Work tool and the chat for
 * a chat drawer; the machine is `workRuntimeScopeKey`, because two machines can
 * each have a lane with the same id.
 */
export function workSurfaceKey(surface: string, scopeKey: string, id: string | null): string {
  return `${surface}\u0000${scopeKey}\u0000${id ?? ""}`;
}

/** Called with the surface's element on mount; the return value is its unmount. */
export function noteWorkSurfaceMounted(key: string, element: Element): () => void {
  const elements = mounted.get(key) ?? new Set<Element>();
  elements.add(element);
  mounted.set(key, elements);
  return () => {
    elements.delete(element);
    if (elements.size === 0 && mounted.get(key) === elements) mounted.delete(key);
  };
}

/** A ref that registers its element under `key` while it is mounted. */
export function useWorkSurfaceMountRef<T extends Element>(key: string | null): (element: T | null) => void {
  const releaseRef = useRef<(() => void) | null>(null);
  return useCallback((element: T | null) => {
    releaseRef.current?.();
    releaseRef.current = key && element ? noteWorkSurfaceMounted(key, element) : null;
  }, [key]);
}

export function isWorkSurfaceMounted(key: string): boolean {
  return (mounted.get(key)?.size ?? 0) > 0;
}

/** The window is showing, so anything laid out in it can be seen. */
export function isDocumentVisible(): boolean {
  if (documentVisibleOverride !== null) return documentVisibleOverride;
  return typeof document !== "undefined" && document.visibilityState === "visible";
}

let documentVisibleOverride: boolean | null = null;

/** Test seam: jsdom's visibility is not the thing under test. */
export function setDocumentVisibleForTests(visible: boolean | null): void {
  documentVisibleOverride = visible;
}

/** Narrower than this and the pane is still sliding open, or stuck closed. */
const MIN_VISIBLE_PANE_WIDTH_PX = 160;

/**
 * Measured on the tools pane that holds the element when there is one: a tool
 * inside a pane that is a sliver wide can still report its own full width.
 */
function laidOut(element: Element): boolean {
  const box = element.closest("[data-work-sidebar-pane]") ?? element;
  return box.getBoundingClientRect().width >= MIN_VISIBLE_PANE_WIDTH_PX;
}

export function isWorkSurfaceOnScreen(key: string): boolean {
  if (!isDocumentVisible()) return false;
  for (const element of mounted.get(key) ?? []) {
    if (element.isConnected && laidOut(element)) return true;
  }
  return false;
}

/**
 * Resolve true once the surface is on screen, or false after `timeoutMs`.
 * Timers, not animation frames: a hidden window runs no frames, and that is
 * exactly the case that has to end in false rather than hang.
 */
export function waitForWorkSurfaceOnScreen(
  key: string,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 3_000;
  const intervalMs = options.intervalMs ?? 100;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const check = () => {
      if (isWorkSurfaceOnScreen(key)) {
        resolve(true);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

/** Test seam. */
export function resetWorkToolOnScreenForTests(): void {
  mounted.clear();
  documentVisibleOverride = null;
}
