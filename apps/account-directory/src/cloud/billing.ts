import { BRAND_IMG_SRC, brandDocument, escapeHtml } from "../brandPage";
import { captureCloudAction, captureCloudFreePlan, type CloudWaitUntil } from "./analytics";
import { formatCloudCents, type CloudCheckoutResult, type CloudFreeUnlockResult, type CloudPlanCleanupPick } from "./contract";
import { unlockFreePlanWithCard } from "./freePlanGithub";
import { accountEmail, sendCloudEmail } from "./email";
import { json } from "./http";
import { checkPlanCleanupPick, planCleanupFor, planCleanupTargetOf, recordPlanCleanupPick, waitingPlanOf, warnPlanCleanupAhead } from "./planCleanup";
import { CENT_MICROS, EXTRA_DISK_MONTH_DAYS, extraDiskGbDaysIn, extraDiskMonthFits, extraDiskMonthMicros, utcDay, type CloudPaidPlanId } from "./plans";
import {
  accountDiskGb,
  accountDiskSql,
  accountRules,
  applyCloudPlanChange,
  boughtPlanIdOf,
  countedPlanDiskGb,
  groupByUser,
  isPaidDowngrade,
  paidPlanOf,
  extraActive,
  extraOwedMilli,
  extraUsedMilli,
  listComputers,
  liveUsedMilli,
  loadAccount,
  logCloud,
  reportCloudFailure,
  type AccountRow,
  type CloudEnv,
  type CloudPlanChange,
  type ComputerRow,
} from "./store";

/**
 * Payments for ADE Cloud (README, "ADE Cloud account"): Checkout and the
 * billing portal, the Stripe webhook, and reporting extra hours to the meter.
 *
 * Stripe's events can arrive late, twice or out of order, so a handler only
 * uses an event to learn which subscription to re-read, then acts on what
 * Stripe says now. Plans change only through `applyCloudPlanChange`.
 */

const STRIPE_API_URL = "https://api.stripe.com/v1";
const STRIPE_API_VERSION = "2026-10-28.endive";
const REQUEST_TIMEOUT_MS = 15_000;
/** The extra-hours tab is charged each time it reaches this many cents. */
const EXTRA_THRESHOLD_CENTS = "500";
const SIGNATURE_TOLERANCE_SECONDS = 300;
/** A claimed event with no finish after this long was lost mid-work, so Stripe's retry takes it. */
const EVENT_CLAIM_STALE_MS = 2 * 60_000;
const MILLI_PER_HOUR = 1000;
/** A long outage catches up over several ticks instead of one huge one. */
const MAX_REPORTS_PER_ACCOUNT_TICK = 60;

const RETURN_PATH = "/billing/return";
const WEBHOOK_PATH = "/webhooks/stripe";

/** A refusal the client shows as is. */
export class CloudBillingError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "CloudBillingError";
  }
}

/** A plan switch retried inside this window reuses its Stripe idempotency key, so it switches once. */
const PLAN_CHANGE_RETRY_WINDOW_MS = 10 * 60_000;

const unavailable = () => new CloudBillingError("billing_unavailable", "ADE Cloud can't reach billing right now. Try again soon.", 503);

class StripeRequestError extends Error {
  constructor(readonly status: number, readonly stripeMessage: string) {
    super(`stripe answered ${status}`);
    this.name = "StripeRequestError";
  }
}

type StripeObject = Record<string, unknown>;

