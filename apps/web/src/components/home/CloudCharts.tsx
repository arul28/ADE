import { Fragment, useState, type ReactNode } from "react";
import { ADE_MACHINE, CHECKED_ON, NO_CLOUD, RIVALS, adeMonthlyUsd } from "../../lib/cloudCompetitors";
import { FREE_PLAN, PRICING_PLANS, formatCount, formatUsd, planCostsFor } from "../../lib/cloudPricing";
import { cn } from "../../lib/cn";

/*
 * ADE Cloud against the other agent apps that sell a cloud computer, drawn
 * the way benchmark pages draw a speed test: one metric per chart, best
 * first, one row per vendor on one line (logo, name and machine, a thick bar,
 * the value at the bar's end), and ADE as the only gold bar. The apps with no
 * cloud at all sit in one small greyed card instead of a chart. Numbers come
 * from `lib/cloudCompetitors.ts`.
 */

const ADE_LOGO = "/images/home/ade-icon.png";
const panel = "rounded-[20px] border border-white/[0.08] bg-[#0f0e16]";

export function CloudCharts() {
  return (
    <div className="mt-12 grid gap-3 lg:grid-cols-3">
      <PerHourChart className="lg:col-span-2" />
      <FreeHoursChart />
      <BillChart className="lg:col-span-2" />
      <NoCloudCard />
    </div>
  );
}

/** Where every competitor number comes from; it closes the ADE Cloud section. */
export function CloudSources() {
  return (
    <p className="mt-6 max-w-[82ch] text-[13px] leading-relaxed text-white/45">
      Prices from each vendor's own pricing page on {CHECKED_ON}, for the computer only; model use is extra, except that Capy's
      credits also pay for tokens. Values marked ≈ are our arithmetic from that page. Free hours count only hours that come back every
      month, so one-time credits (Replicas, Superconductor) count as none. Apps with a cloud but no published price are left out. Apps from{" "}
      <a href="https://ademark.dev" target="_blank" rel="noreferrer" className="underline decoration-white/25 underline-offset-2 hover:text-white/75">
        ademark.dev
      </a>
      .
    </p>
  );
}

function Chart({ title, metric, children, control, className }: { title: string; metric: string; children: ReactNode; control?: ReactNode; className?: string }) {
  return (
    <figure className={cn(panel, "flex flex-col p-5 sm:p-7", className)}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <figcaption>
          <h3 className="text-[16px] font-semibold text-white">{title}</h3>
          <p className="mt-1 text-[14px] text-white/55">{metric}</p>
        </figcaption>
        {control}
      </div>
      <div className="mt-6 flex flex-1 flex-col gap-2.5">{children}</div>
    </figure>
  );
}

function Mark({ src, name, size = 28, className }: { src: string; name: string; size?: number; className?: string }) {
  return (
    <span className={cn("grid shrink-0 place-items-center overflow-hidden rounded-[8px] bg-white/[0.06]", className)} style={{ width: size, height: size }} title={name}>
      <img src={src} alt="" aria-hidden className="h-full w-full object-contain" />
    </span>
  );
}

type Bar = { id: string; name: string; sub: string; logo: string; source?: string; value: number; label: string; ade: boolean };

/** Best first: ascending for prices, descending for free hours; ADE wins a tie. */
function sortBars(bars: Bar[], higherIsBetter = false): Bar[] {
  return [...bars].sort((a, b) => (higherIsBetter ? b.value - a.value : a.value - b.value) || Number(b.ade) - Number(a.ade));
}

/** One vendor in a narrow card: name and value on one line, a thin bar under them, on the full track. */
function CompactBarRow({ bar, max }: { bar: Bar; max: number }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2.5">
        <Mark src={bar.logo} name={bar.name} size={22} />
        <span className={cn("min-w-0 flex-1 truncate text-[14px]", bar.ade ? "font-semibold text-white" : "text-white/85")}>{bar.name}</span>
        <span className={cn("font-mono text-[14px] tabular-nums", bar.ade ? "font-semibold text-[#ffc861]" : "text-white/75")}>{bar.label}</span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-white/[0.05]">
        <div
          className={cn("h-full rounded-full transition-[width] duration-500 ease-out", bar.ade ? "bg-[#ffc861]" : "bg-white/[0.24]")}
          style={{ width: `${bar.value ? Math.max(2, (bar.value / max) * 100) : 0}%` }}
        />
      </div>
    </div>
  );
}

