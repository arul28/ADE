import { useId, useState } from "react";
import { ArrowUpRight, Smartphone } from "lucide-react";
import { CHECKED_ON, NO_CLOUD, NO_PUBLISHED_PRICE, RIVALS, adeMonthlyUsd } from "../../lib/cloudCompetitors";
import { FREE_PLAN, PRICING_PLANS, formatCount, formatUsd } from "../../lib/cloudPricing";
import { cn } from "../../lib/cn";
import { LINKS } from "../../lib/links";
import { MARKETING_CTA_LABELS, MARKETING_CTA_POSITIONS, type MarketingCtaLabel } from "../../lib/marketingAnalytics";
import { CloudLockup } from "../cloud/CloudMark";
import { City, Moon, NightSky } from "../cloud/NightCity";
import { AppleMark } from "./marks";

/**
 * ADE Cloud on the home page, right under the hero. It picks a fight: one
 * card that puts ADE's monthly bill next to every agent app that publishes a
 * cloud computer price (drag the hours and watch), or the free hours each
 * gives; the apps with no cloud at all; then the four plans, each opening
 * the web app at that plan. Competitor numbers live in
 * `lib/cloudCompetitors.ts` with their sources.
 */
export function CloudSection() {
  return (
    <section
      id="ade-cloud"
      aria-labelledby="ade-cloud-title"
      className="relative scroll-mt-16 overflow-hidden"
      style={{ background: "linear-gradient(180deg, #0a0a0f 0%, var(--color-night) 18%, #17123a 58%, var(--color-dusk) 100%)" }}
    >
      <NightSky />
      <Moon className="right-[9%] top-[clamp(56px,8vw,110px)] h-[clamp(40px,4.6vw,68px)] w-[clamp(40px,4.6vw,68px)]" />

      <div className="relative mx-auto max-w-[1180px] px-5 pt-[clamp(72px,8vw,120px)] sm:px-8">
        <div className="text-center">
          <CloudLockup className="justify-center text-[17px] text-white" markClassName="h-6" />
          <h2
            id="ade-cloud-title"
            className="mt-5 font-serif font-normal text-white"
            style={{ fontSize: "clamp(42px, 6vw, 92px)", lineHeight: 0.98, letterSpacing: "-0.02em" }}
          >
            Cloud computers for your agents.
            <br />
            <em className="italic text-[color:var(--color-lamp)]">For a fraction of the price.</em>
          </h2>
          <p className="mx-auto mt-5 max-w-[40rem] text-[clamp(16px,1.3vw,19px)] leading-[1.6] text-white/65">
            {formatCount(FREE_PLAN.hours)} hours free every month, then the cheapest cloud hours we could find.
          </p>
        </div>

        <PriceFight />
        <NoCloud />
        <Plans />

        <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[14px] text-white/65">
          <span className="text-[12px] font-medium uppercase tracking-[0.12em] text-[color:var(--color-lamp)]">Coming soon</span>
          <span className="inline-flex items-center gap-2">
            <Smartphone className="h-4 w-4 text-white/55" /> iOS Simulator in the cloud
          </span>
          <span className="inline-flex items-center gap-2">
            <AppleMark className="h-4 w-4 text-white/55" /> Mac computers in the cloud
          </span>
        </div>
      </div>

      <City scale={0.7} count={15} seed={11} className="mt-[clamp(48px,6vw,80px)]" />
    </section>
  );
}

type View = "bill" | "free";
const HOUR_STEPS = [25, 50, 100, 150, 200, 300, 400, 500, 750, 1000];

type Row = { id: string; name: string; logo?: string; machine: string; value: number; label: string; note: string; ade?: boolean; source?: string };

