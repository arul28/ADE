/**
 * The renewal of a renewing sign-in across computers (P5):
 *
 * - The takeover: when the owner computer is off and the copy is
 *   past its expiry + 60 s, the cloud computer whose turn waits claims the
 *   renewal (`decideRotatingRenewal`, 60 s grace), gets the full copy,
 *   renews it and pushes it as the new owner.
 * - The write-back: the origin, when it wakes, writes that newer copy of its
 *   OWN sign-in into its login file, and claims the renewal back by the
 *   normal rule (10 min past expiry).
 * - Renewal ahead on the owner computer (`providerLoginRenew.ts`):
 *   only for a sign-in in use on ADE Cloud, and only when the account has a
 *   cloud computer ("no renewals for nobody").
 */

import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import { cloudChoiceKey } from "../../../shared/providerLoginsCloudSetting";
import type { ProviderLoginProvider } from "../../../shared/types/providerLogins";
import {
  ROTATING_CLAIM_SETTLE_MS,
  decideRotatingRenewal,
  rotatingRenewalRole,
  type RotatingRenewalVerdict,
} from "../account/rotatingCredentialOwner";
import { noteProviderLoginChanged } from "../ai/providerLoginChanged";
import { writeBackSignIn, type AppliedEntry } from "./providerLoginApply";
import {
  PROVIDER_LOGIN_VAULT_KIND,
  originId,
  parseProviderLoginKey,
  readProviderLoginPayload,
  withoutTakenFrom,
  type ProviderLoginMachine,
} from "./providerLoginPayload";
import { createOwnerRenewal, type OwnerRenewTarget } from "./providerLoginRenew";
import type { ProviderLoginStateFile } from "./providerLoginState";
import {
  SHORT_WAIT_LEFT_MS,
  SHORT_WAIT_POLL_MS,
  STABLE_AGE_MS,
  TAKEOVER_GRACE_MS,
  TAKEOVER_HOW,
  delay,
  laterExpiry,
  sameAccount,
  type LoginMemo,
  type ProviderLoginVault,
  type SyncShared,
  type TakeoverResult,
  type VaultRow,
} from "./providerLoginSyncShared";