/**
 * One vendor on one line. The bar stops at 82% of the track so the value always fits after it.
 * A phone has no room for the name column beside the bar, so it gets the compact row.
 */
function BarRow({ bar, max }: { bar: Bar; max: number }) {
  const width = Math.max(bar.ade ? 6 : 1.2, (bar.value / max) * 82);
  return (
    <>
    <div className="sm:hidden">
      <CompactBarRow bar={bar} max={max} />
    </div>
    <div className="hidden grid-cols-[28px_minmax(0,210px)_1fr] items-center gap-3 sm:grid">
      <Mark src={bar.logo} name={bar.name} />
      <div className="min-w-0">
        {bar.source ? (
          <a href={bar.source} target="_blank" rel="noreferrer" className="block truncate text-[14px] font-medium text-white/90 hover:text-white">
            {bar.name}
          </a>
        ) : (
          <span className="block truncate text-[14px] font-semibold text-white">{bar.name}</span>
        )}
        <span className="block truncate text-[12.5px] text-white/45">{bar.sub}</span>
      </div>
      <div className="relative flex h-9 items-center rounded-[8px] bg-white/[0.035]">
        <div
          className={cn("absolute inset-y-1 left-1 rounded-[6px] transition-[width] duration-500 ease-out", bar.ade ? "bg-[#ffc861]" : "bg-white/[0.2]")}
          style={{ width: `calc(${width}% - 4px)` }}
        />
        <span
          className={cn("absolute whitespace-nowrap pl-3 font-mono text-[14px] tabular-nums transition-[left] duration-500 ease-out", bar.ade ? "font-semibold text-[#ffc861]" : "text-white/80")}
          style={{ left: `${width}%` }}
        >
          {bar.label}
        </span>
      </div>
    </div>
    </>
  );
}

const WORKLOADS = [100, 300, 1000];
/** A bill to the cent: plan arithmetic like 50 + 0.36 × 91.6 leaves float noise. */
const money = (usd: number) => formatUsd(Math.round(usd * 100) / 100);

/** 1. A month's bill for the hours picked, on each vendor's cheapest plan that runs them. */
function BillChart({ className }: { className?: string }) {
  const [hours, setHours] = useState(300);
  const adeBill = adeMonthlyUsd(hours);
  const adePlan = planCostsFor(hours)[0]?.plan;
  const bars = sortBars([
    { id: "ade", name: "ADE Cloud", sub: `${ADE_MACHINE} · ${adePlan?.name ?? ""} plan`, logo: ADE_LOGO, value: adeBill, label: money(adeBill), ade: true },
    ...RIVALS.flatMap((rival): Bar[] => {
      const value = rival.monthlyUsd?.(hours);
      if (value == null) return [];
      return [
        {
          id: rival.id,
          name: rival.name,
          sub: [rival.machine, rival.plan].filter(Boolean).join(" · "),
          logo: rival.logo,
          source: rival.source,
          value,
          label: `${rival.estimate ? "≈" : ""}${money(value)}`,
          ade: false,
        },
      ];
    }),
  ]);
  const max = Math.max(...bars.map((bar) => bar.value), 1);

  return (
    <Chart
      className={className}
      title="Monthly bill"
      metric={`${formatCount(hours)} hours in a month, on each app's cheapest plan for them. Lower is better.`}
      control={
        <div role="radiogroup" aria-label="Hours a month" className="inline-flex rounded-full border border-white/10 p-0.5">
          {WORKLOADS.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={hours === value}
              onClick={() => setHours(value)}
              className={cn(
                "focus-ring rounded-full px-3.5 py-1.5 font-mono text-[13px] tabular-nums transition-colors",
                hours === value ? "bg-white text-[#0b0a14]" : "text-white/60 hover:text-white",
              )}
            >
              {formatCount(value)} h
            </button>
          ))}
        </div>
      }
    >
      {bars.map((bar) => (
        <BarRow key={bar.id} bar={bar} max={max} />
      ))}
    </Chart>
  );
}

