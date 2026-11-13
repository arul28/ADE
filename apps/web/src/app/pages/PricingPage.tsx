import type { ReactNode } from "react";
import { Check, ChevronDown, Cloud, Cpu, HardDrive, Infinity as InfinityIcon, Moon, ShieldCheck, Smartphone, Timer } from "lucide-react";

import { Badge } from "../../components/Badge";
import { Card } from "../../components/Card";
import { InstallBlock } from "../../components/home/Hero";
import { guessPlatform } from "../../components/home/SiteNav";
import { useInstallDialog } from "../../components/install/InstallDialogProvider";
import { Page } from "../../components/Page";
import { Reveal } from "../../components/Reveal";
import { Section } from "../../components/Section";
import { SectionHeading } from "../../components/SectionHeading";
import { buttonClassName } from "../../components/Button";
import { cn } from "../../lib/cn";
import {
  EXTRA_DISK_USD_PER_10GB_MONTH,
  FREE_PLAN,
  FREE_RULES,
  HIGHLIGHTED_PLAN,
  INVITE_RULES,
  PRICING_PLANS,
  PRICING_SIZES,
  formatCents,
  formatCount,
  type PricingPlan,
  type PricingSize,
} from "../../lib/cloudPricing";
import {
  MARKETING_CTA_LABELS,
  MARKETING_CTA_POSITIONS,
  type MarketingCtaLabel,
} from "../../lib/marketingAnalytics";
import { useDocumentTitle } from "../../lib/useDocumentTitle";

const PLAN_CTAS: Record<PricingPlan["id"], { label: string; cta: MarketingCtaLabel }> = {
  free: { label: "Start free", cta: MARKETING_CTA_LABELS.CHOOSE_PLAN_FREE },
  plus: { label: "Get Plus", cta: MARKETING_CTA_LABELS.CHOOSE_PLAN_PLUS },
  pro: { label: "Get Pro", cta: MARKETING_CTA_LABELS.CHOOSE_PLAN_PRO },
  max: { label: "Get Max", cta: MARKETING_CTA_LABELS.CHOOSE_PLAN_MAX },
};

const PAID_PLANS = PRICING_PLANS.filter((plan) => plan.extraHourCents != null);
const PAID_IDLE_DAYS = PAID_PLANS[0]?.idleDays ?? FREE_PLAN.idleDays;
const SMALL = PRICING_SIZES[0];
const LARGE = PRICING_SIZES.find((size) => size.id === "large");

const days = (count: number): string => `${count} ${count === 1 ? "day" : "days"}`;
const sizeRate = (size: PricingSize): string => `${size.rate}×`;

