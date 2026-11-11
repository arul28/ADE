/**
 * Renewal ahead of expiry on the owner computer (P5 step 3a, design §5.1).
 *
 * The origin of a sign-in stays its owner (`refreshOwner`). Where ADE can make
 * the provider's own CLI renew (Codex 24 h before expiry, Grok 200 s before),
 * the owner renews ahead, so the access-only copies on cloud computers never
 * run out while it is on. The renewed file is then captured and pushed by the
 * normal pass, with `refreshOwner` = this computer.
 *
 * "No renewals for nobody": the sync gives this planner a sign-in only when
 * capture is on, the sign-in is on and in use for ADE Cloud, this computer
 * owns it, and the account has a cloud computer. Anything else plans nothing,
 * and no timer exists.
 *
 * One timer for each planned sign-in, aimed at `expiresAt - ahead`, unref'd.
 * A sign-in renews at most once at a time on this computer: one renewal per
 * provider in this process, and the machine lock the proxy's own keeper takes
 * (`borrowedLogins.ts`) across processes.
 *
 * Step 3b: the same planner runs on a cloud computer for a sign-in it took
 * the renewal over for (it is the vault's owner then), and stops when the
 * origin claims it back. The takeover itself and the write-back to the
 * origin are in the sync (`providerLoginSync.ts`).
 */

import type { ProviderLoginProvider } from "../../../shared/types/providerLogins";

export type ProviderLoginRenewer = {
  /** How long before expiry to renew, for each provider ADE can make renew (`BORROW_RENEW_AHEAD_MS`). */
  aheadMs: Partial<Record<ProviderLoginProvider, number>>;
  /**
   * One renewal by the provider's own CLI, under the machine lock the proxy's
   * keeper also takes. True when the CLI answered, false when it failed, null
   * when the lock was busy (the keeper renews this computer's logins now).
   */
  renew(provider: ProviderLoginProvider): Promise<boolean | null>;
  /**
   * Run `fn` under the same machine lock, or null when it is busy. The
   * write-back on the origin (step 3b) takes it, so it never writes a login
   * file while ADE's own keeper renews it.
   */
  withLock?<T>(fn: () => Promise<T>): Promise<T | null>;
};

export type OwnerRenewTarget = { key: string; provider: ProviderLoginProvider; expiresAt: number };

export type OwnerRenewOutcome = "renewed" | "failed" | "busy";

/** After a renewal that did not move the expiry, the next try waits this long. */
export const RENEW_RETRY_MS = 60_000;
/** Tries for one expiry; then nothing until the expiry changes (the CLI renews itself when used). */
export const RENEW_MAX_TRIES = 3;
/** setTimeout's largest delay; a later expiry is planned again by a later pass. */
const MAX_TIMER_MS = 2 ** 31 - 1;

type Logger = { info(event: string, data?: Record<string, unknown>): void };

export function createOwnerRenewal(args: {
  renewer: ProviderLoginRenewer;
  now: () => number;
  logger: Logger;
  /** After each renewal: the sync reads the file again and pushes it. */
  onRenewed: (target: OwnerRenewTarget, outcome: OwnerRenewOutcome) => void;
}) {
  const timers = new Map<string, { timer: ReturnType<typeof setTimeout>; dueAt: number; target: OwnerRenewTarget }>();
  const tries = new Map<string, { expiresAt: number; count: number; lastAt: number }>();
  const running = new Set<ProviderLoginProvider>();
  let renewals = 0;

  function dueAt(target: OwnerRenewTarget): number | null {
    const ahead = args.renewer.aheadMs[target.provider];
    if (!ahead) return null;
    const tried = tries.get(target.key);
    if (tried && tried.expiresAt === target.expiresAt) {
      if (tried.count >= RENEW_MAX_TRIES) return null;
      return Math.max(target.expiresAt - ahead, tried.lastAt + RENEW_RETRY_MS);
    }
    return target.expiresAt - ahead;
  }

  async function fire(key: string): Promise<void> {
    const planned = timers.get(key);
    if (!planned) return;
    timers.delete(key);
    const { target } = planned;
    if (running.has(target.provider)) return;
    running.add(target.provider);
    const tried = tries.get(key);
    tries.set(key, {
      expiresAt: target.expiresAt,
      count: tried?.expiresAt === target.expiresAt ? tried.count + 1 : 1,
      lastAt: args.now(),
    });
    const started = args.now();
    let outcome: OwnerRenewOutcome;
    try {
      const answer = await args.renewer.renew(target.provider);
      outcome = answer === null ? "busy" : answer ? "renewed" : "failed";
    } catch {
      outcome = "failed";
    } finally {
      running.delete(target.provider);
    }
    if (outcome === "renewed") renewals += 1;
    args.logger.info("provider_login.renewed_ahead", {
      provider: target.provider,
      outcome,
      ms: args.now() - started,
      leftMs: target.expiresAt - started,
    });
    args.onRenewed(target, outcome);
  }

  return {
    /** Make the timers match these sign-ins: one each, aimed at its renewal time. Others go. */
    plan(targets: readonly OwnerRenewTarget[]): void {
      const keep = new Set<string>();
      for (const target of targets) {
        const due = dueAt(target);
        if (due == null) continue;
        keep.add(target.key);
        const have = timers.get(target.key);
        if (have && have.dueAt === due && have.target.expiresAt === target.expiresAt) continue;
        if (have) clearTimeout(have.timer);
        const timer = setTimeout(() => void fire(target.key), Math.min(MAX_TIMER_MS, Math.max(0, due - args.now())));
        timer.unref?.();
        timers.set(target.key, { timer, dueAt: due, target });
      }
      for (const [key, planned] of timers) {
        if (keep.has(key)) continue;
        clearTimeout(planned.timer);
        timers.delete(key);
      }
    },
    stop(): void {
      for (const planned of timers.values()) clearTimeout(planned.timer);
      timers.clear();
    },
    /** Live timers (for the idle numbers). */
    timerCount(): number {
      return timers.size;
    },
    /** Renewals this process ran that the CLI answered. */
    renewalCount(): number {
      return renewals;
    },
  };
}
