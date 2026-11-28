import { Smartphone } from "lucide-react";
import { AppleMark } from "../home/marks";
import { HOURLY_SIZES, PHONE_CREDITS_PER_MINUTE, SMALL_SIZE, UNIT, formatCount, hoursOnSize, type PricingPlan } from "../../lib/cloudPricing";
import { cn } from "../../lib/cn";
import type { PricingView } from "../../lib/pricingView";

/**
 * What a plan gets: the Small Linux box on its own line (it never comes out
 * of the credits), then the month's credits and how far they go on each
 * bigger machine, or on the iPhone, if they all went to that one.
 */
export function PlanAllowance({ plan, free, view }: { plan: PricingPlan; free: boolean; view: PricingView }) {
  if (!view.v3) {
    return (
      <div className="mt-6 border-t border-white/[0.08] pt-5">
        <ul>
          <AllowanceRow name={SMALL_SIZE.machine} detail={SMALL_SIZE.specs} value="Unlimited" unit={free ? "with ads on" : "free"} free />
        </ul>
        <p className="mt-5 flex items-baseline gap-2">
          <span className="font-display text-[34px] leading-none text-white tabular-nums">{formatCount(plan.hours)}</span>
          <span className="text-[15px] text-white/70">{UNIT.many} a month</span>
        </p>
        <p className="mt-1 text-[13px] text-white/45">Enough for up to</p>
        <ul className="mt-1">
          {HOURLY_SIZES.map((size) => (
            <AllowanceRow key={size.id} name={size.machine} detail={size.specs} value={formatCount(hoursOnSize(plan.hours, size) ?? 0)} unit="h" />
          ))}
          <AllowanceRow name="iOS Simulator" detail="No Mac needed" value={formatCount(Math.floor(plan.hours / PHONE_CREDITS_PER_MINUTE))} unit="min" phone />
        </ul>
      </div>
    );
  }
  return (
    <div className="mt-6 border-t border-white/[0.08] pt-5">
      <ul>
        {!free ? (
          <AllowanceRow name={SMALL_SIZE.label} detail={`Linux, ${SMALL_SIZE.specs}`} value="Unlimited" unit="free" free even tall={view.ads != null} />
        ) : view.withAds ? (
          <AllowanceRow name={SMALL_SIZE.label} detail={`Linux, ${SMALL_SIZE.specs}`} value="Unlimited" unit="free with ads" free even tall note={`${formatCount(view.freeSmall.struck ?? 0)} ${UNIT.many} an hour with no ads`} />
        ) : (
          <AllowanceRow name={SMALL_SIZE.label} detail={`Linux, ${SMALL_SIZE.specs}`} value={formatCount(view.freeSmall.now)} unit={`${UNIT.many} an hour`} stacked even tall={view.ads != null} note={view.ads ? "Free with ads" : undefined} />
        )}
      </ul>
      <p className="mt-5 flex items-baseline gap-2 whitespace-nowrap">
        <span className="font-display text-[32px] leading-none text-white tabular-nums">{formatCount(view.credits(plan.hours))}</span>
        <span className="text-[14px] text-white/70">{UNIT.many} a month</span>
      </p>
      <p className="mt-1 text-[13px] text-white/45">{view.withAds ? "With ads, enough for up to" : "Enough for up to"}</p>
      <ul className="mt-1">
        {view.machines.map((machine) => {
          const time = view.timeOn(plan.hours, machine);
          const without = view.timeOnFull(plan.hours, machine);
          // One rule for the Mac and iPhone rows: whole hours (rounded down) when the plan gives 2 hours or
          // more at the full price, minutes below that; both figures of a row in the same unit.
          const inHours = machine.per === "hour" || (without ?? time) >= 120;
          const shown = (minutesOrHours: number) => formatCount(machine.per === "minute" && inHours ? Math.floor(minutesOrHours / 60) : minutesOrHours);
          return (
            <AllowanceRow
              key={machine.id}
              name={machine.kind === "linux" ? (HOURLY_SIZES.find((size) => size.id === machine.id)?.label ?? machine.name) : machine.name}
              detail={machine.kind === "linux" ? `Linux, ${machine.specs}` : machine.kind === "mac" ? machine.specs : machine.use}
              value={shown(time)}
              unit={inHours ? "h" : "min"}
              note={without == null ? undefined : `${shown(without)} with no ads`}
              phone={machine.kind === "iphone"}
              mac={machine.kind === "mac"}
              even
            />
          );
        })}
      </ul>
    </div>
  );
}

/** The Free card's small print about Small under Pricing v3. */
export function freeSmallNote(view: PricingView): string {
  const rate = `${formatCount(view.freeSmall.struck ?? view.freeSmall.now)} ${UNIT.many} an hour`;
  if (!view.ads) return `Small is ${rate} on Free, and free on every paid plan.`;
  return `With ads, Small computers are free, and bigger ones cost ${view.ads.discountPct}% less.`;
}

/** One machine in a plan's allowance: its name and specs, then how much of it the plan gets. */
function AllowanceRow({
  name,
  detail,
  value,
  unit,
  free,
  phone,
  mac,
  stacked,
  note,
  even,
  tall,
}: {
  name: string;
  detail: string;
  value: string;
  unit: string;
  free?: boolean;
  phone?: boolean;
  mac?: boolean;
  /** The unit under the value, as a free row has it. */
  stacked?: boolean;
  /** A small line under the value: the same allowance with no ads, while ads are on. */
  note?: string;
  /** A fixed value column, so the rows of the four cards wrap alike and read across. */
  even?: boolean;
  /** The height of the Free card's Small row with its note, on every card, so the rows under it stay level. */
  tall?: boolean;
}) {
  return (
    <li className={cn("grid items-center py-2 list-none", tall && "min-h-[92px]", even ? "grid-cols-[minmax(0,1fr)_92px] gap-x-2" : "grid-cols-[minmax(0,1fr)_auto] gap-x-3")}>
      <span className="min-w-0">
        <span className={cn("flex items-center gap-1.5 text-[15px] text-white/90", even && "whitespace-nowrap")}>
          {phone ? <Smartphone className="h-3.5 w-3.5 shrink-0 text-[#fdba74]" /> : null}
          {mac ? <AppleMark className="h-3.5 w-3.5 shrink-0 text-white/80" /> : null}
          {name}
        </span>
        <span className="block text-[12.5px] leading-[1.4] text-white/45">{detail}</span>
      </span>
      <span className="text-right">
        <span className={cn("font-display leading-none tabular-nums", free ? "text-[19px] text-[color:var(--color-lamp)]" : stacked ? "text-[19px] text-white" : "text-[22px] text-white")}>{value}</span>
        <span className={cn("block text-[12px] text-white/45", !free && !stacked && "inline pl-1")}>{unit}</span>
        {note ? <span className={cn("block text-[11.5px] leading-tight text-white/40 tabular-nums", note.length <= 18 && "whitespace-nowrap")}>{note}</span> : null}
      </span>
    </li>
  );
}
