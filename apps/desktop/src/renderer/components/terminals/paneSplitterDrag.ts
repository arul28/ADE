import { beginWorkSidebarSplitterDrag } from "./workSidebarSplitter";

/**
 * One horizontal splitter drag, from mousedown to whatever ends it.
 *
 * The tools pane grew this logic inline in `TerminalsPage` — rAF coalescing,
 * Escape-to-cancel, pointercancel and blur commits, and the idempotent
 * `pointer-events: none` teardown that is the difference between a fiddly
 * gesture and an unclickable renderer. The Apple column needs exactly the same
 * gesture against a different pair of panes, and a second hand-rolled copy is
 * how one of them quietly loses the Escape path.
 *
 * Everything layout-specific is a callback: `apply` writes whatever flex-grows
 * the caller's row needs while the drag is live, `commit` persists the one
 * width at the end. The drag NEVER writes intermediate values to the store, so
 * a cancel needs no undo — the store still holds the width being returned to.
 *
 * Returns the cancel function, which is idempotent and safe to call from an
 * unmount, a second mousedown, or any other path that has to make sure no drag
 * is still live.
 */
export function beginPaneSplitterDrag(options: {
  handle: HTMLElement;
  /** Width of the row that holds both panes and this splitter. */
  containerWidthPx: number;
  startClientX: number;
  startWidthPct: number;
  /** Clamp a requested width against the caller's floors. */
  clamp: (widthPct: number) => number;
  /**
   * Which way the pane grows. `"left"` means the pane is to the RIGHT of the
   * handle, so dragging the handle left makes it wider — the tools pane and the
   * Apple column are both this.
   */
  grow?: "left" | "right";
  /** Paint one width. Called on every animation frame of the drag. */
  apply: (widthPct: number) => void;
  /** Persist the width the drag ended on. Not called on cancel. */
  commit: (widthPct: number) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}): () => void {
  const {
    handle,
    containerWidthPx,
    startClientX,
    startWidthPct,
    clamp,
    grow = "left",
    apply,
    commit,
    onDragStart,
    onDragEnd,
  } = options;

  let pendingWidthPct = clamp(startWidthPct);
  let animationFrame: number | null = null;

  const paint = (widthPct: number) => {
    const next = clamp(widthPct);
    pendingWidthPct = next;
    apply(next);
  };
  const schedule = (widthPct: number) => {
    pendingWidthPct = clamp(widthPct);
    if (animationFrame != null) return;
    animationFrame = window.requestAnimationFrame(() => {
      animationFrame = null;
      paint(pendingWidthPct);
    });
  };
  const onMove = (moveEvent: MouseEvent) => {
    const travel = grow === "left"
      ? startClientX - moveEvent.clientX
      : moveEvent.clientX - startClientX;
    schedule(startWidthPct + (travel / containerWidthPx) * 100);
  };

  const endDragIsolation = beginWorkSidebarSplitterDrag(handle);
  let finished = false;

  const finishDrag = (mode: "commit" | "cancel") => {
    if (finished) return;
    finished = true;
    if (animationFrame != null) {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }
    paint(mode === "cancel" ? startWidthPct : pendingWidthPct);
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.removeEventListener("pointercancel", onPointerCancel);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("blur", onBlur);
    endDragIsolation();
    onDragEnd?.();
    if (mode === "commit") commit(pendingWidthPct);
  };

  const onUp = () => finishDrag("commit");
  // Losing the pointer or the window is not a width the user chose, so those
  // paths keep whatever the pane already shows rather than reverting it.
  const onPointerCancel = () => finishDrag("commit");
  const onBlur = () => finishDrag("commit");
  const cancelDrag = () => finishDrag("cancel");
  const onKeyDown = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key !== "Escape") return;
    keyEvent.preventDefault();
    keyEvent.stopPropagation();
    cancelDrag();
  };

  onDragStart?.();
  paint(startWidthPct);
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
  document.addEventListener("pointercancel", onPointerCancel);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("blur", onBlur);

  return cancelDrag;
}
