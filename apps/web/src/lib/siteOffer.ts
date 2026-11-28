/**
 * What the account server offers a visitor to the website: whether Pricing v3
 * is on for everyone (`pricing_v3` is `all`), whether the cloud Mac is open to
 * everyone (`mac_computers` is `all`), and whether this visitor's country has
 * the ad price (and if so whether ads start on there, and the discount). The
 * server decides all of it from its own switches and the request's country
 * (`GET /public/pricing`); the site only shows the answer.
 *
 * One request per page load. On `/` and `/pricing` it starts in `index.html`
 * (`vite.config.ts`, `siteOfferEarlyScript`), beside the download of the
 * site's code; any other page asks only when a price first renders. Until
 * it answers, and whenever it fails, the site shows today's prices: an
 * unknown answer is the switch at `off`.
 */
import { useSyncExternalStore } from "react";
import { CLOUD_PUBLIC_PRICING_PATH, type CloudPublicPricing } from "../../../account-directory/src/cloud/contract";
import { AD_WINDOW_MINUTES_DEFAULT } from "../../../account-directory/src/cloud/plans";
import { accountDirectoryBase } from "./accountDirectory";

export type SiteAds = {
  /** Ads start on for a new account here (the US outside California, without Global Privacy Control). */
  startsOn: boolean;
  /** How much less DAEX Cloud costs with ads on, in percent (`ad_discount_pct`), 1 to 99. */
  discountPct: number;
  /** How long after the last use of a chat the ad price lasts (`ad_window_minutes`). */
  windowMinutes: number;
};

export type SiteOffer =
  | { v3: false }
  | {
      v3: true;
      /** The cloud Mac is open to every account. */
      mac: boolean;
      /** The ad price, only where the visitor's country has ads; null shows only full prices and no word about ads. */
      ads: SiteAds | null;
    };

const OFF: SiteOffer = { v3: false };

const ACCOUNT_DIRECTORY = accountDirectoryBase(import.meta.env.VITE_ADE_ACCOUNT_DIRECTORY_URL as string | undefined);

/**
 * Reads the server's answer (`CloudPublicPricing`); anything it does not
 * recognise is `off`. A discount of 0 is no ad price at all.
 */
export function parseSiteOffer(body: unknown): SiteOffer {
  if (!body || typeof body !== "object") return OFF;
  const raw = body as { [K in keyof Extract<CloudPublicPricing, { pricingV3: true }>]?: unknown };
  if (raw.pricingV3 !== true) return OFF;
  const ads = raw.ads && typeof raw.ads === "object" ? (raw.ads as { startsOn?: unknown; discountPct?: unknown; adWindowMinutes?: unknown }) : null;
  const pct = ads?.discountPct;
  const minutes = ads?.adWindowMinutes;
  const validAds = typeof pct === "number" && Number.isInteger(pct) && pct > 0 && pct < 100;
  return {
    v3: true,
    mac: raw.mac === true,
    ads: validAds
      ? {
          startsOn: ads!.startsOn === true,
          discountPct: pct,
          windowMinutes: typeof minutes === "number" && Number.isInteger(minutes) && minutes > 0 ? minutes : AD_WINDOW_MINUTES_DEFAULT,
        }
      : null,
  };
}

/**
 * The local preview: `?offer=us`, `ca` or `world` (and `&mac=1`, `&pct=`,
 * `&window=`) shows Pricing v3 as that visitor would see it, and `?offer=off`
 * today's site. Only in `vite dev`: a built site always asks the server, and
 * the build drops this code.
 */
function previewOffer(): SiteOffer | null {
  if (!import.meta.env.DEV) return null;
  const params = new URLSearchParams(window.location.search);
  const offer = params.get("offer");
  if (!offer) return null;
  if (offer === "off") return OFF;
  const ads = offer === "us" || offer === "ca"
    ? { startsOn: offer === "us", discountPct: Number(params.get("pct") ?? 20), adWindowMinutes: Number(params.get("window") ?? 60) }
    : null;
  return parseSiteOffer({ pricingV3: true, mac: params.get("mac") === "1", ads });
}

type State = { offer: SiteOffer; settled: boolean; adsOn: boolean };

let state: State = { offer: OFF, settled: false, adsOn: false };
const listeners = new Set<() => void>();

function update(next: Partial<State>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

/** Pages hold their prices at most this long for the answer, then show today's (`useSiteOfferSettled`). */
const HOLD_MS = 600;
/** A slower answer than this is no answer. */
const GIVE_UP_MS = 4000;

let started = false;

function start(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  const preview = previewOffer();
  if (preview) {
    settle(preview);
    return;
  }
  const early = (window as Window & { __daexSiteOffer?: Promise<unknown> }).__daexSiteOffer;
  const answer: Promise<unknown> = early ?? fetch(`${ACCOUNT_DIRECTORY}${CLOUD_PUBLIC_PRICING_PATH}`, { credentials: "omit" }).then((response) => (response.ok ? response.json() : null));
  const giveUp = new Promise<null>((resolve) => window.setTimeout(() => resolve(null), GIVE_UP_MS));
  window.setTimeout(() => {
    if (!state.settled) update({ settled: true });
  }, HOLD_MS);
  Promise.race([answer, giveUp])
    .then((body) => settle(parseSiteOffer(body)), () => settle(OFF));
}

function settle(offer: SiteOffer): void {
  update({ offer, settled: true, adsOn: offer.v3 && offer.ads ? offer.ads.startsOn : false });
}

const subscribe = (listener: () => void) => {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The server's offer for this visitor; `{ v3: false }` until it answers. */
export function useSiteOffer(): SiteOffer {
  return useSyncExternalStore(subscribe, () => state.offer, () => OFF);
}

/** Whether the answer is in, or the short hold for it is over. A page with prices at the top hides them until then. */
export function useSiteOfferSettled(): boolean {
  return useSyncExternalStore(subscribe, () => state.settled, () => true);
}

/**
 * The "With ads / No ads" control's position, one for the whole visit, so the
 * home page and `/pricing` agree. It starts where ads start for this region.
 */
export function setAdsOn(value: boolean): void {
  if (state.adsOn !== value) update({ adsOn: value });
}

/** Whether the visitor has the control on "With ads". Always false where the country has no ads. */
export function useAdsOn(): boolean {
  const offer = useSiteOffer();
  const on = useSyncExternalStore(subscribe, () => state.adsOn, () => false);
  return offer.v3 && offer.ads != null && on;
}
