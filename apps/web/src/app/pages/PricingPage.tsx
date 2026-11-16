import { useRef, useState, type ComponentType, type ReactNode } from "react";
import { Check, ChevronDown, Clock, Cpu, Gift, HardDrive, MemoryStick, Recycle, Server, Timer, Zap } from "lucide-react";

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

const serifHeading = "font-display text-white";
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
            style={{ fontSize: "clamp(44px, 5.6vw, 84px)", lineHeight: 0.98, letterSpacing: "-0.04em" }}
          >
            {formatCount(FREE_PLAN.hours)} hours free, every month.
            <br />
            <span className="text-white/45">More costs pennies.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-[44rem] text-[clamp(16px,1.3vw,19px)] leading-[1.6] text-white/65">
            {CHEAPEST_PAID ? `${formatCount(CHEAPEST_PAID.hours)} hours for $${CHEAPEST_PAID.priceUsd}. ` : ""}A computer that is asleep uses none.
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
        <h2 className="text-[18px] font-semibold text-white">{plan.name}</h2>
        {free ? (
          <Badge tone="lamp">No credit card</Badge>
        ) : perHour ? (
          <Badge tone={cheapest ? "violet" : "quiet"}>{perHour} an hour</Badge>
        ) : null}
      </div>
      <p className="mt-4 flex items-baseline gap-1.5">
        <span
          className={cn("font-display leading-none", lit ? "text-[color:var(--color-lamp)]" : "text-white")}
          style={{ fontSize: "clamp(56px, 5vw, 68px)" }}
        >
          ${plan.priceUsd}
        </span>
        <span className="text-[14px] text-white/45">a month</span>
      </p>
      <div className="mt-5 rounded-2xl border border-white/[0.08] bg-black/25 px-4 py-3.5">
        <p className="flex items-baseline gap-1.5">
          <span className="text-[30px] font-semibold leading-none tracking-tight text-white">{formatCount(plan.hours)}</span>
          <span className="text-[15px] text-white/60">hours</span>
        </p>
        <p className="mt-1 text-[13px] text-white/50">About {planDayLine(plan)}</p>
      </div>
      <ul className="mt-5 flex flex-1 flex-col gap-3 text-[14px]">
        <PlanLine icon={HardDrive} label="Disk" value={`${plan.diskGb} GB`} />
        <PlanLine icon={Zap} label="Past your hours" value={plan.extraHourCents == null ? "Pauses" : `${formatCents(plan.extraHourCents)} / hour`} />
        <PlanLine icon={Timer} label="Unused kept" value={days(plan.idleDays)} />
        <PlanLine icon={Server} label="Computers" value="No limit" />
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

