import type {
  ProviderInstance,
  ProviderInstanceProvider,
} from "../../../shared/types/providerInstances";
import type {
  AccountBalanceSkipReason,
  UsageAccount,
  UsageWindow,
} from "../../../shared/types/usage";
import { usageAccountId } from "./usageAccountId";

export type AccountBalancePick = {
  instanceId: string;
  reason: string;
};

/**
 * One open chat that is not burning right now. It is a reservation against the
 * account's weekly room: the chat does not spend anything by existing, but it
 * probably will before the window resets.
 */
export type AccountBalanceIdleChat = {
  /** Milliseconds since this chat last did anything. */
  idleMs: number;
  /** A scheduled wake before the weekly reset makes the resumption certain. */
  wakeAtMs?: number | null;
  /** A failed last turn is likely to be retried. */
  failed?: boolean;
  /** Relative burn of the chat's model; omitted means a normal chat. */
  modelWeight?: number;
};

/**
 * What one account is already expected to spend before its weekly reset.
 *
 * `weeklyRate` and `fiveHourRate` are measured from the provider's own readings
 * and include every client on the login, not only ADE. When no rate is measured
 * yet (a fresh process, or the first poll after a reset), `runningWeight` provides
 * the prior: a running chat is the one thing we know is burning.
 */
export type AccountBalanceLoad = {
  /** Measured weekly percentage points per hour. Undefined = no reading yet. */
  weeklyRate?: number;
  /** Measured five-hour percentage points per hour. Undefined = no reading yet. */
  fiveHourRate?: number;
  /** Model-weighted chats mid-turn, used only when no rate is measured. */
  runningWeight?: number;
  /** Open, not running, not settled or snoozed. */
  idle?: readonly AccountBalanceIdleChat[];
};

/**
 * Chat state the chat service reports for one provider account. Balance turns
 * this into reservations and a prior burn rate; it is raw state, not a decision.
 */
export type ProviderAccountChatLoad = {
  /** Sum of model weights for chats mid-turn (Haiku 0.3, Sonnet 1, Fable 2.4). */
  runningWeight: number;
  /** Open chats that are not running, settled or snoozed. */
  idle: readonly AccountBalanceIdleChat[];
};

/**
 * Why smart balance did not choose an account, next to the account the chat
 * uses instead. `skip` is absent when the pick is a real balance decision.
 */
export type AccountBalanceResult = AccountBalancePick & {
  skip?: AccountBalanceSkipReason;
  /** Signed-in accounts whose stored login is gone. */
  signedOutInstanceIds?: string[];
};

export type PickInstanceForNewChatArgs = {
  provider: ProviderInstanceProvider;
  instances: readonly ProviderInstance[];
  accounts?: readonly UsageAccount[];
  windowsByAccountId:
    | ReadonlyMap<string, readonly UsageWindow[]>
    | Readonly<Record<string, readonly UsageWindow[]>>;
  nowMs: number;
  /** Measured burn and open-chat reservations, keyed by instance id. */
  loadByInstanceId?:
    | ReadonlyMap<string, AccountBalanceLoad>
    | Readonly<Record<string, AccountBalanceLoad>>;
  /** Expected five-hour points one new chat's first turn burns. */
  firstTurnFiveHourBurn?: number;
};

/**
 * A window with this much room or less cannot take a new chat. The five-hour
 * floor is the absolute "can I even start" line; the projection below is what
 * actually decides whether the account can carry the chats already on it.
 */
const MIN_FIVE_HOUR_HEADROOM = 10;
const MIN_WEEKLY_HEADROOM = 5;
/** An unreadable reset time counts as a full week away: the latest deadline. */
const DEFAULT_WEEKLY_DURATION_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_FIVE_HOUR_DURATION_MS = 5 * 60 * 60_000;
/** Never divide by a reset that has already passed; treat it as imminent. */
const MIN_HOURS_TO_RESET = 0.1;
/**
 * Project five-hour burn at most this far ahead. Burn is bursty, and
 * extrapolating one hot turn across four hours would lock an account for no
 * reason; the window itself resets inside five.
 */
const FIVE_HOUR_PROJECTION_HOURS = 1.5;
/** A new chat needs at least this much projected five-hour room. */
const FIVE_HOUR_SURVIVAL_MARGIN = 8;
/** First-turn cost when the caller does not know the model. */
const DEFAULT_FIRST_TURN_FIVE_HOUR_BURN = 3;

/**
 * Relative burn of a model family, used only where no measured rate exists:
 * the prior for running chats, idle reservations, and the first-turn gate.
 * Measured quota movement always wins; this is a starting point, not a price.
 */
