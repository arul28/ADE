/**
 * A provider sign-in on this computer that a person finishes on another
 * screen (C8): `ade providers sign-in <provider> --remote`, which ADE's server
 * runs over exec when the phone or the web asks. It starts the provider's own
 * sign-in in this brain, with the login runners the Settings sheet uses (they
 * outlive the short command), and answers with the link and code the CLI
 * printed. A pasted code goes to the runner's `submitCode` (`writeLoginCode`).
 *
 * Which provider can do this is the shared table (`CLOUD_REMOTE_SIGN_IN`);
 * an `api_key` or `desktop` row is refused with its reason. ADE never signs a
 * provider in for the person: the person opens the link and approves it
 * themselves.
 *
 * Claude is `url_paste`: Claude Code's own `claude setup-token` (the cloud
 * Claude sign-in, `cloudClaudeSignIn.ts`). The person opens its link, pastes
 * the code back, and the pass it prints is saved to the account vault, so
 * every later cloud computer of the account starts signed in.
 */

import {
  CLOUD_SIGN_IN_CODE_REFUSED,
  cloudRemoteSignInRefusal,
  cloudRemoteSignInOf,
  cloudRemoteSignInRuns,
  type CloudRemoteSignInState,
  type CloudRemoteSignInStatus,
} from "../../../../account-directory/src/cloud/contract";
import {
  isAgentCliLoginProvider,
  type AgentCliLoginStartArgs,
} from "../../../../desktop/src/shared/types/agentCliLogin";
import type { CloudSignInStatus } from "../../../../desktop/src/shared/cloudSignIns";
import type { ProviderLoginState } from "../../../../desktop/src/shared/types/providerInstances";
import { BRAND } from "../../../../desktop/src/shared/brand";

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
  /** Stops a running sign-in. Left out: it runs to its own timeout. */
  cancel?: (loginId: string) => unknown;
};

export type RemoteProviderSignInDeps = {
  /** Claude Code and Codex accounts: their account's id is needed (the default one). */
  providerAccounts: () => Promise<Runner & { start: (instanceId: string, options: { deviceAuth: boolean; timeoutMs?: number }) => RunnerStatus }>;
  defaultInstanceId: (provider: "codex") => Promise<string>;
  /** The agent CLIs with their own sign-in (Grok, Devin, Muse, Copilot, Droid, Kimi). */
  agentClis: () => Promise<Runner & { start: (args: AgentCliLoginStartArgs) => Promise<RunnerStatus> }>;
  /**
   * Claude's pass sign-in on this machine (`cloud_sign_in_start`, `_code`,
   * `_status`): one at a time, saved to the account vault when it ends.
   * Left out, Claude is refused.
   */
  claudePass?: () => Promise<ClaudePassRunner>;
  sleep?: (ms: number) => Promise<void>;
};

/** How long a start waits for the CLI to print its link before it answers anyway (the status read shows it later). */
const FIRST_LINK_WAIT_MS = 9_000;
const FIRST_LINK_POLL_MS = 250;
/**
 * After a pasted code, how long the answer reads the sign-in for its verdict
 * (Claude Code refuses a wrong code in about 5 s), and how often: inside the
 * server's one short exec, so the person sees the verdict, not "sent".
 */
const VERDICT_WAIT_MS = 6_000;
const VERDICT_POLL_MS = 500;
/** The longest a remote start may ask its runner to live: a launch's whole sign-in wait. */
const MAX_REMOTE_TIMEOUT_MS = 30 * 60_000;

const PROVIDER_ACCOUNT = "p_";
const AGENT_CLI = "c_";
/** Claude's pass sign-in: one per machine, so its job id names no login. */
const CLAUDE_PASS = "k_claudepass";

/** The cloud Claude sign-in's actions; each answers its state, as `cloud_sign_in_status` reads it. */
export type ClaudePassRunner = {
  /** `timeoutMs`: how long `claude setup-token` may wait for the code (10 minutes when left out). */
  start: (options?: { timeoutMs?: number }) => Promise<CloudSignInStatus["claude"]>;
  status: () => Promise<CloudSignInStatus["claude"]>;
  submitCode: (code: string) => Promise<CloudSignInStatus["claude"]>;
  cancel?: () => Promise<unknown>;
};

