/**
 * The person's two reads that the background never makes:
 *
 * - The Keychain read on a Mac (§3.7): Antigravity's sign-in, one `security`
 *   read that macOS asks the person about.
 * - Copilot's GitHub CLI login (G1): the person's switch on one computer,
 *   and the one `gh auth token` read it starts.
 *
 * Also the Keychain and GitHub CLI parts of the status.
 */

import fs from "node:fs";

import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import type {
  ProviderLoginCaptureOffReason,
  ProviderLoginGhCliStatus,
  ProviderLoginLocalState,
  ProviderLoginProvider,
  ProviderLoginProviderStatus,
  ProviderLoginStatus,
} from "../../../shared/types/providerLogins";
import { isRecord } from "../shared/utils";
import {
  ANTIGRAVITY_SETTINGS_REL,
  GH_BUNDLE_ID,
  antigravityBundle,
  carryRow,
  copilotGhBundle,
  copilotGhHostsPath,
  parseAntigravitySettings,
} from "./providerLoginCarry";
import { GH_READ_MESSAGES, readGhHostsGithubCom } from "./providerLoginGhCli";
import { notifyProviderLoginsChanged } from "./providerLoginHooks";
import {
  antigravityKeychainAccount,
  decodeKeychainSecret,
  readKeychainSecret,
  type AntigravityKeychainSlot,
} from "./providerLoginKeychain";
import {
  PROVIDER_LOGIN_VAULT_KIND,
  loginContentHash,
  originId,
  providerLoginKey,
  shortHash,
} from "./providerLoginPayload";
import { writeProviderLoginState, type ProviderLoginStateFile } from "./providerLoginState";
import {
  GH_ALLOW_WHILE_OFF,
  OFF_MESSAGES,
  type LoginMemo,
  type ProviderLoginVault,
  type SyncShared,
  type VaultRow,
} from "./providerLoginSyncShared";

