import type { CloudSponsoredConsent } from "./contract";
import { settingChangedAt } from "./settings";
import type { CloudDb } from "./store";

// Who sees sponsored cards on ADE Cloud Free, and how they agreed: where cards
// start on with a notice instead of a question, how long a no holds, Global
// Privacy Control, and the second confirm after an opt-out. Pure rules over
// the account's answer (`cloud_sponsored_consent`) and where a request comes
// from; `gravity.ts` saves answers and acts on them.

/** What the consent rules read from the Worker's environment. */
export type SponsoredConsentEnv = CloudDb & {
  /** Where cards start on with a notice (`GravityEnv.GRAVITY_DEFAULT_ON_COUNTRIES`). */
  GRAVITY_DEFAULT_ON_COUNTRIES?: string;
};

/** How long a no to sponsored cards holds before the question comes back. */
const SPONSORED_REASK_MS = 14 * 24 * 60 * 60_000;
/**
 * How long a no given under US state privacy laws holds: California lets a
 * business ask a person who opted out of sharing to opt back in only after
 * 12 months (Civil Code 1798.135(c)(4)).
 */
const SPONSORED_OPT_OUT_HOLD_MS = 365 * 24 * 60 * 60_000;
/** Where cards start on unless `GRAVITY_DEFAULT_ON_COUNTRIES` says otherwise. */
const DEFAULT_ON_COUNTRIES = ["US"];
/**
 * Where US state privacy laws apply to the cards' data (a "sale" or
 * "sharing"): a no there holds 12 months, a yes after it takes a second
 * confirm, and Global Privacy Control is an opt-out for the whole account.
 * The law's, not a switch: unlike where cards start on, no variable moves it.
 */
const OPT_OUT_LAW_COUNTRIES = ["US"];
/**
 * States inside a starts-on country that are asked first (ISO 3166-2). In
 * California free Small computers for the cards are a financial incentive
 * (Civil Code 1798.125(b)), which needs the person's yes before it starts.
 */
const ASK_FIRST_REGIONS = ["US-CA"];

export const countryCodesOf = (value: string | undefined): string[] =>
  (value ?? "").split(",").map((code) => code.trim().toUpperCase()).filter((code) => /^[A-Z]{2}$/.test(code));

/** Where cards start on: the US unless the variable says otherwise; set and empty, nowhere. */
function startsOnCountriesOf(env: SponsoredConsentEnv): string[] {
  return env.GRAVITY_DEFAULT_ON_COUNTRIES === undefined ? DEFAULT_ON_COUNTRIES : countryCodesOf(env.GRAVITY_DEFAULT_ON_COUNTRIES);
}

/** Where a request comes from, as the consent rules read it: its country and state, and the browser's Global Privacy Control. */
export type SponsoredRequester = { country: string | null; region: string | null; gpc: boolean };

export function sponsoredRequester(request: Request | null): SponsoredRequester {
  const region = (request as (Request & { cf?: { regionCode?: unknown } }) | null)?.cf?.regionCode;
  return {
    country: request ? requestCountry(request) : null,
    region: typeof region === "string" && region.trim() ? region.trim().toUpperCase() : null,
    gpc: request?.headers.get("sec-gpc")?.trim() === "1",
  };
}

/**
 * The caller's country as Cloudflare sees it, or null when there is no
 * Cloudflare data (a test, a local run). A code that names no country (Tor's
 * "T1", "XX") is kept as it is, so the country check refuses it.
 */
export function requestCountry(request: Request): string | null {
  const country = (request as Request & { cf?: { country?: unknown } }).cf?.country;
  return typeof country === "string" && country.trim() ? country.trim().toUpperCase() : null;
}

/**
 * Whether cards start on for this person: told they are on and free to turn
 * them off, instead of asked first. Only in a country where that is the law's
 * way (opt-out), never from an unknown country or a state that is asked first
 * (`ASK_FIRST_REGIONS`; an unknown state there is asked too), and never when
 * the browser sends Global Privacy Control: that is an opt-out already, so
 * the person is asked instead.
 */
export function startsOnFor(env: SponsoredConsentEnv, who: SponsoredRequester): boolean {
  if (who.country == null || who.gpc || !startsOnCountriesOf(env).includes(who.country)) return false;
  const askFirst = ASK_FIRST_REGIONS.filter((code) => code.startsWith(`${who.country}-`));
  return askFirst.length === 0 || (who.region != null && !askFirst.includes(`${who.country}-${who.region}`));
}

/** Whether an answer given in this country falls under US state privacy laws' opt-out rules (`OPT_OUT_LAW_COUNTRIES`). */
const optOutCountry = (country: string | null): boolean => country != null && OPT_OUT_LAW_COUNTRIES.includes(country);

