import { LINKS } from "./links";
import { MARKETING_CTA_LABELS, type MarketingCtaLabel } from "./marketingAnalytics";
import type { PricingPlan } from "./cloudPricing";

type CloudPlanId = PricingPlan["id"];

/** Each plan's button words and the CTA it records, on the home page and `/pricing` alike. */
export const PLAN_CTAS: Record<CloudPlanId, { label: string; cta: MarketingCtaLabel }> = {
  free: { label: "Start free", cta: MARKETING_CTA_LABELS.CHOOSE_PLAN_FREE },
  plus: { label: "Get Plus", cta: MARKETING_CTA_LABELS.CHOOSE_PLAN_PLUS },
  pro: { label: "Get Pro", cta: MARKETING_CTA_LABELS.CHOOSE_PLAN_PRO },
  max: { label: "Get Max", cta: MARKETING_CTA_LABELS.CHOOSE_PLAN_MAX },
};

/** The web app at that plan: it signs the person in, then opens ADE Cloud settings there (`?cloudPlan=`). */
export function planHref(plan: CloudPlanId): string {
  return `${LINKS.webClient}/?cloudPlan=${plan}`;
}
