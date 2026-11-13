#!/usr/bin/env node
/**
 * Creates or finds what ADE Cloud sells in the Stripe account the key belongs
 * to (live or sandbox), and prints the ids for wrangler.jsonc. Safe to rerun:
 * each object is found by a fixed id, lookup key or event name first.
 *
 *   STRIPE_SECRET_KEY=... node scripts/stripe-setup.mjs
 *
 * What it sells (the owner's plan table of 2026-11-13): Plus at $5, Pro at
 * $20 and Max at $50 a month; extra hours on their own meter, a flat price per
 * plan (2 cents an hour on Plus, 1.5 on Pro, 1.2 on Max), all three prices on
 * the one meter; extra disk on a second meter, $2 for each 10 GB a month
 * counted by the day; and a billing portal setup (card, cancel at the period
 * end, invoices, and switching plans where Stripe allows it).
 *
 * Each of these is its own product, because Checkout names a line by its
 * product: "ADE Cloud Plus", "ADE Cloud Pro", "ADE Cloud Max", "Extra hours"
 * and "Extra disk", each with a one-line description of what it includes or
 * costs. Managed Payments refuses Checkout's `custom_text`, so the products
 * carry every word Checkout shows. A rerun brings names and descriptions up to
 * date. A price can't change product: one found on the wrong product (or
 * shaped differently) gives its lookup key to a new one and is archived, and
 * subscriptions that already hold it keep billing on it.
 *
 * The extra-hours price from before Cloud 7 (1 cent, 0.85 after 1,000 hours,
 * lookup key `ade_cloud_extra_hours_monthly`) is left as it is: subscriptions
 * that hold it keep billing on it until the Worker moves them to their plan's
 * price, at their next renewal or plan change.
 */

/**
 * What Plus, Pro and Max include and cost, as the products say it. A copy of
 * `CLOUD_PLANS` in `src/cloud/plans.ts`, which the Worker enforces: the script
 * stops before any Stripe call when the two differ (`checkPlanNumbers`).
 * `extraHourCents` is each plan's extra-hours price.
 */
const PLAN_NUMBERS = {
  plus: { hours: 300, diskGb: 30, phoneMinutes: 30, extraHourCents: 2, cents: 500 },
  pro: { hours: 1600, diskGb: 80, phoneMinutes: 160, extraHourCents: 1.5, cents: 2000 },
  max: { hours: 5000, diskGb: 175, phoneMinutes: 500, extraHourCents: 1.2, cents: 5000 },
};
const planDescription = ({ hours, diskGb, extraHourCents }) =>
  `${hours.toLocaleString("en-US")} hours a month and ${diskGb} GB of disk, as many computers as you like, every size with Android and Docker. Extra hours ${extraHourCents}¢ each, only if you turn them on.`;

/**
 * Fails when `PLAN_NUMBERS` and `CLOUD_PLANS` differ, so Stripe never sells
 * other numbers than the Worker gives. Reads `plans.ts` with Node's type
 * stripping (Node 22.18 or newer).
 */
