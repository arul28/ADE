import { CLOUD_CREDIT_UNIT_SENTENCE, type CloudAccountState, type CloudPricingState } from "../../../account-directory/src/cloud/contract";

/**
 * The words for ADE Cloud's balance: credits, one balance the ADE Cloud
 * iPhone draws from too (`CloudAccountState.credits`). The numbers are
 * thousandths; a Medium computer uses one credit an hour. Every surface reads
 * them here instead of writing its own.
 */
export type CloudUnitWords = {
  /** "credits". */
  noun: "credits";
  /** "Credits", to start a label. */
  Noun: "Credits";
  /** "credit". */
  one: "credit";
  /** "1 credit", "2.5 credits": a plain count. */
  count: (value: number) => string;
  /** "418 credits", from thousandths. */
  milli: (milli: number) => string;
  /** "418 credits": the compact form beside a meter. */
  short: (milli: number) => string;
  /** A size's rate in words, lowercase: "uses no credits", "uses 2.5 credits an hour". */
  rate: (rate: number) => string;
  /** A size's rate, short and lowercase, for a before → after line: "0 credits an hour", "1 credit an hour", "2.5 credits an hour". */
  hourly: (rate: number) => string;
  /** A size's rate as a line: "Never uses your credits", "1 hour of work uses 2.5 credits". */
  rateLine: (rate: number) => string;
  /** "Extra credits": the paid plan's switch past the plan. */
  extra: "Extra credits";
  /** "a credit": what one extra unit is priced per ("2¢ a credit"). */
  perUnit: "a credit";
  /** What one credit is (`CLOUD_CREDIT_UNIT_SENTENCE`); empty under Pricing v3, where the rates table says it. */
  unitSentence: string;
  /** Thousandths of a credit the iPhone uses a minute. */
  phoneMilliPerMinute: number;
  /**
   * The shown credits in one Medium-hour unit (1,000 thousandths): 1 before
   * Pricing v3, the server's `creditScale` (10) under it. Never a constant of
   * the app: `cloudUnitWords` reads it from the account.
   */
  scale: number;
  /** "4,180", "299.8": the shown number of credits from thousandths, at `scale`. */
  num: (milli: number) => string;
  /** "$4 for 1,000 credits" under Pricing v3, else "2¢ a credit": one extra credit's price from cents a Medium-hour unit. */
  extraPrice: (centsPerUnit: number) => string;
};

/**
 * "1,600", "299.8" or "49.5" credits from thousandths: whole ones plainly,
 * any other value to the tenth, rounded down at every size. So 299.8 left of
 * 300 reads "299.8", never "299" (one used that wasn't) or "300" (none
 * used). Integer tenths, so 0.3 never prints as 0.2 through float error. The
 * CLI (`cloudHoursText`) and the phone (`cloudHours`) write it the same way.
 * `adeCloud.ts` re-exports it.
 */
export function formatCloudHours(milli: number, scale = 1): string {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  // Pricing v3 (a scale other than 1): balances and used amounts are whole credits, rounded down. Rates keep
  // their exact value (`count`). A legend whose parts must add up uses `cloudWholeParts`.
  if (safeScale !== 1) {
    return Math.floor((Math.max(0, Number.isFinite(milli) ? milli : 0) * safeScale) / 1000).toLocaleString("en-US");
  }
  // Integer math first: milli x scale stays whole, so 1,000 x 10 never drifts below 10,000.
  const tenths = Math.floor((Math.max(0, Number.isFinite(milli) ? milli : 0) * safeScale) / 100);
  return (tenths / 10).toLocaleString("en-US", { maximumFractionDigits: 1 });
}

/**
 * Pricing v3: parts of one total (a balance's used and left) as whole shown
 * credits that add up to the total's whole credits, by largest remainder.
 * Thousandths in, thousandths out (each a whole credit at `scale`). At scale
 * 1 the parts come back as they are.
 */