export function createAllow(s: SyncShared) {
  const { deps, now, platform, ctx, bundleMemos, localStates, jobs } = s;
  const { cloudSetting, captureOffReason, loadState, saveState, liveSignInKeys } = s;

  /**
   * Copy Antigravity's sign-in from this Mac's Keychain into the account:
   * one `security` read, which macOS asks the person about. Behind the same
   * gates as capture. Never runs in a pass or on a timer.
   */
  async function allowKeychain(args: { provider: ProviderLoginProvider; slot?: AntigravityKeychainSlot | null }): Promise<ProviderLoginStatus> {
    if (args.provider !== "antigravity") throw new Error("Only Antigravity's sign-in is copied from the Keychain.");
    if (platform !== "darwin" || deps.cloudComputer) throw new Error("ADE copies a sign-in from the Keychain only on a Mac.");
    const off = await captureOffReason();
    if (off) throw new Error(OFF_MESSAGES[off]);
    // The method the agent saved says which of its two items is the sign-in (no prompt: a plain file).
    let slot: AntigravityKeychainSlot = args.slot ?? "personal";
    if (!args.slot) {
      try {
        const settings = parseAntigravitySettings(fs.readFileSync(antigravityBundle(ctx, "personal").files[1]!.abs, "utf8"));
        if (isRecord(settings?.auth) && settings.auth.type === "oauth-business") slot = "business";
      } catch {
        // No settings: the Google-account sign-in.
      }
    }
    const read = await readKeychainSecret({
      account: antigravityKeychainAccount(slot),
      ...(deps.keychainCommand ? { command: deps.keychainCommand } : {}),
    });
    deps.logger.info("provider_login.keychain_read", { provider: "antigravity", slot, result: read.ok ? "ok" : read.reason });
    if (!read.ok) {
      throw new Error(
        read.reason === "not_found" ? "This Mac's Keychain has no Antigravity sign-in. Sign in to Antigravity first, then allow again."
          : read.reason === "denied" ? "macOS did not let ADE read it. Allow again, and choose Allow when macOS asks."
            : read.reason === "timeout" ? "macOS asked, but there was no answer in 2 minutes. Allow again."
              : "ADE couldn't read the Keychain. Try again.",
      );
    }
    const token = decodeKeychainSecret(read.data);
    if (!token) throw new Error("ADE found the Keychain item but could not read a sign-in from it.");
    // Behind the pass in flight, so the marks file has one writer.
    while (s.inFlight) await s.inFlight.catch(() => undefined);
    const vault = deps.vault();
    const machine = deps.machine();
    const accountUserId = deps.accountUserId();
    if (!vault || !machine || !accountUserId) throw new Error(OFF_MESSAGES.vault_unavailable);
    const bundle = antigravityBundle(ctx, slot);
    const contents = new Map<string, Buffer>([[bundle.files[0]!.rel, token]]);
    try {
      contents.set(ANTIGRAVITY_SETTINGS_REL, fs.readFileSync(bundle.files[1]!.abs));
    } catch {
      // No agent settings on this Mac: the slot says which method it is.
    }
    const row = carryRow("antigravity");
    const parsed = row.parse!(bundle, contents, ctx);
    if ("unreadable" in parsed || !parsed.logins.length) throw new Error("ADE found the Keychain item but could not read a sign-in from it.");
    const origin12 = originId(machine.machineKey);
    const state = loadState(accountUserId);
    const rows = new Map<string, VaultRow>();
    for (const vaultRow of vault.list(ACCOUNT_SCOPE_ALL)) {
      if (vaultRow.kind === PROVIDER_LOGIN_VAULT_KIND) rows.set(vaultRow.key, vaultRow);
    }
    let local: ProviderLoginLocalState = "not_checked";
    let key: string | null = null;
    for (const login of parsed.logins) {
      const memo: LoginMemo = {
        slot: login.slot,
        key: providerLoginKey("antigravity", origin12, login.slot),
        contentHash: loginContentHash(login),
        familyHash: shortHash(login.familySecret),
        class: login.class,
        expiresAt: login.expiresAt,
        account: login.account,
      };
      const decision = jobs.decide(memo, vault, rows, state, machine);
      local = decision.push ? jobs.push("antigravity", login, memo, vault, rows, state, machine) : decision.state;
      key = memo.key;
    }
    if (local === "removed_from_account") {
      throw new Error("You removed this sign-in from your account. Sign in to Antigravity again on this Mac, then allow again.");
    }
    if (local !== "captured" || !key) throw new Error("ADE couldn't put the sign-in in your account. Try again in a moment.");
    state.keychain = { ...(state.keychain ?? {}), antigravity: { allowedAt: now(), slot, key } };
    try {
      writeProviderLoginState(deps.adeDir, state);
    } catch (error) {
      deps.logger.warn("provider_login.state_write_failed", { code: (error as NodeJS.ErrnoException)?.code ?? null });
    }
    notifyProviderLoginsChanged();
    return await jobs.status("antigravity");
  }

  /** The Keychain part of a provider's status, on a Mac only, and the key the last Allow wrote while it is in the account. */
  function keychainStatus(
    provider: ProviderLoginProvider,
    off: ProviderLoginCaptureOffReason | null,
    vault: ProviderLoginVault | null,
  ): { part: NonNullable<ProviderLoginProviderStatus["keychain"]>; key: string | null } | null {
    if (provider !== "antigravity" || platform !== "darwin" || deps.cloudComputer || deps.staticOff) return null;
    const accountUserId = deps.accountUserId();
    const allowed = accountUserId ? loadState(accountUserId).keychain?.antigravity ?? null : null;
    const stillThere = Boolean(allowed && vault?.list(ACCOUNT_SCOPE_ALL).some((row) =>
      row.kind === PROVIDER_LOGIN_VAULT_KIND && row.key === allowed.key && !row.deleted));
    const allowedAt = allowed && stillThere ? new Date(allowed.allowedAt) : null;
    return {
      part: {
        canAllow: !off,
        allowedAt: allowedAt ? allowedAt.toISOString() : null,
        message: allowedAt
          ? `Copied from this Mac on ${allowedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}. Allow again to update.`
          : "On a Mac this sign-in is in the Keychain. Allow ADE to copy it once; macOS asks you first.",
      },
      key: allowedAt ? allowed!.key : null,
    };
  }

  /**
   * The person's switch for Copilot's GitHub CLI login on this computer (G1).
   * Off at the start, and again after a sign-out of ADE (the choice is in the
   * per-account marks file).
   *
   * - ON: the choice is kept, and the one read runs at once (it can show a
   *   keychain or keyring prompt on this computer). With capture on, it is a
   *   pass for Copilot, so the login goes into the account now. With the off
   *   switch for all (or a vault that has not synced yet), only the read runs;
   *   nothing leaves this computer until capture is on. ON again reads again.
   * - OFF: no read from now on, and this computer's copy leaves the account
   *   (each cloud computer drops it at its next pass). If the vault cannot
   *   take the removal now, the absence rule removes it at a later pass.
   *
   * Never on a cloud computer. The status says what happened.
   */
  async function allowGitHubCli(args: { on: boolean }): Promise<ProviderLoginStatus> {
    if (typeof args?.on !== "boolean") throw new Error("Say whether to turn it on or off.");
    if (deps.cloudComputer) throw new Error("A cloud computer does not copy a GitHub CLI login. Turn this on on your own computer.");
    if (deps.staticOff) throw new Error(OFF_MESSAGES[deps.staticOff]);
    const accountUserId = deps.accountUserId();
    if (!accountUserId) throw new Error(OFF_MESSAGES.signed_out);
    const off = args.on ? await captureOffReason() : null;
    if (off && !GH_ALLOW_WHILE_OFF.has(off)) throw new Error(OFF_MESSAGES[off]);
    // Behind the pass in flight, so the marks file has one writer.
    while (s.inFlight) await s.inFlight.catch(() => undefined);
    const state = loadState(accountUserId);
    // Either way the next read starts over: ON reads again, OFF reads nothing.
    s.ghMemo = null;
    bundleMemos.delete(GH_BUNDLE_ID);
    if (args.on) {
      state.ghCli = { allowedAt: state.ghCli?.allowedAt ?? now() };
      saveState(state);
      deps.logger.info("provider_login.gh_allowed", { on: true });
      s.ghForce = true;
      try {
        if (!off) await jobs.pass(["copilot"]);
        else await readGhWithoutCapture(state);
      } finally {
        s.ghForce = false;
      }
      notifyProviderLoginsChanged();
      return await jobs.status("copilot");
    }
    delete state.ghCli;
    delete state.bundles[GH_BUNDLE_ID];
    localStates.delete("copilot");
    deps.logger.info("provider_login.gh_allowed", { on: false });
    const machine = deps.machine();
    const vault = deps.vault();
    let removed: string | null = null;
    if (machine) {
      const key = providerLoginKey("copilot", originId(machine.machineKey), "gh");
      if (vault && liveSignInKeys(vault).has(key) && vault.remove(ACCOUNT_SCOPE_ALL, PROVIDER_LOGIN_VAULT_KIND, key)) {
        removed = key;
        deps.logger.info("provider_login.removed", { provider: "copilot", slot: "gh", reason: "gh_cli_off" });
      }
      // Removed now, or never pushed: forget it. Otherwise the absence rule takes it at a later pass.
      if (removed || !vault || !liveSignInKeys(vault).has(key)) delete state.pushed[key];
      if (state.writtenBack?.[key]) delete state.writtenBack[key];
    }
    saveState(state);
    if (removed) {
      try {
        // The normal remove path: the setting drops its entries for that key.
        return await jobs.saveSetting(cloudSetting(), removed);
      } catch (error) {
        // Capture is off for a reason that keeps the setting; the item is gone anyway.
        deps.logger.warn("provider_login.setting_prune_failed", { provider: "copilot", name: error instanceof Error ? error.name : "unknown" });
      }
    }
    notifyProviderLoginsChanged();
    return await jobs.status("copilot");
  }

  /** ON while capture is off for all (or the vault is not ready): the one read, so the status says what it found; no push. */
  async function readGhWithoutCapture(state: ProviderLoginStateFile): Promise<void> {
    const bundle = copilotGhBundle(ctx);
    const marks = await jobs.statBundle(bundle);
    if (marks === "unreadable") return;
    const contents = "missing" in marks[0]! ? new Map<string, Buffer>() : await jobs.stableRead(bundle, marks);
    // Just changed, or not readable now: the next pass reads it.
    if (!contents || contents === "unreadable") return;
    await jobs.ghTokenStep(contents, JSON.stringify(marks), state);
    saveState(state);
  }

  /**
   * This computer's GitHub CLI login for Copilot (G1), on a person's own
   * computer only. `present` and `user` are from hosts.yml (a file read, no
   * process, no keychain); the rest is the person's choice and the last read.
   */
  let lastGhHostsReadCode: string | null = null;

  async function ghCliStatus(off: ProviderLoginCaptureOffReason | null): Promise<ProviderLoginGhCliStatus | null> {
    if (deps.cloudComputer || deps.staticOff) return null;
    const accountUserId = deps.accountUserId();
    const choice = accountUserId ? loadState(accountUserId).ghCli ?? null : null;
    const hostsPath = copilotGhHostsPath(ctx);
    let raw: string | null = null;
    let readFailed = false;
    try {
      raw = await fs.promises.readFile(hostsPath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code ?? null;
      // No hosts.yml: gh is not signed in here. Any other error is not "signed out".
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        readFailed = true;
        // Once per error, not on every status read.
        if (code !== lastGhHostsReadCode) deps.logger.warn("provider_login.gh_hosts_read_failed", { code });
        lastGhHostsReadCode = code;
      }
    }
    if (!readFailed) lastGhHostsReadCode = null;
    const host = readGhHostsGithubCom(raw);
    const read = choice?.read ?? null;
    const failed = read && (read.result === "not_installed" || read.result === "timeout" || read.result === "failed") ? read.result : null;
    return {
      present: Boolean(host.user || host.token),
      user: host.user,
      allowed: Boolean(choice),
      canAllow: Boolean(accountUserId) && (!off || GH_ALLOW_WHILE_OFF.has(off)),
      ...(choice && read?.result === "classic_token" ? { unsupported: "classic_token" as const } : {}),
      ...(readFailed
        ? { readFailed: true, lastError: "ADE couldn't read the GitHub CLI login file on this computer." }
        : choice && failed ? { lastError: GH_READ_MESSAGES[failed] } : {}),
      ...(choice && read ? { lastReadAt: new Date(read.at).toISOString() } : {}),
    };
  }

  function ghCliMessage(gh: ProviderLoginGhCliStatus, off: ProviderLoginCaptureOffReason | null, fallback: string): string {
    // An unreadable hosts.yml is not "not signed in".
    if (gh.readFailed && gh.lastError) return gh.lastError;
    if (!gh.allowed) {
      return gh.present
        ? "Off on this computer. Turn it on to copy this computer's GitHub CLI login for Copilot on ADE Cloud."
        : "The GitHub CLI on this computer is not signed in to github.com. Run `gh auth login`, then turn this on.";
    }
    if (gh.unsupported === "classic_token") return "This GitHub CLI login uses a classic token (ghp_). Copilot does not take it, so ADE does not copy it.";
    if (gh.lastError) return gh.lastError;
    if (off === "all_off") return "On for this computer. Nothing leaves this computer while sign-ins for ADE Cloud are switched off.";
    return fallback;
  }

  return { allowKeychain, allowGitHubCli, keychainStatus, ghCliStatus, ghCliMessage };
}
