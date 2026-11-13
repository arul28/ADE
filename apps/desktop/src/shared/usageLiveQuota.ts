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
  windows: UsageWindow[];
  accounts: UsageAccount[];
};

/** Whether the machine that took a reading could still read the login. */
function loginUsable(account: UsageAccount): boolean {
  return account.login !== "expired" && account.login !== "signed_out";
}

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
  const better = (candidate: PeerReading, current: PeerReading): boolean => {
    const candidateLive = loginUsable(candidate.account);
    if (candidateLive !== loginUsable(current.account)) return candidateLive;
    return candidate.atMs > current.atMs;
  };
  for (const peer of peers) {
    for (const account of peer.accounts) {
      if (!account.email?.trim()) continue;
      const windows = liveWindowsFor(peer.windows, account.id, nowMs);
      if (windows.length === 0) continue;
      const candidate: PeerReading = { peer, account, windows, atMs: readingAtMs(account) };
      const key = liveAccountPoolKey(account);
      const current = best.get(key);
      if (!current || better(candidate, current)) best.set(key, candidate);
    }
  }
  return best;
}

/** A peer that can spend a login's banked resets, and how many it holds. */
type PeerCreditHolder = {
  credits: NonNullable<UsageAccount["resetCredits"]>;
  on: NonNullable<UsageAccount["resetCreditsOn"]>;
  atMs: number;
};

/**
 * For each login, the freshest peer whose own working login reports banked
 * resets. Only that peer can spend them: a credit is claimed with the login's
 * token, which an expired or absent login here does not have.
 */
function peerCreditHolders(peers: readonly PeerLiveQuota[]): Map<string, PeerCreditHolder> {
  const best = new Map<string, PeerCreditHolder>();
  for (const peer of peers) {
    for (const account of peer.accounts) {
      if (!account.email?.trim() || !loginUsable(account)) continue;
      const credits = account.resetCredits;
      if (!credits || credits.availableCount <= 0) continue;
      const key = liveAccountPoolKey(account);
      const atMs = readingAtMs(account);
      const current = best.get(key);
      if (current && !(atMs > current.atMs)) continue;
      best.set(key, {
        credits,
        on: { machineKey: peer.machineKey, label: peer.label, accountId: account.id },
        atMs,
      });
    }
  }
  return best;
}

/**
 * `account` with a peer's credits, when it cannot spend its own: it has none,
 * or its login expired or signed out, so a cached count here is not spendable.
 */
function withPeerCredits(account: UsageAccount, holder: PeerCreditHolder | undefined): UsageAccount {
  if (!holder) return account;
  if (loginUsable(account) && (account.resetCredits?.availableCount ?? 0) > 0) return account;
  return { ...account, resetCredits: holder.credits, resetCreditsOn: holder.on };
}

function readingMachine(reading: PeerReading): UsageAccountMachine & { machineKey: string } {
  return {
    machineKey: reading.peer.machineKey,
    label: reading.peer.label,
    ...(Number.isFinite(reading.atMs) ? { checkedAt: new Date(reading.atMs).toISOString() } : {}),
  };
}

function rebased(window: UsageWindow, accountId: string, nowMs: number): UsageWindow {
  return { ...window, accountId, resetsInMs: Math.max(0, Date.parse(window.resetsAt) - nowMs) };
}

/**
 * This machine's windows with one account's readings swapped for a peer's.
 *
 * Only the window types the peer reported are replaced, in place, so the
 * order holds (the header reads a provider's first window) and a local window
 * the peer could not send — an idle 5-hour window with no reset time — stays.
 */
function swapAccountWindows(
  windows: UsageWindow[],
  accountId: string,
  reading: PeerReading,
  nowMs: number,
): UsageWindow[] {
  const incoming = new Map(reading.windows.map((window) => [windowLabel(window), rebased(window, accountId, nowMs)]));
  const next: UsageWindow[] = [];
  for (const window of windows) {
    const replacement = window.accountId === accountId ? incoming.get(windowLabel(window)) : undefined;
    if (replacement) {
      next.push(replacement);
      incoming.delete(windowLabel(window));
    } else {
      next.push(window);
    }
  }
  next.push(...incoming.values());
  return next;
}

