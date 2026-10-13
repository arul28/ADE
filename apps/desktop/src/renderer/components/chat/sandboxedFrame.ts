/**
 * What every sandboxed frame in the transcript shares: a scene, and an MCP
 * App. Both run code ADE did not write in a frame with an opaque origin, and
 * both may ask ADE to do something visible (open a link, draft a reply, run a
 * tool) only in answer to the user's own click or key press INSIDE the frame.
 */

/** The least time between two links one frame may open. */
export const FRAME_OPEN_MIN_INTERVAL_MS = 800;
/** The least time between two replies one frame may draft, so a looping page cannot churn the prompt box. */
export const FRAME_REPLY_MIN_INTERVAL_MS = 150;

/*
 * The threat. "This frame has focus and the window has user activation" is not
 * proof of a press inside the frame:
 *
 *   - the activation ADE can read is its OWN document's. Any click or key press
 *     anywhere in ADE sets it, for about five seconds;
 *   - a cross-origin frame can give itself focus from script.
 *
 * So while the reader types in the prompt box, a page could call `focus()` and
 * pass. ADE cannot see input inside the frame (it goes to the frame's own
 * document), but it sees ALL input outside every frame: that reaches `window`
 * here. So the rule is written from that side: an activation that a press
 * outside the frames could account for counts only while the pointer is on the
 * frame.
 *
 * Chromium keeps a transient activation for 5 s. The window below is longer, so
 * an outside press is never trusted for less time than its activation lives.
 *
 * Two frames on one page add a second case: a press inside frame B gives the
 * window its activation and reaches nothing here, and frame A can then give
 * itself focus. So "no outside press" is not enough with the pointer off the
 * frame: the frame must also be the one the user's own input put the focus in
 * (`userFocusedFrame`). ADE gets no event when focus moves from one frame to
 * another, so it reads the focus at the moments it does see: when focus leaves
 * ADE's document, when the pointer leaves a frame, and when a frame passes the
 * check with the pointer on it.
 */
const OUTSIDE_PRESS_ACCOUNTS_FOR_ACTIVATION_MS = 6_000;

/** When input last reached ADE's own document: a press outside every frame. */
let lastOutsidePressAt = Number.NEGATIVE_INFINITY;
/** True when that press was the Tab key: the one outside press that moves focus into a frame. */
let lastOutsidePressWasTab = false;
/** The frame that got its focus from the user's own input, when ADE saw that happen. */
let userFocusedFrame: WeakRef<HTMLIFrameElement> | null = null;
let watchers = 0;

function focusedFrame(): HTMLIFrameElement | null {
  const active = document.activeElement;
  return active instanceof HTMLIFrameElement ? active : null;
}

function setUserFocusedFrame(frame: HTMLIFrameElement | null): void {
  userFocusedFrame = frame ? new WeakRef(frame) : null;
}

function activationIsActive(): boolean {
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  // A host with no activation API cannot tell; the focus check still applies.
  return activation ? activation.isActive : true;
}

function noteOutsidePress(event: Event): void {
  lastOutsidePressAt = Date.now();
  lastOutsidePressWasTab = event.type === "keydown" && (event as KeyboardEvent).key === "Tab";
  // The press was in ADE's own document, so no frame holds the user's focus now.
  setUserFocusedFrame(null);
}

/**
 * Focus left ADE's document. When it went into a frame, the user put it there
 * only if the pointer is on that frame (a click) or the Tab key was just
 * pressed. A frame that took focus from script matches neither.
 */
function noteWindowBlur(): void {
  const tabbed = lastOutsidePressWasTab && Date.now() - lastOutsidePressAt < TAB_MOVES_FOCUS_MS;
  // The focused frame is known only after the blur is done.
  queueMicrotask(() => {
    const frame = focusedFrame();
    setUserFocusedFrame(frame && (tabbed || frame.matches(":hover")) ? frame : null);
  });
}

