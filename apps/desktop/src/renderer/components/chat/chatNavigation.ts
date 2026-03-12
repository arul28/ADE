export function openExternalMcpSettings(): void {
  if (typeof window === "undefined") return;
  window.history.pushState({}, "", "/settings?tab=external-mcp");
  window.dispatchEvent(new PopStateEvent("popstate"));
}
