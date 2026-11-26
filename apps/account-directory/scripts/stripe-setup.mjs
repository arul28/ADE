#!/usr/bin/env node
/**
 * Creates or finds what ADE Cloud sells in the Stripe account the key belongs
 * to (live or sandbox), and prints the ids for wrangler.jsonc. Safe to rerun:
 * each object is found by a fixed id, lookup key or event name first.
 *
 *   STRIPE_SECRET_KEY=... node scripts/stripe-setup.mjs
 *
 * What it sells (Pricing v2, 2026-11-21; 4-cent extra hours and Max's 2,000
 * hours, 2026-11-26): Plus at $5, Pro at $20 and Max at $50 a month; extra
 * hours on their own meter, 4 cents an hour on every paid plan (an hour is a Medium-hour; Small uses none), one price per plan on the
 * one meter; and a billing portal setup (card, cancel at the period end,
 * invoices; plans change in ADE, never in the portal). The ADE Cloud iPhone
 * draws from the same credits, so it has no product of its own. Extra disk
 * and the old extra iPhone minutes are no longer sold: this script neither
 * makes nor changes their products, prices or meters, which stay in Stripe as
 * they are.
 *
 * Each of these is its own product, because Checkout, the portal and invoices
 * name a line by its product: "ADE Cloud Plus", "ADE Cloud Pro", "ADE Cloud
 * Max" and "Extra hours", each with a short description Stripe
 * shows in full (a long one is cut off on Checkout). Managed Payments refuses
 * Checkout's `custom_text`, so the products carry every word Checkout shows.
 * Checkout sells only the plan; the extra-hours item joins a subscription when
 * the person turns it on in ADE (`billing.ts`). A rerun brings names and descriptions up to
 * date. A price can't change product: one found on the wrong product (or
 * shaped differently) gives its lookup key to a new one and is archived, and
 * subscriptions that already hold it keep billing on it.
 *
 * The extra-hours price from before Cloud 7 (1 cent, 0.85 after 1,000 hours,
 * lookup key `ade_cloud_extra_hours_monthly`) is left as it is: subscriptions
 * that hold it keep billing on it until the Worker moves them to their plan's
 * price, at their next renewal or plan change. The same holds for Pro's and
 * Max's prices from before Pricing v2 (1.5 and 1.2 cents), and every plan's
 * 2-cent price from before 2026-11-26: a rerun makes new 4-cent ones under
 * the same lookup keys, and the Worker moves each subscription to the price
 * its `STRIPE_EXTRA_HOURS_*_PRICE_ID` names.
 */

/**
 * What Plus, Pro and Max include and cost, as the products say it. A copy of
 * `CLOUD_PLANS` in `src/cloud/plans.ts`, which the Worker enforces: the script
 * stops before any Stripe call when the two differ (`checkPlanNumbers`).
 * `extraHourCents` is each plan's extra-hours price.
 */
const PLAN_NUMBERS = {
  plus: { hours: 100, computerLimit: 3, extraHourCents: 4, cents: 500 },
  pro: { hours: 600, computerLimit: 10, extraHourCents: 4, cents: 2000 },
  max: { hours: 2000, computerLimit: 20, extraHourCents: 4, cents: 5000 },
};
/** "100 hours a month · 3 cloud computers · unlimited Small computers": short enough that Checkout shows it whole. */
const planDescription = ({ hours, computerLimit }) =>
  `${hours.toLocaleString("en-US")} hours a month · ${computerLimit} cloud computers · unlimited Small computers`;

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
    const expected = { hours: plan.includedMilli / 1000, computerLimit: plan.computerLimit, extraHourCents: plan.extraHourCents, cents: plan.priceUsd * 100 };
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
/** "Only if you turn them on · 4¢ an hour", or each plan's price when they differ. */
function extraHoursDescription() {
  const { plus, pro, max } = PLAN_NUMBERS;
  return plus.extraHourCents === pro.extraHourCents && pro.extraHourCents === max.extraHourCents
    ? `Only if you turn them on · ${plus.extraHourCents}¢ an hour of a Medium computer past your plan`
    : `Only if you turn them on · ${plus.extraHourCents}¢ an hour on Plus, ${pro.extraHourCents}¢ on Pro, ${max.extraHourCents}¢ on Max`;
}
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
    description: extraHoursDescription(),
    unitLabel: "hour",
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
/** The hours meter's event, named before Pricing v2: it now counts Medium-hours (a meter's event can't be renamed). */
const METER_EVENT = "ade_cloud_small_hours";
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
    if (found) {
      // A meter's sum and payload keys can't be changed after it is made: a different one would bill the wrong amounts.
      const shaped = found.default_aggregation?.formula === "sum"
        && found.customer_mapping?.type === "by_id"
        && found.customer_mapping?.event_payload_key === "stripe_customer_id"
        && found.value_settings?.event_payload_key === "value";
      if (!shaped) throw new Error(`The Stripe meter for "${eventName}" (${found.id}) doesn't sum "value" by "stripe_customer_id". Deactivate it in Stripe and run this again.`);
      return found;
    }
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