export function cloudWholeParts(parts: readonly number[], scale: number): number[] {
  if (!Number.isFinite(scale) || scale <= 0 || scale === 1) return [...parts];
  const unit = 1000 / scale;
  const safe = parts.map((part) => Math.max(0, Number.isFinite(part) ? part : 0));
  const total = Math.floor(safe.reduce((sum, part) => sum + part, 0) / unit + 1e-9);
  const floors = safe.map((part) => Math.floor(part / unit + 1e-9));
  let short = total - floors.reduce((sum, part) => sum + part, 0);
  const order = safe.map((part, index) => ({ index, rest: part / unit - floors[index]! })).sort((a, b) => b.rest - a.rest);
  for (const { index } of order) {
    if (short <= 0) break;
    floors[index]! += 1;
    short -= 1;
  }
  return floors.map((whole) => whole * unit);
}

const plain = (value: number): string => Number(value.toFixed(2)).toLocaleString("en-US");

/** The iPhone's rate when the account is not read yet: one credit a minute. */
const DEFAULT_PHONE_MILLI_PER_MINUTE = 1000;

function wordsFor(phoneMilliPerMinute: number, scale = 1): CloudUnitWords {
  // `value` is in Medium-hour units (thousandths / 1000); the shown count is that x the scale.
  const count = (value: number) => {
    const shown = Number((value * scale).toFixed(2));
    return `${plain(shown)} ${shown === 1 ? "credit" : "credits"}`;
  };
  const num = (value: number) => formatCloudHours(value, scale);
  const milli = (value: number) => {
    const shown = num(value);
    return `${shown} ${shown === "1" ? "credit" : "credits"}`;
  };
  return {
    noun: "credits",
    Noun: "Credits",
    one: "credit",
    count,
    milli,
    short: milli,
    rate: (rate) => (rate > 0 ? `uses ${count(rate)} an hour` : "uses no credits"),
    hourly: (rate) => `${count(rate > 0 ? rate : 0)} an hour`,
    rateLine: (rate) => (rate > 0 ? `1 hour of work uses ${count(rate)}` : "Never uses your credits"),
    extra: "Extra credits",
    perUnit: "a credit",
    // Pricing v3 has no such sentence: "Sizes and prices" (the CLI's size rows) is the home of each rate.
    unitSentence: scale === 1 ? CLOUD_CREDIT_UNIT_SENTENCE : "",
    phoneMilliPerMinute,
    scale,
    num,
    extraPrice: (cents) => {
      if (scale === 1) return `${Number(cents.toFixed(2))}¢ a credit`;
      // Cents a Medium-hour unit -> dollars for 1,000 shown credits.
      const dollars = Number(((cents * 1000) / scale / 100).toFixed(2));
      return `$${dollars.toLocaleString("en-US")} for 1,000 credits`;
    },
  };
}

/** The words before the account is read: credits at the iPhone's usual rate. */
export const CLOUD_CREDIT_WORDS: CloudUnitWords = wordsFor(DEFAULT_PHONE_MILLI_PER_MINUTE);

/**
 * The credit scale the server sends with Pricing v3 (`pricing.creditScale`),
 * or 1 when it sends none (Pricing v3 doesn't reach the account): then every
 * number is today's.
 */
export function cloudCreditScaleOf(account: { pricing?: Pick<CloudPricingState, "creditScale"> | null } | null | undefined): number {
  const scale = account?.pricing?.creditScale;
  return typeof scale === "number" && Number.isFinite(scale) && scale > 0 ? scale : 1;
}

const wordsCache = new Map<string, CloudUnitWords>();

/**
 * The words for this account: the iPhone's rate the server sends
 * (`credits.phoneMilliPerMinute`) and, under Pricing v3, its credit scale.
 */
export function cloudUnitWords(
  account: (Pick<CloudAccountState, "credits"> & { pricing?: Pick<CloudPricingState, "creditScale"> | null }) | null | undefined,
): CloudUnitWords {
  const raw = account?.credits?.phoneMilliPerMinute;
  const perMinute = raw == null || !Number.isFinite(raw) || raw <= 0 ? DEFAULT_PHONE_MILLI_PER_MINUTE : raw;
  const scale = cloudCreditScaleOf(account);
  if (perMinute === DEFAULT_PHONE_MILLI_PER_MINUTE && scale === 1) return CLOUD_CREDIT_WORDS;
  const key = `${perMinute}:${scale}`;
  let words = wordsCache.get(key);
  if (!words) {
    words = wordsFor(perMinute, scale);
    wordsCache.set(key, words);
  }
  return words;
}