async function stripeRequest(
  env: Pick<CloudEnv, "STRIPE_SECRET_KEY">,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params?: Record<string, string>,
  idempotencyKey?: string,
): Promise<StripeObject> {
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw unavailable();
  const response = await fetch(`${STRIPE_API_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      "stripe-version": STRIPE_API_VERSION,
      ...(params ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    ...(params ? { body: new URLSearchParams(params).toString() } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => null) as StripeObject | null;
  if (!response.ok) {
    const error = body?.error as StripeObject | undefined;
    throw new StripeRequestError(response.status, typeof error?.message === "string" ? error.message : "");
  }
  return body ?? {};
}

const textOf = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const objectOf = (value: unknown): StripeObject | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as StripeObject : null;
const idOf = (value: unknown): string | null => textOf(value) ?? textOf(objectOf(value)?.id);

/* ---- Checkout, portal ---- */

/** Each paid plan's monthly price; Pro and Max are unset until `scripts/stripe-setup.mjs` made them. */
function planPriceIds(env: CloudEnv): Record<CloudPaidPlanId, string | null> {
  return { plus: env.STRIPE_PLAN_PRICE_ID?.trim() || null, pro: env.STRIPE_PRO_PRICE_ID?.trim() || null, max: env.STRIPE_MAX_PRICE_ID?.trim() || null };
}

/** Which paid plan a price is, or null when it is none of them. */
function paidPlanOfPrice(env: CloudEnv, priceId: string | null): CloudPaidPlanId | null {
  if (!priceId) return null;
  const prices = planPriceIds(env);
  return (["max", "pro", "plus"] as const).find((plan) => prices[plan] === priceId) ?? null;
}

/** The extra-hours price before Cloud 7 (1 cent, then 0.85). The var first: the older name is a Worker secret in production. */
const firstExtraHoursPrice = (env: CloudEnv): string | null => env.STRIPE_EXTRA_HOURS_PRICE_ID?.trim() || env.STRIPE_EXTRA_PRICE_ID?.trim() || null;

/**
 * `plan`'s own extra-hours price (2, 1.5 or 1.2 cents an hour), all on the one
 * hours meter. A plan whose price isn't set yet falls back to the first price.
 */
function extraHoursPriceFor(env: CloudEnv, plan: CloudPaidPlanId): string | null {
  const own = { plus: env.STRIPE_EXTRA_HOURS_PLUS_PRICE_ID, pro: env.STRIPE_EXTRA_HOURS_PRO_PRICE_ID, max: env.STRIPE_EXTRA_HOURS_MAX_PRICE_ID }[plan]?.trim();
  return own || firstExtraHoursPrice(env);
}

/** Every extra-hours price a subscription may hold: each plan's, and the first one older subscriptions keep until they move. */
function extraHoursPrices(env: CloudEnv): Set<string> {
  const prices = [firstExtraHoursPrice(env), env.STRIPE_EXTRA_PRICE_ID?.trim(), ...(["plus", "pro", "max"] as const).map((plan) => extraHoursPriceFor(env, plan))];
  return new Set(prices.filter((price): price is string => Boolean(price)));
}

function billingConfig(env: CloudEnv, plan: CloudPaidPlanId): { planPrice: string; extraPrice: string; diskPrice: string | null } {
  const planPrice = planPriceIds(env)[plan];
  const extraPrice = extraHoursPriceFor(env, plan);
  if (!planPrice || !extraPrice || !env.STRIPE_SECRET_KEY?.trim()) {
    reportCloudFailure("cloud.billing_not_configured", { plan });
    throw unavailable();
  }
  return { planPrice, extraPrice, diskPrice: env.STRIPE_DISK_PRICE_ID?.trim() || null };
}

/**
 * One Stripe customer per account, even when two checkouts start at once,
 * with the account's email so Checkout shows it filled in. The create's
 * params never change (Stripe refuses a retry under the same idempotency key
 * with other params), so the email is filled in after it, as for a customer
 * made before emails were sent. The address comes from Clerk, never from the
 * client, and is never logged; when it can't be read, Checkout just asks for it.
 */
async function ensureCustomer(env: CloudEnv, account: AccountRow, now: number): Promise<string> {
  const email = await accountEmail(env, account.user_id).catch((error: unknown) => {
    logCloud("cloud.customer_email_read_failed", { userId: account.user_id, message: error instanceof Error ? error.name : "unknown" });
    return null;
  });
  if (account.stripe_customer_id) {
    if (email) await fillCustomerEmail(env, account.stripe_customer_id, email);
    return account.stripe_customer_id;
  }
  const customer = await stripeRequest(env, "POST", "/customers", { "metadata[ade_user_id]": account.user_id }, `ade-cloud-customer-${account.user_id}`);
  const id = textOf(customer.id);
  if (!id) throw unavailable();
  await applyCloudPlanChange(env, account.user_id, { stripeCustomerId: id }, now);
  // A retry's create answers the first customer, which may have its email already: the fill reads before it writes.
  if (email) await fillCustomerEmail(env, id, email);
  return id;
}

/** Sets the customer's email when it has none; one the person changed in Stripe stays. A failure only leaves the field empty. */
async function fillCustomerEmail(env: CloudEnv, customerId: string, email: string): Promise<void> {
  try {
    const customer = await stripeRequest(env, "GET", `/customers/${encodeURIComponent(customerId)}`);
    if (textOf(customer.email)) return;
    await stripeRequest(env, "POST", `/customers/${encodeURIComponent(customerId)}`, { email });
  } catch (error) {
    reportCloudFailure("cloud.customer_email_fill_failed", { status: error instanceof StripeRequestError ? error.status : 0 });
  }
}

/** A person with two open Checkout tabs must not be able to buy twice. */
async function expireOpenCheckouts(env: CloudEnv, customer: string): Promise<void> {
  const open = await stripeRequest(env, "GET", `/checkout/sessions?customer=${encodeURIComponent(customer)}&status=open&limit=10`);
  for (const session of (open.data as StripeObject[] | undefined) ?? []) {
    const id = textOf(session.id);
    if (id) await stripeRequest(env, "POST", `/checkout/sessions/${id}/expire`, {});
  }
}

/**
 * Checkout for a plan. A paid account asking for its other plan changes it in
 * place (`changePaidPlan`); a downgrade carries the person's pick (`cleanup`).
 */
export async function createCheckoutUrl(
  env: CloudEnv,
  userId: string,
  origin: string,
  now: number,
  requested?: CloudPaidPlanId,
  waitUntil?: CloudWaitUntil,
  cleanup?: CloudPlanCleanupPick,
): Promise<CloudCheckoutResult> {
  const plan = requested ?? "plus";
  const { planPrice, extraPrice, diskPrice } = billingConfig(env, plan);
  const account = await loadAccount(env, userId, now);
  if (account.plan === "paid") {
    // A build that knows one paid plan names none: it only ever buys, never switches.
    if (!requested) throw new CloudBillingError("already_paid", "You already have a paid plan.", 409);
    const current = paidPlanOf(account);
    const pending = account.paid_plan_next;
    if (current === plan && pending == null) throw new CloudBillingError("already_paid", "You're already on that plan.", 409);
    if (pending === plan) throw new CloudBillingError("already_paid", "Your plan already changes to that at the end of this period.", 409);
    return changePaidPlan(env, account, plan, planPrice, now, waitUntil, cleanup);
  }
  try {
    const customer = await ensureCustomer(env, account, now);
    await expireOpenCheckouts(env, customer);
    const session = await stripeRequest(env, "POST", "/checkout/sessions", {
      mode: "subscription",
      customer,
      client_reference_id: userId,
      "managed_payments[enabled]": "true",
      "line_items[0][price]": planPrice,
      "line_items[0][quantity]": "1",
      "line_items[1][price]": extraPrice,
      // Extra disk rides its own meter and price, never the hours price.
      ...(diskPrice ? { "line_items[2][price]": diskPrice } : {}),
      "metadata[ade_user_id]": userId,
      "subscription_data[metadata][ade_user_id]": userId,
      success_url: `${origin}${RETURN_PATH}?to=done`,
      cancel_url: `${origin}${RETURN_PATH}?to=cancelled`,
    });
    const url = textOf(session.url);
    if (!url) throw unavailable();
    return { url };
  } catch (error) {
    if (error instanceof StripeRequestError) {
      reportCloudFailure("cloud.checkout_failed", { status: error.status, message: error.stripeMessage });
      throw unavailable();
    }
    throw error;
  }
}

/* ---- A card with no charge for the free plan ---- */

/** `metadata[ade_purpose]` of the setup-mode Checkout that unlocks the free hours early. */
const FREE_UNLOCK_PURPOSE = "free_unlock";

/** Whether the Stripe customer already has a card saved (a former paid customer, a card added before). */
async function customerHasCard(env: CloudEnv, customerId: string): Promise<boolean> {
  const cards = await stripeRequest(env, "GET", `/customers/${encodeURIComponent(customerId)}/payment_methods?type=card&limit=1`);
  return Array.isArray(cards.data) && cards.data.length > 0;
}

/**
 * `POST /cloud/billing/free-unlock`: a card saved with no charge starts the
 * free hours of a GitHub account younger than 30 days (`freePlanGithub.ts`).
 * A card already on file unlocks at once; otherwise this answers a Stripe
 * Checkout in setup mode (nothing is charged), and its
 * `checkout.session.completed` unlocks.
 */
export async function createFreeUnlockUrl(env: CloudEnv, userId: string, origin: string, ctx: { now: number; waitUntil?: CloudWaitUntil }): Promise<CloudFreeUnlockResult> {
  const waitUntil: CloudWaitUntil = ctx.waitUntil ?? ((promise) => { void promise; });
  const account = await loadAccount(env, userId, ctx.now);
  if (account.free_card_unlocked_at != null) return { url: null, unlocked: true };
  if (accountRules(account) !== "free" || account.free_github_hold !== "github_too_new") {
    throw new CloudBillingError("nothing_to_unlock", "Your free hours don't need a card.", 409);
  }
  if (!env.STRIPE_SECRET_KEY?.trim()) {
    reportCloudFailure("cloud.billing_not_configured", { plan: FREE_UNLOCK_PURPOSE });
    throw unavailable();
  }
  try {
    if (account.stripe_customer_id && await customerHasCard(env, account.stripe_customer_id)) {
      await unlockFreePlanWithCard(env, account, "card_on_file", { now: ctx.now, waitUntil });
      return { url: null, unlocked: true };
    }
    const customer = await ensureCustomer(env, account, ctx.now);
    const session = await stripeRequest(env, "POST", "/checkout/sessions", {
      mode: "setup",
      currency: "usd",
      // Managed Payments (on for the plans' Checkout) takes only subscription and payment modes.
      "managed_payments[enabled]": "false",
      customer,
      client_reference_id: userId,
      "metadata[ade_user_id]": userId,
      "metadata[ade_purpose]": FREE_UNLOCK_PURPOSE,
      "setup_intent_data[metadata][ade_user_id]": userId,
      "setup_intent_data[metadata][ade_purpose]": FREE_UNLOCK_PURPOSE,
      success_url: `${origin}${RETURN_PATH}?to=card`,
      cancel_url: `${origin}${RETURN_PATH}?to=card_cancelled`,
    });
    const url = textOf(session.url);
    if (!url) throw unavailable();
    captureCloudFreePlan(env, waitUntil, userId, "card_unlock_started", null, ctx.now);
    return { url, unlocked: false };
  } catch (error) {
    if (error instanceof StripeRequestError) {
      reportCloudFailure("cloud.free_unlock_checkout_failed", { status: error.status, message: error.stripeMessage });
      throw unavailable();
    }
    throw error;
  }
}

/** A setup-mode Checkout finished: the card is saved (its SetupIntent succeeded), so the free hours unlock. */
async function onFreeUnlockCompleted(env: CloudEnv, session: StripeObject, now: number, waitUntil: CloudWaitUntil): Promise<void> {
  const metadata = objectOf(session.metadata);
  const userId = textOf(session.client_reference_id) ?? textOf(metadata?.ade_user_id);
  if (!userId) return;
  if (session.status !== "complete") {
    logCloud("cloud.free_unlock_incomplete", { userId, status: textOf(session.status) });
    return;
  }
  const setupIntentId = idOf(session.setup_intent);
  if (setupIntentId) {
    const intent = await stripeRequest(env, "GET", `/setup_intents/${encodeURIComponent(setupIntentId)}`);
    if (intent.status !== "succeeded") {
      logCloud("cloud.free_unlock_not_succeeded", { userId, status: textOf(intent.status) });
      return;
    }
  }
  const account = await loadAccount(env, userId, now);
  await unlockFreePlanWithCard(env, account, "checkout", { now, waitUntil });
}

/** The portal setup stripe-setup made (card, cancel at period end, invoices), when set. */
const portalConfigParams = (env: CloudEnv): Record<string, string> => {
  const id = env.STRIPE_PORTAL_CONFIG_ID?.trim();
  return id ? { configuration: id } : {};
};

type SubscriptionItem = { id: string; price: string | null; meter: string | null };

/** The meter a price bills from, or null for a licensed price. */
const meterOfPrice = (price: unknown): string | null => idOf(objectOf(objectOf(price)?.recurring)?.meter);

/** The subscription's items: which one is the plan, and the price (and meter) of each. */
async function subscriptionItems(env: CloudEnv, subscriptionId: string): Promise<SubscriptionItem[]> {
  const subscription = await stripeRequest(env, "GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
  const items = (objectOf(subscription.items)?.data as StripeObject[] | undefined) ?? [];
  return items.flatMap((item) => {
    const id = textOf(item.id);
    return id ? [{ id, price: idOf(item.price), meter: meterOfPrice(item.price) }] : [];
  });
}

/**
 * Whether the subscription already bills extra disk: the configured price, or
 * an older extra-disk price on the same meter (a price that moved to its own
 * product keeps billing the subscriptions that hold it). A second item on the
 * same meter would bill each GB-day twice.
 */
async function hasDiskItem(env: CloudEnv, items: SubscriptionItem[], diskPrice: string): Promise<boolean> {
  if (items.some((item) => item.price === diskPrice)) return true;
  const metered = items.filter((item) => item.meter != null);
  if (metered.length === 0) return false;
  const diskMeter = meterOfPrice(await stripeRequest(env, "GET", `/prices/${encodeURIComponent(diskPrice)}`));
  return diskMeter != null && metered.some((item) => item.meter === diskMeter);
}

/**
 * Moves the subscription's metered items to the prices `plan` bills with now,
 * uncharged: extra hours to the plan's own price and, with `disk`, extra disk
 * to the current disk price. Each price is on the same meter as the one it
 * replaces, so what was reported keeps counting. An upgrade moves extra hours
 * at once (the cheaper hour); a renewal moves both, which is how a downgrade's
 * price and a subscription bought before Cloud 7 (the first extra-hours
 * price, the $1 disk price) move: at the start of a period, never mid-period.
 */
async function moveMeteredItems(env: CloudEnv, subscriptionId: string, plan: CloudPaidPlanId, now: number, options: { disk: boolean }): Promise<void> {
  const items = await subscriptionItems(env, subscriptionId);
  const hoursPrices = extraHoursPrices(env);
  const move = async (item: SubscriptionItem, price: string, what: "extra_hours" | "extra_disk") => {
    await stripeRequest(env, "POST", `/subscription_items/${encodeURIComponent(item.id)}`, { price, proration_behavior: "none" },
      `ade-metered:${item.id}:${price}:${Math.floor(now / PLAN_CHANGE_RETRY_WINDOW_MS)}`);
    logCloud("cloud.metered_price_moved", { subscriptionId, what, plan, from: item.price, to: price });
  };
  const hoursPrice = extraHoursPriceFor(env, plan);
  const hoursItem = items.find((item) => item.price != null && hoursPrices.has(item.price));
  if (!hoursItem) reportCloudFailure("cloud.extra_hours_item_missing", { subscriptionId });
  else if (hoursPrice && hoursItem.price !== hoursPrice) await move(hoursItem, hoursPrice, "extra_hours");
  const diskPrice = env.STRIPE_DISK_PRICE_ID?.trim();
  if (!options.disk || !diskPrice) return;
  // An older disk price is a metered item that is neither the plan nor extra hours, on the disk price's meter.
  const others = items.filter((item) => item.meter != null && item.price !== diskPrice && !(item.price && hoursPrices.has(item.price)) && paidPlanOfPrice(env, item.price) == null);
  if (others.length === 0) return;
  const diskMeter = meterOfPrice(await stripeRequest(env, "GET", `/prices/${encodeURIComponent(diskPrice)}`));
  const oldDisk = diskMeter ? others.find((item) => item.meter === diskMeter) : undefined;
  if (oldDisk) await move(oldDisk, diskPrice, "extra_disk");
}

/**
 * A move between paid plans (Plus, Pro, Max) on the subscription itself. The
 * billing portal can't do it: Stripe refuses a portal plan switch on a
 * subscription with more than one item, and every ADE subscription has the
 * plan plus its meters.
 * - Upgrade: charged now for the rest of the period; a declined card changes
 *   nothing. The higher plan's hours apply at once, the hours used stay, and
 *   extra hours move to its cheaper price.
 * - Downgrade: no refund and no charge; the next invoice is the cheaper plan.
 *   The higher plan's hours, disk and extra-hour price stay until the period
 *   ends (`applyCloudPlanChange`; the renewal moves the price). Over the
 *   cheaper plan's disk, the person's pick (`cleanup`) is checked before
 *   Stripe is asked, so a pick that doesn't fit changes nothing; once the plan
 *   changed, the pick is recorded and the minute cron frees exactly those
 *   computers.
 * - Back to the plan in force before a downgrade took effect: the item goes
 *   back, uncharged.
 * The webhook that follows applies the same change again, which is a no-op.
 */
async function changePaidPlan(
  env: CloudEnv,
  account: AccountRow,
  to: CloudPaidPlanId,
  toPrice: string,
  now: number,
  waitUntil: CloudWaitUntil,
  cleanup?: CloudPlanCleanupPick,
): Promise<CloudCheckoutResult> {
  if (!account.stripe_subscription_id) throw unavailable();
  if (account.stripe_status === "past_due") {
    throw new CloudBillingError("past_due", "Your last payment didn't go through. Update your card in Manage, then change your plan.", 409);
  }
  const current = paidPlanOf(account);
  const downgrade = isPaidDowngrade(current, to);
  // A downgrade's pick is checked before Stripe: one that doesn't fit changes nothing.
  const computers = downgrade ? await listComputers(env, account.user_id) : [];
  let picked: CloudPlanCleanupPick | null = null;
  if (downgrade && cleanup) {
    const check = checkPlanCleanupPick(env, account, computers, to, cleanup);
    if (!check.ok && check.code !== "nothing_to_free") throw new CloudBillingError(check.code, check.message, check.code === "bad_request" ? 400 : 409);
    if (check.ok) picked = { push: cleanup.push, instanceIds: check.instanceIds };
  }
  const undoDowngrade = to === current && account.paid_plan_next != null;
  // Upward from the plan in force is charged; going back to it isn't. A higher plan
  // than the one in force while a downgrade waits is still an upgrade from it.
  const charged = !downgrade && !undoDowngrade;
  const subscriptionId = account.stripe_subscription_id;
  const planItemOf = async () => (await subscriptionItems(env, subscriptionId)).find((item) => paidPlanOfPrice(env, item.price) != null) ?? null;
  let planItem: { id: string; price: string | null } | null;
  try {
    planItem = await planItemOf();
  } catch (error) {
    if (error instanceof CloudBillingError) throw error;
    reportCloudFailure("cloud.plan_change_failed", { step: "read", status: error instanceof StripeRequestError ? error.status : 0 });
    throw unavailable();
  }
  if (!planItem) {
    reportCloudFailure("cloud.plan_item_missing", { userId: account.user_id });
    throw unavailable();
  }
  if (planItem.price !== toPrice) {
    let confirmed = false;
    let failure: unknown = null;
    try {
      const changed = await stripeRequest(env, "POST", `/subscription_items/${encodeURIComponent(planItem.id)}`, {
        price: toPrice,
        quantity: "1",
        proration_behavior: charged ? "always_invoice" : "none",
        // A declined card leaves the subscription as it was: no half-switched plan.
        ...(charged ? { payment_behavior: "error_if_incomplete" } : {}),
        // The mode and the account's last change are in the key: "Stay on Pro" after a round
        // trip, or the same switch again after it, is a new request; a retry after a lost answer is not.
      }, `ade-plan:${planItem.id}:${to}:${charged ? "charge" : "no-charge"}:${account.updated_at}:${Math.floor(now / PLAN_CHANGE_RETRY_WINDOW_MS)}`);
      // Trust the item Stripe returns, not the request: a replayed or partial answer writes nothing.
      confirmed = idOf(changed.price) === toPrice;
    } catch (error) {
      failure = error;
    }
    if (!confirmed) {
      // A failed or unexpected answer: Stripe may have switched anyway, so ask it and follow what it says.
      const error = failure;
      const after = await planItemOf().catch(() => null);
      if (after?.price !== toPrice) {
        // The account stays exactly as it was. Managed Payments may refuse some subscription changes from the API.
        if (error instanceof StripeRequestError && charged && error.status === 402) {
          reportCloudFailure("cloud.plan_upgrade_declined", { userId: account.user_id });
          throw new CloudBillingError("payment_failed", "Your card was declined, so your plan didn't change. Update your card in Manage.", 402);
        }
        reportCloudFailure("cloud.plan_change_refused", {
          userId: account.user_id,
          to,
          status: error instanceof StripeRequestError ? error.status : 0,
          message: error instanceof StripeRequestError ? error.stripeMessage : error instanceof Error ? error.name : error == null ? "item_not_on_target_price" : "unknown",
        });
        throw new CloudBillingError("plan_change_refused", "ADE Cloud couldn't change your plan right now. Nothing changed. Try again later.", 409);
      }
      reportCloudFailure("cloud.plan_change_unconfirmed", { userId: account.user_id, to });
    }
  }
  try {
    // A pick answers the over-the-limits email's question already: it isn't sent.
    await applyAndAnnounce(env, account, { paidPlan: to }, now, waitUntil, { pickMade: picked != null });
  } catch (error) {
    // Stripe switched; the webhook that follows saves the same change.
    reportCloudFailure("cloud.plan_change_unsaved", { userId: account.user_id, to, message: error instanceof Error ? error.message : "unknown" });
  }
  if (!downgrade) {
    // The cheaper extra hour of the higher plan starts now. A failure leaves the old price until the renewal moves it.
    try {
      await moveMeteredItems(env, subscriptionId, to, now, { disk: false });
    } catch (error) {
      reportCloudFailure("cloud.extra_hours_price_move_failed", { userId: account.user_id, to, status: error instanceof StripeRequestError ? error.status : 0 });
    }
    return { url: null, change: "now" };
  }
  if (picked) {
    if (await recordPlanCleanupPick(env, account.user_id, to, picked, now)) return { url: null, change: "next_period", freeing: picked.instanceIds };
    // Another pick started meanwhile: the plan changed, and nothing of this one is freed.
    reportCloudFailure("cloud.plan_cleanup_pick_lost", { userId: account.user_id });
  }
  // No pick (an older build): nothing is deleted; the answer says what goes over the cheaper plan.
  const over = planCleanupFor(env, account, computers, to);
  return { url: null, change: "next_period", ...(over ? { cleanup: { ...over, startsAt: account.period_end, freeing: null } } : {}) };
}

/**
 * `POST /cloud/billing/plan-cleanup`: the person's pick for an account already
 * over a cheaper plan (the plan in force, or the one a downgrade or a cancel
 * made outside ADE waits for). The same check as a downgrade's pick, then the
 * same freeing.
 */
export async function pickPlanCleanup(env: CloudEnv, userId: string, planId: unknown, pick: CloudPlanCleanupPick, now: number): Promise<void> {
  const account = await loadAccount(env, userId, now);
  const computers = await listComputers(env, userId);
  const target = planCleanupTargetOf(env, account, computers);
  if (!target) throw new CloudBillingError("nothing_to_free", "Your computers already fit your plan.", 409);
  if (planId !== target) throw new CloudBillingError("cleanup_changed", "Your plan changed since ADE showed this. Look again.", 409);
  const check = checkPlanCleanupPick(env, account, computers, target, pick);
  if (!check.ok) throw new CloudBillingError(check.code, check.message, check.code === "bad_request" ? 400 : 409);
  if (!(await recordPlanCleanupPick(env, userId, target, { push: pick.push, instanceIds: check.instanceIds }, now))) {
    throw new CloudBillingError("cleanup_running", "ADE is still freeing the computers you picked. Try again when it's done.", 409);
  }
}

export async function createPortalUrl(env: CloudEnv, userId: string, origin: string, now: number): Promise<{ url: string }> {
  const account = await loadAccount(env, userId, now);
  if (!account.stripe_customer_id) throw new CloudBillingError("no_billing", "There's nothing to manage until you've bought a plan.", 409);
  try {
    const session = await stripeRequest(env, "POST", "/billing_portal/sessions", {
      customer: account.stripe_customer_id,
      return_url: `${origin}${RETURN_PATH}?to=portal`,
      ...portalConfigParams(env),
    });
    const url = textOf(session.url);
    if (!url) throw unavailable();
    return { url };
  } catch (error) {
    if (error instanceof StripeRequestError) {
      reportCloudFailure("cloud.portal_failed", { status: error.status, message: error.stripeMessage });
      throw unavailable();
    }
    throw error;
  }
}

export async function setExtraHours(env: CloudEnv, userId: string, enabled: boolean, now: number): Promise<void> {
  const account = await loadAccount(env, userId, now);
  if (accountRules(account) !== "paid") throw new CloudBillingError("needs_paid_plan", "Extra hours need a paid plan.", 403);
  // Turning them off stops new use; what was already used is still reported.
  const owed = !enabled && extraActive(account)
    ? extraOwedMilli(account, liveUsedMilli(account, await listComputers(env, userId), now))
    : 0;
  const recordOwed = () => env.DB.prepare("update cloud_accounts set extra_owed_milli = ?, updated_at = ? where user_id = ?").bind(owed, now, userId).run();
  // Before the switch moves: read after a failure, the switch being off would forget what's owed.
  if (owed > 0) await recordOwed();
  await applyCloudPlanChange(env, userId, { extraEnabled: enabled }, now);
  if (enabled) await recordOwed();
}

/**
 * Extra disk: on with a monthly limit, or off. Turning it on makes sure the
 * subscription has the extra-disk price (subscriptions bought before it
 * existed don't). Turning it off while the computers hold more than the
 * plan's disk is refused: that disk would still be there, unpaid.
 */
export async function setExtraDisk(
  env: CloudEnv,
  userId: string,
  choice: { enabled: true; monthlyLimitCents: number } | { enabled: false },
  now: number,
): Promise<void> {
  const account = await loadAccount(env, userId, now);
  if (choice.enabled) {
    if (accountRules(account) !== "paid") throw new CloudBillingError("needs_paid_plan", "Extra disk needs a paid plan.", 403);
    const diskPrice = env.STRIPE_DISK_PRICE_ID?.trim();
    if (!diskPrice || !env.STRIPE_DISK_METER_EVENT?.trim() || !account.stripe_subscription_id) {
      reportCloudFailure("cloud.extra_disk_not_configured", { userId });
      throw unavailable();
    }
    try {
      const items = await subscriptionItems(env, account.stripe_subscription_id);
      if (!await hasDiskItem(env, items, diskPrice)) {
        await stripeRequest(env, "POST", "/subscription_items", {
          subscription: account.stripe_subscription_id,
          price: diskPrice,
        }, `ade-cloud-disk-item-${account.stripe_subscription_id}`);
      }
    } catch (error) {
      if (error instanceof StripeRequestError) {
        reportCloudFailure("cloud.extra_disk_item_failed", { status: error.status, message: error.stripeMessage });
        throw unavailable();
      }
      throw error;
    }
    await env.DB.prepare("update cloud_accounts set extra_disk_state = 'on', extra_disk_limit_cents = ?, extra_disk_asked_at = coalesce(extra_disk_asked_at, ?), updated_at = ? where user_id = ?")
      .bind(choice.monthlyLimitCents, now, now, userId).run();
    return;
  }
  // A downgrade waiting for the period end counts already: the next plan's disk is what stays paid.
  const planGb = countedPlanDiskGb(account);
  const usedGb = await accountDiskGb(env, userId);
  if (account.extra_disk_state === "on" && usedGb > planGb) {
    throw new CloudBillingError(
      "disk_over_plan",
      `Your computers hold ${usedGb} GB, more than your plan's ${planGb} GB at one time. Delete a computer you no longer use, then turn extra disk off.`,
      409,
    );
  }
  await env.DB.prepare("update cloud_accounts set extra_disk_state = 'asked', extra_disk_asked_at = coalesce(extra_disk_asked_at, ?), updated_at = ? where user_id = ?")
    .bind(now, now, userId).run();
}

