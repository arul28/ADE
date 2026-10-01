/**
 * Marks a control inside a list row that opens its own hover card (the PR pill
 * and its list). The row's detail card stays away while the pointer is on one:
 * two cards at once cover each other and say the same things twice.
 */
export const ROW_HOVER_SUPPRESS_ATTRIBUTE = "data-row-hover-suppress";

export const rowHoverSuppressProps = { [ROW_HOVER_SUPPRESS_ATTRIBUTE]: "" } as const;

const ROW_HOVER_SUPPRESS_SELECTOR = `[${ROW_HOVER_SUPPRESS_ATTRIBUTE}]`;

export function isInsideRowHoverSuppress(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(ROW_HOVER_SUPPRESS_SELECTOR));
}

export function isPointerOnRowHoverSuppress(): boolean {
  return typeof document !== "undefined"
    && Boolean(document.querySelector(`${ROW_HOVER_SUPPRESS_SELECTOR}:hover`));
}
