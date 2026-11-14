import { useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { CloudLockup } from "../../components/cloud/CloudMark";
import { ComingSoon } from "../../components/cloud/ComingSoon";
import { PlanButton } from "../../components/cloud/PlanButton";
import { Moon, NightSky, PlanTower } from "../../components/cloud/NightCity";
import { InstallBlock } from "../../components/home/Hero";
import { Page } from "../../components/Page";
import { cn } from "../../lib/cn";
import {
  EXTRA_DISK_USD_PER_10GB_MONTH,
  FINDER_DAYS_A_MONTH,
  FREE_PLAN,
  FREE_RULES,
  INVITE_RULES,
  PAID_IDLE_DAYS,
  PRICING_PLANS,
  PRICING_SIZES,
  centsPerIncludedHour,
  formatCents,
  formatCount,
  formatUsd,
  planDayLine,
  suggestPlan,
  type PricingPlan,
  type PricingSize,
} from "../../lib/cloudPricing";
import {
  MARKETING_CTA_LABELS,
  MARKETING_CTA_POSITIONS,
  MARKETING_FEATURES,
  MARKETING_SCREENS,
  type MarketingCtaLabel,
} from "../../lib/marketingAnalytics";
import { captureMarketingFeature } from "../../lib/marketingAnalyticsBrowser";
import { useDocumentTitle } from "../../lib/useDocumentTitle";

const PLAN_CTAS: Record<PricingPlan["id"], { label: string; cta: MarketingCtaLabel }> = {
  free: { label: "Start free", cta: MARKETING_CTA_LABELS.CHOOSE_PLAN_FREE },
  plus: { label: "Get Plus", cta: MARKETING_CTA_LABELS.CHOOSE_PLAN_PLUS },
  pro: { label: "Get Pro", cta: MARKETING_CTA_LABELS.CHOOSE_PLAN_PRO },
  max: { label: "Get Max", cta: MARKETING_CTA_LABELS.CHOOSE_PLAN_MAX },
};

/** Each plan's tower over its card: more floors and more lights for more hours. */
const PLAN_TOWERS: Record<PricingPlan["id"], { floors: number; lit: number; seed: number }> = {
  free: { floors: 3, lit: 0.25, seed: 3 },
  plus: { floors: 5, lit: 0.35, seed: 8 },
  pro: { floors: 8, lit: 0.45, seed: 13 },
  max: { floors: 11, lit: 0.55, seed: 21 },
};

const PAID_PLANS = PRICING_PLANS.filter((plan) => plan.extraHourCents != null);
const CHEAPEST_PAID = [...PAID_PLANS].sort((a, b) => a.priceUsd - b.priceUsd)[0];
const SMALL = PRICING_SIZES[0];

const days = (count: number): string => `${count} ${count === 1 ? "day" : "days"}`;
const hoursWord = (count: number): string => `${formatCount(count)} ${count === 1 ? "hour" : "hours"}`;

/** "2¢ on Plus, 1.5¢ on Pro and 1.2¢ on Max". */
function extraHourList(): string {
  const parts = PAID_PLANS.map((plan) => `${formatCents(plan.extraHourCents ?? 0)} on ${plan.name}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts.join("");
}

const serifHeading = "font-serif font-normal text-white";
const wrap = "mx-auto max-w-[1180px] px-5 sm:px-8";

/**
 * `/pricing`: ADE Cloud's plans under the night sky of the home page. The
 * plans come first, as four towers of a small skyline; then what is coming,
 * a plan finder for the unsure, the details in tabs, and questions. Plans are
 * bought through ADE's web app: a paid plan's button signs in there and goes
 * to checkout. Free starts in the app.
 * Every number comes from `lib/cloudPricing.ts`, which reads the plan facts
 * the server bills with.
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
        <PlanFinder />
        <DetailsSection />
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
    <section
      aria-labelledby="plans-title"
      id="plans"
      className="relative overflow-hidden"
    >
      <NightSky seed={21} />
      <Moon className="right-[8%] top-[clamp(36px,6vw,80px)] h-[clamp(40px,4.4vw,64px)] w-[clamp(40px,4.4vw,64px)]" />
      <div className={cn(wrap, "relative pb-4 pt-[clamp(36px,4.4vw,64px)]")}>
        <div className="text-center">
          <div className="flex items-center justify-center gap-3">
            <CloudLockup className="text-[16px] text-white" markClassName="h-6" />
          </div>
          <h1
            id="plans-title"
            className={cn(serifHeading, "mt-5")}
            style={{ fontSize: "clamp(44px, 5.6vw, 84px)", lineHeight: 0.98, letterSpacing: "-0.02em" }}
          >
            {formatCount(FREE_PLAN.hours)} hours free.
            {CHEAPEST_PAID ? (
              <>
                <br />
                <em className="italic text-[color:var(--color-lamp)]">
                  {formatCount(CHEAPEST_PAID.hours)} for ${CHEAPEST_PAID.priceUsd}.
                </em>
              </>
            ) : null}
          </h1>
          <p className="mx-auto mt-5 max-w-[36rem] text-[clamp(16px,1.3vw,19px)] leading-[1.6] text-white/65">
            Every task gets its own computer in the cloud. An hour is one hour of a {SMALL?.label ?? "Small"} computer at work; asleep, it
            uses none.
          </p>
        </div>

        <div className="mt-[136px] grid gap-x-4 gap-y-[150px] sm:grid-cols-2 lg:grid-cols-4">
          {PRICING_PLANS.map((plan) => (
            <PlanCard key={plan.id} plan={plan} />
          ))}
        </div>

        <p className="mt-6 text-center text-[14px] text-white/45">Prices are monthly, in US dollars.</p>
        <ComingSoon compact className="mt-8" />
      </div>
    </section>
  );
}

function PlanCard({ plan }: { plan: PricingPlan }) {
  const tower = PLAN_TOWERS[plan.id];
  const perHour = centsPerIncludedHour(plan);
  const free = plan.priceUsd === 0;
  const cheapest = plan.id === CHEAPEST_PAID?.id;
  const lit = free || cheapest;
  return (
    <div
      className={cn(
        "relative flex flex-col rounded-[26px] border p-6",
        free
          ? "border-[color:var(--color-lamp)]/45 bg-[linear-gradient(180deg,rgba(255,210,122,0.14),rgba(21,17,47,0.92)_45%)] shadow-[0_30px_80px_-30px_rgba(255,210,122,0.45)]"
          : cheapest
            ? "border-[color:var(--color-violet-bright)]/45 bg-[linear-gradient(180deg,rgba(167,139,250,0.18),rgba(21,17,47,0.92)_45%)] shadow-[0_30px_80px_-30px_rgba(139,92,246,0.6)]"
            : "border-white/[0.09] bg-[#15112f]/90",
      )}
    >
      <PlanTower
        floors={tower.floors}
        litShare={tower.lit}
        seed={tower.seed}
        className="absolute bottom-full right-7 opacity-95"
      />
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[16px] font-semibold text-white">{plan.name}</h2>
        {free ? (
          <Badge tone="lamp">No credit card</Badge>
        ) : perHour ? (
          <Badge tone={cheapest ? "violet" : "quiet"}>{perHour} an hour</Badge>
        ) : null}
      </div>
      <p className="mt-4 flex items-baseline gap-1.5">
        <span
          className={cn("font-serif leading-none", lit ? "text-[color:var(--color-lamp)]" : "text-white")}
          style={{ fontSize: "clamp(56px, 5vw, 68px)" }}
        >
          ${plan.priceUsd}
        </span>
        <span className="text-[14px] text-white/45">a month</span>
      </p>
      <p className="mt-5 text-[24px] font-semibold leading-none tracking-tight text-white">
        {formatCount(plan.hours)}
        <span className="ml-1.5 text-[15px] font-normal text-white/60">hours</span>
      </p>
      <p className="mt-1.5 text-[13.5px] text-white/50">About {planDayLine(plan)}</p>
      <ul className="mt-5 flex flex-1 flex-col gap-2.5 border-t border-dashed border-white/[0.12] pt-5 text-[14px] text-white/60">
        <li>
          <span className="text-white">{plan.diskGb} GB</span> of disk
        </li>
        <li>
          {plan.extraHourCents == null ? (
            <>Pauses when the hours run out</>
          ) : (
            <>
              More hours at <span className="text-white">{formatCents(plan.extraHourCents)}</span>, if you turn it on
            </>
          )}
        </li>
        <li>
          Unused computers kept <span className="text-white">{days(plan.idleDays)}</span>
        </li>
        <li>No limit on computers</li>
      </ul>
      <PlanButton
        cta={PLAN_CTAS[plan.id].cta}
        position={MARKETING_CTA_POSITIONS.PRICING_PAGE}
        plan={plan.id}
        tone={free ? "lamp" : cheapest ? "violet" : "quiet"}
        className="mt-7 w-full"
      >
        {PLAN_CTAS[plan.id].label}
      </PlanButton>
    </div>
  );
}

function Badge({ tone, children }: { tone: "lamp" | "violet" | "quiet"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "whitespace-nowrap rounded-full px-2.5 py-0.5 text-[12px] font-semibold",
        tone === "lamp" && "bg-[color:var(--color-lamp)] text-[#1a1430]",
        tone === "violet" && "bg-[color:var(--color-violet-bright)] text-[#160f33]",
        tone === "quiet" && "border border-white/15 font-medium text-white/60",
      )}
    >
      {children}
    </span>
  );
}

const MAX_COMPUTERS = 20;
const MAX_HOURS_A_DAY = 24;

/**
 * "Not sure which plan?": computers, hours a day and size make a month of
 * hours, and the plan that runs it. Only the first change is reported, never
 * the numbers.
 */
function PlanFinder() {
  const [computers, setComputers] = useState(2);
  const [hoursADay, setHoursADay] = useState(4);
  const [sizeId, setSizeId] = useState<PricingSize["id"]>(SMALL?.id ?? "small");
  const reported = useRef(false);

  const size = PRICING_SIZES.find((entry) => entry.id === sizeId) ?? SMALL;
  const hours = Math.round(computers * hoursADay * FINDER_DAYS_A_MONTH * (size?.rate ?? 1));
  const suggestion = suggestPlan(hours);
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
    <section aria-labelledby="finder-title" className={cn(wrap, "pt-[clamp(64px,7vw,96px)]")}>
      <SectionTitle id="finder-title" title="Not sure which plan?">
        Tell us how your agents work.
      </SectionTitle>

      <div className="mt-8 grid gap-8 rounded-[28px] border border-white/[0.08] bg-white/[0.025] p-6 sm:p-9 lg:grid-cols-[1.1fr_1fr] lg:gap-12">
        <div className="flex flex-col gap-8">
          <Slider
            id="finder-computers"
            label="Computers working at once"
            value={computers}
            min={1}
            max={MAX_COMPUTERS}
            display={String(computers)}
            onChange={(value) => change(() => setComputers(value))}
          />
          <Slider
            id="finder-hours"
            label="Hours a day, each"
            value={hoursADay}
            min={1}
            max={MAX_HOURS_A_DAY}
            display={`${hoursADay} h`}
            onChange={(value) => change(() => setHoursADay(value))}
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
                    <span className="block text-[12px] text-white/45">{entry.use}</span>
                  </button>
                );
              })}
            </div>
          </fieldset>
        </div>

        <div className="flex flex-col justify-between rounded-[22px] bg-[#13112a] p-6 sm:p-8" aria-live="polite">
          <div>
            <p className="text-[14px] text-white/55">
              About <span className="font-semibold text-white">{formatCount(hours)} hours</span> a month
            </p>
            {best ? (
              <>
                <p className={cn(serifHeading, "mt-3")} style={{ fontSize: "clamp(40px, 4.4vw, 60px)", lineHeight: 1 }}>
                  {best.plan.name}{" "}
                  <span className="text-[color:var(--color-lamp)]">{formatUsd(best.costUsd)}</span>
                  <span className="ml-2 font-sans text-[15px] text-white/45">a month</span>
                </p>
                <p className="mt-4 text-[15px] leading-[1.6] text-white/65">
                  {best.extraHours > 0
                    ? `${best.plan.name} includes ${hoursWord(best.plan.hours)}. The other ${hoursWord(best.extraHours)} cost ${formatCents(best.plan.extraHourCents ?? 0)} each, with extra hours turned on.`
                    : best.plan.priceUsd === 0
                      ? `That fits in the free ${hoursWord(best.plan.hours)}.`
                      : `${best.plan.name} includes ${hoursWord(best.plan.hours)}, so ${hoursWord(best.spareHours)} are left over.`}
                </p>
                {other ? (
                  <p className="mt-2 text-[14px] leading-[1.6] text-white/45">
                    {other.extraHours > 0
                      ? `${other.plan.name} with extra hours would be about ${formatUsd(other.costUsd)}.`
                      : `Or ${other.plan.name} at ${formatUsd(other.costUsd)}, with no extra hours.`}
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
  display,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  display: string;
  onChange: (value: number) => void;
}) {
  const fill = `${((value - min) / (max - min)) * 100}%`;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="text-[15px] font-medium text-white/85">
          {label}
        </label>
        <span className="font-serif text-[30px] leading-none text-white tabular-nums">{display}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={1}
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
      {children ? <p className="mt-3 max-w-[38rem] text-[16px] leading-[1.6] text-white/55">{children}</p> : null}
    </>
  );
}

const DETAIL_TABS = [
  { id: "sizes", label: "Sizes" },
  { id: "more", label: "More hours and disk" },
  { id: "unused", label: "Unused computers" },
  { id: "free", label: "The free plan" },
] as const;

type DetailTab = (typeof DETAIL_TABS)[number]["id"];

/** The rules most people never need, one tab at a time. */
function DetailsSection() {
  const [tab, setTab] = useState<DetailTab>("sizes");
  const baseId = useId();
  return (
    <section aria-labelledby="details-title" className={cn(wrap, "pt-[clamp(64px,7vw,96px)]")}>
      <SectionTitle id="details-title" title="The details" />
      <div role="tablist" aria-label="Plan details" className="mt-6 flex gap-2 overflow-x-auto pb-1">
        {DETAIL_TABS.map((entry) => {
          const active = entry.id === tab;
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`${baseId}-${entry.id}-tab`}
              aria-selected={active}
              aria-controls={`${baseId}-${entry.id}-panel`}
              onClick={() => setTab(entry.id)}
              className={cn(
                "focus-ring shrink-0 rounded-full px-4 py-2 text-[14px] font-medium transition-colors",
                active ? "bg-white text-[#0d0b24]" : "border border-white/[0.12] text-white/65 hover:text-white",
              )}
            >
              {entry.label}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-${tab}-panel`}
        aria-labelledby={`${baseId}-${tab}-tab`}
        className="mt-6 min-h-[260px]"
      >
        {tab === "sizes" ? <SizesPanel /> : tab === "more" ? <ExtrasPanel /> : tab === "unused" ? <CleanupPanel /> : <FreePanel />}
      </div>
    </section>
  );
}

