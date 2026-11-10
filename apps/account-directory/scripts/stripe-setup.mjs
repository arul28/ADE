#!/usr/bin/env node
/**
 * Creates or finds what ADE Cloud sells in the Stripe account the key belongs
 * to (live or sandbox), and prints the ids for wrangler.jsonc. Safe to rerun:
 * each object is found by a fixed id, lookup key or event name first.
 *
 *   STRIPE_SECRET_KEY=... node scripts/stripe-setup.mjs
 *
 * What it sells (docs/plans/ade-cloud-plans-and-disk.md): Plus at $5 and Pro
 * at $20 a month; extra hours on their own meter (graduated); extra disk on a
 * second meter, $1 for each 10 GB a month counted by the day; and a billing
 * portal setup that switches between Plus and Pro (an upgrade now, prorated;
 * a downgrade at the period end).
 */

const API = "https://api.stripe.com/v1";
const API_VERSION = "2026-10-28.endive";
const PRODUCT_ID = "ade_cloud";
/** Pro is its own product: the portal switches plans between products, one price each per interval. */
const PRO_PRODUCT_ID = "ade_cloud_pro";
const PRODUCT_TAX_CODE = "txcd_10103001";
const PLAN_LOOKUP_KEY = "ade_cloud_plan_monthly";
const PRO_LOOKUP_KEY = "ade_cloud_pro_monthly";
const EXTRA_LOOKUP_KEY = "ade_cloud_extra_hours_monthly";
const DISK_LOOKUP_KEY = "ade_cloud_extra_disk_monthly";
const METER_EVENT = "ade_cloud_small_hours";
const DISK_METER_EVENT = "ade_cloud_extra_disk_gb_days";
/** Finds this script's portal setup again on a rerun. */
const PORTAL_METADATA = "plans-v1";

const key = process.env.STRIPE_SECRET_KEY?.trim();
if (!key) {
  console.error("Set STRIPE_SECRET_KEY to the key of the account to set up.");
  process.exit(1);
}

