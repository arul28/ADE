// Cross-surface signal to open the header Connections panel to a given tab.
// The Account page and other surfaces dispatch this; TopBar owns the panel and
// subscribes. Keeps the panel a header popover while staying openable elsewhere.

export type ConnectionsPanelTab = "machines" | "mobile" | "web";

const OPEN_CONNECTIONS_EVENT = "ade:open-connections-panel";

export function openConnectionsPanel(tab: ConnectionsPanelTab = "machines"): void {
  window.dispatchEvent(
    new CustomEvent(OPEN_CONNECTIONS_EVENT, { detail: { tab } }),
  );
}

export function subscribeOpenConnectionsPanel(
  cb: (tab: ConnectionsPanelTab) => void,
): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ tab?: ConnectionsPanelTab }>).detail;
    cb(detail?.tab ?? "machines");
  };
  window.addEventListener(OPEN_CONNECTIONS_EVENT, handler);
  return () => window.removeEventListener(OPEN_CONNECTIONS_EVENT, handler);
}
