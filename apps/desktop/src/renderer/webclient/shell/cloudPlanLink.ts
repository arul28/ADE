import {
  CLOUD_WEB_BILLING_RETURN_PARAM,
  isCloudBillingReturnOutcome,
  type CloudBillingReturnOutcome,
  type CloudPlanId,
} from "../../../../../account-directory/src/cloud/contract";
import { createLinkStash } from "./linkStash";

// What the web app was asked to do with ADE Cloud when it opened:
//
// - `?cloudPlan=<free|plus|pro|max>`: a plan picked on ADE's website. The web
//   app opens Settings › ADE Cloud and, for a paid plan, starts its checkout
//   (`WebCloudPlanLink.tsx`).
// - `?cloudReturn=<outcome>`: Stripe sent the person back after a checkout,
//   the billing portal or the free plan's card page (the account directory
//   builds that address, `billing.ts` `webReturnUrl`). The web app opens
//   Settings › ADE Cloud and says how it went.
//
// The request is read once, as the app opens, and kept in localStorage until
// the signed-in app takes it: a sign-in in between leaves the page and comes
// back on another URL. Same reason and same short life as the pending link
// (`pendingTarget.ts`), so an abandoned plan link never starts a checkout on
// a later visit.

export const CLOUD_PLAN_PARAM = "cloudPlan";

/** Settings › ADE Cloud, at its Plans card (`settingsHash.ts` `ADE_CLOUD_PLAN_ANCHOR`). */
export const WEB_CLOUD_SETTINGS_PATH = "/settings?tab=ade-cloud#cloud-plan";

const CLOUD_LINK_KEY = "ade-web:cloud-plan-link";
const CLOUD_LINK_TTL_MS = 10 * 60_000;

const CLOUD_PLAN_IDS: readonly CloudPlanId[] = ["free", "plus", "pro", "max"];

export type WebCloudLink =
  | { kind: "plan"; plan: CloudPlanId }
  | { kind: "return"; outcome: CloudBillingReturnOutcome }
  /** Only the page: a billing call that had to sign in again comes back to it. */
  | { kind: "page" };

function isCloudPlanId(value: unknown): value is CloudPlanId {
  return (CLOUD_PLAN_IDS as readonly unknown[]).includes(value);
}

/** One value, exactly as written: `?cloudPlan=Pro`, `?cloudPlan=pro%20` or the parameter twice is no plan. */
function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? values[0]! : null;
}

/** The request in a URL's query, or null. A return from Stripe wins over a plan. */
export function cloudLinkFromSearch(search: string): WebCloudLink | null {
  const params = new URLSearchParams(search);
  const outcome = single(params, CLOUD_WEB_BILLING_RETURN_PARAM);
  if (isCloudBillingReturnOutcome(outcome)) return { kind: "return", outcome };
  const plan = single(params, CLOUD_PLAN_PARAM);
  if (isCloudPlanId(plan)) return { kind: "plan", plan };
  return null;
}

/**
 * Takes the request out of the address bar, valid or not, keeping the rest of
 * the URL. Called once the request is kept, so a reload or a copied link
 * never starts it again.
 */
export function stripCloudLinkParams(location: Pick<Location, "pathname" | "search" | "hash"> = window.location, history: Pick<History, "replaceState"> = window.history): void {
  const params = new URLSearchParams(location.search);
  if (!params.has(CLOUD_PLAN_PARAM) && !params.has(CLOUD_WEB_BILLING_RETURN_PARAM)) return;
  params.delete(CLOUD_PLAN_PARAM);
  params.delete(CLOUD_WEB_BILLING_RETURN_PARAM);
  const search = params.toString();
  history.replaceState(null, "", `${location.pathname}${search ? `?${search}` : ""}${location.hash}`);
}

function parseCloudLink(value: unknown): WebCloudLink | null {
  const link = value as Partial<{ kind: unknown; plan: unknown; outcome: unknown }> | null | undefined;
  if (link?.kind === "plan" && isCloudPlanId(link.plan)) return { kind: "plan", plan: link.plan };
  if (link?.kind === "return" && isCloudBillingReturnOutcome(link.outcome)) return { kind: "return", outcome: link.outcome };
  if (link?.kind === "page") return { kind: "page" };
  return null;
}

const stash = createLinkStash<WebCloudLink>({ key: CLOUD_LINK_KEY, ttlMs: CLOUD_LINK_TTL_MS, parse: parseCloudLink, legacyField: "link" });

export function stashCloudLink(link: WebCloudLink, nowMs = Date.now()): void {
  stash.write(link, nowMs);
}

/** The kept request, if one is waiting and still fresh. A read only. */
export function peekCloudLink(nowMs = Date.now()): WebCloudLink | null {
  return stash.read(nowMs);
}

/** The kept request, removed as it is read: each request runs once. */
export function takeCloudLink(nowMs = Date.now()): WebCloudLink | null {
  const link = stash.read(nowMs);
  stash.remove();
  return link;
}