/** The pass sign-in's state as the phone and the web read it: saved (here or in the account) is done. */
function claudeAnswerOf(status: CloudSignInStatus["claude"]): CloudRemoteSignInStatus {
  const state: CloudRemoteSignInState = !status ? "failed"
    : status.state === "succeeded" || status.state === "saved_here" ? "done"
      : status.state === "failed" || status.state === "cancelled" || status.state === "mismatch" ? "failed"
        : "pending";
  return {
    jobId: CLAUDE_PASS,
    state,
    url: status?.url ?? null,
    userCode: null,
    // The link ends in a code to paste: the box shows while Claude Code waits.
    needsPastedCode: state === "pending" && Boolean(status?.url),
    reason: state === "failed" ? status?.message ?? "The Claude sign-in didn't finish." : null,
  };
}

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

/** Whether the provider took a pasted code: Claude's pass is being checked or saved, or a runner verifies its login. */
function accepted(jobId: string, raw: CloudSignInStatus["claude"] | RunnerStatus | null): boolean {
  if (!raw) return false;
  if (jobId === CLAUDE_PASS) {
    const state = (raw as NonNullable<CloudSignInStatus["claude"]>).state;
    return state === "verifying" || state === "saving" || state === "mismatch";
  }
  return (raw as RunnerStatus).state === "verifying";
}

