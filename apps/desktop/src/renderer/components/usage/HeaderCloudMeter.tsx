import { ArrowSquareOut, Gift } from "@phosphor-icons/react";
import {
  CLOUD_DISK_WARN_SHARE,
  cloudCatalogOf,
  cloudEarnedHoursOf,
  cloudHoursLeftMilli,
  cloudPlanLabelOf,
  cloudReferralOf,
  formatCloudDate,
  formatCloudGb,
  formatCloudHours,
  percentOf,
  type CloudAccountState,
} from "../../../shared/adeCloud";
import { navigateToAppTarget } from "../../lib/openExternal";
import { CloudMark } from "../remoteTargets/cloudBrand";
import { cn } from "../ui/cn";
import { USAGE_NUMERIC_CLASS, USAGE_TEXT, usageLeftLevel, usageLeftLevelColor } from "./usageDesign";

/**
 * ADE Cloud's meter, the first one in the header's usage control: the hours
 * work can still use (the plan's left plus earned ones) against this
 * period's. The account comes from `state/cloudAccountStore.ts`.
 *
 * Account level, so no pin. Only an account ADE Cloud lets in sees it.
 */

const RING_SIZE = 22;
const RING_STROKE = 1.5;
const BRAND = "var(--adec-400)";
/** The meter's fill while there's plenty left: the dashboard's dusk gradient. */
const BRAND_FILL = "linear-gradient(90deg, var(--adec-500), var(--adec-rose))";

/**
 * Hours left now and the period's total, both counting earned hours: the
 * plan's included hours plus the earned hours there were at the period's
 * start (left now plus used this period), so the total holds still while
 * earned hours are used.
 */
function hoursOf(state: CloudAccountState): { leftMilli: number; totalMilli: number; earnedMilli: number } {
  const earned = cloudEarnedHoursOf(state);
  return {
    leftMilli: cloudHoursLeftMilli(state),
    totalMilli: Math.max(0, state.hours.includedMilli) + earned.leftMilli + earned.usedThisPeriodMilli,
    earnedMilli: earned.leftMilli,
  };
}

function hoursLeftPct(state: CloudAccountState): number {
  const { leftMilli, totalMilli } = hoursOf(state);
  return totalMilli > 0 ? (leftMilli / totalMilli) * 100 : 0;
}

/** "ADE Cloud 43.8 h of 100 h left" for the control's title. */
export function headerCloudTitle(state: CloudAccountState): string {
  const { leftMilli, totalMilli } = hoursOf(state);
  return `ADE Cloud ${formatCloudHours(leftMilli)} h of ${formatCloudHours(totalMilli)} h left`;
}

/** The ring: hours left in ADE Cloud's violet, amber at 20% left, red at 5%; the pale arc is what's used. */
export function HeaderCloudRing({ state }: { state: CloudAccountState }) {
  const left = Math.max(0, Math.min(100, Math.round(hoursLeftPct(state))));
  const color = usageLeftLevelColor(usageLeftLevel(left), BRAND);
  const used = 100 - left;
  const center = RING_SIZE / 2;
  const radius = (RING_SIZE - RING_STROKE) / 2;
  const circumference = 2 * Math.PI * radius;
  const usedDash = (used / 100) * circumference;
  const unshaded = `color-mix(in srgb, ${color} 12%, var(--color-fg))`;
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: RING_SIZE, height: RING_SIZE }}
      title={headerCloudTitle(state)}
      data-usage-provider="ade-cloud"
      data-usage-left={String(left)}
    >
      <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} aria-hidden="true">
        <circle cx={center} cy={center} r={radius} fill="none" stroke={color} strokeWidth={RING_STROKE} />
        {used > 0 ? (
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={unshaded}
            strokeOpacity={0.35}
            strokeWidth={RING_STROKE}
            strokeDasharray={used >= 100 ? undefined : `${usedDash} ${circumference - usedDash}`}
            transform={`rotate(-90 ${center} ${center})`}
          />
        ) : null}
      </svg>
      <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
        <CloudMark size={13} brand bold />
      </span>
    </span>
  );
}

/** The popover's first panel: hours, when they reset, disk, extra and earned hours, and the way to the dashboard. */
export function HeaderCloudPanel({ state, onNavigate }: { state: CloudAccountState; onNavigate: () => void }) {
  const pct = hoursLeftPct(state);
  const hours = hoursOf(state);
  const diskLimit = state.disk.limitGb ?? 0;
  // The invite card shows only with a referral; with no rewards left there is nothing to invite to.
  const canInvite = (cloudReferralOf(state)?.rewardsLeft ?? 0) > 0;
  const open = (anchor?: string) => {
    onNavigate();
    navigateToAppTarget({ kind: "settings", tab: "ade-cloud", ...(anchor ? { anchor } : {}) });
  };
  return (
    <section className="kit-panel flex flex-col gap-2 px-3 py-2.5" aria-label="ADE Cloud">
      <div className="flex items-center gap-2">
        <CloudMark size={14} brand bold />
        <span className={cn("font-semibold text-fg", USAGE_TEXT.body)}>ADE Cloud</span>
        <span className="adec-plan-word">{cloudPlanLabelOf(state, cloudCatalogOf(state))}</span>
        <span className={cn("ml-auto text-muted-fg", USAGE_TEXT.micro)}>{state.billing.cancelAtPeriodEnd ? "Plan ends" : "Resets"} {formatCloudDate(state.billing.periodEnd)}</span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className={cn("text-[20px] font-medium leading-6 text-fg", USAGE_NUMERIC_CLASS)}>{formatCloudHours(hours.leftMilli)} h</span>
        <span className={cn("text-muted-fg", USAGE_TEXT.micro)}>left of {formatCloudHours(hours.totalMilli)} h this month</span>
      </div>
      <div className="kit-meter" data-level={usageLeftLevel(pct)}><span style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: usageLeftLevel(pct) == null ? BRAND_FILL : undefined }} /></div>
      <div className={cn("flex flex-wrap gap-x-3 gap-y-1 text-muted-fg", USAGE_TEXT.micro)}>
        <span>Disk {formatCloudGb(state.disk.usedGb)}{diskLimit > 0 ? ` of ${formatCloudGb(diskLimit)}` : ""}</span>
        <span>{state.computers.total} {state.computers.total === 1 ? "computer" : "computers"}, {state.computers.awake} awake</span>
        {hours.earnedMilli > 0 ? <span>Includes {formatCloudHours(hours.earnedMilli)} h earned</span> : null}
        {state.extraHours.available ? <span>Extra hours {state.extraHours.enabled ? "on" : "off"}</span> : null}
        {diskLimit > 0 && percentOf(state.disk.usedGb, diskLimit) >= CLOUD_DISK_WARN_SHARE * 100 ? <span className="text-[var(--kit-warn)]">Disk almost full</span> : null}
      </div>
      <div className="flex items-center gap-1.5 pt-0.5">
        <button type="button" className="kit-btn" data-size="sm" onClick={() => open()}>
          Open ADE Cloud <ArrowSquareOut size={11} />
        </button>
        {canInvite ? (
          <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" onClick={() => open("cloud-invite")}>
            <Gift size={12} /> Invite friends, get hours
          </button>
        ) : null}
      </div>
    </section>
  );
}
