import { sendCloudEmail } from "./email";
import { json } from "./http";
import {
  accountRules,
  applyCloudPlanChange,
  groupByUser,
  extraActive,
  extraOwedMilli,
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

function billingConfig(env: CloudEnv): { planPrice: string; extraPrice: string } {
  const planPrice = env.STRIPE_PLAN_PRICE_ID?.trim();
  const extraPrice = env.STRIPE_EXTRA_PRICE_ID?.trim();
  if (!planPrice || !extraPrice || !env.STRIPE_SECRET_KEY?.trim()) {
    logCloud("cloud.billing_not_configured");
    throw unavailable();
  }
  return { planPrice, extraPrice };
}

/** One Stripe customer per account, even when two checkouts start at once. */
async function ensureCustomer(env: CloudEnv, account: AccountRow, now: number): Promise<string> {
  if (account.stripe_customer_id) return account.stripe_customer_id;
  const customer = await stripeRequest(env, "POST", "/customers", { "metadata[ade_user_id]": account.user_id }, `ade-cloud-customer-${account.user_id}`);
  const id = textOf(customer.id);
  if (!id) throw unavailable();
  await applyCloudPlanChange(env, account.user_id, { stripeCustomerId: id }, now);
  return id;
}

/** A person with two open Checkout tabs must not be able to buy twice. */
async function expireOpenCheckouts(env: CloudEnv, customer: string): Promise<void> {
  const open = await stripeRequest(env, "GET", `/checkout/sessions?customer=${encodeURIComponent(customer)}&status=open&limit=10`);
  for (const session of (open.data as StripeObject[] | undefined) ?? []) {
    const id = textOf(session.id);
    if (id) await stripeRequest(env, "POST", `/checkout/sessions/${id}/expire`, {});
  }
}

export async function createCheckoutUrl(env: CloudEnv, userId: string, origin: string, now: number): Promise<{ url: string }> {
  const { planPrice, extraPrice } = billingConfig(env);
  const account = await loadAccount(env, userId, now);
  if (account.plan === "paid") throw new CloudBillingError("already_paid", "You're already on the paid plan.", 409);
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
      logCloud("cloud.checkout_failed", { status: error.status, message: error.stripeMessage });
      throw unavailable();
    }
    throw error;
  }
}

