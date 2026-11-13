/**
 * Finds a sign-in / verification code in an incoming text message.
 *
 * This is a heuristic, not an oracle: texts are written by thousands of
 * senders, so the parser masks the spans that are definitely not a code (prices,
 * phone numbers, dates, times, years), then scores every 4-8 digit candidate by
 * how close it sits to a code-shaped keyword. A short alphanumeric code is
 * accepted only when a keyword is near, because `COVID19` and flight numbers
 * live in the same shape.
 *
 * Privacy: this module receives and returns message text. It must never log,
 * report or otherwise persist what it is given; callers pass the code to the
 * person or the agent, never to telemetry.
 *
 * @module messages/messageCodes
 */

export type ExtractedSignInCode = {
  readonly code: string;
  /**
   * 0-1 confidence. High when a strong keyword ("verification code", "OTP",
   * "passcode") sits next to the candidate, lower for a bare number that merely
   * passed the exclusion rules.
   */
  readonly confidence: number;
};

type Keyword = {
  readonly start: number;
  readonly end: number;
  /** 2 = strongly code-shaped, 1 = generic ("code", "PIN", "verify"). */
  readonly strength: 1 | 2;
};

type Candidate = {
  readonly code: string;
  readonly start: number;
  readonly end: number;
  readonly alphanumeric: boolean;
};

const STRONG_KEYWORD_PATTERNS: readonly RegExp[] = [
  /\b(?:verification|security|confirmation|authentication|auth|login|log-in|sign-in|signin)\s+(?:code|pin)\b/gi,
  /\bone[-\s]?time\s+(?:passcode|code|password)\b/gi,
  /\bpasscode\b/gi,
  /\botp\b/gi,
  /\b2fa\b/gi,
  /\btwo[-\s]?factor\b/gi,
];

const MEDIUM_KEYWORD_PATTERNS: readonly RegExp[] = [
  /\bcode\b/gi,
  /\bpin\b/gi,
  /\bverify\b/gi,
  /\bverification\b/gi,
  /\bsign[-\s]?in\b/gi,
  /\blog[-\s]?in\b/gi,
  /\blogin\b/gi,
];

/**
 * Number-shaped contexts that are not a sign-in code. A negative beats a
 * positive keyword when it touches the candidate more closely — or equally, as
 * in "postal code", where both are the same word away.
 */
const NEGATIVE_KEYWORD_PATTERNS: readonly RegExp[] = [
  /\bpostal\s+code\b/gi,
  /\bzip\s+code\b/gi,
  /\bzip\b/gi,
  /\border\b/gi,
  /\binvoice\b/gi,
  /\breceipt\b/gi,
  /\btotal\b/gi,
  /\bamount\b/gi,
  /\btracking\b/gi,
  /\bshipping\b/gi,
  /\bconfirmation\s+number\b/gi,
  /\baccount\s+(?:number|no\.?|#)/gi,
  /\brouting\s+(?:number|no\.?|#)/gi,
  /\bcard\s+(?:number|no\.?|#)/gi,
  /\bending\s+(?:in|with)\b/gi,
  /\bapt\b/gi,
  /\bsuite\b/gi,
  /\bseat\b/gi,
  /\bgate\b/gi,
  /\bflight\b/gi,
  /\breservation\b/gi,
];

/**
 * Spans that can never contain a code. Each replacement keeps the string's
 * length so positions stay comparable with the original text.
 */
const MASK_PATTERNS: readonly RegExp[] = [
  // "$1234.00", "$1,234"
  /\$\s*\d[\d,]*(?:\.\d{1,2})?/g,
  // "1234.00 USD", "52 dollars"
  /\b\d[\d,]*(?:\.\d{1,2})?\s*(?:usd|dollars?|eur|euros?|gbp|pounds?)\b/gi,
  // Any decimal. A code is not written with a decimal point.
  /\b\d+[.,]\d+\b/g,
  // ISO and slash dates, with or without a year.
  /\b\d{4}-\d{1,2}-\d{1,2}\b/g,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,
  // "Nov 13", "November 13, 2026"
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b/gi,
  // "10:30", "4:05pm"
  /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?/gi,
  // "555-123-4567", "(555) 123-4567", "+1 555 123 4567"
  /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}\b/g,
  // "555-1234"
  /\b\d{3}[-.]\d{4}\b/g,
  // Years. A bare 4-digit year is a date, not a code.
  /\b(?:19|20)\d{2}\b/g,
];

/** Replaces every masked span with spaces, preserving indices. */
function maskNonCodeSpans(text: string): string {
  let masked = text;
  for (const pattern of MASK_PATTERNS) {
    masked = masked.replace(pattern, (match) => " ".repeat(match.length));
  }
  return masked;
}

function collectKeywords(text: string): Keyword[] {
  const keywords: Keyword[] = [];
  const collect = (patterns: readonly RegExp[], strength: 1 | 2): void => {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        if (match.index === undefined || match[0].length === 0) continue;
        keywords.push({ start: match.index, end: match.index + match[0].length, strength });
      }
    }
  };
  collect(STRONG_KEYWORD_PATTERNS, 2);
  collect(MEDIUM_KEYWORD_PATTERNS, 1);
  // A later strong hit must survive even when an earlier weak hit covers the
  // same words; the distance comparison sorts that out, so no dedupe is needed.
  return keywords;
}