async function checkPlanNumbers() {
  let plans;
  try {
    ({ CLOUD_PLANS: plans } = await import(new URL("../src/cloud/plans.ts", import.meta.url).href));
  } catch (error) {
    console.error(`Couldn't read src/cloud/plans.ts to check the plan numbers (needs Node 22.18 or newer): ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
  const differences = [];
  for (const [id, numbers] of Object.entries(PLAN_NUMBERS)) {
    const plan = plans[id];
    const expected = { hours: plan.includedMilli / 1000, diskGb: plan.diskGb, phoneMinutes: plan.phoneMinutes, extraHourCents: plan.extraHourCents, cents: plan.priceUsd * 100 };
    for (const [field, value] of Object.entries(expected)) {
      if (numbers[field] !== value) differences.push(`${id}.${field}: this script says ${numbers[field]}, plans.ts says ${value}`);
    }
  }
  if (differences.length) {
    console.error(`The plan numbers here differ from src/cloud/plans.ts; fix PLAN_NUMBERS first:\n${differences.join("\n")}`);
    process.exit(1);
  }
}

const API = "https://api.stripe.com/v1";
const API_VERSION = "2026-10-28.endive";
const PRODUCT_TAX_CODE = "txcd_10103001";
/** Each plan is its own product: the portal switches plans between products, one price each per interval. */
const PRODUCTS = {
  plus: {
    id: "ade_cloud",
    name: "ADE Cloud Plus",
    description: planDescription(PLAN_NUMBERS.plus),
  },
  pro: {
    id: "ade_cloud_pro",
    name: "ADE Cloud Pro",
    description: planDescription(PLAN_NUMBERS.pro),
  },
  max: {
    id: "ade_cloud_max",
    name: "ADE Cloud Max",
    description: planDescription(PLAN_NUMBERS.max),
  },
  extraHours: {
    id: "ade_cloud_extra_hours",
    name: "Extra hours",
    description: `Hours past your plan's, per hour: ${PLAN_NUMBERS.plus.extraHourCents}¢ on Plus, ${PLAN_NUMBERS.pro.extraHourCents}¢ on Pro, ${PLAN_NUMBERS.max.extraHourCents}¢ on Max. You pay only if you turn extra hours on in ADE.`,
    unitLabel: "hour",
  },
  extraDisk: {
    id: "ade_cloud_extra_disk",
    name: "Extra disk",
    description: "$2 per 10 GB a month, counted by the day, on disk past your plan's. You pay only if you turn extra disk on in ADE.",
    unitLabel: "GB-days",
  },
};
const PLAN_LOOKUP_KEY = "ade_cloud_plan_monthly";
const PRO_LOOKUP_KEY = "ade_cloud_pro_monthly";
const MAX_LOOKUP_KEY = "ade_cloud_max_monthly";
/** Each plan's extra-hours price. The first one (`ade_cloud_extra_hours_monthly`, graduated) is left alone. */
const EXTRA_LOOKUP_KEYS = {
  plus: "ade_cloud_extra_hours_plus_monthly",
  pro: "ade_cloud_extra_hours_pro_monthly",
  max: "ade_cloud_extra_hours_max_monthly",
};
const DISK_LOOKUP_KEY = "ade_cloud_extra_disk_monthly";
const METER_EVENT = "ade_cloud_small_hours";
const DISK_METER_EVENT = "ade_cloud_extra_disk_gb_days";
/** Finds this script's portal setup again on a rerun. */
const PORTAL_METADATA = "plans-v1";

await checkPlanNumbers();

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

/** Finds or makes the product, then brings its name, description, unit and tax code up to date. */
async function ensureProduct({ id, name, description, unitLabel }) {
  const wanted = { name, description, tax_code: PRODUCT_TAX_CODE, ...(unitLabel ? { unit_label: unitLabel } : {}) };
  let found = null;
  try {
    found = await stripe("GET", `/products/${id}`);
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  if (!found) return stripe("POST", "/products", { id, ...wanted });
  const stale = !found.active || Object.entries(wanted).some(([field, value]) => (found[field] ?? "") !== value);
  return stale ? stripe("POST", `/products/${id}`, { ...wanted, active: "true" }) : found;
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

/**
 * The price under `lookupKey`: the one found when it is on `product` and
 * `isShaped` says it is right, else a new one made from `params` that takes
 * the lookup key; the old one is archived.
 */
async function ensurePrice(product, lookupKey, params, isShaped) {
  const found = await findPrice(lookupKey);
  if (found && found.product === product.id && isShaped(found)) return found;
  const created = await stripe("POST", "/prices", {
    product: product.id,
    lookup_key: lookupKey,
    ...(found ? { transfer_lookup_key: "true" } : {}),
    currency: "usd",
    tax_behavior: "exclusive",
    ...params,
  });
  if (found) await stripe("POST", `/prices/${found.id}`, { active: "false" });
  return created;
}

const ensurePlanPrice = (product, lookupKey, cents, nickname) => ensurePrice(product, lookupKey, {
  unit_amount: String(cents),
  "recurring[interval]": "month",
  "recurring[usage_type]": "licensed",
  nickname,
}, () => true);

/** One plan's flat extra-hours price per Small-hour, on the shared hours meter: "$0.02 per hour" on Checkout. */
const ensureExtraPrice = (product, meter, plan) => {
  const cents = String(PLAN_NUMBERS[plan].extraHourCents);
  const name = PRODUCTS[plan].name;
  return ensurePrice(product, EXTRA_LOOKUP_KEYS[plan], {
    unit_amount_decimal: cents,
    "recurring[interval]": "month",
    "recurring[usage_type]": "metered",
    "recurring[meter]": meter.id,
    nickname: `${name} extra hours`,
  }, (price) => price.billing_scheme === "per_unit" && Number(price.unit_amount_decimal) === Number(cents) && price.recurring?.meter === meter.id);
};

/**
 * $2 for each 10 GB a month, by the GB-day: a 30-day month of 10 GB is 300
 * GB-days, 200 cents. Checkout shows "$0.02 for every 3 GB-days" instead of a
 * fraction of a cent per GB-day. The period's total is rounded down, so Stripe
 * never bills more than ADE counted (at most 2 GB-days a period, under 2
 * cents, go unbilled). The $1 price this replaces is archived; subscriptions
 * that hold it keep it until the Worker moves them at their next renewal.
 */
const ensureDiskPrice = (product, meter) => ensurePrice(product, DISK_LOOKUP_KEY, {
  unit_amount: "2",
  "transform_quantity[divide_by]": "3",
  "transform_quantity[round]": "down",
  "recurring[interval]": "month",
  "recurring[usage_type]": "metered",
  "recurring[meter]": meter.id,
  nickname: "ADE Cloud extra disk",
}, (price) => price.unit_amount === 2 && price.transform_quantity?.divide_by === 3 && price.recurring?.meter === meter.id);

/**
 * The portal: switch between Plus, Pro and Max (upgrade now and invoiced at
 * once, downgrade at the period end) where Stripe allows it, change the card,
 * cancel at the period end, see invoices. ADE itself switches plans
 * (`billing.ts` `changePaidPlan`): Stripe refuses a portal switch on a
 * subscription with more than one item.
 */
async function ensurePortalConfiguration(product, proProduct, maxProduct, plusPrice, proPrice, maxPrice) {
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
    "features[subscription_update][products][2][product]": maxProduct.id,
    "features[subscription_update][products][2][prices][0]": maxPrice.id,
    "features[subscription_update][schedule_at_period_end][conditions][0][type]": "decreasing_item_amount",
    "metadata[ade_cloud]": PORTAL_METADATA,
  };
  const page = await stripe("GET", "/billing_portal/configurations?active=true&limit=100");
  const found = page.data.find((configuration) => configuration.metadata?.ade_cloud === PORTAL_METADATA);
  return found ? stripe("POST", `/billing_portal/configurations/${found.id}`, params) : stripe("POST", "/billing_portal/configurations", params);
}

const product = await ensureProduct(PRODUCTS.plus);
const proProduct = await ensureProduct(PRODUCTS.pro);
const maxProduct = await ensureProduct(PRODUCTS.max);
const extraProduct = await ensureProduct(PRODUCTS.extraHours);
const diskProduct = await ensureProduct(PRODUCTS.extraDisk);
const meter = await ensureMeter(METER_EVENT, "ADE Cloud extra Small-hours");
const diskMeter = await ensureMeter(DISK_METER_EVENT, "ADE Cloud extra disk GB-days");
const planPrice = await ensurePlanPrice(product, PLAN_LOOKUP_KEY, PLAN_NUMBERS.plus.cents, "ADE Cloud Plus");
const proPrice = await ensurePlanPrice(proProduct, PRO_LOOKUP_KEY, PLAN_NUMBERS.pro.cents, "ADE Cloud Pro");
const maxPrice = await ensurePlanPrice(maxProduct, MAX_LOOKUP_KEY, PLAN_NUMBERS.max.cents, "ADE Cloud Max");
const extraPrices = {
  plus: await ensureExtraPrice(extraProduct, meter, "plus"),
  pro: await ensureExtraPrice(extraProduct, meter, "pro"),
  max: await ensureExtraPrice(extraProduct, meter, "max"),
};
const diskPrice = await ensureDiskPrice(diskProduct, diskMeter);
const portal = await ensurePortalConfiguration(product, proProduct, maxProduct, planPrice, proPrice, maxPrice);

console.log(JSON.stringify({
  livemode: planPrice.livemode,
  product: product.id,
  proProduct: proProduct.id,
  maxProduct: maxProduct.id,
  extraHoursProduct: extraProduct.id,
  extraDiskProduct: diskProduct.id,
  meter: meter.id,
  diskMeter: diskMeter.id,
  STRIPE_PLAN_PRICE_ID: planPrice.id,
  STRIPE_PRO_PRICE_ID: proPrice.id,
  STRIPE_MAX_PRICE_ID: maxPrice.id,
  // Each plan's own; STRIPE_EXTRA_HOURS_PRICE_ID (the first price) stays as it is in wrangler.jsonc.
  STRIPE_EXTRA_HOURS_PLUS_PRICE_ID: extraPrices.plus.id,
  STRIPE_EXTRA_HOURS_PRO_PRICE_ID: extraPrices.pro.id,
  STRIPE_EXTRA_HOURS_MAX_PRICE_ID: extraPrices.max.id,
  STRIPE_METER_EVENT: meter.event_name,
  STRIPE_DISK_PRICE_ID: diskPrice.id,
  STRIPE_DISK_METER_EVENT: diskMeter.event_name,
  STRIPE_PORTAL_CONFIG_ID: portal.id,
}, null, 2));
