import { useId, useState, type ReactNode } from "react";
import { Check, Clock, HelpCircle, X } from "lucide-react";
import { CHECKED_ON, CLOUD_ROSTER, NO_PUBLISHED_PRICE, RIVALS, adeMonthlyUsd, type Rival } from "../../lib/cloudCompetitors";
import { FREE_PLAN, PRICING_PLANS, formatCount, formatUsd } from "../../lib/cloudPricing";
import { cn } from "../../lib/cn";

/*
 * ADE Cloud against every other agent app's cloud, as four charts of one
 * size in a grid: the monthly bill for the hours you pick, free hours a
 * month, the price of one hour, and which apps have a cloud at all. ADE is
 * gold in every one. Numbers come from `lib/cloudCompetitors.ts`, read from
 * each vendor's own pricing page.
 */

const GOLD = "bg-[linear-gradient(90deg,#f5b94a,#ffd27a)] shadow-[0_0_24px_rgba(255,210,122,0.55)]";
const GOLD_UP = "bg-[linear-gradient(0deg,#f5b94a,#ffd27a)] shadow-[0_0_24px_rgba(255,210,122,0.55)]";
const GREY = "bg-[linear-gradient(90deg,rgba(255,255,255,0.14),rgba(255,255,255,0.28))]";

export function CloudCharts() {
  return (
    <div className="mt-[clamp(36px,4.5vw,56px)]">
      <div className="grid gap-3 lg:grid-cols-2">
        <BillChart />
        <FreeHoursChart />
        <PerHourChart />
        <RosterChart />
      </div>
      <p className="mt-4 text-center text-[12.5px] leading-relaxed text-white/40">
        From each vendor's own pricing page, {CHECKED_ON}; ≈ is our arithmetic from that page. The computer only, without model use.{" "}
        {NO_PUBLISHED_PRICE.join(", ")} bundle their cloud with model use, so there is no computer price to compare. Apps from{" "}
        <a href="https://ademark.dev" target="_blank" rel="noreferrer" className="underline decoration-white/20 underline-offset-2 hover:text-white/70">
          ademark.dev
        </a>
        .{" "}
        {RIVALS.map((rival, i) => (
          <span key={rival.id}>
            <a href={rival.source} target="_blank" rel="noreferrer" className="underline decoration-white/20 underline-offset-2 hover:text-white/70">
              {rival.name}
            </a>
            {i < RIVALS.length - 1 ? " · " : ""}
          </span>
        ))}
      </p>
    </div>
  );
}

function Card({ eyebrow, title, children, aside }: { eyebrow: string; title: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="relative flex min-h-[440px] flex-col overflow-hidden rounded-[28px] border border-white/[0.1] bg-[#120f2b]/85 p-6 shadow-[0_40px_100px_-40px_rgba(124,58,237,0.6)] backdrop-blur-md sm:p-7">
      <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(80% 60% at 0% 0%, rgba(255,210,122,0.08), transparent 60%)" }} />
      <div className="relative flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[12px] font-medium uppercase tracking-[0.14em] text-[color:var(--color-lamp)]">{eyebrow}</p>
          <h3 key={typeof title === "string" ? title : undefined} className="ade-pop-in mt-2 font-serif text-[clamp(24px,2.2vw,32px)] leading-[1.1] text-white">
            {title}
          </h3>
        </div>
        {aside}
      </div>
      <div className="relative mt-6 flex flex-1 flex-col">{children}</div>
    </div>
  );
}

function Logo({ name, logo, ade, size = 36 }: { name: string; logo?: string; ade?: boolean; size?: number }) {
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden rounded-[11px] border",
        ade ? "border-[color:var(--color-lamp)]/50 bg-[#1d1640] shadow-[0_0_18px_rgba(255,210,122,0.3)]" : "border-white/10 bg-white/[0.06]",
      )}
      style={{ width: size, height: size }}
      title={name}
    >
      {logo ? <img src={logo} alt="" aria-hidden className="h-full w-full object-cover" /> : <span className="text-[14px] font-semibold text-white/80">{name[0]}</span>}
    </span>
  );
}

