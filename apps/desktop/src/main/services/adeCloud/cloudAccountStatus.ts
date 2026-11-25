import {
  CLOUD_CREDIT_UNIT_SENTENCE,
  CLOUD_PLAN_LABELS,
  cloudSmallHoursSentence,
  cloudSmallUsesHours,
  cloudAccountComputers,
  cloudCatalogOf,
  cloudPlanComputerLimitOf,
  cloudExtraHourCentsOf,
  cloudLimitsPresetOf,
  cloudPlanFactsOf,
  cloudPlanIdOf,
  cloudPlanLabelOf,
  cloudShapeFor,
  cloudShapeWithin,
  describeCloudMachineSize,
  type CloudAccountState,
  type CloudAgentLimits,
  type CloudCatalog,
  type CloudDiskUsage,
  type CloudLimitsPreset,
  type CloudMachine,
  type CloudMachinesResult,
  type CloudPlanId,
} from "../../../shared/adeCloud";
import { cloudLaneStartBlock, type CloudLaneMachine } from "../../../shared/cloudLaneLaunch";
import { cloudHoursOnSizesLine, cloudTierOfMachine, cloudTierUsesHours, cloudTiers, type CloudTierId } from "../../../shared/cloudTiers";
import { cloudUnitWords } from "../../../shared/cloudUnitWords";
import { NO_PROVIDER_SENTENCE } from "./cloudAccess";


/** What a credit is, without `CLOUD_CREDIT_UNIT_SENTENCE`'s "Small computers use none." (for a catalog that charges Small). */
const CLOUD_CREDIT_DEFINITION = "A credit is an hour on a Medium computer or a minute on the ADE Cloud iPhone.";
/**
 * `cloud.status`: the whole ADE Cloud account in one read (plan, hours,
 * computers, each lane, the sizes, what agents may do, and whether a new lane
 * can start). The action (`cloudAgentActions.ts`) makes the reads; this
 * shapes the answer. Pricing v2: each plan has a number of cloud computers,
 * Small computers never use hours, and hours are Medium-hours. There is no
 * plan or account disk; each computer's own disk is in `lanes[].disk`.
 */

/** Where a person changes how many new computers agents may start a day (Settings, the ADE Cloud card). */
export const CLOUD_DAILY_LIMIT_SETTING = "Settings › Integrations › ADE Cloud › What agents may do › New computers a day";

/** `cloud.status` when the computers listed but the plan and hours didn't. */
const CLOUD_ACCOUNT_UNKNOWN_MESSAGE =
  "ADE couldn't read your ADE Cloud plan and hours, so it can't say if a new lane can start. Try again in a minute.";

const milliToHours = (milli: number): number => Math.round(Math.max(0, milli)) / 1000;

/** Why `cloud.status` says a new lane can't start: an account fact, or something ADE couldn't read. */
export type CloudCanStartLaneCode =
  | "out_of_hours"
  | "computer_limit"
  | "signed_out"
  | "not_available"
  | "unreadable"
  | "unreachable"
  | "account_unknown";

/** `cloud.status`'s answer to "can a new ADE Cloud lane start right now?". */
export type CloudCanStartLane = { ok: boolean; reason: string | null; code: CloudCanStartLaneCode | null };

/** One computer of the account in `cloud.status`: the lane it holds, or `lane: null` for a computer made for no lane. */
export type CloudStatusComputer = {
  instanceId: string;
  name: string | null;
  machineKey: string | null;
  lane: { id: string; name: string; projectOrigin: string | null } | null;
  /** The ADE Cloud lane size it runs at, or null at a size the lane sizes don't cover (an older computer). */
  size: { id: CloudTierId; label: string } | null;
  /** "Large · full computer · 4 CPU · 8 GB" (the lane size), else what the computer is. */
  sizeLabel: string;
  /** Hours of the plan per hour awake, from the account's catalog. */
  hoursRate: number | null;
  state: CloudMachine["state"];
  /** When it last did work (its own report at its idle step), else when it was last awake; null when unknown. */
  lastUsedAt: string | null;
  /** Set for a computer unused for long: when ADE Cloud deletes it unless it is used. */
  deletesAt: string | null;
  /**
   * Its disk size, a sentence when full, and what uses it as it last measured
   * itself while awake (`measuredAt`); `usage` is null before its first measure.
   */
  disk: { sizeGb: number | null; full: string | null; usage: CloudDiskUsage | null };
  /**
   * How it keeps current: the image it runs, its channel, the image the
   * channel is on, and `auto` (updates itself when idle), `updating` or
   * `failed` with why. Null from a server before updates.
   */
  update: { image: string | null; channel: "stable" | "beta"; target: string | null; state: "auto" | "updating" | "failed"; error: string | null } | null;
};

