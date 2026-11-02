/**
 * Pooling live quota across environments (machines).
 *
 * Provider rate limits belong to the provider account, not the machine, so the
 * same login signed in on two machines reports the same window. Showing both
 * would double the bar; the pooled view counts each account once, taking the
 * freshest machine's reading for each account + window label.
 *
 * Pure and clock-free: the caller supplies the environments freshest-first (the
 * local machine, then the most recently captured), so "first wins" is a stable
 * choice. Shared between the main process's account-scope merge and the
 * renderer's environment filter so the two never disagree about one number.
 */
import type { UsageAccount, UsageWindow } from "./types";
import type { AdeUsageLiveEnvironment, UsageAccountMachine } from "./types/usage";
import { windowLabel } from "./usageWindowPresentation";

/**
 * The identity two machines' readings of one login pool under.
 *
 * Provider + email is the rule: the same
 * login on two machines may have different local instance ids, so keying by id
 * would count it twice. A login with no email cannot be matched across machines
 * and stays keyed by its own id — a deliberate under-pool rather than a guess.
 */
export function liveAccountPoolKey(account: UsageAccount): string {
  const email = account.email?.trim().toLowerCase();
  return email ? `${account.provider}:${email}` : account.id;
}

export type PooledLiveQuota = {
  /** One window per account + window label, from the freshest environment. */
  windows: UsageWindow[];
  /** The pooled accounts those windows belong to. */
  accounts: UsageAccount[];
};

/**
 * Merge environments into one pooled reading.
 *
 * `selectedMachineKeys` filters which environments contribute; `null`/absent
 * means all. An account contributes only the windows it actually reports, so a
 * monthly-only account adds nothing to a session or weekly bar — the label is
 * part of the dedupe key, keeping monthly separate from session and weekly.
 */
export function poolLiveQuota(
  environments: readonly AdeUsageLiveEnvironment[],
  selectedMachineKeys?: ReadonlySet<string> | null,
): PooledLiveQuota {
  const selected = selectedMachineKeys ?? null;
  const accountsByKey = new Map<string, UsageAccount>();
  const windowsByKey = new Map<string, UsageWindow>();

  for (const environment of environments) {
    if (selected && !selected.has(environment.machineKey)) continue;
    // This environment's own account ids mapped onto their pool keys, so a
    // window can be attributed to the pooled account even when the machines
    // name the login differently.
    const poolKeyByAccountId = new Map<string, string>();
    for (const account of environment.accounts) {
      const key = liveAccountPoolKey(account);
      poolKeyByAccountId.set(account.id, key);
      const existing = accountsByKey.get(key);
      if (!existing) {
        accountsByKey.set(key, { ...account, machines: [...account.machines] });
        continue;
      }
      for (const machine of account.machines) {
        if (existing.machines.some((known) => known.label === machine.label)) continue;
        existing.machines.push(machine);
      }
      if (!existing.plan && account.plan) existing.plan = account.plan;
      if (!existing.label && account.label) existing.label = account.label;
      // Credits belong to the login, not the machine that noticed them.
      if (!existing.resetCredits && account.resetCredits) existing.resetCredits = account.resetCredits;
    }
    for (const window of environment.windows) {
      const accountKey = window.accountId
        ? poolKeyByAccountId.get(window.accountId) ?? window.accountId
        : `${window.provider}:local`;
      // First environment wins: the caller's order is freshest-first.
      const dedupeKey = `${accountKey}\x00${window.provider}\x00${windowLabel(window)}`;
      if (windowsByKey.has(dedupeKey)) continue;
      windowsByKey.set(dedupeKey, window);
    }
  }

  return { windows: [...windowsByKey.values()], accounts: [...accountsByKey.values()] };
}

/** One peer machine's live quota, as its last account refresh reported it. */
export type PeerLiveQuota = {
  machineKey: string;
  label: string;
  windows: readonly UsageWindow[];
  accounts: readonly UsageAccount[];
};

function readingAtMs(account: UsageAccount): number {
  let latest = Number.NEGATIVE_INFINITY;
  for (const machine of account.machines) {
    const at = Date.parse(machine.checkedAt ?? "");
    if (Number.isFinite(at) && at > latest) latest = at;
  }
  return latest;
}

function liveWindowsFor(windows: readonly UsageWindow[], accountId: string, nowMs: number): UsageWindow[] {
  return windows.filter((window) => window.accountId === accountId && Date.parse(window.resetsAt) > nowMs);
}

type PeerReading = { peer: PeerLiveQuota; account: UsageAccount; windows: UsageWindow[]; atMs: number };

/**
 * The freshest unexpired reading of each login across the peers. A reading
 * from a working token beats one taken before that machine's login expired;
 * within the same kind, the newer check wins.
 */
