import { Link } from "react-router-dom";
import { ArrowRight, Cloud } from "lucide-react";
import { cn } from "../../lib/cn";
import { FREE_PLAN, HIGHLIGHTED_PLAN, PRICING_PLANS, formatCount } from "../../lib/cloudPricing";
import { MARKETING_FEATURES } from "../../lib/marketingAnalytics";

/**
 * ADE Cloud on the home page: one line on what it is, the four plans at a
 * glance, and the way to `/pricing`. Styled like the feature wall above it.
 */
export function CloudPricingTeaser() {
  return (
    <section id="ade-cloud" className="mx-auto -mt-[clamp(24px,4vw,64px)] max-w-[1320px] scroll-mt-24 px-5 pb-[clamp(8px,2vw,24px)] sm:px-8">
      <div className="relative overflow-hidden rounded-[28px] border border-white/[0.07] bg-[#111116] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ background: "radial-gradient(70% 90% at 0% 0%, rgba(124,58,237,0.20), transparent 60%)" }}
        />
        <div className="relative grid gap-8 p-6 sm:p-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] lg:items-center lg:gap-12">
          <div>
            <div className="flex items-center gap-2">
              <Cloud className="h-5 w-5 text-[color:var(--color-violet-bright)]" />
              <span className="text-[13px] font-medium text-white/55">ADE Cloud</span>
            </div>
            <h2
              className="mt-3 font-serif font-normal text-white"
              style={{ fontSize: "clamp(30px, 3.4vw, 46px)", lineHeight: 1.04, letterSpacing: "-0.02em" }}
            >
              Agents that keep working
              <br />
              <em className="italic text-[color:var(--color-violet-bright)]">with the lid closed.</em>
            </h2>
            <p className="mt-4 max-w-[440px] text-[clamp(14px,1.1vw,16px)] leading-[1.55] text-white/55">
              Give every lane its own computer in the cloud. {formatCount(FREE_PLAN.hours)} hours free every month.
            </p>
            <Link
              to="/pricing"
              data-ade-analytics-feature={MARKETING_FEATURES.VIEW_PRICING}
              className="focus-ring group mt-6 inline-flex items-center gap-1.5 rounded-md text-sm font-semibold text-white"
            >
              See pricing
              <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
            </Link>
          </div>

          <Link
            to="/pricing"
            data-ade-analytics-feature={MARKETING_FEATURES.VIEW_PRICING}
            aria-label="See ADE Cloud pricing"
            className="focus-ring grid grid-cols-2 gap-3 rounded-[20px] sm:grid-cols-4"
          >
            {PRICING_PLANS.map((plan) => {
              const highlighted = plan.id === HIGHLIGHTED_PLAN;
              return (
                <div
                  key={plan.id}
                  className={cn(
                    "rounded-[20px] border p-4 transition-colors duration-300 sm:p-5",
                    highlighted
                      ? "border-[color:var(--color-violet-bright)]/45 bg-[rgba(124,58,237,0.14)]"
                      : "border-white/[0.07] bg-white/[0.02] hover:border-white/[0.14]",
                  )}
                >
                  <div className="text-[13px] font-medium text-white/60">{plan.name}</div>
                  <div className="mt-2 flex items-baseline gap-1">
                    <span className="text-[28px] font-semibold leading-none tracking-tight text-white">${plan.priceUsd}</span>
                    <span className="text-xs text-white/45">/mo</span>
                  </div>
                  <div className="mt-3 text-[13px] leading-snug text-white/55">
                    <span className="font-medium text-white/85">{formatCount(plan.hours)}</span> hours
                    <br />
                    <span className="font-medium text-white/85">{plan.diskGb} GB</span> disk
                  </div>
                </div>
              );
            })}
          </Link>
        </div>
      </div>
    </section>
  );
}