/** `cloud.status`: the whole account in one read, with no wake and no spend. */
/** A lane in `status` whose computer was deleted: `why` is the reason in one sentence. */
export type CloudStatusDeletedLane = { laneId: string; name: string; branch: string | null; projectOrigin: string | null; deletedAt: string | null; why: string };

export type CloudAccountStatus = {
  canStartLane: CloudCanStartLane;
  plan: {
    id: "free" | "paid";
    label: string;
    /** The plan whose rules are in force: a paid plan with a failed payment follows the free one. */
    rulesId: "free" | "paid";
    pastDue: boolean;
    /**
     * What the plan includes: cloud computers (asleep or not), unlimited
     * Small computers, a month's hours
     * for the bigger sizes, and whether outside agents (ADE MCP) may start
     * ADE Cloud work.
     */
    includes: { computers: number; smallComputers: "unlimited"; hours: number; outsideAgents: boolean };
  } | null;
  /**
   * Credits: `hours` is one balance of credits (a Medium computer uses one an
   * hour), which the ADE Cloud iPhone draws from at `iphonePerMinute` a
   * minute. Null when the account couldn't be read.
   */
  credits: { iphonePerMinute: number } | null;
  hours: {
    left: number;
    included: number;
    used: number;
    percentUsed: number;
    state: CloudAccountState["hours"]["state"];
    resetsAt: string;
    extraHours: { available: boolean; enabled: boolean };
    /** What one credit is (`CLOUD_CREDIT_UNIT_SENTENCE`), and what Small uses. */
    unit: string;
  } | null;
  /**
   * The ADE Cloud iPhone (`ade devices use ios@cloud`), only for an account
   * that has it (`access` on): the credits it used this period (it draws from
   * the one balance, `credits.iphonePerMinute` a minute) and when they reset.
   * Null for every other account, and from a server before the iPhone.
   */
  iphone: {
    access: "on";
    /** The credits the iPhone used this period. */
    creditsUsed: number;
    resetsAt: string | null;
  } | null;
  /** Every plan ADE Cloud sells, cheapest first, with what each includes and costs; `current` is the account's. */
  plans: Array<{
    id: CloudPlanId;
    label: string;
    priceUsdMonth: number;
    /** Cloud computers the plan allows, asleep or not. */
    computers: number;
    /** A month's hours for the sizes bigger than Small (Medium-hours). */
    hours: number;
    /** The same hours as time on each size: "50 hours on a Medium · 20 on a Large · 12 on an X-Large". */
    hoursOnSizes: string;
    /** Whether outside agents (ADE MCP) may start ADE Cloud work on it. */
    outsideAgents: boolean;
    /** Cents an hour past the plan, null where the bigger sizes stop (Free). */
    extraHourCents: number | null;
    current: boolean;
  }>;
  /** "Unlimited Small computers. They never use your credits.", or what Small uses when this account's catalog rates it. */
  smallComputers: string;
  /** How many computers the account has (asleep or not), how many are awake, and the plan's limit. */
  computers: { inUse: number; awake: number; limit: number } | null;
  /** Every computer of the account, lanes first. */
  lanes: CloudStatusComputer[];
  /**
   * The lanes whose computer was deleted (the idle cleanup, the plan, a person
   * who kept the lane): the lane and its chats stay, and its next message makes
   * a new computer on its branch. Null when ADE couldn't read them; optional,
   * as an older ADE sends none.
   */
  lanesComputerDeleted?: CloudStatusDeletedLane[] | null;
  /** True when `lanesComputerDeleted` came from only the newest saved chats: a lane known only from older ones can be missing. */
  lanesComputerDeletedPartial?: boolean;
  /**
   * The lane sizes ADE Cloud offers now, Small first; rates are the catalog's
   * (hours of the plan per hour awake: 0 for Small, which never uses hours).
   */
  sizes: Array<{ id: CloudTierId; label: string; kind: "standard" | "full"; cpu: number; memoryGb: number; hoursRate: number; usesHours: boolean; isDefault: boolean }>;
  /** The size a new lane starts with when none is named; null when this ADE can't read the person's saved choice. */
  defaultSize: CloudTierId | null;
  agents: {
    /** False: agents nobody watches (full-auto chats, automations, ADE MCP apps) may not start anything that uses hours. */
    unattendedSpend: boolean;
    newComputersPerDay: number;
    newComputersToday: number;
    newComputersLeftToday: number;
    /** The lane sizes agents nobody watches may pick on their own. */
    sizesAllowed: CloudTierId[];
    preset: CloudLimitsPreset | "custom";
    /** Where the person changes these. */
    setting: string;
  } | null;
  /** A plain sentence when part of the picture couldn't be read, else null. */
  message: string | null;
};

