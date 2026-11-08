/**
 * The brain's side of "Sign-ins for your cloud machines": which sign-ins the
 * account keeps, saving and removing a pasted key, and Claude's sign-in, which
 * runs here (cloudClaudeSignIn.ts). The desktop's Settings card reaches
 * these through `cloud.cloud_sign_in_*` on this computer's brain; they are
 * the person's alone (actionPolicy.ts), so no agent saves a key or starts a
 * sign-in. Account-wide, so nothing here takes a pin: every computer of the
 * account reads the same vault.
 *
 * No result carries a token or a key.
 */

import {
  cloudSignInSpec,
  type CloudSignInId,
  type CloudSignInStatus,
} from "../../../shared/cloudSignIns";
import { AdeExpectedError } from "../../../shared/expectedError";
import { pinnedLoginCliState } from "../pty/pinnedProviderCli";
import { spawnLoginPty, stopLoginPty } from "../shared/cliLoginPty";
import { userProcessEnv } from "../shared/hostRuntimeEnv";
import { createCloudClaudeSignIn, type CloudClaudeSignIn } from "./cloudClaudeSignIn";
import {
  cleanCloudCloudKey,
  readCloudSignIns,
  removeCloudSignIn,
  saveCloudSignIn,
  type CloudSignInVaults,
} from "./cloudSignInStore";

type Logger = {
  info?(event: string, meta?: Record<string, unknown>): void;
  warn?(event: string, meta?: Record<string, unknown>): void;
} | null | undefined;

const SIGNED_OUT = "Sign in to ADE on this computer first: ADE keeps your sign-ins in your account.";

let machineClaudeSignIn: CloudClaudeSignIn | null = null;

/**
 * The one Claude sign-in of this machine. Every project scope of the brain
 * reaches the same one, so a sign-in started through one is read through any.
 */
function claudeSignIn(logger: Logger): CloudClaudeSignIn {
  if (machineClaudeSignIn) return machineClaudeSignIn;
  const created = createCloudClaudeSignIn({
    resolveCli: () => pinnedLoginCliState("claude"),
    baseEnv: () => userProcessEnv(),
    spawnPty: spawnLoginPty,
    stopPty: stopLoginPty,
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

export function buildCloudSignInActions(deps: {
  /** This runtime's account vault, one item per key; null when signed out. */
  vaults: () => CloudSignInVaults | null;
  /** The ADE account signed in now, or null. */
  accountId: () => string | null;
  /** One sign-in was saved: Claude's once its token is kept, a key at once. */
  onSaved?: (id: CloudSignInId) => void;
  logger?: Logger;
}) {
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

  const status = async (): Promise<CloudSignInStatus> => {
    const saved = await readCloudSignIns(deps.vaults(), deps.logger);
    return { ...saved, claude: claudeSignIn(deps.logger).state() };
  };

  return {
    cloud_sign_in_status: async () => await status(),

    cloud_sign_in_start: async () => {
      const vaults = requireVaults();
      // A token made for one account never goes into another's vault: the
      // person may switch accounts while the browser step is open.
      const startedFor = deps.accountId();
      claudeSignIn(deps.logger).start(async (token) => {
        if (deps.accountId() !== startedFor) {
          deps.logger?.warn?.("cloud.claude_token_dropped", { reason: "account_changed" });
          return false;
        }
        return await save(vaults, "claude", token);
      });
      return await status();
    },

    cloud_sign_in_code: async (args: unknown) => {
      const code = args && typeof args === "object" ? (args as { code?: unknown }).code : undefined;
      if (typeof code !== "string" || !code.trim()) throw new AdeExpectedError("Paste the code the browser shows.", "user");
      claudeSignIn(deps.logger).submitCode(code);
      return await status();
    },

    cloud_sign_in_cancel: async () => {
      await claudeSignIn(deps.logger).cancel();
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

    /** Forgets one sign-in. Machines made with it keep it until they are deleted. */
    cloud_sign_in_remove: async (args: unknown) => {
      const id = signInId(args);
      const vaults = requireVaults();
      // A running Claude sign-in would save a token right after this removal.
      if (id === "claude") await claudeSignIn(deps.logger).cancel();
      if (!(await removeCloudSignIn(vaults, id, deps.logger))) {
        throw new Error("ADE couldn't remove it from your account. Try again.");
      }
      deps.logger?.info?.("cloud.cloud_sign_in_removed", { id });
      return await status();
    },
  };
}
