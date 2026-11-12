/**
 * A provider sign-in on this computer that a person finishes on another
 * screen (C8): `ade providers sign-in <provider> --remote`, which ADE's server
 * runs over exec when the phone or the web asks. It starts the provider's own
 * sign-in in this brain, with the login runners the Settings sheet uses (they
 * outlive the short command), and answers with the link and code the CLI
 * printed. A pasted code goes to the runner's `submitCode` (`writeLoginCode`).
 *
 * Which provider can do this is the shared table (`CLOUD_REMOTE_SIGN_IN`); a
 * `none` row is refused with its reason. ADE never signs a provider in for
 * the person: the person opens the link and approves it themselves.
 */

import {
  cloudRemoteSignInRefusal,
  cloudRemoteSignInOf,
  type CloudRemoteSignInState,
  type CloudRemoteSignInStatus,
} from "../../../../account-directory/src/cloud/contract";
import {
  isAgentCliLoginProvider,
  type AgentCliLoginStartArgs,
} from "../../../../desktop/src/shared/types/agentCliLogin";
import type { ProviderLoginState } from "../../../../desktop/src/shared/types/providerInstances";

/** The slice of a login runner's status this needs (the provider account runner and the agent CLI runner share it). */
type RunnerStatus = {
  loginId: string;
  state: ProviderLoginState;
  url: string | null;
  deviceCode?: string;
  awaitingCode: boolean;
  message?: string;
};

type Runner = {
  status: (loginId: string) => RunnerStatus;
  submitCode: (loginId: string, code: string) => RunnerStatus;
};

export type RemoteProviderSignInDeps = {
  /** Claude Code and Codex accounts: their account's id is needed (the default one). */
  providerAccounts: () => Promise<Runner & { start: (instanceId: string, options: { deviceAuth: boolean }) => RunnerStatus }>;
  defaultInstanceId: (provider: "codex") => Promise<string>;
  /** The agent CLIs with their own sign-in (Grok, Devin, Muse, Copilot, Droid, Kimi). */
  agentClis: () => Promise<Runner & { start: (args: AgentCliLoginStartArgs) => Promise<RunnerStatus> }>;
  sleep?: (ms: number) => Promise<void>;
};

/** How long a start waits for the CLI to print its link before it answers anyway (the status read shows it later). */
const FIRST_LINK_WAIT_MS = 9_000;
const FIRST_LINK_POLL_MS = 250;

const PROVIDER_ACCOUNT = "p_";
const AGENT_CLI = "c_";

/** A runner's state as the phone and the web read it. */
const ANSWER_STATE: Record<ProviderLoginState, CloudRemoteSignInState> = {
  running: "pending",
  verifying: "pending",
  succeeded: "done",
  failed: "failed",
  cancelled: "failed",
};

function answerOf(jobId: string, status: RunnerStatus): CloudRemoteSignInStatus {
  const state = ANSWER_STATE[status.state] ?? "pending";
  return {
    jobId,
    state,
    url: status.url,
    userCode: status.deviceCode ?? null,
    needsPastedCode: status.awaitingCode,
    reason: state === "failed" ? status.message ?? (status.state === "cancelled" ? "The sign-in was stopped." : "The sign-in didn't finish.") : null,
  };
}

export function createRemoteProviderSignIn(deps: RemoteProviderSignInDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const runnerOf = async (jobId: string): Promise<{ runner: Runner; loginId: string }> => {
    const trimmed = jobId.trim();
    if (trimmed.startsWith(PROVIDER_ACCOUNT)) return { runner: await deps.providerAccounts(), loginId: trimmed.slice(PROVIDER_ACCOUNT.length) };
    if (trimmed.startsWith(AGENT_CLI)) return { runner: await deps.agentClis(), loginId: trimmed.slice(AGENT_CLI.length) };
    throw new Error("That sign-in is no longer running. Start it again.");
  };

  return {
    async start(provider: string): Promise<CloudRemoteSignInStatus> {
      const row = cloudRemoteSignInOf(provider);
      if (!row) throw new Error(`ADE doesn't know the provider "${provider}".`);
      if (row.remoteSignIn === "none") throw new Error(cloudRemoteSignInRefusal(row));
      let jobId: string;
      let runner: Runner;
      let status: RunnerStatus;
      if (row.provider === "codex") {
        const accounts = await deps.providerAccounts();
        // The browser is on another screen: Codex signs in with a device code.
        status = accounts.start(await deps.defaultInstanceId("codex"), { deviceAuth: true });
        runner = accounts;
        jobId = `${PROVIDER_ACCOUNT}${status.loginId}`;
      } else {
        if (!isAgentCliLoginProvider(row.provider)) throw new Error(`ADE can't run ${row.label}'s sign-in for another screen.`);
        const clis = await deps.agentClis();
        status = await clis.start({ provider: row.provider });
        runner = clis;
        jobId = `${AGENT_CLI}${status.loginId}`;
      }
      // Answer within the server's short exec: once the link (and a code, for a device flow) is out.
      const until = Date.now() + FIRST_LINK_WAIT_MS;
      while (status.state === "running" && !(status.url && (row.remoteSignIn !== "device" || status.deviceCode)) && Date.now() < until) {
        await sleep(FIRST_LINK_POLL_MS);
        status = runner.status(status.loginId);
      }
      return answerOf(jobId, status);
    },

    async status(jobId: string): Promise<CloudRemoteSignInStatus> {
      const { runner, loginId } = await runnerOf(jobId);
      return answerOf(jobId, runner.status(loginId));
    },

    async submitCode(jobId: string, code: string): Promise<CloudRemoteSignInStatus> {
      const { runner, loginId } = await runnerOf(jobId);
      const trimmed = code.trim();
      if (!trimmed) throw new Error("Paste the code the sign-in page showed.");
      return answerOf(jobId, runner.submitCode(loginId, trimmed));
    },
  };
}

export type RemoteProviderSignIn = ReturnType<typeof createRemoteProviderSignIn>;
