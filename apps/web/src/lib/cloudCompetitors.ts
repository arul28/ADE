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
    plan: "Lite plan, $20 with $20 of credits",
    rateKind: "usage rate",
    // $0.20 an hour from plan credits; Lite ($20 a month, $20 of credits) is the least you can pay.
    monthlyUsd: (hours) => Math.max(20, hours * 0.2),
    perHourCents: 20,
    freeHours: 0,
    note: "On a $20 plan; credits also pay for model tokens",
    source: "https://capy.ai/pricing",
  },
  {
    id: "paradev",
    name: "Paradev",
    logo: "/images/competitors/logo-paradev.webp",
    machine: "4 vCPU · 8 GB",
    plan: "Team seat, $60 with 150 hours",
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
    machine: "Size not published",
    plan: "Pro, $50 for about 500 hours",
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
    id: "copilot",
    name: "GitHub Copilot",
    logo: "/images/competitors/logo-copilot.svg",
    machine: "4 GiB, CPUs not published",
    plan: "Any Copilot plan, compute metered",
    rateKind: "usage rate",
    // $0.000024 per compute second plus $0.000003 per GiB-second, at 4 GiB; a Copilot plan comes on top.
    monthlyUsd: (hours) => hours * 0.1296,
    perHourCents: 12.96,
    // Plans include sandbox time shared with Actions runners, but GitHub does not say how many hours.
    freeHours: null,
    estimate: true,
    note: "Compute only, at 4 GiB, plus a Copilot plan",
    source: "https://docs.github.com/en/billing/concepts/product-billing/cloud-and-local-sandboxes",
  },
  {
    id: "superconductor",
    name: "Superconductor",
    logo: "/images/competitors/logo-superconductor.webp",
    machine: "2 vCPU · 4 GB",
    plan: "Pro, $100 with a credit allowance",
    rateKind: "overage",
    // 200 credits an hour; Pro ($100) overage is $25 per 10,000 credits. Free is 20,000 starting credits, once.
    perHourCents: 50,
    freeHours: 0,
    estimate: true,
    note: "Pro overage rate; its free credits come once, not monthly",
    source: "https://www.superconductor.com/pricing",
  },
];

/** Cloud agents whose price bundles the computer with model use, so there is no compute price to compare. */
export const NO_PUBLISHED_PRICE = ["Claude", "Cursor", "Codex", "Devin", "Jules", "Warp"] as const;

export type CloudStatus = "cloud" | "none" | "closing" | "unpriced";

/**
 * Every agent app ademark.dev measures, plus Conductor (measured, then hidden
 * after Meta bought its maker), and whether it hosts cloud computers for you.
 * super.engineering (Super Dot Engineering LLC) is not Superconductor
 * (Volition, Inc.); their own terms pages name different companies.
 */
export const CLOUD_ROSTER: Array<{ name: string; logo: string; cloud: CloudStatus; detail: string }> = [
  { name: "Capy", logo: "/images/competitors/logo-capy.webp", cloud: "cloud", detail: "$0.20 an hour, on a $20 plan" },
  { name: "Paradev", logo: "/images/competitors/logo-paradev.webp", cloud: "cloud", detail: "From the $60 Team seat" },
  { name: "Cloudroom", logo: "/images/competitors/logo-cloudroom.webp", cloud: "cloud", detail: "Credits; about 30 free hours" },
  { name: "Claude", logo: "/images/competitors/logo-claude.webp", cloud: "cloud", detail: "Bundled into Claude plans" },
  { name: "Traycer", logo: "/images/competitors/logo-traycer.webp", cloud: "unpriced", detail: "Paid add-on, no public price" },
  { name: "Emdash", logo: "/images/competitors/logo-emdash.svg", cloud: "unpriced", detail: "Early access, no public price" },
  { name: "Zeron", logo: "/images/competitors/logo-zeron.webp", cloud: "unpriced", detail: "Hosted on Boat, no public price" },
  { name: "Conductor", logo: "/images/competitors/logo-conductor-app.webp", cloud: "closing", detail: "Cloud shuts down November 20" },
  { name: "T3 Code", logo: "/images/competitors/logo-t3.webp", cloud: "none", detail: "Your own machine or VM" },
  { name: "super.engineering", logo: "/images/competitors/logo-super-engineering.webp", cloud: "none", detail: "Agents run on your machine" },
  { name: "Paseo", logo: "/images/competitors/logo-paseo.svg", cloud: "none", detail: "Runs on your own machines" },
  { name: "Diri", logo: "/images/competitors/logo-diri.webp", cloud: "none", detail: "Local only" },
  { name: "MonoCode", logo: "/images/competitors/logo-monocode.webp", cloud: "none", detail: "Local launcher" },
  { name: "Synara", logo: "/images/competitors/logo-synara.webp", cloud: "none", detail: "Tunnels to your machine" },
  { name: "bb", logo: "/images/competitors/logo-bb.webp", cloud: "none", detail: "Local-first" },
  { name: "Orca", logo: "/images/competitors/logo-orca.webp", cloud: "none", detail: "SSH to your own VMs" },
];