/** "2¢ on Plus, 1.5¢ on Pro and 1.2¢ on Max". */
function extraHourList(): string {
  const parts = PAID_PLANS.map((plan) => `${formatCents(plan.extraHourCents ?? 0)} on ${plan.name}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts.join("");
}

/**
 * `/pricing`: ADE Cloud's plans, sizes and rules. Every number comes from
 * `lib/cloudPricing.ts`, which reads the account directory's own plan facts.
 */
export function PricingPage() {
  useDocumentTitle("Pricing — ADE Cloud");

  return (
    <Page>
      <Section className="pb-10 pt-20 sm:pb-12 sm:pt-24">
        <div className="mx-auto max-w-2xl text-center">
          <Reveal>
            <Badge className="bg-card/50">
              <Cloud className="h-4 w-4" />
              ADE Cloud
            </Badge>
          </Reveal>
          <Reveal delay={0.05}>
            <h1 className="mt-5 text-balance text-4xl font-semibold leading-[1.08] tracking-tight text-fg sm:text-5xl">
              A computer in the cloud for every lane.
            </h1>
          </Reveal>
          <Reveal delay={0.1}>
            <p className="mt-5 text-pretty text-base leading-relaxed text-muted-fg sm:text-lg">
              Your agents keep working when your laptop is closed. Start with {formatCount(FREE_PLAN.hours)} free
              hours a month, and pay only for what you use past your plan.
            </p>
          </Reveal>
          <Reveal delay={0.14}>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
              <Badge variant="outline">
                <InfinityIcon className="h-3.5 w-3.5" /> As many computers as you like
              </Badge>
              <Badge variant="outline">
                <Moon className="h-3.5 w-3.5" /> Asleep, a computer uses no hours
              </Badge>
              <Badge variant="outline">
                <Check className="h-3.5 w-3.5" /> Cancel any time
              </Badge>
            </div>
          </Reveal>
        </div>
      </Section>

      <Section className="py-6 sm:py-8" aria-label="Plans">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PRICING_PLANS.map((plan, index) => (
            <Reveal key={plan.id} delay={0.04 * index} className="h-full">
              <PlanCard plan={plan} highlighted={plan.id === HIGHLIGHTED_PLAN} />
            </Reveal>
          ))}
        </div>
        <Reveal>
          <p className="mt-6 text-center text-sm text-muted-fg">
            Get ADE, then pick your plan in Settings › ADE Cloud. Prices are in US dollars.
          </p>
        </Reveal>
      </Section>

      <Section className="py-14 sm:py-16">
        <div className="grid gap-4 md:grid-cols-3">
          <Reveal className="h-full">
            <FactCard icon={<InfinityIcon className="h-5 w-5" />} title="As many computers as you like">
              Give every lane its own computer. They share your plan's hours and disk, so you never pay per
              computer.
            </FactCard>
          </Reveal>
          <Reveal delay={0.05} className="h-full">
            <FactCard icon={<HardDrive className="h-5 w-5" />} title="Extra disk">
              Need more room than your plan has? It's ${EXTRA_DISK_USD_PER_10GB_MONTH} for each extra 10 GB a
              month, counted by the day, on paid plans. You set the most it can cost.
            </FactCard>
          </Reveal>
          <Reveal delay={0.1} className="h-full">
            <FactCard icon={<Timer className="h-5 w-5" />} title="Unused computers">
              A computer nobody uses for {days(FREE_PLAN.idleDays)} on Free, or {days(PAID_IDLE_DAYS)} on a paid
              plan, is cleaned up. ADE pushes its work to the lane's branch first, and emails you before.
            </FactCard>
          </Reveal>
        </div>
      </Section>

      <Section id="sizes" className="py-14 sm:py-16">
        <Reveal>
          <SectionHeading
            eyebrow="Sizes"
            title="Pick a size for each computer."
            description={
              SMALL
                ? `An hour on ${SMALL.label} is one hour of your plan. Bigger sizes use your hours faster.`
                : "Bigger sizes use your hours faster."
            }
          />
        </Reveal>
        <div className="mt-8 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {PRICING_SIZES.map((size, index) => (
            <Reveal key={size.id} delay={0.04 * index} className="h-full">
              <SizeCard size={size} />
            </Reveal>
          ))}
        </div>
        {LARGE ? (
          <Reveal>
            <p className="mt-5 text-sm text-muted-fg">
              For example, a {LARGE.label} computer awake for 2 hours uses {formatCount(LARGE.rate * 2)} of your hours.
            </p>
          </Reveal>
        ) : null}
      </Section>

      <Section id="free-plan" className="py-14 sm:py-16">
        <Reveal>
          <Card tone="solid" className="grid gap-8 p-6 sm:p-8 md:grid-cols-[1fr_1.1fr] md:gap-10">
            <div>
              <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border/70 bg-card text-fg">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <h2 className="mt-5 text-balance text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
                Who can use the free plan
              </h2>
              <p className="mt-3 text-pretty text-sm leading-relaxed text-muted-fg sm:text-base">
                These keep free hours for real people. You never have to pay to start.
              </p>
            </div>
            <ul className="flex flex-col gap-3 self-center">
              <Rule>A GitHub account that's at least {days(FREE_RULES.githubMinAgeDays)} old.</Rule>
              <Rule>Or add a card instead. It isn't charged.</Rule>
              <Rule>One free plan for each GitHub account.</Rule>
              <Rule>
                Invite a friend and you both get {formatCount(INVITE_RULES.rewardHours)} extra hours, for up to{" "}
                {INVITE_RULES.rewardLimit} friends.
              </Rule>
            </ul>
          </Card>
        </Reveal>
      </Section>

      <Section id="faq" className="py-14 sm:py-16">
        <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:gap-12">
          <Reveal>
            <SectionHeading eyebrow="Questions" title="How it works" size="md" />
          </Reveal>
          <div className="flex flex-col gap-3">
            <Reveal>
              <FaqItem question="What is an hour?">
                One hour of a {SMALL?.label ?? "Small"} computer while it's awake. Bigger sizes count more:
                {" "}
                {PRICING_SIZES.slice(1).map((size) => `${size.label} uses ${sizeRate(size)}`).join(", ")}. A computer
                that's asleep uses no hours, and your hours start over each month.
              </FaqItem>
            </Reveal>
            <Reveal delay={0.04}>
              <FaqItem question="What happens when my hours run out?">
                On Free, your computers stop until next month, or until you pick a paid plan. On a paid plan, your
                agents keep working and each extra hour costs {extraHourList()}. You can turn extra hours off in
                Settings to stop at your plan's hours instead.
              </FaqItem>
            </Reveal>
            <Reveal delay={0.08}>
              <FaqItem question="Can I change plans or cancel?">
                Yes, any time in Settings › ADE Cloud. A bigger plan starts right away, and you pay the difference
                for the rest of the month. A smaller plan, or cancelling, starts with your next month. If your
                computers use more disk than the new plan has, ADE asks which to keep, and pushes the others' work
                to their branches before it frees them.
              </FaqItem>
            </Reveal>
            <Reveal delay={0.12}>
              <FaqItem question="What happens to computers I don't use?">
                After {days(FREE_PLAN.idleDays)} unused on Free, or {days(PAID_IDLE_DAYS)} on a paid plan, ADE
                cleans the computer up. You get an email first. Before it deletes anything, ADE commits the work
                and pushes it to the lane's branch. The lane and its chats stay, and your next message makes a new
                computer from the branch.
              </FaqItem>
            </Reveal>
            <Reveal delay={0.16}>
              <FaqItem question="What are phone minutes?">
                Time on a phone in the cloud that your agents can test your app on. It's coming soon. Each plan
                will include the minutes shown above.
              </FaqItem>
            </Reveal>
          </div>
        </div>
      </Section>

      <Section className="pb-24 pt-10 sm:pb-28">
        <Reveal>
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-balance text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
              Start with {formatCount(FREE_PLAN.hours)} free hours.
            </h2>
            <p className="mt-3 text-pretty text-sm leading-relaxed text-muted-fg sm:text-base">
              ADE is free and open source. ADE Cloud is there when you want it.
            </p>
            <InstallBlock position={MARKETING_CTA_POSITIONS.PRICING_PAGE} />
          </div>
        </Reveal>
      </Section>
    </Page>
  );
}

function PlanCard({ plan, highlighted }: { plan: PricingPlan; highlighted: boolean }) {
  const { openInstall } = useInstallDialog();
  const cta = PLAN_CTAS[plan.id];
  return (
    <Card
      tone={highlighted ? "solid" : "soft"}
      className={cn(
        "relative flex h-full flex-col p-6",
        highlighted &&
          "border-[color:var(--color-violet-bright)]/50 shadow-[0_0_0_1px_rgba(167,139,250,0.25),0_24px_70px_-20px_rgba(124,58,237,0.55)]",
      )}
    >
      {highlighted ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[22px]"
          style={{ background: "radial-gradient(120% 60% at 50% 0%, rgba(124,58,237,0.16), transparent 70%)" }}
        />
      ) : null}
      <div className="relative flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-fg">{plan.name}</h2>
        {highlighted ? (
          <Badge variant="accent" size="sm" className="border-[color:var(--color-violet-bright)]/40 bg-[rgba(124,58,237,0.18)]">
            Recommended
          </Badge>
        ) : null}
      </div>
      <p className="relative mt-1 text-sm text-muted-fg">{plan.pitch}</p>
      <div className="relative mt-5 flex items-baseline gap-1.5">
        <span className="text-4xl font-semibold tracking-tight text-fg">${plan.priceUsd}</span>
        <span className="text-sm text-muted-fg">a month</span>
      </div>
      <button
        type="button"
        onClick={() => openInstall(guessPlatform())}
        data-ade-analytics-cta={cta.cta}
        data-ade-analytics-position={MARKETING_CTA_POSITIONS.PRICING_PAGE}
        className={cn(buttonClassName(highlighted ? "primary" : "secondary", "md"), "relative mt-5 w-full")}
      >
        {cta.label}
      </button>
      <ul className="relative mt-6 flex flex-col gap-3 border-t border-border/70 pt-5 text-sm">
        <PlanLine icon={<Cpu className="h-4 w-4" />} strong={`${formatCount(plan.hours)} hours`}>
          a month
        </PlanLine>
        <PlanLine icon={<HardDrive className="h-4 w-4" />} strong={`${plan.diskGb} GB disk`}>
          shared by your computers
        </PlanLine>
        <PlanLine icon={<Timer className="h-4 w-4" />} strong={plan.extraHourCents == null ? "Work stops" : `${formatCents(plan.extraHourCents)}`}>
          {plan.extraHourCents == null ? `at ${formatCount(plan.hours)} hours` : "for each extra hour"}
        </PlanLine>
        <PlanLine icon={<Moon className="h-4 w-4" />} strong={days(plan.idleDays)}>
          before an unused computer is cleaned up
        </PlanLine>
        <PlanLine icon={<Smartphone className="h-4 w-4" />} strong={`${formatCount(plan.phoneMinutes)} phone minutes`}>
          <span className="text-muted-fg/80">coming soon</span>
        </PlanLine>
      </ul>
    </Card>
  );
}

function PlanLine({ icon, strong, children }: { icon: ReactNode; strong: string; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 shrink-0 text-[color:var(--color-violet-bright)]">{icon}</span>
      <span className="text-muted-fg">
        <span className="font-medium text-fg">{strong}</span> {children}
      </span>
    </li>
  );
}

function FactCard({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <Card className="h-full p-6">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border/70 bg-card text-[color:var(--color-violet-bright)]">
        {icon}
      </div>
      <h3 className="mt-4 text-base font-semibold text-fg">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted-fg">{children}</p>
    </Card>
  );
}

function SizeCard({ size }: { size: PricingSize }) {
  return (
    <Card className="flex h-full flex-col p-4 sm:p-5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold text-fg">{size.label}</h3>
        <span className="font-mono text-lg font-medium text-[color:var(--color-violet-bright)]">{sizeRate(size)}</span>
      </div>
      <p className="mt-1 text-xs text-muted-fg">
        {size.rate === 1 ? "1 hour of your plan per hour" : `${formatCount(size.rate)} hours of your plan per hour`}
      </p>
      <p className="mt-4 text-sm leading-snug text-fg">{size.use}</p>
      <p className="mt-auto pt-4 text-xs leading-relaxed text-muted-fg">
        {size.cpu} CPUs · {size.memoryGb} GB memory
        <br />
        Up to {size.diskMaxGb} GB disk
      </p>
    </Card>
  );
}

function Rule({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-3 text-sm leading-relaxed text-fg sm:text-base">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[rgba(124,58,237,0.18)] text-[color:var(--color-violet-bright)]">
        <Check className="h-3.5 w-3.5" />
      </span>
      <span>{children}</span>
    </li>
  );
}

function FaqItem({ question, children }: { question: string; children: ReactNode }) {
  return (
    <details className="group rounded-[18px] border border-border/70 bg-card/60 shadow-glass-sm open:bg-card/80">
      <summary className="focus-ring flex cursor-pointer list-none items-center justify-between gap-4 rounded-[18px] px-5 py-4 text-left text-sm font-semibold text-fg sm:text-base [&::-webkit-details-marker]:hidden">
        {question}
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-fg transition-transform duration-200 group-open:rotate-180" />
      </summary>
      <p className="px-5 pb-5 text-sm leading-relaxed text-muted-fg">{children}</p>
    </details>
  );
}
