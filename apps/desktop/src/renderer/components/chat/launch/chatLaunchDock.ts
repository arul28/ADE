import type { AgentChatEventEnvelope } from "../../../../shared/types";
import { latestAppResourcePressureLevel } from "../../../lib/resourcePressure";
import { applyViewportOverlayHostStyle, createViewportOverlayHost } from "../../ui/ViewportOverlayHost";

/**
 * T3-style send handoff for the first message of a new chat.
 *
 * The draft composer sits centered on the empty chat surface; the chat it
 * starts docks its composer at the bottom of the thread. Right before the view
 * switches to the new chat, the sending pane measures the draft composer and
 * its text box. The chat pane then plays two FLIPs from those rects:
 *
 * - the docked composer glides down from where the draft composer was, and
 * - the first user bubble rises from where the prompt text was.
 *
 * A launch that opens in a different pane instance stashes the handoff here,
 * keyed by the new chat's session id. A pane that creates its chat in place
 * keeps the handoff itself (`captureComposerHandoff`).
 *
 * Everything here is synchronous: nothing awaits between the stash and the switch.
 */

export type ComposerDockRect = { left: number; top: number; width: number; height: number };

/** How the typed prompt looked, so the flight can start as an exact copy of it. */
export type ComposerTypedText = {
  text: string;
  /** Content-box width and visible height of the text box. */
  width: number;
  height: number;
  font: string;
  lineHeight: string;
  letterSpacing: string;
  color: string;
};

/**
 * Where the prompt text started: the text box's content-box origin, the text
 * box itself (border box), and what it showed.
 */
export type ComposerTextOrigin = { left: number; top: number; box?: ComposerDockRect; typed?: ComposerTypedText };

/**
 * Copies of the draft surface's chrome (mode switcher, usage, launch shelf,
 * logo, import hint), parked over the originals in a fixed overlay at send
 * time. The chat that opens covers the draft surface on its first frame, so
 * the originals cannot animate; the copies leave in their place.
 */
export type DepartingDraftChrome = {
  host: HTMLElement;
  items: Array<{ layer: HTMLElement; kind: "rise" | "fade"; rect: ComposerDockRect }>;
  played: boolean;
};

export type ComposerHandoff = {
  composer: ComposerDockRect;
  text: ComposerTextOrigin | null;
  /** Draft chrome that leaves the screen as the chat opens (launches from the Work draft only). */
  departing?: DepartingDraftChrome | null;
  /**
   * The first message as the opening pane should render it before the host
   * echoes it. Only launches whose chat has no synthetic prompt row set this.
   */
  firstMessage: AgentChatEventEnvelope | null;
};

export type ComposerHandoffCaptureOptions = {
  firstMessage?: AgentChatEventEnvelope | null;
  /** Draft chrome that leaves with a Work draft launch. */
  departingScope?: Element | null;
};

const DOCK_STASH_TTL_MS = 1_500;
export const COMPOSER_DOCK_DURATION_MS = 420;
export const COMPOSER_DOCK_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";
export const FIRST_MESSAGE_FLIGHT_DURATION_MS = 480;
// The same curve as the composer glide: an ease-out that front-loads the
// travel made the text jump to the bubble in the first ~100 ms.
export const FIRST_MESSAGE_FLIGHT_EASING = COMPOSER_DOCK_EASING;
/** How long a parked handoff waits for the pane to settle before it gives up. */
const SETTLE_GIVE_UP_MS = 1_500;
/** How long the flight waits for the bubble to mount before it gives up. */
const FIRST_MESSAGE_TARGET_WAIT_MS = 500;

/** Draft chrome marked to leave with the handoff: `rise` flies off the top, `fade` fades out. */
export const DRAFT_DEPART_SELECTOR = "[data-draft-depart]";
export const DRAFT_DEPART_RISE_DURATION_MS = 420;
export const DRAFT_DEPART_FADE_DURATION_MS = 260;

/** The prompt box's editable text surface (`AgentChatComposer`). */
export const COMPOSER_TEXT_SELECTOR = "[data-chat-composer-text]";
/** A user message bubble in the transcript (`AgentChatMessageList`). */
export const USER_MESSAGE_CARD_SELECTOR = "[data-chat-user-message-card]";

