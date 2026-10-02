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
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { IPty } from "node-pty";
import type * as NodePty from "node-pty";
import {
  isProviderLoginLive,
  type ProviderInstance,
  type ProviderInstanceLoginCommand,
  type ProviderLoginStatus,
} from "../../../shared/types/providerInstances";
import { stripAnsi } from "../../utils/ansiStrip";
import { userProcessEnv } from "../shared/hostRuntimeEnv";
import {
  killWindowsProcessTree,
  killWindowsProcessTreeAsync,
  resolveCliSpawnInvocation,
} from "../shared/processExecution";

/** A sign-in nobody finishes in this long is abandoned; the CLI is stopped. */
const LOGIN_TIMEOUT_MS = 10 * 60_000;
/** A finished login stays readable this long, so the last poll sees the result. */
const FINISHED_RETENTION_MS = 2 * 60_000;
const OUTPUT_LIMIT = 8_000;
/** Wide enough that the CLI never wraps the sign-in link across lines. */
const PTY_COLS = 400;
const PTY_ROWS = 40;

const URL_PATTERN = /https:\/\/[^\s"'<>`]+/g;
/** Hosts a provider sign-in link lives on; any other link is a fallback. */
const AUTH_HOSTS = ["claude.ai", "anthropic.com", "auth.openai.com", "chatgpt.com", "openai.com"];
/** Codex's device code, e.g. `ABCD-EFGHI`, on its own after the "enter this code" line. */
const DEVICE_CODE_PATTERN_ALL = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/g;
const CODE_PROMPT_PATTERN = /paste (the )?(authorization )?code|enter (the )?(authorization )?code|code here/i;

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
  timeout: ReturnType<typeof setTimeout> | null;
  cleanup: ReturnType<typeof setTimeout> | null;
};

const requireFromRuntime = createRequire(
  typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url),
);

function loadPty(): typeof NodePty {
  // node-pty is native and external to both bundles; load it at first use.
  // Not the supervised PTY host: that loader belongs to one project's window,
  // and this runner serves the whole machine, the headless runtime included.
  return requireFromRuntime("node-pty") as typeof NodePty;
}

/** The sign-in link in the CLI's output: an auth host first, else the first link. */
function findSignInUrl(text: string): string | null {
  const urls = (text.match(URL_PATTERN) ?? []).map((url) => url.replace(/[).,;\]]+$/, ""));
  if (urls.length === 0) return null;
  const isAuthHost = (url: string) => {
    try {
      const host = new URL(url).hostname;
      return AUTH_HOSTS.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
    } catch {
      return false;
    }
  };
  return urls.find(isAuthHost) ?? urls[0] ?? null;
}

/** The CLI's last non-empty output line, as a failure reason. */
function lastLine(text: string): string | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.at(-1) ?? null;
}

export function createProviderLoginRunner(deps: ProviderLoginRunnerDeps) {
  const logins = new Map<string, LoginRecord>();
  const now = () => new Date();

  function snapshot(record: LoginRecord): ProviderLoginStatus {
    return { ...record.status };
  }

  /**
   * Stops a login's CLI. On Windows, taskkill must list the tree while the
   * ConPTY leader still exists, so the PTY closes only after taskkill ends.
   * `sync` is for process exit, which cannot wait for a promise.
   */
  function stopPty(record: LoginRecord, options: { sync?: boolean } = {}): void {
    const pty = record.pty;
    record.pty = null;
    if (!pty) return;
    const kill = () => {
      try {
        pty.kill();
      } catch {
        // Already gone.
      }
    };
    if (process.platform !== "win32" || pty.pid <= 0) {
      kill();
    } else if (options.sync) {
      killWindowsProcessTree(pty.pid);
      kill();
    } else {
      void killWindowsProcessTreeAsync(pty.pid).finally(kill);
    }
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
    record.cleanup = setTimeout(() => logins.delete(record.status.loginId), FINISHED_RETENTION_MS);
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
        : lastLine(record.status.output) ?? `The sign-in stopped (exit code ${exitCode}).`;
      finish(record, { state: "failed", message: reason });
    } catch (error) {
      if (record.status.state !== "verifying") return;
      finish(record, {
        state: "failed",
        message: error instanceof Error ? error.message : "The sign-in could not be checked.",
      });
    }
  }

  function start(id: string, options: { deviceAuth?: boolean } = {}): ProviderLoginStatus {
    const instance = deps.getInstance(id);
    if (!instance) throw new Error(`No provider account with id ${JSON.stringify(id)}.`);
    // One sign-in per account: a second start replaces the first.
    for (const record of logins.values()) {
      if (record.status.instanceId === instance.id && isLive(record)) {
        finish(record, { state: "cancelled", message: "Replaced by a new sign-in." });
      }
    }
    const command = deps.loginCommand(instance.id);
    // Only Codex has a device sign-in; Claude's link already ends in a pasted code.
    const deviceAuth = options.deviceAuth === true && instance.provider === "codex";
    const args = deviceAuth ? [...command.args, "--device-auth"] : command.args;
    const env: NodeJS.ProcessEnv = { ...userProcessEnv(), ...command.env, TERM: "xterm-256color" };
    const invocation = resolveCliSpawnInvocation(command.command, args, env);
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
      timeout: null,
      cleanup: null,
    };
    // A cmd.exe wrapper carries one pre-quoted command line; node-pty must not
    // quote it again.
    const ptyArgs = invocation.windowsVerbatimArguments ? invocation.args.join(" ") : invocation.args;
    const pty = loadPty().spawn(invocation.command, ptyArgs, {
      name: "xterm-256color",
      cols: PTY_COLS,
      rows: PTY_ROWS,
      cwd: os.homedir(),
      env: env as Record<string, string>,
    });
    record.pty = pty;
    pty.onData((data) => {
      if (!isLive(record)) return;
      record.rawOutput = `${record.rawOutput}${data}`.slice(-OUTPUT_LIMIT * 2);
      let text = stripAnsi(record.rawOutput).replace(/\r(?!\n)/g, "\n");
      for (const code of record.submittedCodes) text = text.split(code).join("[code]");
      record.status.output = text.slice(-OUTPUT_LIMIT);
      // Read again on every chunk: a link split across two reads is cut off
      // in the first one, and the next read completes it.
      record.status.url = findSignInUrl(text) ?? record.status.url;
      if (deviceAuth) {
        // The last match: the code is the last thing Codex prints before it waits.
        const deviceCode = text.replace(URL_PATTERN, " ").match(DEVICE_CODE_PATTERN_ALL)?.at(-1);
        if (deviceCode) record.status.deviceCode = deviceCode;
      }
      // The prompt can be followed by the CLI's own "Login successful", so
      // only the latest few lines decide whether it is still waiting.
      record.status.awaitingCode = CODE_PROMPT_PATTERN.test(text.split("\n").slice(-4).join("\n"));
    });
    pty.onExit(({ exitCode }) => {
      void onExit(record, exitCode);
    });
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
      // A short paste ("y") would blank every match in the output.
      if (trimmed.length >= 8) record.submittedCodes.push(trimmed);
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
