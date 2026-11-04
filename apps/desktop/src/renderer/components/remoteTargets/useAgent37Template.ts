import { useCallback, useEffect, useState } from "react";
import type { Agent37TemplateStatus } from "../../../shared/agent37";

/**
 * ADE's template in the Agent 37 workspace, live. Account-wide like the key,
 * so it asks this desktop's own main process (no pin). `enabled` is false
 * while no key is connected, so nothing is asked for.
 */
export function useAgent37Template(enabled: boolean): {
  status: Agent37TemplateStatus | null;
  retry: () => void;
} {
  const [status, setStatus] = useState<Agent37TemplateStatus | null>(null);

  useEffect(() => {
    const bridge = window.ade.agent37;
    if (!bridge || !enabled) {
      setStatus(null);
      return;
    }
    let live = true;
    const off = bridge.onTemplateStatus((next) => {
      if (live) setStatus(next);
    });
    void bridge.getTemplateStatus().then((next) => {
      if (live && next) setStatus((current) => current ?? next);
    }).catch(() => undefined);
    return () => {
      live = false;
      off();
    };
  }, [enabled]);

  const retry = useCallback(() => {
    void window.ade.agent37?.retryTemplate().then((next) => {
      if (next) setStatus(next);
    }).catch(() => undefined);
  }, []);

  return { status, retry };
}

/** "in 4 min" for the next automatic try. */
export function agent37RetryLabel(nextRetryAt: number | null): string | null {
  if (nextRetryAt == null) return null;
  const minutes = Math.max(1, Math.round((nextRetryAt - Date.now()) / 60_000));
  return `ADE tries again in about ${minutes} min.`;
}