const PLAN_ORDER: readonly CloudPlanId[] = ["free", "plus", "pro", "max"];

/** The plans the server sells, from its catalog (`plus` is `paid` on a server before Pro). */
function plansOf(catalog: CloudCatalog, current: CloudPlanId | null): CloudAccountStatus["plans"] {
  const tiers = cloudTiers(catalog);
  return PLAN_ORDER.flatMap((id) => {
    const facts = id === "plus" ? catalog.plans.plus ?? catalog.plans.paid : catalog.plans[id];
    if (!facts) return [];
    return [{
      id,
      label: CLOUD_PLAN_LABELS[id],
      priceUsdMonth: facts.priceUsd,
      computers: cloudPlanComputerLimitOf(facts),
      hours: milliToHours(facts.includedMilli),
      hoursOnSizes: cloudHoursOnSizesLine(facts.includedMilli, tiers),
      outsideAgents: facts.outsideAgents !== false,
      extraHourCents: cloudExtraHourCentsOf(id, catalog),
      current: id === current,
    }];
  });
}

/** `canStartLane` from one list read: the access answer first, then the account's facts. */
export function canStartLaneOf(result: CloudMachinesResult): CloudCanStartLane {
  const no = (code: CloudCanStartLaneCode, reason: string): CloudCanStartLane => ({ ok: false, reason, code });
  if (result.state === "not_connected") {
    const reason = result.message ?? NO_PROVIDER_SENTENCE.no_access;
    if (reason === NO_PROVIDER_SENTENCE.signed_out) return no("signed_out", reason);
    if (reason === NO_PROVIDER_SENTENCE.unreadable) return no("unreadable", reason);
    return no("not_available", reason);
  }
  if (result.state === "access_refused") return no("not_available", result.message ?? NO_PROVIDER_SENTENCE.no_access);
  if (result.state === "unreachable") return no("unreachable", result.message ?? "ADE couldn't reach ADE Cloud. Try again in a minute.");
  if (!result.account) return no("account_unknown", CLOUD_ACCOUNT_UNKNOWN_MESSAGE);
  const block = cloudLaneStartBlock(result.account, { newLane: true });
  return block ? no(block.code, block.message) : { ok: true, reason: null, code: null };
}

/**
 * `cloud.status`'s answer from the reads it made: one list of the computers
 * (with the account), the agent limits (null when unread), the saved default
 * size and the agents' new computers today. Pure: it reads nothing more.
 */