/** 2. Cloud hours a month that cost nothing, most first; the apps with none share one line. */
function FreeHoursChart() {
  const bars = sortBars(
    [
      { id: "ade", name: "ADE Cloud", sub: "No card", logo: ADE_LOGO, value: FREE_PLAN.hours, label: `${FREE_PLAN.hours} h`, ade: true },
      ...RIVALS.filter((rival) => rival.freeHours).map((rival): Bar => ({
        id: rival.id,
        name: rival.name,
        sub: "Its own estimate",
        logo: rival.logo,
        source: rival.source,
        value: rival.freeHours,
        label: `${rival.estimate ? "≈" : ""}${rival.freeHours} h`,
        ade: false,
      })),
    ],
    true,
  );
  const none = RIVALS.filter((rival) => rival.freeHours === 0);
  return (
    <Chart title="Free hours" metric="Every month. Higher is better.">
      {bars.map((bar) => (
        <CompactBarRow key={bar.id} bar={bar} max={Math.max(...bars.map((entry) => entry.value))} />
      ))}
      {none.length > 0 && (
        <div className="mt-2 border-t border-white/[0.06] pt-4">
          <p className="font-mono text-[13px] text-white/45">0 h</p>
          <ul className="mt-2.5 flex flex-col gap-2">
            {none.map((rival) => (
              <li key={rival.id} className="flex items-center gap-2.5 text-[14px] text-white/70">
                <Mark src={rival.logo} name={rival.name} size={22} />
                {rival.name}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Chart>
  );
}

/** 3. What one cloud hour costs, cheapest first; each row says what kind of rate it is. */
function PerHourChart({ className }: { className?: string }) {
  const cents = (value: number) => `${value < 10 ? value.toFixed(1) : Math.round(value)}¢`;
  const bars = sortBars([
    ...PRICING_PLANS.filter((plan) => plan.priceUsd > 0).map((plan): Bar => {
      const value = (plan.priceUsd * 100) / plan.hours;
      return { id: `ade-${plan.id}`, name: `ADE ${plan.name}`, sub: `$${plan.priceUsd} plan average · ${ADE_MACHINE}`, logo: ADE_LOGO, value, label: cents(value), ade: true };
    }),
    ...RIVALS.map((rival): Bar => ({
      id: rival.id,
      name: rival.name,
      sub: [`${rival.rateKind[0]!.toUpperCase()}${rival.rateKind.slice(1)}`, rival.machine].filter(Boolean).join(" · "),
      logo: rival.logo,
      source: rival.source,
      value: rival.perHourCents,
      label: `${rival.estimate ? "≈" : ""}${cents(rival.perHourCents)}`,
      ade: false,
    })),
  ]);
  const max = Math.max(...bars.map((bar) => bar.value));
  return (
    <Chart className={className} title="Price per hour" metric="One hour of the plan's computer. Lower is better.">
      {bars.map((bar) => (
        <BarRow key={bar.id} bar={bar} max={max} />
      ))}
    </Chart>
  );
}

/** 4. The agent apps with no cloud at all, greyed out. */
function NoCloudCard() {
  return (
    <figure className={cn(panel, "flex flex-col p-5 sm:p-7")}>
      <figcaption>
        <h3 className="text-[16px] font-semibold text-white">No cloud at all</h3>
        <p className="mt-1 text-[14px] text-white/55">These agent apps run only on your own machines.</p>
      </figcaption>
      <ul className="mt-6 grid grid-cols-2 gap-x-4 gap-y-4">
        {NO_CLOUD.map((app) => (
          <li key={app.name} className="flex min-w-0 items-center gap-2.5 opacity-55 grayscale">
            <Mark src={app.logo} name={app.name} size={26} />
            <span className="min-w-0 text-[13.5px] leading-tight text-white/75">
              {/* A long dotted name may break after its dot, never mid-word. */}
              {app.name.split(".").map((part, i) => (
                <Fragment key={i}>
                  {i > 0 ? (
                    <>
                      .<wbr />
                    </>
                  ) : null}
                  {part}
                </Fragment>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
