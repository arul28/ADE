/**
 * The brain's side of "Sign-ins for your cloud machines": which sign-ins the
 * account keeps, saving and removing a pasted key, and Claude's sign-in, which
 * runs here (cloudClaudeSignIn.ts). The desktop's Settings card reaches
 * these through `cloud.cloud_sign_in_*` on this computer's brain; they are
 * the person's alone (actionPolicy.ts), so no agent saves a key or starts a
 * sign-in. Account-wide, so nothing here takes a pin: every computer of the
 * account reads the same vault.
 *
 * Claude keeps one pass per Claude account (claudePassStore.ts). A start
 * names the account the person pressed; ADE checks the new pass against it
 * before it saves (claudePassVerify.ts), and `cloud_sign_in_keep` saves a
 * pass the check found to be for another account.
 *
 * No result carries a token or a key.
 */

import {
  cloudSignInSpec,
  type CloudClaudeLocalAccount,
  type CloudSignInId,
  type CloudSignInStatus,
} from "../../../shared/cloudSignIns";
import { AdeExpectedError } from "../../../shared/expectedError";
import { getMachineProviderInstanceStore } from "../../../../../ade-cli/src/services/providerInstances/providerInstanceStore";
import type { UsageSnapshot } from "../../../shared/types/usage";
import { claudePassAccountUse } from "../claudePass/claudePassUse";
import { pinnedLoginCliState } from "../pty/pinnedProviderCli";
import { spawnLoginPty, stopLoginPty } from "../shared/cliLoginPty";
import { userProcessEnv } from "../shared/hostRuntimeEnv";
import {
  createCloudClaudeSignIn,
  type ClaudePassSaveOutcome,
  type ClaudePassSaveResult,
  type ClaudeSignInStartOptions,
  type CloudClaudeSignIn,
} from "./cloudClaudeSignIn";
import {
  cleanCloudCloudKey,
  cloudSignInVaultKey,
  readCloudSignIns,
  removeCloudSignIn,
  saveCloudSignIn,
  type CloudSignInVaults,
} from "./cloudSignInStore";
import { isClaudePassKey } from "../../../shared/types/providerLogins";
import {
  localClaudePassMachine,
  readClaudePassSummaries,
  removeAllClaudePasses,
  saveClaudePass,
  uploadClaudePass,
  type ClaudePassMachineStamp,
  type ClaudePassVault,
} from "./claudePassStore";
import { verifyClaudePass, type ClaudePassVerifyResult } from "./claudePassVerify";

type Logger = {
  info?(event: string, meta?: Record<string, unknown>): void;
  warn?(event: string, meta?: Record<string, unknown>): void;
} | null | undefined;

const SIGNED_OUT = "Sign in to ADE on this computer first: ADE keeps your sign-ins in your account.";

type ClaudeVerify = (token: string, options: { signal: AbortSignal }) => Promise<ClaudePassVerifyResult>;

let machineClaudeSignIn: CloudClaudeSignIn | null = null;

/**
 * The one Claude sign-in of this machine. Every project scope of the brain
 * reaches the same one, so a sign-in started through one is read through any.
 */
function claudeSignIn(logger: Logger, verify: ClaudeVerify): CloudClaudeSignIn {
  if (machineClaudeSignIn) return machineClaudeSignIn;
  const created = createCloudClaudeSignIn({
    resolveCli: () => pinnedLoginCliState("claude"),
    baseEnv: () => userProcessEnv(),
    spawnPty: spawnLoginPty,
    stopPty: stopLoginPty,
    verify,
    logger,
  });
  machineClaudeSignIn = created;
  // A sign-in still open when the brain ends would leave Claude Code running.
  process.once("exit", () => created.dispose({ sync: true }));
  return created;
}

function signInId(args: unknown): CloudSignInId {
  const raw = args && typeof args === "object" ? (args as { id?: unknown }).id : undefined;
  const spec = typeof raw === "string" ? cloudSignInSpec(raw) : null;
  if (!spec) throw new AdeExpectedError(`Unknown cloud sign-in ${JSON.stringify(raw)}.`, "user");
  return spec.id;
}

function optionalEmail(args: unknown, field: "forEmail" | "labelEmail"): string | null {
  const raw = args && typeof args === "object" ? (args as Record<string, unknown>)[field] : undefined;
  if (raw == null || raw === "") return null;
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text.includes("@") || text.length > 320 || /\s/.test(text)) {
    throw new AdeExpectedError("That is not an email address.", "user");
  }
  return text;
}

function optionalPassKey(args: unknown): string | null {
  const raw = args && typeof args === "object" ? (args as { renewKey?: unknown }).renewKey : undefined;
  if (raw == null || raw === "") return null;
  if (!isClaudePassKey(raw)) throw new AdeExpectedError("ADE doesn't know that Claude pass.", "user");
  return raw;
}