/** Ends the account's subscription now, for a deleted account. Already gone counts as done. */
export async function cancelAccountSubscription(env: Pick<CloudEnv, "DB" | "STRIPE_SECRET_KEY">, account: Pick<AccountRow, "user_id" | "stripe_subscription_id">, now: number): Promise<void> {
  if (!account.stripe_subscription_id) return;
  try {
    await stripeRequest(env, "DELETE", `/subscriptions/${encodeURIComponent(account.stripe_subscription_id)}`);
  } catch (error) {
    if (!(error instanceof StripeRequestError && error.status === 404)) throw error;
  }
  await env.DB.prepare("update cloud_accounts set plan = 'free', stripe_subscription_id = null, stripe_status = null, extra_enabled = 0, extra_owed_milli = 0, extra_disk_state = 'off', cancel_at_period_end = 0, updated_at = ? where user_id = ?")
    .bind(now, account.user_id).run();
  logCloud("cloud.subscription_cancelled_for_deleted_account", { userId: account.user_id });
}

/* ---- Webhook ---- */

const hexToBytes = (hex: string): Uint8Array<ArrayBuffer> | null => {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  return new Uint8Array(hex.match(/../g)!.map((pair) => parseInt(pair, 16)));
};

/** `Stripe-Signature`: `t=<seconds>,v1=<hex HMAC-SHA256 of "t.body">`, possibly several v1s. */
async function verifyStripeSignature(rawBody: string, header: string | null, secret: string, nowMs: number): Promise<boolean> {
  if (!header) return false;
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name === "t") timestamp = value;
    else if (name === "v1") signatures.push(value);
  }
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signed = encoder.encode(`${timestamp}.${rawBody}`);
  for (const signature of signatures) {
    const bytes = hexToBytes(signature);
    // `verify` compares in constant time.
    if (bytes && await crypto.subtle.verify("HMAC", key, bytes, signed)) return true;
  }
  return false;
}

