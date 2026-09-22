import type {
  ProviderInstance,
  ProviderInstanceProvider,
} from "../../../shared/types/providerInstances";
import type {
  UsageAccount,
  UsageWindow,
} from "../../../shared/types/usage";

export type AccountBalancePick = {
  instanceId: string;
  reason: string;
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

const DEFAULT_START_WEIGHT = 0.35;
const DEFAULT_END_WEIGHT = 0.85;
const UNKNOWN_WEEKLY_WEIGHT = 0.5;
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

function weeklyWeight(window: UsageWindow | undefined, nowMs: number): number {
  const durationMs = window?.windowDurationMs ?? Number.NaN;
  const resetsAtMs = window ? Date.parse(window.resetsAt) : Number.NaN;
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(resetsAtMs) || !Number.isFinite(nowMs)) {
    return UNKNOWN_WEEKLY_WEIGHT;
  }
  const elapsed = Math.min(1, Math.max(0, (nowMs - (resetsAtMs - durationMs)) / durationMs));
  return DEFAULT_START_WEIGHT + (DEFAULT_END_WEIGHT - DEFAULT_START_WEIGHT) * elapsed;
}

function defaultInstanceId(provider: ProviderInstanceProvider, instances: readonly ProviderInstance[]): string {
  return instances.find((instance) => instance.provider === provider && instance.isDefault)?.id
    ?? provider;
}

/**
 * Chooses the local provider account with the most useful remaining quota.
 *
 * The function is deliberately clock- and I/O-free. The caller supplies the
 * snapshot projection and the current time so chat creation can make one
 * consistent choice and unit tests can exercise the weekly weighting exactly.
 */
export function pickInstanceForNewChat({
  provider,
  instances,
  accounts = [],
  windowsByAccountId,
  nowMs,
}: PickInstanceForNewChatArgs): AccountBalancePick {
  const defaultId = defaultInstanceId(provider, instances);
  const signedIn = instances.filter((instance) => instance.provider === provider && instance.signedIn);
  if (signedIn.length === 0) return { instanceId: defaultId, reason: "no signed-in instances" };

  let best: { instance: ProviderInstance; score: number; complete: boolean } | null = null;
  let hasUsageData = false;
  for (const instance of signedIn) {
    const account = accounts.find(
      (candidate) => candidate.provider === provider && candidate.instanceId === instance.id,
    );
    const accountId = account?.id ?? `${provider}:${instance.id}`;
    const windows = windowsForAccount(windowsByAccountId, accountId);
    const fiveHour = windowForType(windows, "five_hour");
    const weekly = windowForType(windows, "weekly");
    const fiveHourHeadroom = headroom(fiveHour);
    const weeklyHeadroom = headroom(weekly);
    if (fiveHourHeadroom === undefined && weeklyHeadroom === undefined) continue;
    hasUsageData = true;

    const complete = fiveHourHeadroom !== undefined && weeklyHeadroom !== undefined;
    const score = complete
      ? fiveHourHeadroom * (1 - weeklyWeight(weekly, nowMs)) + weeklyHeadroom * weeklyWeight(weekly, nowMs)
      : fiveHourHeadroom ?? weeklyHeadroom!;
    if (
      !best
      || score > best.score + SCORE_EPSILON
      || (Math.abs(score - best.score) <= SCORE_EPSILON
        && instance.id === defaultId
        && best.instance.id !== defaultId)
    ) {
      best = { instance, score, complete };
    }
  }

  if (!hasUsageData || !best) return { instanceId: defaultId, reason: "no usage data" };
  return {
    instanceId: best.instance.id,
    reason: best.complete ? "weighted headroom" : "partial usage data",
  };
}

/**
 * A full window blocks a new turn even when the other window still has room.
 * Missing windows are not a guess that the account is free.
 */
function hasImmediateRoom(windows: readonly UsageWindow[]): boolean {
  const fiveHourHeadroom = headroom(windowForType(windows, "five_hour"));
  const weeklyHeadroom = headroom(windowForType(windows, "weekly"));
  if (fiveHourHeadroom === undefined || weeklyHeadroom === undefined) return false;
  if (fiveHourHeadroom === 0 || weeklyHeadroom === 0) return false;
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
 * An account with no windows, or with a window already at 100%, is not a
 * candidate — ADE does not guess that an unread login is free.
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
  const withRoom = candidates.filter((instance) => {
    const account = accounts.find((candidate) => (
      candidate.provider === provider && candidate.instanceId === instance.id
    ));
    const accountId = account?.id ?? `${provider}:${instance.id}`;
    return hasImmediateRoom(windowsForAccount(windowsByAccountId, accountId));
  });
  if (withRoom.length === 0) return null;
  const pick = pickInstanceForNewChat({
    provider,
    instances: withRoom,
    accounts,
    windowsByAccountId,
    nowMs,
  });
  if (pick.reason === "no usage data" || pick.reason === "no signed-in instances") return null;
  const chosen = withRoom.find((instance) => instance.id === pick.instanceId);
  if (!chosen) return null;
  const label = chosen.label.trim() || chosen.id;
  return { instanceId: chosen.id, label, reason: pick.reason };
}
