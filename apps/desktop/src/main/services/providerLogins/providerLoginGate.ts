/**
 * The gate before a turn or a CLI start, on a cloud computer (P5 §5.3): a
 * fresh vault, then this provider applied. When the copy here is about to
 * expire, the short wait: pull now; while the owner may be renewing (up to
 * 60 s past expiry), pull every 5 s for up to 20 s; then, the owner being
 * off, take the renewal over. The whole gate stays under 45 s;
 * then `owner_off` with the owner's name, and the turn goes ahead.
 */

import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import type {
  ProviderLoginChatNotice,
  ProviderLoginGateOptions,
  ProviderLoginGateOutcome,
  ProviderLoginProvider,
} from "../../../shared/types/providerLogins";
import { writeAppliedState, type AppliedEntry } from "./providerLoginApply";
import { PROVIDER_LOGIN_CARRY } from "./providerLoginCarry";
import { PROVIDER_LOGIN_VAULT_KIND } from "./providerLoginPayload";
import {
  GATE_LIMIT_MS,
  GATE_MAX_AGE_MS,
  PROVIDER_NAMES,
  SAVED_KEYS,
  SHORT_WAIT_GATE_LIMIT_MS,
  SHORT_WAIT_POLL_LIMIT_MS,
  SHORT_WAIT_POLL_MS,
  SHORT_WAIT_RENEWING_MS,
  TAKEOVER_HOW,
  delay,
  isSavedKeySource,
  type SyncShared,
} from "./providerLoginSyncShared";

