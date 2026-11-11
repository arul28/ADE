import { useEffect, useSyncExternalStore } from "react";
import { ArrowSquareOut, Gift } from "@phosphor-icons/react";
import { formatCloudDate, formatCloudHours, type CloudAccountState } from "../../../shared/adeCloud";
import { navigateToAppTarget } from "../../lib/openExternal";
import { useAdeCloudEnabled } from "../../state/cloudAccess";
import { CloudMark } from "../remoteTargets/cloudBrand";
import { earnedHoursLeftMilli, formatGb, percentOf } from "../settings/cloudDashboard/cloudDashboardModel";
import { cn } from "../ui/cn";
import { USAGE_NUMERIC_CLASS, USAGE_TEXT, usageLeftLevel, usageLeftLevelColor } from "./usageDesign";

/**
 * ADE Cloud's meter, the first one in the header's usage control: this
 * month's hours against the plan. One account read (the server's computer
 * list, which wakes nothing) when ADE Cloud turns on, then every 5 minutes
 * and when ADE Cloud says something changed. Never on focus or on a fast
 * timer: the header is always on screen.
 *
 * Account level, so no pin. Only an account ADE Cloud lets in sees it.
 */

const REFRESH_MS = 5 * 60_000;
const RING_SIZE = 22;
const RING_STROKE = 1.5;
const BRAND = "var(--adec-400)";

let account: CloudAccountState | null = null;
let timer: number | null = null;
let offStatus: (() => void) | null = null;
let reading = false;
const listeners = new Set<() => void>();

function read(): void {
  const list = typeof window === "undefined" ? undefined : window.ade?.cloud?.listMachines;
  if (!list || reading) return;
  reading = true;
  void list().then(
    (result) => {
      const next = result?.state === "ok" ? result.account ?? null : null;
      if (next !== account) {
        account = next;
        for (const listener of listeners) listener();
      }
    },
    () => undefined,
  ).finally(() => {
    reading = false;
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    read();
    timer = window.setInterval(read, REFRESH_MS);
    offStatus = window.ade?.cloud?.onStatusChanged?.(read) ?? null;
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    if (timer != null) window.clearInterval(timer);
    timer = null;
    offStatus?.();
    offStatus = null;
  };
}

const snapshot = () => account;
const noop = () => () => undefined;
const none = () => null;

/** The account behind the meter while ADE Cloud is on; null while off, or before the first read. */
export function useHeaderCloudAccount(): CloudAccountState | null {
  const enabled = useAdeCloudEnabled();
  const value = useSyncExternalStore(enabled ? subscribe : noop, enabled ? snapshot : none, none);
  // A sign-out or lost access drops the last answer at once.
  useEffect(() => {
    if (!enabled) account = null;
  }, [enabled]);
  return enabled ? value : null;
}

function hoursLeftPct(state: CloudAccountState): number {
  return state.hours.includedMilli > 0 ? (state.hours.leftMilli / state.hours.includedMilli) * 100 : 0;
}

/** "ADE Cloud 43.8 h of 50 h left" for the control's title. */
export function headerCloudTitle(state: CloudAccountState): string {
  return `ADE Cloud ${formatCloudHours(state.hours.leftMilli)} h of ${formatCloudHours(state.hours.includedMilli)} h left`;
}

/** The ring: hours left in ADE Cloud's blue, amber at 20% left, red at 5%; the pale arc is what's used. */
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
  const earned = earnedHoursLeftMilli(state);
  const diskLimit = state.disk.limitGb ?? 0;
  const open = (anchor?: string) => {
    onNavigate();
    navigateToAppTarget({ kind: "settings", tab: "ade-cloud", ...(anchor ? { anchor } : {}) });
  };
  return (
    <section className="kit-panel flex flex-col gap-2 px-3 py-2.5" aria-label="ADE Cloud">
      <div className="flex items-center gap-2">
        <CloudMark size={14} brand bold />
        <span className={cn("font-semibold text-fg", USAGE_TEXT.body)}>ADE Cloud</span>
        <span className={cn("ml-auto text-muted-fg", USAGE_TEXT.micro)}>Resets {formatCloudDate(state.billing.periodEnd)}</span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className={cn("text-[20px] font-medium leading-6 text-fg", USAGE_NUMERIC_CLASS)}>{formatCloudHours(state.hours.leftMilli)} h</span>
        <span className={cn("text-muted-fg", USAGE_TEXT.micro)}>left of {formatCloudHours(state.hours.includedMilli)} h this month</span>
      </div>
      <div className="kit-meter" data-level={usageLeftLevel(pct)}><span style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: usageLeftLevel(pct) == null ? BRAND : undefined }} /></div>
      <div className={cn("flex flex-wrap gap-x-3 gap-y-1 text-muted-fg", USAGE_TEXT.micro)}>
        <span>Disk {formatGb(state.disk.usedGb)}{diskLimit > 0 ? ` of ${formatGb(diskLimit)}` : ""}</span>
        <span>{state.computers.total} of {state.computers.limit} computers</span>
        {earned != null && earned > 0 ? <span>+{formatCloudHours(earned)} h earned</span> : null}
        {state.extraHours.available ? <span>Extra hours {state.extraHours.enabled ? "on" : "off"}</span> : null}
        {diskLimit > 0 && percentOf(state.disk.usedGb, diskLimit) >= 80 ? <span className="text-[var(--color-warning)]">Disk almost full</span> : null}
      </div>
      <div className="flex items-center gap-1.5 pt-0.5">
        <button type="button" className="kit-btn" data-size="sm" onClick={() => open()}>
          Open ADE Cloud <ArrowSquareOut size={11} />
        </button>
        <button type="button" className="kit-btn kit-btn-ghost" data-size="sm" onClick={() => open("cloud-invite")}>
          <Gift size={12} /> Invite friends, get hours
        </button>
      </div>
    </section>
  );
}
