/**
 * Which surface ⌘F belongs to.
 *
 * Several surfaces answer `find` (the chat transcript, every diff, the code
 * editor, the built-in browser), and they nest: a diff panel sits inside the
 * chat pane. Each one marks its root with `data-ade-find-scope`, and the
 * innermost scope around "where the user is" wins.
 *
 * "Where the user is" is the focused element when there is one. Clicking
 * plain text (a transcript reply, a diff line) focuses nothing, so the last
 * pointer press stands in for it. Diff lines live in open shadow roots, so
 * both walks cross shadow boundaries.
 */
import { isInParkedSurface } from "./parkedSurface";

const FIND_SCOPE_ATTRIBUTE = "data-ade-find-scope";

/**
 * A surface marks its root `data-ade-find-scope="<name>"`, written literally in
 * its JSX: `chat-pane` (a whole chat pane, composer included),
 * `chat-transcript`, `diff`, `diff-editor`, `code-editor`, `browser`.
 */
const CHAT_PANE_SCOPE_SELECTOR = `[${FIND_SCOPE_ATTRIBUTE}="chat-pane"]`;

/** The chat pane around `element` (composer included), when there is one. */
export function chatPaneOf(element: Element | null): Element | null {
  return element?.closest(CHAT_PANE_SCOPE_SELECTOR) ?? null;
}

/** Elements (and their subtree) that find never searches: hover actions, cards, attachments. */
export const FIND_SKIP_ATTRIBUTE = "data-ade-find-skip";

/**
 * A button whose label is content, not chrome (a file link in a reply). Find
 * skips buttons — Copy, close, expand — unless they carry this.
 */
export const FIND_INCLUDE_ATTRIBUTE = "data-ade-find-include";

let lastPointerTarget: Element | null = null;
let trackingInstalled = false;

/** Start tracking presses (idempotent). Called by every claimant, so the first ⌘F already knows the last click. */
export function trackFindTargets(): void {
  if (trackingInstalled || typeof document === "undefined") return;
  trackingInstalled = true;
  document.addEventListener(
    "pointerdown",
    (event) => {
      const origin = event.composedPath()[0];
      lastPointerTarget = origin instanceof Element ? origin : event.target instanceof Element ? event.target : null;
    },
    { capture: true, passive: true },
  );
}

/** Parent across a shadow boundary: a shadow root's parent is its host. */
function composedParent(node: Node): Node | null {
  if (node.parentNode instanceof ShadowRoot) return node.parentNode.host;
  return node.parentNode;
}

/** The nearest element marked as a find scope, crossing shadow roots. */
function closestFindScope(node: Node | null): Element | null {
  for (let current = node; current; current = composedParent(current)) {
    if (current instanceof Element && current.hasAttribute(FIND_SCOPE_ATTRIBUTE)) return current;
  }
  return null;
}

function deepActiveElement(): Element | null {
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

/**
 * Where the user is: the focused element, or the last thing they pressed when
 * focus is on nothing in particular. Null before the first press with nothing focused.
 */
function currentFindTarget(): Element | null {
  trackFindTargets();
  const active = deepActiveElement();
  if (active && active !== document.body && active !== document.documentElement) return active;
  return lastPointerTarget?.isConnected ? lastPointerTarget : null;
}

/** Mounted and on screen: not detached, not in a parked or inert surface. */
export function isLiveFindScope(scope: Element | null): scope is Element {
  return Boolean(scope && scope.isConnected && !isInParkedSurface(scope));
}

/** True when `scope` is live and the innermost find scope around where the user is. */
export function findScopeOwnsTarget(scope: Element | null): boolean {
  if (!isLiveFindScope(scope)) return false;
  return closestFindScope(currentFindTarget()) === scope;
}

/**
 * True when the user is somewhere known and it belongs to another find scope.
 * Lets a surface that takes ⌘F "when focus is nowhere" (the built-in browser,
 * whose page is a separate WebContents) step aside for the text the user just
 * clicked.
 */
export function findTargetIsElsewhere(scope: Element): boolean {
  const target = currentFindTarget();
  if (!target || scope.contains(target)) return false;
  const owner = closestFindScope(target);
  // A parked owner is off screen: the user is nowhere, not elsewhere.
  return owner != null && isLiveFindScope(owner) && owner !== scope && !scope.contains(owner);
}