type SubscriptionFacts = {
  id: string;
  status: string;
  customer: string | null;
  userId: string | null;
  cancelAtPeriodEnd: boolean;
  /** Which plan the plan item is; null when no item is a plan price (setup or Stripe changed). */
  paidPlan: CloudPaidPlanId | null;
  /** Seconds, from the plan's own item. Null only if Stripe's shape changed. */
  periodStart: number | null;
  periodEnd: number | null;
  hasThreshold: boolean;
};

async function readSubscription(env: CloudEnv, id: string): Promise<SubscriptionFacts> {
  const subscription = await stripeRequest(env, "GET", `/subscriptions/${encodeURIComponent(id)}`);
  const items = (objectOf(subscription.items)?.data as StripeObject[] | undefined) ?? [];
  // Never `items[0]`: the metered items (extra hours, extra disk) carry their own periods.
  const planItem = items.find((item) => paidPlanOfPrice(env, idOf(item.price)) != null);
  if (!planItem) reportCloudFailure("cloud.plan_item_missing", { subscriptionId: id });
  const metadata = objectOf(subscription.metadata);
  return {
    id,
    status: textOf(subscription.status) ?? "unknown",
    customer: idOf(subscription.customer),
    userId: textOf(metadata?.ade_user_id),
    cancelAtPeriodEnd: subscription.cancel_at_period_end === true || subscription.cancel_at != null,
    paidPlan: planItem ? paidPlanOfPrice(env, idOf(planItem.price)) : null,
    periodStart: typeof planItem?.current_period_start === "number" ? planItem.current_period_start : null,
    periodEnd: typeof planItem?.current_period_end === "number" ? planItem.current_period_end : null,
    hasThreshold: objectOf(subscription.billing_thresholds)?.amount_gte != null,
  };
}