export function accountBalanceModelWeight(modelId: string | null | undefined): number {
  const id = modelId?.trim().toLowerCase() ?? "";
  if (!id) return 1;
  if (id.includes("haiku")) return 0.3;
  if (id.includes("opus") || id.includes("fable")) return 2.4;
  return 1;
}

/** The five-hour room one first turn needs on this model. */
export function firstTurnFiveHourBurnForModel(modelId?: string | null): number {
  return DEFAULT_FIRST_TURN_FIVE_HOUR_BURN * accountBalanceModelWeight(modelId);
}
/** Burn per running chat when no measured rate exists yet. */
export const PRIOR_WEEKLY_BURN_PER_RUNNING_CHAT = 0.5;
export const PRIOR_FIVE_HOUR_BURN_PER_RUNNING_CHAT = 3;
/** Weekly points one resumed idle chat is expected to claim. */
const IDLE_RESUME_POINTS = 2;
/** Half-life of the chance an idle chat is resumed. */
const IDLE_RESUME_HALF_LIFE_MS = 6 * 60 * 60_000;
const MAX_IDLE_RESUME_PROBABILITY = 0.9;
/**
 * Two deficits this close are a tie. A tie goes to the sooner weekly reset,
 * because that is the room that will be lost first, and the band keeps a noisy
 * measured rate from flipping the pick on every poll.
 */
const DEFICIT_TIE = 0.15;

function windowsForAccount(
  windowsByAccountId: PickInstanceForNewChatArgs["windowsByAccountId"],
  accountId: string,
): readonly UsageWindow[] {
  if (windowsByAccountId instanceof Map) return windowsByAccountId.get(accountId) ?? [];
  return (windowsByAccountId as Readonly<Record<string, readonly UsageWindow[]>>)[accountId] ?? [];
}

function windowForType(
  windows: readonly UsageWindow[],
  windowType: UsageWindow["windowType"],
): UsageWindow | undefined {
  return windows.find((window) => window.windowType === windowType);
}

function headroom(window: UsageWindow | undefined): number | undefined {
  if (!window || !Number.isFinite(window.percentUsed)) return undefined;
  return 100 - Math.min(100, Math.max(0, window.percentUsed));
}

function hoursToReset(window: UsageWindow, fallbackDurationMs: number, nowMs: number): number {
  const resetsAtMs = Date.parse(window.resetsAt);
  const remainingMs = Number.isFinite(resetsAtMs) && Number.isFinite(nowMs)
    ? resetsAtMs - nowMs
    : window.windowDurationMs ?? fallbackDurationMs;
  return Math.max(0, remainingMs / 3_600_000);
}

function defaultInstanceId(provider: ProviderInstanceProvider, instances: readonly ProviderInstance[]): string {
  return instances.find((instance) => instance.provider === provider && instance.isDefault)?.id
    ?? provider;
}

function loadFor(
  loadByInstanceId: PickInstanceForNewChatArgs["loadByInstanceId"],
  instanceId: string,
): AccountBalanceLoad {
  if (!loadByInstanceId) return {};
  if (loadByInstanceId instanceof Map) return loadByInstanceId.get(instanceId) ?? {};
  return (loadByInstanceId as Readonly<Record<string, AccountBalanceLoad>>)[instanceId] ?? {};
}

/** One instance's usage account (when the snapshot has it) and its windows. */
function readingFor(
  args: Pick<PickInstanceForNewChatArgs, "provider" | "accounts" | "windowsByAccountId">,
  instanceId: string,
): { account: UsageAccount | undefined; windows: readonly UsageWindow[] } {
  const account = (args.accounts ?? []).find(
    (candidate) => candidate.provider === args.provider && candidate.instanceId === instanceId,
  );
  const accountId = account?.id ?? usageAccountId({ provider: args.provider, instanceId });
  return { account, windows: windowsForAccount(args.windowsByAccountId, accountId) };
}

type AccountRoom =
  | { kind: "unknown" }
  | {
    kind: "room";
    weeklyRoom: number;
    fiveHourRoom: number;
    hoursToWeeklyReset: number;
    hoursToFiveHourReset: number;
    /** Points/hour that spends this account's weekly room exactly at its reset. */
    need: number;
    /** Points/hour already committed to this account. */
    load: number;
    /** `need - load`: positive means this account needs more work. */
    deficit: number;
    /** Five-hour room left after the projection window. */
    survivalFiveHour: number;
    /** True when the account clears every floor and the first-turn budget. */
    survives: boolean;
    /** True when a hard floor or the projection rules this account out. */
    blocked: boolean;
  };

