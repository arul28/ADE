import { ArrowUpRight, Smartphone } from "lucide-react";
import { FREE_PLAN, PRICING_PLANS, formatCount } from "../../lib/cloudPricing";
import { cn } from "../../lib/cn";
import { LINKS } from "../../lib/links";
import { MARKETING_CTA_LABELS, MARKETING_CTA_POSITIONS, type MarketingCtaLabel } from "../../lib/marketingAnalytics";
import { CloudLockup } from "../cloud/CloudMark";
import { City, Moon, NightSky } from "../cloud/NightCity";
import { AppleMark } from "./marks";
import { CloudCharts } from "./CloudCharts";

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

        <CloudCharts />
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
