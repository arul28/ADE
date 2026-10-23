// Cross-surface signal to open the header Connections panel to a given tab.
// The Account page and other surfaces dispatch this; TopBar owns the panel and
// subscribes. Keeps the panel a header popover while staying openable elsewhere.

export type ConnectionsPanelTab = "machines" | "mobile" | "web";

const OPEN_CONNECTIONS_EVENT = "ade:open-connections-panel";

export type OpenConnectionsPanelOptions = { tab?: ConnectionsPanelTab; machineId?: string };

export function openConnectionsPanel(tabOrOptions: ConnectionsPanelTab | OpenConnectionsPanelOptions = "machines"): void {
  const detail = typeof tabOrOptions === "string" ? { tab: tabOrOptions } : { tab: "machines" as const, ...tabOrOptions };
  window.dispatchEvent(
    new CustomEvent(OPEN_CONNECTIONS_EVENT, { detail }),
  );
}

export function subscribeOpenConnectionsPanel(
  cb: (tab: ConnectionsPanelTab, machineId?: string) => void,
): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<OpenConnectionsPanelOptions>).detail;
    cb(detail?.tab ?? "machines", detail?.machineId);
  };
  window.addEventListener(OPEN_CONNECTIONS_EVENT, handler);
  return () => window.removeEventListener(OPEN_CONNECTIONS_EVENT, handler);
}
