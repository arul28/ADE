export function openExternalMcpSettings(): void {
  if (typeof window === "undefined") return;
  window.history.pushState({}, "", "/settings?tab=integrations&integration=managed-mcp");
  window.dispatchEvent(new PopStateEvent("popstate"));
}