export function buildCloudAccountStatus(input: {
  result: CloudMachinesResult;
  limits: CloudAgentLimits | null;
  defaultSize: CloudTierId | null;
  newComputersToday: number;
}): CloudAccountStatus {
  const { result, limits, defaultSize, newComputersToday } = input;
  const canStartLane = canStartLaneOf(result);
  const account = result.state === "ok" ? result.account : null;
  const catalog = cloudCatalogOf(account);
  const tiers = cloudTiers(catalog);
  const deletesAt = new Map((account?.dueForDeletion ?? []).map((entry) => [entry.instanceId, new Date(entry.deletesAt).toISOString()]));
  const lanes: CloudStatusComputer[] = (result.machines as CloudLaneMachine[]).map((box) => {
    const tier = cloudTierOfMachine(box, tiers);
    return {
      instanceId: box.instanceId,
      name: box.name,
      machineKey: box.machineKey,
      lane: box.lane ? { id: box.lane.laneId, name: box.lane.laneName, projectOrigin: box.lane.projectOrigin } : null,
      size: tier ? { id: tier.id, label: tier.label } : null,
      // The lane size's own name: the older shape names call a full 4 CPU / 8 GB "Medium".
      sizeLabel: tier
        ? `${tier.label} · ${tier.type === "vm" ? "full computer" : "standard"} · ${tier.cpu} CPU · ${tier.memoryGb} GB`
        : describeCloudMachineSize(box, catalog),
      hoursRate: tier ? tier.multiplierMilli / 1000 : box.hoursRate,
      state: box.state,
      lastUsedAt: box.lastActiveAtMs != null ? new Date(box.lastActiveAtMs).toISOString() : null,
      deletesAt: deletesAt.get(box.instanceId) ?? null,
      disk: { sizeGb: box.resources?.diskGb ?? null, full: box.diskFull, usage: box.diskUsage ?? null },
      update: box.update
        ? { image: box.update.image, channel: box.update.channel, target: box.update.target, state: box.update.state, error: box.update.error }
        : null,
    };
  }).sort((left, right) => Number(right.lane != null) - Number(left.lane != null));
  // A paid plan with a failed payment follows the free plan's rules until paid.
  const plan = account ? (account.rules === "free" ? catalog.plans.free : cloudPlanFactsOf(account, catalog)) : null;
  // A partial answer (an older server) leaves that part null, never a throw.
  const part = (account ?? {}) as Partial<CloudAccountState>;
  // The ADE Cloud iPhone shows only to an account that has it.
  const phone = part.phone?.access === "on" ? part.phone : null;
  const words = cloudUnitWords(account);
  return {
    canStartLane,
    credits: account ? { iphonePerMinute: words.phoneMilliPerMinute / 1000 } : null,
    plan: account && plan
      ? {
          id: account.plan,
          label: cloudPlanLabelOf(account, catalog),
          rulesId: account.rules,
          pastDue: part.billing?.notice === "past_due",
          includes: {
            computers: cloudPlanComputerLimitOf(plan),
            smallComputers: "unlimited",
            hours: milliToHours(plan.includedMilli),
            outsideAgents: plan.outsideAgents !== false,
          },
        }
      : null,
    hours: account && part.hours && part.billing
      ? {
          left: milliToHours(account.hours.leftMilli),
          included: milliToHours(account.hours.includedMilli),
          used: milliToHours(account.hours.usedMilli),
          percentUsed: account.hours.percentUsed,
          state: account.hours.state,
          resetsAt: new Date(account.billing.periodEnd).toISOString(),
          extraHours: { available: part.extraHours?.available === true, enabled: part.extraHours?.enabled === true },
          // `CLOUD_CREDIT_UNIT_SENTENCE` ends "Small computers use none.": where Small is charged, the definition without it, then what Small uses.
          unit: cloudSmallUsesHours(catalog) ? `${CLOUD_CREDIT_DEFINITION} ${cloudSmallHoursSentence(catalog, words)}` : CLOUD_CREDIT_UNIT_SENTENCE,
        }
      : null,
    iphone: phone
      ? {
          access: "on",
          creditsUsed: milliToHours(phone.creditsUsedMilli ?? 0),
          resetsAt: part.billing ? new Date(part.billing.periodEnd).toISOString() : null,
        }
      : null,
    plans: plansOf(catalog, account ? cloudPlanIdOf(account) : null),
    // Free with sponsored cards off (the server's `smallNeedsCards` rule): Small uses credits, as the catalog rates it.
    smallComputers: cloudSmallHoursSentence(catalog, words),
    computers: part.computers && account ? { inUse: part.computers.total, awake: part.computers.awake, limit: cloudAccountComputers(account).limit } : null,
    lanes,
    sizes: tiers.map((tier) => ({
      id: tier.id,
      label: tier.label,
      kind: tier.type === "vm" ? "full" as const : "standard" as const,
      cpu: tier.cpu,
      memoryGb: tier.memoryGb,
      hoursRate: tier.multiplierMilli / 1000,
      usesHours: cloudTierUsesHours(tier),
      isDefault: tier.id === defaultSize,
    })),
    defaultSize,
    agents: limits
      ? {
          unattendedSpend: limits.unattendedSpend,
          newComputersPerDay: limits.machinesPerDay,
          newComputersToday,
          newComputersLeftToday: limits.unattendedSpend ? Math.max(0, limits.machinesPerDay - newComputersToday) : 0,
          // The same test `approve()` makes: the tier's shape within the largest allowed.
          sizesAllowed: tiers.filter((tier) => {
            const shape = cloudShapeFor({ cpu: tier.cpu, memoryGb: tier.memoryGb });
            return shape != null && cloudShapeWithin(shape.id, limits.maxShape);
          }).map((tier) => tier.id),
          preset: cloudLimitsPresetOf(limits) ?? "custom",
          setting: CLOUD_DAILY_LIMIT_SETTING,
        }
      : null,
    message: result.state !== "ok" ? canStartLane.reason : !account ? CLOUD_ACCOUNT_UNKNOWN_MESSAGE : null,
  };
}
