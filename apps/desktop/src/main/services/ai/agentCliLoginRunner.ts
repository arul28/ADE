/**
 * Runs an agent CLI's own sign-in (Grok, Devin, Muse, Copilot, Droid, Kimi)
 * without a terminal on screen, the way the provider account runner signs in
 * Claude Code and Codex.
 *
 * The CLI is ADE's pinned copy, run in a private PTY on this machine. Its
 * output is read for the sign-in link, a device code and a "paste the code"
 * prompt, and the two CLIs that wait on a keypress get it (Muse's "Press
 * Enter", Droid's Login menu). The result is the CLI's saved login read back
 * from disk, never its text: polled every couple of seconds while it runs
 * (Droid's TUI never exits after a sign-in) and once when it exits. A login
 * counts only once it differs from the one on disk when the sign-in started,
 * so a machine that was already signed in does not read as done at once.
 * Signing in again, a rewritten file proves nothing (a running session
 * refreshes its token in the same file), so only the CLI's clean exit with a
 * changed login counts.
 *
 *   const runner = getMachineAgentCliLoginRunner();
 *   const login = await runner.start({ provider: "grok" });
 *   runner.status(login.loginId);   // poll until state is not running/verifying
 */
import { randomUUID } from "node:crypto";
import {
  AGENT_CLI_LOGIN_PROVIDERS,
  isAgentCliLoginProvider,
  type AgentCliLoginProvider,
  type AgentCliLoginStartArgs,
  type AgentCliLoginStatus,
  type KimiLoginRegion,
} from "../../../shared/types/agentCliLogin";
import { isProviderLoginLive } from "../../../shared/types/providerInstances";
import {
  CODE_PROMPT_PATTERN,
  LOGIN_FINISHED_RETENTION_MS,
  LOGIN_OUTPUT_LIMIT,
  LOGIN_TIMEOUT_MS,
  cleanLoginOutput,
  findDeviceCode,
  findSignInUrl,
  lastOutputLine,
} from "../shared/cliLoginPty";

