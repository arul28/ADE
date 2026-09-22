import { expect } from "vitest";

/**
 * The render check §B asks for, honestly labelled.
 *
 * jsdom has NO layout engine: every `getBoundingClientRect()` in these tests
 * returns zeros, so "does this element overflow its parent" cannot be measured
 * here and a test that claimed to measure it would be measuring nothing. What
 * this does instead is assert the four declarations that actually PRODUCE
 * horizontal overflow in this pane, at a stated container width:
 *
 * 1. A hard pixel width (class or inline) wider than the container.
 * 2. A grid whose auto-fit track minimum is not clamped to `min(100%, …)` —
 *    the exact bug `WorkToolPicker` documents: below one card's width the
 *    track stops shrinking and the row runs off the right edge.
 * 3. A `flex-1` box with no `min-w-0`. A flex item's default `min-width` is
 *    `auto`, so one long device name ("iPhone 17 Pro Max (2nd generation)")
 *    pushes the whole row wider than the pane.
 * 4. `whitespace-nowrap` on a box that is supposed to grow.
 *
 * Any real pixel measurement belongs in the live app, which Unit F owns.
 */
export function expectNoHorizontalOverflow(container: HTMLElement, width: number): void {
  container.style.width = `${width}px`;
  const offenders: string[] = [];
  const note = (element: Element, reason: string) => {
    const classes = element.getAttribute("class") ?? "";
    offenders.push(`<${element.tagName.toLowerCase()} class="${classes.slice(0, 120)}"> ${reason}`);
  };

  for (const element of [container, ...container.querySelectorAll("*")]) {
    if (!(element instanceof HTMLElement)) continue;
    const classes = element.getAttribute("class") ?? "";

    for (const match of classes.matchAll(/(?:^|\s)(?:min-)?w-\[(\d+(?:\.\d+)?)px\]/gu)) {
      const px = Number(match[1]);
      if (px > width) note(element, `declares ${match[0].trim()} inside ${width}px`);
    }

    for (const property of ["width", "minWidth"] as const) {
      const value = element.style[property];
      const px = /^(\d+(?:\.\d+)?)px$/u.exec(value);
      if (px && Number(px[1]) > width) note(element, `style.${property}=${value} inside ${width}px`);
    }

    const template = element.style.gridTemplateColumns;
    if (template.includes("minmax(") && !template.includes("min(100%")) {
      note(element, `grid track minimum is not clamped: ${template}`);
    }

    const has = (name: string) => new RegExp(`(?:^|\\s)${name}(?:\\s|$)`, "u").test(classes);
    if (has("flex-1") && !has("min-w-0")) note(element, "flex-1 without min-w-0");
    if (has("whitespace-nowrap") && (has("flex-1") || has("w-full"))) {
      note(element, "whitespace-nowrap on a growing box");
    }
  }

  expect(offenders, `horizontal overflow risks at ${width}px`).toEqual([]);
}