/**
 * The expected weekly points an open chat will claim before this account's
 * reset. An idle chat is not burning, so this is a reservation, not a rate:
 * it is divided by the hours to reset when it enters the deficit.
 */
function reservedWeeklyPoints(
  load: AccountBalanceLoad,
  nowMs: number,
  hoursToWeeklyReset: number,
): number {
  const horizonMs = Math.max(0, hoursToWeeklyReset) * 3_600_000;
  let points = 0;
  for (const chat of load.idle ?? []) {
    const weight = chat.modelWeight != null && Number.isFinite(chat.modelWeight)
      ? Math.max(0, chat.modelWeight)
      : 1;
    if (chat.wakeAtMs != null && Number.isFinite(chat.wakeAtMs) && chat.wakeAtMs <= nowMs + horizonMs) {
      points += IDLE_RESUME_POINTS * weight;
      continue;
    }
    if (chat.failed) {
      points += IDLE_RESUME_POINTS * 0.8 * weight;
      continue;
    }
    const idleMs = Number.isFinite(chat.idleMs) ? Math.max(0, chat.idleMs) : 0;
    const probability = Math.min(
      MAX_IDLE_RESUME_PROBABILITY,
      0.5 ** (idleMs / IDLE_RESUME_HALF_LIFE_MS),
    );
    points += probability * IDLE_RESUME_POINTS * weight;
  }
  return points;
}

/**
 * How much one account can take now, and what it already owes.
 *
 * Weekly room that is not used before its reset is lost, so the account whose
 * weekly room needs the fastest spend is the one to feed: `room / hours` is the
 * rate that empties it exactly at the reset. Ranking by reset time alone is the
 * special case where every account's room is equally spendable; it sends every
 * chat to a 38%-left account that resets four hours sooner than a 72%-left one.
 *
 * The five-hour window is a gate, not a ranking. Chats already on the account
 * will keep burning through it, so the gate projects the measured burn over the
 * next short horizon and refuses an account that would run dry mid-chat.
 *
 * A missing five-hour window is an idle account: Claude and Codex show that
 * window only after the account's first request in it, so it has all its
 * five-hour room. A missing weekly window counts as a full week away.
 */
function accountRoom(
  windows: readonly UsageWindow[],
  nowMs: number,
  load: AccountBalanceLoad,
  firstTurnFiveHourBurn: number,
): AccountRoom {
  const fiveHour = windowForType(windows, "five_hour");
  const weekly = windowForType(windows, "weekly");
  const fiveHourRoom = headroom(fiveHour);
  const weeklyRoom = headroom(weekly);
  if (fiveHourRoom === undefined && weeklyRoom === undefined) return { kind: "unknown" };

  const hoursToWeeklyReset = weekly
    ? hoursToReset(weekly, DEFAULT_WEEKLY_DURATION_MS, nowMs)
    : DEFAULT_WEEKLY_DURATION_MS / 3_600_000;
  const hoursToFiveHourReset = fiveHour
    ? hoursToReset(fiveHour, DEFAULT_FIVE_HOUR_DURATION_MS, nowMs)
    : DEFAULT_FIVE_HOUR_DURATION_MS / 3_600_000;
  const divisor = Math.max(MIN_HOURS_TO_RESET, hoursToWeeklyReset);

  const weeklyRate = load.weeklyRate ?? (load.runningWeight ?? 0) * PRIOR_WEEKLY_BURN_PER_RUNNING_CHAT;
  const fiveHourRate = load.fiveHourRate ?? (load.runningWeight ?? 0) * PRIOR_FIVE_HOUR_BURN_PER_RUNNING_CHAT;
  const need = (weeklyRoom ?? 100) / divisor;
  const reservedRate = reservedWeeklyPoints(load, nowMs, hoursToWeeklyReset) / divisor;
  const committed = Math.max(0, weeklyRate) + reservedRate;
  const deficit = need - committed;

  const survivalFiveHour = (fiveHourRoom ?? 100)
    - Math.max(0, fiveHourRate) * Math.min(hoursToFiveHourReset, FIVE_HOUR_PROJECTION_HOURS);
  const firstTurnBudget = Math.max(FIVE_HOUR_SURVIVAL_MARGIN, 2 * firstTurnFiveHourBurn);
  const blocked = (weeklyRoom !== undefined && weeklyRoom < MIN_WEEKLY_HEADROOM)
    || (fiveHourRoom !== undefined && fiveHourRoom < MIN_FIVE_HOUR_HEADROOM)
    || survivalFiveHour <= firstTurnBudget;

  return {
    kind: "room",
    weeklyRoom: weeklyRoom ?? 100,
    fiveHourRoom: fiveHourRoom ?? 100,
    hoursToWeeklyReset,
    hoursToFiveHourReset,
    need,
    load: committed,
    deficit,
    survivalFiveHour,
    survives: !blocked,
    blocked,
  };
}

