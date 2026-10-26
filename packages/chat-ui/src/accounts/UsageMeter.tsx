import type { AccountUsage } from "../sdkTypes";

export type UsageMeterProps = {
  usage: AccountUsage;
  label?: string;
  className?: string;
};

export function UsageMeter({ usage, label = "Usage", className }: UsageMeterProps) {
  const percent = Number.isFinite(usage.percent)
    ? Math.max(0, Math.min(100, usage.percent!))
    : Number.isFinite(usage.used) && Number.isFinite(usage.limit) && usage.limit! > 0
      ? Math.max(0, Math.min(100, usage.used! / usage.limit! * 100))
      : null;
  const summary = usage.used !== undefined && usage.limit !== undefined
    ? `${format(usage.used)} of ${format(usage.limit)}`
    : usage.remaining !== undefined ? `${format(usage.remaining)} remaining` : null;

  return (
    <div className={["adechat-usage-meter", className].filter(Boolean).join(" ")}>
      <div className="adechat-usage-meter-label"><span>{label}</span>{summary ? <span>{summary}</span> : null}</div>
      {percent !== null ? (
        <div className="adechat-usage-meter-track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
          <span style={{ width: `${percent}%` }} />
        </div>
      ) : null}
      {usage.resetAt ? <small className="adechat-usage-meter-reset">Resets {new Date(usage.resetAt).toLocaleString()}</small> : null}
    </div>
  );
}

function format(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
}