export async function createPortalUrl(env: CloudEnv, userId: string, origin: string, now: number): Promise<{ url: string }> {
  const account = await loadAccount(env, userId, now);
  if (!account.stripe_customer_id) throw new CloudBillingError("no_billing", "There's nothing to manage until you've bought a plan.", 409);
  try {
    const session = await stripeRequest(env, "POST", "/billing_portal/sessions", {
      customer: account.stripe_customer_id,
      return_url: `${origin}${RETURN_PATH}?to=portal`,
    });
    const url = textOf(session.url);
    if (!url) throw unavailable();
    return { url };
  } catch (error) {
    if (error instanceof StripeRequestError) {
      logCloud("cloud.portal_failed", { status: error.status, message: error.stripeMessage });
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
  await applyCloudPlanChange(env, userId, { extraEnabled: enabled }, now);
  if (enabled || owed > 0) {
    await env.DB.prepare("update cloud_accounts set extra_owed_milli = ?, updated_at = ? where user_id = ?").bind(owed, now, userId).run();
  }
}

/** Ends the account's subscription now, for a deleted account. Already gone counts as done. */
export async function cancelAccountSubscription(env: Pick<CloudEnv, "DB" | "STRIPE_SECRET_KEY">, account: Pick<AccountRow, "user_id" | "stripe_subscription_id">, now: number): Promise<void> {
  if (!account.stripe_subscription_id) return;
  try {
    await stripeRequest(env, "DELETE", `/subscriptions/${encodeURIComponent(account.stripe_subscription_id)}`);
  } catch (error) {
    if (!(error instanceof StripeRequestError && error.status === 404)) throw error;
  }
  await env.DB.prepare("update cloud_accounts set plan = 'free', stripe_subscription_id = null, stripe_status = null, extra_enabled = 0, extra_owed_milli = 0, cancel_at_period_end = 0, updated_at = ? where user_id = ?")
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
  /** Seconds, from the plan's own item. Null only if Stripe's shape changed. */
  periodStart: number | null;
  periodEnd: number | null;
  hasThreshold: boolean;
};

async function readSubscription(env: CloudEnv, id: string): Promise<SubscriptionFacts> {
  const subscription = await stripeRequest(env, "GET", `/subscriptions/${encodeURIComponent(id)}`);
  const items = (objectOf(subscription.items)?.data as StripeObject[] | undefined) ?? [];
  const planItem = items.find((item) => objectOf(item.price)?.id === env.STRIPE_PLAN_PRICE_ID?.trim()) ?? items[0];
  const metadata = objectOf(subscription.metadata);
  return {
    id,
    status: textOf(subscription.status) ?? "unknown",
    customer: idOf(subscription.customer),
    userId: textOf(metadata?.ade_user_id),
    cancelAtPeriodEnd: subscription.cancel_at_period_end === true || subscription.cancel_at != null,
    periodStart: typeof planItem?.current_period_start === "number" ? planItem.current_period_start : null,
    periodEnd: typeof planItem?.current_period_end === "number" ? planItem.current_period_end : null,
    hasThreshold: objectOf(subscription.billing_thresholds)?.amount_gte != null,
  };
}

const periodChange = (subscription: SubscriptionFacts): Pick<CloudPlanChange, "periodStart" | "periodEnd"> =>
  subscription.periodStart != null && subscription.periodEnd != null
    ? { periodStart: subscription.periodStart * 1000, periodEnd: subscription.periodEnd * 1000 }
    : {};

async function userForSubscription(env: CloudEnv, subscription: SubscriptionFacts): Promise<string | null> {
  if (subscription.userId) return subscription.userId;
  if (!subscription.customer) return null;
  const row = await env.DB.prepare("select user_id from cloud_accounts where stripe_customer_id = ?")
    .bind(subscription.customer).first<{ user_id: string }>();
  return row?.user_id ?? null;
}

/** Banner and email, once, when a payment fails or a paid invoice brings the plan back. */
async function announceChange(env: CloudEnv, before: AccountRow, after: AccountRow, now: number): Promise<void> {
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
    await env.DB.prepare("update cloud_accounts set billing_restored_at = ?, updated_at = ? where user_id = ?").bind(now, now, after.user_id).run();
    logCloud("cloud.billing_restored", { userId: after.user_id });
    await sendCloudEmail(env, {
      userId: after.user_id,
      subject: "Your ADE Cloud plan is back",
      text: "Your payment went through, so your plan and its hours are back.",
    });
  }
}

async function applyAndAnnounce(env: CloudEnv, before: AccountRow, change: CloudPlanChange, now: number): Promise<void> {
  const after = await applyCloudPlanChange(env, before.user_id, change, now);
  await announceChange(env, before, after, now);
}

/** Matches the account to what Stripe says about its subscription right now. */
async function syncSubscription(env: CloudEnv, subscriptionId: string | null, now: number, paidInvoice?: StripeObject): Promise<void> {
  if (!subscriptionId) return;
  const subscription = await readSubscription(env, subscriptionId);
  const userId = await userForSubscription(env, subscription);
  if (!userId) {
    logCloud("cloud.stripe_unknown_subscription", { subscriptionId });
    return;
  }
  const account = await loadAccount(env, userId, now);
  // Before Checkout is recorded, or a subscription this account has moved on from.
  if (account.stripe_subscription_id !== subscription.id) return;

  const { status, cancelAtPeriodEnd } = subscription;
  // A Checkout whose payment was still pending, now paid: the plan starts here.
  if ((status === "active" || status === "trialing") && account.plan !== "paid" && account.stripe_status === "incomplete") {
    await applyAndAnnounce(env, account, { plan: "paid", ...periodChange(subscription), stripeStatus: status, cancelAtPeriodEnd }, now);
    await ensureThreshold(env, subscription);
    return;
  }
  if (status === "canceled" || status === "incomplete_expired") {
    await applyAndAnnounce(env, account, { plan: "free", stripeSubscriptionId: null, stripeStatus: null, cancelAtPeriodEnd: false }, now);
    return;
  }
  if (status === "past_due" || status === "unpaid") {
    await applyAndAnnounce(env, account, { stripeStatus: "past_due", cancelAtPeriodEnd }, now);
    return;
  }
  if (status !== "active" && status !== "trialing") return;

  // A renewal's invoice covers the period that just ended, so it ends where the current one starts.
  const isRenewal = paidInvoice?.billing_reason === "subscription_cycle" && paidInvoice.period_end === subscription.periodStart;
  const movesPeriod = isRenewal || account.stripe_status === "past_due";
  await applyAndAnnounce(env, account, {
    stripeStatus: status,
    cancelAtPeriodEnd,
    ...(movesPeriod ? periodChange(subscription) : {}),
  }, now);
}

/** Stripe refuses a threshold at Checkout on these subscriptions; it accepts one afterward. */
async function ensureThreshold(env: CloudEnv, subscription: SubscriptionFacts): Promise<void> {
  if (subscription.hasThreshold) return;
  await stripeRequest(env, "POST", `/subscriptions/${encodeURIComponent(subscription.id)}`, {
    "billing_thresholds[amount_gte]": EXTRA_THRESHOLD_CENTS,
    "billing_thresholds[reset_billing_cycle_anchor]": "false",
  });
}

async function onCheckoutCompleted(env: CloudEnv, session: StripeObject, now: number): Promise<void> {
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
      }, now);
    }
    return;
  }
  if (subscription.status !== "active" && subscription.status !== "trialing") return;
  const account = await loadAccount(env, userId, now);

  if (account.plan === "paid" && account.stripe_subscription_id && account.stripe_subscription_id !== subscription.id) {
    // Two Checkouts finished: keep the first plan and don't leave the person paying twice.
    await stripeRequest(env, "DELETE", `/subscriptions/${encodeURIComponent(subscription.id)}`);
    logCloud("cloud.duplicate_subscription_cancelled", { userId, subscriptionId });
    await sendCloudEmail(env, { owner: true, subject: "ADE Cloud double purchase to refund", text: `Subscription ${subscription.id} duplicated an existing plan and was cancelled. Refund its first invoice.` });
    return;
  }
  if (account.stripe_subscription_id !== subscription.id || account.plan !== "paid") {
    await applyAndAnnounce(env, account, {
      plan: "paid",
      ...periodChange(subscription),
      stripeCustomerId: subscription.customer ?? idOf(session.customer),
      stripeSubscriptionId: subscription.id,
      stripeStatus: subscription.status,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    }, now);
  }
  await ensureThreshold(env, subscription);
}

