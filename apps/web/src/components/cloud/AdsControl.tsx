import { cn } from "../../lib/cn";
import { MARKETING_FEATURES, type MarketingScreen } from "../../lib/marketingAnalytics";
import { captureMarketingFeature } from "../../lib/marketingAnalyticsBrowser";
import { setAdsOn } from "../../lib/siteOffer";
import type { PricingView } from "../../lib/pricingView";
import { adsSentence } from "../../lib/pricingView";

/**
 * "With ads / No ads", built like a monthly and yearly switch: two segments
 * in one pill, the discount on the first. Renders nothing where the visitor's
 * country has no ads, so the page says nothing about ads there.
 */
export function AdsControl({ view, screen, align = "center", className }: { view: PricingView; screen: MarketingScreen; align?: "center" | "start"; className?: string }) {
  const ads = view.ads;
  if (!ads) return null;
  const choose = (on: boolean) => {
    if (on === view.withAds) return;
    setAdsOn(on);
    reportChoice(on, screen);
  };
  const options = [
    { on: true, label: "With ads", note: `${ads.discountPct}% less` },
    { on: false, label: "No ads", note: null },
  ] as const;
  return (
    <div className={cn("flex flex-col gap-3", align === "center" ? "items-center text-center" : "items-start text-left", className)}>
      <div
        role="radiogroup"
        aria-label="Prices with ads or with no ads"
        className="inline-flex rounded-full border border-white/12 bg-white/[0.04] p-1"
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
          event.preventDefault();
          choose(!view.withAds);
          (event.currentTarget.querySelector(`[data-ads="${String(!view.withAds)}"]`) as HTMLButtonElement | null)?.focus();
        }}
      >
        {options.map((option) => {
          const active = view.withAds === option.on;
          return (
            <button
              key={option.label}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              data-ads={String(option.on)}
              onClick={() => choose(option.on)}
              className={cn(
                "focus-ring inline-flex items-center gap-2 rounded-full px-4 py-2 text-[14px] font-medium transition-colors",
                active ? "bg-white text-[#0b0a14]" : "text-white/65 hover:text-white",
              )}
            >
              {option.label}
              {option.note ? (
                <span
                  className={cn(
                    "rounded-full px-1.5 py-px text-[12px] font-semibold tabular-nums",
                    active ? "bg-[color:var(--color-lamp)] text-[#3a2a06]" : "bg-[color:var(--color-lamp)]/15 text-[color:var(--color-lamp)]",
                  )}
                >
                  {option.note}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <p className="max-w-[34rem] text-[14px] leading-[1.55] text-white/55">{adsSentence(ads)} Turn ads off at any time.</p>
    </div>
  );
}

/** The sides already reported this visit: each side's first choice is sent once (`docs/logging.md`, public marketing site). */
const reported = new Set<boolean>();

function reportChoice(on: boolean, screen: MarketingScreen): void {
  if (reported.has(on)) return;
  reported.add(on);
  captureMarketingFeature(on ? MARKETING_FEATURES.CHOOSE_AD_PRICES : MARKETING_FEATURES.CHOOSE_NO_ADS_PRICES, screen);
}
