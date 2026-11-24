import {
  CLOUD_PATHS,
  type CloudFreeUnlockResult,
  type CloudPaidPlanId,
  type CloudPlanCleanupPick,
  type CloudPlanId,
} from "../../../../../account-directory/src/cloud/contract";
import { readCloudPlanCleanup, type CloudAccountState, type CloudOpenCheckoutResult } from "../../../shared/adeCloud";
import { parseCodedErrorMessage } from "../../../shared/codedError";
import { isCloudPhoneProviderChoice, type CloudPhoneProviderChoice, type CloudPhoneProviderChoiceAnswer } from "../../../shared/cloudPhone";
import { captureError } from "../../../shared/sentry/capture";
import type { BrowserAccountClient } from "../account/client";
import { stashCloudLink, type WebCloudLink } from "../shell/cloudPlanLink";

/**
 * ADE Cloud's plan and billing in the web app: the same server calls the
 * desktop's main process makes (`cloudServerProvider.ts`), from this browser
 * with its own account token (`BrowserAccountClient.cloudRequest`). Stripe's
 * pages open in this tab and send the person back to the web app
 * (`returnTo: "web"`), which opens Settings › ADE Cloud.
 *
 * Account level: the plan is the account's, on no machine, so no pin and no
 * connected computer. The reads of the page itself still come from the
 * connected computer (`cloud.ts`).
 *
 * The server asks for no recent sign-in on these routes; any signed-in token
 * of the account works. A browser whose sign-in ended signs in again and
 * comes back to the page (a checkout to its plan's checkout).
 */

export type CloudBillingAccountClient = Pick<BrowserAccountClient, "cloudRequest" | "startSignIn" | "getSnapshot">;

/**
 * The server's access answer, kept a minute per browser account: every
 * ADE Cloud surface asks on mount and on window focus, and each machine's
 * adapter has its own namespace. The server's own answer changes rarely.
 */
const ACCESS_CACHE_MS = 60_000;
/** The server's access answer: on or off, and its sentence when off. */
export type WebCloudAccessAnswer = { enabled: boolean; reason: string | null };

const accessCache = new WeakMap<object, { at: number; userId: string | null; answer: Promise<WebCloudAccessAnswer> }>();

function accessAnswerOf(body: unknown): WebCloudAccessAnswer {
  const value = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  const enabled = value?.enabled === true;
  const reason = !enabled && typeof value?.reason === "string" ? value.reason.trim().slice(0, 500) : "";
  return { enabled, reason: reason || null };
}

const UNREACHABLE = "ADE couldn't reach ADE Cloud. Try again in a moment.";
const BAD_ANSWER = "ADE Cloud answered with something ADE could not read.";
const SIGN_IN_AGAIN = "Your ADE sign-in ended. Sign in again to change your plan.";

/** The server's one sentence (`{ error: { message } }`). */
function errorMessageOf(body: unknown): string | null {
  const error = (body as { error?: { message?: unknown } } | null)?.error;
  return typeof error?.message === "string" && error.message.trim() ? error.message : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Leaves this page for a Stripe page; the person comes back to the web app. */
function openStripePage(url: string): void {
  // The address comes from the account server. Only https: never a `javascript:` or other scheme in this tab.
  // Not pinned to stripe.com: Stripe may serve checkout from a custom domain.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(BAD_ANSWER);
  }
  if (parsed.protocol !== "https:") throw new Error(BAD_ANSWER);
  window.location.assign(parsed.toString());
}

export type WebCloudBilling = ReturnType<typeof createWebCloudBilling>;

