import { execFile } from "node:child_process";
import os from "node:os";
import { getMachineProviderInstanceStore } from "../../../../../ade-cli/src/services/providerInstances/providerInstanceStore";
import {
  isBaseProviderInstance,
  type ProviderInstance,
  type ProviderInstanceLoginCommand,
  type ProviderInstanceRemoveResult,
} from "../../../shared/types/providerInstances";
import { invalidateCachedClaudeCredentials } from "../ai/providerCredentialSources";
import { userProcessEnv } from "../shared/hostRuntimeEnv";
import { killWindowsProcessTreeAsync, resolveCliSpawnInvocation } from "../shared/processExecution";
import { refreshProviderAccounts } from "./refreshProviderAccounts";

const SIGN_OUT_TIMEOUT_MS = 30_000;

type UsageRefresher = { forceRefresh: () => Promise<unknown> } | null | undefined;

/** Runs the provider CLI's logout for one account; rejects with a short sentence. */
async function runLogout(id: string): Promise<void> {
  await getMachineProviderInstanceStore().whileSigningOut(id, runLogoutCommand);
}

async function runLogoutCommand(command: ProviderInstanceLoginCommand): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...userProcessEnv(), ...command.env };
  const invocation = resolveCliSpawnInvocation(command.command, command.args, env);
  await new Promise<void>((resolve, reject) => {
    let timedOut = false;
    const child = execFile(
      invocation.command,
      invocation.args,
      // The home directory, like sign-in: a bare `claude` on Windows is
      // otherwise looked up in whatever directory ADE happens to run from.
      { env, cwd: os.homedir(), windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments },
      (error, _stdout, stderr) => {
        clearTimeout(timer);
        if (!error) return resolve();
        const detail = timedOut ? "it did not finish in 30 seconds" : String(stderr ?? "").trim().split("\n").pop()?.trim();
        reject(new Error(detail ? `Sign-out failed: ${detail}` : "Sign-out failed: the provider CLI could not run."));
      },
    );
    // On Windows the CLI runs under cmd.exe; killing only that leaves it running.
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) void killWindowsProcessTreeAsync(child.pid);
      else child.kill("SIGKILL");
    }, SIGN_OUT_TIMEOUT_MS);
  });
}

function forgetCachedLogin(instance: ProviderInstance | null): void {
  if (instance?.provider !== "claude") return;
  invalidateCachedClaudeCredentials(isBaseProviderInstance(instance) ? undefined : instance.configHome);
}

/**
 * Signs one provider account out with the provider CLI's own command
 * (`claude auth logout`, `codex logout`) in that account's config home, then
 * re-reads the account so every list shows it signed out.
 *
 * The CLI owns the saved login (a file, or a macOS Keychain item named after
 * the config home), so it is the one that clears it. The account card stays:
 * **Sign in** puts a login back, and **Remove** drops the card.
 */
export async function signOutProviderAccount(id: string, usage: UsageRefresher): Promise<ProviderInstance | null> {
  const store = getMachineProviderInstanceStore();
  const instance = store.get(id);
  await runLogout(id);
  forgetCachedLogin(instance);
  await refreshProviderAccounts({ provider: instance?.provider, instanceId: id }, usage);
  return store.get(id);
}

/**
 * Removes one provider account, signing it out first when it holds a login,
 * so adding it again starts from a fresh sign-in. Every surface (desktop, CLI,
 * phone, web) removes through here.
 *
 * A sign-out that fails does not block the removal: the card would otherwise
 * be stuck while its CLI is missing or hung. The result says so, and the login
 * stays in the config home, which removal never deletes.
 */
export async function removeProviderAccount(id: string): Promise<ProviderInstanceRemoveResult> {
  const store = getMachineProviderInstanceStore();
  const instance = store.get(id);
  let signOutError: string | undefined;
  // The store refuses the default and the machine's own login; neither is
  // signed out on the way to that refusal.
  if (instance && !instance.isDefault && !isBaseProviderInstance(instance) && (instance.signedIn || instance.loginBroken)) {
    try {
      await runLogout(id);
      forgetCachedLogin(instance);
    } catch (error) {
      signOutError = error instanceof Error ? error.message : String(error);
    }
  }
  const result = store.remove(id);
  return signOutError ? { ...result, signOutError } : result;
}
