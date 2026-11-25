import { useRef, useState, type ComponentType, type ReactNode } from "react";
import { ArrowDown, Bot, Check, ChevronDown, Clock, Gift, Recycle, X } from "lucide-react";

import { CloudLockup } from "../../components/cloud/CloudMark";
import { ComingSoon } from "../../components/cloud/ComingSoon";
import { PlanButton } from "../../components/cloud/PlanButton";
import { Moon, NightSky, PlanTower } from "../../components/cloud/NightCity";
import { InstallBlock } from "../../components/home/Hero";
import { Page } from "../../components/Page";
import { cn } from "../../lib/cn";
import {
  ADS_FREE_PLAN_SENTENCE,
  CLOUD_PHONE_ON_WEBSITE,
  CLOUD_SMALL_FAIR_USE_SENTENCE,
  FINDER_DAYS_A_MONTH,
  FREE_PLAN,
  FREE_RULES,
  GRAVITY_ADS_ON_WEBSITE,
  HOURLY_SIZES,
  INVITE_RULES,
  MOST_COMPUTERS,
  PAID_IDLE_DAYS,
  PHONE_CREDITS_PER_MINUTE,
  PRICING_PLANS,
  PRICING_SIZES,
  SMALL_SIZE,
  UNIT,
  cloudComputersPhrase,
  formatCents,
  formatCount,
  formatUsd,
  hoursOnSize,
  hoursOnSizesLine,
  listNames,
  suggestPlan,
  type PricingPlan,
  type PricingSize,
} from "../../lib/cloudPricing";
import { MARKETING_CTA_POSITIONS, MARKETING_FEATURES, MARKETING_SCREENS } from "../../lib/marketingAnalytics";
import { captureMarketingFeature } from "../../lib/marketingAnalyticsBrowser";
import { PLAN_CTAS } from "../../lib/planLinks";
import { useDocumentTitle } from "../../lib/useDocumentTitle";

/** Each plan's tower over its card: more floors and more lights for a bigger plan. */
const PLAN_TOWERS: Record<PricingPlan["id"], { floors: number; lit: number; seed: number }> = {
  free: { floors: 3, lit: 0.25, seed: 3 },
  plus: { floors: 5, lit: 0.35, seed: 8 },
  pro: { floors: 8, lit: 0.45, seed: 13 },
  max: { floors: 11, lit: 0.55, seed: 21 },
};

const PAID_PLANS = PRICING_PLANS.filter((plan) => plan.extraHourCents != null);
const CHEAPEST_PAID = [...PAID_PLANS].sort((a, b) => a.priceUsd - b.priceUsd)[0];
const OUTSIDE_AGENT_PLANS = PRICING_PLANS.filter((plan) => plan.outsideAgents);
const NO_OUTSIDE_AGENT_PLANS = PRICING_PLANS.filter((plan) => !plan.outsideAgents);
/** The extra unit's prices, one entry when every paid plan charges the same. */
const EXTRA_PRICES = [...new Set(PAID_PLANS.map((plan) => plan.extraHourCents ?? 0))];
/** The ADE Cloud iPhone joins the rate table once it is on the site. */
const PHONE_IN_CREDITS = CLOUD_PHONE_ON_WEBSITE;

const days = (count: number): string => `${count} ${count === 1 ? "day" : "days"}`;
/** Clock hours on a computer, which every mode counts in hours. */
const clockHours = (count: number): string => `${formatCount(count)} ${count === 1 ? "hour" : "hours"}`;

/** "2¢ on every paid plan", or "2¢ on Plus, 1.5¢ on Pro and 1.2¢ on Max" while they differ. */
function extraPriceList(): string {
  if (EXTRA_PRICES.length === 1) return `${formatCents(EXTRA_PRICES[0]!)} on every paid plan`;
  return listNames(PAID_PLANS.map((plan) => `${formatCents(plan.extraHourCents ?? 0)} on ${plan.name}`));
}

/** "Free has 2 cloud computers, Plus 3, Pro 10 and Max 20". */
const COMPUTER_LIMITS_LINE = listNames(
  PRICING_PLANS.map((plan, index) => (index === 0 ? `${plan.name} has ${cloudComputersPhrase(plan.computerLimit)}` : `${plan.name} ${formatCount(plan.computerLimit)}`)),
);

const serifHeading = "font-display text-white";
const wrap = "mx-auto max-w-[1180px] px-5 sm:px-8";
const sectionGap = "pt-[clamp(64px,7vw,96px)]";
const panel = "rounded-[24px] border border-white/[0.08] bg-[#100e22]";