const pendingDocks = new Map<string, { handoff: ComposerHandoff; stashedAtMs: number }>();

function discardDeparting(handoff: ComposerHandoff | null | undefined): void {
  const departing = handoff?.departing;
  if (departing && !departing.played) departing.host.remove();
}

function sweep(nowMs: number): void {
  for (const [sessionId, entry] of pendingDocks) {
    if (nowMs - entry.stashedAtMs > DOCK_STASH_TTL_MS) {
      discardDeparting(entry.handoff);
      pendingDocks.delete(sessionId);
    }
  }
}

/** Resource pressure at or above this level (ADE's own sample) skips the send motion. */
const SKIP_MOTION_PRESSURE_LEVEL = 3;

/**
 * Whether to play the send handoff at all. It skips for reduced motion, and
 * under heavy CPU or memory pressure: frames drop then, and a stuttering
 * flight reads worse than none.
 */
export function shouldPlaySendHandoff(): boolean {
  // A hidden window runs no animation frames; the handoff would sit parked.
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
  return !prefersReducedMotion() && latestAppResourcePressureLevel() < SKIP_MOTION_PRESSURE_LEVEL;
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

function measureTextOrigin(composer: Element): ComposerTextOrigin | null {
  const text = composer.querySelector<HTMLElement>(COMPOSER_TEXT_SELECTOR);
  if (!text || typeof text.getBoundingClientRect !== "function") return null;
  const rect = text.getBoundingClientRect();
  if (!(rect.width > 0 && rect.height > 0)) return null;
  const style = window.getComputedStyle(text);
  const px = (value: string) => Number.parseFloat(value) || 0;
  const padLeft = px(style.paddingLeft);
  const padTop = px(style.paddingTop);
  const typedText = text instanceof HTMLTextAreaElement ? text.value : text.innerText ?? "";
  // A plain textarea with chips paints transparent glyphs over an overlay;
  // the overlay (and the text box's parent) carries the visible color.
  const visibleColor = /rgba\([^)]*,\s*0\)|transparent/.test(style.color)
    ? window.getComputedStyle(text.parentElement ?? text).color
    : style.color;
  return {
    left: rect.left + padLeft,
    top: rect.top + padTop,
    box: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    ...(typedText.trim()
      ? {
          typed: {
            text: typedText,
            width: rect.width - padLeft - px(style.paddingRight),
            height: rect.height - padTop - px(style.paddingBottom),
            font: style.font,
            lineHeight: style.lineHeight,
            letterSpacing: style.letterSpacing,
            color: visibleColor,
          },
        }
      : {}),
  };
}

/** Measure the draft composer (and its text box) as it is on screen now. */
export function captureComposerHandoff(
  element: Element | null | undefined,
  options: ComposerHandoffCaptureOptions = {},
): ComposerHandoff | null {
  if (!element || typeof element.getBoundingClientRect !== "function") return null;
  const rect = element.getBoundingClientRect();
  if (!(rect.width > 0 && rect.height > 0)) return null;
  const departing = captureDepartingDraftChrome(options.departingScope);
  return {
    composer: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    text: measureTextOrigin(element),
    firstMessage: options.firstMessage ?? null,
    ...(departing ? { departing } : {}),
  };
}

/** Find the composer wrapper in either empty-draft layout. */
export function findComposerHandoffElement(scope: Element | null | undefined): Element | null {
  if (!scope) return null;
  return scope.querySelector("[data-chat-composer-wrapper]")
    ?? scope.querySelector("[data-chat-composer-dock]");
}

/** Find the Work draft composer, including layouts that dock it outside the empty-state subtree. */
export function findDraftComposerHandoffElement(shell: Element | null | undefined): Element | null {
  if (!shell) return null;
  const emptyState = shell.querySelector("[data-chat-empty-state]");
  const composer = findComposerHandoffElement(emptyState ?? shell);
  if (composer || !emptyState) return composer;
  return findComposerHandoffElement(shell);
}

