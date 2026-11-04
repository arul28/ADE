/**
 * Runs a provider's own sign-in for one ADE provider account, without a
 * terminal on screen.
 *
 * The add-account sheet used to embed a Work terminal running `claude auth
 * login`. That showed a black box: the login shell is untracked, so once the
 * CLI exited a second after the browser approval there was no transcript and
 * no live PTY left to draw, and every attempt left a session row in the
 * primary lane. Here the CLI runs in a private PTY owned by this module. Its
 * output is read for the two things a person needs — the sign-in link, and
 * whether it is asking for a pasted code — and the result is verified against
 * the account's saved login when the CLI exits, never assumed from its text.
 *
 * Callers poll `status` (the same shape as the subscription proxy's sign-in),
 * which works the same over local IPC and a pinned remote machine.
 */
import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import {
  isProviderLoginLive,
  type ProviderInstance,
  type ProviderInstanceLoginCommand,
  type ProviderLoginStatus,
} from "../../../shared/types/providerInstances";
import { userProcessEnv } from "../shared/hostRuntimeEnv";
import {
  CODE_PROMPT_PATTERN,
  LOGIN_FINISHED_RETENTION_MS,
  LOGIN_OUTPUT_LIMIT,
  LOGIN_TIMEOUT_MS,
  cleanLoginOutput,
  findDeviceCode,
  findSignInUrl,
  lastOutputLine,
  spawnLoginPty,
  stopLoginPty,
} from "../shared/cliLoginPty";
import {
  pinnedCliDownloadingLine,
  pinnedProviderCliState,
  requirePinnedProviderCli,
  type PinnedProviderCli,
} from "../pty/pinnedProviderCli";

/** Hosts a provider sign-in link lives on; any other link is a fallback. */
const AUTH_HOSTS = ["claude.ai", "anthropic.com", "auth.openai.com", "chatgpt.com", "openai.com"];

export type ProviderLoginRunnerDeps = {
  getInstance: (id: string) => ProviderInstance | null;
  loginCommand: (id: string) => ProviderInstanceLoginCommand;
  /** Re-read the account's saved login and registry after the CLI exits. */
  verify: (instance: ProviderInstance) => Promise<ProviderInstance | null>;
};

type LoginRecord = {
  status: ProviderLoginStatus;
  pty: IPty | null;
  rawOutput: string;
  /** Codes pasted into this sign-in, redacted from the output if the CLI echoes them. */
  submittedCodes: string[];
  /** Output since the last pasted code; null before one. Only it can show the code prompt again. */
  rawSinceSubmit: string | null;
  timeout: ReturnType<typeof setTimeout> | null;
  cleanup: ReturnType<typeof setTimeout> | null;
};

