import type { CloudAgentProvider } from "../../shared/types";

/**
 * Open a cloud's agents panel from anywhere (the composer's menu, a chat
 * header). The top-bar button owns the panel, so this only asks it to open.
 */
const OPEN_CLOUD_AGENTS_EVENT = "ade:open-cloud-agents";

export function openCloudAgentsPanel(provider: CloudAgentProvider): void {
  window.dispatchEvent(new CustomEvent<{ provider: CloudAgentProvider }>(OPEN_CLOUD_AGENTS_EVENT, { detail: { provider } }));
}

export function subscribeOpenCloudAgentsPanel(provider: CloudAgentProvider, listener: () => void): () => void {
  const handler = (event: Event) => {
    if ((event as CustomEvent<{ provider?: CloudAgentProvider }>).detail?.provider === provider) listener();
  };
  window.addEventListener(OPEN_CLOUD_AGENTS_EVENT, handler);
  return () => window.removeEventListener(OPEN_CLOUD_AGENTS_EVENT, handler);
}
