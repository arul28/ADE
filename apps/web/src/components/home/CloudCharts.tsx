import { useState, type ReactNode } from "react";
import { CHECKED_ON, CLOUD_ROSTER, NO_PUBLISHED_PRICE, RIVALS, adeMonthlyUsd, type CloudStatus } from "../../lib/cloudCompetitors";
import { FREE_PLAN, PRICING_PLANS, formatCount, formatUsd } from "../../lib/cloudPricing";
import { cn } from "../../lib/cn";

/*
 * ADE Cloud against every other agent app's cloud, drawn the way benchmark
 * pages draw a speed test: one metric per chart, the metric and its
 * direction under the title, real logos, the value in tabular figures at the
 * end of each bar, and ADE as the only coloured bar. Three charts of one
 * width sit in a row; the roster of every app ademark.dev measures runs
 * under them. Numbers come from `lib/cloudCompetitors.ts`.
 */

const ADE_LOGO = "/images/home/ade-icon.png";
const ACCENT = "bg-[#ffc861]";
const MUTED = "bg-white/[0.22]";
const panel = "rounded-[20px] border border-white/[0.08] bg-[#0f0e16]";

export function CloudCharts() {
  return (
    <div className="mt-12">
      <div className="grid gap-3 lg:grid-cols-3">
        <BillChart />
        <FreeHoursChart />
        <PerHourChart />
      </div>
      <Roster />
    </div>
  );
}

/** Where every competitor number comes from; it closes the ADE Cloud section. */
export function CloudSources() {
  return (
    <p className="mt-6 max-w-[80ch] text-[12.5px] leading-relaxed text-white/40">
        Prices from each vendor's own pricing page on {CHECKED_ON}, for the computer alone; model use is extra everywhere.
        Values marked ≈ are our arithmetic from that page. {NO_PUBLISHED_PRICE.join(", ")} bundle their cloud with model use
        and publish no computer price. Sources:{" "}
        {RIVALS.map((rival, i) => (
          <span key={rival.id}>
            <a href={rival.source} target="_blank" rel="noreferrer" className="underline decoration-white/20 underline-offset-2 hover:text-white/70">
              {rival.name}
            </a>
            {i < RIVALS.length - 1 ? ", " : ", "}
          </span>
        ))}
        <a href="https://ademark.dev" target="_blank" rel="noreferrer" className="underline decoration-white/20 underline-offset-2 hover:text-white/70">
          ademark.dev
        </a>
        .
      </p>
  );
}

function Chart({ title, metric, children, control }: { title: string; metric: string; children: ReactNode; control?: ReactNode }) {
  return (
    <figure className={cn(panel, "flex flex-col p-5 sm:p-6")}>
      <figcaption>
        <h3 className="text-[15px] font-semibold text-white">{title}</h3>
        <p className="mt-0.5 text-[13px] text-white/45">{metric}</p>
      </figcaption>
      {control ? <div className="mt-4">{control}</div> : null}
      <div className="mt-5 flex flex-1 flex-col justify-between gap-3.5">{children}</div>
    </figure>
  );
}

function Mark({ src, name, size = 24 }: { src?: string; name: string; size?: number }) {
  return (
    <span className="grid shrink-0 place-items-center overflow-hidden rounded-[7px] bg-white/[0.06]" style={{ width: size, height: size }}>
      {src ? <img src={src} alt="" aria-hidden className="h-full w-full object-contain" /> : <span className="text-[11px] font-semibold text-white/70">{name[0]}</span>}
    </span>
  );
}

type Bar = { id: string; name: string; sub: string; logo?: string; value: number | null; label: string; ade: boolean };

