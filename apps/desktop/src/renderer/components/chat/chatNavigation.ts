export function openExternalMcpSettings(): void {
  if (typeof window === "undefined") return;
  window.history.pushState({}, "", "/settings?tab=integrations");
  window.dispatchEvent(new PopStateEvent("popstate"));
}