/** The pointer left a frame. A frame that holds the focus then got it while the pointer was on it. */
function notePointerOut(event: Event): void {
  const left = event.target;
  if (!(left instanceof HTMLIFrameElement)) return;
  if (focusedFrame() === left) setUserFocusedFrame(left);
  else if (userFocusedFrame?.deref() === left) setUserFocusedFrame(null);
}

/** The events that grant activation: a key or pointer going down, and a touch or pen coming up. */
const PRESS_EVENTS = ["keydown", "pointerdown", "pointerup"] as const;
/** The most time between a Tab press and the focus change it causes. */
const TAB_MOVES_FOCUS_MS = 250;

/**
 * Watch ADE's own document for presses while a sandboxed frame is mounted.
 * One listener set for the app however many frames are up; the last frame to
 * unmount removes it. Returns the release.
 */
export function watchOutsidePresses(): () => void {
  if (watchers === 0) {
    // Nothing was watching until now. An activation that is already live came
    // from a press this module did not see, so it is taken as an outside one.
    lastOutsidePressAt = typeof navigator !== "undefined" && "userActivation" in navigator && activationIsActive()
      ? Date.now()
      : Number.NEGATIVE_INFINITY;
    lastOutsidePressWasTab = false;
    setUserFocusedFrame(null);
    for (const type of PRESS_EVENTS) window.addEventListener(type, noteOutsidePress, { capture: true, passive: true });
    window.addEventListener("blur", noteWindowBlur);
    window.addEventListener("pointerout", notePointerOut, { capture: true, passive: true });
  }
  watchers += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    watchers -= 1;
    if (watchers === 0) {
      for (const type of PRESS_EVENTS) window.removeEventListener(type, noteOutsidePress, true);
      window.removeEventListener("blur", noteWindowBlur);
      window.removeEventListener("pointerout", notePointerOut, true);
      setUserFocusedFrame(null);
    }
  };
}

/**
 * True when the user just clicked or pressed a key inside `frame`.
 *
 * All three must hold:
 *   1. the frame has focus;
 *   2. the window holds transient user activation;
 *   3. that activation is the frame's: the pointer is on the frame right now,
 *      OR the user's own input put the focus in this frame AND no press
 *      reached ADE's own document recently enough to account for the
 *      activation (so it can only have come from inside this frame).
 *
 * A click in the frame passes on the pointer. Typing in a frame the user
 * clicked or tabbed into passes on either half, with the pointer anywhere. A
 * frame that took the focus from script passes on neither. With one frame
 * mounted there is no other frame to press in, so the focus half is not asked.
 *
 * Fails closed when nothing is watching (no {@link watchOutsidePresses} held).
 */
export function frameJustPressed(frame: HTMLIFrameElement | null): boolean {
  if (!frame || watchers === 0) return false;
  if (document.activeElement !== frame || !activationIsActive()) return false;
  if (frame.matches(":hover")) {
    setUserFocusedFrame(frame);
    return true;
  }
  // Only another mounted frame can take a press that this one then claims.
  if (watchers > 1 && userFocusedFrame?.deref() !== frame) return false;
  return Date.now() - lastOutsidePressAt >= OUTSIDE_PRESS_ACCOUNTS_FOR_ACTIVATION_MS;
}

/**
 * The gate one visible action goes through: a press inside the frame, and at
 * least `minIntervalMs` since the last action `lastRef` let through.
 */
export function passFrameGate(
  frame: HTMLIFrameElement | null,
  lastRef: { current: number },
  minIntervalMs: number,
): boolean {
  const now = Date.now();
  if (!frameJustPressed(frame) || now - lastRef.current < minIntervalMs) return false;
  lastRef.current = now;
  return true;
}

/** Post to a sandboxed frame. Its origin is opaque, so "*" is the only target that reaches it. */
export function postToOpaqueFrame(frame: HTMLIFrameElement | null, message: unknown): void {
  try { frame?.contentWindow?.postMessage(message, "*"); } catch { /* frame gone */ }
}
