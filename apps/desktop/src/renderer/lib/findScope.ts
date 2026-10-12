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
import { isMac } from "./platform";

export const FIND_SCOPE_ATTRIBUTE = "data-ade-find-scope";

/**
 * ⌘<key> on a Mac, Ctrl+<key> elsewhere, without Alt. Ctrl on a Mac is left
 * alone: Ctrl-F and Ctrl-G edit text there.
 */
export function isFindChord(event: KeyboardEvent, key: string): boolean {
  if (event.altKey || event.key.toLowerCase() !== key) return false;
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

let lastPointerTarget: Element | null = null;
let trackingInstalled = false;

function ensureTracking(): void {
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
export function closestFindScope(node: Node | null): Element | null {
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
 * focus is on nothing in particular.
 */
export function currentFindTarget(): Element | null {
  ensureTracking();
  const active = deepActiveElement();
  if (active && active !== document.body && active !== document.documentElement) return active;
  return lastPointerTarget?.isConnected ? lastPointerTarget : null;
}

/** True when `scope` is the innermost find scope around where the user is. */
export function findScopeOwnsTarget(scope: Element | null): boolean {
  if (!scope || !scope.isConnected) return false;
  return closestFindScope(currentFindTarget()) === scope;
}

/**
 * True when the user last pressed inside a find scope other than `scope` (and
 * not inside `scope` itself). Lets a surface that takes ⌘F "when focus is
 * nowhere" step aside for the text the user just clicked.
 */
export function lastPointerInOtherFindScope(scope: Element): boolean {
  ensureTracking();
  if (!lastPointerTarget?.isConnected) return false;
  const owner = closestFindScope(lastPointerTarget);
  return owner != null && owner !== scope && !scope.contains(owner);
}

/** Start tracking presses early, so the first ⌘F already knows the last click. */
export function installFindTargetTracking(): void {
  ensureTracking();
}
