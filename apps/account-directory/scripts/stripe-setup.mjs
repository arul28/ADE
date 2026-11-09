#!/usr/bin/env node
/**
 * Creates or finds what ADE Cloud sells in the Stripe account the key belongs
 * to (live or sandbox), and prints the ids for wrangler.jsonc. Safe to rerun:
 * each object is found by a fixed id, lookup key or event name first.
 *
 *   STRIPE_SECRET_KEY=... node scripts/stripe-setup.mjs
 */

const API = "https://api.stripe.com/v1";
const API_VERSION = "2026-10-28.endive";
const PRODUCT_ID = "ade_cloud";
const PRODUCT_TAX_CODE = "txcd_10103001";
const PLAN_LOOKUP_KEY = "ade_cloud_plan_monthly";
const EXTRA_LOOKUP_KEY = "ade_cloud_extra_hours_monthly";
const METER_EVENT = "ade_cloud_small_hours";

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

async function ensureProduct() {
  try {
    const found = await stripe("GET", `/products/${PRODUCT_ID}`);
    if (found.tax_code !== PRODUCT_TAX_CODE || !found.active) {
      return stripe("POST", `/products/${PRODUCT_ID}`, { tax_code: PRODUCT_TAX_CODE, active: "true" });
    }
    return found;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  return stripe("POST", "/products", { id: PRODUCT_ID, name: "ADE Cloud", tax_code: PRODUCT_TAX_CODE });
}

async function ensureMeter() {
  let startingAfter;
  for (;;) {
    const page = await stripe("GET", `/billing/meters?status=active&limit=100${startingAfter ? `&starting_after=${startingAfter}` : ""}`);
    const found = page.data.find((meter) => meter.event_name === METER_EVENT);
    if (found) return found;
    if (!page.has_more) break;
    startingAfter = page.data.at(-1).id;
  }
  return stripe("POST", "/billing/meters", {
    display_name: "ADE Cloud extra Small-hours",
    event_name: METER_EVENT,
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

async function ensurePlanPrice(product) {
  return (await findPrice(PLAN_LOOKUP_KEY)) ?? stripe("POST", "/prices", {
    product: product.id,
    lookup_key: PLAN_LOOKUP_KEY,
    currency: "usd",
    unit_amount: "500",
    tax_behavior: "exclusive",
    "recurring[interval]": "month",
    "recurring[usage_type]": "licensed",
    nickname: "ADE Cloud plan",
  });
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

const product = await ensureProduct();
const meter = await ensureMeter();
const planPrice = await ensurePlanPrice(product);
const extraPrice = await ensureExtraPrice(product, meter);

console.log(JSON.stringify({
  livemode: planPrice.livemode,
  product: product.id,
  meter: meter.id,
  STRIPE_PLAN_PRICE_ID: planPrice.id,
  STRIPE_EXTRA_PRICE_ID: extraPrice.id,
  STRIPE_METER_EVENT: meter.event_name,
}, null, 2));
