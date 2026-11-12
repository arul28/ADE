/**
 * Apply (P5): bring the files and env keys here in line with what the
 * account picked for ADE Cloud. The capture pass runs first in the same
 * pass, so the local states say whether a file here is safe to replace. A
 * renewing copy is access-only; the full copy goes only to a computer that
 * took the renewal over.
 *
 * On a cloud computer it is the whole job. On a person's own computer it is
 * the sync down (B14-9): a sign-in made on ADE Cloud, or on another of their
 * computers, reaches this one, a computer added later included, and only
 * where this computer has no sign-in of its own for that provider. It never
 * replaces a local sign-in (a collision is logged once), never writes a
 * saved ADE Cloud key or an env variable, and never takes this computer's
 * own copy back. Claude never comes down (Claude's normal sign-in stays on
 * each computer; ADE Cloud uses a Claude pass), and neither does any GitHub
 * credential (Copilot's GitHub CLI login).
 */

import fs from "node:fs";

import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import { cloudChoiceKey } from "../../../shared/providerLoginsCloudSetting";
import type { ProviderLoginLocalState, ProviderLoginProvider } from "../../../shared/types/providerLogins";
import { noteProviderLoginChanged } from "../ai/providerLoginChanged";
import { isRecord } from "../shared/utils";
import {
  adoptOldCodexKeyFile,
  applyCodexKey,
  appliedEntryUnchanged,
  applySignIn,
  emptyAppliedState,
  readAppliedState,
  readBackLoginHashes,
  removeApplied,
  writeAppliedState,
  type AppliedEntry,
  type AppliedStateFile,
} from "./providerLoginApply";
import { takeCloudSignInEnv } from "./providerLoginBoot";
import { carryRow, type CarryBundle, type ParsedLogin } from "./providerLoginCarry";
import { copilotCarriedHash, setCopilotCarriedToken } from "./providerLoginCopilotEnv";
import { notifyProviderLoginsChanged, restartProviderRuntimesWhenIdle, type ProviderLoginRestartOptions } from "./providerLoginHooks";
import { PROVIDER_LOGIN_VAULT_KIND, parseProviderLoginKey, readProviderLoginPayload, shortHash } from "./providerLoginPayload";
import {
  OVERWRITE_SAFE,
  SAVED_KEYS,
  accountHash,
  cloudPlacePicks,
  isSavedKeySource,
  savedKeySource,
  savedKeyTokenOf,
  savedKeyVaultKey,
  type CloudSetting,
  type LoginMemo,
  type ProviderLoginVault,
  type SyncShared,
} from "./providerLoginSyncShared";

/** Local states of a sign-in made here and kept in the account (or kept here while the account refuses it). */
const OWN_LOGIN_STATES: ReadonlySet<ProviderLoginLocalState> = new Set(["captured", "account_refused"]);

/** A Pi place's sub-provider (`pi:<slot>`), or null for any other provider's place. */
function piSlotOf(provider: ProviderLoginProvider, place: string): string | null {
  return provider === "pi" ? place.slice("pi:".length) : null;
}

/**
 * What apply does on this computer, decided once from what it is:
 * - a cloud computer: the whole job (P5);
 * - a person's own computer: the sync down (B14-9; see the top).
 */
type ApplyPolicy = {
  /** The sync down: write only where no local sign-in is, and stay off a place signed out of here. */
  down: boolean;
  /** Which providers' sign-ins are written here. Claude and Copilot never come down. */
  takes: (provider: ProviderLoginProvider) => boolean;
  /** Saved ADE Cloud keys, the env keys, and the old cloud boot's env and Codex key file. */
  savedKeysAndEnv: boolean;
  /** This computer's own copy, written back here. */
  ownCopy: boolean;
  /** The full copy of a renewing sign-in this computer took the renewal over for. */
  renewal: boolean;
  /** Copilot's token in the launch helper (G1). */
  copilot: boolean;
};

const CLOUD_COMPUTER_POLICY: ApplyPolicy = { down: false, takes: () => true, savedKeysAndEnv: true, ownCopy: true, renewal: true, copilot: true };
/** Never down: Claude (its normal sign-in stays on each computer; ADE Cloud uses a pass) and Copilot (a GitHub credential). */
const NEVER_DOWN: ReadonlySet<ProviderLoginProvider> = new Set(["claude", "copilot"]);
const OWN_COMPUTER_POLICY: ApplyPolicy = {
  down: true,
  takes: (provider) => !NEVER_DOWN.has(provider),
  savedKeysAndEnv: false,
  ownCopy: false,
  renewal: false,
  copilot: false,
};