/**
 * Each login this machine holds, with its quota from the freshest machine on
 * the ADE account.
 *
 * Quota belongs to the login, so a machine whose token for it expired, or that
 * has not polled it lately, shows what another machine read a minute ago
 * instead of "No usage yet" or a window whose reset already passed. A local
 * reading from a working token wins whenever it is at least as fresh.
 * Accounts, ids and login state stay local: they describe what this machine
 * can do with the login. Reset credits stay local too, unless this machine has
 * none to spend; then a peer that holds some lends its count and its address.
 */
function overlayPeerReadings<T extends { windows: UsageWindow[]; accounts?: UsageAccount[] }>(
  local: T,
  readings: ReadonlyMap<string, PeerReading>,
  holders: ReadonlyMap<string, PeerCreditHolder>,
  nowMs: number,
): T {
  const accounts = local.accounts ?? [];
  let windows = local.windows;
  let changed = false;
  const nextAccounts = accounts.map((account) => {
    if (!account.email?.trim()) return account;
    const reading = readings.get(liveAccountPoolKey(account));
    if (!reading) return account;
    const ownUsable = loginUsable(account) && liveWindowsFor(local.windows, account.id, nowMs).length > 0;
    // An undated peer reading only fills a hole; it never displaces a live local one.
    if (ownUsable && !(reading.atMs > readingAtMs(account))) return account;
    windows = swapAccountWindows(windows, account.id, reading, nowMs);
    changed = true;
    const machine = readingMachine(reading);
    // The peer's numbers answer the question; this machine's throttle notice no longer does.
    const { notice: _notice, ...rest } = account;
    // This machine could not read the login, so it could not read its banked
    // resets either; the peer that can shows them and spends them.
    return withPeerCredits({
      ...rest,
      machines: [machine, ...account.machines.filter((known) => known.label !== machine.label)],
      readingFrom: machine,
    }, holders.get(liveAccountPoolKey(account)));
  });
  return changed ? { ...local, windows, accounts: nextAccounts } : local;
}

/**
 * Logins signed in only on another machine, marked `notSignedInHere`, so every
 * account's room is in one place. Display only: such a login cannot take a
 * chat here, so the picker never sees them.
 */
function appendElsewhereLogins<T extends { windows: UsageWindow[]; accounts?: UsageAccount[] }>(
  view: T,
  readings: ReadonlyMap<string, PeerReading>,
  holders: ReadonlyMap<string, PeerCreditHolder>,
  nowMs: number,
): T {
  const accounts = view.accounts ?? [];
  const localKeys = new Set(accounts.filter((account) => account.email?.trim()).map(liveAccountPoolKey));
  const extraAccounts: UsageAccount[] = [];
  const extraWindows: UsageWindow[] = [];
  for (const [poolKey, reading] of readings) {
    if (localKeys.has(poolKey)) continue;
    const email = reading.account.email!.trim();
    // Its own id: the peer's instance id names a different login here, or none.
    const id = `${reading.account.provider}:elsewhere:${email.toLowerCase()}`;
    const machine = readingMachine(reading);
    extraWindows.push(...reading.windows.map((window) => rebased(window, id, nowMs)));
    extraAccounts.push(withPeerCredits({
      id,
      provider: reading.account.provider,
      email,
      ...(reading.account.plan ? { plan: reading.account.plan } : {}),
      ...(reading.account.url ? { url: reading.account.url } : {}),
      machines: [machine],
      readingFrom: machine,
      notSignedInHere: true,
    }, holders.get(poolKey)));
  }
  if (extraAccounts.length === 0) return view;
  return { ...view, windows: [...view.windows, ...extraWindows], accounts: [...accounts, ...extraAccounts] };
}

/**
 * The two views of a snapshot pooled with its peers' quota.
 *
 * - `forPicking`: this machine's logins, each with its freshest reading. What
 *   smart balance and every decision reads.
 * - `forDisplay`: that, plus logins only another machine holds. What every
 *   screen shows.
 */
export function poolPeerQuota<T extends { windows: UsageWindow[]; accounts?: UsageAccount[] }>(
  local: T,
  peers: readonly PeerLiveQuota[],
  nowMs: number,
): { forPicking: T; forDisplay: T } {
  if (peers.length === 0) return { forPicking: local, forDisplay: local };
  const readings = freshestPeerReadings(peers, nowMs);
  if (readings.size === 0) return { forPicking: local, forDisplay: local };
  const holders = peerCreditHolders(peers);
  const forPicking = overlayPeerReadings(local, readings, holders, nowMs);
  return { forPicking, forDisplay: appendElsewhereLogins(forPicking, readings, holders, nowMs) };
}
