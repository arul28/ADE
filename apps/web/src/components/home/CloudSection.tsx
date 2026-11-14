import { useEffect, useRef, useState } from "react";
import { Check, GitPullRequest, Smartphone } from "lucide-react";
import { FREE_PLAN, PRICING_PLANS, centsPerIncludedHour, formatCount, type PricingPlan } from "../../lib/cloudPricing";
import { MARKETING_CTA_LABELS, MARKETING_CTA_POSITIONS } from "../../lib/marketingAnalytics";
import { cn } from "../../lib/cn";
import { CloudLockup } from "../cloud/CloudMark";
import { City, Moon, NightSky } from "../cloud/NightCity";
import { PlanButton } from "../cloud/PlanButton";
import { AppleMark } from "./marks";

const CHEAPEST_PAID = [...PRICING_PLANS].filter((plan) => plan.priceUsd > 0).sort((a, b) => a.priceUsd - b.priceUsd)[0]!;

/**
 * ADE Cloud on the home page: a title, then one card. On its left, a cloud
 * computer doing a task overnight; on its right, what that costs, drawn as
 * bars of hours (the free plan, then the cheapest paid one), with the two
 * buttons. What is coming next runs along the card's foot. Every number comes
 * from `lib/cloudPricing.ts`.
 */
export function CloudSection() {
  return (
    <section
      id="ade-cloud"
      aria-labelledby="ade-cloud-title"
      className="relative scroll-mt-16 overflow-hidden"
      style={{ background: "linear-gradient(180deg, #0a0a0f 0%, var(--color-night) 22%, #17123a 60%, var(--color-dusk) 100%)" }}
    >
      <NightSky />
      <Moon className="right-[9%] top-[clamp(56px,8vw,110px)] h-[clamp(40px,4.6vw,68px)] w-[clamp(40px,4.6vw,68px)]" />

      <div className="relative mx-auto max-w-[1180px] px-5 pt-[clamp(56px,6vw,88px)] sm:px-8">
        <div className="text-center">
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
        </div>

        <div className="mt-[clamp(40px,5vw,64px)] overflow-hidden rounded-[32px] border border-white/[0.1] bg-[#120f2b]/85 shadow-[0_50px_120px_-30px_rgba(124,58,237,0.55)] backdrop-blur-md">
          <div className="grid lg:grid-cols-[1fr_1.05fr]">
            <div className="relative border-b border-white/[0.08] p-6 sm:p-9 lg:border-b-0 lg:border-r">
              <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(90% 70% at 0% 0%, rgba(139,92,246,0.22), transparent 60%)" }} />
              <p className="relative text-[13px] font-medium text-white/55">Send a task, close your laptop</p>
              <CloudComputer className="relative mt-5" />
            </div>
            <div className="relative p-6 sm:p-9">
              <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(90% 70% at 100% 0%, rgba(255,210,122,0.14), transparent 60%)" }} />
              <p className="relative text-[13px] font-medium text-white/55">What it costs</p>
              <div className="relative mt-6 flex flex-col gap-6">
                <HoursBar plan={FREE_PLAN} max={CHEAPEST_PAID.hours} price="Free" note="No credit card" lit />
                <HoursBar plan={CHEAPEST_PAID} max={CHEAPEST_PAID.hours} price={`$${CHEAPEST_PAID.priceUsd}`} note={`${centsPerIncludedHour(CHEAPEST_PAID) ?? ""} an hour`} />
              </div>
              <div className="relative mt-8 grid grid-cols-2 gap-3">
                <PlanButton cta={MARKETING_CTA_LABELS.GET_STARTED_FREE} position={MARKETING_CTA_POSITIONS.HOME_CLOUD} tone="lamp" className="w-full">
                  Start free
                </PlanButton>
                <PlanButton
                  cta={MARKETING_CTA_LABELS.CHOOSE_PLAN_PLUS}
                  position={MARKETING_CTA_POSITIONS.HOME_CLOUD}
                  plan={CHEAPEST_PAID.id}
                  tone="quiet"
                  className="w-full"
                >
                  Get {CHEAPEST_PAID.name}
                </PlanButton>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 border-t border-white/[0.08] bg-black/20 px-6 py-4 text-[14px] text-white/70">
            <span className="text-[12px] font-medium uppercase tracking-[0.12em] text-[color:var(--color-lamp)]">Coming soon</span>
            <span className="inline-flex items-center gap-2">
              <Smartphone className="h-4 w-4 text-white/60" /> iOS Simulator in the cloud
            </span>
            <span className="inline-flex items-center gap-2">
              <AppleMark className="h-4 w-4 text-white/60" /> Mac computers in the cloud
            </span>
          </div>
        </div>
      </div>

      <City scale={0.7} count={15} seed={11} className="mt-[clamp(56px,7vw,96px)]" />
    </section>
  );
}

