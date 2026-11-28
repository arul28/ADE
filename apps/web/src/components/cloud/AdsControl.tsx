import { cn } from "../../lib/cn";
import { setAdsOn } from "../../lib/siteOffer";
import type { PricingView, ShownPrice } from "../../lib/pricingView";
import { adsSentence } from "../../lib/pricingView";
import { formatCount } from "../../lib/cloudPricing";

/**
 * "With ads / No ads", built like a monthly and yearly switch: two segments
 * in one pill, the discount on the first. Renders nothing where the visitor's
 * country has no ads, so the page says nothing about ads there.
 */
export function AdsControl({ view, align = "center", className }: { view: PricingView; align?: "center" | "start"; className?: string }) {
  const ads = view.ads;
  if (!ads) return null;
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
          setAdsOn(!view.withAds);
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
              onClick={() => setAdsOn(option.on)}
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

/**
 * A price in credits: the price now, and while ads are on the full price
 * struck beside it. `free` shows a zero as "Free".
 */
export function PriceFigure({
  price,
  className,
  struckClassName,
  free = false,
}: {
  price: ShownPrice;
  className?: string;
  struckClassName?: string;
  free?: boolean;
}) {
  const now = free && price.now === 0 ? "Free" : formatCount(price.now);
  return (
    <span className="inline-flex items-baseline gap-2">
      {price.struck != null ? (
        <s className={cn("text-white/35 decoration-white/45 decoration-[1.5px]", struckClassName)}>
          <span className="sr-only">Full price </span>
          {formatCount(price.struck)}
        </s>
      ) : null}
      <span className={className}>
        {price.struck != null ? <span className="sr-only">With ads </span> : null}
        {now}
      </span>
    </span>
  );
}