export function createGate(s: SyncShared) {
  const { deps, now, ownerOff, ticks, jobs } = s;
  const { metaFor } = s;

  /**
   * The gate before a turn or a CLI start, on a cloud computer: a fresh vault,
   * then this provider applied. When the copy here is about to expire, the
   * short wait (§5.3): pull now; while the owner may be renewing (up to 60 s
   * past expiry), pull every 5 s for up to 20 s; then, the owner being off,
   * take the renewal over (step 3b). The whole gate stays under 45 s; then
   * `owner_off` with the owner's name, and the turn goes ahead.
   */
  async function gate(provider: string, options: ProviderLoginGateOptions = {}): Promise<ProviderLoginGateOutcome> {
    // A new cloud computer's first turn can come while the ADE Cloud answer is still being read.
    if (!ticks.length && s.accessPending) await Promise.race([s.accessPending, new Promise((resolve) => setTimeout(resolve, GATE_LIMIT_MS).unref?.())]);
    if (!ticks.length) return { result: "ok" };
    const providerId = provider.trim().toLowerCase();
    const gated = PROVIDER_LOGIN_CARRY.some((row) => row.provider === providerId && row.carry === "carried")
      || SAVED_KEYS.some((spec) => spec.provider === providerId);
    if (!gated) return { result: "ok" };
    const started = now();
    const limit = <T>(promise: Promise<T> | undefined, budgetMs = GATE_LIMIT_MS): Promise<T | "timeout" | undefined> => {
      if (!promise) return Promise.resolve(undefined);
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), Math.max(0, budgetMs - (now() - started)));
        timer.unref?.();
      });
      return Promise.race([promise.catch(() => undefined), timeout]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    };
    const synced = await limit(deps.vault()?.sync?.({ maxAgeMs: GATE_MAX_AGE_MS }));
    const applied = synced === "timeout" ? "timeout" : await limit(jobs.pass([providerId as ProviderLoginProvider]));
    let outcome: ProviderLoginGateOutcome = synced === "timeout" || applied === "timeout" ? { result: "timeout" } : { result: "ok" };
    // A takeover running here (armed, or a turn's that went on) holds the turn too: its CLI must not renew the same copy.
    const expiring = outcome.result === "ok" ? jobs.expiringCopy(providerId) ?? jobs.takeoverCopy(providerId) : null;
    if (expiring) outcome = await shortWait(providerId as ProviderLoginProvider, expiring, started, limit, options);
    // The lines for the chat of this turn (step 3d); a terminal logs them only.
    const notices: ProviderLoginChatNotice[] = [];
    const first = options.firstCloudChat ? firstCloudChatNotice(providerId) : null;
    if (first) notices.push(first);
    if (outcome.result === "owner_off") {
      const { provider: offProvider, ownerLabel } = outcome;
      notices.push({
        severity: "warning",
        status: "provider_login_owner_off",
        message: `${ownerLabel} didn't renew the ${PROVIDER_NAMES[offProvider] ?? offProvider} sign-in in time.`,
        providerLogin: { kind: "owner_off", provider: offProvider, ownerLabel },
      });
    }
    if (notices.length) outcome = { ...outcome, notices };
    const waitedMs = now() - started;
    if (waitedMs >= 100 || outcome.result !== "ok") {
      deps.logger.info("provider_login.gate", {
        provider: providerId,
        waitedMs,
        result: outcome.result,
        shortWait: Boolean(expiring),
        ...(outcome.result === "ok" && outcome.renewedHere ? { renewedHere: true } : {}),
      });
    }
    return outcome;
  }

  /**
   * The first cloud chat line (step 3d): one time per cloud computer and
   * account (the mark is in the applied state file), on a turn of a provider
   * whose sign-in this computer took from the account.
   */
  function firstCloudChatNotice(provider: string): ProviderLoginChatNotice | null {
    const state = s.appliedCache;
    const vault = deps.vault();
    if (!deps.cloudComputer || !state || state.firstChatAt || !vault) return null;
    const fromAccount = Object.values(state.applied).filter((entry) => !isSavedKeySource(entry.source) && (entry.files.length || entry.pi || entry.qwen));
    if (!fromAccount.some((entry) => entry.provider === provider)) return null;
    const origins = [...new Set(fromAccount.map((entry) => {
      const row = vault.list(ACCOUNT_SCOPE_ALL).find((candidate) => candidate.kind === PROVIDER_LOGIN_VAULT_KIND && candidate.key === entry.source);
      return row && !row.deleted ? metaFor(vault, row)?.origin.label ?? "" : "";
    }).filter(Boolean))];
    if (!origins.length) return null;
    state.firstChatAt = new Date(now()).toISOString();
    try {
      writeAppliedState(deps.adeDir, state);
    } catch (error) {
      deps.logger.warn("provider_login.applied_write_failed", { code: (error as NodeJS.ErrnoException)?.code ?? null });
    }
    const from = origins.length === 1 ? origins[0] : origins.length === 2 ? `${origins[0]} and ${origins[1]}` : `${origins.length} computers`;
    return {
      severity: "info",
      status: "provider_login_first_cloud_chat",
      message: `ADE Cloud uses your sign-ins from ${from}.`,
      providerLogin: { kind: "first_cloud_chat", origins },
    };
  }

  async function shortWait(
    provider: ProviderLoginProvider,
    expiring: { place: string; entry: AppliedEntry },
    started: number,
    limit: <T>(promise: Promise<T> | undefined, budgetMs?: number) => Promise<T | "timeout" | undefined>,
    options: ProviderLoginGateOptions,
  ): Promise<ProviderLoginGateOutcome> {
    const pullAndApply = async (): Promise<boolean> => {
      const pulled = await limit(deps.vault()?.sync?.(), SHORT_WAIT_GATE_LIMIT_MS);
      if (pulled === "timeout") return false;
      if ((await limit(jobs.pass([provider]), SHORT_WAIT_GATE_LIMIT_MS)) === "timeout") return false;
      return !jobs.expiringCopy(provider);
    };
    const key = expiring.entry.source;
    const running = jobs.takeoverRunning(key);
    // A turn moments after one that waited in vain does not wait again: the 30 s tick still pulls.
    const recent = ownerOff.get(expiring.place);
    if (!running && recent && now() - recent.at < GATE_MAX_AGE_MS) return { result: "owner_off", provider, ownerLabel: recent.ownerLabel };
    const ownerLabel = jobs.ownerLabelOf(key);
    // One line per turn, and a true one: this computer's while it renews (or is
    // about to: the owner's time is over), else the owner's (step 3d).
    const claimFrom = TAKEOVER_HOW[provider] ? jobs.claimAt(key) : null;
    const renewingHere = Boolean(running) || (claimFrom != null && claimFrom <= now());
    const name = PROVIDER_NAMES[provider] ?? provider;
    try {
      if (renewingHere) {
        options.onWait?.(`This cloud computer is renewing the ${name} sign-in…`, { kind: "renewing", provider, byLabel: deps.machine()?.label || "this cloud computer" });
      } else {
        options.onWait?.(`Getting a fresh ${name} sign-in from ${ownerLabel}…`);
      }
    } catch {
      // The line is for the person; a caller's failure never holds the turn.
    }
    if (!running) {
      // Step 1: a newer copy may already be in the account.
      if (await pullAndApply()) return { result: "ok" };
      // Step 2: the owner may be renewing now (Grok renews 200 s before expiry), until 60 s past expiry.
      const expiresAt = expiring.entry.expiresAt ?? 0;
      if (now() < expiresAt + SHORT_WAIT_RENEWING_MS) {
        const pollEnd = Math.min(
          now() + SHORT_WAIT_POLL_LIMIT_MS,
          expiresAt + SHORT_WAIT_RENEWING_MS,
          started + SHORT_WAIT_GATE_LIMIT_MS - SHORT_WAIT_POLL_MS,
        );
        while (now() < pollEnd) {
          await delay(Math.min(SHORT_WAIT_POLL_MS, pollEnd - now()));
          if (await pullAndApply()) return { result: "ok" };
        }
      }
    }
    // Steps 3 and 4: the owner did not renew. Take the renewal over (only past
    // expiry + 60 s), within what is left of the 45 s. A takeover that needs
    // longer goes on after the turn, and the next turn gets its copy.
    const took = await limit(jobs.takeover(provider, expiring.place, key), SHORT_WAIT_GATE_LIMIT_MS);
    if (took === "renewed") return { result: "ok", renewedHere: true };
    if (took === "fresh") return { result: "ok" };
    ownerOff.set(expiring.place, { ownerLabel, at: now() });
    // Too early to claim (the owner had until expiry + 60 s): one takeover at that moment, so the retry finds a fresh copy.
    if (took !== "timeout") jobs.armTakeover(provider, expiring.place, key);
    return { result: "owner_off", provider, ownerLabel };
  }

  return { gate };
}