function PlanLine({ icon: Icon, label, value }: { icon: ComponentType<{ className?: string }>; label: string; value: string }) {
  return (
    <li className="flex items-center gap-3">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-white/[0.06] ring-1 ring-white/[0.08]">
        <Icon className="h-4 w-4 text-white/70" />
      </span>
      <span className="flex-1 whitespace-nowrap text-white/55">{label}</span>
      <span className="whitespace-nowrap font-semibold text-white">{value}</span>
    </li>
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
/** Every hour of the month, round-the-clock. */
const MAX_HOURS_A_MONTH = 24 * FINDER_DAYS_A_MONTH;
const HOURS_STEP = 10;

/**
 * "Not sure which plan?": computers, hours a month each and size make a month
 * of hours, and the plan that runs it. Only the first change is reported, never
 * the numbers.
 */
function PlanFinder() {
  const [computers, setComputers] = useState(2);
  const [hoursEach, setHoursEach] = useState(120);
  const [sizeId, setSizeId] = useState<PricingSize["id"]>(SMALL?.id ?? "small");
  const reported = useRef(false);

  const size = PRICING_SIZES.find((entry) => entry.id === sizeId) ?? SMALL;
  const hours = Math.round(computers * hoursEach * (size?.rate ?? 1));
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
            label="Hours a month, each machine"
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
                  <span className="ml-2 font-sans text-[15px] tracking-normal text-white/45">a month</span>
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
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="text-[15px] font-medium text-white/85">
          {label}
        </label>
        <span className="font-display text-[30px] leading-none text-white tabular-nums">{display}</span>
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
      {children ? <p className="mt-3 max-w-[38rem] text-[16px] leading-[1.6] text-white/55">{children}</p> : null}
    </>
  );
}

type Accent = { color: string; glow: string };
const AMBER: Accent = { color: "#ffd27a", glow: "rgba(255,210,122,0.14)" };
const SKY: Accent = { color: "#7dd3fc", glow: "rgba(56,189,248,0.14)" };
const MINT: Accent = { color: "#6ee7b7", glow: "rgba(52,211,153,0.13)" };
const VIOLET: Accent = { color: "#c4b5fd", glow: "rgba(167,139,250,0.15)" };

/** The rules most people never need, all on one page: sizes, then extras and the free plan, then what happens to unused computers. */
function DetailsSection() {
  return (
    <section aria-labelledby="details-title" className={cn(wrap, "pt-[clamp(64px,7vw,96px)]")}>
      <SectionTitle id="details-title" title="The details">
        Sizes, extras, the free plan and what happens to computers nobody uses.
      </SectionTitle>
      <div className="mt-8 flex flex-col gap-4">
        <SizesPanel />
        <div className="grid gap-4 lg:grid-cols-3">
          <ExtraHoursCard />
          <ExtraDiskCard />
          <FreePlanCard />
        </div>
        <CleanupPanel />
      </div>
    </section>
  );
}

/** A details card: an accent-coloured icon and title, and a soft glow of the same colour. */
function DetailCard({ accent, icon: Icon, title, note, children, className }: { accent: Accent; icon: ComponentType<{ className?: string }>; title: string; note?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded-[24px] border border-white/[0.08] bg-[#100e22] p-6 sm:p-7", className)}>
      <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: `radial-gradient(90% 70% at 100% 0%, ${accent.glow}, transparent 65%)` }} />
      <div className="relative">
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-[11px] border border-white/10 bg-white/[0.04]" style={{ color: accent.color }}>
            <Icon className="h-[18px] w-[18px]" />
          </span>
          <div>
            <h3 className="text-[17px] font-semibold text-white">{title}</h3>
            {note ? <p className="text-[13.5px] text-white/50">{note}</p> : null}
          </div>
        </div>
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}

const MAX_RATE = Math.max(...PRICING_SIZES.map((size) => size.rate));

/** Each size as a card: how fast it uses hours, drawn as a bar, and its machine as three chips. */
function SizesPanel() {
  return (
    <DetailCard
      accent={AMBER}
      icon={Cpu}
      title="Sizes"
      note={SMALL ? `One hour on ${SMALL.label} is one hour of your plan. Bigger sizes count more.` : "Bigger sizes count more."}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {PRICING_SIZES.map((size, index) => (
          <div
            key={size.id}
            className="relative flex flex-col overflow-hidden rounded-[24px] border border-white/[0.09] bg-[linear-gradient(180deg,#1a1538,#100d24)] p-5 sm:p-6"
          >
            <div
              className="pointer-events-none absolute inset-0"
              style={{ background: `radial-gradient(100% 70% at 100% 0%, rgba(255,210,122,${0.06 + index * 0.05}), transparent 60%)` }}
            />
            <div className="relative flex items-baseline justify-between">
              <h3 className="text-[18px] font-semibold text-white">{size.label}</h3>
              <span className="font-display text-[44px] leading-none text-[color:var(--color-lamp)]">{size.rate}×</span>
            </div>
            <p className="relative mt-1 truncate text-[14px] text-white/65">{size.use}</p>
            <div className="relative mt-5 flex gap-1" aria-label={`Uses ${size.rate} hours of your plan each hour`}>
              {Array.from({ length: MAX_RATE }, (_, i) => (
                <span
                  key={i}
                  className={cn("h-2 flex-1 rounded-full", i < size.rate ? "bg-[color:var(--color-lamp)] shadow-[0_0_10px_rgba(255,210,122,0.5)]" : "bg-white/[0.08]")}
                />
              ))}
            </div>
            <div className="relative mt-5 flex gap-1 text-[12.5px] text-white/75">
              <SpecChip icon={Cpu} title="CPUs">{size.cpu} CPU</SpecChip>
              <SpecChip icon={MemoryStick} title="Memory">{size.memoryGb} GB</SpecChip>
              <SpecChip icon={HardDrive} title="Disk, at most">{size.diskMaxGb} GB</SpecChip>
            </div>
          </div>
        ))}
      </div>
    </DetailCard>
  );
}

function SpecChip({ icon: Icon, title, children }: { icon: ComponentType<{ className?: string }>; title: string; children: ReactNode }) {
  return (
    <span title={title} className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-white/10 bg-white/[0.05] px-2 py-1">
      <Icon className="h-3.5 w-3.5 text-white/55" />
      {children}
    </span>
  );
}

function ExtraHoursCard() {
  const most = Math.max(...PAID_PLANS.map((plan) => plan.extraHourCents ?? 0));
  return (
    <DetailCard accent={AMBER} icon={Clock} title="Extra hours" note="Paid plans can go past their hours, if you turn it on.">
      <ul className="flex flex-col gap-4">
        {PAID_PLANS.map((plan) => (
          <li key={plan.id}>
            <div className="flex items-baseline justify-between">
              <span className="text-[15px] text-white/75">{plan.name}</span>
              <span className="text-[14px] text-white/50">
                <span className="font-display text-[24px] text-white">{formatCents(plan.extraHourCents ?? 0)}</span> an hour
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
              <div className="h-full rounded-full" style={{ width: `${((plan.extraHourCents ?? 0) / most) * 100}%`, background: AMBER.color }} />
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-5 text-[13.5px] text-white/45">On Free, work pauses until next month instead.</p>
    </DetailCard>
  );
}

function ExtraDiskCard() {
  return (
    <DetailCard accent={SKY} icon={HardDrive} title="Extra disk" note="Shared by all your computers.">
      <p className="flex items-baseline gap-2">
        <span className="font-display text-[56px] leading-none" style={{ color: SKY.color }}>
          ${EXTRA_DISK_USD_PER_10GB_MONTH}
        </span>
        <span className="text-[15px] text-white/55">for each 10 GB, a month</span>
      </p>
      <ul className="mt-6 flex flex-col gap-3 text-[14px] leading-relaxed text-white/70">
        {["Counted by the day: pay only for the days you keep it", "You set the most it can cost each month", "Turn it on in ADE Cloud settings"].map((line) => (
          <li key={line} className="flex items-start gap-2.5">
            <Check className="mt-0.5 h-4 w-4 shrink-0" style={{ color: SKY.color }} />
            {line}
          </li>
        ))}
      </ul>
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

function FreePlanCard() {
  const rules = [
    `A GitHub account at least ${days(FREE_RULES.githubMinAgeDays)} old`,
    "Newer account? Add a card to start now. It is not charged.",
    "One free plan for each GitHub account",
    `Invite a friend: you both get ${formatCount(INVITE_RULES.rewardHours)} extra hours that never expire, for up to ${INVITE_RULES.rewardLimit} friends`,
  ];
  return (
    <DetailCard accent={MINT} icon={Gift} title="The free plan" note="You never pay to start.">
      <p className="font-display text-[34px] leading-[1.05]" style={{ color: MINT.color }}>
        {formatCount(FREE_PLAN.hours)} h <span className="text-white/35">·</span> {FREE_PLAN.diskGb} GB
      </p>
      <p className="text-[14px] text-white/50">every month</p>
      <ul className="mt-5 flex flex-col gap-3 text-[14px] leading-relaxed text-white/70">
        {rules.map((rule) => (
          <li key={rule} className="flex items-start gap-2.5">
            <Check className="mt-0.5 h-4 w-4 shrink-0" style={{ color: MINT.color }} />
            {rule}
          </li>
        ))}
      </ul>
    </DetailCard>
  );
}

function FaqSection() {
  return (
    <section aria-labelledby="faq-title" className={cn(wrap, "pb-10 pt-[clamp(64px,7vw,96px)]")}>
      <div className="max-w-[880px]">
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
