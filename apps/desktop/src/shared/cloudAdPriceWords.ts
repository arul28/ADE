import type {
  CloudAccountState,
  CloudAdsState,
  CloudComputerPrice,
  CloudFullPriceReason,
  CloudPrice,
  CloudPricingState,
} from "../../../account-directory/src/cloud/contract";
import { BRAND } from "./brand";
import type { CloudUnitWords } from "./cloudUnitWords";

/**
 * Pricing v3's words: both prices at every price, what a computer costs now
 * and why, the ads notice and switch, and the CLI and automation notices. One
 * source for the desktop, the web client and `daex cloud status`; the phone
 * writes the same (`/Volumes/Dev/scratch/pricing-v3/copy.md` is the list).
 *
 * The server decides every number (`CloudAccountState.pricing`, the catalog's
 * `adMultiplierMilli`). Nothing here computes a price: it only says the two
 * the server sent, in the order the person's setting makes them.
 */

/** What a person's account says about ads, read from `pricing`. Null without Pricing v3: every screen is today's. */
export type CloudAdsView = CloudAdsState & {
  /** A second price shows: the country has ads and the discount is above 0. */
  second: boolean;
  /** The account is on the Free plan: the notice says Small is free with ads. */
  freePlan: boolean;
};

export function cloudPricingOf(account: { pricing?: CloudPricingState | null } | null | undefined): CloudPricingState | null {
  const pricing = account?.pricing;
  return pricing && typeof pricing === "object" && pricing.ads && typeof pricing.ads === "object" ? pricing : null;
}

export function cloudAdsViewOf(account: (Pick<CloudAccountState, "plan"> & { pricing?: CloudPricingState | null }) | null | undefined): CloudAdsView | null {
  const pricing = cloudPricingOf(account);
  if (!pricing) return null;
  const ads = pricing.ads;
  const discountPct = Number.isFinite(ads.discountPct) ? Math.max(0, ads.discountPct) : 0;
  return {
    ...ads,
    discountPct,
    second: ads.available === true && discountPct > 0,
    freePlan: account?.plan === "free",
  };
}

/** A product's two prices, in thousandths of a Medium-hour unit, an hour (computers) or a minute (the iPhone, a Mac). */
export type CloudRatePair = { fullMilli: number; adMilli: number | null };

export type CloudRateUnit = "hour" | "minute";

const per = (unit: CloudRateUnit) => (unit === "hour" ? "an hour" : "a minute");
const shortPer = (unit: CloudRateUnit) => (unit === "hour" ? "/h" : "/min");

/**
 * A rate's shown number of credits, exact ("8", "2.5"): never rounded down
 * like a balance (`words.num`), so a rate never reads lower than it is.
 */
export function cloudRateNumber(milli: number, words: CloudUnitWords): string {
  return words.count(Math.max(0, milli) / 1000).split(" ")[0]!;
}

function creditsPer(milli: number, words: CloudUnitWords, unit: CloudRateUnit): string {
  return `${words.count(Math.max(0, milli) / 1000)} ${per(unit)}`;
}

/**
 * A product's price, both prices where they differ: the first is what the
 * person pays with their setting now (`leadAd`, default the account's ads
 * switch), the second the other one.
 *
 * - ads on: "8 credits an hour with ads · 10 with no ads"
 * - ads off: "10 credits an hour · 8 with ads"
 * - no ads here, a discount of 0, or no ad rate: "10 credits an hour"
 * - free either way: "Free"; Free's Small: "Free with ads · 5 credits an hour with no ads"
 */
export function cloudRateText(
  pair: CloudRatePair,
  view: CloudAdsView | null,
  words: CloudUnitWords,
  unit: CloudRateUnit = "hour",
  leadAd: boolean = view?.on === true,
): string {
  const full = Math.max(0, pair.fullMilli);
  const ad = pair.adMilli == null ? null : Math.max(0, pair.adMilli);
  const single = full === 0 ? "Free" : creditsPer(full, words, unit);
  // A discount of 0 makes both prices equal (no second price), except Free's Small, free with ads.
  if (!view || !view.available || ad == null || ad === full) return single;
  if (leadAd) {
    if (ad === 0) return `Free with ads · ${full === 0 ? "Free" : creditsPer(full, words, unit)} with no ads`;
    return `${creditsPer(ad, words, unit)} with ads · ${cloudRateNumber(full, words)} with no ads`;
  }
  return `${single} · ${ad === 0 ? "Free" : cloudRateNumber(ad, words)} with ads`;
}

/** The compact form for narrow places: "8/h with ads", "10/h", "Free", "4/min with ads". */
export function cloudRateCompact(
  pair: CloudRatePair,
  view: CloudAdsView | null,
  words: CloudUnitWords,
  unit: CloudRateUnit = "hour",
  leadAd: boolean = view?.on === true,
): string {
  const full = Math.max(0, pair.fullMilli);
  const ad = pair.adMilli == null ? null : Math.max(0, pair.adMilli);
  const withAds = Boolean(view?.available && ad != null && ad !== full && leadAd);
  const value = withAds ? ad! : full;
  if (value === 0) return withAds ? "Free with ads" : "Free";
  return `${cloudRateNumber(value, words)}${shortPer(unit)}${withAds ? " with ads" : ""}`;
}

