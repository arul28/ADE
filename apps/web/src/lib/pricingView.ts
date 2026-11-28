/**
 * The prices a visitor sees, today's or Pricing v3's, in the units the page
 * shows. The plan facts stay in `cloudPricing.ts` (the server's own files);
 * this adds what Pricing v3 changes on the page:
 *
 * - credits shown at 10 times the stored unit (`CREDIT_SCALE`), so the
 *   money and the hours of every plan stay the same;
 * - the cloud iPhone at half its price in money, and the cloud Mac;
 * - the ad price (`discountPct` less, rounded to whole credits) beside the
 *   full price, only where the server says the visitor's country has ads.
 *
 * Inside, every amount stays in the stored unit (Medium-hours, a thousandth
 * of which the server keeps), so the plan finder's arithmetic is the same
 * for both; only what is shown is scaled.
 */
import { useMemo } from "react";
import {
  CREDIT_SCALE,
  HOURLY_SIZES,
  INVITE_RULES,
  MAC_MILLI_PER_MINUTE,
  PHONE_CREDITS_PER_MINUTE,
  PHONE_MILLI_PER_MINUTE_V3,
  SHOWN_CREDIT_MILLI,
  adRateMilli,
  v3FullRateMilli,
  SMALL_NO_ADS_RATE,
  formatCount,
  type PricingPlan,
  type PricingSize,
} from "./cloudPricing";
import { useAdsOn, useSiteOffer, type SiteAds, type SiteOffer } from "./siteOffer";
import { BRAND } from "../../../desktop/src/shared/brand";

/** The ad price of a full price in shown credits (Pricing v3): the server's `adRateMilli`, in shown credits. */
export const adPriceOf = (full: number, pct: number): number => adRateMilli(Math.round(full * SHOWN_CREDIT_MILLI), pct) / SHOWN_CREDIT_MILLI;

/** A price as shown: what it costs now, and the full price struck beside it while ads are on (null with no ads). */
export type ShownPrice = { now: number; struck: number | null };

export type Machine = {
  id: PricingSize["id"] | "mac" | "iphone";
  name: string;
  /** Specs in words. */
  specs: string;
  /** What it is for, in a few words. */
  use: string;
  per: "hour" | "minute";
  /** Shown credits for each hour (or minute). */
  price: ShownPrice;
  /** Stored Medium-hours for each hour (or minute) at the price now. */
  storedRate: number;
  kind: "linux" | "mac" | "iphone";
};

export type PricingView = {
  v3: boolean;
  /** The ad price, where the visitor's country has it: the control shows. Null: full prices only, no word about ads. */
  ads: SiteAds | null;
  /** The control is on "With ads". */
  withAds: boolean;
  /** Shown credits for `stored` Medium-hours. */
  credits: (stored: number) => number;
  /** "1 credit", "6,000 credits". */
  creditsLabel: (shown: number) => string;
  /** The machines that use credits, in the order the page lists them: the hourly sizes, the Mac (when open), the iPhone. */
  machines: Machine[];
  /** Free's Small for an hour, in shown credits: free with ads, a rate without. */
  freeSmall: ShownPrice;
  /** Small is free on Free too, with ads or not (the server's ad switch does not reach everyone): free on every plan. */
  freeSmallFree: boolean;
  /** How far `storedHours` of a plan goes on `machine`, in whole hours or minutes. */
  timeOn: (storedHours: number, machine: Machine) => number;
  /** The same with no ads, for the honest "50 with no ads" beside it. Null when the control is not on "With ads". */
  timeOnFull: (storedHours: number, machine: Machine) => number | null;
  /** Extra credits: "$4 for 1,000" under v3, "4¢ each" today. */
  extraPrice: (plan: PricingPlan) => string | null;
  /** Stored Medium-hours each Small hour on Free uses at the price now (0 with ads). */
  freeSmallStoredRate: number;
  /** An invite's reward in shown credits. */
  inviteCredits: number;
  /** The cloud Mac is on the page. */
  mac: boolean;
  /** What uses the plan's credits: "bigger computers, the Mac and the iPhone". */
  spenders: string;
};

function sizeMachine(size: PricingSize, scale: number, ads: SiteAds | null, withAds: boolean): Machine {
  // Today's rate as it is (2.5 on a Large); Pricing v3's from the server's whole-credit rule.
  const full = scale === 1 ? size.rate : v3FullRateMilli(Math.round(size.rate * 1000)) / SHOWN_CREDIT_MILLI;
  const ad = ads ? adPriceOf(full, ads.discountPct) : full;
  const now = withAds ? ad : full;
  return {
    id: size.id,
    name: size.machine,
    specs: size.specs,
    use: size.use,
    per: "hour",
    price: { now, struck: withAds && ad !== full ? full : null },
    storedRate: now / scale,
    kind: "linux",
  };
}

function minuteMachine(id: "mac" | "iphone", storedPerMinute: number, scale: number, ads: SiteAds | null, withAds: boolean): Machine {
  const full = storedPerMinute * scale;
  const ad = ads ? adPriceOf(full, ads.discountPct) : full;
  const now = withAds ? ad : full;
  return id === "mac"
    ? { id, name: "Mac", specs: "6 CPUs, 8 GB, Xcode", use: "Mac and iPhone builds", per: "minute", price: { now, struck: withAds && ad !== full ? full : null }, storedRate: now / scale, kind: "mac" }
    : { id, name: "iOS Simulator", specs: "An iPhone in the cloud", use: "No Mac needed", per: "minute", price: { now, struck: withAds && ad !== full ? full : null }, storedRate: now / scale, kind: "iphone" };
}