function BarRow({ bar, max }: { bar: Bar; max: number }) {
  return (
    <div className="grid grid-cols-[24px_minmax(0,1fr)_64px] items-center gap-x-3 gap-y-1.5">
      <Mark src={bar.logo} name={bar.name} />
      <div className="min-w-0">
        <p className={cn("truncate text-[13.5px] leading-tight", bar.ade ? "font-semibold text-white" : "text-white/80")}>
          {bar.name} <span className="font-normal text-white/35">{bar.sub}</span>
        </p>
      </div>
      <span className={cn("text-right font-mono text-[13.5px] tabular-nums", bar.ade ? "text-[#ffc861]" : "text-white/80")}>{bar.label}</span>
      <div className="col-span-3 h-[6px] overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className={cn("h-full rounded-full transition-[width] duration-500 ease-out", bar.ade ? ACCENT : MUTED)}
          style={{ width: bar.value == null ? 0 : `${Math.max(1.5, (bar.value / max) * 100)}%` }}
        />
      </div>
    </div>
  );
}

const WORKLOADS = [
  { hours: 100, label: "100 h" },
  { hours: 300, label: "300 h" },
  { hours: 1000, label: "1,000 h" },
];
const money = (usd: number) => (usd === 0 ? "$0" : formatUsd(Math.round(usd * 100) / 100));

