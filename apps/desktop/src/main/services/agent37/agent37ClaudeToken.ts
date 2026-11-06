/**
 * Claude on Agent 37 machines, signed in once.
 *
 * A new cloud machine has no Claude sign-in, so a ready machine (made ahead of
 * time, for a chat that starts in seconds) would stop that chat on a sign-in.
 * Claude Code has a sign-in made for this: `claude setup-token` prints a
 * long-lived subscription token, and `CLAUDE_CODE_OAUTH_TOKEN` signs Claude
 * Code in with it. Agent 37's own docs sign Claude in on a machine this way.
 *
 * The person runs that sign-in once, here, in a private terminal (the same
 * one ADE's provider sign-ins use): the browser approves it, and ADE reads the
 * token from Claude Code's output and keeps it in the person's account vault.
 * Every Agent 37 machine made after that gets it as instance env, which Agent
 * 37 stores with the machine and gives back on every boot.
 *
 * The token is never shown: it is cut from the output the screen reads, never
 * logged, and only leaves this process for the account vault and Agent 37's
 * create call. Account-wide, so nothing here takes a pin.
 */

import type { IPty } from "node-pty";
import type { Agent37ClaudeTokenSignInState, Agent37ClaudeTokenStatus } from "../../../shared/agent37";
import { pinnedLoginCliState, type PinnedProviderCli } from "../pty/pinnedProviderCli";
import { userProcessEnv } from "../shared/hostRuntimeEnv";
import {
  LOGIN_TIMEOUT_MS,
  cleanLoginOutput,
  lastOutputLine,
  readLoginOutput,
  spawnLoginPty,
  stopLoginPty,
  writeLoginCode,
} from "../shared/cliLoginPty";
import type { Agent37Vault } from "./agent37Credential";
import { COMPLETE_TOKEN_PATTERN, TOKEN_PATTERN, parseStored, type StoredToken } from "./agent37ClaudeTokenStore";

export { AGENT37_CLAUDE_TOKEN_VAULT_KEY, agent37MachineEnv } from "./agent37ClaudeTokenStore";

const AUTH_HOSTS = ["claude.ai", "anthropic.com", "claude.com"];

type Logger = {
  info?(event: string, meta?: Record<string, unknown>): void;
  warn?(event: string, meta?: Record<string, unknown>): void;
} | null | undefined;

type SignInRecord = {
  status: { state: Agent37ClaudeTokenSignInState; output: string; url: string | null; awaitingCode: boolean };
  message: string | null;
  pty: IPty | null;
  rawOutput: string;
  submittedCodes: string[];
  rawSinceSubmit: string | null;
  timeout: ReturnType<typeof setTimeout> | null;
  /** The browser was opened for this link already. */
  openedUrl: string | null;
};