/** Whether this request's Global Privacy Control is an opt-out for the whole account: sent from where US law makes it one. */
export const gpcOptsOut = (who: SponsoredRequester): boolean => who.gpc && optOutCountry(who.country);

/**
 * The account's answer. `source`: the person's own (`answer`), the yes saved
 * with the notice that cards are on (`notice`), or the no a browser's Global
 * Privacy Control made (`gpc`). `gpc` 1: a yes given, past the second
 * confirm, from a US browser that sends the signal (it holds there).
 * `looked_at`: the last time the yes was given or a look found it holding
 * (Free's Small is free only while that is recent, `gravity.ts`
 * `SMALL_FREE_LOOK_MS`); null for a no.
 */
export type ConsentRow = {
  consent: CloudSponsoredConsent;
  email_hash: string | null;
  decided_at: number;
  source: "answer" | "notice" | "gpc";
  country: string | null;
  gpc: number;
  looked_at: number | null;
};

export async function readConsent(env: CloudDb, userId: string): Promise<ConsentRow | null> {
  return env.DB.prepare("select consent, email_hash, decided_at, source, country, gpc, looked_at from cloud_sponsored_consent where user_id = ?")
    .bind(userId).first<ConsentRow>();
}

/**
 * Whether this request's Global Privacy Control turns the account's answer
 * into a no (`gravity.ts` `honorGpc`): an opt-out (`gpcOptsOut`) over no
 * answer, or over a yes not given from such a browser. A yes given there,
 * after the second confirm, holds.
 */
export const gpcOverrides = (consent: ConsentRow | null, who: SponsoredRequester): boolean =>
  gpcOptsOut(who) && (consent == null || (consent.consent === "granted" && !consent.gpc));

/**
 * Whether this person is told cards are on (not asked): nothing to show yet,
 * they are where cards start on, and they never said no. Someone who said no
 * is asked when the no runs out, never turned back on by a notice.
 */
export const startsOnNow = (env: SponsoredConsentEnv, consent: ConsentRow | null, shown: CloudSponsoredConsent | null, who: SponsoredRequester): boolean =>
  shown === null && consent?.consent !== "declined" && startsOnFor(env, who);

/**
 * Whether the account's yes lets cards go to Gravity for this person now. An
 * answer always does; the yes saved with the notice only where cards start
 * on (the person travelled, or turned on Global Privacy Control: they are
 * asked first). Never over this request's Global Privacy Control
 * (`gpcOverrides`).
 */
export const yesHolds = (env: SponsoredConsentEnv, consent: ConsentRow | null, who: SponsoredRequester): consent is ConsentRow =>
  consent?.consent === "granted" && (consent.source !== "notice" || startsOnFor(env, who)) && !gpcOverrides(consent, who);

/**
 * Whether a yes now needs a second, separate confirm (`confirmYes`): no yes
 * holds, and the person opted out under US rules (a no given or read in the
 * US, or their browser's Global Privacy Control from the US): California's
 * two-step opt-in after an opt-out. Elsewhere a yes after a no is one click.
 * `PUT /consent` refuses a yes without `confirmed` then, so an app too old to
 * ask twice can't turn cards back on in one click.
 */
export const yesNeedsConfirm = (consent: ConsentRow | null, shown: CloudSponsoredConsent | null, who: SponsoredRequester): boolean =>
  shown !== "granted" && (
    (consent?.consent === "declined" && (optOutCountry(consent.country) || optOutCountry(who.country)))
    || gpcOptsOut(who)
  );

/**
 * The answer clients see: null when the person is to be asked (or told)
 * again. A no is asked again once it is SPONSORED_REASK_MS old, or when it
 * came before the ad switch last changed (when Small began to need cards);
 * a no given under US state privacy laws only after 12 months
 * (SPONSORED_OPT_OUT_HOLD_MS), whatever the switch did. Until the person
 * answers, it still counts as a no: no cards, Small uses credits.
 */
export async function shownAnswer(env: SponsoredConsentEnv, consent: ConsentRow | null, who: SponsoredRequester, now: number): Promise<CloudSponsoredConsent | null> {
  if (!consent) return null;
  if (consent.consent === "granted") return yesHolds(env, consent, who) ? "granted" : null;
  if (optOutCountry(consent.country)) return now - consent.decided_at >= SPONSORED_OPT_OUT_HOLD_MS ? null : "declined";
  const asked = now - consent.decided_at >= SPONSORED_REASK_MS || consent.decided_at < (await settingChangedAt(env, "gravity_ads") ?? 0);
  return asked ? null : "declined";
}