export function createWebCloudBilling(accountClient: CloudBillingAccountClient) {
  /**
   * `afterSignIn`: what the page does once a sign-in that ended is done again.
   * Only a click starts a sign-in; the plan link (`WebCloudPlanLink.tsx`) passes
   * null and says so instead, so a refusal can never loop through sign-ins.
   */
  const ask = async (
    method: "GET" | "POST",
    path: string,
    body: Record<string, unknown> | undefined,
    afterSignIn: WebCloudLink | null,
  ): Promise<{ status: number; body: unknown }> => {
    let answer: { status: number; body: unknown };
    try {
      answer = await accountClient.cloudRequest({ method, path, ...(body ? { body } : {}) });
    } catch (error) {
      const parsed = parseCodedErrorMessage(error);
      if (parsed.code === "signed_out") {
        if (afterSignIn) {
          stashCloudLink(afterSignIn);
          void accountClient.startSignIn().catch((error: unknown) => {
            // The person sees "sign in again" either way; a sign-in that will not start is worth knowing about.
            captureError(error, { fingerprint: ["web", "cloud_billing_sign_in"], tags: { area: "cloud_billing" }, handled: true });
          });
        }
        throw new Error(SIGN_IN_AGAIN);
      }
      throw new Error(parsed.code === "unavailable" || !parsed.message ? UNREACHABLE : parsed.message);
    }
    // Refused after a fresh token: signing in again would be refused the same way.
    if (answer.status === 401) throw new Error(errorMessageOf(answer.body) ?? "ADE Cloud didn't accept your sign-in. Sign out of ADE and sign in again.");
    if (answer.status < 200 || answer.status >= 300) {
      throw new Error(errorMessageOf(answer.body)
        ?? (answer.status >= 500 ? "ADE Cloud is having trouble right now. Try again in a moment." : `ADE Cloud answered with an error (${answer.status}).`));
    }
    return answer;
  };

  const post = async (path: string, body: Record<string, unknown>, afterSignIn: WebCloudLink | null) =>
    (await ask("POST", path, body, afterSignIn)).body;

  const accountState = (value: unknown): CloudAccountState => {
    if (!record(value)) throw new Error(BAD_ANSWER);
    return value as CloudAccountState;
  };

  const page: WebCloudLink = { kind: "page" };

  return {
    /** Whether ADE Cloud lets this account in, from the server itself (no computer needed). */
    async accessEnabled(): Promise<boolean> {
      return record((await ask("GET", CLOUD_PATHS.access, undefined, null)).body)?.enabled === true;
    },

    /** The same answer, read at most once a minute; a failed read is not kept. */
    async accessEnabledCached(): Promise<boolean> {
      return (await this.accessAnswerCached()).enabled;
    },

    /** The same, with the server's sentence when the account can't use ADE Cloud. */
    async accessAnswerCached(): Promise<WebCloudAccessAnswer> {
      const userId = accountClient.getSnapshot().userId;
      const kept = accessCache.get(accountClient);
      if (kept && kept.userId === userId && Date.now() - kept.at < ACCESS_CACHE_MS) return await kept.answer;
      const answer = (async () => accessAnswerOf((await ask("GET", CLOUD_PATHS.access, undefined, null)).body))();
      const entry = { at: Date.now(), userId, answer };
      accessCache.set(accountClient, entry);
      answer.catch(() => {
        if (accessCache.get(accountClient) === entry) accessCache.delete(accountClient);
      });
      return await answer;
    },

    /** The account's plan and hours, from the server itself. */
    async readAccount(): Promise<CloudAccountState> {
      return accountState((await ask("GET", CLOUD_PATHS.account, undefined, null)).body);
    },

    /**
     * As the desktop's `openCheckout`: Stripe's checkout opens in this tab, or
     * a paid account's plan changes in place (`change`). `afterSignIn` false:
     * the plan link, which never starts a sign-in.
     */
    async openCheckout(plan?: CloudPaidPlanId, cleanup?: CloudPlanCleanupPick, options: { afterSignIn?: boolean } = {}): Promise<CloudOpenCheckoutResult> {
      const chosen: CloudPaidPlanId = plan ?? "plus";
      const body = record(await post(
        CLOUD_PATHS.billingCheckout,
        { plan: chosen, knowsMax: true, returnTo: "web", ...(cleanup ? { cleanup } : {}) },
        options.afterSignIn === false ? null : { kind: "plan", plan: chosen as CloudPlanId },
      ));
      if (body?.url === null && (body.change === "now" || body.change === "next_period")) {
        const over = readCloudPlanCleanup(body.cleanup);
        const freeing = Array.isArray(body.freeing) ? body.freeing.filter((id): id is string => typeof id === "string") : null;
        return { opened: false, change: body.change, ...(over ? { cleanup: over } : {}), ...(freeing ? { freeing } : {}) };
      }
      if (typeof body?.url !== "string" || !body.url) throw new Error(BAD_ANSWER);
      openStripePage(body.url);
      return { opened: true };
    },

    async openBillingPortal(): Promise<{ opened: boolean }> {
      const body = record(await post(CLOUD_PATHS.billingPortal, { returnTo: "web" }, page));
      if (typeof body?.url !== "string" || !body.url) throw new Error(BAD_ANSWER);
      openStripePage(body.url);
      return { opened: true };
    },

    async openFreeUnlock(): Promise<{ opened: boolean; unlocked: boolean }> {
      const body = record(await post(CLOUD_PATHS.billingFreeUnlock, { returnTo: "web" }, page)) as Partial<CloudFreeUnlockResult> | null;
      if (body?.unlocked === true) return { opened: false, unlocked: true };
      if (typeof body?.url !== "string" || !body.url) throw new Error(BAD_ANSWER);
      openStripePage(body.url);
      return { opened: true, unlocked: false };
    },

    async setExtraHours(enabled: boolean): Promise<CloudAccountState> {
      return accountState(await post(CLOUD_PATHS.billingExtraHours, { enabled }, page));
    },

    async setExtraPhoneMinutes(choice: { enabled: true; monthlyLimitUsd: number | null } | { enabled: false }): Promise<CloudAccountState> {
      return accountState(await post(CLOUD_PATHS.billingExtraPhone, choice, page));
    },

    /** A tester's pick of who runs their phones (account level, as on the desktop). The server refuses anyone else with its sentence. */
    async setPhoneProvider(provider: CloudPhoneProviderChoice): Promise<CloudPhoneProviderChoiceAnswer> {
      const body = record(await post(CLOUD_PATHS.phoneProvider, { provider }, page));
      if (body?.ok !== true || !isCloudPhoneProviderChoice(body.provider)) throw new Error(BAD_ANSWER);
      return { ok: true, provider: body.provider };
    },

    async pickPlanCleanup(input: { planId: CloudPlanId } & CloudPlanCleanupPick): Promise<CloudAccountState> {
      return accountState(await post(CLOUD_PATHS.billingPlanCleanup, input, page));
    },
  };
}
