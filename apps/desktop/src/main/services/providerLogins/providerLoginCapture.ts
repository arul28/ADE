/**
 * Capture (P5): on each vault tick (the account vault's own 30 s timer, so no
 * new timer) and a few seconds after a sign-in on this computer, look at each
 * carried provider's login files with `stat` only. A file is read only when
 * its (mtime, size, inode) moved, and only when the read is stable: the file
 * is at least 2 s old, and a `stat` before and after the read agree. A login
 * that changed goes into the account as one vault item per sign-in
 * (`providerLoginPayload.ts`).
 *
 * Capture is off unless all of these hold (`captureOffReason`): a full brain
 * (not embedded), a release build, account sync on, signed in to an ADE
 * account that has ADE Cloud, ADE Cloud's sign-ins switched on, and a vault
 * that synced. An account without ADE Cloud never has a login uploaded.
 *
 * Each pass then applies on a cloud computer, writes back on the origin, and
 * plans the renewals ahead (the other jobs, through `jobs`).
 */

import fs from "node:fs";

import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import type { ProviderLoginLocalState, ProviderLoginProvider } from "../../../shared/types/providerLogins";
import { GH_BUNDLE_ID, GH_READ_PART, GH_TOKEN_PART, PROVIDER_LOGIN_CARRY, type CarryBundle, type CarryRow, type ParsedLogin } from "./providerLoginCarry";
import { ghReadEnv, isClassicGitHubToken, readGhHostsGithubCom, runGhAuthToken, type GhTokenRead } from "./providerLoginGhCli";
import { notifyProviderLoginPass, notifyProviderLoginsChanged } from "./providerLoginHooks";
import {
  PROVIDER_LOGIN_MAX_CHARS,
  PROVIDER_LOGIN_VAULT_KIND,
  buildProviderLoginPayload,
  isNewerProviderLoginPayload,
  loginContentHash,
  originId,
  parseProviderLoginKey,
  providerLoginKey,
  readProviderLoginMeta,
  shortHash,
  type ProviderLoginMachine,
} from "./providerLoginPayload";
import { sameMarks, writeProviderLoginState, type FileMark, type GhCliChoice, type ProviderLoginStateFile } from "./providerLoginState";
import {
  ABSENT_REMOVE_MS,
  GH_READ_MS,
  GH_READ_ON_CLICK_MS,
  STABLE_AGE_MS,
  laterExpiry,
  type BundleObservation,
  type LoginMemo,
  type PushDecision,
  type SyncShared,
  type ProviderLoginVault,
  type VaultRow,
} from "./providerLoginSyncShared";