/** 1. A month's bill for the workload picked. */
function BillChart() {
  const [hours, setHours] = useState(300);
  const bars: Bar[] = [
    { id: "ade", name: "ADE Cloud", sub: "Small", logo: ADE_LOGO, value: adeMonthlyUsd(hours), label: money(adeMonthlyUsd(hours)), ade: true },
    ...RIVALS.filter((rival) => rival.monthlyUsd).map((rival): Bar => {
      const value = rival.monthlyUsd!(hours);
      return {
        id: rival.id,
        name: rival.name,
        sub: rival.machine.split(",")[0]!,
        logo: rival.logo,
        value,
        label: value == null ? "n/a" : `${rival.estimate ? "≈" : ""}${money(value)}`,
        ade: false,
      };
    }),
  ].sort((a, b) => (a.ade ? -1 : b.ade ? 1 : (a.value ?? Infinity) - (b.value ?? Infinity)));
  const max = Math.max(...bars.map((bar) => bar.value ?? 0), 1);

  return (
    <Chart
      title="Monthly bill"
      metric={`${formatCount(hours)} hours of a 2-CPU computer. Lower is better.`}
      control={
        <div role="radiogroup" aria-label="Hours a month" className="inline-flex rounded-full border border-white/10 p-0.5">
          {WORKLOADS.map((workload) => (
            <button
              key={workload.hours}
              type="button"
              role="radio"
              aria-checked={hours === workload.hours}
              onClick={() => setHours(workload.hours)}
              className={cn(
                "focus-ring rounded-full px-3 py-1 font-mono text-[12px] tabular-nums transition-colors",
                hours === workload.hours ? "bg-white text-[#0b0a14]" : "text-white/55 hover:text-white",
              )}
            >
              {workload.label}
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

/** 2. Cloud hours a month that cost nothing, as columns. */
function FreeHoursChart() {
  const known = RIVALS.filter((rival) => rival.freeHours !== null).sort((a, b) => (b.freeHours ?? 0) - (a.freeHours ?? 0));
  const columns = [
    { id: "ade", name: "ADE", logo: ADE_LOGO, value: FREE_PLAN.hours, label: String(FREE_PLAN.hours), ade: true },
    ...known.map((rival) => ({ id: rival.id, name: rival.name, logo: rival.logo, value: rival.freeHours ?? 0, label: `${rival.estimate && rival.freeHours ? "≈" : ""}${rival.freeHours ?? 0}`, ade: false })),
  ];
  return (
    <Chart title="Free hours" metric="Every month, no card. Higher is better.">
      <div className="flex flex-1 items-end gap-2 border-b border-white/[0.08]" style={{ minHeight: 190 }}>
        {columns.map((column) => (
          <div key={column.id} className="flex h-full flex-1 flex-col items-center justify-end" title={column.name}>
            <span className={cn("mb-1.5 font-mono text-[12.5px] tabular-nums", column.ade ? "text-[#ffc861]" : "text-white/55")}>{column.label}</span>
            <div
              className={cn("w-full max-w-[44px] rounded-t-[6px]", column.ade ? ACCENT : MUTED)}
              style={{ height: column.value ? `${(column.value / FREE_PLAN.hours) * 150}px` : 2 }}
            />
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        {columns.map((column) => (
          <div key={column.id} className="flex flex-1 justify-center">
            <Mark src={column.logo} name={column.name} size={22} />
          </div>
        ))}
      </div>
    </Chart>
  );
}

/** 3. What one cloud hour costs, every plan that prints a rate. */
function PerHourChart() {
  const cents = (value: number) => `${value < 10 ? value.toFixed(1) : Math.round(value)}¢`;
  const bars: Bar[] = [
    ...PRICING_PLANS.filter((plan) => plan.priceUsd > 0).map((plan): Bar => {
      const value = (plan.priceUsd * 100) / plan.hours;
      return { id: `ade-${plan.id}`, name: `ADE ${plan.name}`, sub: `$${plan.priceUsd}`, logo: ADE_LOGO, value, label: cents(value), ade: true };
    }),
    ...RIVALS.filter((rival) => rival.perHourCents != null).map((rival): Bar => ({
      id: rival.id,
      name: rival.name,
      sub: "",
      logo: rival.logo,
      value: rival.perHourCents!,
      label: `${rival.estimate ? "≈" : ""}${cents(rival.perHourCents!)}`,
      ade: false,
    })),
  ].sort((a, b) => (a.value ?? 0) - (b.value ?? 0));
  const max = Math.max(...bars.map((bar) => bar.value ?? 0));
  return (
    <Chart title="Price per hour" metric="One hour of the plan's computer. Lower is better.">
      {bars.map((bar) => (
        <BarRow key={bar.id} bar={bar} max={max} />
      ))}
    </Chart>
  );
}

const STATUS: Record<CloudStatus, { label: string; dot: string }> = {
  cloud: { label: "Cloud", dot: "bg-emerald-400" },
  unpriced: { label: "No price", dot: "bg-white/40" },
  closing: { label: "Closing", dot: "bg-rose-400" },
  none: { label: "No cloud", dot: "bg-white/15" },
};

/** Every app ademark.dev measures, and whether it hosts a computer for your agents. */
function Roster() {
  const [filter, setFilter] = useState<"all" | "none">("all");
  const without = CLOUD_ROSTER.filter((app) => app.cloud === "none").length;
  const apps = filter === "all" ? CLOUD_ROSTER : CLOUD_ROSTER.filter((app) => app.cloud === "none");
  return (
    <div className={cn(panel, "mt-3 p-5 sm:p-6")}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h3 className="text-[15px] font-semibold text-white">Who gives your agents a computer</h3>
          <p className="mt-0.5 text-[13px] text-white/45">
            {without} of the {CLOUD_ROSTER.length} agent apps ademark.dev measures have no cloud at all.
          </p>
        </div>
        <div role="radiogroup" aria-label="Show" className="inline-flex rounded-full border border-white/10 p-0.5 text-[12.5px]">
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
              className={cn("focus-ring rounded-full px-3 py-1 transition-colors", filter === id ? "bg-white text-[#0b0a14]" : "text-white/55 hover:text-white")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <ul className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
        {apps.map((app) => (
          <li key={app.name} title={`${app.name}: ${app.detail}`} className="flex flex-col gap-2.5 rounded-[14px] border border-white/[0.06] bg-white/[0.02] p-3">
            <div className="flex items-center gap-2">
              <Mark src={app.logo} name={app.name} size={26} />
              <span className="min-w-0 break-words text-[13px] leading-tight text-white/85">{app.name}</span>
            </div>
            <span className="flex items-center gap-1.5 text-[12px] text-white/50">
              <span className={cn("h-1.5 w-1.5 rounded-full", STATUS[app.cloud].dot)} />
              {STATUS[app.cloud].label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
