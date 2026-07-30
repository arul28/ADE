import type { AdeSyncClient } from "../sync";
import { sessionLifecycleSupported } from "../adapter/sessionLifecycleSupport";

/**
 * Web-only presentation for the shared Work tab's session-lifecycle controls.
 *
 * The Work list is the desktop component, mounted verbatim by ADE Web, and it
 * reveals the row's lifecycle control on pointer hover. A phone or tablet never
 * produces hover, so on the web that control would be unreachable — and a host
 * running an older ADE advertises no `session.*` commands at all, which would
 * leave a control that can only fail.
 *
 * Both are web-shell concerns, not component concerns, so they are handled here
 * with one stylesheet keyed off a single attribute on <html>:
 *
 *   data-ade-session-lifecycle="ready"        host can do lifecycle
 *   data-ade-session-lifecycle="unsupported"  host can't — hide the affordance
 */

const STYLE_ELEMENT_ID = "ade-web-session-lifecycle";
export const SESSION_LIFECYCLE_ATTRIBUTE = "data-ade-session-lifecycle";

export type SessionLifecycleChromeState = "ready" | "unsupported";

/**
 * Touch targets are 2rem (32px) rather than the desktop control's 20px, and the
 * duration menu rows get a 44px minimum so the snooze choices are separately
 * tappable (the row count varies with the time of day — see
 * `resolveSnoozePresets`).
 */
const STYLES = `
@media (pointer: coarse) {
  [${SESSION_LIFECYCLE_ATTRIBUTE}="ready"] [data-testid="session-snooze-button"] {
    opacity: 1;
    height: 2rem;
    width: 2rem;
  }
  /* The row's action wrapper is pointer-events-none until hovered; a coarse
     pointer never hovers, so the button would swallow no taps at all. */
  [${SESSION_LIFECYCLE_ATTRIBUTE}="ready"] *:has(> [data-testid="session-snooze-button"]) {
    pointer-events: auto;
  }
  [${SESSION_LIFECYCLE_ATTRIBUTE}="ready"] [role="menu"][aria-label="Snooze session"] [role="menuitem"] {
    min-height: 2.75rem;
  }
}
[${SESSION_LIFECYCLE_ATTRIBUTE}="unsupported"] [data-testid="session-snooze-button"] {
  display: none;
}
`;

/** Press-and-hold duration that stands in for a right-click on touch. */
export const LONG_PRESS_MS = 500;
/** Movement past this is a scroll or a drag, not a press. */
const LONG_PRESS_SLOP_PX = 10;
/** Bounded ancestor walk from the press target up to the session row. */
const CARD_LOOKUP_MAX_DEPTH = 12;
const SNOOZE_BUTTON_SELECTOR = '[data-testid="session-snooze-button"]';
/** Stable root anchor rendered by the shared SessionCard. */
const SESSION_ROW_SELECTOR = "[data-session-row]";

/**
 * The session row a press landed on, or null.
 *
 * `SessionCard` marks its root with `data-session-row`, so prefer that. The
 * ancestor-walk below is a fallback for a row that predates the attribute: the
 * row always renders the lifecycle control as a descendant, so the nearest
 * ancestor containing one IS the row. Walking the DOM (rather than a `:has()`
 * selector) keeps the fallback working on browsers without `:has` support.
 */
function sessionRowFrom(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  // The control opens its own menu; a long press on it is not a row press.
  if (target.closest(SNOOZE_BUTTON_SELECTOR)) return null;
  if (target.closest('[role="menu"], [role="dialog"]')) return null;
  const tagged = target.closest(SESSION_ROW_SELECTOR);
  if (tagged instanceof HTMLElement) return tagged;
  let node: Element | null = target;
  for (let depth = 0; node && depth < CARD_LOOKUP_MAX_DEPTH; depth += 1) {
    if (node instanceof HTMLElement && node.querySelector(SNOOZE_BUTTON_SELECTOR)) return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Bridge press-and-hold to the row's context menu on touch.
 *
 * Settle, Unsettle and Keep active live only in the shared row's context menu,
 * which desktop opens with a right-click. Android fires `contextmenu` on a long
 * press; iOS Safari never does, so on the web those three actions would be
 * unreachable on a phone. Synthesising the event keeps one menu implementation
 * instead of a second, divergent touch menu.
 */
function installLongPressContextMenu(doc: Document): () => void {
  const view = doc.defaultView;
  if (!view || typeof view.matchMedia !== "function") return () => undefined;
  if (!view.matchMedia("(pointer: coarse)").matches) return () => undefined;

  let timer: number | null = null;
  let origin: { x: number; y: number; row: HTMLElement } | null = null;

  const cancel = () => {
    if (timer != null) view.clearTimeout(timer);
    timer = null;
    origin = null;
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "mouse" || !event.isPrimary) return;
    const row = sessionRowFrom(event.target);
    if (!row) return;
    origin = { x: event.clientX, y: event.clientY, row };
    timer = view.setTimeout(() => {
      const pressed = origin;
      cancel();
      if (!pressed) return;
      pressed.row.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 2,
        clientX: pressed.x,
        clientY: pressed.y,
      }));
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!origin) return;
    if (
      Math.abs(event.clientX - origin.x) > LONG_PRESS_SLOP_PX
      || Math.abs(event.clientY - origin.y) > LONG_PRESS_SLOP_PX
    ) {
      cancel();
    }
  };

  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("pointermove", onPointerMove, true);
  doc.addEventListener("pointerup", cancel, true);
  doc.addEventListener("pointercancel", cancel, true);
  doc.addEventListener("scroll", cancel, true);
  return () => {
    cancel();
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("pointermove", onPointerMove, true);
    doc.removeEventListener("pointerup", cancel, true);
    doc.removeEventListener("pointercancel", cancel, true);
    doc.removeEventListener("scroll", cancel, true);
  };
}

function ensureStyleElement(doc: Document): HTMLStyleElement {
  const existing = doc.getElementById(STYLE_ELEMENT_ID);
  if (existing instanceof HTMLStyleElement) return existing;
  const style = doc.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = STYLES;
  doc.head.appendChild(style);
  return style;
}

export function applySessionLifecycleChromeState(
  state: SessionLifecycleChromeState,
  doc: Document = document,
): void {
  doc.documentElement.setAttribute(SESSION_LIFECYCLE_ATTRIBUTE, state);
}

/**
 * Install the stylesheet and keep the capability flag in step with the host.
 * The advertised command list is re-read on every status change because a
 * reconnect (or a machine switch) can land on a different ADE version.
 */
export function installSessionLifecycleChrome(
  client: Pick<AdeSyncClient, "getCommandDescriptors" | "subscribe">,
  doc: Document = document,
): () => void {
  ensureStyleElement(doc);
  const sync = () => {
    applySessionLifecycleChromeState(
      sessionLifecycleSupported(client.getCommandDescriptors()) ? "ready" : "unsupported",
      doc,
    );
  };
  sync();
  const unsubscribe = client.subscribe(sync);
  const uninstallLongPress = installLongPressContextMenu(doc);
  return () => {
    unsubscribe();
    uninstallLongPress();
    doc.documentElement.removeAttribute(SESSION_LIFECYCLE_ATTRIBUTE);
    doc.getElementById(STYLE_ELEMENT_ID)?.remove();
  };
}
