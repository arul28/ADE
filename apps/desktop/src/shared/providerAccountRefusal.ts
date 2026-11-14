import { isUsageLimitFailureText } from "./usageLimitResumePresentation";

/**
 * A provider failure that is the person's account, not a broken agent:
 *
 * - `plan`: the provider is signed in, but the plan does not include this
 *   (Kimi's "subscription does not have access to Kimi Code", Cursor's
 *   `plan_required`). Signing in again does not help.
 * - `auth`: the sign-in is missing, expired or refused (a 401, an invalid
 *   token, "authentication failed" in any of the providers' languages).
 * - `model`: the provider does not serve this model for this account.
 *
 * These surfaces read their plan and model verdicts from this table: the
 * chat card (`decorateAgentCliError`), the tracked CLI card's plan veto
 * (`classifyAgentCliError`), provider health, and the failed turn's
 * `error_kind`. Sign-in words also live in `isAcpAuthError` (the ACP probe).
 * Only the verdict leaves; never the text.
 */
export type ProviderAccountRefusal = "plan" | "auth" | "model";

/**
 * Checked first: a plan refusal often also says "authentication required"
 * and carries a 403 (Kimi's), and sending that person to sign in again is
 * the wrong fix.
 */
const PLAN_REFUSAL = new RegExp([
  String.raw`\bplan_required\b`,
  // The subject must be the plan: "You don't have access to this repository"
  // is a file or GitHub refusal, not the provider's plan.
  String.raw`\b(?:subscription|plan|tier)\b[^\n]{0,40}\b(?:does not|doesn't|do not|don't) (?:have|include|grant) access to\b`,
  String.raw`\bnot available (?:for|on|to) (?:free|your current|your) (?:users|plan|tier|account|subscription)\b`,
  // The plan must be named: a usage limit says "Upgrade to Pro or try again
  // later", and that is a limit that resets, not a plan refusal.
  String.raw`\bupgrade (?:your |to (?:an? )?)?(?:\w+ )?(?:plan|subscription|tier)\b`,
  String.raw`\bnot included in your (?:plan|subscription)\b`,
  String.raw`\brequires? an? (?:paid|pro|higher|premium) (?:plan|subscription|tier|account)\b`,
].join("|"), "i");

/** A model the provider does not serve to this account. */
const MODEL_REFUSAL = new RegExp([
  String.raw`\bmodel_not_found\b`,
  String.raw`\bmodel\b[^\n]{0,80}\bis not supported when using\b`,
  String.raw`\b(?:unknown|invalid|unsupported) model\b`,
  String.raw`\bmodel\b[^\n]{0,60}\b(?:does not exist|not found|is not available for your)\b`,
].join("|"), "i");

/**
 * A sign-in the provider refused. A bare 401/403 is not enough (a 403 is as
 * often a plan or region refusal, and a number can be a line number): it
 * must sit next to a status word or an auth phrase.
 */
const AUTH_REFUSAL = new RegExp([
  String.raw`\b(?:not logged in|not signed in|not authenticated|unauthenticated|unauthori[sz]ed)\b`,
  String.raw`\bauthentication (?:failed|required|error)\b`,
  String.raw`\b(?:login|sign[- ]in) required\b`,
  String.raw`\bplease (?:log|sign) in\b`,
  String.raw`\binvalid (?:api[ _-]?key|authori[sz]ation token|auth(?:entication)? token|access token|bearer token|credentials?)\b`,
  String.raw`\b(?:token|credentials?|session token|api key) (?:has |have |is )?(?:expired|revoked)\b`,
  String.raw`\b(?:status(?:\s+code)?|http(?:\s+status)?|error|failed)\s*[:=]?\s*\(?401\b`,
  String.raw`\b401\s*(?:unauthori[sz]ed|:\s*\{)`,
  // Chinese providers (GLM, Kimi, Qwen endpoints) answer in Chinese.
  String.raw`身份验证失败|认证失败|鉴权失败|未登录|令牌无效`,
].join("|"), "i");

/** What a provider failure's own words say about the person's account; null when they say nothing. */
export function classifyProviderAccountRefusal(
  ...texts: Array<string | null | undefined>
): ProviderAccountRefusal | null {
  const text = texts.filter((value): value is string => typeof value === "string" && value.length > 0).join("\n");
  if (!text.trim()) return null;
  // A usage limit often offers an upgrade too. It keeps its own card, its
  // reset time and its auto-resume, so it is never a plan refusal.
  if (PLAN_REFUSAL.test(text) && !isUsageLimitFailureText(text)) return "plan";
  if (MODEL_REFUSAL.test(text)) return "model";
  if (AUTH_REFUSAL.test(text)) return "auth";
  return null;
}

/**
 * Whether the words are a refused sign-in, read on their own. The verdict
 * above puts plan and model first; a caller that only asks "is this a
 * sign-in failure" reads this.
 */
export function isProviderAuthRefusalText(text: string): boolean {
  return AUTH_REFUSAL.test(text);
}
