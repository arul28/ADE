import { CLOUD_CREDIT_UNIT_SENTENCE, type CloudAccountState } from "../../../account-directory/src/cloud/contract";

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
  /** A size's rate as a line: "Never uses your credits", "1 hour of work uses 2.5 credits". */
  rateLine: (rate: number) => string;
  /** "Extra credits": the paid plan's switch past the plan. */
  extra: "Extra credits";
  /** "a credit": what one extra unit is priced per ("2¢ a credit"). */
  perUnit: "a credit";
  /** What one credit is (`CLOUD_CREDIT_UNIT_SENTENCE`). */
  unitSentence: string;
  /** Thousandths of a credit the iPhone uses a minute. */
  phoneMilliPerMinute: number;
};

/**
 * "1,600", "299.8" or "49.5" credits from thousandths: whole ones plainly,
 * any other value to the tenth, rounded down at every size. So 299.8 left of
 * 300 reads "299.8", never "299" (one used that wasn't) or "300" (none
 * used). Integer tenths, so 0.3 never prints as 0.2 through float error. The
 * CLI (`cloudHoursText`) and the phone (`cloudHours`) write it the same way.
 * `adeCloud.ts` re-exports it.
 */
export function formatCloudHours(milli: number): string {
  const tenths = Math.floor(Math.max(0, Number.isFinite(milli) ? milli : 0) / 100);
  return (tenths / 10).toLocaleString("en-US", { maximumFractionDigits: 1 });
}

const plain = (value: number): string => Number(value.toFixed(2)).toLocaleString("en-US");

/** The iPhone's rate when the account is not read yet: one credit a minute. */
const DEFAULT_PHONE_MILLI_PER_MINUTE = 1000;

function wordsFor(phoneMilliPerMinute: number): CloudUnitWords {
  const count = (value: number) => `${plain(value)} ${value === 1 ? "credit" : "credits"}`;
  const milli = (value: number) => {
    const shown = formatCloudHours(value);
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
    rateLine: (rate) => (rate > 0 ? `1 hour of work uses ${count(rate)}` : "Never uses your credits"),
    extra: "Extra credits",
    perUnit: "a credit",
    unitSentence: CLOUD_CREDIT_UNIT_SENTENCE,
    phoneMilliPerMinute,
  };
}

/** The words before the account is read: credits at the iPhone's usual rate. */
export const CLOUD_CREDIT_WORDS: CloudUnitWords = wordsFor(DEFAULT_PHONE_MILLI_PER_MINUTE);

/** The words for this account, with the iPhone's rate the server sends (`credits.phoneMilliPerMinute`). */
export function cloudUnitWords(account: Pick<CloudAccountState, "credits"> | null | undefined): CloudUnitWords {
  const perMinute = account?.credits?.phoneMilliPerMinute;
  if (perMinute == null || !Number.isFinite(perMinute) || perMinute <= 0 || perMinute === DEFAULT_PHONE_MILLI_PER_MINUTE) return CLOUD_CREDIT_WORDS;
  return wordsFor(perMinute);
}
