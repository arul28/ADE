import { useState, type ReactNode } from "react";
import { ADE_MACHINE, CHECKED_ON, CLOUD_ROSTER, NO_PUBLISHED_PRICE, RIVALS, adeMonthlyUsd, type CloudStatus } from "../../lib/cloudCompetitors";
import { FREE_PLAN, PRICING_PLANS, formatCount, formatUsd, planCostsFor } from "../../lib/cloudPricing";
import { cn } from "../../lib/cn";

/*
 * ADE Cloud against every other agent app's cloud, drawn the way benchmark
 * pages draw a speed test: one metric per chart, the metric and its direction
 * under the title, real logos, the value in tabular figures, and ADE as the
 * only coloured bar. The monthly bill leads, larger, because it is the one
 * like-for-like number: what a month of hours costs, with each vendor's
 * required plan. Every row says which machine and which plan its price is
 * for, and each vendor's name links to the page the number came from.
 * Numbers come from `lib/cloudCompetitors.ts`.
 */

const ADE_LOGO = "/images/home/ade-icon.png";
const ACCENT = "bg-[#ffc861]";
const MUTED = "bg-white/[0.24]";
const panel = "rounded-[20px] border border-white/[0.08] bg-[#0f0e16]";
const link = "underline decoration-white/0 underline-offset-[3px] transition-colors hover:decoration-white/40";

export function CloudCharts() {
  return (
    <div className="mt-12 grid gap-3 lg:grid-cols-3">
      <BillChart className="lg:col-span-2" />
      <FreeHoursChart />
      <PerHourChart />
      <Roster className="lg:col-span-2" />
    </div>
  );
}

/** Where every competitor number comes from; it closes the ADE Cloud section. */
export function CloudSources() {
  return (
    <p className="mt-6 max-w-[82ch] text-[13px] leading-relaxed text-white/45">
      Prices from each vendor's own pricing page on {CHECKED_ON}, for the computer only; model use is extra everywhere, except
      that Capy's credits also pay for tokens. Values marked ≈ are our arithmetic from that page. {NO_PUBLISHED_PRICE.join(", ")}{" "}
      bundle their cloud with model use and publish no computer price. The app list is{" "}
      <a href="https://ademark.dev" target="_blank" rel="noreferrer" className="underline decoration-white/25 underline-offset-2 hover:text-white/75">
        ademark.dev
      </a>
      's.
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
      <div className="mt-6 flex flex-1 flex-col justify-between gap-4">{children}</div>
    </figure>
  );
}

function Mark({ src, name, size = 26 }: { src?: string; name: string; size?: number }) {
  return (
    <span className="grid shrink-0 place-items-center overflow-hidden rounded-[7px] bg-white/[0.06]" style={{ width: size, height: size }}>
      {src ? <img src={src} alt="" aria-hidden className="h-full w-full object-contain" /> : <span className="text-[11px] font-semibold text-white/70">{name[0]}</span>}
    </span>
  );
}

type Bar = { id: string; name: string; sub: string; logo?: string; source?: string; value: number | null; label: string; ade: boolean };

function BarRow({ bar, max, big }: { bar: Bar; max: number; big?: boolean }) {
  return (
    <div className="grid grid-cols-[26px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2">
      <Mark src={bar.logo} name={bar.name} />
      <p className="min-w-0 truncate text-[14px] leading-tight">
        {bar.source ? (
          <a href={bar.source} target="_blank" rel="noreferrer" className={cn(link, "text-white/90")}>
            {bar.name}
          </a>
        ) : (
          <span className="font-semibold text-white">{bar.name}</span>
        )}
        <span className="ml-2 text-white/45">{bar.sub}</span>
      </p>
      <span className={cn("text-right font-mono tabular-nums", big ? "text-[15px]" : "text-[14px]", bar.ade ? "text-[#ffc861]" : "text-white/85")}>{bar.label}</span>
      <div className={cn("col-span-3 overflow-hidden rounded-full bg-white/[0.06]", big ? "h-[8px]" : "h-[6px]")}>
        <div
          className={cn("h-full rounded-full transition-[width] duration-500 ease-out", bar.ade ? ACCENT : MUTED)}
          style={{ width: bar.value == null ? 0 : `${Math.max(1.5, (bar.value / max) * 100)}%` }}
        />
      </div>
    </div>
  );
}

