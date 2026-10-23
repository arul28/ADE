/**
 * `ade usage limits`: the quota snapshot cut down to what an agent plans with.
 *
 * The full `UsageSnapshot` carries cost history and daily charts (close to a
 * megabyte as JSON), and its text form names accounts by email, which is not
 * what `ade chat create --instance` takes. This report keeps, per account, the
 * id to start a chat on, how much of each window is left, when it resets, how
 * fast it is going, how old the reading is, and whether the account can take a
 * chat at all. Nothing here decides anything for the agent.
 *
 * Pure and clock-injected: the host builds it for the `usage.getUsageLimits`
 * action, and the CLI builds the same report from a full snapshot when an
 * older host has no such action.
 */
import type {
  UsageAccount,
  UsagePacingStatus,
  UsageProvider,
  UsageProviderStatus,
  UsageSnapshot,
  UsageWindow,
} from "./types/usage";
import { computeResetsInMs, windowLabel } from "./usageWindowPresentation";

export type UsageLimitsPace = {
  status: UsagePacingStatus;
  /** True when the current rate leaves room until the window resets. */
  lastsToReset: boolean;
  /** Minutes until the window is used up at the current rate; null when it lasts or the rate is ~0. */
  runsOutInMinutes: number | null;
};

export type UsageLimitsWindow = {
  type: string;
  /** "5-hour", "Weekly", "Monthly", … — the same names the app uses. */
  label: string;
  percentLeft: number;
  resetsAt: string | null;
  resetsInMinutes: number | null;
  /** The reset time passed after the reading: the window is full again. */
  hasReset?: true;
  unlimited?: true;
  /** Exact request meter, when the provider counts requests (Copilot). */
  countLeft?: number;
  countTotal?: number;
  /** Percent left of a model's own share of this window (Claude Opus, Sonnet). */
  models?: Record<string, number>;
  pace?: UsageLimitsPace;
};

/**
 * - `ok`: a fresh reading.
 * - `stale`: the last check failed; these are the last numbers that worked.
 * - `expired`: the stored login expired; the provider renews it on the next chat.
 * - `signed_out`: no usable login; the account cannot take a chat.
 * - `no_reading`: signed in, but no limits have been read yet.
 * - `error`: the check failed and there are no numbers.
 */
export type UsageLimitsAccountState = "ok" | "stale" | "expired" | "signed_out" | "no_reading" | "error";

export type UsageLimitsAccount = {
  provider: UsageProvider;
  /** The snapshot's account id, e.g. `claude:work` or `cursor:local`. */
  accountId: string;
  /** What `ade chat create --instance` takes. Claude and Codex only; null for one-login providers. */
  instanceId: string | null;
  email: string | null;
  /** The name the user gave the account in Settings. */
  label: string | null;
  plan: string | null;
  readAt: string | null;
  ageMinutes: number | null;
  state: UsageLimitsAccountState;
  /** Why the state is not `ok`, in a few words. */
  note: string | null;
  /** The chat that asked runs on this account. */
  thisChat: boolean;
  /** Smart balance would start the next new chat here (only while smart balance is on). */
  nextChat: boolean;
  /** Banked resets the provider granted, when it grants them. */
  resetCredits?: number;
  windows: UsageLimitsWindow[];
};

export type UsageLimitsReport = {
  /** When the host last polled any provider. */
  readAt: string | null;
  /** The account the asking chat runs on, when a chat asked and its provider has accounts. */
  chat: { provider: string; instanceId: string } | null;
  accounts: UsageLimitsAccount[];
  /** Provider-wide facts that change what an account can do (Codex's spending cap). */
  notes: string[];
};

export type BuildUsageLimitsReportOptions = {
  nowMs: number;
  /** Only this provider's accounts. */
  provider?: string | null;
  /** The asking chat's provider and account. */
  chat?: { provider: string; instanceId: string } | null;
};

