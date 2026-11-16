import type { ReactNode } from "react";
import type { PricingPlan } from "../../lib/cloudPricing";
import { cn } from "../../lib/cn";
import { planHref } from "../../lib/planLinks";
import type { MarketingCtaLabel, MarketingCtaPosition } from "../../lib/marketingAnalytics";
import { useInstallDialog } from "../install/InstallDialogProvider";
import { guessPlatform } from "../home/SiteNav";

/**
 * ADE Cloud's plan and "get started" buttons. A paid plan opens the web app
 * with `?cloudPlan=<plan>`: it signs the person in, then goes straight to
 * Stripe's checkout for that plan. Free, and a button with no plan, open the
 * install dialog, because the free hours start in the app.
 */
export function PlanButton({
  children,
  cta,
  position,
  plan,
  tone = "quiet",
  className,
}: {
  children: ReactNode;
  cta: MarketingCtaLabel;
  position: MarketingCtaPosition;
  plan?: PricingPlan["id"];
  tone?: "quiet" | "lamp" | "violet";
  className?: string;
}) {
  const { openInstall } = useInstallDialog();
  const classes = cn(
    "focus-ring inline-flex h-11 items-center justify-center rounded-full px-6 text-[15px] font-semibold transition-colors",
    tone === "quiet" && "border border-white/15 bg-white/[0.06] text-white hover:border-white/30 hover:bg-white/[0.1]",
    tone === "lamp" && "bg-[color:var(--color-lamp)] text-[#1a1430] hover:bg-[#ffdd99]",
    tone === "violet" && "bg-[color:var(--color-violet-bright)] text-[#160f33] hover:bg-[#bba6fb]",
    className,
  );
  if (plan && plan !== "free") {
    return (
      <a
        href={planHref(plan)}
        data-ade-analytics-cta={cta}
        data-ade-analytics-position={position}
        className={classes}
      >
        {children}
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={() => openInstall(guessPlatform())}
      data-ade-analytics-cta={cta}
      data-ade-analytics-position={position}
      className={classes}
    >
      {children}
    </button>
  );
}
