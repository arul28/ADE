/**
 * The computer limit (`docs/plans/pricing-v2-and-gravity.md`): each plan has a
 * number of cloud computers, asleep or not, and outside agents (ADE MCP) start
 * ADE Cloud work on paid plans only. `adeCloud.ts` re-exports all of it.
 */

import type {
  CloudAccountState,
  CloudComputerLimitDetail,
  CloudComputerLimitLane,
  CloudNextPlan,
  CloudPlanFacts,
  CloudPlanId,
} from "../../../account-directory/src/cloud/contract";
import { CLOUD_PLAN_SENTENCE_NAMES } from "../../../account-directory/src/cloud/contract";
import { cloudCatalogOf, cloudPlanFactsOf, cloudPlanIdOf, isPaidPlanId } from "./adeCloud";

const countOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** How many cloud computers a plan allows, asleep or not, from the catalog (every server sends it; a malformed answer reads 0). */
export function cloudPlanComputerLimitOf(facts: Pick<CloudPlanFacts, "computerLimit"> | null | undefined): number {
  return countOf(facts?.computerLimit) ?? 0;
}

type AccountComputersPick = Pick<CloudAccountState, "computers" | "catalog" | "plan" | "planId">;
type AccountComputers = { total: number; limit: number };

/**
 * The account's computers and its plan's limit (asleep or not), or null when
 * the account wasn't read. A limit the answer left out is the plan's own.
 */
export function cloudAccountComputers(account: AccountComputersPick): AccountComputers;
export function cloudAccountComputers(account: AccountComputersPick | null | undefined): AccountComputers | null;
export function cloudAccountComputers(account: AccountComputersPick | null | undefined): AccountComputers | null {
  if (!account?.computers) return null;
  const total = countOf(account.computers.total) ?? 0;
  const limit = countOf(account.computers.limit) ?? cloudPlanComputerLimitOf(cloudPlanFactsOf(account, cloudCatalogOf(account)));
  return { total, limit };
}

/** Whether the account uses all its plan's cloud computers, so a new cloud lane is refused (`computer_limit`). */
export function cloudComputerLimitReached(account: Pick<CloudAccountState, "computers" | "catalog" | "plan" | "planId"> | null | undefined): boolean {
  const computers = cloudAccountComputers(account);
  return computers != null && computers.total >= computers.limit;
}

/** The next plan up as the server sent it (`computers.nextPlan`, or a refusal's), or null (Max, not sold, or not a plan). */
export function readCloudNextPlan(value: unknown): CloudNextPlan | null {
  if (!value || typeof value !== "object") return null;
  const next = value as Record<string, unknown>;
  return isPaidPlanId(next.planId) && typeof next.computerLimit === "number" && typeof next.priceUsd === "number"
    ? { planId: next.planId, computerLimit: next.computerLimit, priceUsd: next.priceUsd }
    : null;
}

/**
 * What the computer limit card shows, built from the account when no refusal
 * carried it (the card opened before a new lane): the limit, the count, and
 * the server's next plan. `lanes` comes from the caller's list of the account's computers.
 */
export function cloudComputerLimitDetailOf(
  account: Pick<CloudAccountState, "plan" | "planId" | "catalog" | "computers">,
  lanes: CloudComputerLimitLane[] = [],
): CloudComputerLimitDetail | null {
  const computers = cloudAccountComputers(account);
  if (!computers) return null;
  return { planId: cloudPlanIdOf(account), limit: computers.limit, total: computers.total, lanes, nextPlan: readCloudNextPlan(account.computers.nextPlan) };
}

/** A `computer_limit` refusal's detail (flat on the server's `error`), or null when it isn't one. */
export function readCloudComputerLimitDetail(value: unknown): CloudComputerLimitDetail | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.limit !== "number" || typeof raw.total !== "number") return null;
  const planId: CloudPlanId = raw.planId === "free" || isPaidPlanId(raw.planId) ? raw.planId : "free";
  const lanes = Array.isArray(raw.lanes)
    ? raw.lanes.flatMap((entry): CloudComputerLimitLane[] => {
      if (!entry || typeof entry !== "object") return [];
      const lane = entry as Record<string, unknown>;
      if (typeof lane.instanceId !== "string" || !lane.instanceId) return [];
      return [{
        instanceId: lane.instanceId,
        laneName: typeof lane.laneName === "string" && lane.laneName ? lane.laneName : lane.instanceId,
        awake: lane.awake === true,
        lastAwakeAt: typeof lane.lastAwakeAt === "number" && Number.isFinite(lane.lastAwakeAt) ? lane.lastAwakeAt : null,
        hasLane: lane.hasLane !== false,
      }];
    })
    : [];
  return { planId, limit: raw.limit, total: raw.total, lanes, nextPlan: readCloudNextPlan(raw.nextPlan) };
}

/** "All 2 of your cloud computers are in use": the limit card's title. */
export function cloudComputerLimitTitle(detail: Pick<CloudComputerLimitDetail, "limit">): string {
  return detail.limit === 1 ? "Your one cloud computer is in use" : `All ${detail.limit} of your cloud computers are in use`;
}

/** The limit card's third way out: "Move to Plus". */
export function cloudComputerLimitUpgradeLabel(nextPlan: CloudNextPlan): string {
  return `Move to ${CLOUD_PLAN_SENTENCE_NAMES[nextPlan.planId]}`;
}

/**
 * Whether outside agents (ADE MCP) may start ADE Cloud work on the account's
 * plan, as the server decides it: never under the free rules (a `past_due`
 * paid plan included), else what the plan's facts say. An account ADE
 * couldn't read goes on: the server refuses it (`outside_agent_free_plan`) on
 * the call, which carries `origin: "mcp"`. This only answers early.
 */
export function cloudOutsideAgentsAllowed(account: Pick<CloudAccountState, "plan" | "planId" | "rules" | "catalog"> | null | undefined): boolean {
  if (!account) return true;
  if (account.rules === "free") return false;
  return cloudPlanFactsOf(account, cloudCatalogOf(account))?.outsideAgents !== false;
}