const periodChange = (subscription: SubscriptionFacts): Pick<CloudPlanChange, "periodStart" | "periodEnd"> =>
  subscription.periodStart != null && subscription.periodEnd != null
    ? { periodStart: subscription.periodStart * 1000, periodEnd: subscription.periodEnd * 1000 }
    : {};

/** An existing account only: a webhook naming an id with no account must not create one. */
async function userForSubscription(env: CloudEnv, subscription: SubscriptionFacts): Promise<string | null> {
  if (subscription.userId) {
    const named = await env.DB.prepare("select user_id from cloud_accounts where user_id = ?")
      .bind(subscription.userId).first<{ user_id: string }>();
    if (named) return named.user_id;
  }
  if (!subscription.customer) return null;
  const row = await env.DB.prepare("select user_id from cloud_accounts where stripe_customer_id = ?")
    .bind(subscription.customer).first<{ user_id: string }>();
  return row?.user_id ?? null;
}

/**
 * Banner and email, once, when a payment fails or a paid invoice brings the
 * plan back; and when a downgrade or a cancel is made over the cheaper plan's
 * limits, the email naming what those limits will free (a cancel from the
 * billing portal is never seen in ADE first).
 */
async function announceChange(env: CloudEnv, before: AccountRow, after: AccountRow, options: { pickMade?: boolean } = {}): Promise<void> {
  const waitingBefore = waitingPlanOf(before);
  const waitingAfter = waitingPlanOf(after);
  if (waitingAfter && waitingAfter !== waitingBefore && !options.pickMade) {
    // Its own failure must not cost the past-due or restored email below: Stripe's retry sees no change and never sends it.
    try {
      await warnPlanCleanupAhead(env, after, await listComputers(env, after.user_id), waitingAfter);
    } catch (error) {
      reportCloudFailure("cloud.plan_cleanup_warn_ahead_failed", { userId: after.user_id, message: error instanceof Error ? error.message : "unknown" });
    }
  }
  const wasPastDue = before.stripe_status === "past_due";
  const isPastDue = after.stripe_status === "past_due";
  if (!wasPastDue && isPastDue && after.plan === "paid") {
    logCloud("cloud.billing_past_due", { userId: after.user_id });
    await sendCloudEmail(env, {
      userId: after.user_id,
      subject: "Your ADE Cloud payment didn't go through",
      text: "We couldn't charge your card, so your account is on the free plan's hours and extra hours are off. Update your card in ADE to get your plan back.",
    });
    return;
  }
  if (wasPastDue && !isPastDue && after.plan === "paid") {
    logCloud("cloud.billing_restored", { userId: after.user_id });
    await sendCloudEmail(env, {
      userId: after.user_id,
      subject: "Your ADE Cloud plan is back",
      text: "Your payment went through, so your plan and its hours are back.",
    });
  }
}

async function applyAndAnnounce(env: CloudEnv, before: AccountRow, change: CloudPlanChange, now: number, waitUntil?: CloudWaitUntil, options: { pickMade?: boolean } = {}): Promise<void> {
  const after = await applyCloudPlanChange(env, before.user_id, change, now);
  await announceChange(env, before, after, options);
  const plan = boughtPlanIdOf(after);
  if (plan !== boughtPlanIdOf(before)) {
    logCloud("cloud.plan_changed", { userId: after.user_id, from: boughtPlanIdOf(before), to: plan });
    captureCloudAction(env, waitUntil, after.user_id, { action: "plan_change", plan, origin: "person" }, `plan:${plan}`, now);
  }
}