/** Store an already measured handoff under the session that is about to open. */
export function stashComposerHandoffOrigin(sessionId: string, handoff: ComposerHandoff | null | undefined): void {
  if (!handoff) return;
  const nowMs = Date.now();
  sweep(nowMs);
  discardDeparting(pendingDocks.get(sessionId)?.handoff);
  pendingDocks.set(sessionId, { handoff, stashedAtMs: nowMs });
}

/** Measure the draft composer and remember it for the session about to open. */
export function stashComposerDockOrigin(
  sessionId: string,
  element: Element | null | undefined,
  options: ComposerHandoffCaptureOptions = {},
): void {
  const handoff = captureComposerHandoff(element, options);
  if (!handoff) return;
  stashComposerHandoffOrigin(sessionId, handoff);
}

function liveEntry(sessionId: string | null | undefined) {
  if (!sessionId) return null;
  const entry = pendingDocks.get(sessionId);
  if (!entry) return null;
  if (Date.now() - entry.stashedAtMs > DOCK_STASH_TTL_MS) {
    discardDeparting(entry.handoff);
    pendingDocks.delete(sessionId);
    return null;
  }
  return entry;
}

/** True while a dock is waiting for this session's pane (drives the Work area's no-blur switch). */
export function hasPendingComposerDock(sessionId: string | null | undefined): boolean {
  return liveEntry(sessionId) != null;
}

/** The stashed first message, without consuming the handoff (seeds the pane's first render). */
export function peekComposerHandoffFirstMessage(sessionId: string | null | undefined): AgentChatEventEnvelope | null {
  return liveEntry(sessionId)?.handoff.firstMessage ?? null;
}

export function takeComposerDockOrigin(sessionId: string | null | undefined): ComposerHandoff | null {
  const entry = liveEntry(sessionId);
  if (!entry || !sessionId) return null;
  pendingDocks.delete(sessionId);
  return entry.handoff;
}

/**
 * Run `fn` once the pane that just mounted has painted and settled. A chat
 * pane's first commit can block the main thread for a few hundred ms and then
 * shift its layout (measured widths, reserves), so an animation started in the
 * layout effect is mostly over before its first frame and aims at a stale
 * rect. Two frames later the layout is final and the full animation shows.
 */
function afterSettledFrames(fn: () => void, onGiveUp: () => void): void {
  // Frames stop if the window hides meanwhile; never leave a parked copy or a
  // pinned composer behind waiting for them.
  let done = false;
  const giveUp = window.setTimeout(() => {
    if (done) return;
    done = true;
    onGiveUp();
  }, SETTLE_GIVE_UP_MS);
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    if (done) return;
    done = true;
    window.clearTimeout(giveUp);
    fn();
  }));
}

function composerDockOffset(element: HTMLElement, from: ComposerDockRect): { dx: number; dy: number } | null {
  const to = element.getBoundingClientRect();
  if (!(to.width > 0 && to.height > 0)) return null;
  const dx = (from.left + from.width / 2) - (to.left + to.width / 2);
  const dy = (from.top + from.height) - (to.top + to.height);
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return null;
  return { dx, dy };
}

function rectContains(outer: DOMRect, inner: ComposerDockRect): boolean {
  return outer.left <= inner.left + 1
    && outer.top <= inner.top + 1
    && outer.right >= inner.left + inner.width - 1
    && outer.bottom >= inner.top + inner.height - 1;
}

/**
 * The docked composer lives in a footer that clips (`overflow: hidden`), so a
 * glide that starts mid-surface would only show once it reached the footer.
 * Open every clipping ancestor that does not already contain the start rect,
 * and return how to put them back.
 */
function unclipAncestorsFor(element: HTMLElement, from: ComposerDockRect): () => void {
  const opened: Array<{ element: HTMLElement; overflow: string }> = [];
  for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
    if (rectContains(node.getBoundingClientRect(), from)) break;
    const style = window.getComputedStyle(node);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    opened.push({ element: node, overflow: node.style.overflow });
    node.style.overflow = "visible";
  }
  return () => {
    for (const entry of opened) entry.element.style.overflow = entry.overflow;
  };
}

/**
 * FLIP the docked composer from where the draft composer was. Bottom edges and
 * horizontal centers are aligned, which reads as the same box gliding down;
 * width is not scaled because scaling a text field smears its glyphs. The
 * composer is pinned at the old spot until the pane settles, then glides.
 */
