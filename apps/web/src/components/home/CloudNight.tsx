import { Link } from "react-router-dom";
import { ArrowRight, ArrowUp, Check, GitPullRequest } from "lucide-react";
import { FREE_PLAN, FREE_RULES, PRICING_PLANS, formatCount } from "../../lib/cloudPricing";
import { MARKETING_CTA_LABELS, MARKETING_CTA_POSITIONS, MARKETING_FEATURES } from "../../lib/marketingAnalytics";
import { CloudLockup, CloudMark } from "../cloud/CloudMark";
import { ComingSoon } from "../cloud/ComingSoon";
import { PlanButton } from "../cloud/PlanButton";
import { linkToPricing } from "../../lib/siteFlags";
import { AgentLog, City, Moon, NightSky } from "../cloud/NightCity";

const CHEAPEST_PAID_USD = Math.min(...PRICING_PLANS.filter((plan) => plan.priceUsd > 0).map((plan) => plan.priceUsd));

/**
 * ADE Cloud on the home page. It follows the story's last chapter (every
 * machine on one account), so it opens on the one machine you do not own.
 * One night is the picture: send a task at 23:40, close the laptop, wake up
 * to a pull request. Then the free hours, and what is coming next. */
export function CloudNight() {
  return (
    <section
      id="ade-cloud"
      aria-labelledby="ade-cloud-title"
      className="relative scroll-mt-16 overflow-hidden"
      style={{
        background:
          "linear-gradient(180deg, #0a0a0f 0%, var(--color-night) 22%, #17123a 58%, var(--color-dusk) 100%)",
      }}
    >
      <NightSky />
      <Moon className="right-[9%] top-[clamp(56px,9vw,120px)] h-[clamp(44px,5vw,76px)] w-[clamp(44px,5vw,76px)]" />

      <div className="relative mx-auto max-w-[1240px] px-5 pt-[clamp(96px,12vw,160px)] text-center sm:px-8">
        <div className="flex items-center justify-center gap-3">
          <CloudLockup className="text-[17px] text-white" markClassName="h-6" />
        </div>
        <h2
          id="ade-cloud-title"
          className="mt-5 font-serif font-normal text-white"
          style={{ fontSize: "clamp(44px, 6.6vw, 104px)", lineHeight: 0.98, letterSpacing: "-0.02em" }}
        >
          Close your laptop.
          <br />
          <em className="italic text-[color:var(--color-lamp)]">The agents keep going.</em>
        </h2>
        <p className="mx-auto mt-6 max-w-[34rem] text-[clamp(16px,1.3vw,19px)] leading-[1.6] text-white/65">
          Send a task to its own computer in the cloud. Your agents code, test and open a pull request while you sleep.
        </p>
      </div>

      <OneNight />

      <div className="relative mx-auto max-w-[1240px] px-5 pt-[clamp(72px,9vw,120px)] text-center sm:px-8">
        <p className="flex flex-wrap items-baseline justify-center gap-x-4 gap-y-1">
          <span
            className="font-serif leading-none text-[color:var(--color-lamp)]"
            style={{ fontSize: "clamp(88px, 11vw, 156px)", textShadow: "0 0 60px rgba(255,210,122,0.35)" }}
          >
            {formatCount(FREE_PLAN.hours)}
          </span>
          <span className="text-left font-serif text-[clamp(28px,3vw,42px)] leading-[1.05] text-white">
            free hours
            <br />
            every month
          </span>
        </p>
        <p className="mt-4 text-[17px] text-white/70">No credit card. Paid plans from ${CHEAPEST_PAID_USD} a month.</p>
        <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
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
              See the plans
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

/** The night, left to right: the sky warms to dawn behind the last step. */
function OneNight() {
  return (
    <div className="relative mx-auto mt-[clamp(48px,6vw,80px)] max-w-[1180px] px-5 sm:px-8">
      <ol
        className="relative grid overflow-hidden rounded-[32px] border border-white/[0.08] lg:grid-cols-3"
        style={{
          background: [
            "radial-gradient(60% 90% at 100% 100%, rgba(255,170,110,0.28), transparent 70%)",
            "radial-gradient(40% 70% at 92% 110%, rgba(255,210,122,0.30), transparent 70%)",
            "linear-gradient(90deg, rgba(18,15,46,0.85) 0%, rgba(32,20,70,0.8) 55%, rgba(74,36,92,0.75) 100%)",
          ].join(", "),
        }}
      >
        <Step time="23:40" title="Send the task">
          <div className="w-full max-w-[300px] rounded-[16px] border border-white/[0.1] bg-[#15122d]/90 p-3.5 text-left shadow-[0_24px_60px_-20px_rgba(0,0,0,0.6)]">
            <p className="text-[13.5px] leading-[1.5] text-white/85">Fix the rounding bug in checkout and add tests.</p>
            <div className="mt-3 flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.07] py-1 pl-1.5 pr-2.5 text-[12px] text-white/80">
                <CloudMark className="h-3" />
                ADE Cloud
              </span>
              <span className="grid h-7 w-7 place-items-center rounded-full bg-[color:var(--color-violet-bright)] text-[#120f2e]">
                <ArrowUp className="h-3.5 w-3.5" />
              </span>
            </div>
          </div>
        </Step>
        <Step time="Overnight" title="Close your laptop">
          <AgentLog className="w-full max-w-[300px] text-left" />
        </Step>
        <Step time="07:30" title="Wake up to a pull request" last>
          <div className="w-full max-w-[300px] rounded-[16px] border border-white/[0.12] bg-[#1b1530]/90 p-3.5 text-left shadow-[0_24px_60px_-20px_rgba(255,170,110,0.35)]">
            <div className="flex items-center gap-2 text-[12px] text-emerald-300">
              <GitPullRequest className="h-3.5 w-3.5" />
              Ready to merge
            </div>
            <p className="mt-2 text-[14px] font-semibold text-white">Fix checkout rounding</p>
            <p className="mt-0.5 text-[12px] text-white/45">#1301 · fix-checkout</p>
            <ul className="mt-3 flex flex-col gap-1.5 text-[12.5px] text-white/75">
              <li className="flex items-center gap-2">
                <Check className="h-3.5 w-3.5 text-emerald-300" />
                412 tests pass
              </li>
              <li className="flex items-center gap-2">
                <Check className="h-3.5 w-3.5 text-emerald-300" />
                12 new tests
              </li>
              <li className="flex items-center gap-2">
                <Check className="h-3.5 w-3.5 text-emerald-300" />
                3 files changed
              </li>
            </ul>
          </div>
        </Step>
      </ol>
    </div>
  );
}

function Step({ time, title, last, children }: { time: string; title: string; last?: boolean; children: React.ReactNode }) {
  return (
    <li
      className={
        "relative flex flex-col items-center gap-5 px-6 pb-9 pt-8 text-center sm:px-8" +
        (last ? "" : " border-b border-white/[0.07] lg:border-b-0 lg:border-r")
      }
    >
      <div>
        <p className="font-mono text-[12.5px] text-[color:var(--color-lamp)]/85">{time}</p>
        <h3 className="mt-1.5 text-[19px] font-semibold text-white">{title}</h3>
      </div>
      <div className="flex w-full items-center justify-center lg:min-h-[214px]">{children}</div>
    </li>
  );
}
