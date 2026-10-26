import { useState } from "react";

import type { UsageLimitStatus } from "./sdkTypes";

export type UsageLimitNoticeProps = {
  status: UsageLimitStatus | null;
  onResumeNow?: () => void | Promise<void>;
  onContinueOnAlternate?: () => void | Promise<void>;
};

export function UsageLimitNotice({ status, onResumeNow, onContinueOnAlternate }: UsageLimitNoticeProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!status) return null;

  const alternate = status.alternateAccount ?? (status.alternateAccounts?.[0]
    ? {
        instanceId: status.alternateAccounts[0]!.id,
        label: status.alternateAccounts[0]!.label,
      }
    : null);
  const resumeLabel = status.state === "resuming" ? "Resume scheduled" : "Resume now";
  const run = async (action: (() => void | Promise<void>) | undefined) => {
    if (!action || busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="adechat-usage-limit" role="status" aria-live="polite">
      <div className="adechat-usage-limit-copy">
        <strong>Usage limit reached</strong>
        <span>{status.resetAt ? `Resets ${new Date(status.resetAt).toLocaleString()}` : "This conversation is waiting for usage room."}</span>
      </div>
      <div className="adechat-usage-limit-actions">
        {onResumeNow ? (
          <button type="button" className="adechat-button" disabled={busy} onClick={() => void run(onResumeNow)}>{busy ? "Working…" : resumeLabel}</button>
        ) : null}
        {alternate && onContinueOnAlternate ? (
          <button type="button" className="adechat-button" data-variant="primary" disabled={busy} onClick={() => void run(onContinueOnAlternate)}>
            Continue on {alternate.label}
          </button>
        ) : null}
      </div>
      {error ? <span className="adechat-usage-limit-error" role="alert">Could not continue: {error}</span> : null}
    </aside>
  );
}