async function stripe(method, path, params) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      "stripe-version": API_VERSION,
      ...(params ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(params ? { body: new URLSearchParams(params).toString() } : {}),
  });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(`${method} ${path}: ${response.status} ${body?.error?.message ?? ""}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function ensureProduct(id, name) {
  try {
    const found = await stripe("GET", `/products/${id}`);
    if (found.tax_code !== PRODUCT_TAX_CODE || !found.active) {
      return stripe("POST", `/products/${id}`, { tax_code: PRODUCT_TAX_CODE, active: "true" });
    }
    return found;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  return stripe("POST", "/products", { id, name, tax_code: PRODUCT_TAX_CODE });
}

async function ensureMeter(eventName, displayName) {
  let startingAfter;
  for (;;) {
    const page = await stripe("GET", `/billing/meters?status=active&limit=100${startingAfter ? `&starting_after=${startingAfter}` : ""}`);
    const found = page.data.find((meter) => meter.event_name === eventName);
    if (found) return found;
    if (!page.has_more) break;
    startingAfter = page.data.at(-1).id;
  }
  return stripe("POST", "/billing/meters", {
    display_name: displayName,
    event_name: eventName,
    "default_aggregation[formula]": "sum",
    "customer_mapping[type]": "by_id",
    "customer_mapping[event_payload_key]": "stripe_customer_id",
    "value_settings[event_payload_key]": "value",
  });
}

async function findPrice(lookupKey) {
  const page = await stripe("GET", `/prices?active=true&limit=1&lookup_keys[]=${lookupKey}`);
  return page.data[0] ?? null;
}

/** A price can't change product: one on the wrong product gives its lookup key to a new one and is archived. */
async function ensurePlanPrice(product, lookupKey, cents, nickname) {
  const found = await findPrice(lookupKey);
  if (found && found.product === product.id) return found;
  const created = await stripe("POST", "/prices", {
    product: product.id,
    lookup_key: lookupKey,
    ...(found ? { transfer_lookup_key: "true" } : {}),
    currency: "usd",
    unit_amount: String(cents),
    tax_behavior: "exclusive",
    "recurring[interval]": "month",
    "recurring[usage_type]": "licensed",
    nickname,
  });
  if (found) await stripe("POST", `/prices/${found.id}`, { active: "false" });
  return created;
}

/** $1 for each 10 GB a month, by the GB-day: a 30-day month of 10 GB is 300 GB-days, 100 cents. */
async function ensureDiskPrice(product, meter) {
  return (await findPrice(DISK_LOOKUP_KEY)) ?? stripe("POST", "/prices", {
    product: product.id,
    lookup_key: DISK_LOOKUP_KEY,
    currency: "usd",
    tax_behavior: "exclusive",
    unit_amount_decimal: "0.333333333333",
    "recurring[interval]": "month",
    "recurring[usage_type]": "metered",
    "recurring[meter]": meter.id,
    nickname: "ADE Cloud extra disk",
  });
}

/**
 * The portal: switch between Plus and Pro (upgrade now and invoiced at once,
 * downgrade at the period end), change the card, cancel at the period end,
 * see invoices.
 */
async function ensurePortalConfiguration(product, proProduct, plusPrice, proPrice) {
  const params = {
    "business_profile[headline]": "ADE Cloud",
    "features[invoice_history][enabled]": "true",
    // Stripe refuses plan switching without it.
    "features[payment_method_update][enabled]": "true",
    "features[subscription_cancel][enabled]": "true",
    "features[subscription_cancel][mode]": "at_period_end",
    "features[subscription_update][enabled]": "true",
    "features[subscription_update][default_allowed_updates][0]": "price",
    "features[subscription_update][proration_behavior]": "always_invoice",
    "features[subscription_update][products][0][product]": product.id,
    "features[subscription_update][products][0][prices][0]": plusPrice.id,
    "features[subscription_update][products][1][product]": proProduct.id,
    "features[subscription_update][products][1][prices][0]": proPrice.id,
    "features[subscription_update][schedule_at_period_end][conditions][0][type]": "decreasing_item_amount",
    "metadata[ade_cloud]": PORTAL_METADATA,
  };
  const page = await stripe("GET", "/billing_portal/configurations?active=true&limit=100");
  const found = page.data.find((configuration) => configuration.metadata?.ade_cloud === PORTAL_METADATA);
  return found ? stripe("POST", `/billing_portal/configurations/${found.id}`, params) : stripe("POST", "/billing_portal/configurations", params);
}

/** 1 cent per Small-hour, 0.85 cents after 1,000 in a month. */
async function ensureExtraPrice(product, meter) {
  return (await findPrice(EXTRA_LOOKUP_KEY)) ?? stripe("POST", "/prices", {
    product: product.id,
    lookup_key: EXTRA_LOOKUP_KEY,
    currency: "usd",
    tax_behavior: "exclusive",
    billing_scheme: "tiered",
    tiers_mode: "graduated",
    "tiers[0][up_to]": "1000",
    "tiers[0][unit_amount_decimal]": "1",
    "tiers[1][up_to]": "inf",
    "tiers[1][unit_amount_decimal]": "0.85",
    "recurring[interval]": "month",
    "recurring[usage_type]": "metered",
    "recurring[meter]": meter.id,
    nickname: "ADE Cloud extra hours",
  });
}

const product = await ensureProduct(PRODUCT_ID, "ADE Cloud");
const proProduct = await ensureProduct(PRO_PRODUCT_ID, "ADE Cloud Pro");
const meter = await ensureMeter(METER_EVENT, "ADE Cloud extra Small-hours");
const diskMeter = await ensureMeter(DISK_METER_EVENT, "ADE Cloud extra disk GB-days");
const planPrice = await ensurePlanPrice(product, PLAN_LOOKUP_KEY, 500, "ADE Cloud Plus");
const proPrice = await ensurePlanPrice(proProduct, PRO_LOOKUP_KEY, 2000, "ADE Cloud Pro");
const extraPrice = await ensureExtraPrice(product, meter);
const diskPrice = await ensureDiskPrice(product, diskMeter);
const portal = await ensurePortalConfiguration(product, proProduct, planPrice, proPrice);

console.log(JSON.stringify({
  livemode: planPrice.livemode,
  product: product.id,
  proProduct: proProduct.id,
  meter: meter.id,
  diskMeter: diskMeter.id,
  STRIPE_PLAN_PRICE_ID: planPrice.id,
  STRIPE_PRO_PRICE_ID: proPrice.id,
  STRIPE_EXTRA_PRICE_ID: extraPrice.id,
  STRIPE_METER_EVENT: meter.event_name,
  STRIPE_DISK_PRICE_ID: diskPrice.id,
  STRIPE_DISK_METER_EVENT: diskMeter.event_name,
  STRIPE_PORTAL_CONFIG_ID: portal.id,
}, null, 2));