export function createAgent37ClaudeToken(deps: {
  /** Null when this computer is signed out of ADE: there is no account to keep the token in. */
  vault: () => Agent37Vault | null;
  openExternal: (url: string) => void;
  /** Told whenever the status changed, so windows read it again. */
  onChanged: () => void;
  logger?: Logger;
}) {
  let record: SignInRecord | null = null;

  const live = (candidate: SignInRecord | null): candidate is SignInRecord =>
    candidate != null && (candidate.status.state === "running" || candidate.status.state === "saving");

  function end(target: SignInRecord, state: Agent37ClaudeTokenSignInState, message: string | null = null) {
    target.status.state = state;
    target.status.awaitingCode = false;
    target.message = message;
    if (target.timeout) clearTimeout(target.timeout);
    target.timeout = null;
    const pty = target.pty;
    target.pty = null;
    if (pty) stopLoginPty(pty);
    deps.onChanged();
  }

  async function save(target: SignInRecord, token: string) {
    target.status.state = "saving";
    deps.onChanged();
    const vault = deps.vault();
    if (!vault) {
      end(target, "failed", "Sign in to ADE on this computer first: ADE keeps the token in your account.");
      return;
    }
    const stored: StoredToken = { v: 1, token, savedAt: Date.now() };
    const ok = await vault.set(JSON.stringify(stored)).catch(() => false);
    if (record !== target) return;
    if (!ok) {
      deps.logger?.warn?.("agent37.claude_token_save_failed");
      end(target, "failed", "ADE couldn't save the token to your account. Try again.");
      return;
    }
    deps.logger?.info?.("agent37.claude_token_saved");
    end(target, "succeeded");
  }

  /** Cuts the token from everything the screen reads, then keeps it. */
  function take(target: SignInRecord, token: string) {
    target.submittedCodes.push(token);
    target.status.output = cleanLoginOutput(target.rawOutput, target.submittedCodes);
    target.rawOutput = "";
    void save(target, token);
  }

  function spawn(target: SignInRecord, cli: PinnedProviderCli) {
    const env: NodeJS.ProcessEnv = { ...userProcessEnv(), ...cli.env, TERM: "xterm-256color" };
    // The token being made must not be confused with one already set here.
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    let pty: IPty;
    try {
      pty = spawnLoginPty(cli.command, [...cli.leadingArgs, "setup-token"], env);
    } catch (error) {
      end(target, "failed", `Couldn't start Claude Code's sign-in: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    target.pty = pty;
    pty.onData((data) => {
      if (record !== target || target.status.state !== "running") return;
      const before = `${target.status.url ?? ""}|${target.status.awaitingCode}`;
      const text = readLoginOutput(target, data, { hosts: AUTH_HOSTS, deviceCode: false, pasteCode: true, promptTailLines: 4 });
      const token = COMPLETE_TOKEN_PATTERN.exec(text)?.[0] ?? null;
      if (token) {
        take(target, token);
        return;
      }
      if (target.status.url && target.status.url !== target.openedUrl) {
        target.openedUrl = target.status.url;
        deps.openExternal(target.status.url);
      }
      // Only what the card shows changing is news; every output line is not.
      if (`${target.status.url ?? ""}|${target.status.awaitingCode}` !== before) deps.onChanged();
    });
    pty.onExit(({ exitCode }) => {
      if (record !== target || target.status.state !== "running") return;
      target.pty = null;
      const last = TOKEN_PATTERN.exec(cleanLoginOutput(target.rawOutput, target.submittedCodes))?.[0] ?? null;
      if (last) {
        take(target, last);
        return;
      }
      end(target, "failed", exitCode === 0
        ? "Claude Code finished without a token. Try again."
        : lastOutputLine(target.status.output) ?? `Claude Code's sign-in stopped (exit code ${exitCode}).`);
    });
  }

  async function savedState(): Promise<Pick<Agent37ClaudeTokenStatus, "saved" | "savedAt" | "unknown">> {
    const vault = deps.vault();
    if (!vault) return { saved: false, savedAt: null, unknown: false };
    try {
      const read = await vault.get();
      if (!read.ok) return { saved: false, savedAt: null, unknown: true };
      const stored = parseStored(read.value);
      return { saved: stored != null, savedAt: stored?.savedAt ?? null, unknown: false };
    } catch {
      return { saved: false, savedAt: null, unknown: true };
    }
  }

  async function status(): Promise<Agent37ClaudeTokenStatus> {
    const saved = await savedState();
    const current = record;
    return {
      ...saved,
      signIn: current
        ? { state: current.status.state, url: current.status.url, awaitingCode: current.status.awaitingCode, message: current.message }
        : null,
    };
  }

  return {
    status,
    /** Starts Claude Code's `setup-token` sign-in; a running one is replaced. */
    async start(): Promise<Agent37ClaudeTokenStatus> {
      if (!deps.vault()) throw new Error("Sign in to ADE on this computer first: ADE keeps the token in your account.");
      if (live(record)) end(record, "cancelled");
      const pinned = pinnedLoginCliState("claude");
      if (pinned.kind === "blocked") throw new Error(pinned.message);
      const target: SignInRecord = {
        status: { state: "running", output: "", url: null, awaitingCode: false },
        message: null,
        pty: null,
        rawOutput: "",
        submittedCodes: [],
        rawSinceSubmit: null,
        timeout: null,
        openedUrl: null,
      };
      record = target;
      target.timeout = setTimeout(() => {
        if (record === target && live(target)) end(target, "failed", "The sign-in timed out after 10 minutes.");
      }, LOGIN_TIMEOUT_MS);
      target.timeout.unref?.();
      if (pinned.kind === "ready") {
        spawn(target, pinned.cli);
      } else {
        // ADE's copy of Claude Code is still downloading: start once it lands.
        void pinned.done.then(
          (cli) => { if (record === target && target.status.state === "running") spawn(target, cli); },
          (error: unknown) => { if (record === target && live(target)) end(target, "failed", error instanceof Error ? error.message : String(error)); },
        );
      }
      deps.onChanged();
      return await status();
    },
    async submitCode(code: string): Promise<Agent37ClaudeTokenStatus> {
      if (!record || record.status.state !== "running") throw new Error("This sign-in is not waiting for a code any more.");
      writeLoginCode(record, code);
      deps.onChanged();
      return await status();
    },
    async cancel(): Promise<Agent37ClaudeTokenStatus> {
      if (live(record)) end(record, "cancelled");
      record = null;
      deps.onChanged();
      return await status();
    },
    /** Forgets the token. Machines made with it keep it until they are deleted. */
    async remove(): Promise<Agent37ClaudeTokenStatus> {
      const vault = deps.vault();
      if (!vault) throw new Error("Sign in to ADE on this computer first.");
      const ok = await vault.remove().catch(() => false);
      if (!ok) throw new Error("ADE couldn't remove the token from your account. Try again.");
      deps.logger?.info?.("agent37.claude_token_removed");
      record = null;
      deps.onChanged();
      return await status();
    },
    dispose() {
      if (live(record)) end(record, "cancelled");
      record = null;
    },
  };
}

export type Agent37ClaudeToken = ReturnType<typeof createAgent37ClaudeToken>;