export function playComposerDock(element: HTMLElement | null, from: ComposerDockRect | null): void {
  if (!element || !from || !shouldPlaySendHandoff()) return;
  if (typeof element.animate !== "function") return;
  const pinned = composerDockOffset(element, from);
  if (!pinned) return;
  const restoreClipping = unclipAncestorsFor(element, from);
  // The empty composer's placeholder would sit right under the flying copy of
  // the prompt; keep its text surface blank until the glide lands.
  const textSurface = element.querySelector(COMPOSER_TEXT_SELECTOR)?.parentElement;
  const previousSurfaceOpacity = textSurface?.style.opacity ?? "";
  if (textSurface) textSurface.style.opacity = "0";
  const restore = () => {
    restoreClipping();
    if (textSurface) textSurface.style.opacity = previousSurfaceOpacity;
  };
  const previousTransform = element.style.transform;
  element.style.transform = `translate(${pinned.dx}px, ${pinned.dy}px)`;
  afterSettledFrames(() => {
    element.style.transform = previousTransform;
    const offset = element.isConnected ? composerDockOffset(element, from) : null;
    if (!offset) {
      restore();
      return;
    }
    try {
      const animation = element.animate(
        [
          { transform: `translate(${offset.dx}px, ${offset.dy}px)` },
          { transform: "translate(0px, 0px)" },
        ],
        { duration: COMPOSER_DOCK_DURATION_MS, easing: COMPOSER_DOCK_EASING },
      );
      textSurface?.animate(
        [{ opacity: 0 }, { opacity: 0, offset: 0.7 }, { opacity: 1 }],
        { duration: COMPOSER_DOCK_DURATION_MS, easing: "linear" },
      );
      animation.addEventListener("finish", restore);
      animation.addEventListener("cancel", restore);
    } catch {
      restore();
    }
  }, () => {
    element.style.transform = previousTransform;
    restore();
  });
}

/** The vertical translate an element carries right now (the row's own entrance offset). */
function currentTranslateY(element: Element | null): number {
  if (!element) return 0;
  const transform = window.getComputedStyle(element).transform;
  if (!transform || transform === "none") return 0;
  try {
    return new DOMMatrixReadOnly(transform).m42;
  } catch {
    return 0;
  }
}

/** Where the bubble's border box settles: its rect minus the row's entrance offset. */
function settledCardBox(card: HTMLElement): ComposerDockRect | null {
  const rect = card.getBoundingClientRect();
  if (!(rect.width > 0 && rect.height > 0)) return null;
  return {
    left: rect.left,
    top: rect.top - currentTranslateY(card.parentElement),
    width: rect.width,
    height: rect.height,
  };
}

/**
 * Glass cards blur what is behind them. A moving copy would re-blur on every
 * frame, which is heavy on a weak GPU; the bubble gradient is near-opaque, so
 * the copy drops the blur and nobody sees the difference.
 */
function dropBackdrop(element: HTMLElement): void {
  element.style.backdropFilter = "none";
  element.style.setProperty("-webkit-backdrop-filter", "none");
}

/** A text layer that looks exactly like the prompt as it was typed. */
function typedTextLayer(typed: ComposerTypedText, left: number, top: number): HTMLElement {
  const layer = document.createElement("div");
  layer.textContent = typed.text;
  Object.assign(layer.style, {
    position: "absolute",
    left: `${left}px`,
    top: `${top}px`,
    width: `${typed.width}px`,
    maxHeight: `${typed.height}px`,
    overflow: "hidden",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    textAlign: "left",
    font: typed.font,
    lineHeight: typed.lineHeight,
    letterSpacing: typed.letterSpacing,
    color: typed.color,
  });
  return layer;
}

function placeBox(layer: HTMLElement, box: { left: number; top: number; width?: number; height?: number }): void {
  layer.style.left = `${box.left}px`;
  layer.style.top = `${box.top}px`;
  if (box.width != null) layer.style.width = `${box.width}px`;
  if (box.height != null) layer.style.height = `${box.height}px`;
}

const translate = (dx: number, dy: number) => `translate(${dx}px, ${dy}px)`;

