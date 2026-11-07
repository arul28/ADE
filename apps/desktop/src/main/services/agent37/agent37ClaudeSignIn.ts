/**
 * Claude on Agent 37 machines, signed in once.
 *
 * Claude Code has a sign-in made for headless machines: `claude setup-token`
 * prints a long-lived subscription token, and `CLAUDE_CODE_OAUTH_TOKEN` signs
 * Claude Code in with it. The person runs it once, here, in a private PTY: the
 * browser approves it, and ADE reads the token from Claude Code's output and
 * keeps it in the account vault (agent37CloudSignInStore.ts). Every Agent 37
 * machine made after that gets it as instance env.
 *
 * This runs in the brain (`ade serve`), never in the desktop's main process:
 * the brain loads node-pty from a real folder, while inside a packaged app
 * node-pty's helper sits in app.asar and can't be spawned or repaired. The
 * token never leaves the brain except for the vault: it is cut from the output
 * before anything reads it, and never logged.
 *
 * One sign-in per machine; a start replaces a running one.
 */

import type { Agent37CloudSignInStatus } from "../../../shared/agent37";
import { AdeExpectedError } from "../../../shared/expectedError";
import {
  LOGIN_TIMEOUT_MS,
  cleanLoginOutput,
  readLoginOutput,
  writeLoginCode,
} from "../shared/cliLoginPty";
import type { AgentCliLoginCliState, AgentCliLoginPty } from "../ai/agentCliLoginRunner";
import { COMPLETE_CLAUDE_TOKEN_PATTERN, CLAUDE_TOKEN_PATTERN } from "./agent37CloudSignInStore";

const AUTH_HOSTS = ["claude.ai", "anthropic.com", "claude.com"];

type Logger = {
  info?(event: string, meta?: Record<string, unknown>): void;
  warn?(event: string, meta?: Record<string, unknown>): void;
} | null | undefined;

type ClaudeState = NonNullable<Agent37CloudSignInStatus["claude"]>;

type SignInRecord = {
  status: { state: ClaudeState["state"]; output: string; url: string | null; awaitingCode: boolean };
  message: string | null;
  pty: AgentCliLoginPty | null;
  rawOutput: string;
  submittedCodes: string[];
  rawSinceSubmit: string | null;
  timeout: ReturnType<typeof setTimeout> | null;
  /** Keeps the token; false when the account refused it. */
  save: (token: string) => Promise<boolean>;
  /** The save of the token read, while it runs. */
  saving: Promise<unknown> | null;
};

export type Agent37ClaudeSignInDeps = {
  /** ADE's pinned Claude Code on this machine. Never one from the PATH. */
  resolveCli: () => AgentCliLoginCliState;
  /** The environment the CLI runs with (the user's, without ADE's host variables). */
  baseEnv: () => NodeJS.ProcessEnv;
  spawnPty: (command: string, args: string[], env: NodeJS.ProcessEnv) => AgentCliLoginPty;
  /** Stops the CLI; `sync` on process exit, which can't wait. */
  stopPty: (pty: AgentCliLoginPty, options: { sync?: boolean }) => void;
  logger?: Logger;
};