export function createCapture(s: SyncShared) {
  const { deps, now, env, platform, ctx, bundleMemos, localStates, jobs } = s;
  const { captureOffReason, setLocal, loadState, metaFor } = s;

  const ghRunner = deps.ghTokenRunner ?? runGhAuthToken;
  let rerun: { providers: Set<ProviderLoginProvider> | null } | null = null;

  /** A file's mark; "unreadable" when the stat itself failed for another reason than "not there" (a lock, a permission). */
  async function statFile(abs: string, rel: string): Promise<FileMark | "unreadable"> {
    try {
      const stat = await fs.promises.stat(abs);
      if (!stat.isFile()) return { rel, missing: true };
      return { rel, mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      return code === "ENOENT" || code === "ENOTDIR" ? { rel, missing: true } : "unreadable";
    }
  }

  /** Every file's mark, or "unreadable" when one stat failed: never counted as a missing file (signed out). */
  async function statBundle(bundle: CarryBundle): Promise<FileMark[] | "unreadable"> {
    const marks = await Promise.all(bundle.files.map((spec) => statFile(spec.abs, spec.rel)));
    return marks.some((mark) => mark === "unreadable") ? "unreadable" : (marks as FileMark[]);
  }

  /**
   * Read every present file once, then check that nothing moved under the read.
   * null: not stable yet (or a file went away under the read). "unreadable": a
   * present file could not be read (a permission change, a lock).
   */
  async function stableRead(bundle: CarryBundle, marks: FileMark[]): Promise<Map<string, Buffer> | "unreadable" | null> {
    const newest = Math.max(...marks.map((mark) => ("missing" in mark ? 0 : mark.mtimeMs)));
    if (now() - newest < STABLE_AGE_MS) return null;
    const contents = new Map<string, Buffer>();
    for (const [index, spec] of bundle.files.entries()) {
      if ("missing" in marks[index]!) continue;
      try {
        contents.set(spec.rel, await fs.promises.readFile(spec.abs));
      } catch (error) {
        return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? null : "unreadable";
      }
    }
    const after = await statBundle(bundle);
    if (after === "unreadable") return "unreadable";
    return sameMarks(marks, after) ? contents : null;
  }

  async function observeBundle(
    row: CarryRow,
    bundle: CarryBundle,
    state: ProviderLoginStateFile,
    origin12: string,
    forceRead: boolean,
  ): Promise<BundleObservation> {
    const marks = await statBundle(bundle);
    // The old marks stay, so each pass tries again; the absence rule does not count it.
    if (marks === "unreadable") return { kind: "unreadable" };
    if (bundle.files.some((spec, index) => spec.required && "missing" in marks[index]!)) {
      state.bundles[bundle.id] = { files: marks };
      bundleMemos.delete(bundle.id);
      return { kind: "absent" };
    }
    const memo = bundleMemos.get(bundle.id);
    if (!forceRead && memo && sameMarks(state.bundles[bundle.id]?.files, marks)) {
      // An unreadable file stays unreadable until it changes: never "parsed, no login" (that would count as signed out).
      if (memo.unreadable) return { kind: "unreadable" };
      return { kind: "parsed", logins: memo.logins.map((login) => ({ memo: login, full: null })), skipped: memo.skipped };
    }
    if (bundle.id === GH_BUNDLE_ID && !forceRead && !memo) {
      // After a restart of the brain: the gh login read before, unchanged since, and in the account. No gh process.
      const restored = restoreGhMemo(bundle, marks, state, origin12);
      if (restored) return restored;
    }
    const contents = await stableRead(bundle, marks);
    // Not stable yet: keep the old marks, so the next pass reads it again.
    if (!contents) return { kind: "settling" };
    // Not readable now: the old marks stay too, so each pass tries again.
    if (contents === "unreadable") return { kind: "unreadable" };
    if (bundle.id === GH_BUNDLE_ID) await ghTokenStep(contents, JSON.stringify(marks), state);
    const parsed = row.parse!(bundle, contents, ctx);
    state.bundles[bundle.id] = { files: marks };
    if ("unreadable" in parsed) {
      bundleMemos.set(bundle.id, { logins: [], skipped: [{ slot: bundle.id, state: "unreadable" }], unreadable: true });
      return { kind: "unreadable" };
    }
    const logins = parsed.logins.map((login) => ({
      memo: {
        slot: login.slot,
        key: providerLoginKey(row.provider, origin12, login.slot),
        contentHash: loginContentHash(login),
        familyHash: shortHash(login.familySecret),
        class: login.class,
        expiresAt: login.expiresAt,
        account: login.account,
      },
      full: login,
    }));
    bundleMemos.set(bundle.id, { logins: logins.map((login) => login.memo), skipped: parsed.skipped });
    return { kind: "parsed", logins, skipped: parsed.skipped };
  }

  /**
   * Copilot's GitHub CLI login (G1): give the parse the token. The file's own
   * token (gh's plain-text storage) needs no process. Otherwise one `gh auth
   * token` runs, only after the person turned it on, and only when hosts.yml
   * changed since the last read or the person pressed again. A read that gave
   * no token waits for the file to change (no retry on the tick).
   */
  async function ghTokenStep(contents: Map<string, Buffer>, mark: string, state: ProviderLoginStateFile): Promise<void> {
    const choice = state.ghCli;
    if (!choice) return;
    const host = readGhHostsGithubCom(contents.get("hosts.yml")?.toString("utf8") ?? null);
    const record = (result: NonNullable<GhCliChoice["read"]>["result"]) => {
      choice.read = { mark, at: now(), result, user: host.user };
    };
    if (!host.user && !host.token) {
      if (choice.read?.mark !== mark) record("no_token");
      return;
    }
    if (host.token) {
      if (choice.read?.mark !== mark) record(isClassicGitHubToken(host.token) ? "classic_token" : "ok");
      return;
    }
    let read: GhTokenRead | null = null;
    if (!s.ghForce && s.ghMemo?.mark === mark) {
      read = s.ghMemo.read;
    } else if (!s.ghForce && choice.read?.mark === mark && choice.read.result !== "ok") {
      // The last read gave no token and the file has not changed: wait for a change or the person's click.
      contents.set(GH_READ_PART, Buffer.from(choice.read.result));
      return;
    }
    if (!read) {
      const timeoutMs = s.ghForce ? GH_READ_ON_CLICK_MS : GH_READ_MS;
      s.ghForce = false;
      read = await ghRunner({ env: ghReadEnv(env, platform), timeoutMs }).catch((): GhTokenRead => ({ ok: false, reason: "failed" }));
      s.ghMemo = { mark, read };
      record(read.ok ? (isClassicGitHubToken(read.token) ? "classic_token" : "ok") : read.reason);
      deps.logger.info("provider_login.gh_read", { result: choice.read!.result });
    }
    if (read.ok && !isClassicGitHubToken(read.token)) contents.set(GH_TOKEN_PART, Buffer.from(read.token));
    else contents.set(GH_READ_PART, Buffer.from(read.ok ? "classic_token" : read.reason));
  }

  /** The gh login's memo from the marks file, when the last read was a token, hosts.yml is unchanged, and this computer pushed it. */
  function restoreGhMemo(bundle: CarryBundle, marks: FileMark[], state: ProviderLoginStateFile, origin12: string): BundleObservation | null {
    const read = state.ghCli?.read;
    if (!read || read.result !== "ok" || read.mark !== JSON.stringify(marks)) return null;
    const key = providerLoginKey("copilot", origin12, "gh");
    const pushed = state.pushed[key];
    if (!pushed) return null;
    const login: LoginMemo = {
      slot: "gh",
      key,
      contentHash: pushed.pushedHash,
      familyHash: pushed.familyHash,
      class: "fixed",
      expiresAt: null,
      account: read.user ? { email: null, id: read.user } : null,
    };
    state.bundles[bundle.id] = { files: marks };
    bundleMemos.set(bundle.id, { logins: [login], skipped: [] });
    return { kind: "parsed", logins: [{ memo: login, full: null }], skipped: [] };
  }

  /**
   * The copy here is of the sign-in this item holds: its family, an earlier
   * one the lineage lists, the family a takeover started from (`takenFrom`,
   * never evicted: step 3c), or the very copy a write-back put here.
   */
  function ofSameSignIn(
    meta: { familyHash: string; lineage: string[]; takenFrom: string | null },
    login: LoginMemo,
    state: ProviderLoginStateFile,
  ): boolean {
    if (meta.familyHash === login.familyHash || meta.lineage.includes(login.familyHash)) return true;
    if (meta.takenFrom === login.familyHash) return true;
    return state.writtenBack?.[login.key]?.contentHash === login.contentHash;
  }

  function decide(
    login: LoginMemo,
    vault: ProviderLoginVault,
    rows: Map<string, VaultRow>,
    state: ProviderLoginStateFile,
    machine: ProviderLoginMachine,
  ): PushDecision {
    const row = rows.get(login.key);
    const pushed = state.pushed[login.key];
    if (row?.deleted) {
      // The person removed this sign-in; the same family stays removed. A new sign-in adds it back.
      if (pushed && pushed.familyHash === login.familyHash) return { push: false, state: "removed_from_account" };
      return { push: true };
    }
    if (!row) return { push: true };
    // A copy this computer cannot decrypt, or one a newer ADE wrote, is unknown, not missing:
    // capture never writes over it. A copy it decrypts but cannot parse is damaged: replace it.
    if (!row.readable) return { push: false, state: "account_unreadable" };
    const meta = metaFor(vault, row);
    if (!meta) {
      return isNewerProviderLoginPayload(vault.get(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND, row.key))
        ? { push: false, state: "account_unreadable" }
        : { push: true };
    }
    // The copy the write-back wrote here: never pushed back (no echo). Once the file changes, the normal rules apply.
    const back = state.writtenBack?.[login.key];
    if (back) {
      if (back.contentHash === login.contentHash) {
        // The cloud computer renewed it again since: write that copy back too (writeBack checks every limit).
        const again = meta.contentHash !== (back.accountHash ?? back.contentHash)
          && meta.origin.deviceId === machine.deviceId
          && Boolean(row.refreshOwner) && row.refreshOwner !== machine.deviceId;
        return again ? { push: false, state: "written_back", writeBack: true } : { push: false, state: "written_back" };
      }
      delete state.writtenBack![login.key];
    }
    // What this computer last pushed, and the account still holds it. (A write that lost to a newer one is not "captured".)
    if (pushed?.pushedHash === login.contentHash && meta.contentHash === login.contentHash) return { push: false, state: "captured" };
    if (meta.contentHash === login.contentHash) {
      state.pushed[login.key] = { pushedHash: login.contentHash, familyHash: login.familyHash, pushedAt: now(), absentSince: null, absentPasses: 0 };
      return { push: false, state: "captured" };
    }
    if (login.class === "renewing" && row.refreshOwner && row.refreshOwner !== machine.deviceId) {
      // Another computer renews this sign-in now. A copy of its family (the
      // same family, or an earlier one of the same sign-in) never goes over
      // that computer's copy, with two exceptions on the origin after a
      // cloud computer took the renewal over (design §3.4, step 3b).
      const ofFamily = ofSameSignIn(meta, login, state);
      // The local file is the very copy this computer last put in the account: nothing new here.
      const unchanged = pushed?.pushedHash === login.contentHash;
      const originAfterTakeover = !deps.cloudComputer
        && meta.origin.deviceId === machine.deviceId
        && row.refreshOwner !== meta.origin.deviceId;
      if (ofFamily) {
        // §3.4 row 3: the CLI here renewed by itself to a later expiry. It holds the newest family: push and own it again.
        if (originAfterTakeover && !unchanged && laterExpiry(login.expiresAt, meta.expiresAt)) return { push: true };
        // The write-back: the account holds a newer copy of this very sign-in, and the file here is unchanged since capture.
        if (originAfterTakeover && unchanged) return { push: false, state: "other_owner_newer", writeBack: true };
        return { push: false, state: "other_owner_newer" };
      }
      // An old copy this computer pushed before, whose family the account no longer lists: never pushed again.
      if (unchanged) return { push: false, state: "other_owner_newer" };
    }
    // A new family here is a new sign-in (§3.4 row 1): it goes up, and names this computer the owner.
    return { push: true };
  }

  function push(
    provider: ProviderLoginProvider,
    login: ParsedLogin,
    memo: LoginMemo,
    vault: ProviderLoginVault,
    rows: Map<string, VaultRow>,
    state: ProviderLoginStateFile,
    machine: ProviderLoginMachine,
    takeover: { place: string } | null = null,
  ): ProviderLoginLocalState {
    const row = rows.get(memo.key);
    const previous = row && !row.deleted
      ? readProviderLoginMeta(vault.get(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND, memo.key))
      : null;
    const payload = buildProviderLoginPayload({
      provider,
      login,
      machine,
      previous,
      now: now(),
      // A cloud computer that took the renewal over pushes into the origin's key: the origin stays, and the lineage grows.
      ...(takeover ? { renewal: { cloud: deps.cloudComputer } } : {}),
    });
    const value = JSON.stringify(payload);
    if (value.length > PROVIDER_LOGIN_MAX_CHARS) {
      deps.logger.warn("provider_login.capture_too_large", { provider, slot: memo.slot, chars: value.length });
      return "too_large";
    }
    // Every write names the owner: the store would clear it otherwise (P4 §4).
    // A cloud computer names itself only for a sign-in it took the renewal
    // over for (step 3b); a sign-in made on it renews nowhere (no owner).
    const owner = login.class === "renewing" && (!deps.cloudComputer || takeover) ? machine.deviceId : null;
    const written = vault.set(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND, memo.key, value, { refreshOwner: owner });
    if (!written) {
      deps.logger.warn("provider_login.capture_write_refused", { provider, slot: memo.slot });
      return "not_checked";
    }
    state.pushed[memo.key] = { pushedHash: memo.contentHash, familyHash: memo.familyHash, pushedAt: now(), absentSince: null, absentPasses: 0 };
    if (state.signedOut?.[memo.key]) delete state.signedOut[memo.key];
    deps.logger.info("provider_login.captured", {
      provider,
      slot: memo.slot,
      class: login.class,
      chars: value.length,
      ...(takeover ? { takeover: true } : {}),
    });
    if (takeover) jobs.noteOwnedCopy(takeover.place, memo, payload.expiresAt);
    return "captured";
  }

  async function runPass(providers: Set<ProviderLoginProvider> | null): Promise<void> {
    const off = await captureOffReason();
    s.lastPassAt = now();
    // Capture off for any reason: no renewal ahead, and no timer for one.
    if (off) jobs.cancelRenewalPlan();
    // The account lost ADE Cloud or signed out between two answers: stop riding the ticks.
    if (off === "no_ade_cloud" || off === "signed_out") jobs.leaveTicks();
    if (off === "all_off") {
      // Nothing is captured. On a cloud computer the switched-off sign-ins
      // leave and its saved keys stay managed (the switch covers sign-ins only).
      const vault = deps.vault();
      const machine = deps.machine();
      const accountUserId = deps.accountUserId();
      if (vault && machine && accountUserId) {
        if (deps.cloudComputer) {
          await jobs.runApply(vault, accountUserId, originId(machine.machineKey), machine.deviceId, providers, false);
          jobs.checkArmed();
        }
        notifyProviderLoginPass({ accountUserId, cloudComputer: deps.cloudComputer, providers: providers ? [...providers] : null, captureOff: "all_off" });
      }
      return;
    }
    if (off) return;
    const vault = deps.vault()!;
    const machine = deps.machine();
    const accountUserId = deps.accountUserId();
    if (!machine || !accountUserId) return;
    const origin12 = originId(machine.machineKey);
    // On a cloud computer, what apply wrote here is known before capture looks.
    if (deps.cloudComputer) await jobs.loadApplied(accountUserId);
    const state = loadState(accountUserId);
    const before = JSON.stringify(state);
    let accountChanged = false;
    const rows = new Map<string, VaultRow>();
    for (const row of vault.list(ACCOUNT_SCOPE_ALL)) {
      if (row.kind === PROVIDER_LOGIN_VAULT_KIND) rows.set(row.key, row);
    }
    const parked = new Set(vault.parkedKeys?.(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND) ?? []);
    const seenKeys = new Set<string>();
    const uncertain = new Set<ProviderLoginProvider>();
    const writeBacks: Array<{ provider: ProviderLoginProvider; memo: LoginMemo; slotId: string; bundleId: string }> = [];
    const removedThisPass = new Set<string>();

    for (const row of PROVIDER_LOGIN_CARRY) {
      if (row.carry !== "carried" || !row.locate || !row.parse) continue;
      if (providers && !providers.has(row.provider)) continue;
      localStates.set(row.provider, new Map());
      if (row.provider === "copilot" && (deps.cloudComputer || !state.ghCli)) {
        // The GitHub CLI login is read only after the person turns it on here
        // (G1); never on a cloud computer. Not looked at, so not "signed in":
        // a copy pushed before the person turned it off leaves by the absence rule.
        if (deps.cloudComputer) uncertain.add(row.provider);
        continue;
      }
      const bundles = row.locate(ctx);
      // Not looked at here (Antigravity on a Mac, read only on the person's
      // Allow): its sign-in is not "gone from this computer".
      if (!bundles.length) uncertain.add(row.provider);
      for (const bundle of bundles) {
        let observation = await observeBundle(row, bundle, state, origin12, false);
        if (observation.kind === "absent") {
          setLocal(row.provider, bundle.id, "not_signed_in", null);
          continue;
        }
        if (observation.kind === "settling" && deps.cloudComputer && jobs.isAppliedBundle(row.provider, bundle)) {
          // Apply wrote these files a moment ago and nobody changed them since.
          setLocal(row.provider, bundle.id, "from_account", null);
          uncertain.add(row.provider);
          continue;
        }
        if (observation.kind === "settling" || observation.kind === "unreadable") {
          uncertain.add(row.provider);
          setLocal(row.provider, bundle.id, observation.kind, null);
          continue;
        }
        for (const skipped of observation.skipped) setLocal(row.provider, `${bundle.id}:${skipped.slot}`, skipped.state, null);
        // A slot ADE could not read may still hold a login: only a positive "no login" counts toward the absence rule.
        if (observation.skipped.some((skipped) => skipped.state === "unreadable")) uncertain.add(row.provider);
        // A login that must go up but came from the memo is read again, in full.
        const needsFull = observation.logins.some((login) => !login.full && decide(login.memo, vault, rows, state, machine).push);
        if (needsFull) {
          observation = await observeBundle(row, bundle, state, origin12, true);
          if (observation.kind !== "parsed") {
            uncertain.add(row.provider);
            setLocal(row.provider, bundle.id, observation.kind === "absent" ? "not_signed_in" : observation.kind, null);
            continue;
          }
        }
        for (const { memo: observed, full } of observation.logins) {
          if (deps.cloudComputer && s.appliedLoginHashes.has(observed.contentHash)) {
            // The account's sign-in that apply wrote here: never captured back, and
            // the sign-in it replaced (made here) is not "signed out here".
            setLocal(row.provider, `${bundle.id}:${observed.slot}`, "from_account", null);
            uncertain.add(row.provider);
            continue;
          }
          // A sign-in this cloud computer took the renewal over for, renewed here
          // (by ADE or by its CLI): it goes back into that sign-in's own key, never
          // into a new one, and only while this computer still owns it (step 3b).
          const takeover = deps.cloudComputer ? jobs.ownedPlaceFor(row.provider, observed) : null;
          const memo = takeover ? { ...observed, key: takeover.source } : observed;
          if (takeover) {
            uncertain.add(row.provider);
            const ownedRow = rows.get(takeover.source);
            if (!ownedRow || ownedRow.deleted || ownedRow.refreshOwner !== machine.deviceId) {
              // The person removed it, or the origin claimed it back: never pushed from here.
              setLocal(row.provider, `${bundle.id}:${memo.slot}`, "from_account", null);
              continue;
            }
          } else {
            seenKeys.add(memo.key);
          }
          const pushed = state.pushed[memo.key];
          if (pushed) {
            pushed.absentSince = null;
            pushed.absentPasses = 0;
          }
          const decision = decide(memo, vault, rows, state, machine);
          if (!decision.push && decision.writeBack) {
            writeBacks.push({ provider: row.provider, memo, slotId: `${bundle.id}:${memo.slot}`, bundleId: bundle.id });
          }
          let local: ProviderLoginLocalState = decision.push && full
            ? push(row.provider, full, memo, vault, rows, state, machine, takeover ? { place: takeover.place } : null)
            : decision.push ? "settling" : decision.state;
          if (decision.push && full && local === "captured") accountChanged = true;
          // Written here, but the account service will not take it: say so, never "in your account".
          if (local === "captured" && parked.has(memo.key)) local = "account_refused";
          setLocal(row.provider, `${bundle.id}:${memo.slot}`, local, memo.key);
        }
      }
    }

    // The write-back (step 3b): the newer copy of this computer's own sign-in, into its login file.
    for (const candidate of writeBacks) {
      if (await jobs.writeBack(candidate, vault, rows, state, machine)) setLocal(candidate.provider, candidate.slotId, "written_back", candidate.memo.key);
    }

    // This computer's sign-ins that are gone here: two passes 60 s apart remove them from the account.
    for (const [key, pushed] of Object.entries(state.pushed)) {
      const parsedKey = parseProviderLoginKey(key);
      if (!parsedKey || parsedKey.origin12 !== origin12 || seenKeys.has(key)) continue;
      if (providers && !providers.has(parsedKey.provider)) continue;
      if (uncertain.has(parsedKey.provider)) continue;
      pushed.absentSince ??= now();
      pushed.absentPasses += 1;
      if (pushed.absentPasses < 2 || now() - pushed.absentSince < ABSENT_REMOVE_MS) continue;
      const row = rows.get(key);
      if (row && !row.deleted) {
        if (vault.remove(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND, key)) {
          accountChanged = true;
          deps.logger.info("provider_login.removed", { provider: parsedKey.provider, slot: parsedKey.slot, reason: "signed_out_at_origin" });
        }
      }
      // Forget it: if the login comes back, the next pass captures it again into the same key.
      delete state.pushed[key];
      if (state.writtenBack?.[key]) delete state.writtenBack[key];
      // Kept, so a copy that comes back into the account while the person is still signed out here leaves again.
      state.signedOut = { ...(state.signedOut ?? {}), [key]: now() };
      removedThisPass.add(key);
    }

    // A sign-in the person signed out of here that is back in the account (a
    // cloud computer's write that crossed the removal): removed again, while
    // the person is still signed out here. A new sign-in here clears the mark.
    for (const key of Object.keys(state.signedOut ?? {})) {
      const parsedKey = parseProviderLoginKey(key);
      if (!parsedKey || parsedKey.origin12 !== origin12 || seenKeys.has(key)) {
        delete state.signedOut![key];
        continue;
      }
      if ((providers && !providers.has(parsedKey.provider)) || uncertain.has(parsedKey.provider) || removedThisPass.has(key)) continue;
      const row = rows.get(key);
      if (row && !row.deleted && vault.remove(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND, key)) {
        accountChanged = true;
        deps.logger.info("provider_login.removed", { provider: parsedKey.provider, slot: parsedKey.slot, reason: "signed_out_at_origin_again" });
      }
    }

    if (JSON.stringify(state) !== before) {
      try {
        writeProviderLoginState(deps.adeDir, state);
      } catch (error) {
        deps.logger.warn("provider_login.state_write_failed", { code: (error as NodeJS.ErrnoException)?.code ?? null });
      }
    }
    if (accountChanged) notifyProviderLoginsChanged();
    if (deps.cloudComputer) {
      await jobs.runApply(vault, accountUserId, origin12, machine.deviceId, providers, true);
      jobs.checkArmed();
    }
    await jobs.planRenewals(vault, machine, origin12, state);
    notifyProviderLoginPass({
      accountUserId,
      cloudComputer: deps.cloudComputer,
      providers: providers ? [...providers] : null,
      captureOff: null,
    });
  }

  /** One pass at a time; a request during a pass runs once more after it. */
  function pass(providers: ProviderLoginProvider[] | null = null): Promise<void> {
    const wanted = providers ? new Set(providers) : null;
    if (s.inFlight) {
      if (!rerun) rerun = { providers: wanted };
      else if (!wanted || !rerun.providers) rerun.providers = null;
      else for (const provider of wanted) rerun.providers.add(provider);
      return s.inFlight;
    }
    s.inFlight = (async () => {
      try {
        await runPass(wanted);
        while (rerun) {
          const next = rerun;
          rerun = null;
          await runPass(next.providers);
        }
      } catch (error) {
        deps.logger.warn("provider_login.pass_failed", {
          name: error instanceof Error ? error.name : "unknown",
          code: (error as NodeJS.ErrnoException)?.code ?? null,
        });
      } finally {
        s.inFlight = null;
      }
    })();
    return s.inFlight;
  }

  return { pass, decide, push, statBundle, stableRead, ghTokenStep, ofSameSignIn };
}
