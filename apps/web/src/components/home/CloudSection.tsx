import { ArrowUpRight, Check, Smartphone } from "lucide-react";
import { FREE_PLAN, PRICING_PLANS, formatCount } from "../../lib/cloudPricing";
import { cn } from "../../lib/cn";
import { LINKS } from "../../lib/links";
import { MARKETING_CTA_LABELS, MARKETING_CTA_POSITIONS, type MarketingCtaLabel } from "../../lib/marketingAnalytics";
import { CloudLockup } from "../cloud/CloudMark";
import { AppleMark } from "./marks";
import { CloudCharts, CloudSources } from "./CloudCharts";

/**
 * ADE Cloud on the home page, right under the hero. It picks a fight: three
 * benchmark-style charts against the agent apps that publish a cloud price,
 * a greyed card of the apps with no cloud at all, then the four plans, each
 * opening the web app at that plan. Competitor numbers live in
 * `lib/cloudCompetitors.ts` with their sources.
 */
export function CloudSection() {
  return (
    <section id="ade-cloud" aria-labelledby="ade-cloud-title" className="relative scroll-mt-16 overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[520px]" style={{ background: "radial-gradient(60% 100% at 50% 0%, rgba(124,58,237,0.16), transparent 70%)" }} />
      <div className="relative mx-auto max-w-[1180px] px-5 pb-[clamp(72px,8vw,112px)] pt-[clamp(72px,8vw,120px)] sm:px-8">
        <div>
          <CloudLockup className="text-[15px] text-white/80" markClassName="h-5" />
          <h2 id="ade-cloud-title" className="mt-5 font-display text-white" style={{ fontSize: "clamp(30px, 3.4vw, 46px)", lineHeight: 1.1 }}>
            Cloud computers for your agents.
            <br className="hidden md:block" />{" "}
            <span className="text-white/45">{formatCount(FREE_PLAN.hours)} free hours a month, then from 1¢ an hour.</span>
          </h2>
        </div>

        <CloudCharts />
        <Plans />

        <p className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-[14px] text-white/55">
          <span className="text-white/80">Coming soon</span>
          <span className="inline-flex items-center gap-2">
            <Smartphone className="h-4 w-4" /> iOS Simulator in the cloud
          </span>
          <span className="inline-flex items-center gap-2">
            <AppleMark className="h-4 w-4" /> Mac computers in the cloud
          </span>
        </p>
        <CloudSources />
      </div>
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
              "focus-ring group relative flex flex-col rounded-[20px] border bg-[#0f0e16] p-5 transition-colors",
              free ? "border-[#ffc861]/40 hover:border-[#ffc861]/70" : "border-white/[0.08] hover:border-white/25",
            )}
          >
            <div className="flex items-center justify-between">
              <span className="text-[15px] font-semibold text-white">{plan.name}</span>
              <ArrowUpRight className="h-4 w-4 text-white/35 transition-colors group-hover:text-white" />
            </div>
            <p className="mt-3 flex items-baseline gap-1">
              <span className={cn("font-display text-[36px] leading-none", free ? "text-[#ffc861]" : "text-white")}>${plan.priceUsd}</span>
              <span className="text-[13px] text-white/45">a month</span>
            </p>
            <p className="mt-2 text-[14px] text-white/70">
              <span className="font-mono text-white tabular-nums">{formatCount(plan.hours)}</span> hours
            </p>
            {free && (
              <p className="mt-3 inline-flex items-center gap-1.5 text-[13px] text-[#ffc861]">
                <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> No credit card needed
              </p>
            )}
          </a>
        );
      })}
    </div>
  );
}