type RankedInstance = { instance: ProviderInstance; room: Extract<AccountRoom, { kind: "room" }> };

/**
 * Orders two accounts when their deficits are within the tie band. Negative
 * means `a` goes first: the sooner weekly reset, then the healthier five-hour
 * window, then the default account, then a stable id order.
 */
function compareTie(a: RankedInstance, b: RankedInstance, defaultId: string): number {
  if (Math.abs(a.room.hoursToWeeklyReset - b.room.hoursToWeeklyReset) > 1e-9) {
    return a.room.hoursToWeeklyReset - b.room.hoursToWeeklyReset;
  }
  if (Math.abs(a.room.survivalFiveHour - b.room.survivalFiveHour) > 1e-9) {
    return b.room.survivalFiveHour - a.room.survivalFiveHour;
  }
  if (a.instance.id === defaultId) return -1;
  if (b.instance.id === defaultId) return 1;
  return a.instance.id < b.instance.id ? -1 : a.instance.id > b.instance.id ? 1 : 0;
}

/** The largest deficit, with the tie band and deadline order applied. */
function bestByDeficit(candidates: readonly RankedInstance[], defaultId: string): RankedInstance {
  return candidates.reduce((current, candidate) => {
    const gap = candidate.room.deficit - current.room.deficit;
    if (gap > DEFICIT_TIE) return candidate;
    if (gap < -DEFICIT_TIE) return current;
    return compareTie(candidate, current, defaultId) < 0 ? candidate : current;
  });
}

/**
 * When every account is blocked, any room beats a stopped chat. Prefer the
 * account that survives the five-hour projection longest, then the one with
 * more weekly room, then the normal deadline order.
 */
function bestBySurvival(candidates: readonly RankedInstance[], defaultId: string): RankedInstance {
  return candidates.reduce((current, candidate) => {
    const survivalGap = candidate.room.survivalFiveHour - current.room.survivalFiveHour;
    if (Math.abs(survivalGap) > 1e-9) return survivalGap > 0 ? candidate : current;
    const roomGap = candidate.room.weeklyRoom - current.room.weeklyRoom;
    if (Math.abs(roomGap) > 1e-9) return roomGap > 0 ? candidate : current;
    return compareTie(candidate, current, defaultId) < 0 ? candidate : current;
  });
}

/**
 * Chooses the local provider account a new chat should use.
 *
 * The function is deliberately clock- and I/O-free. The caller supplies the
 * snapshot projection, the measured load and the current time so chat creation
 * can make one consistent choice and unit tests can exercise the scoring
 * exactly.
 *
 * Every result names an account, and a result that is not a balance decision
 * says why in `skip`, so a caller can show the user that balance did not run.
 * An account is never refused: when every account is blocked, the least-bad one
 * still receives the chat, because a chat that cannot start is worse.
 */
export function pickInstanceForNewChat({
  provider,
  instances,
  accounts = [],
  windowsByAccountId,
  nowMs,
  loadByInstanceId,
  firstTurnFiveHourBurn = DEFAULT_FIRST_TURN_FIVE_HOUR_BURN,
}: PickInstanceForNewChatArgs): AccountBalanceResult {
  const defaultId = defaultInstanceId(provider, instances);
  // A copy of another account's login is that account's quota, counted once.
  const signedIn = instances.filter((instance) => (
    instance.provider === provider && instance.signedIn && !instance.sameLoginAs
  ));
  if (signedIn.length < 2) {
    return { instanceId: defaultId, reason: "one signed-in account", skip: "one_account" };
  }

  const signedOutInstanceIds: string[] = [];
  const rankedInstances: RankedInstance[] = [];
  let unknownCount = 0;
  for (const instance of signedIn) {
    const { account, windows } = readingFor({ provider, accounts, windowsByAccountId }, instance.id);
    // Old windows stay on screen after a login breaks. They are not room.
    if (account?.login === "signed_out") {
      signedOutInstanceIds.push(instance.id);
      continue;
    }
    const room = accountRoom(
      windows,
      nowMs,
      loadFor(loadByInstanceId, instance.id),
      firstTurnFiveHourBurn,
    );
    if (room.kind === "unknown") {
      unknownCount += 1;
      continue;
    }
    rankedInstances.push({ instance, room });
  }

  const signedOut = signedOutInstanceIds.length > 0 ? { signedOutInstanceIds } : {};
  const eligible = rankedInstances.filter((candidate) => candidate.room.survives);
  if (eligible.length > 0) {
    return {
      instanceId: bestByDeficit(eligible, defaultId).instance.id,
      reason: "most room to spend before reset",
      ...signedOut,
    };
  }
  if (rankedInstances.length > 0) {
    // Never block a new chat: the account that lasts longest takes it.
    return {
      instanceId: bestBySurvival(rankedInstances, defaultId).instance.id,
      reason: "least likely to run dry",
      skip: "all_full",
      ...signedOut,
    };
  }
  if (signedOutInstanceIds.length === signedIn.length) {
    return { instanceId: defaultId, reason: "every login is signed out", skip: "all_signed_out", ...signedOut };
  }
  if (unknownCount > 0) {
    return { instanceId: defaultId, reason: "no usage data", skip: "no_usage_data", ...signedOut };
  }
  return { instanceId: defaultId, reason: "every account is near its limit", skip: "all_full", ...signedOut };
}

