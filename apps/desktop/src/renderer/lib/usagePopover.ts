// Cross-surface signal to open the top-bar usage popover. The header chip owns
// the popover and claims the request; when no chip is mounted (the status
// controls collapsed into the overflow menu), the caller gets `false` back and
// picks its own fallback.

const OPEN_USAGE_POPOVER_EVENT = "ade:open-usage-popover";

/** True when a mounted usage chip opened its popover. */
export function requestUsagePopover(): boolean {
  const event = new Event(OPEN_USAGE_POPOVER_EVENT, { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

export function subscribeUsagePopoverRequests(open: () => void): () => void {
  const handler = (event: Event) => {
    event.preventDefault();
    open();
  };
  window.addEventListener(OPEN_USAGE_POPOVER_EVENT, handler);
  return () => window.removeEventListener(OPEN_USAGE_POPOVER_EVENT, handler);
}
