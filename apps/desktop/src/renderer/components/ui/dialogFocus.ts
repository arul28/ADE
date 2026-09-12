/**
 * What can be tabbed to inside a dialog.
 *
 * The traps that read THIS module share one selector and one set of visibility
 * rules, so `HeaderSheet` and `AutoHandoffModal` cannot quietly disagree about
 * whether a `<summary>`, an `[aria-hidden]` subtree or a closed `<details>` is
 * reachable. Kept as a plain module rather than a hook because the two shapes
 * differ — `HeaderSheet`'s trap is a hook, `AutoHandoffModal`'s is a
 * window-level handler — and both need the same list.
 *
 * Not yet the app's only answer: `providerSectionPrimitives`,
 * `StorageCleanupDialog`, `ChatAttachmentPreviewModal` and `LanePrHoverCard`
 * still carry their own selector lists. Converging them is a separate change;
 * this note is here so the next reader knows there is something left to do.
 */
export const DIALOG_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "summary",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR),
  ).filter((element) => {
    const closedDetails = element.closest<HTMLDetailsElement>(
      "details:not([open])",
    );
    const isClosedDetailsSummary =
      closedDetails?.querySelector(":scope > summary") === element;
    return (
      !element.closest('[hidden], [aria-hidden="true"]') &&
      (!closedDetails || isClosedDetailsSummary) &&
      !element.hasAttribute("disabled") &&
      element.tabIndex >= 0
    );
  });
}
