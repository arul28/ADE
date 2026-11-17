import { planCostsFor } from "./cloudPricing";

/**
 * What other agent apps charge for a cloud computer, for the home page's
 * charts: the apps ademark.dev measures, plus Replicas. Only apps that
 * publish an hourly compute price are charted; the monthly bill drops any
 * row whose bill the vendor's page does not give. Every number was read from
 * the vendor's own pricing page on `CHECKED_ON` (Capy's on `CAPY_CHECKED_ON`);
 * an `estimate` is our arithmetic from that page and is drawn with "≈". Re-check
 * before changing copy around them.
 */

export const CHECKED_ON = "November 16, 2026";
/** Capy's page was re-read on this date; the other rows keep their earlier check. */
export const CAPY_CHECKED_ON = "November 17, 2026";

export type Rival = {
  id: string;
  name: string;
  logo: string;
  /** The machine compared, as the vendor names it; omitted when the vendor does not say. */
  machine?: string;
  /** What `hours` of that machine costs in a month, in dollars, with the plan the vendor requires; null where the page does not say (the row is left out). */
  monthlyUsd?: (hours: number) => number | null;
  /** What one hour of that machine costs, in cents. */
  perHourCents: number;
  /** Cloud hours a month that cost nothing; 0 for none (a one-time credit counts as none). */
  freeHours: number;
  /** The plan you must be on to get a cloud computer at all, and what it includes. */
  plan: string;
  /** The plan behind the monthly bill for `hours`, when it isn't always `plan`. */
  planFor?: (hours: number) => string;
  /** What the hourly price is: an average over a plan's included hours, a metered usage rate, or the rate past a plan's hours. */
  rateKind: "plan average" | "usage rate" | "overage";
  /** True when the numbers are our arithmetic from the vendor's page, not a price it prints. */
  estimate?: boolean;
  source: string;
};

/** ADE Cloud's own bill: the cheapest plan that runs `hours` of a Small computer (2 CPUs, 4 GB). */
export const ADE_MACHINE = "2 CPUs · 4 GB";

export function adeMonthlyUsd(hours: number): number {
  return planCostsFor(hours)[0]?.costUsd ?? 0;
}

/** Replicas' cheapest plan for `hours` of Small: Developer ($50) or a Team step ($200, $300, ...), each billing 1.5x past its usage. */
function replicasBest(hours: number): { price: number; usd: number } {
  const usage = hours * 0.24;
  let best = { price: 50, usd: 50 + Math.max(0, usage - 50) * 1.5 };
  for (let price = 200; price < usage + 100; price += 100) {
    const usd = price + Math.max(0, usage - price) * 1.5;
    if (usd < best.usd) best = { price, usd };
  }
  return best;
}

/**
 * Capy's cheapest way to run `hours` of Medium (2 vCPU · 8 GB). One machine
 * minute is one minute on 1 vCPU / 4 GB, and a machine uses one for every 4 GB
 * of RAM, so Medium uses 2 a minute (120 an hour). Lite ($20) includes 30,000
 * machine minutes (250 hours here), Pro ($100) 150,000 (1,250), Max ($200)
 * 300,000 (2,500). Past a plan, 60 machine minutes cost $0.10 of credits, which
 * is $0.20 an hour here. Credits without a plan cost the same, from a $5 top-up.
 */
const CAPY_OVERAGE_USD_PER_HOUR = 0.2;
const CAPY_PLANS = [
  { plan: "$20 Lite plan", price: 20, hours: 250 },
  { plan: "$100 Pro plan", price: 100, hours: 1_250 },
  { plan: "$200 Max plan", price: 200, hours: 2_500 },
] as const;

function capyBest(hours: number): { plan: string; usd: number } {
  let best = { plan: "Credits only", usd: hours * CAPY_OVERAGE_USD_PER_HOUR };
  for (const plan of CAPY_PLANS) {
    const usd = plan.price + Math.max(0, hours - plan.hours) * CAPY_OVERAGE_USD_PER_HOUR;
    if (usd <= best.usd) best = { plan: plan.plan, usd };
  }
  return best;
}

