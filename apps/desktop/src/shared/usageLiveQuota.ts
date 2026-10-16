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
import type { AdeUsageLiveEnvironment } from "./types/usage";
import { windowLabel } from "./usageWindowPresentation";

/**
 * The identity two machines' readings of one login pool under.
 *
 * Provider + email is the rule (t3 pools by provider + email too): the same
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