/** The shown usage of this computer's usage service, when it runs here. No poll, no request. */
async function machineUsageSnapshot(): Promise<Pick<UsageSnapshot, "windows" | "accounts"> | null> {
  const [{ peekSharedUsageTrackingService }, { resolveMachineAdeLayout }] = await Promise.all([
    import("../usage/sharedUsageTracking"),
    import("../../../../../ade-cli/src/services/projects/machineLayout"),
  ]);
  return peekSharedUsageTrackingService(resolveMachineAdeLayout().adeDir)?.getUsageSnapshot() ?? null;
}

/** The signed-in Claude accounts of this computer with an email; copies of another account are left out. */
function machineClaudeAccounts(): CloudClaudeLocalAccount[] {
  try {
    return getMachineProviderInstanceStore().list("claude")
      .filter((instance) => instance.signedIn && !instance.sameLoginAs && instance.account?.email?.includes("@"))
      .map((instance) => ({ instanceId: instance.id, email: instance.account!.email!.trim(), isDefault: instance.isDefault }));
  } catch {
    return [];
  }
}

export function buildCloudSignInActions(deps: {
  /** This runtime's account vault, one item per key; null when signed out. */
  vaults: () => CloudSignInVaults | null;
  /** The ADE account signed in now, or null. */
  accountId: () => string | null;
  /** One sign-in was saved: Claude's once its token is kept, a key at once. */
  onSaved?: (id: CloudSignInId) => void;
  /**
   * The account vault's Claude passes; null when signed out. Without it (not
   * wired yet) a Claude sign-in keeps the single item of older versions.
   */
  passVault?: () => ClaudePassVault | null;
  /** This computer's signed-in Claude accounts, for the account list. */
  localAccounts?: () => CloudClaudeLocalAccount[];
  /** This computer as a pass records it. */
  machine?: () => Promise<ClaudePassMachineStamp | null>;
  /** Which account a pass is for (claudePassVerify.ts). */
  verify?: ClaudeVerify;
  /** This computer's shown usage (memory only), for the use of each pass. */
  usageSnapshot?: () => Promise<Pick<UsageSnapshot, "windows" | "accounts"> | null>;
  logger?: Logger;
}) {
  const localAccounts = deps.localAccounts ?? machineClaudeAccounts;
  const usageSnapshot = deps.usageSnapshot ?? machineUsageSnapshot;
  const machine = deps.machine ?? localClaudePassMachine;
  const verify: ClaudeVerify = deps.verify ?? ((token, options) => verifyClaudePass(token, { signal: options.signal, logger: deps.logger }));
  const signIn = () => claudeSignIn(deps.logger, verify);

  const save = async (vaults: CloudSignInVaults, id: CloudSignInId, token: string): Promise<boolean> => {
    const ok = await saveCloudSignIn(vaults, id, token, deps.logger);
    if (ok) deps.onSaved?.(id);
    return ok;
  };

  const requireVaults = (): CloudSignInVaults => {
    const vaults = deps.vaults();
    if (!vaults) throw new AdeExpectedError(SIGNED_OUT, "user");
    return vaults;
  };

  /** The single Claude item of older versions, raw; null when absent or unreadable. */
  const readLegacyClaude = async (vaults: CloudSignInVaults | null): Promise<string | null> => {
    const vault = vaults?.(cloudSignInVaultKey("claude"));
    if (!vault) return null;
    try {
      const read = await vault.get();
      return read.ok ? read.value : null;
    } catch {
      return null;
    }
  };

  const readPasses = async (
    vaults: CloudSignInVaults | null,
    accounts: readonly CloudClaudeLocalAccount[],
  ): Promise<CloudSignInStatus["passes"]> => {
    const passVault = deps.passVault?.() ?? null;
    if (!passVault) return null;
    try {
      return readClaudePassSummaries(passVault, await readLegacyClaude(vaults), accounts);
    } catch (error) {
      deps.logger?.warn?.("claude_pass.read_failed", { reason: error instanceof Error ? error.name : "unknown" });
      return null;
    }
  };

  const status = async (): Promise<CloudSignInStatus> => {
    const vaults = deps.vaults();
    let accounts: CloudClaudeLocalAccount[] = [];
    try {
      accounts = localAccounts();
    } catch {
      // No account list; the sign-in still runs with "Another account".
    }
    const [saved, readPassList, usage] = await Promise.all([
      readCloudSignIns(vaults, deps.logger),
      readPasses(vaults, accounts),
      usageSnapshot().catch(() => null),
    ]);
    // Claude's limits belong to the account: a pass shows those of the account
    // with the same verified email that this computer tracks.
    const nowMs = Date.now();
    const passes = readPassList?.map((pass) => (pass.unreadable ? pass : { ...pass, use: claudePassAccountUse(pass, usage, nowMs) })) ?? null;
    let claude = signIn().state();
    // A pass kept only here that has reached the account since: signed in now.
    if (claude?.state === "saved_here" && claude.savedKey) {
      const saved = passes?.find((pass) => pass.key === claude!.savedKey);
      const upload = saved && !saved.unreadable ? saved.upload : undefined;
      if (upload === "account") claude = { ...claude, state: "succeeded", message: null, upload };
      else if (upload) claude = { ...claude, upload };
    }
    return { ...saved, claude, localAccounts: accounts, passes };
  };

  /**
   * Keeps one Claude pass. With the pass vault: the pass of its account, and
   * the single item of older versions as well, which new cloud computers and
   * older desktops still read until launch uses passes (P6 step 2).
   *
   * The vault writes here first. The save then sends the pass to the account
   * and waits up to 15 s: a pass that did not arrive (an older server refuses
   * the kind, or no network) ends as `saved_here`, never as signed in, and
   * stays queued on this computer.
   */
  const savePass = async (
    vaults: CloudSignInVaults,
    token: string,
    outcome: ClaudePassSaveOutcome,
    renewKey: string | null,
    accountId: string | null,
  ): Promise<ClaudePassSaveResult> => {
    const passVault = deps.passVault?.() ?? null;
    if (!passVault) return await save(vaults, "claude", token);
    const key = saveClaudePass(passVault, {
      token,
      email: outcome.email,
      check: outcome.check,
      labelSource: outcome.labelSource,
      renewKey,
      madeOn: await machine().catch(() => null),
      ...(accountId ? { expectedAccountUserId: accountId } : {}),
    }, deps.logger);
    if (!key) return false;
    if (!(await saveCloudSignIn(vaults, "claude", token, deps.logger))) {
      deps.logger?.warn?.("claude_pass.legacy_mirror_failed", { key });
    }
    const upload = await uploadClaudePass(passVault, key, { logger: deps.logger });
    deps.onSaved?.("claude");
    return { key, upload };
  };

  return {
    cloud_sign_in_status: async () => await status(),

    /**
     * Starts Claude's approve. `forEmail`: the account the person pressed
     * (none for "Another account"); `renewKey`: the pass a Renew replaces;
     * `labelEmail`: an email the person typed (kept only when the check
     * names none and nothing was pressed).
     */
    cloud_sign_in_start: async (args?: unknown) => {
      const vaults = requireVaults();
      const renewKey = optionalPassKey(args);
      // A Renew names a pass of THIS account, never a key a window made up.
      if (renewKey && !(await readPasses(vaults, []))?.some((pass) => pass.key === renewKey)) {
        throw new AdeExpectedError("ADE doesn't know that Claude pass.", "user");
      }
      const options: ClaudeSignInStartOptions = {
        forEmail: optionalEmail(args, "forEmail"),
        renewKey,
        labelEmail: optionalEmail(args, "labelEmail"),
        // Only a pass with an account label needs the check; the single item has none.
        check: Boolean(deps.passVault?.()),
      };
      // A token made for one account never goes into another's vault: the
      // person may switch accounts while the browser step is open.
      const startedFor = deps.accountId();
      signIn().start(async (token, outcome) => {
        if (deps.accountId() !== startedFor) {
          deps.logger?.warn?.("cloud.claude_token_dropped", { reason: "account_changed" });
          return false;
        }
        return await savePass(vaults, token, outcome, options.renewKey ?? null, startedFor);
      }, options);
      return await status();
    },

    cloud_sign_in_code: async (args: unknown) => {
      const code = args && typeof args === "object" ? (args as { code?: unknown }).code : undefined;
      if (typeof code !== "string" || !code.trim()) throw new AdeExpectedError("Paste the code the browser shows.", "user");
      signIn().submitCode(code);
      return await status();
    },

    /** Keeps a pass the check found to be for another account than the pressed one. */
    cloud_sign_in_keep: async () => {
      requireVaults();
      signIn().keep();
      return await status();
    },

    cloud_sign_in_cancel: async () => {
      await signIn().cancel();
      return await status();
    },

    cloud_sign_in_save_key: async (args: unknown) => {
      const id = signInId(args);
      const spec = cloudSignInSpec(id);
      if (spec?.method !== "key") throw new AdeExpectedError("Claude signs in with its own sign-in, not a pasted key.", "user");
      const cleaned = cleanCloudCloudKey(args && typeof args === "object" ? (args as { key?: unknown }).key : undefined);
      if (!cleaned.ok) throw new AdeExpectedError(cleaned.message, "user");
      if (!(await save(requireVaults(), id, cleaned.key))) {
        throw new Error(`ADE couldn't save your ${spec.keyName} to your account. Try again.`);
      }
      deps.logger?.info?.("cloud.cloud_key_saved", { id });
      return await status();
    },

    /**
     * Forgets one sign-in; for Claude, every pass. Machines made with it keep
     * it until they are deleted.
     */
    cloud_sign_in_remove: async (args: unknown) => {
      const id = signInId(args);
      const vaults = requireVaults();
      // A running Claude sign-in would save a token right after this removal.
      if (id === "claude") await signIn().cancel();
      const passVault = id === "claude" ? deps.passVault?.() ?? null : null;
      const passesRemoved = passVault ? removeAllClaudePasses(passVault, deps.logger) : true;
      if (!(await removeCloudSignIn(vaults, id, deps.logger)) || !passesRemoved) {
        throw new Error("ADE couldn't remove it from your account. Try again.");
      }
      deps.logger?.info?.("cloud.cloud_sign_in_removed", { id });
      return await status();
    },
  };
}
