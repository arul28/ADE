import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { FREE_PLAN, FREE_RULES, PRICING_PLANS, centsPerIncludedHour, formatCount } from "../../lib/cloudPricing";
import { MARKETING_CTA_LABELS, MARKETING_CTA_POSITIONS, MARKETING_FEATURES } from "../../lib/marketingAnalytics";
import { linkToPricing } from "../../lib/siteFlags";
import { CloudLockup } from "../cloud/CloudMark";
import { ComingSoon } from "../cloud/ComingSoon";
import { City, Moon, NightSky } from "../cloud/NightCity";
import { PlanButton } from "../cloud/PlanButton";

const CHEAPEST_PAID = [...PRICING_PLANS].filter((plan) => plan.priceUsd > 0).sort((a, b) => a.priceUsd - b.priceUsd)[0]!;
const BIGGEST = PRICING_PLANS[PRICING_PLANS.length - 1]!;

/**
 * ADE Cloud on the home page, and what it leads with is the price: 100 hours
 * free every month, and the cheapest paid plan for a few dollars. The local
 * sections above show what ADE does on your machines; this one says you can
 * add cloud computers for next to nothing. Every number comes from
 * `lib/cloudPricing.ts`.
 */
export function CloudSection() {
  return (
    <section
      id="ade-cloud"
      aria-labelledby="ade-cloud-title"
      className="relative mt-[clamp(72px,9vw,128px)] scroll-mt-16 overflow-hidden"
      style={{ background: "linear-gradient(180deg, #0a0a0f 0%, var(--color-night) 24%, #17123a 62%, var(--color-dusk) 100%)" }}
    >
      <NightSky />
      <Moon className="right-[9%] top-[clamp(56px,8vw,110px)] h-[clamp(40px,4.6vw,68px)] w-[clamp(40px,4.6vw,68px)]" />

      <div className="relative mx-auto max-w-[1100px] px-5 pt-[clamp(88px,10vw,140px)] text-center sm:px-8">
        <CloudLockup className="justify-center text-[17px] text-white" markClassName="h-6" />
        <h2
          id="ade-cloud-title"
          className="mt-5 font-serif font-normal text-white"
          style={{ fontSize: "clamp(42px, 6vw, 92px)", lineHeight: 0.98, letterSpacing: "-0.02em" }}
        >
          Cloud computers for your agents.
          <br />
          <em className="italic text-[color:var(--color-lamp)]">Practically free.</em>
        </h2>
        <p className="mx-auto mt-6 max-w-[36rem] text-[clamp(16px,1.3vw,19px)] leading-[1.6] text-white/65">
          Send any task to its own computer in the cloud. Close your laptop; the agent keeps going and opens a pull request
          when it is done.
        </p>

        <dl className="mx-auto mt-[clamp(48px,6vw,80px)] grid max-w-[860px] grid-cols-1 sm:grid-cols-2">
          <PriceColumn
            amount={`${formatCount(FREE_PLAN.hours)} hours`}
            label="Free, every month"
            note="No credit card"
            lit
          />
          <PriceColumn
            amount={`${formatCount(CHEAPEST_PAID.hours)} hours`}
            label={`$${CHEAPEST_PAID.priceUsd} a month`}
            note={`${centsPerIncludedHour(CHEAPEST_PAID) ?? ""} an hour`}
            divided
          />
        </dl>
        <p className="mt-6 text-[14px] text-white/45">
          Running more? {BIGGEST.name} has {formatCount(BIGGEST.hours)} hours for ${BIGGEST.priceUsd}. A computer that is
          asleep uses none.
        </p>

        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <PlanButton
            cta={MARKETING_CTA_LABELS.GET_STARTED_FREE}
            position={MARKETING_CTA_POSITIONS.HOME_CLOUD}
            tone="lamp"
            className="w-full sm:w-auto"
          >
            Start free
          </PlanButton>
          {linkToPricing ? (
            <Link
              to="/pricing"
              data-ade-analytics-feature={MARKETING_FEATURES.VIEW_PRICING}
              className="focus-ring group inline-flex h-11 items-center gap-1.5 rounded-full border border-white/15 px-5 text-[15px] font-medium text-white/85 hover:border-white/35 hover:text-white"
            >
              See every plan
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          ) : null}
        </div>
        <p className="mt-4 text-[13px] text-white/40">
          Free hours need a GitHub account at least {FREE_RULES.githubMinAgeDays} days old.
        </p>

        <ComingSoon compact className="mt-12" />
      </div>

      <City scale={0.7} count={15} seed={11} className="mt-[clamp(56px,7vw,96px)]" />
    </section>
  );
}

/** One price, set as type: the hours large, then what they cost, then a quiet note. */
function PriceColumn({ amount, label, note, lit, divided }: { amount: string; label: string; note: string; lit?: boolean; divided?: boolean }) {
  return (
    <div className={divided ? "border-t border-white/[0.12] pt-8 sm:border-l sm:border-t-0 sm:pt-0" : "pb-8 sm:pb-0"}>
      <dt className="sr-only">{label}</dt>
      <dd
        className={lit ? "font-serif leading-none text-[color:var(--color-lamp)]" : "font-serif leading-none text-white"}
        style={{ fontSize: "clamp(52px, 6.4vw, 96px)", letterSpacing: "-0.02em", textShadow: lit ? "0 0 60px rgba(255,210,122,0.35)" : undefined }}
      >
        {amount}
      </dd>
      <dd className="mt-3 text-[clamp(18px,1.6vw,22px)] font-semibold text-white">{label}</dd>
      <dd className="mt-1 text-[14.5px] text-white/50">{note}</dd>
    </div>
  );
}