/**
 * A full window blocks a new turn even when the other window still has room.
 * An account with no windows at all is not a guess that the account is free,
 * but an account with a weekly reading and no five-hour window is idle, and
 * idle means its five-hour window is empty.
 */
function hasImmediateRoom(windows: readonly UsageWindow[]): boolean {
  const fiveHourHeadroom = headroom(windowForType(windows, "five_hour"));
  const weeklyHeadroom = headroom(windowForType(windows, "weekly"));
  if (weeklyHeadroom === undefined) return false;
  if (weeklyHeadroom === 0 || fiveHourHeadroom === 0) return false;
  return true;
}

export type UsageLimitAlternatePick = {
  instanceId: string;
  label: string;
  reason: string;
};

/**
 * Another signed-in account that can take a turn the current one just lost
 * to a usage limit.
 *
 * A rescue is not a new-chat decision. The question is "can this account
 * finish the turn I just lost?", so five-hour survival leads: an account with
 * the best long-run pace but minutes of five-hour room would simply stop the
 * chat again. Weekly room and the normal deadline order break ties.
 *
 * The current account is excluded even when its snapshot still shows room:
 * the provider already rejected the turn, and the snapshot can lag that.
 * An account with no weekly reading, a window already at 100%, or a login
 * that is gone is not a candidate — ADE does not guess that an unread login
 * is free.
 */
export function pickAlternateInstanceForLimitedChat({
  provider,
  currentInstanceId,
  instances,
  accounts = [],
  windowsByAccountId,
  nowMs,
  loadByInstanceId,
  firstTurnFiveHourBurn = DEFAULT_FIRST_TURN_FIVE_HOUR_BURN,
}: PickInstanceForNewChatArgs & { currentInstanceId: string }): UsageLimitAlternatePick | null {
  const blockedId = currentInstanceId.trim() || defaultInstanceId(provider, instances);
  const candidates = instances.filter((instance) => (
    instance.provider === provider && instance.signedIn && !instance.sameLoginAs && instance.id !== blockedId
  ));
  let chosen: RankedInstance | null = null;
  for (const instance of candidates) {
    const { account, windows } = readingFor({ provider, accounts, windowsByAccountId }, instance.id);
    if (account?.login === "signed_out" || !hasImmediateRoom(windows)) continue;
    const room = accountRoom(
      windows,
      nowMs,
      loadFor(loadByInstanceId, instance.id),
      firstTurnFiveHourBurn,
    );
    if (room.kind !== "room") continue;
    const ranked = { instance, room };
    if (!chosen) {
      chosen = ranked;
      continue;
    }
    const survivalGap = ranked.room.survivalFiveHour - chosen.room.survivalFiveHour;
    if (Math.abs(survivalGap) > 1e-9) {
      if (survivalGap > 0) chosen = ranked;
      continue;
    }
    const roomGap = ranked.room.weeklyRoom - chosen.room.weeklyRoom;
    if (Math.abs(roomGap) > 1e-9) {
      if (roomGap > 0) chosen = ranked;
      continue;
    }
    if (compareTie(ranked, chosen, defaultInstanceId(provider, instances)) < 0) chosen = ranked;
  }
  if (!chosen) return null;
  const label = chosen.instance.label.trim() || chosen.instance.id;
  return { instanceId: chosen.instance.id, label, reason: "most five-hour room left" };
}
