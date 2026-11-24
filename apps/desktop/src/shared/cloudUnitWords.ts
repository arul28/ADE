import { CLOUD_CREDIT_UNIT_SENTENCE, CLOUD_HOUR_UNIT_SENTENCE, type CloudAccountState } from "../../../account-directory/src/cloud/contract";

/**
 * The words for ADE Cloud's balance: "hours", or "credits" once the account
 * server sends `CloudAccountState.credits` (one balance the ADE Cloud iPhone
 * draws from too). The numbers are the same either way (thousandths; a
 * Medium computer uses one an hour), so only the words change. Every surface
 * reads them here instead of branching on `account.credits` itself.
 */
export type CloudUnitWords = {
  /** Credits mode: one balance, and the iPhone uses it at `phoneMilliPerMinute`. */
  credits: boolean;
  /** "credits" | "hours". */
  noun: "credits" | "hours";
  /** "Credits" | "Hours", to start a label. */
  Noun: "Credits" | "Hours";
  /** "credit" | "hour". */
  one: "credit" | "hour";
  /** "1 credit", "2.5 credits", "1 hour": a plain count. */
  count: (value: number) => string;
  /** "418 credits", "418 hours", from thousandths. */
  milli: (milli: number) => string;
  /** "418 credits", "418 h": the compact form beside a meter. */
  short: (milli: number) => string;
  /** A size's rate in words, lowercase: "uses no credits", "uses 2.5 credits an hour". */
  rate: (rate: number) => string;
  /** A size's rate as a line: "Never uses your credits", "1 hour of work uses 2.5 credits". */
  rateLine: (rate: number) => string;
  /** "Extra credits" | "Extra hours": the paid plan's switch past the plan. */
  extra: "Extra credits" | "Extra hours";
  /** "a credit" | "an hour": what one extra unit is priced per ("2¢ a credit"). */
  perUnit: "a credit" | "an hour";
  /** What one unit is (`CLOUD_CREDIT_UNIT_SENTENCE` / `CLOUD_HOUR_UNIT_SENTENCE`). */
  unitSentence: string;
  /** Thousandths of a credit the iPhone uses a minute; null in hours mode (the iPhone has its own minutes). */
  phoneMilliPerMinute: number | null;
};

/**
 * "1,600", "299.8" or "49.5" hours (or credits) from thousandths: whole ones
 * plainly, any other value to the tenth, rounded down at every size. So 299.8
 * left of 300 reads "299.8", never "299" (one used that wasn't) or "300"
 * (none used). Integer tenths, so 0.3 never prints as 0.2 through float
 * error. The CLI (`cloudHoursText`) and the phone (`cloudHours`) write it the
 * same way. `adeCloud.ts` re-exports it.
 */
export function formatCloudHours(milli: number): string {
  const tenths = Math.floor(Math.max(0, Number.isFinite(milli) ? milli : 0) / 100);
  return (tenths / 10).toLocaleString("en-US", { maximumFractionDigits: 1 });
}

const plain = (value: number): string => Number(value.toFixed(2)).toLocaleString("en-US");

function wordsFor(credits: boolean, phoneMilliPerMinute: number | null): CloudUnitWords {
  const one = credits ? "credit" : "hour";
  const noun = credits ? "credits" : "hours";
  const count = (value: number) => `${plain(value)} ${value === 1 ? one : noun}`;
  return {
    credits,
    noun,
    Noun: credits ? "Credits" : "Hours",
    one,
    count,
    milli: (milli) => {
      const shown = formatCloudHours(milli);
      return `${shown} ${shown === "1" ? one : noun}`;
    },
    short: (milli) => {
      const shown = formatCloudHours(milli);
      return credits ? `${shown} ${shown === "1" ? "credit" : "credits"}` : `${shown} h`;
    },
    rate: (rate) => (rate > 0 ? `uses ${count(rate)} an hour` : `uses no ${noun}`),
    rateLine: (rate) => (rate > 0 ? `1 hour of work uses ${count(rate)}${credits ? "" : " of your plan"}` : `Never uses your ${noun}`),
    extra: credits ? "Extra credits" : "Extra hours",
    perUnit: credits ? "a credit" : "an hour",
    unitSentence: credits ? CLOUD_CREDIT_UNIT_SENTENCE : CLOUD_HOUR_UNIT_SENTENCE,
    phoneMilliPerMinute,
  };
}

/** Hours mode: what every surface said before credits, and what an account without `credits` still reads. */
export const CLOUD_HOURS_WORDS: CloudUnitWords = wordsFor(false, null);

/** The words for this account: credits when the server sends `credits`, else hours. */
export function cloudUnitWords(account: Pick<CloudAccountState, "credits"> | null | undefined): CloudUnitWords {
  const credits = account?.credits;
  if (!credits) return CLOUD_HOURS_WORDS;
  const perMinute = Number.isFinite(credits.phoneMilliPerMinute) && credits.phoneMilliPerMinute > 0 ? credits.phoneMilliPerMinute : 1000;
  return wordsFor(true, perMinute);
}