/** A catalog size's two prices. */
export function cloudTierRatePair(tier: { multiplierMilli: number; adMultiplierMilli?: number | null }): CloudRatePair {
  return { fullMilli: tier.multiplierMilli, adMilli: tier.adMultiplierMilli ?? null };
}

/**
 * A size's credits an hour (thousandths) at the price paid now: its price
 * with ads while ads are on here (Settings' size table and its "Left at this
 * size"), else the full price. A start that always pays the full price (a CLI
 * session, an automation, an outside agent) passes no `view`.
 */
export function cloudTierRateNowMilli(tier: { multiplierMilli: number; adMultiplierMilli?: number | null }, view: CloudAdsView | null): number {
  const pair = cloudTierRatePair(tier);
  return view?.available === true && view.on && pair.adMilli != null ? pair.adMilli : pair.fullMilli;
}

/** A computer's or the iPhone's price now, as its two prices (`rateMilli` is now, `otherRateMilli` the other). */
export function cloudPriceNowPair(price: Pick<CloudPrice, "now" | "rateMilli" | "otherRateMilli">): CloudRatePair {
  return price.now === "ad"
    ? { fullMilli: price.otherRateMilli, adMilli: price.rateMilli }
    : { fullMilli: price.rateMilli, adMilli: price.otherRateMilli };
}

/** "8 credits an hour with ads · 10 with no ads" for the ad price now, "10 credits an hour · 8 with ads" for the full price. */
export function cloudPriceNowText(price: CloudPrice, view: CloudAdsView | null, words: CloudUnitWords, unit: CloudRateUnit = "hour"): string {
  return cloudRateText(cloudPriceNowPair(price), view, words, unit, price.now === "ad");
}

export function cloudPriceNowCompact(price: CloudPrice, view: CloudAdsView | null, words: CloudUnitWords, unit: CloudRateUnit = "hour"): string {
  return cloudRateCompact(cloudPriceNowPair(price), view, words, unit, price.now === "ad");
}

/** "for an hour", "for 30 minutes", "for 2 hours", "for a day"; null for a value with no plain word. */
function windowWords(minutes: number): string | null {
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes === 60) return "for an hour";
  if (minutes === 1440) return "for a day";
  if (minutes < 60 || minutes === 90) return `for ${minutes} minutes`;
  if (minutes % 60 === 0 && minutes < 1440) return `for ${minutes / 60} hours`;
  return null;
}

/**
 * Why a computer has the full price while ads are on, in one line; null with
 * the ad price, with ads off, or where there are no ads (nothing about ads
 * shows there). A reason the app doesn't know reads "Full price".
 */
export function cloudFullPriceReasonLine(
  price: Pick<CloudPrice, "now" | "reason"> & Partial<Pick<CloudPrice, "rateMilli" | "otherRateMilli">>,
  view: CloudAdsView | null,
): string | null {
  if (!view || !view.on || !view.available || price.now !== "full") return null;
  // One price (a paid plan's Small, the iPhone started before Pricing v3): the full price costs nothing more, so no reason.
  if (price.rateMilli != null && price.rateMilli === price.otherRateMilli) return null;
  const reason = price.reason as CloudFullPriceReason | null;
  if (reason === "ads_off" || reason === "no_ads_here") return null;
  switch (reason) {
    case "cli_session":
      return "Full price: a CLI session runs here";
    case "automation":
      return "Full price: an automation runs here";
    case "outside_agent":
      return "Full price: an outside agent works here";
    case "not_in_use": {
      const span = windowWords(view.windowMinutes);
      return span ? `Full price: no chat in use ${span}` : "Full price: no chat in use lately";
    }
    case "unverified":
      return "Full price: ads cannot show on this connection";
    default:
      return "Full price";
  }
}

/** The account's price for one computer, or null when the server lists none (or Pricing v3 is off). */
export function cloudComputerPriceOf(
  account: { pricing?: CloudPricingState | null } | null | undefined,
  instanceId: string | null | undefined,
): CloudComputerPrice | null {
  if (!instanceId) return null;
  return cloudPricingOf(account)?.computers.find((entry) => entry.instanceId === instanceId) ?? null;
}

/**
 * The sentence of the notice and the switch. `state`: "on" where ads start on
 * (the notice) or are on (the switch), "ask" where the person is asked first
 * or ads are off.
 */