/** The view for one answer of the server and one position of the control. Pure, so the numbers table can be checked. */
export function pricingViewFor(offer: SiteOffer, adsOnChoice: boolean): PricingView {
  const v3 = offer.v3;
  const ads = offer.v3 ? offer.ads : null;
  const withAds = ads != null && adsOnChoice;
  const scale = v3 ? CREDIT_SCALE : 1;
  const credits = (stored: number) => Math.round(stored * scale);
  const creditsLabel = (shown: number) => `${formatCount(shown)} ${shown === 1 ? "credit" : "credits"}`;

  const machines: Machine[] = HOURLY_SIZES.map((size) => sizeMachine(size, scale, ads, withAds));
  if (offer.v3 && offer.mac) machines.push(minuteMachine("mac", MAC_MILLI_PER_MINUTE / 1000, scale, ads, withAds));
  machines.push(minuteMachine("iphone", v3 ? PHONE_MILLI_PER_MINUTE_V3 / 1000 : PHONE_CREDITS_PER_MINUTE, scale, ads, withAds));

  const smallFull = offer.v3 ? offer.freeSmallMilli / SHOWN_CREDIT_MILLI : SMALL_NO_ADS_RATE * scale;
  // Free's Small: free with ads (in every ad country), the full rate without.
  const freeSmall: ShownPrice = withAds ? { now: 0, struck: smallFull } : { now: smallFull, struck: null };

  const fullRate = (machine: Machine) => (machine.price.struck ?? machine.price.now) / scale;
  const timeOn = (stored: number, machine: Machine) => Math.floor(stored / machine.storedRate + 1e-9);
  const timeOnFull = (stored: number, machine: Machine) => (machine.price.struck == null ? null : Math.floor(stored / fullRate(machine) + 1e-9));

  const extraPrice = (plan: PricingPlan): string | null => {
    if (plan.extraHourCents == null) return null;
    if (!v3) return null;
    // A stored Medium-hour costs `extraHourCents`; 1,000 shown credits are 1,000 / scale of them.
    const usd = (plan.extraHourCents * (1000 / scale)) / 100;
    return `$${Number.isInteger(usd) ? usd : usd.toFixed(2)} for 1,000 credits`;
  };

  return {
    v3,
    ads,
    withAds,
    credits,
    creditsLabel,
    machines,
    freeSmall,
    freeSmallFree: v3 && smallFull === 0,
    timeOn,
    timeOnFull,
    extraPrice,
    freeSmallStoredRate: freeSmall.now / scale,
    inviteCredits: credits(INVITE_RULES.rewardHours),
    mac: machines.some((machine) => machine.kind === "mac"),
    spenders: machines.some((machine) => machine.kind === "mac")
      ? `bigger computers, the ${BRAND.CLOUD_NAME} Mac and the ${BRAND.CLOUD_NAME} iPhone`
      : `bigger computers and the ${BRAND.CLOUD_NAME} iPhone`,
  };
}

/** The view for this visitor, live with the server's answer and the control. */
export function usePricingView(): PricingView {
  const offer = useSiteOffer();
  const adsOn = useAdsOn();
  return useMemo(() => pricingViewFor(offer, adsOn), [offer, adsOn]);
}

/** The control's one sentence (`Words` in the plan: never "earn", "reward" or "watch"). */
export function adsSentence(ads: SiteAds): string {
  return `A chat that uses ${BRAND.CLOUD_NAME} shows an ad under each reply. With ads on, ${BRAND.CLOUD_NAME} costs ${ads.discountPct}% less.`;
}

/**
 * The ad window in the apps' words (`copy.md`, "Full price: no chat in use
 * for an hour"): "5 minutes" to "45 minutes", "an hour", "90 minutes",
 * "2 hours" to "12 hours", "a day"; null for anything else.
 */
function windowWords(minutes: number): string | null {
  if (minutes >= 5 && minutes <= 45 && minutes % 5 === 0) return `${minutes} minutes`;
  if (minutes === 60) return "an hour";
  if (minutes === 90) return "90 minutes";
  if (minutes >= 120 && minutes <= 720 && minutes % 60 === 0) return `${minutes / 60} hours`;
  if (minutes === 1440) return "a day";
  return null;
}

/** When the ad price counts, in one line for the small print. */
export function adPriceRuleSentence(ads: SiteAds): string {
  const window = windowWords(ads.windowMinutes);
  return `The ad price counts while you use a ${BRAND.CLOUD_NAME} chat on that computer, and for ${window ?? "a while"} after. CLI sessions, automations and work an outside agent starts always use the full price.`;
}

/**
 * What a credit buys, under Pricing v3: "A Medium computer uses 10 credits an
 * hour, and the DAEX Cloud iPhone 5 a minute. Small computers on paid plans use none."
 */
export function creditUnitSentence(view: PricingView): string {
  const medium = view.machines.find((machine) => machine.id === "medium");
  const phone = view.machines.find((machine) => machine.kind === "iphone");
  const mac = view.machines.find((machine) => machine.kind === "mac");
  const full = (machine: Machine | undefined) => formatCount(machine ? (machine.price.struck ?? machine.price.now) : 0);
  const minutes = mac && phone && full(mac) === full(phone)
    ? `the ${BRAND.CLOUD_NAME} Mac and iPhone ${full(phone)} a minute each`
    : `${mac ? `the ${BRAND.CLOUD_NAME} Mac ${full(mac)} a minute, ` : ""}the ${BRAND.CLOUD_NAME} iPhone ${full(phone)} a minute`;
  return `A Medium computer uses ${full(medium)} credits an hour, and ${minutes}. Small computers ${view.freeSmallFree ? "use" : "on paid plans use"} none.`;
}