/** One plan's flat extra-hours price per Medium-hour, on the shared hours meter: "$0.04 per hour" on Checkout. */
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
 * The portal: change the card, cancel at the period end, see invoices. Plans
 * change in ADE (`billing.ts` `changePaidPlan`), never here: ADE's switch is
 * the one that checks a cheaper plan's limits and the person's cleanup pick,
 * and a portal downgrade would leave a subscription schedule that refuses
 * ADE's own changes. (Subscriptions with only the plan item would otherwise
 * be switchable here since Checkout stopped adding the extra items.) The
 * headline and links are what the person sees at the top of the page.
 */
async function ensurePortalConfiguration() {
  const params = {
    "business_profile[headline]": "Manage your ADE Cloud plan",
    "business_profile[privacy_policy_url]": "https://ade-app.dev/privacy",
    "business_profile[terms_of_service_url]": "https://ade-app.dev/terms",
    "features[invoice_history][enabled]": "true",
    "features[payment_method_update][enabled]": "true",
    "features[subscription_cancel][enabled]": "true",
    "features[subscription_cancel][mode]": "at_period_end",
    "features[subscription_update][enabled]": "false",
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
const meter = await ensureMeter(METER_EVENT, "ADE Cloud extra hours");
const planPrice = await ensurePlanPrice(product, PLAN_LOOKUP_KEY, PLAN_NUMBERS.plus.cents, "ADE Cloud Plus");
const proPrice = await ensurePlanPrice(proProduct, PRO_LOOKUP_KEY, PLAN_NUMBERS.pro.cents, "ADE Cloud Pro");
const maxPrice = await ensurePlanPrice(maxProduct, MAX_LOOKUP_KEY, PLAN_NUMBERS.max.cents, "ADE Cloud Max");
const extraPrices = {
  plus: await ensureExtraPrice(extraProduct, meter, "plus"),
  pro: await ensureExtraPrice(extraProduct, meter, "pro"),
  max: await ensureExtraPrice(extraProduct, meter, "max"),
};
const portal = await ensurePortalConfiguration();

console.log(JSON.stringify({
  livemode: planPrice.livemode,
  product: product.id,
  proProduct: proProduct.id,
  maxProduct: maxProduct.id,
  extraHoursProduct: extraProduct.id,
  meter: meter.id,
  STRIPE_PLAN_PRICE_ID: planPrice.id,
  STRIPE_PRO_PRICE_ID: proPrice.id,
  STRIPE_MAX_PRICE_ID: maxPrice.id,
  // Each plan's own; STRIPE_EXTRA_HOURS_PRICE_ID (the first price) stays as it is in wrangler.jsonc.
  // A plan's id that changes goes into STRIPE_EXTRA_HOURS_RETIRED_PRICE_IDS, or its subscriptions never move.
  STRIPE_EXTRA_HOURS_PLUS_PRICE_ID: extraPrices.plus.id,
  STRIPE_EXTRA_HOURS_PRO_PRICE_ID: extraPrices.pro.id,
  STRIPE_EXTRA_HOURS_MAX_PRICE_ID: extraPrices.max.id,
  STRIPE_METER_EVENT: meter.event_name,
  STRIPE_PORTAL_CONFIG_ID: portal.id,
}, null, 2));