export const RIVALS: Rival[] = [
  {
    id: "capy",
    name: "Capy",
    logo: "/images/competitors/logo-capy.webp",
    machine: "2 vCPU · 8 GB",
    plan: CAPY_PLANS[0].plan,
    rateKind: "overage",
    monthlyUsd: (hours) => capyBest(hours).usd,
    planFor: (hours) => capyBest(hours).plan,
    perHourCents: Math.round(CAPY_OVERAGE_USD_PER_HOUR * 100),
    freeHours: 0,
    source: "https://capy.ai/pricing",
  },
  {
    id: "paradev",
    name: "Paradev",
    logo: "/images/competitors/logo-paradev.webp",
    machine: "4 vCPU · 8 GB",
    plan: "$60 Team seat",
    rateKind: "overage",
    // Team: $60 a seat with 150 workspace hours, then $0.06 per GB-hour ($0.48 an hour at 8 GB).
    monthlyUsd: (hours) => 60 + Math.max(0, hours - 150) * 0.48,
    perHourCents: 48,
    freeHours: 0,
    source: "https://paradev.com/pricing",
  },
  {
    id: "cloudroom",
    name: "Cloudroom",
    logo: "/images/competitors/logo-cloudroom.webp",
    plan: "$50 Pro plan",
    rateKind: "plan average",
    // Free: 3,000 credits each 30 days; Pro: $50 for 50,000 credits; the page puts a typical agent hour at about 100 credits.
    monthlyUsd: (hours) => (hours <= 30 ? 0 : hours <= 500 ? 50 : null),
    perHourCents: 10,
    freeHours: 30,
    estimate: true,
    source: "https://cloudroom.dev/pricing",
  },
  {
    id: "replicas",
    name: "Replicas",
    logo: "/images/competitors/logo-replicas.svg",
    machine: "2 vCPU · 8 GB",
    plan: "$50 Developer plan",
    rateKind: "usage rate",
    // Small is $0.004 a minute ($0.24 an hour) inside a plan, 1.5x past it. Developer is $50 with $50 of usage;
    // Team is $200 and up in $100 steps, usage equal to the price. Its $100 free credit comes once, not monthly.
    monthlyUsd: (hours) => replicasBest(hours).usd,
    planFor: (hours) => {
      const { price } = replicasBest(hours);
      return price === 50 ? "$50 Developer plan" : `$${price} Team plan`;
    },
    perHourCents: 24,
    freeHours: 0,
    source: "https://replicas.dev/pricing",
  },
  {
    id: "superconductor",
    name: "Superconductor",
    logo: "/images/competitors/logo-superconductor.webp",
    machine: "2 vCPU · 4 GB",
    plan: "$100 Pro plan",
    rateKind: "overage",
    // 200 credits an hour; Pro ($100) overage is $25 per 10,000 credits. Free is 20,000 starting credits, once.
    // Pro's credit allowance at $100 is not stated, so it has no monthly bill and stays out of that chart.
    perHourCents: 50,
    freeHours: 0,
    estimate: true,
    source: "https://www.superconductor.com/pricing",
  },
];

/**
 * The agent apps ademark.dev measures that host no cloud computer at all.
 * super.engineering (Super Dot Engineering LLC) is not Superconductor
 * (Volition, Inc.); their own terms pages name different companies.
 */
export const NO_CLOUD: Array<{ name: string; logo: string }> = [
  { name: "T3 Code", logo: "/images/competitors/logo-t3.webp" },
  { name: "super.engineering", logo: "/images/competitors/logo-super-engineering.webp" },
  { name: "Paseo", logo: "/images/competitors/logo-paseo.svg" },
  { name: "Orca", logo: "/images/competitors/logo-orca.webp" },
  { name: "Diri", logo: "/images/competitors/logo-diri.webp" },
  { name: "Synara", logo: "/images/competitors/logo-synara.webp" },
  { name: "MonoCode", logo: "/images/competitors/logo-monocode.webp" },
  { name: "bb", logo: "/images/competitors/logo-bb.webp" },
];
