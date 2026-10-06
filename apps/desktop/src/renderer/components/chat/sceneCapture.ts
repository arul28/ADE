/**
 * Grabbing a scene's still: a crop of the window, so it must only ever be
 * taken when the whole scene is on screen and on top. Pure DOM geometry, apart
 * from `SceneFrame`'s React state.
 */

/**
 * True when the whole shell is inside the viewport.
 *
 * Deliberately all-or-nothing rather than "intersects": the snapshot path
 * crops to what is on screen, so anything less than the whole rect produces a
 * picture of part of a view with no sign that it is partial.
 */
function isSceneRectFullyVisible(rect: DOMRect): boolean {
  if (rect.width < 1 || rect.height < 1) return false;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  if (!viewportWidth || !viewportHeight) return false;
  return rect.top >= 0 && rect.left >= 0 && rect.bottom <= viewportHeight && rect.right <= viewportWidth;
}

/** The `overflow` values that clip descendants to the element's padding box. */
const CLIPPING_OVERFLOW = new Set(["hidden", "clip", "auto", "scroll", "overlay"]);

/** Sub-pixel slack for the containment checks: layout is fractional, a capture is not. */
const SCENE_RECT_EPSILON = 0.5;

/**
 * The shell's rect, but only when every pixel inside it is this scene, on
 * screen, right now. Null otherwise.
 *
 * The snapshot is a grab of the WINDOW cropped to this rect, so whatever is
 * painted there is what gets kept. Inside the window viewport is not enough:
 *
 *  - The transcript is its own scroller, and the chat header sits above it in
 *    the same window. A scene scrolled half under the scroller's top edge still
 *    has a non-negative window rect, so the crop came back as the chat header
 *    painted over the scene's hidden top. Every clipping ancestor has to
 *    contain the rect too.
 *  - The composer floats over the bottom of the transcript, and a dialog or
 *    menu can sit over anything. Hit-testing a few points finds whatever is
 *    painted on top; anything that is not this shell means "not now".
 */
export function measureCapturableSceneRect(shell: HTMLElement): DOMRect | null {
  const rect = shell.getBoundingClientRect();
  if (!isSceneRectFullyVisible(rect)) return null;
  for (let el = shell.parentElement; el && el !== document.documentElement; el = el.parentElement) {
    const style = window.getComputedStyle(el);
    if (!CLIPPING_OVERFLOW.has(style.overflowX) && !CLIPPING_OVERFLOW.has(style.overflowY)) continue;
    // The clip edge is the padding box: the border box less the borders.
    const box = el.getBoundingClientRect();
    const left = box.left + el.clientLeft;
    const top = box.top + el.clientTop;
    if (
      rect.left < left - SCENE_RECT_EPSILON
      || rect.top < top - SCENE_RECT_EPSILON
      || rect.right > left + el.clientWidth + SCENE_RECT_EPSILON
      || rect.bottom > top + el.clientHeight + SCENE_RECT_EPSILON
    ) {
      return null;
    }
  }
  if (typeof document.elementFromPoint === "function") {
    const inset = 2;
    const points: Array<[number, number]> = [
      [rect.left + inset, rect.top + inset],
      [rect.right - inset, rect.top + inset],
      [rect.left + inset, rect.bottom - inset],
      [rect.right - inset, rect.bottom - inset],
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
    ];
    for (const [x, y] of points) {
      const hit = document.elementFromPoint(x, y);
      if (!hit || !shell.contains(hit)) return null;
    }
  }
  return rect;
}

function sameSceneRect(a: DOMRect, b: DOMRect): boolean {
  return Math.abs(a.left - b.left) < SCENE_RECT_EPSILON
    && Math.abs(a.top - b.top) < SCENE_RECT_EPSILON
    && Math.abs(a.width - b.width) < SCENE_RECT_EPSILON
    && Math.abs(a.height - b.height) < SCENE_RECT_EPSILON;
}

export type SceneCapture = (rect: { x: number; y: number; width: number; height: number }) => Promise<string | null>;

/**
 * Grab the shell, or answer why not.
 *
 * Measured twice — before the request and after the picture comes back —
 * because the grab is asynchronous: it lands on a later compositor frame, and
 * the transcript re-pins its scroll and re-measures rows at exactly the moments
 * a scene tends to be captured (a turn ending, the composer resizing). A rect
 * that moved in between describes a place the scene no longer was, and the
 * picture is of whatever slid into it. Such a picture is thrown away, never kept.
 */
export async function captureSceneShell(
  shell: HTMLElement,
  capture: SceneCapture,
): Promise<{ kind: "captured"; dataUrl: string } | { kind: "not-visible" | "moved" | "empty" }> {
  const before = measureCapturableSceneRect(shell);
  if (!before) return { kind: "not-visible" };
  const dataUrl = await capture({
    x: before.x, y: before.y, width: before.width, height: before.height,
  });
  const after = shell.isConnected ? measureCapturableSceneRect(shell) : null;
  if (!after || !sameSceneRect(before, after)) return { kind: "moved" };
  return dataUrl ? { kind: "captured", dataUrl } : { kind: "empty" };
}

/**
 * How long a capture thrown away for moving waits before it tries again. It
 * doubles per consecutive miss up to the cap: a pinned transcript scrolls every
 * frame while a turn streams, and each try is a window grab plus a PNG encode.
 */
export const SCENE_CAPTURE_RETRY_MS = 250;
export const SCENE_CAPTURE_RETRY_MAX_MS = 4_000;