/**
 * The prompt's text box becomes the bubble. Everything is drawn in a fixed
 * overlay (the transcript scroller clips, and the composer lives outside it;
 * the overlay copies the chat's inline appearance variables). Three layers:
 *
 * - the bubble chrome (gradient, border, shadow; no content) starts as the
 *   prompt's whole text box, invisible, and contracts into the bubble while
 *   it fades in, so the box visibly lifts out of the prompt box and shrinks
 *   toward the right-aligned bubble instead of a small bubble crossing the
 *   screen from the left;
 * - the prompt exactly as typed (font, color, wrap), which only rises and
 *   dissolves, so no text crosses the screen;
 * - the bubble's own text, riding inside the box, fading in.
 *
 * Every layer is laid out once at its end geometry and animates only
 * `transform` and `opacity`, so the whole flight runs on the compositor: it
 * stays smooth while the main thread is busy mounting the new chat and
 * streaming its first events, which is exactly when it plays.
 */
function flyCardFrom(card: HTMLElement, from: ComposerTextOrigin): void {
  const initial = settledCardBox(card);
  if (!initial) return;
  const cardStyle = window.getComputedStyle(card);
  const padLeft = Number.parseFloat(cardStyle.paddingLeft) || 0;
  const padTop = Number.parseFloat(cardStyle.paddingTop) || 0;
  // Without a measured text box, start from a bubble-sized box on the text.
  const box: ComposerDockRect = from.box ?? {
    left: from.left - padLeft,
    top: from.top - padTop,
    width: initial.width,
    height: initial.height,
  };

  const hostFrame = {
    left: "0px",
    top: "0px",
    width: "0px",
    height: "0px",
    margin: "0",
    padding: "0",
    overflow: "visible",
  } as const;
  const host = createViewportOverlayHost("chatFirstMessageHandoff", hostFrame);
  const appearanceRoot = card.closest<HTMLElement>("[data-chat-appearance-root]");
  if (appearanceRoot) host.style.cssText = appearanceRoot.style.cssText;
  applyViewportOverlayHostStyle(host, "chatFirstMessageHandoff", hostFrame);
  host.dataset.chatFirstMessageFlight = "";
  const layerStyle = { position: "absolute", margin: "0", transformOrigin: "0 0", willChange: "transform, opacity" };

  const chrome = card.cloneNode(false) as HTMLElement;
  chrome.removeAttribute("data-chat-user-message-card");
  Object.assign(chrome.style, layerStyle, { maxWidth: "none", minWidth: "0", opacity: "0" });
  dropBackdrop(chrome);
  const bubbleText = card.cloneNode(true) as HTMLElement;
  bubbleText.removeAttribute("data-chat-user-message-card");
  Object.assign(bubbleText.style, layerStyle, {
    maxWidth: "none",
    background: "transparent",
    borderColor: "transparent",
    boxShadow: "none",
  });
  dropBackdrop(bubbleText);
  const typed = from.typed ? typedTextLayer(from.typed, from.left, from.top) : null;
  if (typed) Object.assign(typed.style, layerStyle);
  // Without a typed copy the bubble text is the only text: show it from the start.
  if (typed) bubbleText.style.opacity = "0";

  // Lay every layer out at its end geometry for `target`, and return the
  // transforms that put it back at its start (the prompt).
  const layOut = (target: ComposerDockRect) => {
    placeBox(chrome, target);
    placeBox(bubbleText, { left: target.left, top: target.top, width: target.width });
    const chromeStart = `${translate(box.left - target.left, box.top - target.top)} scale(${box.width / target.width}, ${box.height / target.height})`;
    const bubbleTextStart = translate(from.left - padLeft - target.left, from.top - padTop - target.top);
    // The typed text only rises (it never crosses the screen).
    const typedRise = target.top + padTop - from.top;
    return { chromeStart, bubbleTextStart, typedRise };
  };
  const parked = layOut(initial);
  chrome.style.transform = parked.chromeStart;
  bubbleText.style.transform = parked.bubbleTextStart;
  host.append(chrome, bubbleText);
  if (typed) host.append(typed);
  document.body.appendChild(host);

  const previousVisibility = card.style.visibility;
  card.style.visibility = "hidden";
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    card.style.visibility = previousVisibility;
    host.remove();
  };

  // Parked on the prompt until the pane settles; then aim at where the bubble
  // really is and morph.
  afterSettledFrames(() => {
    const target = card.isConnected ? settledCardBox(card) : null;
    if (!target) {
      settle();
      return;
    }
    const { chromeStart, bubbleTextStart, typedRise } = layOut(target);
    const duration = FIRST_MESSAGE_FLIGHT_DURATION_MS;
    const motion = { duration, easing: FIRST_MESSAGE_FLIGHT_EASING, fill: "forwards" as const };
    try {
      chrome.style.transform = "";
      chrome.style.opacity = "";
      bubbleText.style.transform = "";
      const flight = chrome.animate(
        [
          { transform: chromeStart, opacity: 0 },
          { opacity: 1, offset: 0.45 },
          { transform: "translate(0px, 0px) scale(1, 1)", opacity: 1 },
        ],
        motion,
      );
      bubbleText.animate([{ transform: bubbleTextStart }, { transform: "translate(0px, 0px)" }], motion);
      if (typed) {
        // The typed text rises and dissolves while the box contracts toward
        // the bubble; the bubble text takes over mid-flight.
        typed.animate([{ transform: translate(0, 0) }, { transform: translate(0, typedRise) }], motion);
        typed.animate([{ opacity: 1 }, { opacity: 0 }], { duration: duration * 0.4, easing: "ease-in", fill: "forwards" });
        bubbleText.style.opacity = "";
        bubbleText.animate(
          [{ opacity: 0 }, { opacity: 0, offset: 0.25 }, { opacity: 1, offset: 0.7 }, { opacity: 1 }],
          { duration, easing: "linear" },
        );
      }
      flight.addEventListener("finish", settle);
      flight.addEventListener("cancel", settle);
    } catch {
      settle();
    }
  }, settle);
}