export function createProviderLoginRunner(deps: ProviderLoginRunnerDeps) {
  const logins = new Map<string, LoginRecord>();
  const now = () => new Date();

  function snapshot(record: LoginRecord): ProviderLoginStatus {
    return { ...record.status };
  }

  /** Stops a login's CLI (its whole tree on Windows). */
  function stopPty(record: LoginRecord, options: { sync?: boolean } = {}): void {
    const pty = record.pty;
    record.pty = null;
    stopLoginPty(pty, options);
  }

  function finish(
    record: LoginRecord,
    patch: Partial<ProviderLoginStatus>,
    options: { sync?: boolean } = {},
  ): void {
    if (record.timeout) clearTimeout(record.timeout);
    record.timeout = null;
    Object.assign(record.status, patch, { endedAt: now().toISOString() });
    stopPty(record, options);
    if (record.cleanup) clearTimeout(record.cleanup);
    record.cleanup = setTimeout(() => logins.delete(record.status.loginId), LOGIN_FINISHED_RETENTION_MS);
    record.cleanup.unref?.();
  }

  function isLive(record: LoginRecord): boolean {
    return isProviderLoginLive(record.status);
  }

  async function onExit(record: LoginRecord, exitCode: number): Promise<void> {
    if (!isLive(record)) return;
    record.pty = null;
    record.status.state = "verifying";
    record.status.awaitingCode = false;
    try {
      const instance = deps.getInstance(record.status.instanceId);
      const verified = instance ? await deps.verify(instance) : null;
      // A cancel, the timeout, or a new start may have ended it meanwhile.
      if (record.status.state !== "verifying") return;
      if (verified?.signedIn) {
        finish(record, {
          state: "succeeded",
          ...(verified.account?.email ? { email: verified.account.email } : {}),
        });
        return;
      }
      const reason = exitCode === 0
        ? "The sign-in finished, but no working login was saved for this account."
        : lastOutputLine(record.status.output) ?? `The sign-in stopped (exit code ${exitCode}).`;
      finish(record, { state: "failed", message: reason });
    } catch (error) {
      if (record.status.state !== "verifying") return;
      finish(record, {
        state: "failed",
        message: error instanceof Error ? error.message : "The sign-in could not be checked.",
      });
    }
  }

  /**
   * Runs the sign-in on ADE's pinned copy of the provider CLI: the account's
   * argv with its command word replaced by that copy, which also carries the
   * switches that keep it from updating itself. Never a CLI from the PATH.
   */
  function spawnLogin(record: LoginRecord, instance: ProviderInstance, cli: PinnedProviderCli, deviceAuth: boolean): void {
    const command = deps.loginCommand(instance.id);
    const args = [...cli.leadingArgs, ...command.args, ...(deviceAuth ? ["--device-auth"] : [])];
    const env: NodeJS.ProcessEnv = { ...userProcessEnv(), ...command.env, ...cli.env, TERM: "xterm-256color" };
    let pty: IPty;
    try {
      pty = spawnLoginPty(cli.command, args, env);
    } catch (error) {
      // A failed spawn must not stop the sign-in already running for this
      // account: the new attempt never existed.
      const detail = error instanceof Error ? error.message : "the CLI could not be started";
      throw new Error(`Could not run the ${instance.provider} sign-in command (${cli.command}): ${detail}`);
    }
    record.pty = pty;
    // One sign-in per account: a second start replaces the first, now that this
    // one is really running.
    for (const live of logins.values()) {
      if (live !== record && live.status.instanceId === instance.id && isLive(live)) {
        finish(live, { state: "cancelled", message: "Replaced by a new sign-in." });
      }
    }
    pty.onData((data) => {
      if (!isLive(record)) return;
      record.rawOutput = `${record.rawOutput}${data}`.slice(-LOGIN_OUTPUT_LIMIT * 2);
      const text = cleanLoginOutput(record.rawOutput, record.submittedCodes);
      record.status.output = text.slice(-LOGIN_OUTPUT_LIMIT);
      // Read again on every chunk: a link split across two reads is cut off
      // in the first one, and the next read completes it.
      record.status.url = findSignInUrl(text, AUTH_HOSTS) ?? record.status.url;
      if (deviceAuth) {
        // The last match: the code is the last thing Codex prints before it waits.
        const deviceCode = findDeviceCode(text);
        if (deviceCode) record.status.deviceCode = deviceCode;
      }
      // The prompt can be followed by the CLI's own "Login successful", so
      // only the latest few lines decide whether it is still waiting. After a
      // paste, the prompt it answered is still there; only a new one counts.
      if (record.rawSinceSubmit !== null) record.rawSinceSubmit = `${record.rawSinceSubmit}${data}`.slice(-LOGIN_OUTPUT_LIMIT);
      const promptText = record.rawSinceSubmit === null ? text : cleanLoginOutput(record.rawSinceSubmit, record.submittedCodes);
      record.status.awaitingCode = CODE_PROMPT_PATTERN.test(promptText.split("\n").slice(-4).join("\n"));
    });
    pty.onExit(({ exitCode }) => {
      void onExit(record, exitCode);
    });
  }

  function start(id: string, options: { deviceAuth?: boolean } = {}): ProviderLoginStatus {
    const instance = deps.getInstance(id);
    if (!instance) throw new Error(`No provider account ${JSON.stringify(id)}.`);
    // Only Codex has a device sign-in; Claude's link already ends in a pasted code.
    const deviceAuth = options.deviceAuth === true && instance.provider === "codex";
    const pinned = pinnedProviderCliState(instance.provider);
    if (pinned.kind === "blocked") throw new Error(pinned.message);
    const loginId = randomUUID();
    const record: LoginRecord = {
      status: {
        loginId,
        instanceId: instance.id,
        provider: instance.provider,
        state: "running",
        url: null,
        awaitingCode: false,
        output: "",
        startedAt: now().toISOString(),
      },
      pty: null,
      rawOutput: "",
      submittedCodes: [],
      rawSinceSubmit: null,
      timeout: null,
      cleanup: null,
    };
    if (pinned.kind === "ready") {
      spawnLogin(record, instance, pinned.cli, deviceAuth);
    } else {
      // This machine has no copy yet: the sign-in reads as running with the
      // download's line, and starts once the copy lands (or fails with why).
      record.status.output = pinnedCliDownloadingLine(pinned.label);
      void pinned.done
        .then(() => requirePinnedProviderCli(instance.provider))
        .then((cli) => {
          if (!isLive(record)) return;
          record.status.output = "";
          spawnLogin(record, instance, cli, deviceAuth);
        })
        .catch((error: unknown) => {
          if (!isLive(record)) return;
          finish(record, { state: "failed", message: error instanceof Error ? error.message : String(error) });
        });
    }
    record.timeout = setTimeout(() => {
      if (isLive(record)) finish(record, { state: "failed", message: "The sign-in timed out after 10 minutes." });
    }, LOGIN_TIMEOUT_MS);
    record.timeout.unref?.();
    logins.set(loginId, record);
    return snapshot(record);
  }

  function requireLogin(loginId: string): LoginRecord {
    const record = logins.get(typeof loginId === "string" ? loginId.trim() : "");
    if (!record) throw new Error("That sign-in is no longer running. Start it again.");
    return record;
  }

  return {
    start,
    status(loginId: string): ProviderLoginStatus {
      return snapshot(requireLogin(loginId));
    },
    submitCode(loginId: string, code: string): ProviderLoginStatus {
      const record = requireLogin(loginId);
      const trimmed = typeof code === "string" ? code.trim() : "";
      if (!trimmed) throw new Error("Paste the code from the browser first.");
      if (!record.pty || record.status.state !== "running") {
        throw new Error("This sign-in is not waiting for a code any more.");
      }
      // A paste as short as "y" would blank every match in the output.
      if (trimmed.length >= 4) record.submittedCodes.push(trimmed);
      record.rawSinceSubmit = "";
      record.pty.write(`${trimmed}\r`);
      record.status.awaitingCode = false;
      return snapshot(record);
    },
    cancel(loginId: string): ProviderLoginStatus {
      const record = requireLogin(loginId);
      if (isLive(record)) finish(record, { state: "cancelled" });
      return snapshot(record);
    },
    disposeAll(): void {
      for (const record of logins.values()) {
        if (isLive(record)) finish(record, { state: "cancelled" }, { sync: true });
        if (record.cleanup) clearTimeout(record.cleanup);
      }
      logins.clear();
    },
  };
}

export type ProviderLoginRunner = ReturnType<typeof createProviderLoginRunner>;
