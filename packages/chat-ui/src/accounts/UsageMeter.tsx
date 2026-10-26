import type { AccountUsage, AccountUsageWindow } from "../sdkTypes";

export type UsageMeterProps = {
  usage: AccountUsage;
  label?: string;
  className?: string;
};

/** One bar per quota window, filled by the share still left. */
export function UsageMeter({ usage, label = "Usage", className }: UsageMeterProps) {
  return (
    <div className={["adechat-usage-meter", className].filter(Boolean).join(" ")} aria-label={label}>
      {usage.windows.map((window) => <UsageWindow key={window.type} window={window} />)}
      {usage.state !== "ok" && usage.note ? <small className="adechat-usage-meter-reset">{usage.note}</small> : null}
    </div>
  );
}

function UsageWindow({ window }: { window: AccountUsageWindow }) {
  const percent = window.unlimited ? 100 : Math.max(0, Math.min(100, window.percentLeft));
  const summary = window.unlimited
    ? "Unlimited"
    : window.countLeft !== undefined && window.countTotal !== undefined
      ? `${window.countLeft} of ${window.countTotal} left`
      : `${Math.round(percent)}% left`;
  return (
    <>
      <div className="adechat-usage-meter-label"><span>{window.label}</span><span>{summary}</span></div>
      <div
        className="adechat-usage-meter-track"
        role="meter"
        aria-label={`${window.label} left`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      {window.resetsAt ? <small className="adechat-usage-meter-reset">Resets {new Date(window.resetsAt).toLocaleString()}</small> : null}
    </>
  );
}