/**
 * Fly the chat's first user bubble up from where the prompt text sat. The
 * bubble usually exists already (the pane rendered it this commit); if the
 * list mounts it a frame or two later, this waits briefly and then gives up
 * without animating.
 */
export function playFirstMessageFlight(root: HTMLElement | null, from: ComposerTextOrigin | null): void {
  if (!root || !from || !shouldPlaySendHandoff()) return;
  if (typeof HTMLElement.prototype.animate !== "function") return;
  const find = () => root.querySelector<HTMLElement>(USER_MESSAGE_CARD_SELECTOR);
  const card = find();
  if (card) {
    flyCardFrom(card, from);
    return;
  }
  const deadline = performance.now() + FIRST_MESSAGE_TARGET_WAIT_MS;
  const poll = () => {
    if (!root.isConnected) return;
    const next = find();
    if (next) {
      flyCardFrom(next, from);
      return;
    }
    if (performance.now() < deadline) window.requestAnimationFrame(poll);
  };
  window.requestAnimationFrame(poll);
}

/**
 * Park copies of the draft surface's departing chrome over the originals.
 * Synchronous, right before the view switches: a few rects, one clone each.
 * A copy that is never played (the chat never opened) removes itself.
 */
function captureDepartingDraftChrome(scope: Element | null | undefined): DepartingDraftChrome | null {
  if (!scope || !shouldPlaySendHandoff()) return null;
  const sources = Array.from(scope.querySelectorAll<HTMLElement>(DRAFT_DEPART_SELECTOR));
  if (!sources.length) return null;
  const hostFrame = {
    left: "0px",
    top: "0px",
    width: "0px",
    height: "0px",
    overflow: "visible",
  } as const;
  const host = createViewportOverlayHost("chatDraftDeparture", hostFrame);
  host.dataset.chatDraftDeparting = "";
  const items: DepartingDraftChrome["items"] = [];
  for (const source of sources) {
    const rect = source.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) continue;
    const layer = document.createElement("div");
    // Inherited text styles and the chat's inline appearance variables do not
    // travel with a clone; carry them on the layer.
    const appearanceRoot = source.closest<HTMLElement>("[data-chat-appearance-root]");
    if (appearanceRoot) layer.style.cssText = appearanceRoot.style.cssText;
    const style = window.getComputedStyle(source);
    Object.assign(layer.style, {
      position: "absolute",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      margin: "0",
      padding: "0",
      font: style.font,
      color: style.color,
      letterSpacing: style.letterSpacing,
      textAlign: style.textAlign,
      // Laid out once, then only transform and opacity change.
      contain: "layout style",
      willChange: "transform, opacity",
    });
    const clone = source.cloneNode(true) as HTMLElement;
    clone.removeAttribute("data-draft-depart");
    // The layer carries the position; the copy fills it whatever its own
    // positioning was (an absolutely placed source would land off screen).
    Object.assign(clone.style, {
      position: "relative",
      inset: "auto",
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      margin: "0",
      transform: "none",
    });
    layer.appendChild(clone);
    host.appendChild(layer);
    items.push({
      layer,
      kind: source.dataset.draftDepart === "rise" ? "rise" : "fade",
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    });
  }
  if (!items.length) return null;
  document.body.appendChild(host);
  const departing: DepartingDraftChrome = { host, items, played: false };
  // Belt and braces: a copy nobody plays must not outlive the stash.
  window.setTimeout(() => {
    if (!departing.played) host.remove();
  }, DOCK_STASH_TTL_MS + 500);
  return departing;
}