export function cloudAdsSentence(view: Pick<CloudAdsView, "discountPct" | "freePlan">, state: "on" | "ask"): string {
  const pct = view.discountPct;
  if (view.freePlan) {
    if (pct <= 0) return state === "on" ? "Ads are on, so Small computers are free." : "Turn on ads, so Small computers are free.";
    return state === "on"
      ? `Ads are on: Small computers are free, and bigger ones cost ${pct}% less.`
      : `Turn on ads: Small computers are free, and bigger ones cost ${pct}% less.`;
  }
  if (pct <= 0) return state === "on" ? `Ads are on in your ${BRAND.CLOUD_NAME} chats.` : `Turn on ads in your ${BRAND.CLOUD_NAME} chats?`;
  return state === "on" ? `Ads are on, so ${BRAND.CLOUD_NAME} costs ${pct}% less.` : `Turn on ads to pay ${pct}% less.`;
}

/** The fixed words of the notice, the switch and the two full-price notices. */
export const CLOUD_ADS_WORDS = {
  label: "Ads",
  keep: "Keep ads",
  turnOff: "Turn off ads",
  turnOn: "Turn on ads",
  noThanks: "No thanks",
  keepOff: "Keep ads off",
  confirmTitle: "Turn on ads?",
  howItWorks: "How it works",
  fineLine: `One ad under a finished reply. Change this any time in Settings › ${BRAND.CLOUD_NAME}.`,
  whereShown: `Ads show under replies in chats that use ${BRAND.CLOUD_NAME}. CLI sessions, automations and work an outside agent starts always use the full price.`,
  /** What Gravity gets: the same facts as the consent copy before Pricing v3 (`SponsoredReplySlot`). */
  sends: `To pick an ad, ${BRAND.NAME} sends Gravity, our ad partner, your last message and the reply (or the agent's search), your IP address, your device type and a hashed copy of your account email. Ads are for people 18 or older.`,
  openAsChat: "Open as a chat",
  startCli: "Start CLI",
} as const;

/** The notice when a person starts an agent CLI on a cloud computer while ads are on. */
export function cloudCliFullPriceSentence(view: Pick<CloudAdsView, "discountPct">): string {
  return view.discountPct > 0
    ? `CLI sessions use the full price. Chats cost ${view.discountPct}% less with ads.`
    : "CLI sessions use the full price. Small computers are free only in chats with ads.";
}

/** The line in an automation's form when it runs on a cloud computer while ads are on. */
export function cloudAutomationFullPriceSentence(view: Pick<CloudAdsView, "discountPct">): string {
  return view.discountPct > 0
    ? `Automations use the full price. Chats cost ${view.discountPct}% less with ads.`
    : "Automations use the full price. Small computers are free only in chats with ads.";
}

/**
 * Whether the full-price notices show: ads are on for the account here, and
 * there is a cheaper price to lose (a discount, or Free's free Small).
 */
export function cloudFullPriceNoticeShows(view: CloudAdsView | null): view is CloudAdsView {
  return Boolean(view && view.on && view.available && (view.discountPct > 0 || view.freePlan));
}

/**
 * How long `leftMilli` lasts at a size, both ways, in the website's form:
 * "up to 62 hours on a Medium with ads · 50 with no ads" while ads are on;
 * "50 hours on a Medium" otherwise. "Up to": CLI sessions and automations use
 * the full price. `label` is the size with its article ("a Medium").
 */
export function cloudHoursBothText(leftMilli: number, pair: CloudRatePair, view: CloudAdsView | null, label: string, first = true): string {
  const hoursAt = (rate: number) => {
    const hours = Math.max(0, leftMilli) / rate;
    return (hours >= 10 ? Math.floor(hours) : Math.floor(hours * 10) / 10).toLocaleString("en-US");
  };
  const full = hoursAt(pair.fullMilli);
  const fullText = first ? `${full} ${full === "1" ? "hour" : "hours"} on ${label}` : `${full} on ${label}`;
  const ad = pair.adMilli;
  if (!view || !view.on || !view.available || ad == null || ad <= 0 || ad >= pair.fullMilli) return fullText;
  const withAds = hoursAt(ad);
  return `up to ${withAds}${first ? ` ${withAds === "1" ? "hour" : "hours"}` : ""} on ${label} with ads · ${full} with no ads`;
}

/**
 * The cloud iPhone's price under Pricing v3: while a phone runs, what it costs
 * now (`pricing.phone`) and the full-price reason; otherwise the catalog's two
 * prices a minute. Null without Pricing v3 (today's words stay).
 */
export function cloudPhonePriceWords(
  account: (Pick<CloudAccountState, "plan"> & { pricing?: CloudPricingState | null; catalog?: CloudAccountState["catalog"] }) | null | undefined,
  words: CloudUnitWords,
  live: boolean,
): { text: string; reason: string | null } | null {
  const pricing = cloudPricingOf(account);
  if (!pricing) return null;
  const view = cloudAdsViewOf(account);
  const now = live ? pricing.phone : null;
  if (now) return { text: cloudPriceNowText(now, view, words, "minute"), reason: cloudFullPriceReasonLine(now, view) };
  const phone = account?.catalog?.phone;
  if (!phone) return null;
  return { text: cloudRateText({ fullMilli: phone.milliPerMinute, adMilli: phone.adMilliPerMinute }, view, words, "minute"), reason: null };
}