function collectCandidates(original: string, masked: string): Candidate[] {
  const candidates: Candidate[] = [];

  // Grouped codes: "482 913" and "482-913".
  for (const match of masked.matchAll(/\b\d{3}[ -]\d{3}\b/g)) {
    if (match.index === undefined) continue;
    candidates.push({
      code: match[0].replace(/\D/g, ""),
      start: match.index,
      end: match.index + match[0].length,
      alphanumeric: false,
    });
  }

  for (const match of masked.matchAll(/\b\d{4,8}\b/g)) {
    if (match.index === undefined) continue;
    candidates.push({
      code: match[0],
      start: match.index,
      end: match.index + match[0].length,
      alphanumeric: false,
    });
  }

  // Alphanumeric codes are considered only against untouched text: a span the
  // maskers already claimed (a phone number, a date) cannot also be a code.
  for (const match of original.matchAll(/\b[A-Za-z0-9]{5,8}\b/g)) {
    if (match.index === undefined) continue;
    const value = match[0];
    if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) continue;
    const start = match.index;
    const end = start + value.length;
    if (masked.slice(start, end) !== value) continue;
    candidates.push({
      code: value.toUpperCase(),
      start,
      end,
      alphanumeric: true,
    });
  }

  return candidates;
}

function distanceTo(candidate: Candidate, keyword: Keyword): number {
  if (candidate.start >= keyword.end) return candidate.start - keyword.end;
  if (candidate.end <= keyword.start) return keyword.start - candidate.end;
  return 0;
}

function nearest(
  candidate: Candidate,
  keywords: readonly Keyword[],
): { keyword: Keyword; distance: number } | null {
  let best: { keyword: Keyword; distance: number } | null = null;
  for (const keyword of keywords) {
    const distance = distanceTo(candidate, keyword);
    if (
      best === null
      || distance < best.distance
      || (distance === best.distance && keyword.strength > best.keyword.strength)
    ) {
      best = { keyword, distance };
    }
  }
  return best;
}

function confidenceFor(candidate: Candidate, keyword: Keyword | null, distance: number): number {
  if (keyword === null) {
    // A bare 4-digit number is too often a year, an amount, or a count; 5-8
    // digits is the shape people actually read as a code.
    return candidate.code.length >= 5 ? 0.5 : 0.4;
  }

  const base = keyword.strength === 2
    ? (candidate.alphanumeric ? 0.9 : 0.95)
    : (candidate.alphanumeric ? 0.8 : 0.85);
  const proximityPenalty = distance <= 24 ? 0 : distance <= 60 ? 0.05 : 0.15;
  const groupingBonus = !candidate.alphanumeric && /^\d{6}$/.test(candidate.code) && distance <= 60 ? 0.03 : 0;
  return Math.max(0, Math.min(1, base - proximityPenalty + groupingBonus));
}

/**
 * Returns the most likely sign-in code in `text`, or null when nothing passes
 * the exclusions. The returned code is digits only for numeric candidates (the
 * separators in "482 913" are punctuation, not part of the code), uppercased
 * for alphanumeric candidates.
 */
/**
 * A shopping text ("Use code SAVE20 at checkout", "your discount code") is
 * never a sign-in code, unless it also says plainly that it is one.
 */
const SHOPPING_TEXT = /\b(?:promo|promotion(?:al)?|coupon|discount|voucher|referral|gift\s*card|checkout|\d{1,2}\s?%\s?off)\b/i;
const SIGN_IN_TEXT = /\b(?:verif(?:y|ication)|one[-\s]?time|otp|passcode|sign[-\s]?in|log[-\s]?in|login|authenticat(?:e|ion)|security\s+code|2fa|two[-\s]?factor)\b/i;

export function extractSignInCode(text: string | null | undefined): ExtractedSignInCode | null {
  if (typeof text === "string" && SHOPPING_TEXT.test(text) && !SIGN_IN_TEXT.test(text)) return null;
  if (!text) return null;
  const original = text;
  if (original.trim() === "") return null;

  const masked = maskNonCodeSpans(original);
  // Keyword positions must be read from the same-index original; masking only
  // touches digits and punctuation, so an index from `original` matches both.
  const positiveKeywords = collectKeywords(original);

  const negatives: Keyword[] = [];
  for (const pattern of NEGATIVE_KEYWORD_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of original.matchAll(pattern)) {
      if (match.index === undefined || match[0].length === 0) continue;
      negatives.push({ start: match.index, end: match.index + match[0].length, strength: 1 });
    }
  }

  const candidates = collectCandidates(original, masked);
  if (candidates.length === 0) return null;

  let best: { candidate: Candidate; confidence: number; distance: number } | null = null;
  for (const candidate of candidates) {
    const positive = nearest(candidate, positiveKeywords);
    if (candidate.alphanumeric && positive === null) continue;

    const negative = nearest(candidate, negatives);
    // "postal code" puts a positive and a negative at the same distance; the
    // negative wins that tie so a ZIP is never reported as a sign-in code.
    if (negative !== null && (positive === null || negative.distance <= positive.distance)) continue;

    const distance = positive?.distance ?? Number.MAX_SAFE_INTEGER;
    const confidence = confidenceFor(candidate, positive?.keyword ?? null, distance);
    if (
      best === null
      || confidence > best.confidence
      || (confidence === best.confidence && distance < best.distance)
    ) {
      best = { candidate, confidence, distance };
    }
  }

  return best === null ? null : { code: best.candidate.code, confidence: best.confidence };
}