/** How often the saved login is read while the CLI runs. */
const VERIFY_POLL_MS = 2_000;
/** A TUI draws its prompt a moment before it reads keys; the keypress waits this long. */
const KEYPRESS_DELAY_MS = 300;
/** Only the latest lines decide whether a prompt is still showing. */
const PROMPT_TAIL_LINES = 6;
const EMAIL_PATTERN = /(?:signed|logged) in as\s+([^\s<>"'()]+@[^\s<>"'()]+)/i;

/** The slice of a PTY this runner uses, so a test or a probe can stand one in. */
export type AgentCliLoginPty = {
  pid: number;
  onData: (listener: (data: string) => void) => unknown;
  onExit: (listener: (event: { exitCode: number }) => void) => unknown;
  write: (data: string) => void;
  kill: () => void;
};

/** ADE's pinned copy of the CLI: an absolute entry, the arguments before the CLI's own, its env. */
export type AgentCliLoginCli = { command: string; leadingArgs: string[]; env: Record<string, string> };

export type AgentCliLoginCliState =
  | { kind: "ready"; cli: AgentCliLoginCli }
  /** Downloading first: `line` is what the sheet shows; `done` resolves to the copy or rejects with why not. */
  | { kind: "downloading"; line: string; done: Promise<AgentCliLoginCli> }
  | { kind: "blocked"; message: string };

export type AgentCliSavedLoginRead = { signedIn: boolean; fingerprint: string; account?: string };

export type AgentCliLoginRunnerDeps = {
  /** Where ADE's copy of the provider's CLI stands on this machine. Never a CLI from the PATH. */
  resolveCli: (provider: AgentCliLoginProvider) => AgentCliLoginCliState;
  /** The environment the CLI runs with (the user's, without ADE's host variables). */
  baseEnv: () => NodeJS.ProcessEnv;
  spawnPty: (command: string, args: string[], env: NodeJS.ProcessEnv) => AgentCliLoginPty;
  /** Stops the CLI; `sync` on process exit. */
  stopPty: (pty: AgentCliLoginPty, options: { sync?: boolean }) => void;
  /** The provider's saved login on disk, read with the CLI's environment. */
  readSavedLogin: (provider: AgentCliLoginProvider, env: NodeJS.ProcessEnv) => Promise<AgentCliSavedLoginRead>;
  /** A sign-in verified: drop whatever caches the provider's signed-in state. */
  onSignedIn?: (provider: AgentCliLoginProvider) => void;
  pollMs?: number;
  timeoutMs?: number;
  /** The machine's platform; defaults to this process's. */
  platform?: NodeJS.Platform;
};

type ProviderLoginSpec = {
  label: string;
  /** The sign-in's arguments, after the copy's own leading ones. */
  args: (options: { kimiRegion: KimiLoginRegion }) => string[];
  /** Hosts the sign-in link lives on; any other link is a fallback. */
  hosts: readonly string[];
  /** Prints a one-time code to confirm or type on the sign-in page. */
  deviceCode: boolean;
  /** Asks for a code pasted from the browser. */
  pasteCode: boolean;
  /** Opens the sign-in page in a browser on this machine by itself. */
  opensBrowser: boolean;
  /** A prompt the CLI waits on, answered with `send` once. */
  keypress?: { when: RegExp; send: string };
  /** A full-screen TUI that positions its words with cursor moves. */
  tui?: boolean;
  /** Runs its normal session, not a sign-in, when it is already signed in. */
  refusesWhenSignedIn?: boolean;
  /**
   * Rewrites its login file while it still waits for approval, so a changed
   * file proves nothing: only the CLI's exit after approval counts.
   */
  verifyOnExitOnly?: boolean;
  /**
   * Where ADE cannot see the saved login (Muse keeps it in the macOS Keychain,
   * which ADE never reads), a clean exit counts unless the output says the
   * sign-in failed. Only on that platform; everywhere else the file decides.
   */
  keychainOnly?: { platform: NodeJS.Platform; failure: RegExp };
};

const SPECS: Readonly<Record<AgentCliLoginProvider, ProviderLoginSpec>> = {
  // Device flow. Not `--oauth`: that waits on a loopback callback, which a
  // browser on another machine cannot reach.
  grok: { label: "Grok", args: () => ["login"], hosts: ["x.ai"], deviceCode: true, pasteCode: false, opensBrowser: true },
  // The manual flow skips a menu: a link, then a pasted code.
  devin: {
    label: "Devin",
    args: () => ["auth", "login", "--force-manual-token-flow"],
    hosts: ["devin.ai"],
    deviceCode: false,
    pasteCode: true,
    opensBrowser: false,
  },
  // Prints the device link and code, then waits on Enter before it opens a
  // browser and polls; Enter is pressed for it.
  muse: {
    label: "Muse Code",
    args: () => ["login"],
    hosts: ["meta.com"],
    deviceCode: true,
    pasteCode: false,
    opensBrowser: true,
    keypress: { when: /press\s*enter\s*to\s*open/i, send: "\r" },
    // Muse 1.4.7's own failure lines; on success it saves to the Keychain and exits.
    keychainOnly: { platform: "darwin", failure: /saving failed|not approved in time|denied|expired/i },
  },
  copilot: {
    label: "GitHub Copilot",
    args: () => ["login", "--device-code"],
    hosts: ["github.com"],
    deviceCode: true,
    pasteCode: false,
    opensBrowser: false,
    // Copilot 1.0.105 rewrites config.json when the login starts, then exits
    // once GitHub approves (measured with a real sign-in).
    verifyOnExitOnly: true,
  },
  // No login subcommand: signed out, the TUI opens on a menu with Login
  // preselected. Enter picks it; the device flow follows, and the TUI keeps
  // running after the sign-in lands.
  droid: {
    label: "Droid",
    args: () => [],
    hosts: ["factory.ai"],
    deviceCode: true,
    pasteCode: false,
    opensBrowser: true,
    keypress: { when: /factory\s*private\s*deployment/i, send: "\r" },
    tui: true,
    refusesWhenSignedIn: true,
  },
  kimi: {
    label: "Kimi Code",
    args: ({ kimiRegion }) => ["login", "--region", kimiRegion],
    hosts: ["kimi.com", "kimi.ai"],
    deviceCode: true,
    pasteCode: false,
    // Kimi 2.3.1 prints "Opening browser for Kimi device login: https://www.kimi.ai/code/authorize_device?user_code=…".
    opensBrowser: true,
  },
};

type LoginRecord = {
  status: AgentCliLoginStatus;
  kimiRegion: KimiLoginRegion;
  env: NodeJS.ProcessEnv;
  /** The saved login when the sign-in started; a verified one must differ. */
  baseline: AgentCliSavedLoginRead | null;
  pty: AgentCliLoginPty | null;
  rawOutput: string;
  /** Codes pasted into this sign-in, redacted from the output if the CLI echoes them. */
  submittedCodes: string[];
  /** Output since the last pasted code; null before one. Only it can show the code prompt again. */
  rawSinceSubmit: string | null;
  keypressSent: boolean;
  polling: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
  poll: ReturnType<typeof setInterval> | null;
  cleanup: ReturnType<typeof setTimeout> | null;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseKimiRegion(value: unknown): KimiLoginRegion {
  if (value == null || value === "") return "global";
  if (value === "global" || value === "mainland-cn") return value;
  throw new Error(`Unknown Kimi region ${JSON.stringify(value)}; use "global" or "mainland-cn".`);
}

export function createAgentCliLoginRunner(deps: AgentCliLoginRunnerDeps) {
  const logins = new Map<string, LoginRecord>();
  const pollMs = deps.pollMs ?? VERIFY_POLL_MS;
  const timeoutMs = deps.timeoutMs ?? LOGIN_TIMEOUT_MS;
  const now = () => new Date();

  function snapshot(record: LoginRecord): AgentCliLoginStatus {
    return { ...record.status };
  }

  function isLive(record: LoginRecord): boolean {
    return isProviderLoginLive(record.status);
  }

  function later(record: LoginRecord, ms: number, run: () => void): void {
    const timer = setTimeout(() => {
      record.timers.delete(timer);
      run();
    }, ms);
    timer.unref?.();
    record.timers.add(timer);
  }

  function stopPty(record: LoginRecord, options: { sync?: boolean } = {}): void {
    const pty = record.pty;
    record.pty = null;
    if (pty) deps.stopPty(pty, options);
  }

  function finish(record: LoginRecord, patch: Partial<AgentCliLoginStatus>, options: { sync?: boolean } = {}): void {
    for (const timer of record.timers) clearTimeout(timer);
    record.timers.clear();
    if (record.poll) clearInterval(record.poll);
    record.poll = null;
    Object.assign(record.status, patch, { awaitingCode: false, downloading: null, endedAt: now().toISOString() });
    stopPty(record, options);
    if (record.cleanup) clearTimeout(record.cleanup);
    record.cleanup = setTimeout(() => logins.delete(record.status.loginId), LOGIN_FINISHED_RETENTION_MS);
    record.cleanup.unref?.();
  }

  function succeed(record: LoginRecord, account?: string): void {
    const email = record.status.output.match(EMAIL_PATTERN)?.[1]?.replace(/[.,;:!]+$/, "") ?? account;
    finish(record, { state: "succeeded", ...(email ? { email } : {}) });
    deps.onSignedIn?.(record.status.provider);
  }

  /** The saved login is there and is not the one that was there at the start. */
  function isFresh(record: LoginRecord, saved: AgentCliSavedLoginRead): boolean {
    return saved.signedIn && saved.fingerprint !== record.baseline?.fingerprint;
  }

  /**
   * A changed login file proves a sign-in while the CLI still runs, and after
   * an exit that was not clean. Not when the CLI rewrites it before approval
   * (Copilot), nor when a login was already there: a session using it
   * refreshes its token in the same file.
   */
  function trustsFileChange(record: LoginRecord): boolean {
    return !SPECS[record.status.provider].verifyOnExitOnly && !record.baseline?.signedIn;
  }

  async function pollSavedLogin(record: LoginRecord): Promise<void> {
    if (record.polling || record.status.state !== "running") return;
    record.polling = true;
    try {
      const saved = await deps.readSavedLogin(record.status.provider, record.env);
      // The CLI may have exited, or a cancel landed, while this read ran.
      if (record.status.state === "running" && isFresh(record, saved)) succeed(record, saved.account);
    } catch {
      // A read that fails says nothing; the next poll or the exit decides.
    } finally {
      record.polling = false;
    }
  }

  async function onExit(record: LoginRecord, exitCode: number): Promise<void> {
    if (!isLive(record)) return;
    record.pty = null;
    if (record.poll) clearInterval(record.poll);
    record.poll = null;
    record.status.state = "verifying";
    record.status.awaitingCode = false;
    const label = SPECS[record.status.provider].label;
    try {
      const saved = await deps.readSavedLogin(record.status.provider, record.env);
      // A cancel, the timeout, or a new start may have ended it meanwhile.
      if (record.status.state !== "verifying") return;
      if (isFresh(record, saved) && (exitCode === 0 || trustsFileChange(record))) {
        succeed(record, saved.account);
        return;
      }
      const keychain = SPECS[record.status.provider].keychainOnly;
      if (keychain && (deps.platform ?? process.platform) === keychain.platform && exitCode === 0 && record.status.url && !keychain.failure.test(record.status.output)) {
        succeed(record);
        return;
      }
      const reason = exitCode === 0
        ? `The sign-in finished, but ${label} saved no login on this machine.`
        : lastOutputLine(record.status.output) ?? `The sign-in stopped (exit code ${exitCode}).`;
      finish(record, { state: "failed", message: reason });
    } catch (error) {
      if (record.status.state !== "verifying") return;
      finish(record, { state: "failed", message: errorMessage(error) || "The sign-in could not be checked." });
    }
  }

  function onData(record: LoginRecord, spec: ProviderLoginSpec, data: string): void {
    if (!isLive(record)) return;
    record.rawOutput = `${record.rawOutput}${data}`.slice(-LOGIN_OUTPUT_LIMIT * 2);
    const text = cleanLoginOutput(record.rawOutput, record.submittedCodes, { cursorMovesAsSpace: spec.tui });
    record.status.output = text.slice(-LOGIN_OUTPUT_LIMIT);
    // Read again on every chunk: a link split across two reads is cut off in
    // the first one, and the next read completes it.
    record.status.url = findSignInUrl(text, spec.hosts) ?? record.status.url;
    if (spec.deviceCode) {
      const deviceCode = findDeviceCode(text);
      if (deviceCode) record.status.deviceCode = deviceCode;
    }
    const tail = text.split("\n").slice(-PROMPT_TAIL_LINES).join("\n");
    // The prompt can be followed by the CLI's own "Signed in", so only the
    // latest lines decide whether it is still waiting.
    if (record.rawSinceSubmit !== null) record.rawSinceSubmit = `${record.rawSinceSubmit}${data}`.slice(-LOGIN_OUTPUT_LIMIT);
    if (spec.pasteCode) {
      // After a paste, the prompt it answered is still on screen; only a new one counts.
      const promptTail = record.rawSinceSubmit === null
        ? tail
        : cleanLoginOutput(record.rawSinceSubmit, record.submittedCodes).split("\n").slice(-PROMPT_TAIL_LINES).join("\n");
      record.status.awaitingCode = CODE_PROMPT_PATTERN.test(promptTail);
    }
    if (spec.keypress && !record.keypressSent && spec.keypress.when.test(tail)) {
      record.keypressSent = true;
      const pty = record.pty;
      const send = spec.keypress.send;
      later(record, KEYPRESS_DELAY_MS, () => {
        if (isLive(record) && record.pty === pty) pty?.write(send);
      });
    }
  }

  function spawnLogin(record: LoginRecord, cli: AgentCliLoginCli): void {
    const provider = record.status.provider;
    const spec = SPECS[provider];
    const args = [...cli.leadingArgs, ...spec.args({ kimiRegion: record.kimiRegion })];
    const env: NodeJS.ProcessEnv = { ...record.env, ...cli.env, TERM: "xterm-256color" };
    let pty: AgentCliLoginPty;
    try {
      pty = deps.spawnPty(cli.command, args, env);
    } catch (error) {
      // A failed spawn must not stop a sign-in already running for this
      // provider: the new attempt never existed.
      throw new Error(`Could not run the ${spec.label} sign-in (${cli.command}): ${errorMessage(error)}`);
    }
    record.pty = pty;
    record.status.downloading = null;
    // One sign-in per CLI on a machine: a second start replaces the first,
    // now that this one is really running.
    for (const live of logins.values()) {
      if (live !== record && live.status.provider === provider && isLive(live)) {
        finish(live, { state: "cancelled", message: "Replaced by a new sign-in." });
      }
    }
    pty.onData((data) => onData(record, spec, data));
    pty.onExit(({ exitCode }) => {
      void onExit(record, exitCode);
    });
    if (trustsFileChange(record)) {
      record.poll = setInterval(() => {
        void pollSavedLogin(record);
      }, pollMs);
      record.poll.unref?.();
    }
  }

  async function start(args: AgentCliLoginStartArgs): Promise<AgentCliLoginStatus> {
    const provider = args?.provider;
    if (!isAgentCliLoginProvider(provider)) {
      throw new Error(`Unknown sign-in ${JSON.stringify(provider)}; one of ${AGENT_CLI_LOGIN_PROVIDERS.join(", ")}.`);
    }
    const spec = SPECS[provider];
    const kimiRegion = parseKimiRegion(provider === "kimi" ? args.kimiRegion : undefined);
    const cliState = deps.resolveCli(provider);
    if (cliState.kind === "blocked") throw new Error(cliState.message);
    const env = deps.baseEnv();
    const baseline = await deps.readSavedLogin(provider, env).catch(() => null);
    if (spec.refusesWhenSignedIn && baseline?.signedIn) {
      throw new Error(`${spec.label} is already signed in on this machine. To use another account, sign out in ${spec.label} first.`);
    }
    const record: LoginRecord = {
      status: {
        loginId: randomUUID(),
        provider,
        state: "running",
        url: null,
        awaitingCode: false,
        opensBrowser: spec.opensBrowser,
        downloading: null,
        output: "",
        startedAt: now().toISOString(),
      },
      kimiRegion,
      env,
      baseline,
      pty: null,
      rawOutput: "",
      submittedCodes: [],
      rawSinceSubmit: null,
      keypressSent: false,
      polling: false,
      timers: new Set(),
      poll: null,
      cleanup: null,
    };
    if (cliState.kind === "ready") {
      spawnLogin(record, cliState.cli);
    } else {
      // This machine has no copy yet: the sign-in reads as running with the
      // download's line, and starts once the copy lands (or fails with why).
      record.status.downloading = cliState.line;
      void cliState.done
        .then((cli) => {
          if (isLive(record)) spawnLogin(record, cli);
        })
        .catch((error: unknown) => {
          if (isLive(record)) finish(record, { state: "failed", message: errorMessage(error) });
        });
    }
    later(record, timeoutMs, () => {
      if (isLive(record)) finish(record, { state: "failed", message: "The sign-in timed out after 10 minutes." });
    });
    logins.set(record.status.loginId, record);
    return snapshot(record);
  }

  function requireLogin(loginId: unknown): LoginRecord {
    const record = logins.get(typeof loginId === "string" ? loginId.trim() : "");
    if (!record) throw new Error("That sign-in is no longer running. Start it again.");
    return record;
  }

  return {
    start,
    status(loginId: string): AgentCliLoginStatus {
      return snapshot(requireLogin(loginId));
    },
    submitCode(loginId: string, code: string): AgentCliLoginStatus {
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
    cancel(loginId: string): AgentCliLoginStatus {
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

export type AgentCliLoginRunner = ReturnType<typeof createAgentCliLoginRunner>;
