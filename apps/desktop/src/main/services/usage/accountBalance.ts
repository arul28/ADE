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
 * Below this much five-hour room, the account's score shrinks in step. A chat
 * on an account with 20% of its five-hour window left stops within the hour,
 * even when its weekly room is the most urgent to use.
 */
const FULL_FIVE_HOUR_HEADROOM = 50;
/** An unreadable reset time counts as a full week away: the slowest urgency. */
const DEFAULT_WEEKLY_DURATION_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_FIVE_HOUR_DURATION_MS = 5 * 60 * 60_000;
/** A reset closer than this counts as this far, so the rate stays finite. */
const MIN_HOURS_TO_RESET = 0.25;
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
  return Math.max(MIN_HOURS_TO_RESET, remainingMs / 3_600_000);
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
  | { kind: "room"; urgency: number; fiveHourHeadroom: number };

/**
 * How much one account can take now, and how soon its room expires.
 *
 * `urgency` is the burn rate the account needs to use its remaining room
 * before the reset: headroom percent per hour until the reset. Room that
 * resets tomorrow is worth more now than the same room that resets in six
 * days, because the first is lost if no chat uses it. The weekly window sets
 * the rate when it is known. The five-hour window gates the account and scales
 * the rate down when less than half of it is left.
 *
 * A missing five-hour window is an idle account: Claude and Codex show that
 * window only after the account's first request in it, so it has all its
 * five-hour room.
 */
function accountRoom(windows: readonly UsageWindow[], nowMs: number): AccountRoom {
  const fiveHour = windowForType(windows, "five_hour");
  const weekly = windowForType(windows, "weekly");
  const fiveHourHeadroom = headroom(fiveHour);
  const weeklyHeadroom = headroom(weekly);
  if (fiveHourHeadroom === undefined && weeklyHeadroom === undefined) return { kind: "unknown" };
  if (fiveHourHeadroom !== undefined && fiveHourHeadroom <= MIN_FIVE_HOUR_HEADROOM) return { kind: "full" };
  if (weeklyHeadroom !== undefined && weeklyHeadroom <= MIN_WEEKLY_HEADROOM) return { kind: "full" };
  const rate = weekly && weeklyHeadroom !== undefined
    ? weeklyHeadroom / hoursToReset(weekly, DEFAULT_WEEKLY_DURATION_MS, nowMs)
    : fiveHourHeadroom! / hoursToReset(fiveHour!, DEFAULT_FIVE_HOUR_DURATION_MS, nowMs);
  const fiveHourRoom = fiveHourHeadroom ?? 100;
  const urgency = rate * Math.min(1, fiveHourRoom / FULL_FIVE_HOUR_HEADROOM);
  return { kind: "room", urgency, fiveHourHeadroom: fiveHourRoom };
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
  const signedIn = instances.filter((instance) => instance.provider === provider && instance.signedIn);
  if (signedIn.length < 2) {
    return { instanceId: defaultId, reason: "one signed-in account", skip: "one_account" };
  }

  const signedOutInstanceIds: string[] = [];
  let best: { instance: ProviderInstance; urgency: number; fiveHourHeadroom: number } | null = null;
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
    const better = !best
      || room.urgency > best.urgency + SCORE_EPSILON
      || (Math.abs(room.urgency - best.urgency) <= SCORE_EPSILON
        && (room.fiveHourHeadroom > best.fiveHourHeadroom + SCORE_EPSILON
          || (Math.abs(room.fiveHourHeadroom - best.fiveHourHeadroom) <= SCORE_EPSILON
            && instance.id === defaultId)));
    if (better) best = { instance, urgency: room.urgency, fiveHourHeadroom: room.fiveHourHeadroom };
  }

  const signedOut = signedOutInstanceIds.length > 0 ? { signedOutInstanceIds } : {};
  if (best) {
    return { instanceId: best.instance.id, reason: "use-before-reset rate", ...signedOut };
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
    instance.provider === provider && instance.signedIn && instance.id !== blockedId
  ));
  let chosen: { instance: ProviderInstance; urgency: number } | null = null;
  for (const instance of candidates) {
    const { account, windows } = readingFor({ provider, accounts, windowsByAccountId }, instance.id);
    if (account?.login === "signed_out" || !hasImmediateRoom(windows)) continue;
    const room = accountRoom(windows, nowMs);
    // Near-full accounts still count here: any room beats a stopped chat.
    const urgency = room.kind === "room" ? room.urgency : 0;
    if (!chosen || urgency > chosen.urgency + SCORE_EPSILON) chosen = { instance, urgency };
  }
  if (!chosen) return null;
  const label = chosen.instance.label.trim() || chosen.instance.id;
  return { instanceId: chosen.instance.id, label, reason: "use-before-reset rate" };
}
