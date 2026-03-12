import { useEffect, useState } from "react";

export type ChatMcpSummary = {
  configuredCount: number;
  connectedCount: number;
};

export function useChatMcpSummary(enabled = true): ChatMcpSummary | null {
  const [summary, setSummary] = useState<ChatMcpSummary | null>(null);

  useEffect(() => {
    if (!enabled || !window.ade?.externalMcp) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    void Promise.all([
      window.ade.externalMcp.listConfigs().catch(() => []),
      window.ade.externalMcp.listServers().catch(() => []),
    ]).then(([configs, servers]) => {
      if (cancelled) return;
      setSummary({
        configuredCount: configs.length,
        connectedCount: servers.filter((server) => server.state === "connected").length,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return summary;
}
