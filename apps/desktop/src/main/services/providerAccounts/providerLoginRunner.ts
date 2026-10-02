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
import type {
  ProviderInstance,
  ProviderInstanceLoginCommand,
  ProviderLoginStatus,
} from "../../../shared/types/providerInstances";
import { stripAnsi } from "../../utils/ansiStrip";
import { killWindowsProcessTree, resolveCliSpawnInvocation } from "../shared/processExecution";

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
const CODE_PROMPT_PATTERN = /paste (the )?(authorization )?code|enter (the )?(authorization )?code|code here/i;

export type ProviderLoginRunnerDeps = {
  getInstance: (id: string) => ProviderInstance | null;
  loginCommand: (id: string) => ProviderInstanceLoginCommand;
  /** Re-read the account's saved login and registry after the CLI exits. */
  verify: (instance: ProviderInstance) => Promise<ProviderInstance | null>;
  loadPty?: () => typeof NodePty;
  now?: () => Date;
};

type LoginRecord = {
  status: ProviderLoginStatus;
  pty: IPty | null;
  rawOutput: string;
  timeout: ReturnType<typeof setTimeout> | null;
  cleanup: ReturnType<typeof setTimeout> | null;
};

const requireFromRuntime = createRequire(
  typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url),
);

function defaultLoadPty(): typeof NodePty {
  // node-pty is native and external to both bundles; load it at first use.
  return requireFromRuntime("node-pty") as typeof NodePty;
}

/** The sign-in link in the CLI's output: an auth host first, else the first link. */
export function findSignInUrl(text: string): string | null {
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
  const now = deps.now ?? (() => new Date());
  const loadPty = deps.loadPty ?? defaultLoadPty;

  function snapshot(record: LoginRecord): ProviderLoginStatus {
    return { ...record.status };
  }

  function stopPty(record: LoginRecord): void {
    const pty = record.pty;
    record.pty = null;
    if (!pty) return;
    try {
      if (process.platform === "win32" && pty.pid > 0) killWindowsProcessTree(pty.pid);
      else pty.kill();
    } catch {
      // Already gone.
    }
  }

  function finish(record: LoginRecord, patch: Partial<ProviderLoginStatus>): void {
    if (record.timeout) clearTimeout(record.timeout);
    record.timeout = null;
    Object.assign(record.status, patch, { endedAt: now().toISOString() });
    stopPty(record);
    record.cleanup = setTimeout(() => logins.delete(record.status.loginId), FINISHED_RETENTION_MS);
    record.cleanup.unref?.();
  }

  function isLive(record: LoginRecord): boolean {
    return record.status.state === "running" || record.status.state === "verifying";
  }

  async function onExit(record: LoginRecord, exitCode: number): Promise<void> {
    if (!isLive(record)) return;
    record.pty = null;
    record.status.state = "verifying";
    record.status.awaitingCode = false;
    try {
      const instance = deps.getInstance(record.status.instanceId);
      const verified = instance ? await deps.verify(instance) : null;
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
      finish(record, {
        state: "failed",
        message: error instanceof Error ? error.message : "The sign-in could not be checked.",
      });
    }
  }

  function start(id: string): ProviderLoginStatus {
    const instance = deps.getInstance(id);
    if (!instance) throw new Error(`No provider account with id ${JSON.stringify(id)}.`);
    // One sign-in per account: a second start replaces the first.
    for (const record of logins.values()) {
      if (record.status.instanceId === instance.id && isLive(record)) {
        finish(record, { state: "cancelled", message: "Replaced by a new sign-in." });
      }
    }
    const command = deps.loginCommand(instance.id);
    const env: NodeJS.ProcessEnv = { ...process.env, ...command.env, TERM: "xterm-256color" };
    const invocation = resolveCliSpawnInvocation(command.command, command.args, env);
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
      timeout: null,
      cleanup: null,
    };
    const pty = loadPty().spawn(invocation.command, invocation.args, {
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
      const text = stripAnsi(record.rawOutput).replace(/\r(?!\n)/g, "\n");
      record.status.output = text.slice(-OUTPUT_LIMIT);
      record.status.url = record.status.url ?? findSignInUrl(text);
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
        if (isLive(record)) finish(record, { state: "cancelled" });
        if (record.cleanup) clearTimeout(record.cleanup);
      }
      logins.clear();
    },
  };
}

export type ProviderLoginRunner = ReturnType<typeof createProviderLoginRunner>;
