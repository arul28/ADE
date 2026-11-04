import { useCallback, useEffect, useState } from "react";
import type { Agent37TemplateStatus } from "../../../shared/agent37";

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  // IPC wraps a main-process throw as "Error invoking remote method '…': Error: <message>".
  return raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "").trim();
}

/**
 * ADE's template in the Agent 37 workspace, live. Account-wide like the key,
 * so it asks this desktop's own main process (no pin). `enabled` is false
 * while no key is connected, so nothing is asked for.
 *
 * `loadError` is set when ADE couldn't ask at all (the call failed), which is
 * not the same as a template that is still being checked; `retry` asks again.
 */
export function useAgent37Template(enabled: boolean): {
  status: Agent37TemplateStatus | null;
  loadError: string | null;
  retry: () => void;
} {
  const [status, setStatus] = useState<Agent37TemplateStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const bridge = window.ade.agent37;
    if (!bridge || !enabled) {
      setStatus(null);
      setLoadError(null);
      return;
    }
    let live = true;
    const off = bridge.onTemplateStatus((next) => {
      if (!live) return;
      setStatus(next);
      setLoadError(null);
    });
    void bridge.getTemplateStatus().then((next) => {
      if (!live) return;
      if (next) {
        setStatus((current) => current ?? next);
        setLoadError(null);
      } else {
        setLoadError("ADE couldn't read the template's state.");
      }
    }, (error: unknown) => {
      if (live) setLoadError(errorText(error) || "ADE couldn't read the template's state.");
    });
    return () => {
      live = false;
      off();
    };
  }, [enabled, attempt]);

  const retry = useCallback(() => {
    const bridge = window.ade.agent37;
    if (!bridge) return;
    setLoadError(null);
    void bridge.retryTemplate().then((next) => {
      if (next) setStatus(next);
      // The build may have been fine and only the read failed: read again too.
      setAttempt((value) => value + 1);
    }, (error: unknown) => {
      setLoadError(errorText(error) || "ADE couldn't ask for the template again.");
    });
  }, []);

  return { status, loadError, retry };
}

/** "in 4 min" for the next automatic try. */
export function agent37RetryLabel(nextRetryAt: number | null): string | null {
  if (nextRetryAt == null) return null;
  const minutes = Math.max(1, Math.round((nextRetryAt - Date.now()) / 60_000));
  return `ADE tries again in about ${minutes} min.`;
}