/** Matches the account to what Stripe says about its subscription right now. */
async function syncSubscription(env: CloudEnv, subscriptionId: string | null, now: number, waitUntil: CloudWaitUntil, paidInvoice?: StripeObject): Promise<void> {
  if (!subscriptionId) return;
  const subscription = await readSubscription(env, subscriptionId);
  const userId = await userForSubscription(env, subscription);
  if (!userId) {
    reportCloudFailure("cloud.stripe_unknown_subscription", { subscriptionId });
    return;
  }
  const account = await loadAccount(env, userId, now);
  // Before Checkout is recorded, or a subscription this account has moved on from.
  if (account.stripe_subscription_id !== subscription.id) return;

  const { status, cancelAtPeriodEnd } = subscription;
  if (status === "canceled" || status === "incomplete_expired") {
    await applyAndAnnounce(env, account, { plan: "free", stripeSubscriptionId: null, stripeStatus: null, cancelAtPeriodEnd: false }, now, waitUntil);
    return;
  }
  if (status === "past_due" || status === "unpaid") {
    await applyAndAnnounce(env, account, { stripeStatus: "past_due", cancelAtPeriodEnd }, now, waitUntil);
    return;
  }
  if (status !== "active" && status !== "trialing") return;

  // A renewal's invoice covers the period that just ended, so it ends where the current one starts.
  const isRenewal = paidInvoice?.billing_reason === "subscription_cycle" && paidInvoice.period_end === subscription.periodStart;
  // A Checkout whose payment was still pending, now paid: the plan starts here.
  const starting = account.plan !== "paid" && account.stripe_status === "incomplete";
  const movesPeriod = starting || isRenewal || account.stripe_status === "past_due";
  await applyAndAnnounce(env, account, {
    ...(starting ? { plan: "paid" as const } : {}),
    // An upgrade or back: the plan's hours change now, the hours used stay.
    ...(subscription.paidPlan ? { paidPlan: subscription.paidPlan } : {}),
    stripeStatus: status,
    cancelAtPeriodEnd,
    ...(movesPeriod ? periodChange(subscription) : {}),
  }, now, waitUntil);
  // On every active event, so a threshold that failed after the plan was saved still gets set.
  if (starting || account.plan === "paid") await ensureThreshold(env, subscription);
  // A new period bills extra hours and disk at the plan's prices now: a downgrade's
  // and an older subscription's move here. A failure throws, so Stripe's retry moves them.
  if (isRenewal && subscription.paidPlan) await moveMeteredItems(env, subscription.id, subscription.paidPlan, now, { disk: true });
}

/** Stripe refuses a threshold at Checkout on these subscriptions; it accepts one afterward. */
async function ensureThreshold(env: CloudEnv, subscription: SubscriptionFacts): Promise<void> {
  if (subscription.hasThreshold) return;
  await stripeRequest(env, "POST", `/subscriptions/${encodeURIComponent(subscription.id)}`, {
    "billing_thresholds[amount_gte]": EXTRA_THRESHOLD_CENTS,
    "billing_thresholds[reset_billing_cycle_anchor]": "false",
  });
}

async function onCheckoutCompleted(env: CloudEnv, session: StripeObject, now: number, waitUntil: CloudWaitUntil): Promise<void> {
  const subscriptionId = idOf(session.subscription);
  const metadata = objectOf(session.metadata);
  const userId = textOf(session.client_reference_id) ?? textOf(metadata?.ade_user_id);
  if (session.mode !== "subscription" || !subscriptionId || !userId) return;
  const subscription = await readSubscription(env, subscriptionId);
  if (subscription.status === "incomplete") {
    // Payment still pending: remember the subscription so its `active` event starts the plan.
    const pending = await loadAccount(env, userId, now);
    if (pending.plan !== "paid") {
      await applyAndAnnounce(env, pending, {
        stripeCustomerId: subscription.customer ?? idOf(session.customer),
        stripeSubscriptionId: subscription.id,
        stripeStatus: "incomplete",
        ...(subscription.paidPlan ? { paidPlan: subscription.paidPlan } : {}),
      }, now, waitUntil);
    }
    return;
  }
  if (subscription.status !== "active" && subscription.status !== "trialing") return;
  const account = await loadAccount(env, userId, now);

  if (account.plan === "paid" && account.stripe_subscription_id && account.stripe_subscription_id !== subscription.id) {
    // Two Checkouts finished: keep the first plan and don't leave the person paying twice.
    await stripeRequest(env, "DELETE", `/subscriptions/${encodeURIComponent(subscription.id)}`);
    reportCloudFailure("cloud.duplicate_subscription_cancelled", { userId, subscriptionId });
    await sendCloudEmail(env, { owner: true, subject: "ADE Cloud double purchase to refund", text: `Subscription ${subscription.id} duplicated an existing plan and was cancelled. Refund its first invoice.` });
    return;
  }
  if (account.stripe_subscription_id !== subscription.id || account.plan !== "paid") {
    await applyAndAnnounce(env, account, {
      plan: "paid",
      ...(subscription.paidPlan ? { paidPlan: subscription.paidPlan } : {}),
      ...periodChange(subscription),
      stripeCustomerId: subscription.customer ?? idOf(session.customer),
      stripeSubscriptionId: subscription.id,
      stripeStatus: subscription.status,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    }, now, waitUntil);
  }
  await ensureThreshold(env, subscription);
}

const invoiceSubscriptionId = (invoice: StripeObject): string | null =>
  idOf(objectOf(objectOf(invoice.parent)?.subscription_details)?.subscription) ?? idOf(invoice.subscription);

async function applyStripeEvent(env: CloudEnv, type: string, object: StripeObject, now: number, waitUntil: CloudWaitUntil): Promise<void> {
  if (type === "checkout.session.completed") {
    if (object.mode === "setup" && textOf(objectOf(object.metadata)?.ade_purpose) === FREE_UNLOCK_PURPOSE) return onFreeUnlockCompleted(env, object, now, waitUntil);
    return onCheckoutCompleted(env, object, now, waitUntil);
  }
  if (type === "customer.subscription.updated" || type === "customer.subscription.deleted") return syncSubscription(env, idOf(object.id), now, waitUntil);
  if (type === "invoice.paid") return syncSubscription(env, invoiceSubscriptionId(object), now, waitUntil, object);
  if (type === "invoice.payment_failed") return syncSubscription(env, invoiceSubscriptionId(object), now, waitUntil);
}

/** Takes this event for one delivery: a first delivery, or one whose earlier claim was lost mid-work. */
async function claimStripeEvent(env: CloudEnv, eventId: string, type: string, now: number): Promise<"claimed" | "duplicate" | "in_progress"> {
  const claim = await env.DB.prepare("insert or ignore into cloud_stripe_events (event_id, type, received_at) values (?, ?, ?)")
    .bind(eventId, type, now).run();
  if (claim.meta.changes !== 0) return "claimed";
  const earlier = await env.DB.prepare("select received_at, applied_at from cloud_stripe_events where event_id = ?")
    .bind(eventId).first<{ received_at: number; applied_at: number | null }>();
  if (earlier?.applied_at != null) return "duplicate";
  if (earlier && now - earlier.received_at < EVENT_CLAIM_STALE_MS) return "in_progress";
  const retaken = await env.DB.prepare("update cloud_stripe_events set received_at = ? where event_id = ? and received_at = ? and applied_at is null")
    .bind(now, eventId, earlier?.received_at ?? 0).run();
  return retaken.meta.changes === 1 ? "claimed" : "in_progress";
}