/** Providers that take `--instance` (several logins on one machine). */
const INSTANCE_PROVIDERS: ReadonlySet<string> = new Set(["claude", "codex"]);

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function clampPercent(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function minutesBetween(fromMs: number, toMs: number): number {
  return Math.max(0, Math.round((toMs - fromMs) / 60_000));
}

function buildWindow(window: UsageWindow, readAtMs: number | null, nowMs: number): UsageLimitsWindow {
  const resetsAt = isoOrNull(window.resetsAt);
  // A reading with no reset time keeps its fill: there is no reset to have
  // passed. One whose reset passed since the reading is full again.
  const hasReset = resetsAt != null && computeResetsInMs(resetsAt, nowMs) <= 0;
  const used = hasReset ? 0 : clampPercent(window.percentUsed);
  const out: UsageLimitsWindow = {
    type: window.windowType,
    label: windowLabel({ windowType: window.windowType, windowDurationMs: window.windowDurationMs ?? null }),
    percentLeft: round1(100 - used),
    resetsAt,
    resetsInMinutes: resetsAt && !hasReset ? minutesBetween(nowMs, Date.parse(resetsAt)) : null,
  };
  if (hasReset) out.hasReset = true;
  if (window.unlimited === true) {
    out.unlimited = true;
    out.percentLeft = 100;
  }
  if (
    !hasReset
    && typeof window.entitlementCount === "number" && Number.isFinite(window.entitlementCount) && window.entitlementCount > 0
    && typeof window.usedCount === "number" && Number.isFinite(window.usedCount)
  ) {
    out.countTotal = window.entitlementCount;
    out.countLeft = Math.max(0, window.entitlementCount - window.usedCount);
  }
  if (!hasReset && window.modelBreakdown) {
    const models: Record<string, number> = {};
    for (const [model, percentUsed] of Object.entries(window.modelBreakdown)) {
      if (typeof percentUsed === "number" && Number.isFinite(percentUsed)) models[model] = round1(100 - clampPercent(percentUsed));
    }
    if (Object.keys(models).length > 0) out.models = models;
  }
  const pacing = window.pacing;
  if (!hasReset && !out.unlimited && pacing) {
    // `etaHours` was measured at the reading, so it counts from then, not now.
    const etaHours = typeof pacing.etaHours === "number" && Number.isFinite(pacing.etaHours) ? pacing.etaHours : null;
    const runsOutAtMs = etaHours != null && !pacing.willLastToReset
      ? (readAtMs ?? nowMs) + etaHours * 3_600_000
      : null;
    out.pace = {
      status: pacing.status,
      lastsToReset: pacing.willLastToReset === true,
      runsOutInMinutes: runsOutAtMs == null ? null : minutesBetween(nowMs, runsOutAtMs),
    };
  }
  return out;
}

function accountState(
  account: UsageAccount | null,
  status: UsageProviderStatus | undefined,
  windowCount: number,
): { state: UsageLimitsAccountState; note: string | null } {
  if (account?.login === "signed_out") return { state: "signed_out", note: "signed out; can't take a chat until it signs in again" };
  if (account?.login === "expired") return { state: "expired", note: "login expired; renews on its next chat" };
  if (status?.state === "stale") return { state: "stale", note: status.message?.trim() || "last check failed; showing the last numbers" };
  if (windowCount === 0) {
    if (account?.notice?.message) return { state: "no_reading", note: `${account.notice.message.trim()}; retrying` };
    if (status?.state === "error") return { state: "error", note: status.message?.trim() || "couldn't read limits" };
    return { state: "no_reading", note: "no limits read yet" };
  }
  return { state: "ok", note: null };
}

/**
 * One row per account the host reads limits for, each with its windows.
 *
 * Windows without an account id (an older host, or a one-login provider) join
 * that provider's only account, or a `<provider>:local` row when there is no
 * account to join. A provider that is not signed in on the machine is absent.
 */
export function buildUsageLimitsReport(
  snapshot: Partial<UsageSnapshot> | null | undefined,
  options: BuildUsageLimitsReportOptions,
): UsageLimitsReport {
  const { nowMs } = options;
  const providerFilter = options.provider?.trim().toLowerCase() || null;
  const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : [];
  const knownAccounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
  const providerStatus = snapshot?.providerStatus ?? {};
  const chat = options.chat ?? null;
  const nextChat = new Set((snapshot?.balanceNext ?? []).map((pick) => `${pick.provider}:${pick.instanceId}`));

  const accounts: UsageAccount[] = [...knownAccounts];
  const windowsByAccount = new Map<string, UsageWindow[]>();
  for (const window of windows) {
    let accountId = window.accountId?.trim() || null;
    if (!accountId) {
      const own = accounts.filter((account) => account.provider === window.provider);
      if (own.length === 1) accountId = own[0]!.id;
      else {
        accountId = `${window.provider}:local`;
        if (!accounts.some((account) => account.id === accountId)) {
          const status = providerStatus[window.provider];
          accounts.push({
            id: accountId,
            provider: window.provider,
            ...(status?.accountEmail ? { email: status.accountEmail } : {}),
            ...(status?.accountPlan ? { plan: status.accountPlan } : {}),
            machines: [],
          });
        }
      }
    } else if (!accounts.some((account) => account.id === accountId)) {
      accounts.push({ id: accountId, provider: window.provider, machines: [] });
    }
    const list = windowsByAccount.get(accountId) ?? [];
    list.push(window);
    windowsByAccount.set(accountId, list);
  }

  // A provider that failed with nothing to show still gets a row, so "Claude
  // could not be read" is not mistaken for "Claude is not signed in here".
  for (const [provider, status] of Object.entries(providerStatus) as Array<[UsageProvider, UsageProviderStatus | undefined]>) {
    if (status?.state !== "error" && status?.state !== "stale") continue;
    if (accounts.some((account) => account.provider === provider)) continue;
    accounts.push({
      id: `${provider}:local`,
      provider,
      ...(status.accountEmail ? { email: status.accountEmail } : {}),
      machines: [],
    });
  }

  const rows: UsageLimitsAccount[] = [];
  for (const account of accounts) {
    if (providerFilter && account.provider !== providerFilter) continue;
    const status = providerStatus[account.provider];
    const accountWindows = windowsByAccount.get(account.id) ?? [];
    const readAt = isoOrNull(account.machines?.[0]?.checkedAt)
      ?? isoOrNull(status?.updatedAt)
      ?? isoOrNull(status?.lastSuccessAt)
      ?? (accountWindows.length > 0 ? isoOrNull(snapshot?.lastPolledAt) : null);
    const readAtMs = readAt ? Date.parse(readAt) : null;
    const instanceId = INSTANCE_PROVIDERS.has(account.provider)
      ? account.instanceId?.trim()
        || (account.id.startsWith(`${account.provider}:`) && !account.id.includes("@")
          ? account.id.slice(account.provider.length + 1)
          : null)
        || null
      : null;
    const { state, note } = accountState(account, status, accountWindows.length);
    const row: UsageLimitsAccount = {
      provider: account.provider,
      accountId: account.id,
      instanceId,
      email: account.email?.trim() || null,
      label: account.label?.trim() || null,
      plan: account.plan?.trim() || null,
      readAt,
      ageMinutes: readAtMs == null ? null : minutesBetween(readAtMs, nowMs),
      state,
      note,
      thisChat: Boolean(chat && instanceId && chat.provider === account.provider && chat.instanceId === instanceId),
      nextChat: Boolean(instanceId && nextChat.has(`${account.provider}:${instanceId}`)),
      windows: accountWindows.map((window) => buildWindow(window, readAtMs, nowMs)),
    };
    const credits = account.resetCredits?.availableCount;
    if (typeof credits === "number" && credits > 0) row.resetCredits = credits;
    rows.push(row);
  }

  const notes: string[] = [];
  if (snapshot?.spendControlReached === true && (!providerFilter || providerFilter === "codex")) {
    notes.push("Codex spending cap reached: Codex can't spend credits once its limits run out.");
  }

  return {
    readAt: isoOrNull(snapshot?.lastPolledAt),
    chat: chat && (!providerFilter || chat.provider === providerFilter) ? chat : null,
    accounts: rows,
    notes,
  };
}

/** "45m", "3h 10m", "2d 4h". */
export function formatLimitsDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  if (hours < 24) {
    const rest = total % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

/** The pace of one window in words: "lasts to reset", "runs out in 18h". */
export function usageLimitsPaceText(window: UsageLimitsWindow): string {
  if (window.hasReset) return "reset since the reading; full again";
  if (window.unlimited) return "unlimited";
  const pace = window.pace;
  if (!pace) return "";
  if (window.percentLeft <= 0) return "used up";
  if (pace.lastsToReset || pace.runsOutInMinutes == null) return "lasts to reset";
  return pace.runsOutInMinutes <= 0 ? "about to run out" : `runs out in ${formatLimitsDuration(pace.runsOutInMinutes)}`;
}

/** How much of one window is left: "61%", "268 of 300 left (89%)", "unlimited". */
export function usageLimitsLeftText(window: UsageLimitsWindow): string {
  if (window.unlimited) return "unlimited";
  // Whole percents read faster; under 1% keeps its decimal so "0.4%" is not "0%".
  const left = window.percentLeft;
  const percent = `${left > 0 && left < 1 ? left.toFixed(1) : Math.floor(left)}%`;
  const models = window.models
    ? ` (${Object.entries(window.models).map(([model, left]) => `${model} ${Math.round(left)}%`).join(", ")})`
    : "";
  if (window.countLeft != null && window.countTotal != null) return `${window.countLeft} of ${window.countTotal} (${percent})${models}`;
  return `${percent}${models}`;
}