const WORKLOADS = [100, 300, 1000];
const money = (usd: number) => (usd === 0 ? "$0" : formatUsd(Math.round(usd * 100) / 100));

/** 1. A month's bill for the hours picked, with the plan each vendor makes you buy. The lead chart. */
function BillChart({ className }: { className?: string }) {
  const [hours, setHours] = useState(300);
  const adeBill = adeMonthlyUsd(hours);
  const adePlan = planCostsFor(hours)[0]?.plan;
  const bars: Bar[] = [
    {
      id: "ade",
      name: "ADE Cloud",
      sub: `${ADE_MACHINE} · ${adePlan ? `${adePlan.name} plan` : ""}`,
      logo: ADE_LOGO,
      value: adeBill,
      label: money(adeBill),
      ade: true,
    },
    ...RIVALS.filter((rival) => rival.monthlyUsd).map((rival): Bar => {
      const value = rival.monthlyUsd!(hours);
      return {
        id: rival.id,
        name: rival.name,
        sub: `${rival.machine} · ${rival.plan}`,
        logo: rival.logo,
        source: rival.source,
        value,
        label: value == null ? "not offered" : `${rival.estimate ? "≈" : ""}${money(value)}`,
        ade: false,
      };
    }),
  ].sort((a, b) => (a.ade ? -1 : b.ade ? 1 : (a.value ?? Infinity) - (b.value ?? Infinity)));
  const max = Math.max(...bars.map((bar) => bar.value ?? 0), 1);
  const cheapestRival = Math.min(...bars.filter((bar) => !bar.ade && bar.value != null).map((bar) => bar.value as number));

  return (
    <Chart
      className={className}
      title="Your monthly bill"
      metric={`${formatCount(hours)} hours of cloud computer in a month, on the cheapest plan that runs them. Lower is better.`}
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
      <p className="font-display text-[clamp(30px,3vw,44px)] leading-none text-white">
        {money(adeBill)}
        <span className="ml-3 font-sans text-[15px] font-normal tracking-normal text-white/55">
          on ADE, against {money(cheapestRival)} at the cheapest of the rest
        </span>
      </p>
      {bars.map((bar) => (
        <BarRow key={bar.id} bar={bar} max={max} big />
      ))}
    </Chart>
  );
}