/**
 * `/pricing`: ADE Cloud's plans under the night sky of the home page. The
 * plans come first, as four towers of a small skyline; then the unit (hours,
 * or credits) explained once with its rates, a plan finder for the unsure,
 * the details, what is coming, and questions. Plans are bought through ADE's
 * web app: a paid plan's button signs in there and goes to checkout. Free
 * starts in the app. Every number and unit word comes from
 * `lib/cloudPricing.ts`, which reads the plan facts the server bills with.
 */
export function PricingPage() {
  useDocumentTitle("ADE Cloud Pricing");
  return (
    <Page>
      <div
        className="overflow-x-clip text-white"
        style={{ background: "linear-gradient(180deg, var(--color-night) 0%, #1b1440 24%, #120e2b 46%, #0c0a1a 72%, #0a0a0f 100%)" }}
      >
        <PricingHero />
        <RateSection />
        <PlanFinder />
        <DetailsSection />
        <section aria-labelledby="soon-title" className={cn(wrap, sectionGap)}>
          <SectionTitle id="soon-title" title="Coming soon" />
          <ComingSoon className="mt-8" />
        </section>
        <FaqSection />
        <section className={cn(wrap, "pb-[clamp(72px,8vw,112px)] pt-[clamp(56px,6vw,88px)] text-center")}>
          <h2 className={serifHeading} style={{ fontSize: "clamp(36px, 4.6vw, 60px)", lineHeight: 1.02 }}>
            The ADE app is free today.
          </h2>
          <p className="mx-auto mt-4 max-w-[32rem] text-[15px] leading-[1.6] text-white/55">
            Run your agents on your own computers, and add ADE Cloud when you want it.
          </p>
          <InstallBlock position={MARKETING_CTA_POSITIONS.PRICING_PAGE} />
        </section>
      </div>
    </Page>
  );
}

function PricingHero() {
  return (
    <section aria-labelledby="plans-title" id="plans" className="relative overflow-hidden">
      <NightSky seed={21} />
      <Moon className="right-[8%] top-[clamp(36px,6vw,80px)] h-[clamp(40px,4.4vw,64px)] w-[clamp(40px,4.4vw,64px)]" />
      <div className={cn(wrap, "relative pb-4 pt-[clamp(36px,4.4vw,64px)]")}>
        <div className="text-center">
          <div className="flex items-center justify-center gap-3">
            <CloudLockup className="text-[16px] text-white" markClassName="h-6" />
          </div>
          <h1
            id="plans-title"
            className={cn(serifHeading, "mt-5 text-balance")}
            style={{ fontSize: "clamp(40px, 5.6vw, 84px)", lineHeight: 0.98, letterSpacing: "-0.04em" }}
          >
            {UNIT.smallUnlimitedParts[0]}
            <br />
            <span className="text-white/45">{UNIT.smallUnlimitedParts[1]}</span>
          </h1>
          <p className="mx-auto mt-5 max-w-[44rem] text-[clamp(16px,1.3vw,19px)] leading-[1.6] text-white/65">
            {UNIT.offerRest}
          </p>
          <a
            href="#rates"
            className="focus-ring mt-3 inline-flex items-center gap-1.5 rounded text-[15px] text-white/75 underline decoration-white/25 underline-offset-4 hover:text-white"
          >
            {UNIT.rateTitle} <ArrowDown className="h-4 w-4" />
          </a>
        </div>

        <div className="mt-[136px] grid gap-x-4 gap-y-[150px] sm:grid-cols-2 xl:grid-cols-4">
          {PRICING_PLANS.map((plan) => (
            <PlanCard key={plan.id} plan={plan} />
          ))}
        </div>

        <p className="mx-auto mt-8 max-w-[48rem] text-center text-[14px] leading-[1.6] text-white/45">
          Prices are monthly, in US dollars. {CLOUD_SMALL_FAIR_USE_SENTENCE} {ADS_FREE_PLAN_SENTENCE}
        </p>
      </div>
    </section>
  );
}

/** A plan card's look for its accent: Free in lamp gold, the cheapest paid plan in violet, the rest quiet. */
const PLAN_CARD_TONES: Record<"lamp" | "violet" | "quiet", string> = {
  lamp: "border-[color:var(--color-lamp)]/45 bg-[linear-gradient(180deg,rgba(255,210,122,0.14),rgba(21,17,47,0.92)_45%)] shadow-[0_30px_80px_-30px_rgba(255,210,122,0.45)]",
  violet: "border-[color:var(--color-violet-bright)]/45 bg-[linear-gradient(180deg,rgba(167,139,250,0.18),rgba(21,17,47,0.92)_45%)] shadow-[0_30px_80px_-30px_rgba(139,92,246,0.6)]",
  quiet: "border-white/[0.09] bg-[#15112f]/90",
};