export function createTakeover(s: SyncShared) {
  const { deps, now, ctx, bundleMemos, settleTimers, ticks, jobs } = s;
  const { cloudSetting, metaFor, signInsFromVault } = s;

  /** One takeover per sign-in at a time; a second turn waits on the same one. */
  const takeovers = new Map<string, Promise<TakeoverResult>>();

  /**
   * The takeover armed by a turn that ended `owner_off` before the claim was
   * allowed (step 3c): ONE unref timer per sign-in, at expiry + 60 s (and the
   * last write + 60 s). Only a turn arms it ("no renewals for nobody"); it
   * goes at stop, when the copy here is no longer the expiring one (a new
   * copy, a sign-out, the sign-in switched off or not in use), and after it
   * runs once.
   */
  const armed = new Map<string, { place: string; provider: ProviderLoginProvider; timer: ReturnType<typeof setTimeout> }>();

  /** The applied copy of this provider that renews elsewhere and has less than 60 s left, if any. */
  function expiringCopy(provider: string): { place: string; entry: AppliedEntry } | null {
    for (const [place, entry] of Object.entries(s.appliedCache?.applied ?? {})) {
      if (entry.provider !== provider || !entry.accessOnly || entry.expiresAt == null) continue;
      if (entry.expiresAt - now() < SHORT_WAIT_LEFT_MS) return { place, entry };
    }
    return null;
  }

  /** The applied copy of this provider whose renewal a takeover here runs now, if any. */
  function takeoverCopy(provider: string): { place: string; entry: AppliedEntry } | null {
    for (const [place, entry] of Object.entries(s.appliedCache?.applied ?? {})) {
      if (entry.provider === provider && takeovers.has(entry.source)) return { place, entry };
    }
    return null;
  }

  function armTakeover(provider: ProviderLoginProvider, place: string, key: string): void {
    if (!deps.cloudComputer || !ticks.length || armed.has(key) || takeovers.has(key) || !TAKEOVER_HOW[provider]) return;
    const claimFrom = claimAt(key);
    if (claimFrom == null) return;
    const at = claimFrom + 1_000;
    // Past that moment the turn already tried the claim; it failed for another reason, and nothing is armed.
    if (at <= now()) return;
    const timer = setTimeout(() => {
      if (armed.get(key)?.timer !== timer) return;
      armed.delete(key);
      if (!ticks.length || !stillExpiring(place, key)) return;
      void takeover(provider, place, key);
    }, at - now());
    timer.unref?.();
    armed.set(key, { place, provider, timer });
    deps.logger.info("provider_login.takeover_armed", { provider, inMs: at - now() });
  }

  /** When a cloud computer may claim the renewal of `key`: past expiry + 60 s and the last write + 60 s. Null when not known. */
  function claimAt(key: string): number | null {
    const vault = deps.vault();
    const row = vault?.list(ACCOUNT_SCOPE_ALL).find((entry) => entry.kind === PROVIDER_LOGIN_VAULT_KIND && entry.key === key);
    const meta = vault && row && !row.deleted ? metaFor(vault, row) : null;
    if (!row || meta?.expiresAt == null) return null;
    const updatedAt = Date.parse(row.updatedAt);
    return Math.max(meta.expiresAt, Number.isFinite(updatedAt) ? updatedAt : 0) + TAKEOVER_GRACE_MS;
  }

  function disarm(key: string, reason: string): void {
    const entry = armed.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    armed.delete(key);
    deps.logger.info("provider_login.takeover_disarmed", { provider: entry.provider, reason });
  }

  /** The copy applied at `place` is still `key`'s access-only copy, with less than 60 s left. */
  function stillExpiring(place: string, key: string): boolean {
    const entry = s.appliedCache?.applied[place];
    return Boolean(entry && entry.source === key && entry.accessOnly && entry.expiresAt != null && entry.expiresAt - now() < SHORT_WAIT_LEFT_MS);
  }

  /** After each apply: an armed takeover whose copy changed (a new copy, a sign-out, switched off) goes. */
  function checkArmed(): void {
    for (const [key, entry] of [...armed]) if (!stillExpiring(entry.place, key)) disarm(key, "copy_changed");
  }

  function takeover(provider: ProviderLoginProvider, place: string, key: string): Promise<TakeoverResult> {
    const running = takeovers.get(key);
    if (running) return running;
    const next = runTakeover(provider, place, key)
      .catch((error): TakeoverResult => {
        deps.logger.warn("provider_login.takeover_failed", { provider, name: error instanceof Error ? error.name : "unknown" });
        return "none";
      })
      .finally(() => {
        if (takeovers.get(key) === next) takeovers.delete(key);
      });
    takeovers.set(key, next);
    return next;
  }

  /**
   * Claim the renewal of one sign-in with the 60 s grace, wait the 30 s claim
   * settle, check again, then get the full copy here (apply sees the new
   * owner) and renew it: ADE's renew call for Codex and Grok (one CLI
   * process), the CLI itself on start for Kimi and Pi. Capture then pushes
   * the renewed copy into the same key, with this computer as the owner.
   * "No renewals for nobody": only a sign-in that is on and in use for ADE
   * Cloud, and only when a turn here waits for it.
   */
  async function runTakeover(provider: ProviderLoginProvider, place: string, key: string): Promise<TakeoverResult> {
    const started = now();
    const vault = deps.vault();
    const machine = deps.machine();
    const rotating = deps.rotatingVault?.() ?? null;
    const how = TAKEOVER_HOW[provider];
    const finish = (result: TakeoverResult, step: string): TakeoverResult => {
      deps.logger.info("provider_login.takeover", { provider, step, result, ms: now() - started });
      return result;
    };
    if (!vault || !machine || !rotating || !how) return finish("none", "unsupported");
    if (how === "renew" && !deps.renewer?.aheadMs[provider]) return finish("none", "unsupported");
    const signIn = signInsFromVault(vault, originId(machine.machineKey), cloudSetting(), machine.deviceId).find((entry) => entry.key === key);
    if (!signIn || signIn.class !== "renewing" || !signIn.onForCloud || !signIn.inUseOnCloud) return finish("none", "not_in_use");
    const ref = { scope: ACCOUNT_SCOPE_ALL, kind: PROVIDER_LOGIN_VAULT_KIND, key };
    const decideOnce = (): Promise<RotatingRenewalVerdict> | null => {
      const row = vault.list(ACCOUNT_SCOPE_ALL).find((entry) => entry.kind === PROVIDER_LOGIN_VAULT_KIND && entry.key === key);
      const meta = row && !row.deleted ? metaFor(vault, row) : null;
      const value = row && !row.deleted ? vault.get(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND, key) : null;
      if (!row || !meta || !value || meta.expiresAt == null) return null;
      // Not past expiry + 60 s (and the last write + 60 s): the owner may still send it; nothing to claim.
      const role = rotatingRenewalRole({
        deviceId: machine.deviceId,
        owner: row.refreshOwner,
        expiresAtMs: meta.expiresAt,
        updatedAtMs: Date.parse(row.updatedAt),
        nowMs: now(),
        graceMs: TAKEOVER_GRACE_MS,
      });
      if (role === "read") return Promise.resolve({ renew: false, reason: "other_owner" });
      return decideRotatingRenewal({
        vault: rotating,
        deviceId: machine.deviceId,
        ref,
        expiresAtMs: meta.expiresAt,
        currentValue: value,
        nowMs: now(),
        graceMs: TAKEOVER_GRACE_MS,
        logger: deps.logger,
        logContext: { provider },
      });
    };
    let verdict = await decideOnce();
    if (!verdict) return finish("none", "no_copy");
    const claimed = !verdict.renew && (verdict.reason === "claimed" || verdict.reason === "claim_settling");
    // A claim stands only after the settle: a second claimant's later write wins, and this one then reads instead.
    for (let check = 0; check < 3 && !verdict.renew && (verdict.reason === "claimed" || verdict.reason === "claim_settling"); check += 1) {
      if (check === 0) {
        claimedAt.set(key, now());
        deps.logger.info("provider_login.takeover_claimed", { provider, reason: verdict.reason });
      }
      await delay(ROTATING_CLAIM_SETTLE_MS + 250);
      verdict = (await decideOnce()) ?? { renew: false, reason: "claim_failed" };
    }
    if (!verdict.renew) {
      // Another computer renews it (another claimant stood, or the owner sent a
      // copy): take what the account has. After a claim that lost, the claimant
      // that stood renews in the next seconds, so pull a few times (the gate's
      // limit still ends the turn's wait).
      for (let pull = 0; ; pull += 1) {
        await vault.sync?.().catch(() => undefined);
        await jobs.pass([provider]);
        if (!expiringCopy(provider)) return finish("fresh", verdict.reason);
        if (!claimed || pull >= 3) return finish("none", verdict.reason);
        await delay(SHORT_WAIT_POLL_MS);
      }
    }
    // This computer owns the renewal now: the full copy here.
    await jobs.pass([provider]);
    const entry = s.appliedCache?.applied[place];
    if (!entry?.owned || entry.source !== key) return finish("none", "no_full_copy");
    if (how === "cli") return finish("renewed", "full_copy");
    const answer = await deps.renewer!.renew(provider).catch(() => false);
    if (!answer) return finish("none", answer === null ? "renew_busy" : "renew_failed");
    // The renewed file is read once it is stable; capture pushes it into the same key, this computer the owner.
    await delay(STABLE_AGE_MS + 250);
    await jobs.pass([provider]);
    return finish("renewed", "renewed");
  }

  /**
   * Write the newer copy of this computer's own sign-in into its login file,
   * after a cloud computer renewed it. Every limit, again, on the whole item:
   * this computer made it (the same key and the same device), it is a
   * renewing sign-in, another computer owns it now and renewed it, the copy
   * here is of the same sign-in (its family is the item's, or one the item
   * lists as earlier), the account is the same, the item's expiry is later,
   * and the file here is still the copy capture last put in the account.
   * `writeBackSignIn` checks the file again just before the rename.
   */
  async function writeBack(
    candidate: { provider: ProviderLoginProvider; memo: LoginMemo; bundleId: string },
    vault: ProviderLoginVault,
    rows: Map<string, VaultRow>,
    state: ProviderLoginStateFile,
    machine: ProviderLoginMachine,
  ): Promise<boolean> {
    const { provider, memo } = candidate;
    const row = rows.get(memo.key);
    const payload = row && !row.deleted ? readProviderLoginPayload(vault.get(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND, memo.key)) : null;
    const parsedKey = parseProviderLoginKey(memo.key);
    const refused = (reason: string): false => {
      deps.logger.info("provider_login.write_back_skipped", { provider, slot: memo.slot, reason });
      return false;
    };
    if (deps.cloudComputer || !row || !payload || !parsedKey) return refused("no_item");
    if (parsedKey.origin12 !== originId(machine.machineKey) || payload.origin.deviceId !== machine.deviceId) return refused("not_origin");
    if (payload.provider !== provider || payload.slot !== memo.slot || payload.class !== "renewing" || memo.class !== "renewing") return refused("not_renewing");
    if (provider === "pi" && memo.slot === "anthropic") return refused("not_carried");
    if (!row.refreshOwner || row.refreshOwner === machine.deviceId) return refused("own_owner");
    if (!payload.renewedBy || payload.renewedAt == null || payload.renewedBy.machineKey === machine.machineKey) return refused("not_renewed_elsewhere");
    if (!jobs.ofSameSignIn(payload, memo, state)) return refused("other_family");
    if (!sameAccount(payload.account, memo.account)) return refused("other_account");
    if (!laterExpiry(payload.expiresAt, memo.expiresAt)) return refused("not_newer");
    if (state.pushed[memo.key]?.pushedHash !== memo.contentHash) return refused("local_changed");
    const write = () => writeBackSignIn({ provider, slot: memo.slot, files: payload.files, parts: payload.parts, expectHash: memo.contentHash }, ctx);
    // Under ADE's machine lock, so ADE's own keeper never renews this file at the same moment.
    const result = deps.renewer?.withLock ? await deps.renewer.withLock(write) : await write();
    if (!result) return refused("lock_busy");
    if (!result.ok) return refused(result.reason === "write_failed" && result.code === "ELOCKED" ? "lock_busy" : result.reason);
    const readBack = result.loginHashes[0] ?? payload.contentHash;
    const renewedBy = payload.renewedBy.label || "another computer";
    state.pushed[memo.key] = { pushedHash: readBack, familyHash: payload.familyHash, pushedAt: now(), absentSince: null, absentPasses: 0 };
    state.writtenBack = {
      ...(state.writtenBack ?? {}),
      [memo.key]: { contentHash: readBack, familyHash: payload.familyHash, at: now(), renewedBy, accountHash: payload.contentHash },
    };
    // The marks moved: the next pass reads the file again and finds this copy.
    bundleMemos.delete(candidate.bundleId);
    deps.logger.info("provider_login.written_back", { provider, slot: memo.slot, renewedByCloud: payload.renewedBy.cloud === true });
    noteProviderLoginChanged(provider);
    return true;
  }

  /** The name of the computer that renews this sign-in: its origin unless another computer renewed it last. */
  function ownerLabelOf(key: string): string {
    const vault = deps.vault();
    const row = vault?.list(ACCOUNT_SCOPE_ALL).find((entry) => entry.kind === PROVIDER_LOGIN_VAULT_KIND && entry.key === key);
    const meta = vault && row ? metaFor(vault, row) : null;
    if (!meta) return "the computer that made this sign-in";
    if (row?.refreshOwner && row.refreshOwner === meta.origin.deviceId) return meta.origin.label || "the computer that made this sign-in";
    return meta.renewedBy?.label || meta.origin.label || "the computer that made this sign-in";
  }

  // ── Renewal ahead on the owner computer (step 3a) ────────────────────
  // On a cloud computer only for a sign-in it took the renewal over for
  // (step 3b): it owns it then and holds the full copy. It stops when the
  // origin claims the renewal back.

  const ownerRenewal = deps.renewer
    ? createOwnerRenewal({
      renewer: deps.renewer,
      now,
      logger: deps.logger,
      onRenewed: (target, outcome) => {
        // The keeper renewing it (busy) changes the file too. Either way the
        // file is read once it is stable, and the pass pushes it.
        if (outcome === "failed" || !ticks.length) return;
        const id = `renew:${target.provider}`;
        clearTimeout(settleTimers.get(id));
        const timer = setTimeout(() => {
          settleTimers.delete(id);
          void jobs.pass([target.provider]);
        }, STABLE_AGE_MS + 250);
        timer.unref?.();
        settleTimers.set(id, timer);
      },
    })
    : null;

  /** Bumped by each plan, so an answer that comes late never undoes a newer plan. */
  let planGeneration = 0;

  /** Claims this computer made (a takeover, or a claim back), by key: no renewal until the 30 s settle passes. */
  const claimedAt = new Map<string, number>();
  const claimBacks = new Set<string>();
  /** The last failure code of each key's claim-back: a repeat of the same cause logs at info. */
  const claimBackFailures = new Map<string, string>();

  /**
   * The sign-ins this computer renews ahead, and only when all hold: capture
   * is on (this runs at the end of a capture pass), this computer is the
   * owner, the sign-in is on and in use for ADE Cloud, ADE can make its CLI
   * renew, and the account has a cloud computer. The owner is the origin, or
   * a cloud computer that took the renewal over and holds the full copy
   * (step 3b). On the origin, a sign-in another computer owns is claimed back
   * by the normal rule (10 min past expiry) when the file here holds the
   * account's newest copy.
   */
  async function planRenewals(vault: ProviderLoginVault, machine: ProviderLoginMachine, origin12: string, state: ProviderLoginStateFile): Promise<void> {
    const rows = new Map<string, VaultRow>();
    for (const row of vault.list(ACCOUNT_SCOPE_ALL)) {
      if (row.kind === PROVIDER_LOGIN_VAULT_KIND && !row.deleted) rows.set(row.key, row);
    }
    // Owner only once the account service took this computer's write: a
    // queued write can still lose to the owner's newer one (the stale rule).
    const pending = new Set(vault.pendingKeys?.(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND) ?? []);
    const targets: OwnerRenewTarget[] = [];
    for (const signIn of signInsFromVault(vault, origin12, cloudSetting(), machine.deviceId)) {
      if (signIn.class !== "renewing" || !signIn.onForCloud || !signIn.inUseOnCloud) continue;
      const row = rows.get(signIn.key);
      if (!row || pending.has(signIn.key)) continue;
      if (deps.cloudComputer) {
        // A cloud computer renews only a sign-in it took over, while it holds the full copy.
        const entry = s.appliedCache?.applied[cloudChoiceKey(signIn.provider, signIn.slot)];
        if (signIn.origin.thisComputer || !entry?.owned || entry.source !== signIn.key) continue;
      } else if (!signIn.origin.thisComputer) {
        continue;
      }
      if (row.refreshOwner !== machine.deviceId) {
        if (!deps.cloudComputer) maybeClaimBack(row, vault, machine, state);
        continue;
      }
      // A takeover renews it now; the planner takes over from the copy it pushes.
      if (takeovers.has(signIn.key)) continue;
      const claimed = claimedAt.get(signIn.key);
      if (claimed != null && now() - claimed < ROTATING_CLAIM_SETTLE_MS) continue;
      if (!deps.renewer?.aheadMs[signIn.provider]) continue;
      const expiresAt = signIn.expiresAt ? Date.parse(signIn.expiresAt) : Number.NaN;
      if (Number.isFinite(expiresAt)) targets.push({ key: signIn.key, provider: signIn.provider, expiresAt });
    }
    if (!ownerRenewal) return;
    const generation = ++planGeneration;
    if (!targets.length) {
      ownerRenewal.plan([]);
      return;
    }
    // Asked only now, when a sign-in is otherwise due. The pass never waits on
    // it: a read can take seconds, and a later pass's plan wins. A cloud
    // computer is one, so it does not ask.
    const answer = deps.cloudComputer
      ? Promise.resolve(true)
      : deps.cloudComputerExists ? deps.cloudComputerExists().catch(() => null) : Promise.resolve(null);
    void answer.then((exists) => {
      if (generation === planGeneration) ownerRenewal.plan(exists === true ? targets : []);
    });
  }

  /**
   * The origin claims the renewal of its own sign-in back (§5.2): only by the
   * normal rule (the owner sent nothing for 10 min past expiry), only when the
   * file here holds the account's newest copy (captured, or written back), and
   * never in the pass's path (the claim reads the vault and waits for it).
   */
  function maybeClaimBack(row: VaultRow, vault: ProviderLoginVault, machine: ProviderLoginMachine, state: ProviderLoginStateFile): void {
    const key = row.key;
    if (!row.refreshOwner || claimBacks.has(key)) return;
    const meta = metaFor(vault, row);
    if (!meta || meta.origin.deviceId !== machine.deviceId || meta.expiresAt == null) return;
    const back = state.writtenBack?.[key];
    const inStep = back ? back.familyHash === meta.familyHash : state.pushed[key]?.pushedHash === meta.contentHash;
    if (!inStep) return;
    const role = rotatingRenewalRole({
      deviceId: machine.deviceId,
      owner: row.refreshOwner,
      expiresAtMs: meta.expiresAt,
      updatedAtMs: Date.parse(row.updatedAt),
      nowMs: now(),
    });
    if (role !== "claim") return;
    const rotating = deps.rotatingVault?.() ?? null;
    const value = vault.get(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND, key);
    if (!rotating || !value) return;
    claimBacks.add(key);
    const provider = meta.provider;
    // The claim drops `takenFrom`: the takeover it marked ends here (step 3c).
    const claimValue = withoutTakenFrom(value);
    void decideRotatingRenewal({
      vault: rotating,
      deviceId: machine.deviceId,
      ref: { scope: ACCOUNT_SCOPE_ALL, kind: PROVIDER_LOGIN_VAULT_KIND, key },
      expiresAtMs: meta.expiresAt,
      currentValue: value,
      ...(claimValue ? { claimValue } : {}),
      nowMs: now(),
      logger: deps.logger,
      logContext: { provider },
    })
      .then((verdict) => {
        const claimed = !verdict.renew && verdict.reason === "claimed";
        if (claimed) claimedAt.set(key, now());
        claimBackFailures.delete(key);
        deps.logger.info("provider_login.claim_back", { provider, result: verdict.renew ? "owner" : verdict.reason });
      })
      .catch((error: unknown) => {
        // The next pass tries the claim-back again; the same cause warns once.
        const code = (error as NodeJS.ErrnoException)?.code ?? "unknown";
        const repeat = claimBackFailures.get(key) === code;
        claimBackFailures.set(key, code);
        deps.logger[repeat ? "info" : "warn"]("provider_login.claim_back_failed", { provider, code });
      })
      .finally(() => claimBacks.delete(key));
  }

  function cancelRenewalPlan(): void {
    planGeneration += 1;
    ownerRenewal?.plan([]);
  }

  function stopRenewals(): void {
    planGeneration += 1;
    ownerRenewal?.stop();
  }

  function takeoverRunning(key: string): boolean {
    return takeovers.has(key);
  }

  function disarmAll(): void {
    for (const key of [...armed.keys()]) disarm(key, "stopped");
  }

  return { checkArmed, writeBack, planRenewals, cancelRenewalPlan, stopRenewals, disarmAll, expiringCopy, takeoverCopy, takeover, takeoverRunning, armTakeover, claimAt, ownerLabelOf };
}
