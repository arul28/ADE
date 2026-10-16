/**
 * Page visibility for the web adapter's pollers. Each poll re-reads the host
 * over the relay, so a hidden tab pauses it and becoming visible resumes it
 * with an immediate read. Without a `document` (Node tests) the page counts as
 * visible, so pollers run as they always did.
 */

export function isPageHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

export function observePageVisibility(handlers: { onHidden: () => void; onVisible: () => void }): () => void {
  if (typeof document === "undefined") return () => {};
  const onChange = () => {
    if (document.visibilityState === "hidden") handlers.onHidden();
    else handlers.onVisible();
  };
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}