/**
 * Renderer-owned launches can spend longer than the parked clone's safety TTL
 * waiting for lane/session IPC. Refresh only a clone that expired; retain the
 * send-time composer and text origins, and keep an intentionally skipped
 * departure skipped.
 */
export function refreshComposerHandoffDeparture(
  handoff: ComposerHandoff,
  scope: Element | null | undefined,
): ComposerHandoff {
  if (!handoff.departing || handoff.departing.host.isConnected) return handoff;
  return { ...handoff, departing: captureDepartingDraftChrome(scope) };
}

/** The opening chat's header, which the mode switcher morphs into. */
export const CHAT_SHELL_HEADER_SELECTOR = "[data-chat-shell-header]";
export const DRAFT_HEADER_MORPH_DURATION_MS = COMPOSER_DOCK_DURATION_MS;

/**
 * Only the header's shape travels in the morph (the bar layer: backgrounds,
 * no glyphs); its text and icons fade in at their final place (the content
 * layer: glyphs, no backgrounds), because stretched glyphs read as broken.
 */
const MORPH_BAR_STYLE = `[data-chat-header-morph-bar], [data-chat-header-morph-bar] * {
  color: transparent !important;
  -webkit-text-fill-color: transparent !important;
  text-shadow: none !important;
}
[data-chat-header-morph-bar] svg, [data-chat-header-morph-bar] img { visibility: hidden !important; }
[data-chat-header-morph-content], [data-chat-header-morph-content] * {
  background: transparent !important;
  border-color: transparent !important;
  box-shadow: none !important;
}`;

function headerLayer(header: HTMLElement, rect: DOMRect): HTMLElement {
  const layer = document.createElement("div");
  const appearanceRoot = header.closest<HTMLElement>("[data-chat-appearance-root]");
  if (appearanceRoot) layer.style.cssText = appearanceRoot.style.cssText;
  const style = window.getComputedStyle(header);
  Object.assign(layer.style, {
    position: "absolute",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    padding: "0",
    font: style.font,
    color: style.color,
    transformOrigin: "0 0",
    contain: "layout style",
    willChange: "transform, opacity",
    opacity: "0",
  });
  const clone = header.cloneNode(true) as HTMLElement;
  clone.removeAttribute("data-chat-shell-header");
  Object.assign(clone.style, { width: `${rect.width}px`, height: `${rect.height}px`, margin: "0", visibility: "visible" });
  layer.appendChild(clone);
  return layer;
}

/**
 * Send the parked draft chrome off, once the new chat has settled, together
 * with the composer glide and the first-message flight:
 *
 * - with a chat header to land in, the mode switcher morphs into it: the
 *   header's bar grows out of the switcher pill while the pill's labels fade,
 *   and the header's own title and actions fade in at their final place. The
 *   real header stays hidden until then, so there is never a frame with the
 *   header already up and the switcher still on screen;
 * - without one, the switcher flies up off the top;
 * - everything else fades out and drops a little.
 *
 * Transform and opacity only.
 */