const ADE_LOGO = "/images/home/ade-icon.png";
const HOUR_STEPS = [25, 50, 100, 150, 200, 300, 400, 500, 750, 1000];
const money = (usd: number) => (usd === 0 ? "Free" : formatUsd(Math.round(usd * 100) / 100));

/** 1. What a month costs for the hours picked: drag the slider and the bars move. */
function BillChart() {
  const [step, setStep] = useState(HOUR_STEPS.indexOf(100));
  const hours = HOUR_STEPS[step]!;
  const sliderId = useId();
  const ade = adeMonthlyUsd(hours);
  const rows = [
    { id: "ade", name: "ADE Cloud", logo: ADE_LOGO, value: ade as number | null, ade: true, estimate: false },
    ...RIVALS.filter((rival) => rival.monthlyUsd).map((rival) => ({
      id: rival.id,
      name: rival.name,
      logo: rival.logo,
      value: rival.monthlyUsd!(hours),
      ade: false,
      estimate: Boolean(rival.estimate),
    })),
  ].sort((a, b) => (a.ade ? -1 : b.ade ? 1 : (a.value ?? Infinity) - (b.value ?? Infinity)));
  const priced = rows.filter((row) => !row.ade && row.value != null).map((row) => row.value as number);
  const max = Math.max(...priced, ade, 1);
  const charging = priced.filter((value) => value > 0);
  const title =
    ade === 0
      ? `Free on ADE. ${charging.length} of ${priced.length} others charge.`
      : `${Math.max(2, Math.round(Math.min(...priced) / ade))}× less than the next best.`;

  return (
    <Card eyebrow="Your monthly bill" title={title}>
      <div className="flex items-center gap-4">
        <label htmlFor={sliderId} className="shrink-0 whitespace-nowrap text-[14px] text-white/60">
          <span className="font-serif text-[26px] leading-none text-white tabular-nums">{formatCount(hours)}</span> hours
        </label>
        <input
          id={sliderId}
          type="range"
          min={0}
          max={HOUR_STEPS.length - 1}
          value={step}
          onChange={(event) => setStep(Number(event.target.value))}
          aria-valuetext={`${hours} hours a month`}
          className="ade-range"
          style={{ ["--fill" as string]: `${(step / (HOUR_STEPS.length - 1)) * 100}%` }}
        />
      </div>
      <ul className="mt-6 flex flex-1 flex-col justify-between gap-3">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center gap-3">
            <Logo name={row.name} logo={row.logo} ade={row.ade} size={32} />
            <span className={cn("w-[92px] shrink-0 truncate text-[13px]", row.ade ? "font-semibold text-[color:var(--color-lamp)]" : "text-white/70")}>{row.name}</span>
            <div className="relative h-8 flex-1 overflow-hidden rounded-full bg-white/[0.05]">
              <div
                className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out", row.ade ? GOLD : GREY)}
                style={{ width: row.value == null ? 0 : `${Math.max(3, (row.value / max) * 100)}%` }}
              />
            </div>
            <span className={cn("w-[76px] shrink-0 text-right text-[16px] font-semibold tabular-nums", row.ade ? "text-[color:var(--color-lamp)]" : "text-white")}>
              {row.value == null ? "—" : `${row.estimate ? "≈" : ""}${money(row.value)}`}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** 2. Free hours every month, as columns: ADE's is the only one standing. */
function FreeHoursChart() {
  const [hover, setHover] = useState<string | null>(null);
  const known = RIVALS.filter((rival) => rival.freeHours !== null);
  const columns = [
    { id: "ade", name: "ADE Cloud", logo: ADE_LOGO, value: FREE_PLAN.hours, ade: true, estimate: false },
    ...known
      .map((rival) => ({ id: rival.id, name: rival.name, logo: rival.logo, value: rival.freeHours ?? 0, ade: false, estimate: Boolean(rival.estimate) }))
      .sort((a, b) => b.value - a.value),
  ];
  const nextFree = Math.max(...known.map((rival) => rival.freeHours ?? 0));

  return (
    <Card eyebrow="Free cloud hours a month" title={`${formatCount(FREE_PLAN.hours)} on ADE. Next best: ${nextFree}.`}>
      <div className="flex flex-1 items-end justify-around gap-3 border-b border-white/[0.1] pb-0" style={{ minHeight: 240 }}>
        {columns.map((column) => (
          <div
            key={column.id}
            className="flex flex-1 flex-col items-center justify-end self-stretch"
            onMouseEnter={() => setHover(column.id)}
            onMouseLeave={() => setHover(null)}
          >
            <span className={cn("mb-2 text-[15px] font-semibold tabular-nums", column.ade ? "text-[color:var(--color-lamp)]" : "text-white/55")}>
              {column.estimate ? "≈" : ""}
              {column.value}
            </span>
            <div
              className={cn("w-full max-w-[64px] rounded-t-[12px] transition-all duration-300", column.ade ? GOLD_UP : "bg-white/[0.12]", hover && hover !== column.id && "opacity-50")}
              style={{ height: column.value ? `${(column.value / FREE_PLAN.hours) * 100}%` : 4 }}
            />
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-around gap-3">
        {columns.map((column) => (
          <div key={column.id} className="flex flex-1 flex-col items-center gap-1.5 text-center">
            <Logo name={column.name} logo={column.logo} ade={column.ade} size={30} />
            <span className={cn("text-[12px]", column.ade ? "text-[color:var(--color-lamp)]" : "text-white/55")}>{column.name}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** 3. The price of one cloud hour, as dots on one scale; hover a dot for the plan and machine behind it. */
function PerHourChart() {
  const [hover, setHover] = useState<string | null>(null);
  const adePlans = PRICING_PLANS.filter((plan) => plan.priceUsd > 0).map((plan) => ({
    id: `ade-${plan.id}`,
    name: `ADE ${plan.name}`,
    logo: ADE_LOGO,
    cents: (plan.priceUsd * 100) / plan.hours,
    detail: `$${plan.priceUsd} for ${formatCount(plan.hours)} hours · 2 CPUs, 4 GB`,
    ade: true,
    estimate: false,
  }));
  const rivals = RIVALS.filter((rival) => rival.perHourCents != null).map((rival) => ({
    id: rival.id,
    name: rival.name,
    logo: rival.logo,
    cents: rival.perHourCents!,
    detail: `${rival.machine} · ${rival.note}`,
    ade: false,
    estimate: Boolean(rival.estimate),
  }));
  const dots = [...adePlans, ...rivals].sort((a, b) => a.cents - b.cents);
  const max = Math.max(...dots.map((dot) => dot.cents));
  const best = Math.min(...adePlans.map((dot) => dot.cents));
  const cheapestRival = Math.min(...rivals.map((dot) => dot.cents));
  const active = dots.find((dot) => dot.id === hover) ?? null;

  return (
    <Card eyebrow="Price of one cloud hour" title={`From ${best.toFixed(1)}¢. The rest from ${Math.round(cheapestRival)}¢.`}>
      <ul className="flex flex-1 flex-col justify-between gap-2">
        {dots.map((dot) => (
          <li key={dot.id} className="flex items-center gap-3" onMouseEnter={() => setHover(dot.id)} onMouseLeave={() => setHover(null)}>
            <span className={cn("w-[112px] shrink-0 truncate text-[13px]", dot.ade ? "font-semibold text-[color:var(--color-lamp)]" : "text-white/70")}>{dot.name}</span>
            <div className="relative h-6 flex-1">
              <div className="absolute inset-x-0 top-1/2 h-px bg-white/[0.08]" />
              <div className={cn("absolute top-1/2 h-px", dot.ade ? "bg-[color:var(--color-lamp)]/60" : "bg-white/25")} style={{ left: 0, width: `${(dot.cents / max) * 100}%` }} />
              <span
                className={cn(
                  "absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full transition-transform",
                  dot.ade ? "bg-[color:var(--color-lamp)] shadow-[0_0_14px_rgba(255,210,122,0.8)]" : "bg-white/70",
                  hover === dot.id && "scale-150",
                )}
                style={{ left: `${(dot.cents / max) * 100}%` }}
              />
            </div>
            <span className={cn("w-[58px] shrink-0 text-right text-[14px] font-semibold tabular-nums", dot.ade ? "text-[color:var(--color-lamp)]" : "text-white")}>
              {dot.estimate ? "≈" : ""}
              {dot.cents < 10 ? dot.cents.toFixed(1) : Math.round(dot.cents)}¢
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-4 h-5 truncate text-[13px] text-white/55">{active ? `${active.name}: ${active.detail}` : "Hover a dot for the plan and machine."}</p>
    </Card>
  );
}

/** 4. Every agent app ademark.dev measures, and whether it gives you cloud computers at all. */
function RosterChart() {
  const [filter, setFilter] = useState<"all" | "cloud" | "none">("all");
  const [hover, setHover] = useState<string | null>(null);
  const hovered = CLOUD_ROSTER.find((app) => app.name === hover) ?? null;
  const total = CLOUD_ROSTER.length;
  const without = CLOUD_ROSTER.filter((app) => app.cloud === "no").length;
  const closing = CLOUD_ROSTER.filter((app) => app.cloud === "closing").length;
  const shown = CLOUD_ROSTER.filter((app) => (filter === "all" ? true : filter === "cloud" ? app.cloud === "yes" : app.cloud !== "yes"));

  return (
    <Card
      eyebrow="Who gives you a cloud"
      title={without * 2 === total ? "Half have no cloud at all." : `${without} of ${total} have no cloud at all.`}
      aside={
        <div className="flex shrink-0 gap-1 rounded-full border border-white/10 bg-black/30 p-1 text-[12.5px]">
          {([
            ["all", "All"],
            ["cloud", "Cloud"],
            ["none", "None"],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
              className={cn("focus-ring rounded-full px-2.5 py-1 font-medium", filter === id ? "bg-white text-[#0d0b24]" : "text-white/60 hover:text-white")}
            >
              {label}
            </button>
          ))}
        </div>
      }
    >
      <div className="mb-4 flex items-center gap-3 rounded-2xl border border-[color:var(--color-lamp)]/35 bg-[rgba(255,210,122,0.08)] px-4 py-3">
        <Logo name="ADE" logo={ADE_LOGO} ade size={34} />
        <p className="min-w-0 flex-1 truncate text-[14px] text-white">
          <span className="font-semibold text-[color:var(--color-lamp)]">ADE Cloud</span> · {formatCount(FREE_PLAN.hours)} free hours, then from 1¢ an hour
        </p>
        <Check className="h-5 w-5 shrink-0 text-[color:var(--color-lamp)]" />
      </div>
      <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {shown.map((app) => (
          <li
            key={app.name}
            title={`${app.name}: ${app.detail}`}
            onMouseEnter={() => setHover(app.name)}
            onMouseLeave={() => setHover(null)}
            className={cn(
              "flex items-center gap-2 rounded-xl border px-2.5 py-2 text-[13px] transition-colors",
              app.cloud === "yes" ? "border-white/15 bg-white/[0.05] text-white/85" : "border-white/[0.06] bg-transparent text-white/45",
              hover === app.name && "border-white/35 text-white",
            )}
          >
            <span className="min-w-0 flex-1 truncate">{app.name}</span>
            {app.cloud === "yes" ? (
              <Check className="h-3.5 w-3.5 shrink-0 text-emerald-300/80" />
            ) : app.cloud === "closing" ? (
              <Clock className="h-3.5 w-3.5 shrink-0 text-rose-300/70" />
            ) : app.cloud === "unclear" ? (
              <HelpCircle className="h-3.5 w-3.5 shrink-0 text-white/35" />
            ) : (
              <X className="h-3.5 w-3.5 shrink-0 text-white/30" />
            )}
          </li>
        ))}
      </ul>
      <p className="mt-auto truncate pt-4 text-[13px] text-white/55">
        {hovered ? `${hovered.name}: ${hovered.detail}` : `${total} apps from ademark.dev${closing ? `; ${closing} is closing its cloud` : ""}. Hover one.`}
      </p>
    </Card>
  );
}

export type { Rival };