export function createRemoteProviderSignIn(deps: RemoteProviderSignInDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // A code pasted on a job's current link, until that link changes or ends: the
  // launch wait reads it so a refused code's restart says so (`codeSent`).
  const codeSentOn = new Map<string, string | null>();
  const withCodeSent = (answer: CloudRemoteSignInStatus): CloudRemoteSignInStatus => {
    const sentOn = codeSentOn.get(answer.jobId);
    if (sentOn === undefined) return answer;
    // A new link (a restart) is a new page: the code was for the old one.
    if (answer.state === "pending" && sentOn !== answer.url) {
      codeSentOn.delete(answer.jobId);
      return answer;
    }
    return { ...answer, codeSent: true };
  };
  const timeoutOf = (options?: { timeoutMs?: number }): number | undefined =>
    typeof options?.timeoutMs === "number" && options.timeoutMs > 0 ? Math.min(MAX_REMOTE_TIMEOUT_MS, Math.round(options.timeoutMs)) : undefined;

  const claude = async (): Promise<ClaudePassRunner> => {
    if (!deps.claudePass) throw new Error(`${BRAND.NAME} on this computer can't run Claude's sign-in for another screen. Update it, then try again.`);
    return await deps.claudePass();
  };

  const runnerOf = async (jobId: string): Promise<{ runner: Runner; loginId: string }> => {
    const trimmed = jobId.trim();
    if (trimmed.startsWith(PROVIDER_ACCOUNT)) return { runner: await deps.providerAccounts(), loginId: trimmed.slice(PROVIDER_ACCOUNT.length) };
    if (trimmed.startsWith(AGENT_CLI)) return { runner: await deps.agentClis(), loginId: trimmed.slice(AGENT_CLI.length) };
    throw new Error("That sign-in is no longer running. Start it again.");
  };

  return {
    async start(provider: string, options?: { timeoutMs?: number }): Promise<CloudRemoteSignInStatus> {
      const row = cloudRemoteSignInOf(provider);
      if (!row) throw new Error(`${BRAND.NAME} doesn't know the provider "${provider}".`);
      if (!cloudRemoteSignInRuns(row)) throw new Error(cloudRemoteSignInRefusal(row));
      const timeoutMs = timeoutOf(options);
      if (row.provider === "claude") {
        codeSentOn.delete(CLAUDE_PASS);
        const runner = await claude();
        let current = await runner.start(timeoutMs ? { timeoutMs } : undefined);
        // Answer within the server's short exec: once Claude Code printed its link.
        const until = Date.now() + FIRST_LINK_WAIT_MS;
        while (current?.state === "running" && !current.url && Date.now() < until) {
          await sleep(FIRST_LINK_POLL_MS);
          current = await runner.status();
        }
        return claudeAnswerOf(current);
      }
      let jobId: string;
      let runner: Runner;
      let status: RunnerStatus;
      if (row.provider === "codex") {
        const accounts = await deps.providerAccounts();
        // The browser is on another screen: Codex signs in with a device code.
        status = accounts.start(await deps.defaultInstanceId("codex"), { deviceAuth: true, ...(timeoutMs ? { timeoutMs } : {}) });
        runner = accounts;
        jobId = `${PROVIDER_ACCOUNT}${status.loginId}`;
      } else {
        if (!isAgentCliLoginProvider(row.provider)) throw new Error(`${BRAND.NAME} can't run ${row.label}'s sign-in for another screen.`);
        const clis = await deps.agentClis();
        status = await clis.start({ provider: row.provider, ...(timeoutMs ? { timeoutMs } : {}) });
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
      if (jobId.trim() === CLAUDE_PASS) return withCodeSent(claudeAnswerOf(await (await claude()).status()));
      const { runner, loginId } = await runnerOf(jobId);
      return withCodeSent(answerOf(jobId, runner.status(loginId)));
    },

    /**
     * Passes the code on, then reads the sign-in for its verdict for up to
     * `VERDICT_WAIT_MS`: refused (it failed, or its link changed: the launch
     * wait already started a new one), accepted (the provider took it and DAEX
     * finishes), done, or still pending.
     */
    async submitCode(jobId: string, code: string): Promise<CloudRemoteSignInStatus> {
      const trimmed = code.trim();
      if (!trimmed) throw new Error("Paste the code the sign-in page showed.");
      const id = jobId.trim();
      const read = id === CLAUDE_PASS
        ? async () => { const raw = await (await claude()).status(); return { raw, answer: claudeAnswerOf(raw) }; }
        : async () => { const { runner, loginId } = await runnerOf(id); const raw = runner.status(loginId); return { raw, answer: answerOf(id, raw) }; };
      const before = (await read()).answer;
      let answer: CloudRemoteSignInStatus;
      let raw: CloudSignInStatus["claude"] | RunnerStatus | null;
      if (id === CLAUDE_PASS) {
        raw = await (await claude()).submitCode(trimmed);
        answer = claudeAnswerOf(raw);
      } else {
        const { runner, loginId } = await runnerOf(id);
        raw = runner.submitCode(loginId, trimmed);
        answer = answerOf(id, raw);
      }
      codeSentOn.set(id, before.url);
      const until = Date.now() + VERDICT_WAIT_MS;
      for (;;) {
        if (answer.state === "done") return { ...answer, verdict: "accepted" };
        // A refusal, or a new link the wait already started after one: the code didn't work.
        if (answer.state === "failed" || (before.url && answer.url && answer.url !== before.url)) {
          return { ...answer, state: "failed", reason: CLOUD_SIGN_IN_CODE_REFUSED, verdict: "refused", codeSent: true };
        }
        if (accepted(id, raw)) return { ...answer, verdict: "accepted", codeSent: true };
        if (Date.now() >= until) return { ...answer, verdict: null, codeSent: true };
        await sleep(VERDICT_POLL_MS);
        ({ raw, answer } = await read());
      }
    },

    /** Stops a sign-in a launch's wait started (the wait ended). */
    async cancel(jobId: string): Promise<void> {
      const id = jobId.trim();
      codeSentOn.delete(id);
      if (id === CLAUDE_PASS) {
        await (await claude()).cancel?.();
        return;
      }
      const { runner, loginId } = await runnerOf(id);
      await runner.cancel?.(loginId);
    },
  };
}

export type RemoteProviderSignIn = ReturnType<typeof createRemoteProviderSignIn>;