export function playDepartingDraftChrome(
  departing: DepartingDraftChrome | null | undefined,
  header?: HTMLElement | null,
): void {
  if (!departing || departing.played) return;
  departing.played = true;
  const { host, items } = departing;
  // An expired clone can still be referenced by a handoff captured before
  // slow launch IPC. Never hide the real chat header for a detached overlay.
  if (!host.isConnected) return;
  const morphInto = header?.isConnected && items.some((item) => item.kind === "rise") ? header : null;
  // Hidden before the chat's first paint (this runs in its layout effect).
  const previousHeaderVisibility = morphInto?.style.visibility ?? "";
  if (morphInto) morphInto.style.visibility = "hidden";
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    if (morphInto) morphInto.style.visibility = previousHeaderVisibility;
    host.remove();
  };
  if (!shouldPlaySendHandoff()) {
    finish();
    return;
  }
  afterSettledFrames(() => {
    let longestMs = DRAFT_DEPART_FADE_DURATION_MS;
    try {
      const headerRect = morphInto?.getBoundingClientRect();
      for (const item of items) {
        if (
          item.kind === "rise"
          && morphInto
          && headerRect
          && headerRect.width > 0
          && headerRect.height > 0
        ) {
          longestMs = Math.max(longestMs, DRAFT_HEADER_MORPH_DURATION_MS);
          const pill = item.rect;
          if (!host.querySelector("style")) {
            const style = document.createElement("style");
            style.textContent = MORPH_BAR_STYLE;
            host.appendChild(style);
          }
          const bar = headerLayer(morphInto, headerRect);
          bar.setAttribute("data-chat-header-morph-bar", "");
          // The bar carries the shape; the content layer only the title and actions.
          const content = headerLayer(morphInto, headerRect);
          content.setAttribute("data-chat-header-morph-content", "");
          host.append(bar, content);
          const timing = { duration: DRAFT_HEADER_MORPH_DURATION_MS, easing: COMPOSER_DOCK_EASING, fill: "forwards" as const };
          bar.animate(
            [
              {
                transform: `${translate(pill.left - headerRect.left, pill.top - headerRect.top)} scale(${pill.width / headerRect.width}, ${pill.height / headerRect.height})`,
                opacity: 0,
              },
              { opacity: 1, offset: 0.4 },
              { transform: "translate(0px, 0px) scale(1, 1)", opacity: 1 },
            ],
            timing,
          );
          // Late enough that the bar already spans the title and the actions.
          content.animate([{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 }], { ...timing, easing: "linear" });
          // The pill drifts toward the header's middle as its labels fade.
          const dx = (headerRect.left + headerRect.width / 2) - (pill.left + pill.width / 2);
          const dy = (headerRect.top + headerRect.height / 2) - (pill.top + pill.height / 2);
          item.layer.animate(
            [{ transform: "translate(0px, 0px)", opacity: 1 }, { transform: translate(dx, dy), opacity: 0 }],
            { duration: DRAFT_HEADER_MORPH_DURATION_MS * 0.45, easing: "ease-out", fill: "forwards" },
          );
        } else if (item.kind === "rise") {
          longestMs = Math.max(longestMs, DRAFT_DEPART_RISE_DURATION_MS);
          item.layer.animate(
            [
              { transform: "translate(0px, 0px)", opacity: 1 },
              { opacity: 1, offset: 0.6 },
              { transform: `translate(0px, ${-(item.rect.top + item.rect.height + 24)}px)`, opacity: 0 },
            ],
            { duration: DRAFT_DEPART_RISE_DURATION_MS, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" },
          );
        } else {
          item.layer.animate(
            [
              { transform: "translate(0px, 0px)", opacity: 1 },
              { transform: "translate(0px, 10px)", opacity: 0 },
            ],
            { duration: DRAFT_DEPART_FADE_DURATION_MS, easing: "ease-out", fill: "forwards" },
          );
        }
      }
    } catch {
      finish();
      return;
    }
    window.setTimeout(finish, longestMs + 40);
  }, finish);
}
