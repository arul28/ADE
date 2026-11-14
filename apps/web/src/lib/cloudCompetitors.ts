import { planCostsFor } from "./cloudPricing";

/**
 * What other agent apps charge for a cloud computer, for the home page's
 * comparison. Only products that publish a compute price are compared; the
 * rest are named as "no published price" or "no cloud". Every number here
 * was read from the vendor's own pricing page on `CHECKED_ON`; re-check them
 * before changing the copy around them.
 */

export const CHECKED_ON = "November 14, 2026";

export type Rival = {
  id: string;
  name: string;
  logo?: string;
  /** The machine compared, as the vendor names it. */
  machine: string;
  /** What `hours` of that machine costs in a month, in dollars, with any plan the vendor requires. */
  monthlyUsd: (hours: number) => number;
  /** Cloud hours a month that cost nothing, or null when the vendor does not say. */
  freeHours: number | null;
  /** One line under the bar: what the price includes or leaves out. */
  note: string;
  source: string;
};

/** ADE Cloud's own bill: the cheapest plan that runs `hours` of a Small computer (2 CPUs, 4 GB). */
export function adeMonthlyUsd(hours: number): number {
  return planCostsFor(hours)[0]?.costUsd ?? 0;
}

export const RIVALS: Rival[] = [
  {
    id: "capy",
    name: "Capy",
    machine: "Medium, 2 vCPU · 8 GB",
    // $0.20 an hour from plan credits; Lite ($20 a month, $20 of credits) is the least you can pay.
    monthlyUsd: (hours) => Math.max(20, hours * 0.2),
    freeHours: 0,
    note: "Credits also pay for model tokens",
    source: "https://capy.ai/pricing",
  },
  {
    id: "paradev",
    name: "Paradev",
    machine: "Workspace, 4 vCPU · 8 GB",
    // Team: $60 a seat with 150 workspace hours, then $0.48 an hour ($0.06 per GB-hour).
    monthlyUsd: (hours) => 60 + Math.max(0, hours - 150) * 0.48,
    freeHours: 0,
    note: "Cloud starts on the $60 Team seat",
    source: "https://paradev.com/pricing",
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    logo: "/images/competitors/github.webp",
    machine: "Cloud sandbox, 4 GiB",
    // $0.000024 per compute second plus $0.000003 per GiB-second, at 4 GiB; a Copilot plan comes on top.
    monthlyUsd: (hours) => hours * 0.1296,
    // Plans include sandbox time shared with Actions runners, but GitHub does not say how many hours.
    freeHours: null,
    note: "Compute only, plus a Copilot plan",
    source: "https://docs.github.com/en/billing/concepts/product-billing/cloud-and-local-sandboxes",
  },
];

/** Cloud agents whose price bundles the computer with model use, so there is no compute price to compare. */
export const NO_PUBLISHED_PRICE = ["Cursor", "Codex", "Devin", "Jules", "Warp"] as const;

/** Agent apps with no cloud computers at all. */
export const NO_CLOUD: Array<{ name: string; logo?: string }> = [
  { name: "T3 Code", logo: "/images/competitors/t3-code.webp" },
  { name: "Orca" },
  { name: "Emdash" },
];
