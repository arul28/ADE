import { Link } from "react-router-dom";
import { ArrowRight, ArrowUpRight, Check } from "lucide-react";
import { ADS_FREE_PLAN_SENTENCE, PRICING_PLANS, UNIT, formatCount } from "../../lib/cloudPricing";
import { cn } from "../../lib/cn";
import { MARKETING_CTA_POSITIONS, MARKETING_FEATURES } from "../../lib/marketingAnalytics";
import { PLAN_CTAS, planHref } from "../../lib/planLinks";
import { CloudLockup } from "../cloud/CloudMark";
import { ComingSoon } from "../cloud/ComingSoon";
import { CloudCharts, CloudSources } from "./CloudCharts";

/**
 * ADE Cloud on the home page, right under the hero. It picks a fight: three
 * benchmark-style charts against the agent apps that publish a cloud price,
 * a greyed card of the apps with no cloud at all, then the four plans, each
 * opening the web app at that plan, with the unit said once under them.
 * Competitor numbers live in
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
            <span className="text-white/45">{UNIT.smallUnlimited}</span>
          </h2>
        </div>

        <CloudCharts />

        <div className="mt-14 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <h3 className="font-display text-[clamp(24px,2.4vw,30px)] leading-tight text-white">Plans</h3>
          <Link
            to="/pricing"
            data-ade-analytics-feature={MARKETING_FEATURES.VIEW_PRICING}
            className="focus-ring inline-flex items-center gap-1.5 rounded text-[14px] text-white/70 transition-colors hover:text-white"
          >
            Full pricing <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
        <Plans />

        <p className="mt-5 max-w-[82ch] text-[14px] leading-relaxed text-white/60">{UNIT.unitSentence}</p>
        <p className="mt-2 max-w-[82ch] text-[13px] leading-relaxed text-white/45">{ADS_FREE_PLAN_SENTENCE}</p>
        <ComingSoon compact className="mt-6" />
        <CloudSources />
      </div>
    </section>
  );
}

/** The four plans in one row (cloud computers, then the month's hours or credits for the sizes bigger than Small); each opens the web app's ADE Cloud settings at that plan. */
function Plans() {
  return (
    <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
      {PRICING_PLANS.map((plan) => {
        const free = plan.priceUsd === 0;
        return (
          <a
            key={plan.id}
            href={planHref(plan.id)}
            data-ade-analytics-cta={PLAN_CTAS[plan.id].cta}
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
            <ul className="mt-3 flex flex-col gap-1 text-[14px] leading-snug text-white/70">
              <li>
                <span className="font-mono text-white tabular-nums">{formatCount(plan.computerLimit)}</span> cloud computers
              </li>
              <li>
                <span className="font-mono text-white tabular-nums">{formatCount(plan.hours)}</span> {plan.hours === 1 ? UNIT.one : UNIT.many} for {UNIT.spenders}
              </li>
              <li>{plan.adSupported ? "Ad-supported" : "No ads"}</li>
            </ul>
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