async function handleStripeWebhook(request: Request, env: CloudEnv, waitUntil: CloudWaitUntil): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const secret = env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    logCloud("cloud.stripe_webhook_not_configured");
    return json({ error: "not configured" }, 503);
  }
  const now = Date.now();
  const rawBody = await request.text();
  if (!await verifyStripeSignature(rawBody, request.headers.get("stripe-signature"), secret, now)) {
    return json({ error: "invalid signature" }, 400);
  }
  let event: StripeObject;
  try {
    event = JSON.parse(rawBody) as StripeObject;
  } catch {
    return json({ error: "invalid body" }, 400);
  }
  const eventId = textOf(event.id);
  const type = textOf(event.type);
  const object = objectOf(objectOf(event.data)?.object);
  if (!eventId || !type || !object) return json({ error: "invalid event" }, 400);

  const claim = await claimStripeEvent(env, eventId, type, now);
  if (claim === "duplicate") return json({ received: true, duplicate: true });
  // Not done, so Stripe asks again later.
  if (claim === "in_progress") return json({ error: "in progress" }, 409);
  try {
    await applyStripeEvent(env, type, object, now, waitUntil);
    await env.DB.prepare("update cloud_stripe_events set applied_at = ? where event_id = ?").bind(Date.now(), eventId).run();
  } catch (error) {
    reportCloudFailure("cloud.stripe_webhook_failed", { type, eventId, status: error instanceof StripeRequestError ? error.status : null });
    // Give the claim back so Stripe's retry runs it again. If this fails too, the stale claim is retaken.
    await env.DB.prepare("delete from cloud_stripe_events where event_id = ?").bind(eventId).run().catch((deleteError: unknown) => {
      reportCloudFailure("cloud.stripe_claim_release_failed", { eventId, message: deleteError instanceof Error ? deleteError.message : "unknown" });
    });
    return json({ error: "try again" }, 500);
  }
  return json({ received: true });
}

/* ---- Public routes ---- */

const RETURN_MESSAGES: Record<string, { heading: string; line: string }> = {
  done: { heading: "You're all set", line: "Your plan will show in ADE in a moment." },
  cancelled: { heading: "Nothing changed", line: "You left checkout before paying." },
  portal: { heading: "Back to ADE", line: "Any changes you made will show in ADE in a moment." },
  card: { heading: "Card saved", line: "You weren't charged. Your free hours will show in ADE in a moment." },
  card_cancelled: { heading: "Nothing changed", line: "You left before saving a card. Your free hours start when your GitHub account is 30 days old." },
};

function returnPage(url: URL, method: string): Response {
  if (method !== "GET") return json({ error: "method not allowed" }, 405);
  // Own keys only: `?to=constructor` or `?to=__proto__` must not read an inherited value.
  const to = url.searchParams.get("to") ?? "";
  const message = Object.hasOwn(RETURN_MESSAGES, to) ? RETURN_MESSAGES[to] : RETURN_MESSAGES.portal;
  const html = brandDocument({
    title: message.heading,
    card: `<p class="sub">${escapeHtml(message.line)}</p>`,
    foot: "You can close this page and go back to ADE.",
  });
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; ${BRAND_IMG_SRC}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "referrer-policy": "no-referrer",
    },
  });
}

/** Stripe's webhook and the page Stripe sends people back to: no bearer, so outside `/cloud`. */
export function isCloudBillingPublicRequest(url: URL): boolean {
  return url.pathname === WEBHOOK_PATH || url.pathname === RETURN_PATH;
}

export async function handleCloudBillingPublicRequest(request: Request, env: CloudEnv, waitUntil?: CloudWaitUntil): Promise<Response> {
  const url = new URL(request.url);
  return url.pathname === WEBHOOK_PATH ? handleStripeWebhook(request, env, waitUntil) : returnPage(url, request.method);
}

/* ---- Extra hours to the meter ---- */

/** Stripe refused a report because this identifier was already counted. */
const isDuplicateReport = (error: unknown): boolean =>
  error instanceof StripeRequestError && error.status === 400 && /identifier/i.test(error.stripeMessage) && /(already|duplicate|exists)/i.test(error.stripeMessage);

/**
 * Each whole extra Small-hour is one report whose identifier is its place in
 * the period, so a retry after a crash can never count an hour twice. The part
 * of an hour left over waits for the next tick. A tick with no account on
 * extra hours is one indexed read.
 */
export async function reportExtraHours(env: CloudEnv, now = Date.now()): Promise<void> {
  const eventName = env.STRIPE_METER_EVENT?.trim();
  if (!eventName || !env.STRIPE_SECRET_KEY?.trim()) return;
  const rows = await env.DB.prepare(`
    select * from cloud_accounts
    where (extra_enabled = 1 or extra_owed_milli > 0) and plan = 'paid' and coalesce(stripe_status, '') <> 'past_due'
  `).all<AccountRow>();
  // Filtered here, not in the query: a `stripe_customer_id` term makes SQLite pick that index and read every customer each minute.
  const accounts = (rows.results ?? []).filter((account) => account.stripe_customer_id && account.stripe_subscription_id);
  if (accounts.length === 0) return;

  const awake = await env.DB.prepare("select * from cloud_computers where deleted_at is null and awake_since is not null and user_id in (select value from json_each(?))")
    .bind(JSON.stringify(accounts.map((account) => account.user_id))).all<ComputerRow>();
  const awakeByUser = groupByUser(awake.results ?? []);

  for (const account of accounts) {
    const live = liveUsedMilli(account, awakeByUser.get(account.user_id) ?? [], now);
    // With the switch off, only what was used before it went off is billed.
    // Earned hours come before extra hours: only what they don't cover is billed.
    const billable = account.extra_enabled === 1 ? extraUsedMilli(account, live) : account.extra_owed_milli;
    const owedHours = Math.floor((billable - account.extra_reported_milli) / MILLI_PER_HOUR);
    let reported = account.extra_reported_milli;
    for (let sent = 0; sent < Math.min(owedHours, MAX_REPORTS_PER_ACCOUNT_TICK); sent += 1) {
      const place = Math.floor(reported / MILLI_PER_HOUR) + 1;
      try {
        await stripeRequest(env, "POST", "/billing/meter_events", {
          event_name: eventName,
          identifier: `ade-extra:${account.stripe_subscription_id}:${account.period_start}:${place}`,
          "payload[stripe_customer_id]": account.stripe_customer_id as string,
          "payload[value]": "1",
        });
      } catch (error) {
        if (!isDuplicateReport(error)) {
          reportCloudFailure("cloud.meter_report_failed", { userId: account.user_id, status: error instanceof StripeRequestError ? error.status : null });
          break;
        }
      }
      // Compare first: a renewal may have reset this count while the report was out.
      const next = reported + MILLI_PER_HOUR;
      const saved = await env.DB.prepare("update cloud_accounts set extra_reported_milli = ?, updated_at = ? where user_id = ? and extra_reported_milli = ?")
        .bind(next, now, account.user_id, reported).run();
      if (saved.meta.changes !== 1) break;
      reported = next;
    }
    // Under a whole hour left: nothing more to report, and the row stops being read each tick.
    if (account.extra_enabled !== 1 && account.extra_owed_milli > 0 && account.extra_owed_milli - reported < MILLI_PER_HOUR) {
      await env.DB.prepare("update cloud_accounts set extra_owed_milli = 0, updated_at = ? where user_id = ? and extra_enabled = 0 and extra_owed_milli = ?")
        .bind(now, account.user_id, account.extra_owed_milli).run();
    }
  }
}

/* ---- Extra disk to its meter ---- */

/** A meter event's timestamp: midday of its day, never in the future. */
const meterTimestamp = (day: string, now: number): string =>
  String(Math.floor(Math.min(Date.parse(`${day}T12:00:00Z`), now) / 1000));

type DiskDayRow = {
  user_id: string;
  day: string;
  peak_gb: number;
  plan_gb: number;
  billable: number;
  send_started_at: number | null;
  billed_gb: number | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  extra_disk_limit_cents: number | null;
  period_start: number;
};

/** Stripe keeps a meter event's identifier for about a day; a send is retried only well inside that. */
const DISK_REPORT_SAFE_WINDOW_MS = 20 * 60 * 60_000;
const DISK_REPORTS_PER_RUN = 200;