/** 2. Cloud hours a month that cost nothing, as named columns. */
function FreeHoursChart() {
  const known = RIVALS.filter((rival) => rival.freeHours !== null).sort((a, b) => (b.freeHours ?? 0) - (a.freeHours ?? 0));
  const columns = [
    { id: "ade", name: "ADE", logo: ADE_LOGO, source: undefined as string | undefined, value: FREE_PLAN.hours, label: String(FREE_PLAN.hours), ade: true },
    ...known.map((rival) => ({
      id: rival.id,
      name: rival.name,
      logo: rival.logo,
      source: rival.source,
      value: rival.freeHours ?? 0,
      label: `${rival.estimate && rival.freeHours ? "≈" : ""}${rival.freeHours ?? 0}`,
      ade: false,
    })),
  ];
  return (
    <Chart title="Free hours" metric="Every month, no card. Higher is better.">
      <div className="flex flex-1 items-end gap-2 border-b border-white/[0.08]" style={{ minHeight: 270 }}>
        {columns.map((column) => (
          <div key={column.id} className="flex h-full flex-1 flex-col items-center justify-end">
            <span className={cn("mb-1.5 font-mono text-[13px] tabular-nums", column.ade ? "text-[#ffc861]" : "text-white/60")}>{column.label}</span>
            <div
              className={cn("w-full max-w-[40px] rounded-t-[6px]", column.ade ? ACCENT : MUTED)}
              style={{ height: column.value ? `${(column.value / FREE_PLAN.hours) * 230}px` : 2 }}
            />
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        {columns.map((column) => (
          <div key={column.id} className="flex min-w-0 flex-1 flex-col items-center gap-1.5 text-center">
            <Mark src={column.logo} name={column.name} size={22} />
            <span className={cn("w-full truncate text-[11.5px]", column.ade ? "font-semibold text-white" : "text-white/55")}>{column.name}</span>
          </div>
        ))}
      </div>
    </Chart>
  );
}

/** 3. What one cloud hour costs, with what kind of rate each one is. */
function PerHourChart() {
  const cents = (value: number) => `${value < 10 ? value.toFixed(1) : Math.round(value)}¢`;
  const bars: Bar[] = [
    ...PRICING_PLANS.filter((plan) => plan.priceUsd > 0).map((plan): Bar => {
      const value = (plan.priceUsd * 100) / plan.hours;
      return { id: `ade-${plan.id}`, name: `ADE ${plan.name}`, sub: "plan average", logo: ADE_LOGO, value, label: cents(value), ade: true };
    }),
    ...RIVALS.filter((rival) => rival.perHourCents != null).map((rival): Bar => ({
      id: rival.id,
      name: rival.name,
      sub: rival.rateKind,
      logo: rival.logo,
      source: rival.source,
      value: rival.perHourCents!,
      label: `${rival.estimate ? "≈" : ""}${cents(rival.perHourCents!)}`,
      ade: false,
    })),
  ].sort((a, b) => (a.value ?? 0) - (b.value ?? 0));
  const max = Math.max(...bars.map((bar) => bar.value ?? 0));
  return (
    <Chart title="Price per hour" metric="One hour of each plan's computer. Lower is better.">
      {bars.map((bar) => (
        <BarRow key={bar.id} bar={bar} max={max} />
      ))}
    </Chart>
  );
}

const STATUS: Record<CloudStatus, { label: string; dot: string }> = {
  cloud: { label: "Cloud", dot: "bg-emerald-400" },
  unpriced: { label: "No public price", dot: "bg-white/45" },
  closing: { label: "Shutting down", dot: "bg-rose-400" },
  none: { label: "No cloud", dot: "bg-white/20" },
};

/** Every app ademark.dev measures, and whether it hosts a computer for your agents. */
function Roster({ className }: { className?: string }) {
  const [filter, setFilter] = useState<"all" | "none">("all");
  const without = CLOUD_ROSTER.filter((app) => app.cloud === "none").length;
  const apps = filter === "all" ? CLOUD_ROSTER : CLOUD_ROSTER.filter((app) => app.cloud === "none");
  return (
    <Chart
      className={className}
      title="Who gives your agents a computer"
      metric={`${without} of the ${CLOUD_ROSTER.length} agent apps ademark.dev measures have no cloud at all.`}
      control={
        <div role="radiogroup" aria-label="Show" className="inline-flex rounded-full border border-white/10 p-0.5 text-[13px]">
          {([
            ["all", `All ${CLOUD_ROSTER.length}`],
            ["none", `No cloud ${without}`],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={filter === id}
              onClick={() => setFilter(id)}
              className={cn("focus-ring rounded-full px-3.5 py-1.5 transition-colors", filter === id ? "bg-white text-[#0b0a14]" : "text-white/60 hover:text-white")}
            >
              {label}
            </button>
          ))}
        </div>
      }
    >
      <ul className="grid flex-1 auto-rows-fr grid-cols-2 gap-2 sm:grid-cols-4">
        {apps.map((app) => (
          <li key={app.name} title={`${app.name}: ${app.detail}`} className="flex items-center gap-2.5 rounded-[12px] border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
            <Mark src={app.logo} name={app.name} size={26} />
            <span className="min-w-0">
              <span className="block truncate text-[13.5px] text-white/90">{app.name}</span>
              <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-white/50">
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS[app.cloud].dot)} />
                <span className="truncate">{STATUS[app.cloud].label}</span>
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Chart>
  );
}
