import { useEffect, useState } from "react";

export type ChatMcpSummary = {
  configuredCount: number;
  connectedCount: number;
};

let cachedSummary: ChatMcpSummary | null = null;
let summaryPromise: Promise<ChatMcpSummary> | null = null;

async function fetchChatMcpSummary(): Promise<ChatMcpSummary> {
  if (cachedSummary) return cachedSummary;
  if (!window.ade?.externalMcp) {
    return { configuredCount: 0, connectedCount: 0 };
  }
  if (!summaryPromise) {
    summaryPromise = Promise.all([
      window.ade.externalMcp.listConfigs().catch(() => []),
      window.ade.externalMcp.listServers().catch(() => []),
    ])
      .then(([configs, servers]) => {
        const next = {
          configuredCount: configs.length,
          connectedCount: servers.filter((server) => server.state === "connected").length,
        };
        cachedSummary = next;
        return next;
      })
      .finally(() => {
        summaryPromise = null;
      });
  }
  return summaryPromise;
}

export function useChatMcpSummary(enabled = true): ChatMcpSummary | null {
  const [summary, setSummary] = useState<ChatMcpSummary | null>(cachedSummary);

  useEffect(() => {
    if (!enabled || !window.ade?.externalMcp) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    if (cachedSummary) {
      setSummary(cachedSummary);
      return () => {
        cancelled = true;
      };
    }
    void fetchChatMcpSummary().then((next) => {
      if (cancelled) return;
      setSummary(next);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return summary;
}
