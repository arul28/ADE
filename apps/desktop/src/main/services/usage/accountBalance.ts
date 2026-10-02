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
};

/**
 * A window with this much room or less cannot take a new chat. The chat would
 * hit the limit after a few turns, so a fuller account is not a real choice.
 */
const MIN_FIVE_HOUR_HEADROOM = 10;
const MIN_WEEKLY_HEADROOM = 5;
/**
 * An account with this little five-hour room, and more than
 * {@link FIVE_HOUR_RESET_SOON_HOURS} until that window resets, takes a new chat
 * only when no account has more: the chat would stop on the five-hour limit
 * within the hour, however soon the weekly room expires.
 */
const LOW_FIVE_HOUR_HEADROOM = 25;
const FIVE_HOUR_RESET_SOON_HOURS = 1;
/** An unreadable reset time counts as a full week away: the latest deadline. */
const DEFAULT_WEEKLY_DURATION_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_FIVE_HOUR_DURATION_MS = 5 * 60 * 60_000;
const SCORE_EPSILON = 1e-9;

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
  | { kind: "full" }
  | { kind: "room"; constrained: boolean; hoursToWeeklyReset: number; fiveHourHeadroom: number };

/**
 * How much one account can take now, and when its weekly room expires.
 *
 * Weekly room that is not used before its reset is lost, so the account whose
 * weekly window resets soonest is the one to spend first: every turn it takes
 * is one a later-resetting account keeps for after that reset. Ranking by
 * room per hour instead sent new chats to a fresh account resetting in three
 * days while two accounts resetting within the day let their room expire.
 *
 * The five-hour window gates the account, and marks it `constrained` when
 * little is left and that window is not about to reset.
 *
 * A missing five-hour window is an idle account: Claude and Codex show that
 * window only after the account's first request in it, so it has all its
 * five-hour room. A missing weekly window counts as a full week away.
 */
function accountRoom(windows: readonly UsageWindow[], nowMs: number): AccountRoom {
  const fiveHour = windowForType(windows, "five_hour");
  const weekly = windowForType(windows, "weekly");
  const fiveHourHeadroom = headroom(fiveHour);
  const weeklyHeadroom = headroom(weekly);
  if (fiveHourHeadroom === undefined && weeklyHeadroom === undefined) return { kind: "unknown" };
  if (fiveHourHeadroom !== undefined && fiveHourHeadroom <= MIN_FIVE_HOUR_HEADROOM) return { kind: "full" };
  if (weeklyHeadroom !== undefined && weeklyHeadroom <= MIN_WEEKLY_HEADROOM) return { kind: "full" };
  const hoursToWeeklyReset = weekly
    ? hoursToReset(weekly, DEFAULT_WEEKLY_DURATION_MS, nowMs)
    : DEFAULT_WEEKLY_DURATION_MS / 3_600_000;
  const constrained = fiveHour !== undefined
    && fiveHourHeadroom !== undefined
    && fiveHourHeadroom < LOW_FIVE_HOUR_HEADROOM
    && hoursToReset(fiveHour, DEFAULT_FIVE_HOUR_DURATION_MS, nowMs) > FIVE_HOUR_RESET_SOON_HOURS;
  return { kind: "room", constrained, hoursToWeeklyReset, fiveHourHeadroom: fiveHourHeadroom ?? 100 };
}

type RankedRoom = Extract<AccountRoom, { kind: "room" }>;

/**
 * Whether `a` should take a new chat before `b`: an unconstrained account
 * first, then the sooner weekly reset, then more five-hour room.
 */
function ranksBefore(a: RankedRoom, b: RankedRoom): boolean | null {
  if (a.constrained !== b.constrained) return !a.constrained;
  if (Math.abs(a.hoursToWeeklyReset - b.hoursToWeeklyReset) > SCORE_EPSILON) {
    return a.hoursToWeeklyReset < b.hoursToWeeklyReset;
  }
  if (Math.abs(a.fiveHourHeadroom - b.fiveHourHeadroom) > SCORE_EPSILON) {
    return a.fiveHourHeadroom > b.fiveHourHeadroom;
  }
  return null;
}

/**
 * Chooses the local provider account a new chat should use.
 *
 * The function is deliberately clock- and I/O-free. The caller supplies the
 * snapshot projection and the current time so chat creation can make one
 * consistent choice and unit tests can exercise the scoring exactly.
 *
 * Every result names an account, and a result that is not a balance decision
 * says why in `skip`, so a caller can show the user that balance did not run.
 */
export function pickInstanceForNewChat({
  provider,
  instances,
  accounts = [],
  windowsByAccountId,
  nowMs,
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
  let best: { instance: ProviderInstance; room: RankedRoom } | null = null;
  let unknownCount = 0;
  for (const instance of signedIn) {
    const { account, windows } = readingFor({ provider, accounts, windowsByAccountId }, instance.id);
    // Old windows stay on screen after a login breaks. They are not room.
    if (account?.login === "signed_out") {
      signedOutInstanceIds.push(instance.id);
      continue;
    }
    const room = accountRoom(windows, nowMs);
    if (room.kind === "unknown") {
      unknownCount += 1;
      continue;
    }
    if (room.kind === "full") continue;
    const order = best ? ranksBefore(room, best.room) : true;
    if (order === true || (order === null && instance.id === defaultId)) best = { instance, room };
  }

  const signedOut = signedOutInstanceIds.length > 0 ? { signedOutInstanceIds } : {};
  if (best) {
    return { instanceId: best.instance.id, reason: "soonest weekly reset", ...signedOut };
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
}: PickInstanceForNewChatArgs & { currentInstanceId: string }): UsageLimitAlternatePick | null {
  const blockedId = currentInstanceId.trim() || defaultInstanceId(provider, instances);
  const candidates = instances.filter((instance) => (
    instance.provider === provider && instance.signedIn && !instance.sameLoginAs && instance.id !== blockedId
  ));
  let chosen: { instance: ProviderInstance; room: RankedRoom | null } | null = null;
  for (const instance of candidates) {
    const { account, windows } = readingFor({ provider, accounts, windowsByAccountId }, instance.id);
    if (account?.login === "signed_out" || !hasImmediateRoom(windows)) continue;
    const room = accountRoom(windows, nowMs);
    // Near-full accounts still count here, after every account with real room:
    // any room beats a stopped chat.
    const ranked = room.kind === "room" ? room : null;
    const better = !chosen
      || (ranked !== null && (chosen.room === null || ranksBefore(ranked, chosen.room) === true));
    if (better) chosen = { instance, room: ranked };
  }
  if (!chosen) return null;
  const label = chosen.instance.label.trim() || chosen.instance.id;
  return { instanceId: chosen.instance.id, label, reason: "soonest weekly reset" };
}