export function createApplyPass(s: SyncShared) {
  const { deps, now, env, ctx, localStates, applyStates, ownerOff } = s;
  const { cloudSetting, setLocal, metaFor } = s;
  const policy = deps.cloudComputer ? CLOUD_COMPUTER_POLICY : OWN_COMPUTER_POLICY;
  /** `<place> <key>` pairs whose collision with a local sign-in was logged, so each is logged once. */
  const keptLocalLogged = new Set<string>();

  /** The local states capture read for the place: Pi's own sub-provider's entries and the file as a whole; every slot otherwise. */
  function* localSlotsAt(provider: ProviderLoginProvider, place: string) {
    const slot = piSlotOf(provider, place);
    for (const [slotId, local] of localStates.get(provider) ?? []) {
      if (slot && slotId.includes(":") && !slotId.endsWith(`:${slot}`)) continue;
      yield local;
    }
  }

  /**
   * The sync down stays off a place this computer signed out of: the person
   * removed what the sync down wrote (`declined`), signed out of this
   * computer's own sign-in there (capture's `signedOut` mark), or is signing
   * out of it now (capture saw it gone and waits out the second pass,
   * `absentSince`). A sign-in made here again lifts all three.
   */
  function downDeclined(state: AppliedStateFile, accountUserId: string, origin12: string, place: string): boolean {
    if (state.declined?.[place] != null) return true;
    const capture = s.loadState(accountUserId);
    const leaving = Object.entries(capture.pushed).filter(([, pushed]) => pushed.absentSince != null).map(([key]) => key);
    for (const key of [...Object.keys(capture.signedOut ?? {}), ...leaving]) {
      const parsedKey = parseProviderLoginKey(key);
      if (parsedKey && parsedKey.origin12 === origin12 && cloudChoiceKey(parsedKey.provider, parsedKey.slot) === place) return true;
    }
    return false;
  }

  /** This computer has its own sign-in at the place now (captured, kept here, or taken out of the account): the person signed in here. */
  function signedInHere(provider: ProviderLoginProvider, place: string): boolean {
    for (const local of localSlotsAt(provider, place)) {
      if (OWN_LOGIN_STATES.has(local.state) || local.state === "removed_from_account") return true;
    }
    return false;
  }

  type Want =
    | {
      kind: "signin";
      place: string;
      provider: ProviderLoginProvider;
      slot: string;
      key: string;
      contentHash: string;
      class: ParsedLogin["class"];
      own: boolean;
      /** This cloud computer owns the renewal (it took it over): the full copy goes here (step 3b). */
      owned: boolean;
    }
    | { kind: "key"; place: string; provider: ProviderLoginProvider; id: string; token: string; contentHash: string };

  /** What the first apply took out of the env (fix B1); null until then. Values stay in memory only. */
  let envTaken: Readonly<Record<string, string>> | null = null;
  /**
   * Bumped by `forgetApplied` (an ADE sign-out). An apply that started for the
   * account before checks it before each write and before it saves the applied
   * state, so it never writes the old account's sign-ins after the sign-out
   * removed them.
   */
  let accountGeneration = 0;

  const rememberAppliedHashes = (state: AppliedStateFile): void => {
    s.appliedLoginHashes = new Set(Object.values(state.applied).flatMap((entry) => entry.loginHashes ?? []));
  };

  /** Undo every file and env key this computer applied (sign-out, account switch). */
  async function removeAllApplied(state: AppliedStateFile, reason: string): Promise<void> {
    const providers = new Set<string>();
    for (const [place, entry] of Object.entries(state.applied)) {
      try {
        await removeApplied(entry);
      } catch (error) {
        deps.logger.warn("provider_login.remove_failed", { place, code: (error as NodeJS.ErrnoException)?.code ?? null });
      }
      providers.add(entry.provider);
      deps.logger.info("provider_login.removed", { provider: entry.provider, place, reason });
    }
    for (const [name, valueHash] of Object.entries(state.env)) {
      const value = env[name];
      if (value != null && shortHash(value) === valueHash) delete env[name];
    }
    state.applied = {};
    state.env = {};
    // Copilot's token lives only in the launch helper (G1).
    setCopilotCarriedToken(null);
    for (const provider of providers) afterApplyChange(provider);
  }

  /**
   * Every present file of this bundle is one apply wrote, unchanged (Kimi's
   * config, where apply adds only a section, is left out of the check). Read
   * only for a bundle that is still settling, so only just after an apply.
   */
  function isAppliedBundle(provider: ProviderLoginProvider, bundle: CarryBundle): boolean {
    const entries = Object.values(s.appliedCache?.applied ?? {}).filter((entry) => entry.provider === provider);
    const files = entries.flatMap((entry) => entry.files);
    if (!files.length) return false;
    // Files apply only adds a part to (Kimi's config, Antigravity's settings) are left out.
    const kimiConfigs = new Set(entries.flatMap((entry) => [entry.kimiConfig?.path, entry.antigravity?.path].filter((abs): abs is string => Boolean(abs))));
    let present = 0;
    for (const spec of bundle.files) {
      if (kimiConfigs.has(spec.abs)) continue;
      let bytes: Buffer;
      try {
        bytes = fs.readFileSync(spec.abs);
      } catch {
        continue;
      }
      present += 1;
      const hash = shortHash(bytes);
      if (!files.some((file) => file.abs === spec.abs && file.hash === hash)) return false;
    }
    return present > 0;
  }

  function afterApplyChange(provider: string, switched?: ProviderLoginRestartOptions["switched"]): void {
    noteProviderLoginChanged(provider);
    restartProviderRuntimesWhenIdle(provider, switched ? { switched } : undefined);
  }

  /** The words for a pick in "Switched to <label>." (step 3d): the account's email, else the computer the sign-in came from. */
  function pickLabel(vault: ProviderLoginVault, key: string): string {
    if (key === "key") return "your saved key";
    const row = vault.list(ACCOUNT_SCOPE_ALL).find((entry) => entry.kind === PROVIDER_LOGIN_VAULT_KIND && entry.key === key);
    const meta = row && !row.deleted ? metaFor(vault, row) : null;
    const email = meta?.account?.email?.trim();
    if (email) return email;
    return meta?.origin.label ? `Sign-in from ${meta.origin.label}` : "an earlier sign-in";
  }

  async function loadApplied(accountUserId: string): Promise<AppliedStateFile> {
    if (s.appliedCache?.accountUserId === accountUserId) return s.appliedCache;
    const onDisk = readAppliedState(deps.adeDir);
    if (onDisk && onDisk.accountUserId !== accountUserId) {
      // Another account's sign-ins must not stay on this computer.
      await removeAllApplied(onDisk, "account_switch");
    }
    s.appliedCache = onDisk && onDisk.accountUserId === accountUserId ? onDisk : emptyAppliedState(accountUserId);
    rememberAppliedHashes(s.appliedCache);
    return s.appliedCache;
  }

  function savedKeyToken(id: string, vault: ProviderLoginVault): string | null {
    return savedKeyTokenOf(vault.get(ACCOUNT_SCOPE_ALL, "integration", savedKeyVaultKey(id)));
  }

  /**
   * What ADE Cloud uses for each place now (P5 §4.2), from the vault and the
   * setting. Coming down to an own computer: only another computer's
   * sign-in, of a provider that comes down; never a saved key.
   */
  function desiredPlaces(vault: ProviderLoginVault, setting: CloudSetting, origin12: string, deviceId: string): Map<string, Want> {
    const picks = cloudPlacePicks(vault.list(ACCOUNT_SCOPE_ALL), setting, {
      usable: (row) => row.readable,
      meta: (row) => metaFor(vault, row),
      savedKeyToken: (id) => savedKeyToken(id, vault),
    });
    const wants = new Map<string, Want>();
    const keyWant = (place: string, provider: ProviderLoginProvider, id: string, token: string): Want =>
      ({ kind: "key", place, provider, id, token, contentHash: shortHash(token) });
    for (const [place, picked] of picks) {
      if (!policy.takes(picked.provider)) continue;
      if ("savedKey" in picked) {
        if (!policy.savedKeysAndEnv) continue;
        wants.set(place, keyWant(place, picked.provider, picked.savedKey.id, picked.savedKey.token));
        continue;
      }
      const pick = picked.signIn;
      const parsedKey = parseProviderLoginKey(pick.row.key)!;
      // This computer's own copy is its own sign-in, or one the person signed out of here: never written back down.
      if (!policy.ownCopy && parsedKey.origin12 === origin12) continue;
      wants.set(place, {
        kind: "signin",
        place,
        provider: pick.provider,
        slot: pick.slot,
        key: pick.row.key,
        contentHash: pick.meta.contentHash,
        class: pick.meta.class,
        own: parsedKey.origin12 === origin12,
        // Only a cloud computer takes a renewal over; an own computer gets the access-only copy.
        owned: policy.renewal && pick.meta.class === "renewing" && parsedKey.origin12 !== origin12 && pick.row.refreshOwner === deviceId,
      });
    }
    if (!policy.savedKeysAndEnv) return wants;
    // A carried provider with no sign-in in use falls back to its saved key; a key-only provider always uses it.
    for (const spec of SAVED_KEYS) {
      if (!spec.provider) continue;
      if (wants.has(spec.provider)) continue;
      const token = savedKeyToken(spec.id, vault);
      if (token) wants.set(spec.provider, keyWant(spec.provider, spec.provider, spec.id, token));
    }
    return wants;
  }

  /** May apply replace this provider's file here? Only when the login in it is safe in the account, or is the account's. */
  function mayOverwrite(provider: ProviderLoginProvider, place: string, have: AppliedEntry | null): boolean {
    for (const local of localSlotsAt(provider, place)) {
      if (OVERWRITE_SAFE.has(local.state)) continue;
      if (local.state === "from_saved_key" && isSavedKeySource(have?.source)) continue;
      return false;
    }
    return true;
  }

  /** The sign-in in use was made here and the file here is it: nothing to write, never cut to access-only. */
  function isOwnLoginHere(provider: ProviderLoginProvider, key: string): boolean {
    for (const local of localStates.get(provider)?.values() ?? []) {
      if (local.key === key && OWN_LOGIN_STATES.has(local.state)) return true;
    }
    return false;
  }

  function saveApplied(): void {
    if (!s.appliedCache) return;
    rememberAppliedHashes(s.appliedCache);
    try {
      writeAppliedState(deps.adeDir, s.appliedCache);
    } catch (error) {
      deps.logger.warn("provider_login.applied_write_failed", { code: (error as NodeJS.ErrnoException)?.code ?? null });
    }
  }

  /**
   * The place of a sign-in this cloud computer took the renewal over for,
   * when `login` (read here, not the copy apply wrote) is that sign-in renewed
   * here: the same provider and slot, and the same account. Its files are
   * then recorded as ADE's again, so they still leave when the sign-in
   * leaves the account (step 3b).
   */
  function ownedPlaceFor(provider: ProviderLoginProvider, login: LoginMemo): { place: string; source: string } | null {
    const place = cloudChoiceKey(provider, login.slot);
    const entry = s.appliedCache?.applied[place];
    if (!entry?.owned || entry.provider !== provider || login.class !== "renewing") return null;
    if (entry.accountHash && entry.accountHash !== accountHash(login.account)) return null;
    let changed = false;
    for (const file of entry.files) {
      try {
        const hash = shortHash(fs.readFileSync(file.abs));
        if (hash !== file.hash) {
          file.hash = hash;
          changed = true;
        }
      } catch {
        // Gone: removal has nothing to take.
      }
    }
    if (entry.pi) {
      try {
        const current = JSON.parse(fs.readFileSync(entry.pi.authPath, "utf8")) as unknown;
        const value = isRecord(current) ? current[entry.pi.slot] : undefined;
        const hash = value === undefined ? null : shortHash(JSON.stringify(value));
        if (hash && hash !== entry.pi.entryHash) {
          entry.pi.entryHash = hash;
          changed = true;
        }
      } catch {
        // Unreadable now: the next pass looks again.
      }
    }
    if (changed) saveApplied();
    return { place, source: entry.source };
  }

  /** After a takeover's push: the applied entry is that copy, so apply leaves it and capture skips it. */
  function noteOwnedCopy(place: string, memo: LoginMemo, expiresAt: number | null): void {
    const entry = s.appliedCache?.applied[place];
    if (!entry?.owned) return;
    entry.contentHash = memo.contentHash;
    entry.loginHashes = [memo.contentHash];
    entry.expiresAt = expiresAt;
    ownerOff.delete(place);
    saveApplied();
  }

  /**
   * The sync down's rule on an own computer: replace only what ADE wrote and
   * nobody changed (every part: files, Pi's entry, Qwen's fields) while no
   * sign-in made here sits at the place, or write where this computer has no
   * sign-in for the provider (capture read it as signed out, and the file
   * reads back empty). A sign-in the person made here, in the account or
   * not, always stays.
   */
  function mayWriteDown(provider: ProviderLoginProvider, place: string, have: AppliedEntry | null): boolean {
    return have ? appliedEntryUnchanged(have) && !signedInHere(provider, place) : noLoginHere(provider, place);
  }

  /**
   * No sign-in at the place here: capture read every slot as signed out (not
   * settling, not unreadable), and the files read back empty.
   */
  function noLoginHere(provider: ProviderLoginProvider, place: string): boolean {
    // A provider capture did not look at here (Antigravity in a Mac's Keychain), or one
    // whose login may sit in the OS keychain or keyring, is never "signed out".
    if (carryRow(provider).osStore?.(ctx)) return false;
    let looked = false;
    for (const local of localSlotsAt(provider, place)) {
      if (local.state !== "not_signed_in") return false;
      looked = true;
    }
    return looked && readBackLoginHashes(provider, piSlotOf(provider, place), ctx).length === 0;
  }

  /**
   * Without a capture pass just before (the off switch for all), the local
   * states are old: replace only a file ADE wrote and nobody changed, or write
   * where no sign-in is.
   */
  function mayOverwriteUnobserved(provider: ProviderLoginProvider, place: string, have: AppliedEntry | null): boolean {
    if (have) return appliedEntryUnchanged(have);
    return readBackLoginHashes(provider, piSlotOf(provider, place), ctx).length === 0;
  }

  /**
   * Copilot's place on a cloud computer (G1): no file and no env variable.
   * The token in use (a carried GitHub CLI login, or the saved key) goes into
   * the launch helper, which gives it only to Copilot processes at start.
   * The applied entry keeps the source and hash only. True when the token in
   * use here changed (Copilot restarts when idle).
   */
  function applyCopilot(
    vault: ProviderLoginVault,
    state: AppliedStateFile,
    place: string,
    want: Want | null,
    have: AppliedEntry | null,
    pickedBefore: string | null,
    noteSwitch: (provider: string, before: string | null, after: string) => void,
  ): boolean {
    const token = want?.kind === "key" ? want.token : want ? copilotTokenOf(vault, want.key) : null;
    if (!want || !token) {
      applyStates.set(place, { state: want ? "failed" : "none", key: want ? (want.kind === "key" ? "key" : want.key) : null });
      if (want) deps.logger.warn("provider_login.apply_failed", { provider: "copilot", place, reason: "nothing_to_write", code: null });
      const hadToken = copilotCarriedHash() != null;
      setCopilotCarriedToken(null);
      if (have) {
        delete state.applied[place];
        deps.logger.info("provider_login.removed", { provider: "copilot", place, reason: "not_in_use" });
      }
      return hadToken || Boolean(have);
    }
    const pick = want.kind === "key" ? "key" : want.key;
    const source = want.kind === "key" ? savedKeySource(want.id) : want.key;
    applyStates.set(place, { state: want.kind === "key" ? "key" : "applied", key: pick });
    const fresh = copilotCarriedHash() !== want.contentHash;
    if (!fresh && have?.source === source && have.contentHash === want.contentHash) return false;
    setCopilotCarriedToken({ token, hash: want.contentHash });
    state.applied[place] = { provider: "copilot", source, contentHash: want.contentHash, accessOnly: false, renewalSafe: true, files: [], loginHashes: [], appliedAt: now() };
    ownerOff.delete(place);
    noteSwitch("copilot", pickedBefore, pick);
    deps.logger.info("provider_login.applied", { provider: "copilot", place, key: pick, accessOnly: false, renewalSafe: true });
    return fresh;
  }

  /** The GitHub token a carried Copilot sign-in holds (`parts.githubToken`), or null. Never logged. */
  function copilotTokenOf(vault: ProviderLoginVault, key: string): string | null {
    const payload = readProviderLoginPayload(vault.get(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND, key));
    const token = payload?.provider === "copilot" ? payload.parts?.githubToken : null;
    return typeof token === "string" && token ? token : null;
  }

  /**
   * Bring the files and env keys here in line with what the account picked.
   * On an own computer, only the sync down's sign-ins (see the top).
   */
  async function runApply(
    vault: ProviderLoginVault,
    accountUserId: string,
    origin12: string,
    deviceId: string,
    providers: Set<ProviderLoginProvider> | null,
    captureRan: boolean,
  ): Promise<void> {
    const generation = accountGeneration;
    const signedOutSince = (): boolean => generation !== accountGeneration;
    const state = await loadApplied(accountUserId);
    if (signedOutSince()) return;
    const before = JSON.stringify(state);
    // Fix B1: the boot leaves the sign-in variables the desktop sent in the env
    // (the old path). They leave at the first apply, which runs only with a
    // signed-in account and a ready vault, so a key leaves only when the vault
    // can give it back. A process that started earlier keeps its env until the
    // idle restart that the changed providers get below.
    const envBefore = new Map(SAVED_KEYS.map((spec) => [spec.env, env[spec.env]]));
    // The boot's env and the old Codex key file are a cloud computer's only.
    const takeover = policy.savedKeysAndEnv && !envTaken;
    if (takeover) {
      envTaken = takeCloudSignInEnv(env);
      deps.logger.info("provider_login.env_taken", { names: Object.keys(envTaken) });
    }
    if (policy.savedKeysAndEnv && !state.applied.codex && !state.env.OPENAI_API_KEY) {
      // The Codex file the old cloud boot wrote from the computer's instance env: managed from now on.
      const bootKey = envTaken?.OPENAI_API_KEY;
      const adopted = bootKey ? adoptOldCodexKeyFile(bootKey, ctx, now()) : null;
      if (adopted) {
        state.applied.codex = adopted;
        deps.logger.info("provider_login.adopted", { provider: "codex", source: "old_cloud_boot" });
      }
    }
    const setting = cloudSetting();
    const wants = desiredPlaces(vault, setting, origin12, deviceId);
    const changed = new Set<string>();
    // ADE Cloud's pick changed for a provider (not a renewal, not the first pick here): its open chats say so (step 3d).
    const switches = new Map<string, NonNullable<ProviderLoginRestartOptions["switched"]>>();
    const noteSwitch = (provider: string, before: string | null, after: string): void => {
      if (!before || before === after || switches.has(provider)) return;
      switches.set(provider, { from: { key: before, label: pickLabel(vault, before) }, to: { key: after, label: pickLabel(vault, after) } });
    };
    const places = new Set([...wants.keys(), ...Object.keys(state.applied)]);
    for (const place of places) {
      // Signed out of ADE during this apply: nothing more is written (forgetAccount removes what was).
      if (signedOutSince()) return;
      const provider = (place.startsWith("pi:") ? "pi" : place) as ProviderLoginProvider;
      if (providers && !providers.has(provider)) continue;
      let want = wants.get(place) ?? null;
      const have = state.applied[place] ?? null;
      if (policy.down && captureRan) {
        // A sign-in made here lifts a sign-out the sync down kept to.
        if (state.declined?.[place] != null && signedInHere(provider, place)) delete state.declined[place];
        // What the sync down wrote is gone, and nobody wrote another: the person signed out here. It stays signed out.
        if (have && have.loginHashes.length && noLoginHere(provider, place)) {
          state.declined = { ...(state.declined ?? {}), [place]: now() };
          deps.logger.info("provider_login.down_declined", { provider, place, reason: "signed_out_here" });
        }
        if (want && downDeclined(state, accountUserId, origin12, place)) want = null;
      }
      const pickedBefore = applyStates.get(place)?.key ?? (have ? (isSavedKeySource(have.source) ? "key" : have.source) : null);
      if (provider === "copilot") {
        // A GitHub credential never comes down to an own computer.
        if (policy.copilot && applyCopilot(vault, state, place, want, have, pickedBefore, noteSwitch)) changed.add(provider);
        continue;
      }
      const fileLess = want?.kind === "key" && want.provider !== "codex";
      if (!want || fileLess) {
        applyStates.set(place, { state: want ? "key" : "none", key: want ? "key" : null });
        if (!have) continue;
        // An own computer keeps a working sign-in the sync down wrote when the
        // account stops using it (switched off for ADE Cloud, removed, another
        // pick), as the off switch for all does; ADE sign-out takes it. Only a
        // sign-out here (nothing at the place any more) forgets it.
        if (policy.down && !(captureRan && noLoginHere(provider, place))) continue;
        try {
          await removeApplied(have);
        } catch (error) {
          // One place that can't be cleaned (a file held open) never stops the others; the entry stays, so the next pass tries again.
          applyStates.set(place, { state: "failed", key: want ? "key" : null });
          deps.logger.warn("provider_login.remove_failed", { provider, place, code: (error as NodeJS.ErrnoException)?.code ?? null });
          continue;
        }
        delete state.applied[place];
        localStates.get(provider)?.delete(`applied:${place}`);
        changed.add(provider);
        if (want) noteSwitch(provider, pickedBefore, "key");
        deps.logger.info("provider_login.removed", { provider, place, reason: want ? "key_in_use" : "not_in_use" });
        continue;
      }
      const source = want.kind === "key" ? savedKeySource(want.id) : want.key;
      const owned = want.kind === "signin" && want.owned;
      // The same copy, and the same owner: nothing to do. A change of owner (a takeover, or the origin's claim back) writes again.
      if (have && have.source === source && have.contentHash === want.contentHash && Boolean(have.owned) === owned) {
        applyStates.set(place, { state: want.kind === "key" ? "key" : have.files.length || have.pi || have.qwen ? "applied" : "own", key: want.kind === "key" ? "key" : want.key });
        continue;
      }
      if (want.kind === "signin" && want.own && isOwnLoginHere(provider, want.key)) {
        state.applied[place] = { provider, source, contentHash: want.contentHash, accessOnly: false, renewalSafe: true, files: [], loginHashes: [], appliedAt: now() };
        applyStates.set(place, { state: "own", key: want.key });
        continue;
      }
      const mayWrite = policy.down
        ? captureRan && mayWriteDown(provider, place, have)
        : captureRan ? mayOverwrite(provider, place, have) : mayOverwriteUnobserved(provider, place, have);
      if (!mayWrite) {
        applyStates.set(place, { state: "kept_local", key: want.kind === "key" ? "key" : want.key });
        // The person's own sign-in here wins over the account's copy; said once per copy, like the PAT's collision.
        const logKey = `${place} ${source}`;
        if (policy.down && captureRan && !keptLocalLogged.has(logKey)) {
          keptLocalLogged.add(logKey);
          deps.logger.info("provider_login.down_kept_local", { provider, place, reason: have ? "changed_here" : "signed_in_here" });
        }
        continue;
      }
      let result: Awaited<ReturnType<typeof applySignIn>>;
      if (want.kind === "key") {
        result = applyCodexKey(source, want.token, ctx, have, now());
      } else {
        const payload = readProviderLoginPayload(vault.get(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND, want.key));
        result = payload && payload.provider === provider
          ? await applySignIn({
            place,
            provider,
            source,
            contentHash: payload.contentHash,
            slot: payload.slot,
            class: payload.class,
            files: payload.files,
            parts: payload.parts,
            expiresAt: payload.expiresAt,
            full: owned,
          }, have, ctx, now())
          : { ok: false, reason: "nothing_to_write" };
        if (result.ok && owned) result.entry.accountHash = accountHash(payload?.account ?? null);
      }
      if (result.ok && signedOutSince()) {
        // Written while the sign-out ran: the old account's copy leaves again.
        await removeApplied(result.entry).catch((error: unknown) => {
          deps.logger.warn("provider_login.remove_failed", { provider, place, code: (error as NodeJS.ErrnoException)?.code ?? null });
        });
        return;
      }
      if (!result.ok) {
        applyStates.set(place, { state: "failed", key: want.kind === "key" ? "key" : want.key });
        deps.logger.warn("provider_login.apply_failed", { provider, place, reason: result.reason, code: result.code ?? null });
        continue;
      }
      state.applied[place] = result.entry;
      ownerOff.delete(place);
      applyStates.set(place, { state: want.kind === "key" ? "key" : "applied", key: want.kind === "key" ? "key" : want.key });
      // Until the next pass reads the file back, the status says whose it is.
      if (want.kind === "signin") setLocal(provider, `applied:${place}`, "from_account", null);
      changed.add(provider);
      noteSwitch(provider, pickedBefore, want.kind === "key" ? "key" : want.key);
      deps.logger.info("provider_login.applied", {
        provider,
        place,
        key: want.kind === "key" ? "key" : want.key,
        accessOnly: result.entry.accessOnly,
        renewalSafe: result.entry.renewalSafe,
        ...(owned ? { owned: true } : {}),
      });
    }

    // Env keys: a saved key is in its variable only while it is in use, so it never outranks a carried sign-in.
    // The pass that took the boot variables puts back every one the account still has, whatever `providers` says.
    // Never on an own computer: the sync down writes sign-ins only.
    if (signedOutSince()) return;
    const envProviders = takeover ? null : providers;
    if (policy.savedKeysAndEnv && (!envProviders || SAVED_KEYS.some((spec) => spec.provider && envProviders.has(spec.provider)))) {
      for (const spec of SAVED_KEYS) {
        if (envProviders && (!spec.provider || !envProviders.has(spec.provider))) continue;
        const want = spec.provider ? wants.get(spec.provider) : null;
        // Copilot's key never goes into the brain's env: the launch helper gives it to Copilot processes only (G1 Q3).
        // An old value apply set here leaves.
        const token = spec.id === "copilot" ? null
          : spec.provider
            ? (want?.kind === "key" && want.id === spec.id ? want.token : null)
            : savedKeyToken(spec.id, vault);
        const setHash = state.env[spec.env];
        if (token) {
          if (env[spec.env] !== token) env[spec.env] = token;
          state.env[spec.env] = shortHash(token);
        } else if (setHash) {
          const current = env[spec.env];
          if (current != null && shortHash(current) === setHash) delete env[spec.env];
          delete state.env[spec.env];
        }
      }
    }
    // A provider whose variable now differs from before this pass (set, changed, or taken away) restarts when idle.
    for (const spec of SAVED_KEYS) {
      if (env[spec.env] !== envBefore.get(spec.env)) changed.add(spec.provider ?? spec.id);
    }

    if (signedOutSince()) return;
    if (JSON.stringify(state) !== before) {
      rememberAppliedHashes(state);
      try {
        writeAppliedState(deps.adeDir, state);
      } catch (error) {
        deps.logger.warn("provider_login.applied_write_failed", { code: (error as NodeJS.ErrnoException)?.code ?? null });
      }
    }
    for (const provider of changed) afterApplyChange(provider, switches.get(provider));
    if (changed.size) notifyProviderLoginsChanged();
  }

  /**
   * On ADE sign-out: an apply in flight stops before its next write, and the
   * account's sign-ins apply wrote here leave with the account (on an own
   * computer, only the ones the sync down wrote and nobody changed since).
   */
  function forgetApplied(): void {
    accountGeneration += 1;
    keptLocalLogged.clear();
    const onDisk = s.appliedCache ?? readAppliedState(deps.adeDir);
    s.appliedCache = null;
    applyStates.clear();
    s.appliedLoginHashes = new Set();
    if (onDisk && (Object.keys(onDisk.applied).length || Object.keys(onDisk.env).length)) {
      void removeAllApplied(onDisk, "signed_out")
        .then(() => {
          try {
            writeAppliedState(deps.adeDir, emptyAppliedState(null));
          } catch (error) {
            // Paths and hashes only; the next account's load starts it over.
            deps.logger.warn("provider_login.applied_write_failed", { code: (error as NodeJS.ErrnoException)?.code ?? null });
          }
        })
        .catch((error: unknown) => {
          deps.logger.warn("provider_login.forget_failed", {
            name: error instanceof Error ? error.name : "unknown",
            code: (error as NodeJS.ErrnoException)?.code ?? null,
          });
        });
    }
  }

  /** The account sign-in apply wrote here that capture reads back as `contentHash`, or null. */
  function appliedSourceOf(contentHash: string): string | null {
    for (const entry of Object.values(s.appliedCache?.applied ?? {})) {
      if (!isSavedKeySource(entry.source) && entry.loginHashes.includes(contentHash)) return entry.source;
    }
    return null;
  }

  return { runApply, loadApplied, isAppliedBundle, ownedPlaceFor, noteOwnedCopy, forgetApplied, appliedSourceOf };
}