function SizesPanel() {
  return (
    <>
      <p className="max-w-[40rem] text-[15px] leading-[1.6] text-white/55">
        {SMALL
          ? `An hour on ${SMALL.label} is one hour of your plan. Bigger sizes use hours faster. Change a computer's size any time.`
          : "Bigger sizes use hours faster."}
      </p>
      <div className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-[24px] border border-white/[0.08] bg-white/[0.08] lg:grid-cols-4">
        {PRICING_SIZES.map((size) => (
          <div key={size.id} className="flex flex-col bg-[color:var(--color-bg)] p-5 sm:p-6">
            <div className="flex items-baseline justify-between">
              <h3 className="text-[16px] font-semibold text-white">{size.label}</h3>
              <span className="font-serif text-[34px] leading-none text-[color:var(--color-lamp)]">{size.rate}×</span>
            </div>
            <p className="mt-3 text-[14px] leading-snug text-white/70">{size.use}</p>
            <p className="mt-auto pt-5 text-[13px] leading-relaxed text-white/40">
              {size.cpu} CPUs, {size.memoryGb} GB memory
              <br />
              Disk grows to {size.diskMaxGb} GB
            </p>
          </div>
        ))}
      </div>
    </>
  );
}

function ExtrasPanel() {
  return (
    <>
      <p className="max-w-[40rem] text-[15px] leading-[1.6] text-white/55">
        Paid plans can go past their hours and disk. Both are off until you turn them on in Settings › ADE Cloud.
      </p>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <div className="rounded-[24px] border border-white/[0.08] bg-white/[0.02] p-6 sm:p-8">
          <h3 className="text-[17px] font-semibold text-white">Extra hours</h3>
          <dl className="mt-5 divide-y divide-white/[0.07]">
            {PAID_PLANS.map((plan) => (
              <div key={plan.id} className="flex items-baseline justify-between py-3">
                <dt className="text-[15px] text-white/70">{plan.name}</dt>
                <dd className="text-[15px] text-white/55">
                  <span className="font-serif text-[26px] text-white">{formatCents(plan.extraHourCents ?? 0)}</span> an hour
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-[14px] text-white/45">On Free, work pauses until next month instead.</p>
        </div>
        <div className="rounded-[24px] border border-white/[0.08] bg-white/[0.02] p-6 sm:p-8">
          <h3 className="text-[17px] font-semibold text-white">Extra disk</h3>
          <p className="mt-5 flex items-baseline gap-2">
            <span className="font-serif text-[60px] leading-none text-white">${EXTRA_DISK_USD_PER_10GB_MONTH}</span>
            <span className="text-[15px] text-white/55">for each 10 GB, a month</span>
          </p>
          <ul className="mt-6 flex flex-col gap-2 text-[14px] leading-relaxed text-white/60">
            <li>Counted by the day, so you pay only for the days you keep it.</li>
            <li>You set the most it can cost each month.</li>
            <li>All your computers share it.</li>
          </ul>
        </div>
      </div>
    </>
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
    <>
      <p className="max-w-[40rem] text-[15px] leading-[1.6] text-white/55">
        ADE deletes computers nobody uses, to free their disk. This is what happens first.
      </p>
      <ol className="mt-6 grid gap-8 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6">
        {steps.map((step, index) => (
          <li key={step.title} className="border-t border-white/[0.12] pt-5">
            <span className="font-serif text-[34px] leading-none text-[color:var(--color-lamp)]">{index + 1}</span>
            <h3 className="mt-4 text-[16px] font-semibold text-white">{step.title}</h3>
            <p className="mt-2 text-[14px] leading-relaxed text-white/55">{step.body}</p>
          </li>
        ))}
      </ol>
    </>
  );
}

function FreePanel() {
  return (
    <div className="grid gap-8 rounded-[28px] border border-white/[0.08] bg-[radial-gradient(120%_120%_at_0%_0%,rgba(255,210,122,0.08),transparent_55%)] p-7 sm:p-10 md:grid-cols-[1fr_1.1fr] md:gap-12">
      <p className="font-serif text-[clamp(26px,2.8vw,36px)] leading-[1.15] text-white">
        {formatCount(FREE_PLAN.hours)} hours and {FREE_PLAN.diskGb} GB every month. You never pay to start.
      </p>
      <ul className="flex flex-col gap-4 self-center text-[15px] leading-relaxed text-white/80">
        <li>A GitHub account that is at least {days(FREE_RULES.githubMinAgeDays)} old.</li>
        <li>Newer account? Add a card to start now. It is not charged.</li>
        <li>One free plan for each GitHub account.</li>
        <li>
          Invite a friend, and you both get {formatCount(INVITE_RULES.rewardHours)} extra hours that never expire, for up
          to {INVITE_RULES.rewardLimit} friends.
        </li>
      </ul>
    </div>
  );
}

function FaqSection() {
  return (
    <section aria-labelledby="faq-title" className={cn(wrap, "pb-10 pt-[clamp(64px,7vw,96px)]")}>
      <div className="mx-auto max-w-[820px]">
        <SectionTitle id="faq-title" title="Questions" />
        <div className="mt-6 divide-y divide-white/[0.08] border-y border-white/[0.08]">
          <FaqItem question="How do I pick a plan?">
            Press its button: ADE's web app signs you in and takes you to checkout. Or pick one in the ADE app, in
            Settings under ADE Cloud. Free needs no credit card.
          </FaqItem>
          <FaqItem question="What is an hour?">
            One hour of a {SMALL?.label ?? "Small"} computer while it is awake. Bigger sizes count more:{" "}
            {PRICING_SIZES.slice(1)
              .map((size) => `${size.label} uses ${size.rate}×`)
              .join(", ")}
            . A computer that is asleep uses no hours, and your hours start over each month.
          </FaqItem>
          <FaqItem question="What happens when my hours run out?">
            On Free, your computers stop until next month, or until you pick a paid plan. On a paid plan, turn on extra
            hours in Settings and your agents keep working: each extra hour costs {extraHourList()}. With extra hours
            off, work stops at your plan's hours.
          </FaqItem>
          <FaqItem question="Can I change plans or cancel?">
            Yes, any time in Settings › ADE Cloud. A bigger plan starts right away, and you pay the difference for the
            rest of the month. A smaller plan, or cancelling, starts when your month ends. If your computers use more
            disk than the new plan has, ADE asks which to keep, and pushes the others' work to their branches before it
            frees them.
          </FaqItem>
          <FaqItem question="Is there a limit on computers?">
            No. Give every task its own computer. They all share your plan's hours and disk, so you never pay per
            computer.
          </FaqItem>
          <FaqItem question="What happens to computers I don't use?">
            After {days(FREE_PLAN.idleDays)} unused on Free, or {days(PAID_IDLE_DAYS)} on a paid plan, ADE deletes the
            computer. You get an email first. Before it deletes anything, ADE commits the work and pushes it to the
            task's branch. Files git ignores, such as .env or a local database, are never pushed, so they are not kept;
            the email lists them. The task and its chats stay, and your next message makes a new computer from the
            branch.
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
