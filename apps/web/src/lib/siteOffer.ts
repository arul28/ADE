/**
 * What the account server offers a visitor to the website: whether Pricing v3
 * is on for everyone (`pricing_v3` is `all`), whether the cloud Mac is open to
 * everyone (`mac_computers` is `all`), and whether this visitor's country has
 * the ad price (and if so whether ads start on there, and the discount). The
 * server decides all of it from its own switches and the request's country
 * (`GET /public/pricing`); the site only shows the answer.
 *
 * One request per page load, sent when this module loads, so it runs beside
 * the page's own download. Until it answers, and whenever it fails, the site
 * shows today's prices: an unknown answer is the switch at `off`.
 */
import { useSyncExternalStore } from "react";

export type SiteAds = {
  /** Ads start on for a new account here (the US outside California, without Global Privacy Control). */
  startsOn: boolean;
  /** How much less DAEX Cloud costs with ads on, in percent (`ad_discount_pct`). */
  discountPct: number;
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

const DEFAULT_ACCOUNT_DIRECTORY = "https://ade-account-directory-production.arulsharma1028.workers.dev";
const ACCOUNT_DIRECTORY =
  ((import.meta.env.VITE_ADE_ACCOUNT_DIRECTORY_URL as string | undefined)?.trim() || DEFAULT_ACCOUNT_DIRECTORY).replace(/\/+$/, "");

/** Reads the server's answer; anything it does not recognise is `off`. */
export function parseSiteOffer(body: unknown): SiteOffer {
  if (!body || typeof body !== "object") return OFF;
  const raw = body as { pricingV3?: unknown; mac?: unknown; ads?: unknown };
  if (raw.pricingV3 !== true) return OFF;
  const ads = raw.ads as { startsOn?: unknown; discountPct?: unknown } | null | undefined;
  const pct = ads && typeof ads === "object" ? ads.discountPct : null;
  const validAds = typeof pct === "number" && Number.isInteger(pct) && pct > 0 && pct < 100;
  return {
    v3: true,
    mac: raw.mac === true,
    ads: validAds ? { startsOn: ads!.startsOn === true, discountPct: pct } : null,
  };
}

/**
 * The local preview: `?offer=us`, `ca` or `world` (and `&mac=1`) shows Pricing
 * v3 as that visitor would see it, and `?offer=off` today's site. Only in
 * `vite dev`; a built site always asks the server.
 */
function previewOffer(): SiteOffer | null {
  if (!import.meta.env.DEV || typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const offer = params.get("offer");
  if (!offer) return null;
  const mac = params.get("mac") === "1";
  if (offer === "us") return { v3: true, mac, ads: { startsOn: true, discountPct: 20 } };
  if (offer === "ca") return { v3: true, mac, ads: { startsOn: false, discountPct: 20 } };
  if (offer === "world") return { v3: true, mac, ads: null };
  return OFF;
}

let current: SiteOffer = OFF;
const listeners = new Set<() => void>();

function publish(next: SiteOffer): void {
  current = next;
  adsOn = next.v3 && next.ads ? next.ads.startsOn : false;
  for (const listener of listeners) listener();
}

function load(): void {
  if (typeof window === "undefined" || typeof fetch !== "function") return;
  const preview = previewOffer();
  if (preview) {
    publish(preview);
    return;
  }
  const controller = new AbortController();
  // A slow answer is no answer: the page keeps today's prices.
  const timer = window.setTimeout(() => controller.abort(), 4000);
  fetch(`${ACCOUNT_DIRECTORY}/public/pricing`, { credentials: "omit", signal: controller.signal })
    .then((response) => (response.ok ? response.json() : null))
    .then((body) => {
      const offer = parseSiteOffer(body);
      if (offer.v3) publish(offer);
    })
    .catch(() => {})
    .finally(() => window.clearTimeout(timer));
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The server's offer for this visitor; `{ v3: false }` until it answers. */
export function useSiteOffer(): SiteOffer {
  return useSyncExternalStore(subscribe, () => current, () => OFF);
}

/**
 * The "With ads / No ads" control's position, one for the whole visit, so the
 * home page and `/pricing` agree. It starts where ads start for this region.
 */
let adsOn = false;

export function setAdsOn(value: boolean): void {
  if (adsOn === value) return;
  adsOn = value;
  for (const listener of listeners) listener();
}

/** Whether the visitor has the control on "With ads". Always false where the country has no ads. */
export function useAdsOn(): boolean {
  const offer = useSiteOffer();
  const on = useSyncExternalStore(subscribe, () => adsOn, () => false);
  return offer.v3 && offer.ads != null && on;
}

load();
