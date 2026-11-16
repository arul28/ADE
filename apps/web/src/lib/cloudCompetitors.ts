import { planCostsFor } from "./cloudPricing";

/**
 * What other agent apps charge for a cloud computer, for the home page's
 * charts. The roster is every app ademark.dev measures. Only apps that
 * publish a compute price are charted; the rest are named as bundled,
 * unclear or without a cloud. Every number was read from the vendor's own
 * pricing page on `CHECKED_ON`; an `estimate` is our arithmetic from that
 * page and is drawn with "≈". Re-check before changing copy around them.
 */

export const CHECKED_ON = "November 14, 2026";

export type Rival = {
  id: string;
  name: string;
  logo?: string;
  /** The machine compared, as the vendor names it. */
  machine: string;
  /** What `hours` of that machine costs in a month, in dollars, with the plan the vendor requires; null where the page does not say. */
  monthlyUsd?: (hours: number) => number | null;
  /** What one hour of that machine costs, in cents. */
  perHourCents?: number;
  /** Cloud hours a month that cost nothing, or null when the vendor does not say. */
  freeHours: number | null;
  /** The plan you must be on to get a cloud computer at all, and what it includes. */
  plan: string;
  /** What the hourly price is: an average over a plan's included hours, a metered usage rate, or the rate past a plan's hours. */
  rateKind: "plan average" | "usage rate" | "overage";
  /** True when the numbers are our arithmetic from the vendor's page, not a price it prints. */
  estimate?: boolean;
  /** One line: what the price includes or leaves out. */
  note: string;
  source: string;
};

/** ADE Cloud's own bill: the cheapest plan that runs `hours` of a Small computer (2 CPUs, 4 GB). */
export const ADE_MACHINE = "2 CPUs · 4 GB";

export function adeMonthlyUsd(hours: number): number {
  return planCostsFor(hours)[0]?.costUsd ?? 0;
}

export const RIVALS: Rival[] = [
  {
    id: "capy",
    name: "Capy",
    logo: "/images/competitors/logo-capy.webp",
    machine: "2 vCPU · 8 GB",
    plan: "$20 Lite plan",
    rateKind: "usage rate",
    // $0.20 an hour from plan credits; Lite ($20 a month, $20 of credits) is the least you can pay.
    monthlyUsd: (hours) => Math.max(20, hours * 0.2),
    perHourCents: 20,
    freeHours: 0,
    // Credits past the plan's $20 are assumed to cost the same $0.20 an hour; the page does not print a top-up rate.
    estimate: true,
    note: "On a $20 plan; credits also pay for model tokens",
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
    note: "Cloud starts on the $60 Team seat",
    source: "https://paradev.com/pricing",
  },
  {
    id: "cloudroom",
    name: "Cloudroom",
    logo: "/images/competitors/logo-cloudroom.webp",
    machine: "Size unpublished",
    plan: "$50 Pro plan",
    rateKind: "plan average",
    // Free: 3,000 credits each 30 days; Pro: $50 for 50,000 credits; the page puts a typical agent hour at about 100 credits.
    monthlyUsd: (hours) => (hours <= 30 ? 0 : hours <= 500 ? 50 : null),
    perHourCents: 10,
    freeHours: 30,
    estimate: true,
    note: "Hours from its own ~100 credits an hour",
    source: "https://cloudroom.dev/pricing",
  },
  {
    id: "superconductor",
    name: "Superconductor",
    logo: "/images/competitors/logo-superconductor.webp",
    machine: "2 vCPU · 4 GB",
    plan: "$100 Pro plan",
    rateKind: "overage",
    // 200 credits an hour; Pro ($100) overage is $25 per 10,000 credits. Free is 20,000 starting credits, once.
    // Pro's credit allowance at $100 is not stated, so no monthly bill can be worked out.
    monthlyUsd: () => null,
    perHourCents: 50,
    freeHours: 0,
    estimate: true,
    note: "Pro overage rate; its free credits come once, not monthly",
    source: "https://www.superconductor.com/pricing",
  },
];

/** Agent apps with a cloud but no computer price to compare: Claude bundles it into its plans; the rest print no price. */
export const NO_PUBLISHED_PRICE = ["Claude", "Traycer", "Emdash", "Zeron"] as const;

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
