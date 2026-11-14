import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import type { MarketingCtaLabel, MarketingCtaPosition } from "../../lib/marketingAnalytics";
import { useInstallDialog } from "../install/InstallDialogProvider";
import { guessPlatform } from "../home/SiteNav";

/**
 * ADE Cloud's plan and "get started" buttons. A plan is bought from inside
 * ADE (Settings, ADE Cloud), where the account is signed in, so every one of
 * these starts by getting the app.
 */
export function PlanButton({
  children,
  cta,
  position,
  tone = "quiet",
  className,
}: {
  children: ReactNode;
  cta: MarketingCtaLabel;
  position: MarketingCtaPosition;
  tone?: "quiet" | "lamp" | "violet" | "white";
  className?: string;
}) {
  const { openInstall } = useInstallDialog();
  return (
    <button
      type="button"
      onClick={() => openInstall(guessPlatform())}
      data-ade-analytics-cta={cta}
      data-ade-analytics-position={position}
      className={cn(
        "focus-ring h-11 rounded-full px-6 text-[15px] font-semibold transition-colors",
        tone === "quiet" && "border border-white/15 bg-white/[0.06] text-white hover:border-white/30 hover:bg-white/[0.1]",
        tone === "lamp" && "bg-[color:var(--color-lamp)] text-[#1a1430] hover:bg-[#ffdd99]",
        tone === "violet" && "bg-[color:var(--color-violet-bright)] text-[#160f33] hover:bg-[#bba6fb]",
        tone === "white" && "bg-white text-[#0d0b24] hover:bg-white/90",
        className,
      )}
    >
      {children}
    </button>
  );
}