const invoiceSubscriptionId = (invoice: StripeObject): string | null =>
  idOf(objectOf(objectOf(invoice.parent)?.subscription_details)?.subscription) ?? idOf(invoice.subscription);

async function applyStripeEvent(env: CloudEnv, type: string, object: StripeObject, now: number): Promise<void> {
  if (type === "checkout.session.completed") return onCheckoutCompleted(env, object, now);
  if (type === "customer.subscription.updated" || type === "customer.subscription.deleted") return syncSubscription(env, idOf(object.id), now);
  if (type === "invoice.paid") return syncSubscription(env, invoiceSubscriptionId(object), now, object);
  if (type === "invoice.payment_failed") return syncSubscription(env, invoiceSubscriptionId(object), now);
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

async function handleStripeWebhook(request: Request, env: CloudEnv): Promise<Response> {
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
    await applyStripeEvent(env, type, object, now);
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

const RETURN_MESSAGES: Record<string, string> = {
  done: "Thanks. Your plan will show in ADE in a moment.",
  cancelled: "Nothing changed.",
  portal: "Any changes you made will show in ADE in a moment.",
};

function returnPage(url: URL, method: string): Response {
  if (method !== "GET") return json({ error: "method not allowed" }, 405);
  const message = RETURN_MESSAGES[url.searchParams.get("to") ?? ""] ?? RETURN_MESSAGES.portal;
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ADE</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#111;color:#eee;text-align:center;padding:24px}p{margin:.25em 0}.dim{color:#999}</style><main><p>${message}</p><p class="dim">You can close this tab and go back to ADE.</p></main></html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" },
  });
}

/** Stripe's webhook and the page Stripe sends people back to: no bearer, so outside `/cloud`. */
export function isCloudBillingPublicRequest(url: URL): boolean {
  return url.pathname === WEBHOOK_PATH || url.pathname === RETURN_PATH;
}

export async function handleCloudBillingPublicRequest(request: Request, env: CloudEnv): Promise<Response> {
  const url = new URL(request.url);
  return url.pathname === WEBHOOK_PATH ? handleStripeWebhook(request, env) : returnPage(url, request.method);
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
    const billable = account.extra_enabled === 1 ? live - account.included_milli : account.extra_owed_milli;
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
