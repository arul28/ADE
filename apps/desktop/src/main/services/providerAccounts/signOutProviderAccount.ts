import { execFile } from "node:child_process";
import { getMachineProviderInstanceStore } from "../../../../../ade-cli/src/services/providerInstances/providerInstanceStore";
import { isBaseProviderInstance, type ProviderInstance } from "../../../shared/types/providerInstances";
import { invalidateCachedClaudeCredentials } from "../ai/providerCredentialSources";
import { userProcessEnv } from "../shared/hostRuntimeEnv";
import { resolveCliSpawnInvocation } from "../shared/processExecution";
import { refreshProviderAccounts } from "./refreshProviderAccounts";

const SIGN_OUT_TIMEOUT_MS = 30_000;

/**
 * Signs one provider account out with the provider CLI's own command
 * (`claude auth logout`, `codex logout`) in that account's config home, then
 * re-reads the account so every list shows it signed out.
 *
 * The CLI owns the saved login (a file, or a macOS Keychain item named after
 * the config home), so it is the one that clears it. The account card stays:
 * **Sign in** puts a login back, and **Remove** drops the card.
 */
export async function signOutProviderAccount(
  id: string,
  usage: { forceRefresh: () => Promise<unknown> } | null | undefined,
): Promise<ProviderInstance | null> {
  const store = getMachineProviderInstanceStore();
  const command = store.logoutCommand(id);
  const instance = store.get(id);
  const env: NodeJS.ProcessEnv = { ...userProcessEnv(), ...command.env };
  const invocation = resolveCliSpawnInvocation(command.command, command.args, env);
  await new Promise<void>((resolve, reject) => {
    execFile(
      invocation.command,
      invocation.args,
      {
        env,
        timeout: SIGN_OUT_TIMEOUT_MS,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      },
      (error, _stdout, stderr) => {
        if (!error) return resolve();
        const detail = String(stderr ?? "").trim().split("\n").pop()?.trim();
        reject(new Error(detail ? `Sign-out failed: ${detail}` : "Sign-out failed."));
      },
    );
  });
  if (instance?.provider === "claude") {
    invalidateCachedClaudeCredentials(isBaseProviderInstance(instance) ? undefined : instance.configHome);
  }
  await refreshProviderAccounts({ provider: instance?.provider, instanceId: id }, usage);
  return store.get(id);
}
