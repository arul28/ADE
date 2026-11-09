import { useCallback, useState } from "react";
import { showToast } from "../app/toast/toastStore";

/**
 * The Push all work to GitHub button. Used on the 0-hours states and the 30-day
 * warnings. Account-level: it names the computer.
 */
export function PushAllWorkButton({ instanceId, className }: { instanceId: string; className?: string }) {
  const [pushing, setPushing] = useState(false);
  const run = useCallback(() => {
    const push = window.ade.cloud?.pushAllWork;
    if (!push) return;
    setPushing(true);
    void push(instanceId).then(
      (result) => showToast({ tone: result.ok ? "success" : "error", title: result.ok ? "Pushed all work" : "Couldn't push all work", message: result.message }),
      (error: unknown) => showToast({ tone: "error", title: "Couldn't push all work", message: error instanceof Error ? error.message : "ADE couldn't push the work. Try again." }),
    ).finally(() => setPushing(false));
  }, [instanceId]);
  return (
    <span className={className}>
      <button type="button" className="ade-modern-btn" data-size="sm" disabled={pushing} onClick={run}>
        {pushing ? "Pushing all work…" : "Push all work to GitHub"}
      </button>
    </span>
  );
}
