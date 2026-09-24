/**
 * Scrollbars stay invisible until you scroll. While an element scrolls it
 * carries `data-ade-scrolling`, and the CSS in index.css paints its thumb only
 * while it has that attribute and the pointer is over it. The attribute
 * clears a moment after the last scroll event.
 *
 * One capture-phase listener on the document sees every element's scroll
 * (scroll events do not bubble, but they do pass the capture phase), so no
 * component has to opt in. Native scrolling is untouched.
 */

export const SCROLLING_ATTRIBUTE = "data-ade-scrolling";
const SCROLLING_LINGER_MS = 800;

const clearTimers = new WeakMap<Element, number>();
let installed = false;

function markScrolling(element: Element): void {
  if (!element.hasAttribute(SCROLLING_ATTRIBUTE)) element.setAttribute(SCROLLING_ATTRIBUTE, "");
  const pending = clearTimers.get(element);
  if (pending !== undefined) window.clearTimeout(pending);
  clearTimers.set(
    element,
    window.setTimeout(() => {
      clearTimers.delete(element);
      element.removeAttribute(SCROLLING_ATTRIBUTE);
    }, SCROLLING_LINGER_MS),
  );
}

function handleScroll(event: Event): void {
  const target = event.target;
  if (target instanceof Element) markScrolling(target);
  else if (target === document) markScrolling(document.documentElement);
}

/** Installs the document listener once. Safe to call more than once. */
export function installScrollingIndicator(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("scroll", handleScroll, { capture: true, passive: true });
}