/**
 * Each finished UTC day's extra disk, once, from the day's own row: the GB
 * its peak passed the bought plan's disk by, billed only when the row says
 * the day was billable all day (a paid plan in good standing with extra disk
 * on). From the ten-minute owner check, so a failed send is retried soon.
 *
 * - One meter event per day, identified by the subscription and the day.
 *   Stripe drops a repeat of that identifier for about a day, so a send that
 *   timed out is resent only inside that window, with the same value
 *   (`billed_gb` is written before the first send). A day still unconfirmed
 *   after it is never resent blindly: it goes to the owner as a billing
 *   mismatch (`unconfirmed_at`).
 * - A period's extra disk never passes the monthly limit the person set:
 *   a day that would is billed only up to it.
 * - Each row is marked right after its own send succeeds.
 */
export async function reportExtraDiskDays(env: CloudEnv, now = Date.now()): Promise<void> {
  const rows = await env.DB.prepare(`
    select d.user_id, d.day, d.peak_gb, d.plan_gb, d.billable, d.send_started_at, d.billed_gb,
      a.stripe_customer_id, a.stripe_subscription_id, a.extra_disk_limit_cents, a.period_start
    from cloud_disk_days d join cloud_accounts a on a.user_id = d.user_id
    where d.reported_at is null and d.unconfirmed_at is null and d.day < ?
    order by d.day limit ?
  `).bind(utcDay(now), DISK_REPORTS_PER_RUN).all<DiskDayRow>();
  const mark = (row: DiskDayRow, billedGb: number) =>
    env.DB.prepare("update cloud_disk_days set billed_gb = ?, reported_at = ? where user_id = ? and day = ? and reported_at is null")
      .bind(billedGb, now, row.user_id, row.day).run();
  for (const row of rows.results ?? []) {
    const extraGb = Math.max(0, row.peak_gb - row.plan_gb);
    if (row.billable !== 1 || extraGb === 0) {
      await mark(row, 0);
      continue;
    }
    const customer = row.stripe_customer_id;
    const subscription = row.stripe_subscription_id;
    if (!customer || !subscription) {
      // Billable when written, but the subscription is gone now: nothing to bill it to.
      reportCloudFailure("cloud.disk_day_without_subscription", { userId: row.user_id, day: row.day });
      await mark(row, 0);
      continue;
    }
    const eventName = env.STRIPE_DISK_METER_EVENT?.trim();
    // Not set up yet: the day waits, unmarked and never sent, so it is billed once it is.
    if (!eventName || !env.STRIPE_SECRET_KEY?.trim()) continue;
    if (row.send_started_at != null && now - row.send_started_at > DISK_REPORT_SAFE_WINDOW_MS) {
      await env.DB.prepare("update cloud_disk_days set unconfirmed_at = ? where user_id = ? and day = ?").bind(now, row.user_id, row.day).run();
      reportCloudFailure("cloud.disk_meter_unconfirmed", { userId: row.user_id, day: row.day, billedGb: row.billed_gb });
      continue;
    }
    let billGb = row.billed_gb;
    if (row.send_started_at == null || billGb == null) {
      billGb = Math.min(extraGb, await diskRoomUnderLimit(env, row));
      if (billGb === 0) {
        logCloud("cloud.extra_disk_capped", { userId: row.user_id, day: row.day, extraGb });
        await mark(row, 0);
        continue;
      }
      const claimed = await env.DB.prepare("update cloud_disk_days set send_started_at = ?, billed_gb = ? where user_id = ? and day = ? and send_started_at is null")
        .bind(now, billGb, row.user_id, row.day).run();
      // Another owner check claimed this day first: it sends, this run skips it.
      if ((claimed.meta?.changes ?? 0) === 0) continue;
    }
    try {
      await stripeRequest(env, "POST", "/billing/meter_events", {
        event_name: eventName,
        identifier: `ade-disk:${subscription}:${row.day}`,
        timestamp: meterTimestamp(row.day, now),
        "payload[stripe_customer_id]": customer,
        "payload[value]": String(billGb),
      });
    } catch (error) {
      if (!isDuplicateReport(error)) {
        // Retried on the next owner check, inside Stripe's window.
        reportCloudFailure("cloud.disk_meter_report_failed", { userId: row.user_id, status: error instanceof StripeRequestError ? error.status : null });
        continue;
      }
    }
    await mark(row, billGb);
  }
}

/** GB-days of extra disk this row's period may still bill before passing the person's monthly limit. */
async function diskRoomUnderLimit(env: CloudEnv, row: DiskDayRow): Promise<number> {
  if (row.extra_disk_limit_cents == null) return 0;
  const periodStartDay = utcDay(row.period_start);
  // A day from before the current period is held to the 30 days before it.
  const from = row.day >= periodStartDay ? periodStartDay : utcDay(Date.parse(`${row.day}T00:00:00Z`) - (EXTRA_DISK_MONTH_DAYS - 1) * 86_400_000);
  const billed = await env.DB.prepare(`
    select coalesce(sum(billed_gb), 0) as gb from cloud_disk_days
    where user_id = ? and day >= ? and day < ? and billed_gb is not null
  `).bind(row.user_id, from, row.day).first<{ gb: number }>();
  const limitGbDays = extraDiskGbDaysIn(row.extra_disk_limit_cents);
  return Math.max(0, limitGbDays - (billed?.gb ?? 0));
}

/** An account whose extra disk, kept a full month, passes its limit (`checkExtraDiskLimits`). */
export type ExtraDiskOverLimit = { userId: string; extraGb: number; monthCents: number; limitCents: number };

/**
 * The daily check that the promise "up to $X a month" still holds for what
 * the computers hold now (a lowered limit, a plan change). Over it, the
 * person is told once, and the owner's report lists the account; billing
 * itself stays inside the limit (`reportExtraDiskDays`) and growth is refused.
 */
export async function checkExtraDiskLimits(env: CloudEnv, now: number): Promise<ExtraDiskOverLimit[]> {
  const rows = await env.DB.prepare(`
    select a.*, ${accountDiskSql("a.user_id")} as disk_gb
    from cloud_accounts a
    where a.deleted_at is null and ((a.plan = 'paid' and a.extra_disk_state = 'on') or a.extra_disk_over_limit_at is not null)
  `).all<AccountRow & { disk_gb: number }>();
  const over: ExtraDiskOverLimit[] = [];
  for (const account of rows.results ?? []) {
    // Kept a month: a downgrade waiting for the period end counts already.
    const planGb = countedPlanDiskGb(account, boughtPlanIdOf(account));
    const extraGb = Math.max(0, account.disk_gb - planGb);
    const limitCents = account.extra_disk_limit_cents ?? 0;
    const monthCents = Math.ceil(extraDiskMonthMicros(extraGb) / CENT_MICROS);
    const isOver = account.plan === "paid" && account.extra_disk_state === "on" && !extraDiskMonthFits(extraGb, limitCents);
    if (!isOver) {
      if (account.extra_disk_over_limit_at != null) {
        await env.DB.prepare("update cloud_accounts set extra_disk_over_limit_at = null where user_id = ?").bind(account.user_id).run();
      }
      continue;
    }
    over.push({ userId: account.user_id, extraGb, monthCents, limitCents });
    if (account.extra_disk_over_limit_at != null) continue;
    await env.DB.prepare("update cloud_accounts set extra_disk_over_limit_at = ? where user_id = ?").bind(now, account.user_id).run();
    await sendCloudEmail(env, {
      userId: account.user_id,
      subject: "Your ADE Cloud extra disk is over your limit",
      text: `Your computers hold ${extraGb} GB more than your plan's ${planGb} GB at one time. For a month that is about ${formatCloudCents(monthCents)}, more than the ${formatCloudCents(limitCents)} limit you set. ADE Cloud bills no more than your limit, and your disks can't grow until it fits. Delete a computer you no longer use, or raise the limit in Settings.`,
    });
  }
  return over;
}