/** The comparison card: a monthly bill for the hours picked, or free hours, as bars that move. */
function PriceFight() {
  const [view, setView] = useState<View>("bill");
  const [step, setStep] = useState(HOUR_STEPS.indexOf(100));
  const hours = HOUR_STEPS[step]!;
  const sliderId = useId();

  const adeBill = adeMonthlyUsd(hours);
  const rows: Row[] =
    view === "bill"
      ? [
          { id: "ade", name: "ADE Cloud", logo: "/images/home/ade-icon.png", machine: "Small, 2 CPUs · 4 GB", value: adeBill, label: adeBill === 0 ? "Free" : formatUsd(adeBill), note: "The computer only; bring your own models", ade: true },
          ...RIVALS.map((rival) => {
            const value = rival.monthlyUsd(hours);
            return { id: rival.id, name: rival.name, logo: rival.logo, machine: rival.machine, value, label: formatUsd(Math.round(value * 100) / 100), note: rival.note, source: rival.source };
          }).sort((a, b) => a.value - b.value),
        ]
      : [
          { id: "ade", name: "ADE Cloud", logo: "/images/home/ade-icon.png", machine: "Every month, no card", value: FREE_PLAN.hours, label: `${formatCount(FREE_PLAN.hours)} hours`, note: "No credit card", ade: true },
          ...RIVALS.filter((rival) => rival.freeHours !== null).map((rival) => ({ id: rival.id, name: rival.name, logo: rival.logo, machine: "Every month", value: rival.freeHours ?? 0, label: `${rival.freeHours ?? 0} hours`, note: rival.note, source: rival.source })),
        ];
  const max = Math.max(...rows.map((row) => row.value), 1);
  const cheapestRival = Math.min(...rows.filter((row) => !row.ade).map((row) => row.value));
  const verdict =
    view === "free"
      ? `${formatCount(FREE_PLAN.hours)} free hours. ${RIVALS.filter((rival) => rival.freeHours === 0).map((rival) => rival.name).join(" and ")}: none.`
      : adeBill === 0
        ? `Free on ADE. ${formatUsd(Math.round(cheapestRival * 100) / 100)} at the cheapest of the rest.`
        : `${Math.max(2, Math.round(cheapestRival / adeBill))}× cheaper than the next best.`;

  return (
    <div className="mt-[clamp(36px,4.5vw,56px)] overflow-hidden rounded-[32px] border border-white/[0.1] bg-[#120f2b]/85 shadow-[0_50px_120px_-30px_rgba(124,58,237,0.55)] backdrop-blur-md">
      <div className="flex flex-col gap-5 border-b border-white/[0.08] px-6 py-5 sm:px-8 md:flex-row md:items-center md:justify-between">
        <div role="tablist" aria-label="Compare" className="flex w-fit gap-1 rounded-full border border-white/10 bg-black/30 p-1">
          {([
            ["bill", "Monthly bill"],
            ["free", "Free hours"],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={view === id}
              onClick={() => setView(id)}
              className={cn(
                "focus-ring rounded-full px-4 py-1.5 text-[14px] font-medium transition-colors",
                view === id ? "bg-[color:var(--color-lamp)] text-[#1a1430]" : "text-white/65 hover:text-white",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {view === "bill" ? (
          <div className="flex min-w-0 flex-1 items-center gap-4 md:max-w-[460px]">
            <label htmlFor={sliderId} className="shrink-0 whitespace-nowrap text-[14px] text-white/60">
              <span className="font-serif text-[26px] leading-none text-white tabular-nums">{formatCount(hours)}</span> hours a month
            </label>
            <input
              id={sliderId}
              type="range"
              min={0}
              max={HOUR_STEPS.length - 1}
              step={1}
              value={step}
              onChange={(event) => setStep(Number(event.target.value))}
              aria-valuetext={`${hours} hours a month`}
              className="ade-range"
              style={{ ["--fill" as string]: `${(step / (HOUR_STEPS.length - 1)) * 100}%` }}
            />
          </div>
        ) : null}
      </div>

      <div className="px-6 py-6 sm:px-8">
        <p key={verdict} className="ade-pop-in font-serif text-[clamp(26px,2.8vw,40px)] leading-tight text-white">
          {verdict}
        </p>
        <ul className="mt-6 flex flex-col gap-4">
          {rows.map((row) => (
            <li key={row.id} className="group grid grid-cols-[minmax(0,180px)_1fr] items-center gap-4 sm:grid-cols-[220px_1fr]">
              <div className="flex min-w-0 items-center gap-3">
                <RivalLogo name={row.name} logo={row.logo} ade={row.ade} />
                <div className="min-w-0">
                  <p className={cn("truncate text-[15px] font-semibold", row.ade ? "text-[color:var(--color-lamp)]" : "text-white")}>{row.name}</p>
                  <p className="truncate text-[12.5px] text-white/45">{row.machine}</p>
                </div>
              </div>
              <div className="flex min-w-0 items-center gap-3">
                <div className="relative h-9 flex-1 overflow-hidden rounded-full bg-white/[0.05]">
                  <div
                    className={cn(
                      "absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out",
                      row.ade
                        ? "bg-[linear-gradient(90deg,#f5b94a,#ffd27a)] shadow-[0_0_24px_rgba(255,210,122,0.55)]"
                        : "bg-[linear-gradient(90deg,rgba(255,255,255,0.14),rgba(255,255,255,0.26))]",
                    )}
                    style={{ width: `${Math.max(row.value > 0 || row.ade ? 3 : 0, (row.value / max) * 100)}%` }}
                  />
                  <span className="absolute inset-y-0 left-4 flex items-center text-[12.5px] text-white/0 transition-colors group-hover:text-white/70">
                    {row.note}
                  </span>
                </div>
                <span className={cn("w-[88px] shrink-0 text-right text-[18px] font-semibold tabular-nums", row.ade ? "text-[color:var(--color-lamp)]" : "text-white")}>
                  {row.label}
                </span>
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-6 text-[12.5px] leading-relaxed text-white/40">
          Each vendor's own pricing page, {CHECKED_ON}. The cheapest plan that runs the hours, for the machine named; model use not
          included. {NO_PUBLISHED_PRICE.join(", ")} bundle their cloud with model use and publish no computer price.{" "}
          {RIVALS.map((rival, i) => (
            <span key={rival.id}>
              <a href={rival.source} target="_blank" rel="noreferrer" className="underline decoration-white/20 underline-offset-2 hover:text-white/70">
                {rival.name}
              </a>
              {i < RIVALS.length - 1 ? ", " : "."}
            </span>
          ))}
        </p>
      </div>
    </div>
  );
}

function RivalLogo({ name, logo, ade }: { name: string; logo?: string; ade?: boolean }) {
  return (
    <span
      className={cn(
        "grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-[12px] border",
        ade ? "border-[color:var(--color-lamp)]/50 bg-[#1d1640] shadow-[0_0_20px_rgba(255,210,122,0.3)]" : "border-white/10 bg-white/[0.06]",
      )}
    >
      {logo ? <img src={logo} alt="" aria-hidden className="h-full w-full object-cover" /> : <span className="text-[16px] font-semibold text-white/80">{name[0]}</span>}
    </span>
  );
}

/** The agent apps that have no cloud computers to give you at all. */
function NoCloud() {
  return (
    <div className="mt-3 flex flex-col gap-4 rounded-[24px] border border-white/[0.08] bg-black/25 px-6 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
      <p className="text-[15px] text-white/70">
        <span className="font-semibold text-white">No cloud at all.</span> Bring your own server, or keep your laptop awake.
      </p>
      <ul className="flex flex-wrap gap-2">
        {NO_CLOUD.map((app) => (
          <li key={app.name} className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] py-1 pl-1 pr-3 text-[14px] text-white/75">
            <span className="grid h-7 w-7 place-items-center overflow-hidden rounded-full bg-white/[0.08] text-[12px] font-semibold">
              {app.logo ? <img src={app.logo} alt="" aria-hidden className="h-full w-full object-cover" /> : app.name[0]}
            </span>
            {app.name}
            <span className="text-white/35" aria-hidden>
              ✕
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const PLAN_CTA: Record<string, MarketingCtaLabel> = {
  free: MARKETING_CTA_LABELS.CHOOSE_PLAN_FREE,
  plus: MARKETING_CTA_LABELS.CHOOSE_PLAN_PLUS,
  pro: MARKETING_CTA_LABELS.CHOOSE_PLAN_PRO,
  max: MARKETING_CTA_LABELS.CHOOSE_PLAN_MAX,
};

/** The four plans in one row; each opens the web app's ADE Cloud settings at that plan. */
function Plans() {
  return (
    <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
      {PRICING_PLANS.map((plan) => {
        const free = plan.priceUsd === 0;
        return (
          <a
            key={plan.id}
            href={`${LINKS.webClient}/?cloudPlan=${plan.id}`}
            data-ade-analytics-cta={PLAN_CTA[plan.id]}
            data-ade-analytics-position={MARKETING_CTA_POSITIONS.HOME_CLOUD}
            className={cn(
              "focus-ring group relative flex flex-col rounded-[24px] border p-5 transition-transform hover:-translate-y-0.5",
              free ? "border-[color:var(--color-lamp)]/45 bg-[rgba(255,210,122,0.08)]" : "border-white/[0.09] bg-[#15112f]/80 hover:border-white/20",
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-[15px] font-semibold text-white">{plan.name}</span>
              <ArrowUpRight className="h-4 w-4 text-white/35 transition-colors group-hover:text-white" />
            </div>
            <p className="mt-3 flex items-baseline gap-1">
              <span className={cn("font-serif text-[40px] leading-none", free ? "text-[color:var(--color-lamp)]" : "text-white")}>${plan.priceUsd}</span>
              <span className="text-[13px] text-white/45">a month</span>
            </p>
            <p className="mt-2 text-[14px] text-white/70">
              <span className="font-semibold text-white">{formatCount(plan.hours)}</span> hours
            </p>
          </a>
        );
      })}
    </div>
  );
}
