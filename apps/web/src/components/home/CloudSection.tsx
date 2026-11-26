import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { UNIT } from "../../lib/cloudPricing";
import { MARKETING_FEATURES } from "../../lib/marketingAnalytics";
import { CloudLockup } from "../cloud/CloudMark";
import { CloudIphoneBand } from "../cloud/CloudIphone";
import { CloudCharts, CloudSources } from "./CloudCharts";

/**
 * ADE Cloud on the home page, right under the hero. It picks a fight: three
 * benchmark-style charts against the agent apps that publish a cloud price,
 * a greyed card of the apps with no cloud at all, a link to the plans on
 * `/pricing`, then the ADE Cloud iPhone. Competitor numbers live in
 * `lib/cloudCompetitors.ts` with their sources.
 */
export function CloudSection() {
  return (
    <section id="ade-cloud" aria-labelledby="ade-cloud-title" className="relative scroll-mt-16 overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[520px]" style={{ background: "radial-gradient(60% 100% at 50% 0%, rgba(124,58,237,0.16), transparent 70%)" }} />
      <div className="relative mx-auto max-w-[1180px] px-5 pb-[clamp(32px,4vw,56px)] pt-[clamp(72px,8vw,120px)] sm:px-8">
        <div>
          <CloudLockup className="text-[15px] text-white/80" markClassName="h-5" />
          <h2 id="ade-cloud-title" className="mt-5 font-display text-white" style={{ fontSize: "clamp(30px, 3.4vw, 46px)", lineHeight: 1.1 }}>
            Cloud computers for your agents.
            <br className="hidden md:block" />{" "}
            <span className="text-white/45">{UNIT.smallUnlimited}</span>
          </h2>
        </div>

        <CloudCharts />

        <div className="mt-6 flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
          <CloudSources />
          <Link
            to="/pricing"
            data-ade-analytics-feature={MARKETING_FEATURES.VIEW_PRICING}
            className="focus-ring inline-flex items-center gap-1.5 rounded text-[15px] font-medium text-white/80 transition-colors hover:text-white"
          >
            Plans and pricing <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
        <CloudIphoneBand />
      </div>
    </section>
  );
}