/** One plan: its price, its month of hours (or credits), then the same rows in the same order on every card, so the four read across. */
function PlanCard({ plan }: { plan: PricingPlan }) {
  const tower = PLAN_TOWERS[plan.id];
  const free = plan.priceUsd === 0;
  const cheapest = plan.id === CHEAPEST_PAID?.id;
  const lit = free || cheapest;
  const tone = free ? "lamp" : cheapest ? "violet" : "quiet";
  // Where ads reach Free, its Small is unlimited only with sponsored cards on, in the US.
  const smallNeedsAds = free && GRAVITY_ADS_ON_WEBSITE;
  return (
    <div className={cn("relative flex flex-col rounded-[26px] border p-6", PLAN_CARD_TONES[tone])}>
      <PlanTower floors={tower.floors} litShare={tower.lit} seed={tower.seed} className="absolute bottom-full right-7 opacity-95" />
      <h2 className="text-[18px] font-semibold text-white">{plan.name}</h2>
      <p className="mt-1 text-[14px] text-white/55">{plan.pitch}</p>
      <p className="mt-4 flex items-baseline gap-1.5">
        <span
          className={cn("font-display leading-none", lit ? "text-[color:var(--color-lamp)]" : "text-white")}
          style={{ fontSize: "clamp(52px, 5vw, 64px)" }}
        >
          ${plan.priceUsd}
        </span>
        <span className="text-[14px] text-white/45">a month</span>
      </p>
      <div className="mt-5 rounded-2xl border border-white/[0.08] bg-black/25 px-4 py-3.5">
        <p className="flex items-baseline gap-2">
          <span className="text-[30px] font-semibold leading-none tracking-tight text-white tabular-nums">{formatCount(plan.hours)}</span>
          <span className="text-[15px] text-white/75">{plan.hours === 1 ? UNIT.one : UNIT.many}</span>
        </p>
        <p className="mt-1.5 text-[13px] text-white/50">A month, for {UNIT.spenders}</p>
      </div>
      <dl className="mt-4 flex flex-1 flex-col text-[14px]">
        <PlanRow label="Cloud computers" value={formatCount(plan.computerLimit)} />
        <PlanRow label="Small computers" value={smallNeedsAds ? "Unlimited in the US, with sponsored cards" : "Unlimited"} />
        <PlanRow label={UNIT.extraTitle} value={plan.extraHourCents == null ? "None" : `${formatCents(plan.extraHourCents)} each`} muted={plan.extraHourCents == null} />
        <PlanRow label="Outside agents" value={plan.outsideAgents ? "Yes" : "No"} muted={!plan.outsideAgents} />
        <PlanRow label="Ads" value={plan.adSupported ? "Ad-supported" : "No ads"} />
        <PlanRow label="Unused computers kept" value={days(plan.idleDays)} />
      </dl>
      <PlanButton
        cta={PLAN_CTAS[plan.id].cta}
        position={MARKETING_CTA_POSITIONS.PRICING_PAGE}
        plan={plan.id}
        tone={tone}
        className="mt-6 w-full"
      >
        {PLAN_CTAS[plan.id].label}
      </PlanButton>
      {/* Every card keeps this line's room, so the four buttons stay level. */}
      <p aria-hidden={!free} className={cn("mt-3 text-center text-[13px] text-[color:var(--color-lamp)]", !free && "invisible")}>
        No credit card needed
      </p>
      {smallNeedsAds ? (
        <p className="mt-2 text-[12px] leading-[1.5] text-white/45">
          Outside the US, or without sponsored cards, Small computers use your {UNIT.count(plan.hours)} too.
        </p>
      ) : null}
    </div>
  );
}

/** One row of a plan card: a label and its value on one line, divided from the next. */
function PlanRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-white/[0.06] py-2.5 last:border-b-0">
      <dt className="text-white/55">{label}</dt>
      <dd className={cn("text-right font-semibold", muted ? "text-white/45" : "text-white")}>{value}</dd>
    </div>
  );
}

/**
 * The unit, explained once: what each size uses an hour awake (and the
 * iPhone a minute, under credits once it is on the site), then how long a
 * month of each plan lasts on each size, in clock hours.
 */