/** One plan's hours as a bar, measured against the largest bar shown, with its price at the end. */
function HoursBar({ plan, max, price, note, lit }: { plan: PricingPlan; max: number; price: string; note: string; lit?: boolean }) {
  const share = Math.max(0.08, Math.min(1, plan.hours / max));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <p className="flex items-baseline gap-2">
          <span className={cn("font-serif leading-none", lit ? "text-[color:var(--color-lamp)]" : "text-white")} style={{ fontSize: "clamp(40px, 4vw, 56px)" }}>
            {formatCount(plan.hours)}
          </span>
          <span className="text-[16px] text-white/60">hours a month</span>
        </p>
        <p className="text-right">
          <span className="block text-[22px] font-semibold leading-none text-white">{price}</span>
          <span className="mt-1 block text-[13px] text-white/45">{note}</span>
        </p>
      </div>
      <div className="mt-3 h-3 overflow-hidden rounded-full bg-white/[0.07]">
        <div
          className={cn("h-full rounded-full", lit ? "bg-[color:var(--color-lamp)] shadow-[0_0_20px_rgba(255,210,122,0.6)]" : "bg-[linear-gradient(90deg,#8b5cf6,#c4b5fd)] shadow-[0_0_20px_rgba(139,92,246,0.6)]")}
          style={{ width: `${share * 100}%` }}
        />
      </div>
    </div>
  );
}

const LOG = [
  { time: "23:41", text: "Reading the checkout service" },
  { time: "23:58", text: "Found the rounding bug" },
  { time: "00:26", text: "Wrote 12 tests" },
  { time: "01:14", text: "All 412 tests pass", good: true },
  { time: "01:22", text: "Asleep. No hours used." },
] as const;

/** One cloud computer's night, line by line once it scrolls into view, ending on a pull request. */
function CloudComputer({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShown(true);
          observer.disconnect();
        }
      },
      { threshold: 0.35 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} data-shown={shown} aria-hidden className={cn("rounded-[20px] border border-white/[0.1] bg-[#0d0b20] shadow-[0_30px_70px_-20px_rgba(0,0,0,0.8)]", className)}>
      <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3 text-[13px]">
        <span className="flex items-center gap-2 text-white/80">
          <span className="flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
            <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
            <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
          </span>
          <span className="ml-2 font-medium">fix-checkout</span>
          <span className="text-white/35">· Small</span>
        </span>
        <span className="flex items-center gap-1.5 text-[color:var(--color-lamp)]">
          <span className="ade-pulse-dot h-1.5 w-1.5 rounded-full bg-[color:var(--color-lamp)]" />
          In the cloud
        </span>
      </div>
      <div className="px-4 py-4 font-mono text-[13px] leading-[2] text-white/80">
        {LOG.map((line, index) => (
          <div key={line.time} className="ade-log-line flex gap-4" style={{ animationDelay: `${0.2 + index * 0.45}s` }}>
            <span className="text-white/30">{line.time}</span>
            <span className={"good" in line ? "text-emerald-300" : undefined}>{line.text}</span>
          </div>
        ))}
      </div>
      <div className="ade-log-line mx-4 mb-4 flex items-center gap-3 rounded-[14px] border border-emerald-400/25 bg-emerald-400/[0.07] px-4 py-3" style={{ animationDelay: `${0.2 + LOG.length * 0.45}s` }}>
        <GitPullRequest className="h-5 w-5 shrink-0 text-emerald-300" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold text-white">Fix checkout rounding</p>
          <p className="text-[12.5px] text-white/50">#1301 · ready when you wake up</p>
        </div>
        <Check className="h-5 w-5 shrink-0 text-emerald-300" />
      </div>
    </div>
  );
}