function freshestPeerReadings(peers: readonly PeerLiveQuota[], nowMs: number): Map<string, PeerReading> {
  const best = new Map<string, PeerReading>();
  const rank = (reading: PeerReading): [number, number] => [
    reading.account.login === "expired" || reading.account.login === "signed_out" ? 0 : 1,
    reading.atMs,
  ];
  for (const peer of peers) {
    for (const account of peer.accounts) {
      if (!account.email?.trim()) continue;
      const windows = liveWindowsFor(peer.windows, account.id, nowMs);
      if (windows.length === 0) continue;
      const candidate: PeerReading = { peer, account, windows, atMs: readingAtMs(account) };
      const key = liveAccountPoolKey(account);
      const current = best.get(key);
      if (current) {
        const [cLive, cAt] = rank(current);
        const [nLive, nAt] = rank(candidate);
        if (nLive < cLive || (nLive === cLive && !(nAt > cAt))) continue;
      }
      best.set(key, candidate);
    }
  }
  return best;
}

function readingMachine(reading: PeerReading): UsageAccountMachine & { machineKey: string } {
  return {
    machineKey: reading.peer.machineKey,
    label: reading.peer.label,
    ...(Number.isFinite(reading.atMs) ? { checkedAt: new Date(reading.atMs).toISOString() } : {}),
  };
}

function rebasedWindows(reading: PeerReading, accountId: string, nowMs: number): UsageWindow[] {
  return reading.windows.map((window) => ({
    ...window,
    accountId,
    resetsInMs: Math.max(0, Date.parse(window.resetsAt) - nowMs),
  }));
}

/**
 * This machine's snapshot with each login's quota taken from the freshest
 * machine on the ADE account.
 *
 * Quota belongs to the login, so a machine whose token for it expired, or that
 * has not polled it lately, shows what another machine read a minute ago
 * instead of "No usage yet" or a window whose reset already passed. A local
 * reading from a working token wins whenever it is at least as fresh.
 * Accounts, ids, login state and reset credits stay local: they describe what
 * this machine can do with the login.
 *
 * `includeOtherMachineLogins` also lists logins signed in only on another
 * machine, marked `notSignedInHere`, so the user sees every account's room in
 * one place. The picker reads the view without them: such a login cannot take
 * a chat here.
 */
export function fillQuotaFromPeers<T extends { windows: UsageWindow[]; accounts?: UsageAccount[] }>(
  local: T,
  peers: readonly PeerLiveQuota[],
  nowMs: number,
  options: { includeOtherMachineLogins?: boolean } = {},
): T {
  if (peers.length === 0) return local;
  const readings = freshestPeerReadings(peers, nowMs);
  if (readings.size === 0) return local;
  const accounts = local.accounts ?? [];

  let windows = local.windows;
  let nextAccounts: UsageAccount[] | null = null;
  const localKeys = new Set<string>();
  accounts.forEach((account, index) => {
    if (!account.email?.trim()) return;
    const poolKey = liveAccountPoolKey(account);
    localKeys.add(poolKey);
    const reading = readings.get(poolKey);
    if (!reading) return;
    const ownLive = liveWindowsFor(local.windows, account.id, nowMs);
    const ownUsable = ownLive.length > 0 && account.login !== "expired" && account.login !== "signed_out";
    // An undated peer reading only fills a hole; it never displaces a live local one.
    if (ownUsable && !(reading.atMs > readingAtMs(account))) return;
    windows = [
      ...windows.filter((window) => window.accountId !== account.id),
      ...rebasedWindows(reading, account.id, nowMs),
    ];
    const machine = readingMachine(reading);
    // The peer's numbers answer the question; this machine's throttle notice no longer does.
    const { notice: _notice, ...rest } = account;
    nextAccounts ??= [...accounts];
    nextAccounts[index] = {
      ...rest,
      machines: [machine, ...account.machines.filter((known) => known.label !== machine.label)],
      readingFrom: machine,
    };
  });

  if (options.includeOtherMachineLogins) {
    for (const [poolKey, reading] of readings) {
      if (localKeys.has(poolKey)) continue;
      const email = reading.account.email!.trim();
      // Its own id: the peer's instance id names a different login here, or none.
      const id = `${reading.account.provider}:elsewhere:${email.toLowerCase()}`;
      const machine = readingMachine(reading);
      windows = [...windows, ...rebasedWindows(reading, id, nowMs)];
      nextAccounts ??= [...accounts];
      nextAccounts.push({
        id,
        provider: reading.account.provider,
        email,
        ...(reading.account.plan ? { plan: reading.account.plan } : {}),
        ...(reading.account.url ? { url: reading.account.url } : {}),
        machines: [machine],
        readingFrom: machine,
        notSignedInHere: true,
      });
    }
  }

  if (!nextAccounts) return local;
  return { ...local, windows, accounts: nextAccounts };
}