export function createAgent37ClaudeSignIn(deps: Agent37ClaudeSignInDeps) {
  let record: SignInRecord | null = null;

  const live = (candidate: SignInRecord | null): candidate is SignInRecord =>
    candidate != null && (candidate.status.state === "running" || candidate.status.state === "saving");

  function end(target: SignInRecord, state: ClaudeState["state"], message: string | null = null, options: { sync?: boolean } = {}) {
    target.status.state = state;
    target.status.awaitingCode = false;
    target.message = message;
    if (target.timeout) clearTimeout(target.timeout);
    target.timeout = null;
    const pty = target.pty;
    target.pty = null;
    if (pty) deps.stopPty(pty, options);
  }

  /** Cuts the token from everything that reads the output, then keeps it. */
  function take(target: SignInRecord, token: string) {
    target.submittedCodes.push(token);
    target.status.output = cleanLoginOutput(target.rawOutput, target.submittedCodes);
    target.rawOutput = "";
    target.status.state = "saving";
    target.status.awaitingCode = false;
    target.saving = target.save(token).then(
      (ok) => {
        if (record !== target || target.status.state !== "saving") return;
        if (!ok) {
          end(target, "failed", "ADE couldn't save the token to your account. Sign in to ADE on this computer, then try again.");
          return;
        }
        deps.logger?.info?.("agent37.claude_token_saved");
        end(target, "succeeded");
      },
      () => {
        if (record !== target || target.status.state !== "saving") return;
        deps.logger?.warn?.("agent37.claude_token_save_threw", { reason: "vault_write_threw" });
        end(target, "failed", "ADE couldn't save the token to your account. Try again.");
      },
    );
  }

  function spawn(target: SignInRecord, cli: { command: string; leadingArgs: string[]; env: Record<string, string> }) {
    const env: NodeJS.ProcessEnv = { ...deps.baseEnv(), ...cli.env, TERM: "xterm-256color" };
    // The token being made must not be confused with one already set here.
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    let pty: AgentCliLoginPty;
    try {
      pty = deps.spawnPty(cli.command, [...cli.leadingArgs, "setup-token"], env);
    } catch (error) {
      end(target, "failed", `Couldn't start Claude Code's sign-in: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    target.pty = pty;
    pty.onData((data) => {
      if (record !== target || target.status.state !== "running") return;
      const text = readLoginOutput(target, data, { hosts: AUTH_HOSTS, deviceCode: false, pasteCode: true, promptTailLines: 4 });
      const token = COMPLETE_CLAUDE_TOKEN_PATTERN.exec(text)?.[0] ?? null;
      if (token) take(target, token);
    });
    pty.onExit(({ exitCode }) => {
      // Forget the process first, whatever the state: a later end() must never
      // kill a PID that is gone, which on Windows may already be another process.
      if (target.pty === pty) target.pty = null;
      if (record !== target || target.status.state !== "running") return;
      const last = CLAUDE_TOKEN_PATTERN.exec(cleanLoginOutput(target.rawOutput, target.submittedCodes))?.[0] ?? null;
      if (last) {
        take(target, last);
        return;
      }
      // Not Claude Code's last line: it can hold part of a token cut across lines.
      end(target, "failed", exitCode === 0
        ? "Claude Code finished without a token. Try again."
        : `Claude Code's sign-in stopped (exit code ${exitCode}).`);
    });
  }

  return {
    state(): Agent37CloudSignInStatus["claude"] {
      const current = record;
      return current
        ? { state: current.status.state, url: current.status.url, awaitingCode: current.status.awaitingCode, message: current.message }
        : null;
    },
    /** Starts Claude Code's `setup-token`; a running one is replaced. */
    start(save: (token: string) => Promise<boolean>): void {
      const cliState = deps.resolveCli();
      if (cliState.kind === "blocked") throw new AdeExpectedError(cliState.message, "environment");
      if (live(record)) end(record, "cancelled");
      const target: SignInRecord = {
        status: { state: "running", output: "", url: null, awaitingCode: false },
        message: null,
        pty: null,
        rawOutput: "",
        submittedCodes: [],
        rawSinceSubmit: null,
        timeout: null,
        save,
        saving: null,
      };
      record = target;
      target.timeout = setTimeout(() => {
        if (record === target && live(target)) end(target, "failed", "The sign-in timed out after 10 minutes.");
      }, LOGIN_TIMEOUT_MS);
      target.timeout.unref?.();
      if (cliState.kind === "ready") {
        spawn(target, cliState.cli);
        return;
      }
      // ADE's copy of Claude Code is still downloading: start once it lands.
      void cliState.done.then(
        (cli) => { if (record === target && target.status.state === "running") spawn(target, cli); },
        (error: unknown) => { if (record === target && live(target)) end(target, "failed", error instanceof Error ? error.message : String(error)); },
      );
    },
    submitCode(code: string): void {
      if (!record || record.status.state !== "running") throw new AdeExpectedError("This sign-in is not waiting for a code any more.", "user");
      writeLoginCode(record, code);
    },
    /**
     * Stops a running sign-in. Settles once a token it already read is
     * written, so a removal that waits for it is the last word.
     */
    async cancel(): Promise<void> {
      const current = record;
      if (live(current)) end(current, "cancelled");
      record = null;
      await current?.saving;
    },
    dispose(options: { sync?: boolean } = {}): void {
      if (live(record)) end(record, "cancelled", null, options);
      record = null;
    },
  };
}

export type Agent37ClaudeSignIn = ReturnType<typeof createAgent37ClaudeSignIn>;
