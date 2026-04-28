export const PROJECT_BROWSER_CLOSE_EVENT = "ade:project-browser-close";

export function requestProjectBrowserClose(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(PROJECT_BROWSER_CLOSE_EVENT));
}
