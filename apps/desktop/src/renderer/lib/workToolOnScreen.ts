/**
 * Is a Work tool really on screen?
 *
 * `ade ui show` must not answer "shown" for a surface the user cannot see.
 * Writing "open the Apple tool" into the store is only a request: the tools
 * pane slides open on an animation, the tool mounts a commit later, and in a
 * window that is hidden or on another Space the animation never runs at all
 * (the pane stayed 19px wide in the 2026-09-23 repro). So a show waits for
 * the tool itself to mount, the pane to have real width, and the window to be
 * visible — and says so only then.
 */

type ToolKey = string;

const mounted = new Map<ToolKey, number>();

function keyFor(tool: string, laneId: string | null): ToolKey {
  return `${tool}\u0000${laneId ?? ""}`;
}

/** Called by a tool panel on mount; the return value is its unmount. */
export function noteWorkToolMounted(tool: string, laneId: string | null): () => void {
  const key = keyFor(tool, laneId);
  mounted.set(key, (mounted.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (mounted.get(key) ?? 1) - 1;
    if (next > 0) mounted.set(key, next);
    else mounted.delete(key);
  };
}

export function isWorkToolMounted(tool: string, laneId: string | null): boolean {
  return (mounted.get(keyFor(tool, laneId)) ?? 0) > 0;
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

function defaultPaneVisible(): boolean {
  if (!isDocumentVisible()) return false;
  for (const pane of document.querySelectorAll<HTMLElement>("[data-work-sidebar-pane]")) {
    if (pane.getBoundingClientRect().width >= MIN_VISIBLE_PANE_WIDTH_PX) return true;
  }
  return false;
}

let paneVisibleProbe: () => boolean = defaultPaneVisible;

/** Test seam: jsdom lays nothing out, so a test says whether the pane is visible. */
export function setWorkToolsPaneVisibleProbeForTests(probe: (() => boolean) | null): void {
  paneVisibleProbe = probe ?? defaultPaneVisible;
}

export function isWorkToolOnScreen(tool: string, laneId: string | null): boolean {
  return isWorkToolMounted(tool, laneId) && paneVisibleProbe();
}

/**
 * Resolve true once the tool is on screen, or false after `timeoutMs`.
 * Timers, not animation frames: a hidden window runs no frames, and that is
 * exactly the case that has to end in false rather than hang.
 */
export function waitForWorkToolOnScreen(
  tool: string,
  laneId: string | null,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 3_000;
  const intervalMs = options.intervalMs ?? 100;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const check = () => {
      if (isWorkToolOnScreen(tool, laneId)) {
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
  paneVisibleProbe = defaultPaneVisible;
  documentVisibleOverride = null;
}