function RateSection() {
  return (
    <section aria-labelledby="rates-title" id="rates" className={cn(wrap, sectionGap, "scroll-mt-16")}>
      <SectionTitle id="rates-title" title={UNIT.rateTitle}>
        {UNIT.unitSentence} A computer uses nothing while it sleeps, and your {UNIT.many} start over each month.
      </SectionTitle>
      <div className="mt-8 grid gap-4 lg:grid-cols-[1fr_1fr]">
        <div className={cn(panel, "p-5 sm:p-7")}>
          <h3 className="text-[17px] font-semibold text-white">Each size</h3>
          <ul className="mt-4 divide-y divide-white/[0.07]">
            {PRICING_SIZES.map((size) => (
              <RateRow
                key={size.id}
                name={size.label}
                detail={`${size.full ? "Full computer · " : ""}${size.cpu} CPU · ${size.memoryGb} GB memory · ${size.use}`}
                per="Each hour uses"
                value={size.rate > 0 ? UNIT.count(size.rate) : "None"}
                note={size.rate > 0 ? undefined : GRAVITY_ADS_ON_WEBSITE ? "Unlimited on paid plans, and on Free in the US with sponsored cards" : "Unlimited, on every plan"}
              />
            ))}
            {PHONE_IN_CREDITS ? (
              <RateRow name="ADE Cloud iPhone" detail="An iOS Simulator in the cloud" per="Each minute uses" value={UNIT.count(PHONE_CREDITS_PER_MINUTE)} />
            ) : null}
          </ul>
        </div>
        <div className={cn(panel, "p-5 sm:p-7")}>
          <h3 className="text-[17px] font-semibold text-white">How long a month lasts</h3>
          <p className="mt-1 text-[14px] text-white/50">
            Hours on one computer of each size{PHONE_IN_CREDITS ? ", or minutes on the iPhone" : ""}, with a month of each plan's {UNIT.many}.
          </p>
          <table className="mt-4 w-full table-fixed border-collapse text-[14px]">
            <thead>
              <tr className="text-white/45">
                <th scope="col" className="w-[26%] pb-2 text-left font-normal">
                  <span className="sr-only">Size</span>
                </th>
                {PRICING_PLANS.map((plan) => (
                  <th key={plan.id} scope="col" className="pb-2 text-right font-medium">
                    {plan.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.07]">
              <tr>
                <th scope="row" className="py-3 text-left font-semibold text-white">
                  {SMALL_SIZE.label}
                </th>
                <td colSpan={PRICING_PLANS.length} className="py-3 text-center text-[color:var(--color-lamp)]">
                  Unlimited on every plan
                </td>
              </tr>
              {HOURLY_SIZES.map((size) => (
                <tr key={size.id}>
                  <th scope="row" className="py-3 text-left font-semibold text-white">
                    {size.label}
                  </th>
                  {PRICING_PLANS.map((plan) => (
                    <td key={plan.id} className="py-3 text-right font-mono tabular-nums text-white/85">
                      {formatCount(hoursOnSize(plan.hours, size) ?? 0)}
                    </td>
                  ))}
                </tr>
              ))}
              {PHONE_IN_CREDITS ? (
                <tr>
                  <th scope="row" className="py-3 text-left font-semibold text-white">
                    iPhone <span className="font-normal text-white/45">(min)</span>
                  </th>
                  {PRICING_PLANS.map((plan) => (
                    <td key={plan.id} className="py-3 text-right font-mono tabular-nums text-white/85">
                      {formatCount(Math.floor(plan.hours / PHONE_CREDITS_PER_MINUTE))}
                    </td>
                  ))}
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function RateRow({ name, detail, per, value, note }: { name: string; detail: string; per: string; value: string; note?: string }) {
  return (
    <li className="flex items-center justify-between gap-4 py-3.5">
      <div className="min-w-0">
        <p className="text-[15px] font-semibold text-white">{name}</p>
        <p className="mt-0.5 text-[13px] leading-[1.45] text-white/50">{detail}</p>
        {note ? <p className="mt-0.5 text-[13px] leading-[1.45] text-[color:var(--color-lamp)]/85">{note}</p> : null}
      </div>
      <div className="shrink-0 text-right">
        <p className="text-[12px] text-white/45">{per}</p>
        <p className="font-display text-[22px] leading-tight text-[color:var(--color-lamp)]">{value}</p>
      </div>
    </li>
  );
}

/** Every hour of the month, round-the-clock. */
const MAX_HOURS_A_MONTH = 24 * FINDER_DAYS_A_MONTH;
const HOURS_STEP = 10;

/**
 * "Not sure which plan?": computers, hours a month each and size make a month
 * of the plan's unit (none on Small), and the plan that has the computers and
 * runs it. Only the first change is reported, never the numbers.
 */
function PlanFinder() {
  const [computers, setComputers] = useState(2);
  const [hoursEach, setHoursEach] = useState(120);
  const [sizeId, setSizeId] = useState<PricingSize["id"]>(SMALL_SIZE.id);
  const reported = useRef(false);

  const size = PRICING_SIZES.find((entry) => entry.id === sizeId) ?? SMALL_SIZE;
  const usesUnits = size.rate > 0;
  const needed = Math.round(computers * hoursEach * size.rate);
  const suggestion = suggestPlan(needed, computers);
  const best = suggestion?.pick;
  const other = suggestion?.other ?? null;

  const change = (apply: () => void) => {
    apply();
    if (!reported.current) {
      reported.current = true;
      captureMarketingFeature(MARKETING_FEATURES.USE_PLAN_FINDER, MARKETING_SCREENS.PRICING);
    }
  };

  return (
    <section aria-labelledby="finder-title" className={cn(wrap, sectionGap)}>
      <SectionTitle id="finder-title" title="Not sure which plan?">
        Tell us how your agents work.
      </SectionTitle>

      <div className="mt-8 grid gap-8 rounded-[28px] border border-white/[0.08] bg-white/[0.025] p-5 sm:p-9 lg:grid-cols-[1.1fr_1fr] lg:gap-12">
        <div className="flex flex-col gap-8">
          <Slider
            id="finder-computers"
            label="Cloud computers"
            value={computers}
            min={1}
            max={MOST_COMPUTERS}
            display={String(computers)}
            onChange={(value) => change(() => setComputers(value))}
          />
          <Slider
            id="finder-hours"
            label="Hours a month, each computer"
            value={hoursEach}
            min={HOURS_STEP}
            max={Math.floor(MAX_HOURS_A_MONTH / HOURS_STEP) * HOURS_STEP}
            step={HOURS_STEP}
            display={`${formatCount(hoursEach)} h`}
            onChange={(value) => change(() => setHoursEach(value))}
          />
          <fieldset>
            <legend className="text-[15px] font-medium text-white/85">Size</legend>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {PRICING_SIZES.map((entry) => {
                const active = entry.id === sizeId;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => change(() => setSizeId(entry.id))}
                    className={cn(
                      "focus-ring rounded-2xl border px-3 py-2.5 text-left transition-colors",
                      active
                        ? "border-[color:var(--color-lamp)]/60 bg-[rgba(255,210,122,0.1)] text-white"
                        : "border-white/[0.1] text-white/70 hover:border-white/25 hover:text-white",
                    )}
                  >
                    <span className="block text-[14px] font-semibold">{entry.label}</span>
                    <span className="block text-[12px] leading-[1.4] text-white/45">{entry.use}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>
        </div>

        <div className="flex flex-col justify-between rounded-[22px] bg-[#13112a] p-5 sm:p-8" aria-live="polite">
          <div>
            <p className="text-[14px] text-white/55">
              {usesUnits ? (
                <>
                  About <span className="font-semibold text-white">{UNIT.count(needed)}</span> of your plan a month
                </>
              ) : (
                <>
                  <span className="font-semibold text-white">No {UNIT.many}:</span> {size.label} computers never use them
                </>
              )}
            </p>
            {best ? (
              <>
                <p className={cn(serifHeading, "mt-3")} style={{ fontSize: "clamp(40px, 4.4vw, 60px)", lineHeight: 1 }}>
                  {best.plan.name}{" "}
                  <span className="text-[color:var(--color-lamp)]">{formatUsd(best.costUsd)}</span>
                  <span className="ml-2 font-sans text-[15px] tracking-normal text-white/45">a month</span>
                </p>
                <p className="mt-4 text-[15px] leading-[1.6] text-white/65">
                  {!usesUnits
                    ? `${best.plan.name} has ${cloudComputersPhrase(best.plan.computerLimit)}, and ${size.label} computers never use your ${UNIT.many}.`
                    : best.extraHours > 0
                      ? `${best.plan.name} has ${cloudComputersPhrase(best.plan.computerLimit)} and ${UNIT.count(best.plan.hours)}. The other ${UNIT.count(best.extraHours)} cost ${formatCents(best.plan.extraHourCents ?? 0)} each, with ${UNIT.extra} turned on.`
                      : best.plan.priceUsd === 0
                        ? `That fits in the free ${UNIT.count(best.plan.hours)}, on ${cloudComputersPhrase(best.plan.computerLimit)}.`
                        : `${best.plan.name} has ${cloudComputersPhrase(best.plan.computerLimit)} and ${UNIT.count(best.plan.hours)}, ${best.spareHours > 0 ? `so ${UNIT.count(best.spareHours)} ${best.spareHours === 1 ? "is" : "are"} left over` : "just enough"}.`}
                </p>
                {other ? (
                  <p className="mt-2 text-[14px] leading-[1.6] text-white/45">
                    {other.extraHours > 0
                      ? `${other.plan.name} with ${UNIT.extra} would be about ${formatUsd(other.costUsd)}.`
                      : `Or ${other.plan.name} at ${formatUsd(other.costUsd)}, with no ${UNIT.extra}.`}
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
          {best ? (
            <PlanButton
              cta={PLAN_CTAS[best.plan.id].cta}
              position={MARKETING_CTA_POSITIONS.PLAN_FINDER}
              plan={best.plan.id}
              tone="lamp"
              className="mt-8 w-full"
            >
              {PLAN_CTAS[best.plan.id].label}
            </PlanButton>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function Slider({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  display,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  display: string;
  onChange: (value: number) => void;
}) {
  const fill = `${((value - min) / (max - min)) * 100}%`;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-[15px] font-medium text-white/85">
          {label}
        </label>
        <span className="whitespace-nowrap font-display text-[30px] leading-none text-white tabular-nums">{display}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="ade-range mt-3"
        style={{ ["--fill" as string]: fill }}
      />
    </div>
  );
}

function SectionTitle({ id, title, children }: { id: string; title: string; children?: ReactNode }) {
  return (
    <>
      <h2 id={id} className={serifHeading} style={{ fontSize: "clamp(30px, 3.4vw, 44px)", lineHeight: 1.06 }}>
        {title}
      </h2>
      {children ? <p className="mt-3 max-w-[40rem] text-[16px] leading-[1.6] text-white/55">{children}</p> : null}
    </>
  );
}

type Accent = { color: string; glow: string };
const AMBER: Accent = { color: "#ffd27a", glow: "rgba(255,210,122,0.14)" };
const SKY: Accent = { color: "#7dd3fc", glow: "rgba(56,189,248,0.14)" };
const MINT: Accent = { color: "#6ee7b7", glow: "rgba(52,211,153,0.13)" };
const VIOLET: Accent = { color: "#c4b5fd", glow: "rgba(167,139,250,0.15)" };

/** The rules most people never need: going past a plan, the free plan, outside agents, then what happens to unused computers. */
function DetailsSection() {
  return (
    <section aria-labelledby="details-title" className={cn(wrap, sectionGap)}>
      <SectionTitle id="details-title" title="The details" />
      <div className="mt-8 flex flex-col gap-4">
        <div className="grid gap-4 lg:grid-cols-3">
          <ExtraCard />
          <FreePlanCard />
          <OutsideAgentsCard />
        </div>
        <CleanupPanel />
      </div>
    </section>
  );
}

/** A details card: an accent-coloured icon and title, and a soft glow of the same colour. */
function DetailCard({ accent, icon: Icon, title, note, children, className }: { accent: Accent; icon: ComponentType<{ className?: string }>; title: string; note?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("relative overflow-hidden p-5 sm:p-7", panel, className)}>
      <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: `radial-gradient(90% 70% at 100% 0%, ${accent.glow}, transparent 65%)` }} />
      <div className="relative">
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[11px] border border-white/10 bg-white/[0.04]" style={{ color: accent.color }}>
            <Icon className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0">
            <h3 className="text-[17px] font-semibold text-white">{title}</h3>
            {note ? <p className="text-[13.5px] leading-[1.45] text-white/50">{note}</p> : null}
          </div>
        </div>
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}

function CheckList({ accent, items }: { accent: Accent; items: string[] }) {
  return (
    <ul className="flex flex-col gap-3 text-[14px] leading-relaxed text-white/70">
      {items.map((line) => (
        <li key={line} className="flex items-start gap-2.5">
          <Check className="mt-0.5 h-4 w-4 shrink-0" style={{ color: accent.color }} />
          {line}
        </li>
      ))}
    </ul>
  );
}

/** Past the plan: paid plans buy more of the unit after use; Free stops instead. */
function ExtraCard() {
  const most = Math.max(...PAID_PLANS.map((plan) => plan.extraHourCents ?? 0));
  const onePrice = EXTRA_PRICES.length === 1 ? EXTRA_PRICES[0]! : null;
  return (
    <DetailCard accent={AMBER} icon={Clock} title={UNIT.extraTitle} note={`Paid plans can go past their ${UNIT.many}, if you turn it on.`}>
      {onePrice != null ? (
        <>
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-display text-[56px] leading-none" style={{ color: AMBER.color }}>
              {formatCents(onePrice)}
            </span>
            <span className="text-[15px] text-white/55">for each {UNIT.one} once your plan's run out</span>
          </p>
          <div className="mt-6">
            <CheckList accent={AMBER} items={[`On ${listNames(PAID_PLANS.map((plan) => plan.name))}`, "Billed after use", "Turn it on in ADE Cloud settings"]} />
          </div>
        </>
      ) : (
        <ul className="flex flex-col gap-4">
          {PAID_PLANS.map((plan) => (
            <li key={plan.id}>
              <div className="flex items-baseline justify-between">
                <span className="text-[15px] text-white/75">{plan.name}</span>
                <span className="text-[14px] text-white/50">
                  <span className="font-display text-[24px] text-white">{formatCents(plan.extraHourCents ?? 0)}</span> a credit
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                <div className="h-full rounded-full" style={{ width: `${((plan.extraHourCents ?? 0) / most) * 100}%`, background: AMBER.color }} />
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-5 text-[13.5px] leading-[1.5] text-white/45">
        On Free, {UNIT.spenders} pause until next month instead. Small computers keep working{GRAVITY_ADS_ON_WEBSITE ? " in the US with sponsored cards" : ""}.
      </p>
    </DetailCard>
  );
}

function FreePlanCard() {
  const rules = [
    `A GitHub account at least ${days(FREE_RULES.githubMinAgeDays)} old`,
    "Newer account? Add a card to start now. It is not charged.",
    "One free plan for each GitHub account, and for each computer you use it from",
    `Invite a friend: you both get ${formatCount(INVITE_RULES.rewardHours)} ${UNIT.extra} that never expire, for up to ${INVITE_RULES.rewardLimit} friends`,
  ];
  return (
    <DetailCard accent={MINT} icon={Gift} title="The free plan" note="You never pay to start.">
      <p className="font-display text-[34px] leading-[1.05]" style={{ color: MINT.color }}>
        Unlimited Small
      </p>
      <p className="mt-1 text-[14px] text-white/50">
        {cloudComputersPhrase(FREE_PLAN.computerLimit)} · {UNIT.count(FREE_PLAN.hours)} a month for {UNIT.spenders}
      </p>
      <div className="mt-5">
        <CheckList accent={MINT} items={rules} />
      </div>
    </DetailCard>
  );
}

/** Which plans let an agent outside ADE (through ADE MCP) start ADE Cloud work. */
function OutsideAgentsCard() {
  return (
    <DetailCard accent={SKY} icon={Bot} title="Outside agents" note="Agents outside ADE, through ADE MCP.">
      <p className="text-[15px] leading-[1.6] text-white/70">
        A bot or another app's agent can start work on ADE Cloud on {listNames(OUTSIDE_AGENT_PLANS.map((plan) => plan.name))}.
      </p>
      <ul className="mt-6 grid grid-cols-2 gap-3 text-[14px] text-white/75">
        {PRICING_PLANS.map((plan) => (
          <li key={plan.id} className="flex items-center gap-2.5">
            {plan.outsideAgents ? <Check className="h-4 w-4 shrink-0" style={{ color: SKY.color }} /> : <X className="h-4 w-4 shrink-0 text-white/35" />}
            <span className={plan.outsideAgents ? undefined : "text-white/45"}>{plan.name}</span>
          </li>
        ))}
      </ul>
      {NO_OUTSIDE_AGENT_PLANS.length > 0 ? (
        <p className="mt-5 text-[13.5px] leading-[1.5] text-white/45">
          Agents inside ADE, automations and webhooks use ADE Cloud on {listNames(NO_OUTSIDE_AGENT_PLANS.map((plan) => plan.name))} too.
        </p>
      ) : null}
    </DetailCard>
  );
}

function CleanupPanel() {
  const steps = [
    {
      title: "It sits unused",
      body: `For ${days(FREE_PLAN.idleDays)} on Free, or ${days(PAID_IDLE_DAYS)} on a paid plan.`,
    },
    { title: "You get an email", body: "It comes before anything is deleted, and lists what will not be kept." },
    {
      title: "Your work is pushed",
      body: "ADE commits the work and pushes it to the task's branch on GitHub. Files git ignores, like .env, are not pushed.",
    },
    { title: "The computer goes", body: "The task and its chats stay. Your next message makes a new computer from the branch." },
  ];
  return (
    <DetailCard accent={VIOLET} icon={Recycle} title="Unused computers" note="ADE deletes computers nobody uses. This is what happens first.">
      <ol className="relative grid gap-8 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6">
        <span aria-hidden className="absolute left-4 right-4 top-4 hidden h-px lg:block" style={{ background: `linear-gradient(90deg, ${VIOLET.color}, transparent)` }} />
        {steps.map((step, index) => (
          <li key={step.title} className="relative">
            <span
              className="relative grid h-8 w-8 place-items-center rounded-full border text-[14px] font-semibold"
              style={{ color: VIOLET.color, borderColor: `${VIOLET.color}66`, background: "#17132e" }}
            >
              {index + 1}
            </span>
            <h4 className="mt-4 text-[16px] font-semibold text-white">{step.title}</h4>
            <p className="mt-2 text-[14px] leading-relaxed text-white/55">{step.body}</p>
          </li>
        ))}
      </ol>
    </DetailCard>
  );
}

function FaqSection() {
  return (
    <section aria-labelledby="faq-title" className={cn(wrap, "pb-10", sectionGap)}>
      <div className="max-w-[880px]">
        <SectionTitle id="faq-title" title="Questions" />
        <div className="mt-6 divide-y divide-white/[0.08] border-y border-white/[0.08]">
          <FaqItem question="How do I pick a plan?">
            Press its button: ADE's web app signs you in and takes you to checkout. Or pick one in the ADE app, in
            Settings under ADE Cloud. Free needs no credit card.
          </FaqItem>
          <FaqItem question="Are Small computers really unlimited?">
            Yes. {UNIT.smallUnlimited} Each one counts toward your plan's cloud computers, and it sleeps when work
            stops. {CLOUD_SMALL_FAIR_USE_SENTENCE}
          </FaqItem>
          <FaqItem question="What is a credit?">
            {UNIT.unitSentence} Free's {UNIT.count(FREE_PLAN.hours)} last {hoursOnSizesLine(FREE_PLAN.hours, ", ")}.
            A computer that is asleep uses no {UNIT.many}, and your {UNIT.many} start over each month.
          </FaqItem>
          <FaqItem question={`What happens when my ${UNIT.many} run out?`}>
            On Free, your {listNames(HOURLY_SIZES.map((size) => size.label))} computers{PHONE_IN_CREDITS ? " and the ADE Cloud iPhone" : ""} stop
            until next month, or until you pick a paid plan; {SMALL_SIZE.label} computers keep working
            {GRAVITY_ADS_ON_WEBSITE ? " in the US with sponsored cards" : ""}. On a paid plan, turn on {UNIT.extra} in Settings and
            your agents keep working: each extra {UNIT.one} costs {extraPriceList()}, billed after use. With {UNIT.extra}{" "}
            off, work on the bigger sizes stops at your plan's {UNIT.many}.
          </FaqItem>
          <FaqItem question="Can I change plans or cancel?">
            Yes, any time in Settings › ADE Cloud. A bigger plan starts right away, and you pay the difference for the
            rest of the month. A smaller plan, or cancelling, starts when your month ends. If you have more cloud
            computers than the new plan allows, ADE asks which to keep, and pushes the others' work to their branches
            before it frees them.
          </FaqItem>
          <FaqItem question="How many cloud computers can I have?">
            {COMPUTER_LIMITS_LINE}, asleep or not. At the limit, free up a computer from another lane (the lane and its
            chats stay, and it gets a new computer the next time you send a message there), delete a lane, or move to a
            bigger plan.
          </FaqItem>
          <FaqItem question="Can agents outside ADE use ADE Cloud?">
            On {listNames(OUTSIDE_AGENT_PLANS.map((plan) => plan.name))}, yes: an agent connected through ADE MCP can
            start work on ADE Cloud.
            {NO_OUTSIDE_AGENT_PLANS.length > 0 ? ` On ${listNames(NO_OUTSIDE_AGENT_PLANS.map((plan) => plan.name))}, it can't.` : ""}
          </FaqItem>
          <FaqItem question="What happens to computers I don't use?">
            After {days(FREE_PLAN.idleDays)} unused on Free, or {days(PAID_IDLE_DAYS)} on a paid plan, ADE deletes the
            computer. You get an email first. Before it deletes anything, ADE commits the work and pushes it to the
            task's branch. Files git ignores, such as .env or a local database, are never pushed, so they are not kept;
            the email lists them. The task and its chats stay, and your next message makes a new computer from the
            branch.
          </FaqItem>
          <FaqItem question="Does the Free plan show ads?">
            {ADS_FREE_PLAN_SENTENCE} A sponsored card is labeled "Sponsored". An agent may also recommend a sponsored
            tool when you need one; nothing is installed unless you ask. ADE asks you once before the first sponsored
            card, and you can change your answer in Settings › ADE Cloud.
          </FaqItem>
          <FaqItem question="Do I need ADE Cloud to use ADE?">
            No. The ADE app costs nothing and runs your agents on your own computers. ADE Cloud adds computers in the
            cloud when you want agents to keep working with your laptop closed.
          </FaqItem>
        </div>
      </div>
    </section>
  );
}

function FaqItem({ question, children }: { question: string; children: ReactNode }) {
  return (
    <details className="group">
      <summary className="focus-ring flex cursor-pointer list-none items-center justify-between gap-4 rounded-md py-5 text-left text-[16px] font-medium text-white [&::-webkit-details-marker]:hidden">
        {question}
        <ChevronDown className="h-4 w-4 shrink-0 text-white/40 transition-transform duration-200 group-open:rotate-180" />
      </summary>
      <p className="pb-6 pr-8 text-[15px] leading-[1.7] text-white/60">{children}</p>
    </details>
  );
}
