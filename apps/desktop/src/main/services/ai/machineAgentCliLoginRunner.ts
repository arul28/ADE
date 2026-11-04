import { userProcessEnv } from "../shared/hostRuntimeEnv";
import { spawnLoginPty, stopLoginPty } from "../shared/cliLoginPty";
import { pinnedLoginCliState } from "../pty/pinnedProviderCli";
import { invalidateCliAuthStatusCache, readAgentCliSavedLogin } from "./authDetector";
import { createAgentCliLoginRunner, type AgentCliLoginRunner } from "./agentCliLoginRunner";

let runner: AgentCliLoginRunner | null = null;

/**
 * The one agent CLI sign-in runner for this machine, shared by the local IPC
 * handlers and the `ai.cliLogin*` actions a pinned Settings page calls, so a
 * sign-in started through one is readable through the other.
 */
export function getMachineAgentCliLoginRunner(): AgentCliLoginRunner {
  if (runner) return runner;
  runner = createAgentCliLoginRunner({
    resolveCli: pinnedLoginCliState,
    baseEnv: () => userProcessEnv(),
    spawnPty: spawnLoginPty,
    stopPty: stopLoginPty,
    readSavedLogin: readAgentCliSavedLogin,
    // Settings reads the provider's signed-in state through detection's cache.
    onSignedIn: () => invalidateCliAuthStatusCache(),
  });
  // A sign-in still open when the process ends would leave its CLI running.
  // The desktop app and the headless runtime both exit through here.
  const created = runner;
  process.once("exit", () => created.disposeAll());
  return runner;
}
